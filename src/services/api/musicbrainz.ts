/** 
 * MusicBrainz & Cover Art Archive proxy client. 
 * Provides comprehensive discography and artist metadata. Implements transparent proxying to bypass CORS and rate limiting (~1 req/sec). 
 */
import { fetchJsonRobust } from '@shared/lib/httpClient'

const BASE_URL = '/api/musicbrainz'
const APP_ID = 'XFY-music-player/1.0'

// v3: las portadas ahora piden front-500 (antes front-1200) — invalida las
// URLs pesadas cacheadas sin esperar los 14 días de TTL.
const CACHE_KEY = 'xfy_musicbrainz_cache_v3'
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14 // 14 días: esto casi no cambia

let lastRequestAt = 0
const MIN_INTERVAL_MS = 1100 // ~1 req/seg, con margen

interface MBArtistRaw {
  id: string
  name: string
  country?: string
  type?: string
  'life-span'?: { begin?: string; end?: string }
  tags?: { name: string }[]
  disambiguation?: string
}

interface MBReleaseGroup {
  id: string
  title: string
  'primary-type'?: string
  'secondary-types'?: string[]
  'first-release-date'?: string
}

interface MBRelease {
  releases?: { id: string }[]
}

interface MBReleaseDetail {
  media?: { tracks?: { title?: string; length?: number; position?: number }[] }[]
}

type BrainzCache = Record<string, { value: unknown; fetchedAt: number }>

function readCache(): BrainzCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as BrainzCache) : {}
  } catch {
    return {}
  }
}

function writeCache(cache: BrainzCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // no crítico
  }
}

async function throttledFetch(url: string): Promise<unknown> {
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt))
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt = Date.now()
  // Sin reintentos acá (retries: 0): `cachedFetch` de abajo ya tiene su
  // propio fallback a la última respuesta cacheada si esto falla, y
  // reintentar chocaría con el throttle de ~1 req/seg que MusicBrainz
  // exige. El timeout sigue siendo necesario: sin él, un fetch() colgado
  // dejaba `discographyLoading` en true para siempre.
  return fetchJsonRobust(url, { timeoutMs: 10000, retries: 0 })
}

async function cachedFetch<T = unknown>(cacheKey: string, url: string): Promise<T | null> {
  const cache = readCache()
  const cached = cache[cacheKey]
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return (cached.value as T | null) ?? null

  try {
    const value = await throttledFetch(url)
    cache[cacheKey] = { value, fetchedAt: Date.now() }
    writeCache(cache)
    return value as T
  } catch (e) {
    console.warn('[XFY] MusicBrainz lookup falló')
    return (cached?.value as T | null) ?? null
  }
}

/** Look up an artist by name and return their MBID and basic information. */
export async function lookupArtist(name: string | null | undefined) {
  if (!name?.trim()) return null
  const key = `artist:${name.toLowerCase().trim()}`
  // Use ?resource= scheme — the function at /api/musicbrainz handles all sub-resources
  const params = new URLSearchParams({ resource: 'artist', query: name, fmt: 'json', limit: '1', app: APP_ID })
  const url = `${BASE_URL}?${params.toString()}`
  const json = await cachedFetch<{ artists?: MBArtistRaw[] }>(key, url)
  const artist = json?.artists?.[0]
  if (!artist) return null

  return {
    mbid: artist.id,
    name: artist.name,
    country: artist.country || null,
    type: artist.type || null, // "Person", "Group", etc.
    beginDate: artist['life-span']?.begin || null,
    endDate: artist['life-span']?.end || null,
    tags: (artist.tags || []).map((t) => t.name),
    disambiguation: artist.disambiguation || null,
  }
}

/** Fetch the official discography (release-groups) for a given artist MBID. */
export async function getDiscography(mbid: string | null | undefined, limit = 20) {
  if (!mbid) return []
  const key = `discography:${mbid}:${limit}`
  const params = new URLSearchParams({ resource: 'release-group', artist: mbid, fmt: 'json', limit: String(limit), app: APP_ID })
  const url = `${BASE_URL}?${params.toString()}`
  const json = await cachedFetch<{ 'release-groups'?: MBReleaseGroup[] }>(key, url)
  const groups = json?.['release-groups'] ?? []

  return groups
    .map((g) => ({
      mbid: g.id,
      title: g.title,
      type: g['primary-type'] || 'Album',
      secondaryTypes: g['secondary-types'] || [],
      firstReleaseDate: g['first-release-date'] || null,
      coverArtUrl: coverArtUrlFor(g.id),
    }))
    .sort((a, b) => (b.firstReleaseDate || '').localeCompare(a.firstReleaseDate || ''))
}

/**
 * Generate the Cover Art Archive URL for a given release group MBID, routed through
 * /api/imgproxy instead of hitting Cover Art Archive directly.
 *
 * Cover Art Archive 307-redirects to archive.org's CDN (dn7108xx.ca.archive.org),
 * which doesn't send Access-Control-Allow-Origin — so a direct <img src> or fetch()
 * from the browser gets blocked by CORS on that redirect target, on top of that CDN
 * returning occasional 500s. imgproxy.js already solves exactly this (server-side
 * fetch, no CORS restrictions, plus its own cache) and already allowlists archive.org
 * — the audiodb.js client uses it for the same reason. This used to bypass it via a
 * raw path-based rewrite (/api/coverart/... -> coverartarchive.org) that had none of
 * that protection.
 */
export function coverArtUrlFor(releaseGroupMbid: string | null | undefined): string | null {
  if (!releaseGroupMbid) return null
  // front-500: las portadas se muestran en grillas de ~44-96px y en
  // AlbumPage; 500px alcanza de sobra. La versión -1200 (elegida antes
  // pensando en un hero full-screen que nunca la usó) pesaba varias veces
  // más y era parte de por qué las portadas tardaban tanto en aparecer.
  // Cover Art Archive además 404ea para release-groups sin tapa — ese
  // caso lo maneja CachedImg con su fallback.
  const upstream = `https://coverartarchive.org/release-group/${releaseGroupMbid}/front-500`
  return `/api/imgproxy?url=${encodeURIComponent(upstream)}`
}

/**
 * Tracklist REAL de un release-group de MusicBrainz.
 *
 * Para lanzamientos que NO existen en YT Music (directos, compilaciones,
 * ediciones exclusivas), esta es la única fuente honesta de la lista de
 * pistas: primero resolvemos un lanzamiento concreto del grupo y después
 * sus pistas oficiales (recordings). Dos pedidos, throttled a ~1 req/seg
 * y cacheados 14 días en localStorage — se pagan una vez por álbum.
 */
export async function getReleaseGroupTracklist(mbid: string | null | undefined) {
  if (!mbid) return []
  try {
    // 1) Lanzamientos del grupo (cualquiera sirve: la tracklist del grupo
    //    es esencialmente la misma entre ediciones).
    const releases = await cachedFetch<MBRelease>(
      `rg-releases:${mbid}`,
      `${BASE_URL}?${new URLSearchParams({ resource: 'release', 'release-group': mbid, fmt: 'json', limit: '5', app: APP_ID })}`,
    )
    const releaseId = releases?.releases?.[0]?.id
    if (!releaseId) return []

    // 2) El lanzamiento elegido, con sus medios y pistas oficiales.
    const detail = await cachedFetch<MBReleaseDetail>(
      `rg-release:${releaseId}`,
      `${BASE_URL}?${new URLSearchParams({ resource: `release/${releaseId}`, fmt: 'json', inc: 'recordings+media', app: APP_ID })}`,
    )

    const tracks = []
    for (const medium of detail?.media || []) {
      for (const t of medium?.tracks || []) {
        if (!t?.title) continue
        // Contador GLOBAL entre discos: t.position reinicia en cada medio
        // y un directo multi-disco mostraba dos pistas "1", "2"…
        tracks.push({
          title: t.title,
          duration: t.length ? Math.round(t.length / 1000) : null,
          position: tracks.length + 1,
        })
      }
    }
    return tracks.sort((a, b) => a.position - b.position)
  } catch {
    return []
  }
}
