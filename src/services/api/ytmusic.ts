/** Lightweight client for the internal /api/ytmusic serverless function. Integrates with the local request cache with specific TTLs. */
import { cachedFetch } from '@shared/lib/requestCache'
import { fetchJsonRobust, HttpError } from '@shared/lib/httpClient'
import type { AlbumFull, ArtistResult, Song } from '@/types/models'

const HOUR = 1000 * 60 * 60
const DAY = HOUR * 24

// Timeout generoso (la función serverless tiene hasta 30s de maxDuration
// para un cold start de ytmusic-api) y UN solo reintento — ver el
// comentario en httpClient.js sobre por qué no insistimos más que eso.
async function fetchJson<T = unknown>(path: string): Promise<T> {
  const url = path.startsWith('/') ? path : `/${path}`
  try {
    return await fetchJsonRobust<T>(url, { timeoutMs: 20000, retries: 1 })
  } catch (err) {
    if (err instanceof HttpError) {
      const wrapped = new Error(`YT Music API respondió ${err.status}: ${err.message}`) as Error & { status: number }
      wrapped.status = err.status
      throw wrapped
    }
    throw err
  }
}

/** Searches YT Music for songs. Cached for 2 hours. */
export async function searchSongs(query: string | null | undefined, limit = 25): Promise<Song[]> {
  const q = String(query || '')
  return cachedFetch<Song[]>('ytmusic-search', `${q}:${limit}`, 2 * HOUR, () =>
    fetchJson<Song[]>(`/api/ytmusic?op=search&q=${encodeURIComponent(q)}&limit=${limit}`),
  )
}

/** Searches YT Music for artists. Cached for 7 days. */
export async function searchArtists(query: string | null | undefined, limit = 12): Promise<ArtistResult[]> {
  const q = String(query || '')
  return cachedFetch<ArtistResult[]>('ytmusic-search-artists', `${q}:${limit}`, 7 * DAY, () =>
    fetchJson<ArtistResult[]>(`/api/ytmusic?op=searchArtists&q=${encodeURIComponent(q)}&limit=${limit}`),
  )
}

/** Artist profile con top tracks + discografía + bio nativa del canal. */
export interface ArtistProfile {
  id: string
  name?: string | null
  thumbUrl?: string | null
  description?: string | null
  songs: Song[]
  albums: { id: string; albumId?: string; title: string; year?: string | null; thumbUrl?: string | null }[]
  singles: { id: string; albumId?: string; title: string; year?: string | null; thumbUrl?: string | null }[]
}

/** Fetch an artist's full profile and top tracks by artistId. Cached for 3 days.
 *  v2: la respuesta ahora trae albums/singles de los carruseles correctos
 *  (antes getArtistAlbums devolvía carruseles arbitrarios) — la clave nueva
 *  invalida las entradas viejas cacheadas en localStorage sin esperar el TTL. */
export async function getArtist(artistId: string): Promise<ArtistProfile | null> {
  return cachedFetch<ArtistProfile | null>('ytmusic-artist-v2', artistId, 3 * DAY, () =>
    fetchJson<ArtistProfile | null>(`/api/ytmusic?op=artist&artistId=${encodeURIComponent(artistId)}`),
  )
}

/** Fetch full album tracklist by albumId. Cached for 3 days. */
export async function getAlbum(albumId: string): Promise<AlbumFull | null> {
  return cachedFetch<AlbumFull | null>('ytmusic-album', albumId, 3 * DAY, () =>
    fetchJson<AlbumFull | null>(`/api/ytmusic?op=album&albumId=${encodeURIComponent(albumId)}`),
  )
}

/** Fetch current trending tracks. Cached for 3 hours. */
export async function getTrendingTracks(limit = 24): Promise<Song[]> {
  return cachedFetch<Song[]>('ytmusic-trending', String(limit), 3 * HOUR, () =>
    fetchJson<Song[]>(`/api/ytmusic?op=trending&limit=${limit}`),
  )
}

/** Fetch YT Music's own "radio"/related songs for a videoId (same graph
 *  music.youtube.com uses for its autoplay). This is the recommendation
 *  engine behind smart autoplay extension and Smart Shuffle — Spotify's
 *  own Recommendations/Related Artists endpoints have been unavailable to
 *  new third-party apps since Nov 2024, so this is the real signal source.
 *  Cached briefly: it's meant to feel fresh, not to be a static catalog. */
export async function getRelatedSongs(videoId: string | null | undefined, limit = 10): Promise<Song[]> {
  const id = String(videoId || '')
  if (!id) return []
  return cachedFetch<Song[]>('ytmusic-related', `${id}:${limit}`, 30 * 60 * 1000, () =>
    fetchJson<Song[]>(`/api/ytmusic?op=related&videoId=${encodeURIComponent(id)}&limit=${limit}`),
  )
}

/** Fetch plain lyrics for a videoId as a fallback. Cached for 30 days. */
export async function getYTMusicLyrics(videoId: string): Promise<string | null> {
  const r = await cachedFetch<{ lines?: string | null } | null>('ytmusic-lyrics', videoId, 30 * DAY, () =>
    fetchJson<{ lines?: string | null }>(`/api/ytmusic?op=lyrics&videoId=${encodeURIComponent(videoId)}`),
  )
  return r?.lines || null
}

/**
 * Fetch full song metadata to hydrate missing details like featured artists. Cached for 30 days.
 *
 * Un 404 acá significa "este videoId no existe como canción en el catálogo de YT Music" —
 * a diferencia de un fallo de red o un 5xx transitorio, eso no cambia de un pedido al
 * siguiente. Sin distinguirlo, cada reproducción de esa canción volvía a pegarle a la
 * función serverless para siempre (cachedFetch nunca cachea rechazos, a propósito, para
 * no repetir errores transitorios — pero un 404 confirmado no es transitorio). Se cachea
 * `null` como resultado válido, con el mismo TTL de 30 días que un hit real: si YT Music
 * llega a catalogarla más adelante, en el peor caso tarda hasta 30 días en notarse, lo
 * cual es aceptable porque esto solo hidrata un dato de enriquecimiento (featured artists),
 * nunca bloquea la reproducción.
 */
export async function getSong(videoId: string): Promise<Song | null> {
  return cachedFetch<Song | null>('ytmusic-song', videoId, 30 * DAY, async () => {
    try {
      return await fetchJson<Song | null>(`/api/ytmusic?op=song&videoId=${encodeURIComponent(videoId)}`)
    } catch (err) {
      if (err instanceof Error && (err as Error & { status?: number }).status === 404) return null
      throw err
    }
  })
}
