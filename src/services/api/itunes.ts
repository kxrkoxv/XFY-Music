// ============================================================
// iTunes Search API — solo para portadas
// ------------------------------------------------------------
// Sin API key, sin problemas de CORS. Se usa únicamente para subir la
// calidad de la portada cuando la existente (Bing/Pinterest) es poco
// confiable. El audio y la info de las canciones siguen siendo tuyos.
// ============================================================
import type { iTunesArtwork } from '@/types/models'
import { fetchJsonRobust } from '@shared/lib/httpClient'

const CACHE_KEY = 'xfy_itunes_artwork_cache_v1'
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 días

interface CacheEntry {
  url: string | null
  fetchedAt: number
}

type Cache = Record<string, CacheEntry>

function readCache(): Cache {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as Cache) : {}
  } catch {
    return {}
  }
}

function writeCache(cache: Cache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // localStorage lleno o no disponible: seguimos sin cache persistente
  }
}

function cacheKeyFor(title: string, artist: string): string {
  return `${title.toLowerCase().trim()}::${artist.toLowerCase().trim()}`
}

// Sube la resolución de portada que da iTunes por defecto (100x100) a algo
// que de verdad se ve bien en una tarjeta o fondo difuminado.
function upscaleArtwork(url: string | null | undefined): string | null {
  if (!url) return null
  return url.replace(/\/\d+x\d+bb\.jpg$/, '/600x600bb.jpg')
}

export async function lookupArtwork(title: string, artist: string): Promise<iTunesArtwork> {
  const key = cacheKeyFor(title, artist)
  const cache = readCache()
  const cached = cache[key]

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.url
  }

  try {
    const query = encodeURIComponent(`${title} ${artist}`)
    const json = await fetchJsonRobust<{ results?: { artworkUrl100?: string }[] }>(
      `/api/itunes/search?term=${query}&media=music&entity=song&limit=1`,
      {
        timeoutMs: 8000,
        retries: 0,
      },
    )
    const url = upscaleArtwork(json.results?.[0]?.artworkUrl100)

    cache[key] = { url, fetchedAt: Date.now() }
    writeCache(cache)
    return url
  } catch (e) {
    console.warn('[XFY] Búsqueda de portada en iTunes falló')
    return null
  }
}
