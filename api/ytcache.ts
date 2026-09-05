/**
 * Serverless Function: extracción + upload a Vercel Blob (caché de audio
 * compartido). Una sola extracción por canción, para todos los usuarios.
 *
 * POST /api/ytcache  { videoId }
 *   → { status: 'ready' | 'processing' | 'invalid' }
 *
 * Flujo:
 *   1. ¿Ya existe en el blob? → ready al toque (head(), sin re-extraer).
 *   2. ¿Hay un job corriendo para este video en esta instancia? → processing.
 *   3. Si no: responde 202 YA y procesa en background vía waitUntil —
 *      el frontend no espera la extracción (mientras tanto suena el IFrame)
 *      y hace polling del HEAD público hasta que aparezca.
 *
 * Protección: rate limit por IP (ventana de 1 min, techo más bajo para
 * disparos NUEVOS de extracción que para requests baratos) + techo de
 * cola por instancia — ver el bloque "Rate limit" abajo. El endpoint
 * sigue siendo público porque el player lo usa desde cualquier browser
 * (un secret en el bundle no defiende nada); esto convierte el abuso
 * masivo en algo lento y visible, no lo hace imposible.
 *
 * La extracción real (descarga + validación + upload + índice + metadata)
 * vive en _lib/ytstore.js, compartida con api/ytaudit.js (que re-extrae
 * archivos detectados como truncados/corruptos) — ver ese módulo.
 *
 * Requiere que el store esté conectado al proyecto: por default vía OIDC
 * (BLOB_STORE_ID + VERCEL_OIDC_TOKEN, que Vercel inyecta solo al conectar
 * el store — es lo que usa el SDK automáticamente), o vía el token
 * estático BLOB_READ_WRITE_TOKEN como fallback (código fuera de Vercel,
 * o proyectos que lo hayan agregado a mano en Advanced Options).
 */

import { waitUntil } from '@vercel/functions'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { alreadyCached, findCanonicalVideoId, extractAndStore, getSongKey } from './_lib/ytstore.ts'
import { r2Config, b2Config } from './_lib/tieredAudioStore.ts'

// 300s: tope real de Hobby con Fluid Compute activo (default y máximo).
// Ya confirmado en logs de producción que se respeta ("Task timed out
// after 300 seconds" en vez de 60s). Si la extracción típica ronda ese
// límite conviene revisar qué la está haciendo tan lenta antes que subir
// el número — no hay margen para pedir más sin pasar a Pro.
export const config = { maxDuration: 300 }

const inflight = new Set() // videoId en proceso en esta instancia

// --- Rate limit por IP ---
// El endpoint es público (el player lo llama desde cualquier browser, así
// que un secret embebido en el bundle no defiende nada), pero disparar la
// extracción de YouTube + ffmpeg + upload al Blob es LO más caro del
// sistema: sin techo, un script de 20 líneas puede quemar horas de
// Function y GB de store ajenos. No es un WAF — es una traba barata que
// convierte abuso masivo en algo lento y visible en logs. En serverless el
// Map vive por instancia tibia (no es global entre invocaciones frías),
// pero para eso está el techo de cola de abajo.
const RATE_WINDOW_MS = 60 * 1000
const MAX_REQUESTS_PER_WINDOW = 60 // cualquier respuesta, incluso las baratas
const MAX_EXTRACTIONS_PER_WINDOW = 10 // disparos NUEVOS de extracción por IP/minuto
const RATE_MAP_MAX_IPS = 5000 // techo de memoria: IPs trackeadas antes de podar

interface RateEntry {
  start: number
  requests: number
  extractions: number
}

const hitsByIp = new Map<string, RateEntry>() // ip -> { start, requests, extractions }

function clientIp(req: VercelRequest): string {
  const fwd = String(req.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim() || ''
  return fwd || String(req.headers?.['x-real-ip'] || '') || 'desconocida'
}

function pruneRateMap(now: number): void {
  for (const [ip, e] of hitsByIp) {
    if (now - e.start >= RATE_WINDOW_MS) hitsByIp.delete(ip)
  }
}

function rateCheck(ip: string): {
  flood: boolean
  canExtract: () => boolean
  markExtraction: () => void
} {
  const now = Date.now()
  let entry = hitsByIp.get(ip)
  if (!entry || now - entry.start >= RATE_WINDOW_MS) {
    if (!entry && hitsByIp.size >= RATE_MAP_MAX_IPS) pruneRateMap(now)
    entry = { start: now, requests: 0, extractions: 0 }
    hitsByIp.set(ip, entry)
  }
  entry.requests += 1
  const current = entry
  return {
    flood: current.requests > MAX_REQUESTS_PER_WINDOW,
    canExtract: () => current.extractions < MAX_EXTRACTIONS_PER_WINDOW,
    markExtraction: () => { current.extractions += 1 },
  }
}

// Límite de extracciones CONCURRENTES por instancia tibia. Sin esto, una
// ráfaga de POSTs simultáneos (ej. recachear todo el catálogo de una,
// como pasó al vaciar el Blob store) hace que N jobs de extractAndStore
// corran todos a la vez en la misma instancia — cada uno compitiendo por
// la misma CPU con su propio ffmpeg (remux) y su propio challenge de
// BotGuard si la instancia todavía no lo tenía tibio — y eso es lo que
// empuja a varios por encima de los 300s de maxDuration (visto en
// producción: Error 0%, Timeout ~24%, justo durante una ráfaga así).
// Encolar acá adentro, en vez de dejar que todos corran en simultáneo,
// no cambia la respuesta HTTP (sigue siendo 202 inmediato: el frontend
// no espera nada distinto) — solo pospone CUÁNDO arranca cada extracción
// real dentro de esta instancia.
const MAX_CONCURRENT_EXTRACTIONS = 3
let runningExtractions = 0
const extractionQueue: (() => Promise<unknown>)[] = []

// Techo de cola: sin esto, una ráfaga con N videoIds distintos encola N
// jobs (el Set de inflight solo dedupe el MISMO videoId) y la memoria de
// la instancia crece sin control bajo ataque. Al llegar al tope se
// responde 429 y el cliente simplemente reintenta después — el polling
// del HEAD ya es parte natural del flujo, así que "ahora no" no rompe nada.
const MAX_QUEUE_LENGTH = 50

function runExtraction(job: () => Promise<unknown>): void {
  if (runningExtractions >= MAX_CONCURRENT_EXTRACTIONS) {
    extractionQueue.push(job)
    return
  }
  runningExtractions += 1
  job().finally(() => {
    runningExtractions -= 1
    const next = extractionQueue.shift()
    if (next) runExtraction(next)
  })
}

interface YtCacheBody {
  videoId?: string
  title?: string
  artist?: string
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<VercelResponse | void> {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  // POST-only: el GET quedó como puerta de testing sin querer y era otra
  // vía barata de abuso (mismos efectos, cero fricción). El player siempre
  // manda POST (ytblob.js), así que esto no rompe nada legítimo.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ status: 'invalid', error: 'Usar POST con body JSON { videoId }' })
  }

  const body = (req.body || {}) as YtCacheBody
  const videoId = String(body.videoId || '').trim()
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ status: 'invalid', error: 'videoId inválido o faltante' })
  }

  const rl = rateCheck(clientIp(req))
  if (rl.flood) {
    res.setHeader('Retry-After', '60')
    return res.status(429).json({ status: 'rate-limited', error: 'Demasiados requests desde esta IP, reintentá en un minuto' })
  }

  // Opcionales: si el cliente los manda, habilitan dedupe por canción
  // (título+artista) además del dedupe por videoId exacto que ya había.
  const title = String(body.title || '').trim().slice(0, 300)
  const artist = String(body.artist || '').trim().slice(0, 300)
  const songKey = getSongKey(title, artist)

  // El audio en sí puede terminar en R2, B2 o Vercel Blob — lo decide
  // writeAudioTiered() según qué esté configurado (ver tieredAudioStore.ts).
  // Este gate solo debe bloquear si NINGÚN nivel de storage está disponible;
  // antes exigía Blob sí o sí, así que sacar Blob del proyecto (el objetivo,
  // justamente, de migrar a Cloudflare) tiraba 503 aunque R2 estuviera
  // perfectamente configurado. El índice/metadata (chico, JSON) sigue
  // yendo a Blob si existe, pero writeSongIndex/writeSongMeta ya degradan
  // solas con un warn si falla — no ameritan bloquear el endpoint entero.
  const hasOidc = !!(process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN)
  const hasStaticToken = !!process.env.BLOB_READ_WRITE_TOKEN
  const hasBlob = hasOidc || hasStaticToken
  const hasCloudStorage = hasBlob || !!r2Config() || !!b2Config()
  if (!hasCloudStorage) {
    return res.status(503).json({
      status: 'unconfigured',
      error: 'Ningún store de audio conectado (falta R2, B2 o Vercel Blob)',
    })
  }

  try {
    if (await alreadyCached(videoId)) {
      return res.status(200).json({ status: 'ready', videoId })
    }
  } catch (err) {
    console.warn('[ytcache] head falló:', String(err instanceof Error ? err.message : err).slice(0, 120))
  }

  // ¿Esta MISMA canción ya está cacheada bajo otro videoId? Si sí, no hay
  // nada que extraer: le decimos al cliente que reproduzca ese otro
  // videoId directamente. Evita re-descargar de YouTube (lo lento/frágil,
  // ver los "terminated"/timeouts en los logs) y evita blobs de audio
  // duplicados con el mismo contenido.
  if (songKey) {
    try {
      const canonical = await findCanonicalVideoId(songKey)
      if (canonical && canonical !== videoId) {
        return res.status(200).json({ status: 'ready', videoId: canonical, aliasOf: videoId })
      }
    } catch (err) {
      console.warn('[ytcache] lookup de índice falló:', String(err instanceof Error ? err.message : err).slice(0, 120))
    }
  }

  if (inflight.has(videoId)) {
    return res.status(202).json({ status: 'processing', videoId })
  }

  // Los chequeos de arriba (ready / alias) son baratos y no cuentan como
  // extracción — el cupo apretó recién cuando el pedido va a disparar una
  // de verdad (lo caro: YouTube + ffmpeg + upload).
  if (!rl.canExtract() || extractionQueue.length >= MAX_QUEUE_LENGTH) {
    res.setHeader('Retry-After', '60')
    return res.status(429).json({ status: 'rate-limited', error: 'Cupo de extracciones agotado, reintentá en un minuto' })
  }
  rl.markExtraction()
  inflight.add(videoId)

  waitUntil(
    new Promise<void>((resolveJob) => {
      runExtraction(() =>
        extractAndStore(videoId, { songKey, title, artist })
          .catch((err: unknown) => {
            console.warn(`[ytcache] job ${videoId} falló:`, String(err instanceof Error ? err.message : err).slice(0, 200))
          })
          .finally(() => {
            inflight.delete(videoId)
            resolveJob()
          }),
      )
    }),
  )

  return res.status(202).json({ status: 'processing', videoId })
}
