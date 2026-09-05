// Cliente para buscar e importar playlists de YouTube Music.
// Apoya la feature de "importar playlist desde YT" en PlaylistsPage.
import { cachedFetch } from '@shared/lib/requestCache'
import { fetchJsonRobust, HttpError } from '@shared/lib/httpClient'
import type { PlaylistInfo, Song } from '@/types/models'

/** Playlist importable: metadata + songs (isCacheable exige songs no vacío). */
export interface YTPlaylistDetail {
  id: string
  title?: string
  author?: string | null
  thumbUrl?: string | null
  songs: Song[]
}

const HOUR = 1000 * 60 * 60

// Mismo timeout/reintento que ytmusic.js (services/api/ytmusic.js) —
// pega a la misma función serverless, con las mismas limitaciones de
// cold start / bloqueo de IP explicadas ahí.
async function fetchJson<T = unknown>(path: string): Promise<T> {
  try {
    return await fetchJsonRobust<T>(path, { timeoutMs: 20000, retries: 1 })
  } catch (err) {
    if (err instanceof HttpError) {
      const wrapped = new Error(`ytmusic ${err.status}: ${err.message}`) as Error & { status: number }
      wrapped.status = err.status
      throw wrapped
    }
    throw err
  }
}

// Busca playlists públicas de YT Music por término (álbumes, playlists
// de artistas, colecciones populares). Útil para que el usuario busque
// por nombre y elija cuál importar.
export function searchYTPlaylists(query: string | null | undefined, limit = 12): Promise<PlaylistInfo[]> {
  const q = String(query || '').trim()
  if (!q) return Promise.resolve([])
  return cachedFetch<PlaylistInfo[]>('ytpl-search', `${q}:${limit}`, 2 * HOUR, () =>
    fetchJson<PlaylistInfo[]>(`/api/ytmusic?op=searchPlaylists&q=${encodeURIComponent(q)}&limit=${limit}`),
  )
}

// Trae el contenido completo de una playlist: título, autor, portada y
// todas las canciones con videoId reproducible.
//
// El segundo argumento de cachedFetch (isCacheable) es clave acá: una
// playlist con songs:[] no es un resultado válido para guardar 6 horas —
// es indistinguible de un fallo transitorio upstream. Sin este chequeo,
// un solo intento fallido queda "pegado" en el caché del navegador y
// sigue devolviendo la playlist vacía aunque el backend ya esté bien.
export function getYTPlaylist(playlistId: string | null | undefined): Promise<YTPlaylistDetail | null> {
  if (!playlistId) return Promise.resolve(null)
  return cachedFetch<YTPlaylistDetail | null>(
    'ytpl-detail',
    playlistId,
    6 * HOUR,
    () => fetchJson<YTPlaylistDetail>(`/api/ytmusic?op=playlist&playlistId=${encodeURIComponent(playlistId)}`),
    (data) => Array.isArray(data?.songs) && data.songs.length > 0,
  )
}
