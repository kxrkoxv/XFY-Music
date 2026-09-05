// ============================================================
// ytBlob — capa cliente del caché de audio server-side (Vercel Blob).
//
// Arquitectura: una sola extracción por canción, compartida entre todos
// los usuarios y sesiones. El audio extraído se sube a un blob store
// público y de ahí en más se sirve por el CDN de Vercel — reproducir una
// canción ya cacheada es un HEAD (¿existe?) + un GET al edge, mucho más
// rápido que volver a extraer de YouTube.
//
// Flujo de reproducción (ver usePlayerStore):
//   1. ¿Existe el blob de este videoId exacto? (HEAD al CDN, ~30ms).
//   2. Si no, ¿esta MISMA canción (título+artista) ya está cacheada bajo
//      OTRO videoId? Se lee el índice directo del CDN (yt-audio/_index/,
//      ver audioCacheKey.js) — otro fetch chico al edge, sin pasar por
//      la función serverless. Así, si el Usuario A ya hizo que se
//      cacheara "Andrea" (por el videoId de su lyric video) y el Usuario
//      B la pide por el videoId del audio oficial, B recibe el audio
//      real de una — nunca pasa por el IFrame.
//   3. Recién si NINGUNA de las dos existe → IFrame Player INMEDIATO
//      (cero espera) + POST /api/ytcache para que el server extraiga y
//      suba en background.
//   4. Cuando el upload termina, el frontend lo detecta polling el HEAD
//      y avisa con una notificación: "lista para segundo plano".
//
// Convención de paths (determinística, sin sufijos random):
//   yt-audio/{videoId}.m4a   (preferido, AAC)
//   yt-audio/{videoId}.webm  (fallback, Opus)
// ============================================================
import { getSongKey, indexPathFor, candidateAudioPaths, isVideoId, type VideoId } from '@shared/lib/audioCacheKey'
import { createWorkerInterval } from '@shared/lib/workerTicker'

// Bases públicas en orden HOT → FRÍO: R2 (default para audio nuevo) →
// Vercel Blob (legacy, lo que ya estaba cacheado antes de la migración a
// R2) → Backblaze B2 (nivel frío, adonde el cron de R2 degrada lo viejo/
// excedente — ver api/cron/r2-lifecycle.ts). Un nivel que no esté
// configurado (env var vacía en el build) simplemente no entra en la
// lista, así que esto funciona igual antes/durante/después de migrar.
const BLOB_BASE_DEFAULT = 'https://3xdosg72gxp3tqbf.public.blob.vercel-storage.com'
const AUDIO_BASES = [
  import.meta.env.VITE_R2_BASE_URL,
  import.meta.env.VITE_BLOB_BASE_URL || BLOB_BASE_DEFAULT,
  import.meta.env.VITE_B2_BASE_URL,
].filter((base): base is string => Boolean(base))

// El índice de canciones (yt-audio/_index/) y la metadata (yt-audio-meta/)
// NO se migraron: siguen viviendo solo en Vercel Blob (son chicos y ya
// estaban bien ahí), así que su base sigue siendo la de siempre.
const BLOB_BASE = import.meta.env.VITE_BLOB_BASE_URL || BLOB_BASE_DEFAULT

// Cache positivo en memoria: si ya confirmamos que existe, no re-HEADear
// en cada render/click de la misma sesión.
const knownCached = new Set<VideoId>() // videoId

// Alias descubiertos (por el índice leído del CDN, o por el server): "este
// videoId es la MISMA canción que ese otro videoId ya cacheado". Vive
// solo en memoria de esta sesión — el dedupe real y compartido entre
// usuarios vive en el store de audio, esto es únicamente para no repetir
// la consulta del índice cuando la misma pista se vuelve a tocar.
const knownAlias = new Map<VideoId, VideoId>() // videoId (pedido) -> videoId (canónico)

/** Todas las combinaciones base×extensión, en orden hot→frío: se prueba
 *  CADA extensión contra el nivel HOT antes de pasar al siguiente nivel,
 *  porque un acierto en el nivel de arriba es mucho más rápido que
 *  agotar variantes en un nivel frío. */
function candidateUrls(videoId: VideoId): string[] {
  const paths = candidateAudioPaths(videoId)
  return AUDIO_BASES.flatMap((base) => paths.map((path) => `${base}/${path}`))
}

// Timeout por HEAD individual: sin esto, un candidato colgado (host lento/
// caído, CORS preflight que nunca resuelve) bloqueaba TODA la cadena antes
// de llegar al IFrame — justo lo contrario de "IFrame instantáneo".
const HEAD_TIMEOUT_MS = 2500

function headWithTimeout(url: string): Promise<Response | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS)
  return fetch(url, { method: 'HEAD', signal: controller.signal })
    .catch(() => null)
    .finally(() => clearTimeout(timer))
}

/**
 * ¿Ya está el audio en el blob store? Devuelve la URL pública lista para
 * <audio>, o null. Antes esto probaba cada candidato (hasta 3 bases × 2
 * extensiones = 6 HEADs) uno por uno, en serie, sin timeout — un solo
 * candidato lento agregaba segundos enteros de espera ANTES de siquiera
 * intentar el IFrame, que se supone es "instantáneo". Ahora se lanzan
 * todos los HEAD en paralelo (con timeout individual) y se toma el
 * primero que responda ok — como como mucho existe UN candidato real por
 * videoId, no hay riesgo de "carrera" entre resultados válidos.
 */
export async function getCachedAudioUrl(videoId: string | null | undefined): Promise<string | null> {
  if (!isVideoId(videoId)) return null
  const target = knownAlias.get(videoId) || videoId
  const urls = candidateUrls(target)
  const firstUrl = urls[0]
  if (knownCached.has(target)) return firstUrl ?? null
  if (urls.length === 0) return null

  const results = await Promise.all(
    urls.map(async (url) => {
      const res = await headWithTimeout(url)
      return res?.ok ? url : null
    }),
  )
  const hit = results.find((u): u is string => u !== null)
  if (hit) {
    knownCached.add(target)
    return hit
  }
  return null
}

/** Versión booleana para sweeps/prefetch masivos. */
export async function isCachedRemote(videoId: string | null | undefined): Promise<boolean> {
  return !!(await getCachedAudioUrl(videoId))
}

/**
 * ¿Esta canción (por título+artista) ya está cacheada bajo OTRO videoId?
 * Lee el índice directo del CDN del Blob store — ni HEAD al store de
 * candidatos ni POST a /api/ytcache, así que no hay riesgo de cold start
 * de función: es la misma clase de latencia que el chequeo exacto de
 * arriba. Confirma además que el audio referenciado sigue existiendo
 * antes de devolverlo (por si se limpió del store).
 */
export async function lookupCanonicalVideoId(
  title: string | null | undefined,
  artist: string | null | undefined,
): Promise<VideoId | null> {
  const songKey = getSongKey(title, artist)
  if (!songKey) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS)
  try {
    const res = await fetch(`${BLOB_BASE}/${indexPathFor(songKey)}`, { cache: 'no-store', signal: controller.signal })
    if (!res.ok) return null
    const data = (await res.json().catch(() => null)) as { videoId?: string } | null
    const videoId = data?.videoId
    if (!videoId || !isVideoId(videoId)) return null
    if (!(await getCachedAudioUrl(videoId))) return null
    return videoId
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface CachedAudioResolution {
  url: string
  videoId: VideoId
}

export interface SongMeta {
  title?: string
  artist?: string
}

/**
 * Punto de entrada único para "¿hay audio real ya listo para esta
 * pista?" — combina el chequeo exacto y el alias por canción. Devuelve
 * `{ url, videoId }` (el videoId puede no ser el pedido, si se resolvió
 * por alias) o null si de verdad no hay nada cacheado todavía.
 */
export async function resolveCachedAudio(
  videoId: string | null | undefined,
  meta: SongMeta = {},
): Promise<CachedAudioResolution | null> {
  const direct = await getCachedAudioUrl(videoId)
  if (direct) return { url: direct, videoId: knownAlias.get(videoId as VideoId) ?? (videoId as VideoId) }

  const canonical = await lookupCanonicalVideoId(meta.title, meta.artist)
  if (canonical && canonical !== videoId) {
    const url = await getCachedAudioUrl(canonical)
    if (url) {
      knownAlias.set(videoId as VideoId, canonical)
      return { url, videoId: canonical }
    }
  }
  return null
}

/**
 * Pide al server que extraiga y suba el audio de `videoId` (idempotente:
 * si ya está cacheado responde ready al toque; si hay un job corriendo,
 * no duplica). Fire-and-forget friendly.
 *
 * `meta.title`/`meta.artist`, si se mandan, habilitan el dedupe por
 * canción del lado servidor: si la MISMA canción ya está cacheada bajo
 * otro videoId (frecuente en YT Music: audio oficial, video oficial,
 * lyric video...), el server devuelve `{status:'ready', videoId: <el
 * otro>}` en vez de re-extraer. El videoId de la respuesta es siempre el
 * que hay que usar para reproducir — puede no ser el que se pidió.
 * Nota: para saber esto ANTES de arrancar el IFrame, usar
 * resolveCachedAudio() (arriba) — este POST es el que efectivamente
 * dispara la extracción cuando de verdad no hay nada cacheado.
 */
export type RequestCacheStatus = 'ready' | 'processing' | 'invalid' | 'error' | 'unconfigured' | 'rate-limited'

export interface RequestCacheResult {
  status: RequestCacheStatus
  videoId?: VideoId
  aliasOf?: VideoId
  error?: string
}

export async function requestCache(
  videoId: string | null | undefined,
  meta: SongMeta = {},
): Promise<RequestCacheResult> {
  if (!isVideoId(videoId)) return { status: 'invalid' }
  const requested = videoId
  try {
    const res = await fetch('/api/ytcache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, title: meta.title || '', artist: meta.artist || '' }),
    })
    const data = (await res.json().catch(() => ({}))) as Partial<RequestCacheResult> | null
    const result = (data ?? {}) as RequestCacheResult
    if (result.videoId && result.videoId !== requested) knownAlias.set(requested, result.videoId)
    return result
  } catch {
    return { status: 'error' }
  }
}

/**
 * Precalienta: dispara la extracción sin esperar nada (gesto hover/touch
 * sobre una tarjeta, sweep de heavy rotation, precaché de la cola).
 * Mismo nombre/contrato que el viejo warm del resolutor para que los
 * call-sites de UI no cambien de semántica.
 */
export function warmYouTubeAudio(videoId: string | null | undefined, meta: SongMeta = {}): void {
  if (!videoId) return
  requestCache(videoId, meta).catch(() => {})
}

/**
 * Polling del HEAD hasta que el upload termine (o timeout). `onReady`
 * recibe la URL pública cuando aparece. Cancelable cambiando de pista:
 * `isStale()` lo evalúa el caller en cada tick.
 */
export function watchCacheReady(
  videoId: string | null | undefined,
  {
    onReady,
    onExhausted,
    isStale,
    intervalMs = 3000,
    maxTries = 40,
  }: {
    onReady?: (url: string) => void
    /** Se agotaron los reintentos sin que el blob aparezca (sin contar
     *  cortes por `isStale`) — el caller puede usar esto para probar otra
     *  fuente en vez de quedarse escuchando el IFrame para siempre. */
    onExhausted?: () => void
    isStale?: () => boolean
    intervalMs?: number
    maxTries?: number
  },
): () => void {
  let tries = 0
  // Ticker por Web Worker a propósito: con la app en segundo plano los
  // navegadores recortan setInterval a ~1/min, y este polling es JUSTO lo
  // que decide cuándo la pista pasa de IFrame (que YouTube ya no deja
  // sonar bloqueada) al audio real del blob. El worker no se throttlea.
  const stop = createWorkerInterval(async () => {
    tries += 1
    if (isStale?.()) {
      stop()
      return
    }
    if (tries > maxTries) {
      stop()
      onExhausted?.()
      return
    }
    const url = await getCachedAudioUrl(videoId)
    if (url) {
      stop()
      onReady?.(url)
    }
  }, intervalMs)
  return () => stop()
}
