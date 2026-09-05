// ============================================================
// Apple/iTunes gateway — punto único de salida hacia
// itunes.apple.com (vía el rewrite /api/itunes/*).
// ------------------------------------------------------------
// Antes había 3 consumidores independientes pegándole a Apple sin
// coordinarse entre sí: la búsqueda de portada en services/api/itunes.js
// (nunca conectada a la UI real), un fetch suelto adentro de
// usePlayerStore.js para el fallback de nombre de artista, y los
// 6 fetches en paralelo que dispara motionart.js del lado servidor.
// Cada uno con su propio caché (o sin caché), sin límite de
// concurrencia compartido y sin manejo de 403/429 — así es fácil
// que se pisen entre sí cuando varias tarjetas piden portada al
// mismo tiempo.
//
// Este módulo es el ÚNICO lugar del cliente que llama a
// itunes.apple.com de ahora en más:
//   - 1 sola request en vuelo a la vez (cola FIFO)
//   - espaciado mínimo entre requests para no gatillar el rate
//     limit no documentado de Apple (~20 req/min por IP)
//   - circuit breaker: si Apple responde 403/429, se pausan los
//     próximos N segundos y se devuelve null (nunca se rompe la UI)
//   - caché compartido en localStorage con la misma clave para
//     todos los que pidan lo mismo (dedupe de requests en vuelo)
// ============================================================

import { cachedFetch } from '@shared/lib/requestCache'

const MIN_SPACING_MS = 350 // ritmo entre calls a Apple
const BACKOFF_ON_BLOCK_MS = 30_000 // pausa si Apple devuelve 403/429
const ARTWORK_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 días
const ARTIST_TTL_MS = 1000 * 60 * 60 * 24 * 7 // 7 días

let queue: Promise<unknown> = Promise.resolve()
let blockedUntil = 0
const inFlight = new Map<string, Promise<string | null>>() // dedupe: misma key pedida por 2 lugares a la vez comparte la promesa

function upscaleArtwork(url: string | null | undefined): string | null {
  if (!url) return null
  return url.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/1200x1200bb.$1')
}

function normalize(str = ''): string {
  return String(str).toLowerCase().trim()
}

/** Serializa todas las llamadas a Apple detrás de una sola cola con espaciado mínimo. */
function scheduleAppleCall<T>(fn: () => Promise<T | null>): Promise<T | null> {
  const run = queue.then(async () => {
    if (Date.now() < blockedUntil) return null
    const result = await fn()
    await new Promise((r) => setTimeout(r, MIN_SPACING_MS))
    return result
  })
  // Si una llamada falla, no debe trabar las siguientes en la cola.
  queue = run.catch(() => {})
  return run
}

interface ITunesResult {
  artworkUrl100?: string
  artistName?: string
}

async function rawItunesSearch(term: string, opts: Record<string, string> = {}): Promise<ITunesResult[]> {
  if (Date.now() < blockedUntil) return []
  // Timeout explícito, no vía httpClient.js: este módulo ya tiene su
  // propia cola FIFO + circuit breaker (ver comentario arriba), y
  // agregar los reintentos de httpClient encima duplicaría lógica y
  // pisaría el backoff propio de acá. Lo único que faltaba era esto: sin
  // límite de tiempo, un solo fetch() colgado trababa la cola ENTERA
  // para siempre (todo lo que viniera después queda esperando a que esta
  // promesa se resuelva, cosa que nunca pasaba).
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 9000)
  try {
    const params = new URLSearchParams({ term, media: 'music', limit: '1', ...opts })
    const res = await fetch(`/api/itunes/search?${params.toString()}`, { signal: controller.signal })
    if (res.status === 403 || res.status === 429) {
      blockedUntil = Date.now() + BACKOFF_ON_BLOCK_MS
      console.warn(`[XFY] Apple/iTunes respondió ${res.status} — backoff activado`)
      return []
    }
    if (!res.ok) return []
    const json = (await res.json()) as { results?: ITunesResult[] }
    return json.results ?? []
  } catch (e) {
    console.warn('[XFY] iTunes search falló')
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** Portada en alta resolución (1200x1200) por título + artista. Reemplaza services/api/itunes.js. */
export function lookupArtwork(title: string, artist: string): Promise<string | null> {
  const key = `${normalize(title)}::${normalize(artist)}`
  const pending = inFlight.get(key)
  if (pending) return pending

  const promise = cachedFetch(
    'apple-artwork',
    key,
    ARTWORK_TTL_MS,
    () =>
      scheduleAppleCall(async () => {
        const results = await rawItunesSearch(`${title} ${artist}`, { entity: 'song' })
        return upscaleArtwork(results[0]?.artworkUrl100 || null)
      }),
    // No cachear `null`: si Apple nos bloqueó (403/429) o la canción no tuvo match
    // esta vez, cachear "sin portada" por 30 días dejaría el fallback roto mucho
    // más tiempo del que dura el bloqueo real (30s) — mejor reintentar la próxima vez.
    (value) => value !== null,
  ).finally(() => inFlight.delete(key))

  inFlight.set(key, promise)
  return promise
}

/** Nombre real de artista (con colaboradores) por título + artista aproximado. */
export function lookupArtistName(title: string, artist: string): Promise<string | null> {
  const key = `artist:${normalize(title)}::${normalize(artist)}`
  const pending = inFlight.get(key)
  if (pending) return pending

  const promise = cachedFetch(
    'apple-artist-name',
    key,
    ARTIST_TTL_MS,
    () =>
      scheduleAppleCall(async () => {
        const results = await rawItunesSearch(`${title} ${artist}`, { entity: 'song' })
        return results[0]?.artistName || null
      }),
    // Mismo motivo que en lookupArtwork: un `null` (bloqueo transitorio o sin match)
    // no debe quedar cacheado 7 días — dejaría el nombre del artista incompleto en
    // el reproductor durante toda esa semana en vez de corregirse en el próximo intento.
    (value) => value !== null,
  ).finally(() => inFlight.delete(key))

  inFlight.set(key, promise)
  return promise
}
