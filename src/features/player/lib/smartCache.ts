// ============================================================
// Smart Audio Cache — precalienta el caché compartido de Vercel Blob
// (ver ytblob.js / api/ytcache.js) con prioridades basadas en escucha
// real (estilo Spotify / YT Music).
//
// Cómo funcionan los sistemas reales y qué replica cada pieza acá:
//
//   Spotify — prefetch buffer: mientras suena A, se dispara la
//   extracción+upload de B (y C) al Blob store para que skip/next
//   arranquen instantáneos desde el CDN la próxima vez.
//     → prefetchQueueAhead(): las próximas 2 pistas de la cola piden
//       requestCache() mientras suena la actual.
//
//   YT Music "Recently played" — auto-descarga los últimos ~200 temas
//   escuchados.
//     → sweepHeavyRotation(): mantiene cacheado en el Blob store lo
//       reciente y lo de top-escucha (señales de metrics.js), con tope
//       por sweep para no saturar las funciones serverless.
//
//   Regla de oro compartida: NADA de esto bloquea la reproducción. La
//   pista actual siempre arranca por Blob→IFrame ya (ver usePlayerStore);
//   el caché se llena por detrás vía requestCache (POST /api/ytcache,
//   fire-and-forget, dedupe/idempotente en el server).
//
// Cortesía de red: se respeta navigator.connection.saveData y se limita
// la cantidad de requests de cacheo por sweep.
// ============================================================

import { resolveCachedAudio, requestCache } from './ytblob'
import { getTopSongs } from '@shared/lib/metrics'
import { dedupeSongs, primaryArtistName } from '@shared/lib/songIdentity'

const SWEEP_MIN_GAP_MS = 30 * 60 * 1000 // no más de un sweep cada 30 min
const MAX_PREFETCH_AHEAD = 2 // pistas siguientes a precachean (Spotify baja ~1-3)
const MAX_SWEEP_DOWNLOADS = 8 // tope de pedidos de cacheo nuevos por sweep

let lastSweepAt = 0
let sweeping = false

// Modo ahorro de datos manual (Configuración > Reproducción), además del
// navigator.connection.saveData del sistema operativo — cubre el caso de
// quien quiere frenar el prefetch de fondo sin depender de que el OS/red
// exponga esa señal (Wi-Fi limitado, plan de datos chico, etc).
const DATA_SAVER_KEY = 'xfy_data_saver'

export function isDataSaverEnabled(): boolean {
  try {
    return localStorage.getItem(DATA_SAVER_KEY) === '1'
  } catch {
    return false
  }
}

export function setDataSaverEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(DATA_SAVER_KEY, '1')
    else localStorage.removeItem(DATA_SAVER_KEY)
  } catch {
    // no-op
  }
}

function isNetworkFriendly() {
  if (isDataSaverEnabled()) return false
  try {
    const conn = typeof navigator !== 'undefined' ? navigator.connection : null
    if (conn?.saveData) return false
    return true
  } catch {
    return true
  }
}

/**
 * Precachea las próximas pistas reproducibles de la cola (solo YouTube;
 * las externas ya tenían su propio prefetch). Dispara requestCache()
 * para cada una — el server dedupea internamente si ya hay un job
 * corriendo o si el blob ya existe, así que es seguro llamarlo seguido.
 */
export async function prefetchQueueAhead(
  queue: import('@shared/lib/songIdentity').SongLike[],
  currentIndex: number,
  ahead: number = MAX_PREFETCH_AHEAD,
): Promise<void> {
  if (!Array.isArray(queue) || queue.length < 2 || !isNetworkFriendly()) return

  const targets = []
  const seen = new Set()
  for (let step = 1; step <= ahead; step++) {
    const song = queue[(currentIndex + step) % queue.length]
    if (!song?.id) continue
    const id = String(song.videoId || song.id)
    if (seen.has(id)) continue
    seen.add(id)
    targets.push(song)
  }

  for (const song of targets) {
    const videoId = String(song.videoId || song.id)
    const meta = { title: song.title, artist: primaryArtistName(song) }
    try {
      if (await resolveCachedAudio(videoId, meta)) continue
      await requestCache(videoId, meta)
    } catch {
      /* prefetch es best-effort: cualquier fallo no molesta */
    }
  }
}

/**
 * Sweep estilo "Smart Downloads": repone en caché lo que el usuario
 * claramente escucha y que por eviction/LRU pudo haber caído.
 *
 * Señales combinadas (dedup por identidad canónica de canción):
 *   - Top canciones de los últimos 30 días por tiempo de escucha (metrics).
 *   - Recientemente reproducidas (historial del player store).
 *   - Canciones de las playlists guardadas del usuario (`libraryPlaylistSongs`):
 *     a diferencia de las dos anteriores (que son "lo que ya sonó"), esto
 *     cachea lo que el usuario ARMÓ para escuchar después, haya sonado o
 *     no todavía — mismo criterio que el "Descargar" automático de una
 *     playlist en Spotify cuando la marcás como favorita.
 *
 * Throttled internamente: máximo 1 sweep cada SWEEP_MIN_GAP_MS salvo
 * force=true (arranque de app). Cada sweep dispara como mucho
 * MAX_SWEEP_DOWNLOADS pedidos de cacheo nuevos (POST /api/ytcache).
 */
export async function sweepHeavyRotation({
  recentlyPlayed = [],
  libraryPlaylistSongs = [],
  force = false,
}: {
  recentlyPlayed?: import('@shared/lib/songIdentity').SongLike[]
  libraryPlaylistSongs?: import('@shared/lib/songIdentity').SongLike[]
  force?: boolean
} = {}): Promise<void> {
  const now = Date.now()
  if (!force && now - lastSweepAt < SWEEP_MIN_GAP_MS) return
  if (sweeping || !isNetworkFriendly()) return
  sweeping = true
  lastSweepAt = now

  try {
    const top = getTopSongs('30d', 15).map((s) => ({
      id: s.id,
      videoId: s.id,
      title: s.title,
      artist: s.artist,
      albumArtUrl: s.albumArtUrl,
    }))
    // Orden a propósito: top + recientes primero (más probable que se
    // toquen ya), playlists guardadas al final — son candidatas válidas
    // pero de menor prioridad inmediata que lo que el usuario ya venía
    // escuchando de verdad.
    const candidates = dedupeSongs([...top, ...(recentlyPlayed || []), ...(libraryPlaylistSongs || [])])
      .filter((s) => s.id != null && s.title)
      .slice(0, 40)

    let started = 0
    for (const song of candidates) {
      if (started >= MAX_SWEEP_DOWNLOADS) break
      const videoId = String(song.videoId || song.id)
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue
      const meta = { title: song.title, artist: primaryArtistName(song) }
      try {
        if (await resolveCachedAudio(videoId, meta)) continue
        await requestCache(videoId, meta)
        started += 1
      } catch {
        /* best-effort */
      }
    }
  } finally {
    sweeping = false
  }
}
