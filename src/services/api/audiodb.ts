// Communicates with TheAudioDB via a proxy (/api/audiodb/*) to safeguard the API key.
import { fetchJsonRobust } from '@shared/lib/httpClient'
import type { ArtistInfo } from '@/types/models'

const CACHE_KEY = 'xfy_audiodb_cache_v3' // v3: prefer strBiographyES over EN-only
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

function readCache(): Record<string, { value: unknown; fetchedAt: number }> {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, { value: unknown; fetchedAt: number }>) : {}
  } catch {
    return {}
  }
}

function writeCache(cache: Record<string, { value: unknown; fetchedAt: number }>): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // Non-critical fallback if localStorage is unavailable.
  }
}

function cacheKeyFor(type: string, query: string): string {
  return `${type}:${String(query).toLowerCase().trim()}`
}

// Timeout corto (8s) y sin reintentos: acá arriba (lookupArtistInfo,
// lookupAudioDbArtwork) cada llamador ya envuelve esto en un .catch(()
// => null) y sigue con otra fuente — no vale la pena hacer esperar al
// resto de la página (bio, tema de color) por un tercer intento a una
// API de enriquecimiento opcional.
async function fetchJson(url: string): Promise<unknown> {
  return fetchJsonRobust(url, { timeoutMs: 8000, retries: 0 })
}

// Extrae el artista principal para mejorar las búsquedas en AudioDB
function getPrimaryArtist(artistStr: string | null | undefined): string {
  if (!artistStr) return ''
  return artistStr.split(/,|&| feat\.? | ft\.? | y /i)[0]?.trim() ?? ''
}

// Proxies external image URLs through our server to avoid CORS and HTTP→HTTPS issues.
function proxyImageUrl(url: string | null): string | null {
  if (!url) return null
  return `/api/imgproxy?url=${encodeURIComponent(url)}`
}

export async function lookupArtistInfo(artist: string | null | undefined): Promise<ArtistInfo | null> {
  if (!artist) return null

  const primaryArtist = getPrimaryArtist(artist)
  if (!primaryArtist) return null

  const key = cacheKeyFor('artist', primaryArtist)
  const cache = readCache()
  const cached = cache[key]
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value as ArtistInfo | null

  try {
    const url = `/api/audiodb/search.php?s=${encodeURIComponent(primaryArtist)}`
    const json = (await fetchJson(url)) as { artists?: { strArtist?: string; strGenre?: string; strStyle?: string; strBiographyES?: string; strBiographyEN?: string; intFormedYear?: string; strArtistThumb?: string; strArtistLogo?: string; strCountry?: string }[] } | null
    const artistData = json?.artists?.[0]
    if (!artistData) {
      cache[key] = { value: null, fetchedAt: Date.now() }
      writeCache(cache)
      return null
    }

    const rawThumb = artistData.strArtistThumb || artistData.strArtistLogo || null
    // TheAudioDB trae biografías por idioma en campos separados
    // (strBiographyES, strBiographyEN, ...). Antes solo se usaba la
    // versión en inglés, mostrando texto en inglés en una app en
    // español aunque hubiera una versión en español disponible.
    const value = {
      name: artistData.strArtist,
      genre: artistData.strGenre,
      style: artistData.strStyle,
      biography: artistData.strBiographyES || artistData.strBiographyEN || null,
      biographyIsTranslated: !artistData.strBiographyES && !!artistData.strBiographyEN,
      yearFormed: artistData.intFormedYear,
      thumb: proxyImageUrl(rawThumb),
      country: artistData.strCountry,
    }

    cache[key] = { value, fetchedAt: Date.now() }
    writeCache(cache)
    return value
  } catch (e) {
    console.warn('[XFY] AudioDB artist lookup falló')
    return null
  }
}

export async function lookupAudioDbArtwork(title: string | null | undefined, artist: string | null | undefined, album?: string | null): Promise<string | null> {
  if (!artist) return null

  const key = cacheKeyFor('artwork', `${title}::${artist}::${album || ''}`)
  const cache = readCache()
  const cached = cache[key]
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value as string | null

  try {
    // Prefer album artwork; fallback to artist thumbnail.
    let artwork = null

    if (artist && album) {
      const albumUrl = `/api/audiodb/searchalbum.php?s=${encodeURIComponent(artist)}`
      const albumJson = (await fetchJson(albumUrl)) as { album?: { strAlbum?: string; strAlbumThumb?: string; strAlbumCDArt?: string; strArtistThumb?: string }[] } | null
      const albumMatch = albumJson?.album?.find((item) =>
        item.strAlbum?.toLowerCase().trim() === album.toLowerCase().trim(),
      )
      if (albumMatch) {
        artwork = proxyImageUrl(albumMatch.strAlbumThumb || albumMatch.strAlbumCDArt || albumMatch.strArtistThumb || null)
      }
    }

    if (!artwork) {
      const artistInfo = await lookupArtistInfo(artist)
      artwork = artistInfo?.thumb || null // already proxied by lookupArtistInfo
    }

    cache[key] = { value: artwork, fetchedAt: Date.now() }
    writeCache(cache)
    return artwork
  } catch (e) {
    console.warn('[XFY] AudioDB artwork lookup falló')
    return null
  }
}
