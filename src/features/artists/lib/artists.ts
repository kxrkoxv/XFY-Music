import { lookupArtistInfo } from '@services/api/audiodb'
import { lookupArtistBio } from '@services/api/wikipedia'
import {
  lookupArtist as lookupDeezerArtist,
  getArtistAlbums as getDeezerArtistAlbums,
} from '@services/api/deezer'
import {
  lookupArtist as lookupMusicBrainzArtist,
  getDiscography as getMusicBrainzDiscography,
} from '@services/api/musicbrainz'
import { searchArtists } from '@services/api/ytmusic'

// Los servicios viven en módulos JS (Fase 3 los tipa) — las llamadas de
// acá abajo son los bordes sin tipos hasta entonces.

// Deezer rotula los tipos en español (ver RECORD_TYPE_LABEL en deezer.js);
// la UI del catálogo compara contra los tipos canónicos de MusicBrainz.
const DEEZER_TYPE_TO_MB: Record<string, string> = {
  'Álbum': 'Album',
  'EP': 'EP',
  'Sencillo': 'Single',
}

/** Un lanzamiento de la discografía, con la forma EXACTA que espera ArtistPage. */
export interface Release {
  mbid: string
  title: string
  type: string
  secondaryTypes: string[]
  firstReleaseDate?: string | null
  coverArtUrl?: string | null
}

export interface DiscographyResult {
  source: 'musicbrainz' | 'deezer' | null
  releases: Release[]
}

/**
 * Discografía de artista con failover automático entre las dos fuentes:
 *
 *   1. MusicBrainz (primaria): mejor tipado, cobertura de rarezas/directos
 *      y portadas vía Cover Art Archive. Es la que limita ~1 req/s por IP.
 *   2. Deezer (respaldo): no necesita API key extra y ya vive proxificada
 *      en /api/deezer — si MusicBrainz falla, desconoce al artista o no le
 *      tiene discografía útil, el mismo pedido cae acá sin que el caller se
 *      entere de cuál fuente respondió.
 *
 * Los items devueltos tienen SIEMPRE la forma que ArtistPage espera
 * ({ mbid, title, type, secondaryTypes, firstReleaseDate, coverArtUrl })
 * independiente de la fuente: los ids de Deezer fluyen igual de bien por
 * /album/:id porque AlbumPage ya tiene fallback de búsqueda en YT Music
 * para ids que no matchean nada.
 */
export async function fetchArtistDiscography(name: string | null | undefined): Promise<DiscographyResult> {
  if (!name?.trim()) return { source: null, releases: [] }

  const mbArtist = await lookupMusicBrainzArtist(name).catch(() => null)
  if (mbArtist?.mbid) {
    const releases = await getMusicBrainzDiscography(mbArtist.mbid, 40).catch(() => [])
    if (releases.length > 0) return { source: 'musicbrainz', releases }
  }

  const dz = await lookupDeezerArtist(name).catch(() => null)
  if (dz?.id) {
    const albums = await getDeezerArtistAlbums(dz.id, 40).catch(() => [])
    if (albums.length > 0) {
      return {
        source: 'deezer',
        releases: albums.map((a) => ({
          mbid: a.id,
          title: a.title,
          type: DEEZER_TYPE_TO_MB[a.type] || 'Album',
          secondaryTypes: [],
          firstReleaseDate: a.releaseDate,
          coverArtUrl: a.coverUrl,
        })),
      }
    }
  }

  return { source: null, releases: [] }
}

/**
 * Fetches the best available artist photo by checking YT Music, then Deezer, then AudioDB, then Wikipedia.
 * YT Music is prioritized to ensure consistency with the search dropdown.
 *
 * Resultado cacheado (ver PHOTO_CACHE_KEY más abajo) por nombre de artista:
 * antes cada pantalla resolvía su propia foto por su cuenta — ArtistPage
 * llamaba a esto, pero ArtistsPage (la grilla) usaba en cambio la portada
 * del álbum de una canción cualquiera del artista (song.albumArtUrl) como
 * placeholder y JAMÁS lo reemplazaba por la foto real. Resultado: la
 * grilla mostraba una carátula random y la página del artista mostraba
 * otra foto distinta para el mismo artista. Ahora que lookupArtistPhoto
 * cachea, ambas pantallas pueden llamar a la misma función y terminan
 * mostrando exactamente la misma imagen (y la piden a la red una sola vez).
 */
export async function lookupArtistPhoto(name: string | null | undefined): Promise<string | null> {
  if (!name) return null

  const cached = readArtistPhoto(name)
  if (cached) return cached

  const resolved = await resolveArtistPhoto(name)
  if (resolved) writeArtistPhoto(name, resolved)
  return resolved
}

async function resolveArtistPhoto(name: string): Promise<string | null> {
  try {
    // searchArtists es JS con shape inferido poco confiable — cast de borde.
    const yt = (await searchArtists(name, 1)) as { name?: string; thumbUrl?: string }[] | null
    const first = yt?.[0]
    if (first?.thumbUrl) {
      // Exact match check to prevent wrong artist photo
      if (first.name?.toLowerCase() === name.toLowerCase()) {
        // Upscale YT Music thumbnail for high-quality hero backgrounds
        return first.thumbUrl.replace(/=w\d+-h\d+.*$/, '=w1000-h1000-l90-rj')
      }
    }
  } catch {
    // Silently fallback
  }

  const deezer = await lookupDeezerArtist(name).catch(() => null)
  if (deezer?.picture) return deezer.picture

  const audiodb = await lookupArtistInfo(name).catch(() => null)
  if (audiodb?.thumb) return audiodb.thumb

  const wiki = await lookupArtistBio(name).catch(() => null)
  return wiki?.thumb || null
}

// ---------------------------------------------------------------------------
// Caché del tema adaptativo (color dominante extraído de la foto) por
// artista. Antes vivía como UNA KEY DE LOCALSTORAGE POR ARTISTA
// ('xfy_artist_theme_v1:<nombre>') que nunca se limpiaba — a diferencia del
// resto de los cachés de la app (asset cache con LRU y cupo, musicbrainz.js
// con TTL), esa crecía para siempre con cada artista nuevo visitado. Ahora es
// un único blob JSON, mismo patrón que musicbrainz.js, con un tope de
// entradas y desalojo LRU al superarlo.
// ---------------------------------------------------------------------------

const THEME_CACHE_KEY = 'xfy_artist_theme_cache_v1'
const THEME_CACHE_MAX_ENTRIES = 80

export interface ArtistTheme {
  accent?: string
  accentStrong?: string
  accentDim?: string
}

interface ThemeCacheEntry {
  theme: ArtistTheme
  lastAccessed: number
}

type ThemeCache = Record<string, ThemeCacheEntry>

// Limpieza única de las keys del formato viejo (una por artista) la primera
// vez que corre este módulo tras la actualización — de acá en más no se
// vuelven a crear, así que esto no tiene que repetirse en cada carga.
if (typeof localStorage !== 'undefined') {
  try {
    const OLD_PREFIX = 'xfy_artist_theme_v1:'
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && k.startsWith(OLD_PREFIX)) localStorage.removeItem(k)
    }
  } catch {
    // no crítico
  }
}

function readThemeCache(): ThemeCache {
  try {
    const raw = localStorage.getItem(THEME_CACHE_KEY)
    return raw ? (JSON.parse(raw) as ThemeCache) : {}
  } catch {
    return {}
  }
}

function writeThemeCache(cache: ThemeCache): void {
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // no crítico — el tema simplemente se recalcula la próxima vez
  }
}

/** Lee el tema cacheado de un artista (o null si no hay). */
export function readArtistTheme(name: string | null | undefined): ArtistTheme | null {
  if (!name) return null
  const cache = readThemeCache()
  return cache[name.toLowerCase()]?.theme || null
}

/** Guarda el tema de un artista, desalojando las entradas menos usadas
 * recientemente (LRU) si se supera THEME_CACHE_MAX_ENTRIES. */
export function writeArtistTheme(name: string | null | undefined, theme: ArtistTheme | null): void {
  if (!name || !theme) return
  const cache = readThemeCache()
  cache[name.toLowerCase()] = { theme, lastAccessed: Date.now() }

  const keys = Object.keys(cache)
  if (keys.length > THEME_CACHE_MAX_ENTRIES) {
    keys
      .sort((a, b) => (cache[a]?.lastAccessed || 0) - (cache[b]?.lastAccessed || 0))
      .slice(0, keys.length - THEME_CACHE_MAX_ENTRIES)
      .forEach((k) => delete cache[k])
  }

  writeThemeCache(cache)
}

// ---------------------------------------------------------------------------
// Caché de la FOTO resuelta del artista (no del tema de color) — mismo
// patrón LRU que la de arriba. Es lo que hace que la grilla de Artistas y
// la página del artista siempre muestren la misma imagen para el mismo
// nombre, y que solo se pida una vez por artista por sesión.
// ---------------------------------------------------------------------------

const PHOTO_CACHE_KEY = 'xfy_artist_photo_cache_v1'
const PHOTO_CACHE_MAX_ENTRIES = 150

interface PhotoCacheEntry {
  url: string
  lastAccessed: number
}

type PhotoCache = Record<string, PhotoCacheEntry>

function readPhotoCache(): PhotoCache {
  try {
    const raw = localStorage.getItem(PHOTO_CACHE_KEY)
    return raw ? (JSON.parse(raw) as PhotoCache) : {}
  } catch {
    return {}
  }
}

function writePhotoCache(cache: PhotoCache): void {
  try {
    localStorage.setItem(PHOTO_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // no crítico — la foto simplemente se vuelve a resolver la próxima vez
  }
}

/** Lee la foto cacheada de un artista (o null si no hay). */
export function readArtistPhoto(name: string | null | undefined): string | null {
  if (!name) return null
  const cache = readPhotoCache()
  return cache[name.toLowerCase()]?.url || null
}

/** Guarda la foto resuelta de un artista, desalojando LRU si se supera el tope. */
export function writeArtistPhoto(name: string | null | undefined, url: string | null | undefined): void {
  if (!name || !url) return
  const cache = readPhotoCache()
  cache[name.toLowerCase()] = { url, lastAccessed: Date.now() }

  const keys = Object.keys(cache)
  if (keys.length > PHOTO_CACHE_MAX_ENTRIES) {
    keys
      .sort((a, b) => (cache[a]?.lastAccessed || 0) - (cache[b]?.lastAccessed || 0))
      .slice(0, keys.length - PHOTO_CACHE_MAX_ENTRIES)
      .forEach((k) => delete cache[k])
  }

  writePhotoCache(cache)
}