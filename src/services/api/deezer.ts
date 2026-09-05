/** Deezer API proxy client for fetching official artist metadata, photos, and album catalogs. Bypass CORS restrictions. */
import { fetchJsonRobust } from '@shared/lib/httpClient'

const BASE_URL = '/api/deezer'

const CACHE_KEY = 'xfy_deezer_cache_v1'
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14 // 14 días: catálogo de un artista casi no cambia

interface DeezerArtist {
  id: string
  name: string
  picture?: string
  picture_medium?: string
  picture_big?: string
  nb_album?: number
}

interface DeezerAlbum {
  id: string
  title: string
  record_type?: string
  release_date?: string
  cover?: string
  cover_medium?: string
  cover_big?: string
  tracks?: { data?: { title: string; duration?: number }[] }
}

type DeezerCache = Record<string, { value: unknown; fetchedAt: number }>

function readCache(): DeezerCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as DeezerCache) : {}
  } catch {
    return {}
  }
}

function writeCache(cache: DeezerCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // no crítico
  }
}

async function cachedFetch<T = unknown>(cacheKey: string, url: string): Promise<T | null> {
  const cache = readCache()
  const cached = cache[cacheKey]
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return (cached.value as T | null) ?? null

  try {
    // resolveArtistPhoto (artists.js) llama a esto EN SERIE, en la cadena
    // YT Music -> Deezer -> AudioDB -> Wikipedia — sin timeout, un fetch()
    // colgado acá bloqueaba esa cadena entera y dejaba la foto (y el tema
    // de color derivado de ella) sin resolver nunca. Sin reintentos: si
    // falla, sigue a la próxima fuente en la cadena en vez de insistir.
    const value = (await fetchJsonRobust<T>(url, { timeoutMs: 8000, retries: 0 })) as T & {
      error?: { message?: string }
    }
    // Catch Deezer's 200 OK responses that actually contain an error payload to prevent caching failed states.
    if (value?.error) throw new Error(value.error.message || 'Deezer error')
    cache[cacheKey] = { value, fetchedAt: Date.now() }
    writeCache(cache)
    return value as T
  } catch (e) {
    console.warn('[XFY] Deezer lookup falló')
    return (cached?.value as T | null) ?? null
  }
}

/** Look up artist by name and return ID, best available picture, and album count. Prioritizes exact name matches. */
export async function lookupArtist(name: string | null | undefined) {
  if (!name?.trim()) return null
  const key = `artist:${name.toLowerCase().trim()}`
  const url = `${BASE_URL}/search/artist?q=${encodeURIComponent(name)}&limit=5`
  const json = await cachedFetch<{ data?: DeezerArtist[] }>(key, url)
  const matches = json?.data ?? []
  if (matches.length === 0) return null

  const nameLower = name.toLowerCase().trim()
  const best = matches.find((a) => String(a?.name || '').toLowerCase().trim() === nameLower) ?? matches[0]
  if (!best?.id) return null

  return {
    id: best.id,
    name: best.name,
    // "big" (500x500) provides sufficient resolution for background heroes without extreme payload size.
    picture: best.picture_big || best.picture_medium || best.picture || null,
    albumCount: typeof best.nb_album === 'number' ? best.nb_album : null,
  }
}

const RECORD_TYPE_LABEL: Record<string, string> = {
  album: 'Álbum',
  ep: 'EP',
  single: 'Sencillo',
  compile: 'Compilado',
}

/** Fetch official artist albums. Excludes compilations by default to reduce duplicate tracks. */
export async function getArtistAlbums(artistId: string | null | undefined, limit = 24) {
  if (!artistId) return []
  const key = `albums:${artistId}:${limit}`
  const url = `${BASE_URL}/artist/${artistId}/albums?limit=${limit}`
  const json = await cachedFetch<{ data?: DeezerAlbum[] }>(key, url)
  const items = json?.data ?? []

  return items
    .filter((a) => a.record_type !== 'compile')
    .map((a) => ({
      id: a.id,
      title: a.title,
      type: RECORD_TYPE_LABEL[a.record_type ?? ''] || 'Álbum',
      releaseDate: a.release_date || null,
      coverUrl: a.cover_big || a.cover_medium || a.cover || null,
    }))
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''))
}

/**
 * Tracklist de respaldo por nombre: busca "<artista> <álbum>" en el catálogo
 * de Deezer y devuelve las pistas del mejor match. Es el fallback de
 * getReleaseGroupTracklist (MusicBrainz) para lanzamientos que MusicBrainz
 * conoce pero tiene sin pistas cargadas.
 */
export async function getAlbumTracksByName(artistName: string | null | undefined, albumTitle: string | null | undefined) {
  const query = [artistName, albumTitle].filter(Boolean).join(' ').trim()
  if (!query) return []

  const search = await cachedFetch<{ data?: DeezerAlbum[] }>(
    `album-search:${query.toLowerCase()}`,
    `${BASE_URL}/search/album?q=${encodeURIComponent(query)}&limit=5`,
  )
  const matches = search?.data ?? []
  if (matches.length === 0) return []

  const wanted = String(albumTitle || '').toLowerCase().trim()
  const best =
    matches.find((m) => String(m?.title || '').toLowerCase() === wanted) ||
    matches.find((m) => String(m?.title || '').toLowerCase().includes(wanted)) ||
    matches[0]
  if (!best?.id) return []

  const album = await cachedFetch<DeezerAlbum>(`album:${best.id}`, `${BASE_URL}/album/${best.id}`)
  const tracks = album?.tracks?.data ?? []
  // La duration de Deezer ya viene en segundos enteros.
  return tracks.map((t, i) => ({
    title: t.title,
    duration: t.duration ? Math.round(t.duration) : null,
    position: i + 1,
  }))
}
