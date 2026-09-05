/**
 * Núcleo de extracción de audio directo de YouTube/YT Music.
 * Usado por api/ytcache.js para extraer una vez por canción y subir el
 * resultado a Vercel Blob (caché de audio compartido, servido por CDN).
 *
 * Por qué existe esto: desde 2025 YouTube exige PO Tokens (Proof of Origin,
 * generados vía BotGuard) para servir URLs reproducibles de googlevideo
 * desde IPs de datacenter — sin token hay 403, formatos vacíos o challenge
 * anti-bot. Además @distube/ytdl-core fue archivado (agosto 2025), así que
 * la extracción se migró a youtubei.js (el cliente que mantienen los mismos
 * autores que yt-dlp usa ahora).
 *
 * Cómo funciona:
 *   1. Sesión Innertube persistente (una sola por instancia tibia).
 *   2. Challenge de BotGuard cargado una vez en una VM in-process
 *      (bgutils-js, misma librería del provider POT oficial de yt-dlp).
 *   3. Con el integrity token se arma un WebPoMinter y por cada videoId
 *      se mintea un token content-bound (~100-300ms, cacheado ~6h).
 *   4. getBasicInfo con cliente YTMUSIC → mejor formato audioonly →
 *      decipher → URL final con `pot=`. Se sondea con Range bytes=0-1
 *      antes de devolverla para no entregar URLs muertas.
 *   5. Si YTMUSIC no da formato utilizable, se reintenta con TV (sin
 *      PO token todavía; fallback temporal mientras dure).
 *
 * Todos los caches viven a nivel de módulo: en Vercel Functions las
 * instancias tibias reusan el módulo entre invocaciones, así el costo alto
 * (sesión + BotGuard + integrity token) se paga ~1 vez cada horas.
 */

import { JSDOM } from 'jsdom'
import { Innertube, Platform } from 'youtubei.js'
import { BotGuardClient, getChallenge } from 'bgutils-js/botguard'
import type { WebPoSignalOutput } from 'bgutils-js/shared-types'
import { WebPoMinter } from 'bgutils-js/webpo'
import { buildURL, getHeaders, USER_AGENT } from 'bgutils-js/utils'
import { ProxyAgent, setGlobalDispatcher } from 'undici'
import { resolveViaExternalFallback } from './pipedFallback.ts'

// Proxy residencial opcional para el tráfico saliente de YouTube (ver
// proxyDispatcher.ts, ahora inlineado acá a propósito: vivía en un archivo
// aparte importado estáticamente desde este módulo, pero este módulo a su
// vez se carga con `import()` dinámico desde ytstore.ts — ese doble salto
// (dinámico + estático transitivo) es lo que el bundler de Vercel no
// estaba empaquetando bien ("Cannot find module .../proxyDispatcher").
// Inlineado acá no hay archivo transitivo que trazar: cero superficie para
// que vuelva a pasar. Mismo comportamiento, mismo YT_PROXY_URL opcional.
let __ytProxyInstalled = false
function installYtProxyIfConfigured(): void {
  if (__ytProxyInstalled) return
  __ytProxyInstalled = true
  const proxyUrl = process.env.YT_PROXY_URL
  if (!proxyUrl) return
  try {
    setGlobalDispatcher(new ProxyAgent(proxyUrl))
  } catch (err) {
    console.error('[ytcore] YT_PROXY_URL inválida, se ignora:', err instanceof Error ? err.message : err)
  }
}

// Debe instalarse ANTES de que corra cualquier fetch de este módulo
// (sesión Innertube, challenge de BotGuard, integrity token, sonda de la
// URL final). No-op si YT_PROXY_URL no está seteada.
installYtProxyIfConfigured()

/** Nombre de cliente Innertube, derivado de la firma de getBasicInfo. */
type InnerTubeClient = NonNullable<NonNullable<Parameters<Innertube['getBasicInfo']>[1]>['client']>

// youtubei.js NO trae evaluador propio (por seguridad): para descifrar las
// URLs firmadas hace falta ejecutar el player JS ofuscado de YouTube acá.
type ShimWithEval = { shim: { eval?: (data: { output: string }) => Promise<unknown> } }
;(Platform as unknown as ShimWithEval).shim.eval = async (data) => new Function(data.output)()

declare global {
  // eslint-disable-next-line no-var
  var __xfyDomReady: boolean | undefined
}

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// Cadena de clientes Innertube a probar en orden. YTMUSIC es el cliente de
// YT Music (mismos catálogo/formatos); MWEB suele devolver formatos directos
// con gvs PO token cuando YTMUSIC no trae nada; ANDROID_VR y TV históricamente
// pasan sin PO token — son la red de seguridad cuando YouTube le pone el
// challenge anti-bot a los clientes web desde IPs de datacenter.
const CLIENT_CHAIN: InnerTubeClient[] = [
  (process.env.YT_AUDIO_CLIENT || 'YTMUSIC') as InnerTubeClient,
  'MWEB',
  'ANDROID_VR',
  'TV',
]

const URL_TTL_MS = 4 * 60 * 60 * 1000 // firmas de googlevideo duran ~6h; margen corto a propósito
const URL_CACHE_MAX = 500 // por instancia tibia; evicción FIFO si se llena
const MINTER_REFRESH_MARGIN_MS = 15 * 60 * 1000 // renovar el minter antes de que expire su integrity token
const PROBE_TIMEOUT_MS = 6000

/** Formato de audio resuelto y verificado, listo para descargar/proxear. */
export interface ResolvedAudio {
  url: string
  mimeType: string
  bitrate: number
  durationSecs: number
  client: string
  /** true si `url` apunta a un formato muxed (video+audio) porque no
   *  había audio-only disponible — ytstore.ts debe extraer solo el
   *  audio con ffmpeg antes de guardarlo (ver remux.ts:extractAudioOnly). */
  isMuxed?: boolean
}

interface CachedResolved extends ResolvedAudio {
  expiry: number
}

let innertubePromise: Promise<Innertube> | null = null
let botguardPromise: Promise<BotGuardClient> | null = null // VM de BotGuard ya cargada (globalThis)
let minterState: { minter: WebPoMinter; expiresAt: number } | null = null
const urlCache = new Map<string, CachedResolved>() // videoId → resolved
const inflight = new Map<string, Promise<ResolvedAudio | null>>() // videoId → promesa en curso (dedupe de requests simultáneos)

function setupDomGlobals(): void {
  if (globalThis.__xfyDomReady) return
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://www.youtube.com/',
    referrer: 'https://www.youtube.com/',
    userAgent: USER_AGENT,
  })
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    origin: dom.window.origin,
  })
  if (!Reflect.has(globalThis, 'navigator')) {
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator })
  }
  globalThis.__xfyDomReady = true
}

/**
 * Normaliza YTDL_COOKIE a formato header ("name=value; name=value").
 * Acepta los tres formatos que la gente pega en la práctica:
 *   1. Archivo Netscape completo (con comentarios y tabs) — lo detecta solo.
 *   2. JSON estilo EditThisCookie ([{ name, value }, ...]).
 *   3. Header de una línea (lo deja como viene, limpio).
 * Deduplica por nombre (queda la primera aparición) porque YouTube repite
 * cookies entre dominios y un header duplicado confunde a algunos parsers.
 */
export function parseCookieInput(raw: unknown): string | null {
  if (!raw) return null
  const str = String(raw).trim()

  const pairs: string[] = []

  // JSON EditThisCookie
  if (str.startsWith('[')) {
    try {
      const arr = JSON.parse(str) as { name?: string; value?: string }[] | null
      if (Array.isArray(arr)) {
        arr.forEach((c) => c?.name && pairs.push(`${c.name}=${c.value ?? ''}`))
      }
    } catch {
      /* cae al parseo por líneas */
    }
  }

  if (pairs.length === 0 && /^# Netscape|^\[?\.?(www\.)?youtube\.com\t/im.test(str)) {
    // Netscape: domain \t flag \t path \t secure \t expiry \t name \t value
    for (const line of str.split(/\r?\n/)) {
      const l = line.replace(/^#HttpOnly_\s*/i, '').trim()
      if (!l || l.startsWith('#')) continue
      const f = l.split('\t')
      const domain = f[0]
      const name = f[5]
      if (f.length < 7 || !domain || !name) continue
      if (!/(^|\.)youtube\.com$/i.test(domain.trim())) continue
      pairs.push(`${name}=${f.slice(6).join('=')}`)
    }
  }

  if (pairs.length === 0) {
    // Formato header: una o varias líneas "name=value; ..." (sin comentarios)
    for (const line of str.split(/\r?\n/)) {
      const l = line.trim().replace(/;$/, '')
      if (!l || l.startsWith('#')) continue
      for (const piece of l.split(';')) {
        const p = piece.trim()
        if (p && /^[^\s=]+=[\s\S]*$/.test(p)) pairs.push(p)
      }
    }
  }

  if (pairs.length === 0) return null

  const seen = new Set<string>()
  const unique: string[] = []
  for (const pair of pairs) {
    const name = pair.slice(0, pair.indexOf('='))
    if (seen.has(name)) continue
    seen.add(name)
    unique.push(pair)
  }
  return unique.join('; ')
}

function getInnertube(): Promise<Innertube> {
  if (!innertubePromise) {
    innertubePromise = Innertube.create({
      user_agent: BROWSER_UA,
      cookie: parseCookieInput(process.env.YTDL_COOKIE) || undefined,
    }).catch((err: unknown) => {
      innertubePromise = null // no cachear sesiones rotas
      throw err
    })
  }
  return innertubePromise
}

async function ensureBotguard(): Promise<BotGuardClient> {
  if (botguardPromise) return botguardPromise
  botguardPromise = (async () => {
    setupDomGlobals()
    const challenge = await getChallenge({ requestKey: REQUEST_KEY, fetchFunction: fetch })
    const interpreterJavascript =
      challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue
    if (!interpreterJavascript) throw new Error('BotGuard no entregó intérprete')
    new Function(interpreterJavascript)()
    return BotGuardClient.create({
      program: challenge.program,
      globalName: challenge.globalName,
      globalObject: globalThis,
    })
  })().catch((err: unknown) => {
    botguardPromise = null
    throw err
  })
  return botguardPromise
}

async function ensureMinter(): Promise<WebPoMinter> {
  if (minterState && Date.now() < minterState.expiresAt - MINTER_REFRESH_MARGIN_MS) {
    return minterState.minter
  }
  const botguard = await ensureBotguard()
  const webPoSignalOutput: WebPoSignalOutput = []
  const botguardResponse = await botguard.snapshot({ webPoSignalOutput })

  const integrityTokenResponse = await fetch(buildURL('GenerateIT', true), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  })
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] =
    (await integrityTokenResponse.json()) as [string?, number?, number?, string?]

  if (!integrityToken) throw new Error('Integrity token vacío')

  const minter = await WebPoMinter.create(
    { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
    webPoSignalOutput,
  )
  const ttlMs = Math.min(Math.max((estimatedTtlSecs || 7200) * 1000, 30 * 60 * 1000), 6 * 60 * 60 * 1000)
  minterState = { minter, expiresAt: Date.now() + ttlMs }
  return minter
}

async function mintPoToken(videoId: string): Promise<string | null> {
  try {
    const minter = await ensureMinter()
    return await minter.mintAsWebsafeString(videoId)
  } catch (err) {
    console.warn('[ytcore] No se pudo mintear PO token:', String(err instanceof Error ? err.message : err).slice(0, 120))
    return null
  }
}

/** Shape mínimo del formato audio-only que este módulo necesita. */
interface AudioFormatInfo {
  mime_type?: string
  bitrate?: number
  approx_duration_ms?: number | string
  decipher: (player: unknown) => Promise<string>
}

/** Elige el mejor formato audio-only del player response. */
function pickAudioFormat(info: Innertube extends never ? never : Awaited<ReturnType<Innertube['getBasicInfo']>>): AudioFormatInfo | null {
  try {
    const chosen = info.chooseFormat({ quality: 'best', type: 'audio' })
    if (chosen && !chosen.is_type_otf && chosen.has_audio !== false) return chosen as unknown as AudioFormatInfo
  } catch {
    /* chooseFormat tira si no encuentra nada: caemos al scan manual */
  }
  const formats = info.streaming_data?.adaptive_formats ?? []
  const audioOnly = formats.filter((f) => f.has_audio && !f.has_video && !f.is_type_otf)
  return (audioOnly.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0] as unknown as AudioFormatInfo) || null
}

/**
 * Fallback cuando NINGÚN formato audio-only está disponible para el
 * cliente actual (pasa en algunos clientes/regiones donde YouTube solo
 * expone formatos muxed). Mismo comportamiento que el changelog v5.1.2
 * de Spotube ("newpipe: Fallback to muxed streams if no audio stream is
 * available"): tomamos el mejor formato muxed (video+audio) y dejamos que
 * ytstore.ts le extraiga solo el audio con ffmpeg -vn al procesarlo (ver
 * extractAudioOnly en remux.ts). Nunca es la primera opción — muxed pesa
 * mucho más al bajar y hay que transcodear — pero es mejor que fallar.
 */
function pickMuxedFallbackFormat(info: Innertube extends never ? never : Awaited<ReturnType<Innertube['getBasicInfo']>>): AudioFormatInfo | null {
  const formats = info.streaming_data?.formats ?? [] // formatos progresivos (muxed) de YouTube
  const muxed = formats.filter((f) => f.has_audio && f.has_video)
  return (muxed.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0] as unknown as AudioFormatInfo) || null
}

/** Sonda Range bytes=0-1: confirma que la URL firma realmente sirve audio antes de entregarla. */
async function probeUrl(url: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-1', 'User-Agent': BROWSER_UA },
      signal: controller.signal,
    })
    try {
      await res.body?.cancel?.()
    } catch {
      /* noop */
    }
    return res.status === 200 || res.status === 206
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resuelve una URL directa reproducible para `videoId`.
 * Devuelve { url, mimeType, bitrate, durationSecs, client } o null.
 *
 * Dedupe: si dos requests piden el mismo videoId a la vez (típico al saltar
 * rápido entre pistas), comparten una sola resolución en lugar de duplicar
 * toda la cadena Innertube/BotGuard.
 */
export function resolveAudioUrl(videoId: string | null | undefined): Promise<ResolvedAudio | null> {
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return Promise.resolve(null)

  const cached = urlCache.get(videoId)
  if (cached && Date.now() < cached.expiry) {
    // eslint-disable-next-line no-unused-vars -- `expiry` se saca a propósito del payload
    const { expiry, ...rest } = cached
    return Promise.resolve(rest)
  }

  const pending = inflight.get(videoId)
  if (pending) return pending

  const promise = resolveAudioUrlInner(videoId).finally(() => inflight.delete(videoId))
  inflight.set(videoId, promise)
  return promise
}

// Último motivo de fallo — va en el body de error de /api/ytcache para que
// el diagnóstico no requiera abrir los logs de Vercel.
let lastFailureReason: string | null = null
export function getLastFailureReason(): string | null {
  return lastFailureReason
}

// Cuando TODOS los clientes devuelven playability != OK es YouTube poniendo
// el challenge anti-bot a la IP/sesión. Reconstruir la sesión Innertube
// (nuevo visitor_data) suele desbloquearlo una vez; con cooldown para no
// meter ruido si el bloqueo es persistente hasta que se configure cookie.
const SESSION_REBUILD_COOLDOWN_MS = 60 * 1000
let lastSessionRebuildAt = 0

interface AttemptResult {
  resolved: ResolvedAudio | null
  lastReason: string
  systemicHit: boolean
}

async function attemptWithClients(innertube: Innertube, videoId: string): Promise<AttemptResult> {
  let lastReason = 'sin intento'
  let systemicHit = false

  for (const client of CLIENT_CHAIN) {
    try {
      const poToken = client === 'TV' || client === 'ANDROID_VR' ? null : await mintPoToken(videoId)
      const info = await innertube.getBasicInfo(videoId, {
        client,
        ...(poToken ? { po_token: poToken } : {}),
      })

      if (info.playability_status?.status && info.playability_status.status !== 'OK') {
        const reason = info.playability_status.reason || ''
        systemicHit = true
        lastReason = `${client}: ${info.playability_status.status}${reason ? ' – ' + String(reason).slice(0, 80) : ''}`
        continue
      }

      let format = pickAudioFormat(info)
      let isMuxed = false
      if (!format) {
        // Sin audio-only: probamos el mejor formato muxed antes de pasar
        // al siguiente cliente (ver pickMuxedFallbackFormat arriba).
        format = pickMuxedFallbackFormat(info)
        isMuxed = !!format
      }
      if (!format) {
        lastReason = `${client}: sin formato audio-only ni muxed`
        continue
      }

      let url = await format.decipher(innertube.session.player)
      if (!url) {
        lastReason = `${client}: decipher vacío`
        continue
      }
      if (poToken) {
        url += (url.includes('?') ? '&' : '?') + `pot=${poToken}`
      }

      if (!(await probeUrl(url))) {
        lastReason = `${client}: sonda Range falló`
        continue
      }

      return {
        resolved: {
          url,
          mimeType: (format.mime_type || 'audio/mp4').split(';')[0] ?? 'audio/mp4',
          bitrate: format.bitrate || 0,
          durationSecs: Math.round(Number(format.approx_duration_ms || 0) / 1000),
          client: isMuxed ? `${client}:muxed` : client,
          isMuxed,
        },
        lastReason,
        systemicHit: false,
      }
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err)
      // "Sign in to confirm you're not a bot" y similares llegan como excepción
      // de Innertube, no como playability status.
      if (/confirm|bot|integrity|challenge/i.test(msg)) systemicHit = true
      lastReason = `${client}: ${msg.slice(0, 120)}`
    }
  }

  return { resolved: null, lastReason, systemicHit }
}

async function resolveAudioUrlInner(videoId: string): Promise<ResolvedAudio | null> {
  let innertube = await getInnertube()
  let { resolved, lastReason, systemicHit } = await attemptWithClients(innertube, videoId)

  // Bloqueo anti-bot sistémico → sesión nueva (visitor_data fresco) y un
  // único reintento inmediato. Si sigue bloqueado, el cooldown deja pasar
  // el request sin martillar y el fix real es YTDL_COOKIE.
  if (!resolved && systemicHit && Date.now() - lastSessionRebuildAt > SESSION_REBUILD_COOLDOWN_MS) {
    lastSessionRebuildAt = Date.now()
    console.warn('[ytcore] Challenge anti-bot en todos los clientes — reconstruyendo sesión Innertube')
    innertubePromise = null
    innertube = await getInnertube()
    ;({ resolved, lastReason } = await attemptWithClients(innertube, videoId))
  }

  // Último recurso: TODO el CLIENT_CHAIN de youtubei.js (con reconstrucción
  // de sesión incluida) siguió bloqueado. En vez de rendirnos, probamos
  // Piped/Invidious — infraestructura de terceros con su propia reputación
  // de IP, que a veces sigue funcionando cuando la nuestra está marcada.
  // Deshabilitable con YT_DISABLE_EXTERNAL_FALLBACK=1 si se prefiere fallar
  // rápido y confiar solo en el pipeline propio.
  if (!resolved && process.env.YT_DISABLE_EXTERNAL_FALLBACK !== '1') {
    try {
      const fallback = await resolveViaExternalFallback(videoId)
      if (fallback) {
        resolved = fallback
        lastReason = `fallback externo (${fallback.client}) tras agotar CLIENT_CHAIN`
      }
    } catch (err) {
      console.warn('[ytcore] Fallback Piped/Invidious también falló:', err instanceof Error ? err.message : err)
    }
  }

  lastFailureReason = lastReason
  if (resolved) cacheSet(videoId, resolved)
  else console.warn(`[ytcore] Extracción falló para ${videoId} — ${lastReason}`)
  return resolved
}

/** Cache FIFO con tope: las instancias tibias viven horas y no deben crecer sin límite. */
function cacheSet(videoId: string, resolved: ResolvedAudio): void {
  if (!urlCache.has(videoId) && urlCache.size >= URL_CACHE_MAX) {
    const oldest = urlCache.keys().next().value
    if (oldest !== undefined) urlCache.delete(oldest)
  }
  urlCache.set(videoId, { ...resolved, expiry: Date.now() + URL_TTL_MS })
}
