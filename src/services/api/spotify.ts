// Cliente para /api/spotify — resuelve una playlist pública de Spotify a
// su metadata + lista de temas "crudos" (título, artista, álbum, portada,
// duración). Estos temas todavía NO son reproducibles: no tienen videoId
// de YouTube. El match contra YT Music se hace en el cliente (ver
// matchSpotifyTrackToSong más abajo) para poder mostrar progreso y no
// pegarle un timeout a la función serverless con playlists grandes.
import { cachedFetch } from '@shared/lib/requestCache'
import { fetchJsonRobust, HttpError } from '@shared/lib/httpClient'
import { searchSongs } from '@services/api/ytmusic'
import type { Song } from '@/types/models'

const HOUR = 1000 * 60 * 60

async function fetchJson<T = unknown>(path: string): Promise<T> {
  try {
    return await fetchJsonRobust<T>(path, { timeoutMs: 20000, retries: 1 })
  } catch (err) {
    if (err instanceof HttpError) {
      const wrapped = new Error(`spotify ${err.status}: ${err.message}`) as Error & { status: number }
      wrapped.status = err.status
      throw wrapped
    }
    throw err
  }
}

export interface SpotifyRawTrack {
  spotifyId: string | null
  title: string
  artist: string
  album: string | null
  thumbUrl: string | null
  durationMs: number
}

export interface SpotifyPlaylistDetail {
  id: string
  title: string
  author: string | null
  thumbUrl: string | null
  tracks: SpotifyRawTrack[]
}

/** Resuelve un link/URI/ID de playlist de Spotify a su metadata + temas crudos. */
export function getSpotifyPlaylist(urlOrId: string): Promise<SpotifyPlaylistDetail | null> {
  const q = String(urlOrId || '').trim()
  if (!q) return Promise.resolve(null)
  return cachedFetch<SpotifyPlaylistDetail | null>(
    'spotify-playlist',
    q,
    6 * HOUR,
    // Vive en /api/ytmusic (op=spotifyPlaylist) y no en su propia función:
    // el plan Hobby de Vercel tiene un tope de 12 Serverless Functions.
    () => fetchJson<SpotifyPlaylistDetail>(`/api/ytmusic?op=spotifyPlaylist&url=${encodeURIComponent(q)}`),
    (data) => Array.isArray(data?.tracks) && data.tracks.length > 0,
  )
}

/** Resultado de intentar emparejar un tema de Spotify con una canción
 *  reproducible de YT Music. `song` es null si no se encontró nada. */
export interface MatchedSpotifyTrack {
  spotify: SpotifyRawTrack
  song: Song | null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Búsqueda "título artista" y toma el primer resultado — es la misma
// heurística que ya usa el resto de la app (ver crossSourceFallback.ts)
// para resolver un tema por nombre cuando no hay ID directo.
//
// BUGFIX (importaciones grandes perdían temas silenciosamente): antes,
// cualquier error de red/timeout/429 en la búsqueda contra /api/ytmusic
// se tragaba acá mismo y el tema quedaba marcado como "sin match" para
// siempre — indistinguible de un tema que genuinamente no existe en YT
// Music. Con listas grandes (cientos de "Me Gusta"), la concurrencia
// sostenida contra la función serverless dispara suficientes fallos
// transitorios como para que se pierda una fracción grande de la lista
// sin ningún aviso. Ahora se reintenta con backoff SOLO cuando la
// búsqueda tira una excepción (fallo real de la request) — una búsqueda
// que responde bien pero sin resultados (`results.length === 0`) sigue
// contando como "sin match" de una sola pasada, porque ahí no hay nada
// que reintentar.
async function matchOne(track: SpotifyRawTrack, retries = 2): Promise<MatchedSpotifyTrack> {
  const query = `${track.title} ${track.artist}`.trim()
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(400 * attempt) // backoff: 400ms, 800ms
    try {
      const results = await searchSongs(query, 5)
      if (results.length === 0) return { spotify: track, song: null }
      
      // Heurística de matching: puntuar cada resultado para encontrar el más cercano
      // a la metadata original (en vez de agarrar ciegas el result[0]).
      // Esto evita que canciones distintas de Spotify caigan en el mismo resultado
      // genérico de YT Music (ej. un mix o un video popular) y luego se dedupliquen.
      let bestResult = results[0]!
      let bestScore = -Infinity
      
      for (const res of results) {
        let score = 0
        const spotifyDur = track.durationMs / 1000
        const ytDur = res.duration || 0
        
        // 1. Duración: penalizar fuertemente las versiones extendidas o mixes
        if (ytDur > 0) {
          const diff = Math.abs(spotifyDur - ytDur)
          if (diff <= 3) score += 50
          else if (diff <= 10) score += 30
          else if (diff > 45) score -= 60
        }
        
        // 2. Coincidencia de título
        const sTitle = res.title.toLowerCase()
        const tTitle = track.title.toLowerCase()
        if (sTitle === tTitle) score += 40
        else if (sTitle.includes(tTitle) || tTitle.includes(sTitle)) score += 15
        
        // 3. Coincidencia de artista
        const sArtist = res.artist.toLowerCase()
        const tArtist = track.artist.toLowerCase()
        if (sArtist === tArtist) score += 40
        else if (sArtist.includes(tArtist) || tArtist.includes(sArtist)) score += 15
        
        // 4. Coincidencia de álbum (si YT Music lo expone)
        if (track.album && res.album) {
          if (res.album.toLowerCase() === track.album.toLowerCase()) score += 15
        }
        
        if (score > bestScore) {
          bestScore = score
          bestResult = res
        }
      }
      
      return { spotify: track, song: bestResult }
    } catch (err) {
      lastErr = err
    }
  }
  console.warn('[spotify import] búsqueda falló tras reintentos:', query, lastErr)
  return { spotify: track, song: null }
}

/**
 * Empareja una lista de temas de Spotify con canciones reproducibles,
 * con concurrencia limitada (para no saturar /api/ytmusic) y reportando
 * progreso — pensado para alimentar una barra de progreso en la UI de
 * importación mientras se resuelve una playlist grande.
 *
 * Concurrencia bajada de 4 a 3: con listas de cientos de temas (ej. "Me
 * Gusta" con 470+), 4 workers en paralelo sostenidos durante varios
 * minutos saturaban la función serverless de búsqueda y elevaban la
 * tasa de fallos transitorios que `matchOne` ahora reintenta — bajar la
 * concurrencia reduce cuánto hay que reintentar en primer lugar.
 */
export async function matchSpotifyTracks(
  tracks: SpotifyRawTrack[],
  onProgress?: (done: number, total: number) => void,
  concurrency = 3,
): Promise<MatchedSpotifyTrack[]> {
  const results: MatchedSpotifyTrack[] = new Array(tracks.length)
  let nextIndex = 0
  let done = 0

  async function worker() {
    while (nextIndex < tracks.length) {
      const i = nextIndex++
      results[i] = await matchOne(tracks[i]!)
      done += 1
      onProgress?.(done, tracks.length)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tracks.length) }, () => worker())
  await Promise.all(workers)
  return results
}
