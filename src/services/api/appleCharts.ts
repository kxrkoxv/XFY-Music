// ============================================================
// Apple Marketing Tools RSS — charts oficiales de Apple Music
// ------------------------------------------------------------
// rss.marketingtools.apple.com es el feed público que Apple ofrece
// para fines de marketing/promoción (ver rss.marketingtools.apple.com
// y performance-partners.apple.com/tools). Es JSON, sin API key, sin
// login, actualizado a diario — pero SOLO trae metadata (rank, título,
// artista, portada, género, link a Apple Music). No entrega audio: no
// es un endpoint de streaming, así que no reemplaza a YT Music para
// reproducir.
//
// Lo que hace este módulo: pide el Top Songs de un país, y por cada
// entrada busca el mismo título/artista en YT Music para quedarse con
// la versión que SÍ se puede reproducir. Las entradas del chart sin
// match razonable se descartan.
//
// (Antes esto resolvía contra Audius — se sacó: el catálogo de Audius
// nunca resultaba reproducible en la práctica.)
// ============================================================

import { searchSongs } from './ytmusic'
import { fetchJsonRobust } from '@shared/lib/httpClient'
import type { Song } from '@/types/models'

const BASE_URL = '/api/apple-charts/api/v2'

const CACHE_KEY = 'xfy_apple_charts_cache_v2'
const CACHE_TTL_MS = 1000 * 60 * 60 * 6 // el feed de Apple se actualiza 1x/día

interface ChartEntry {
  id?: string
  name: string
  artistName: string
  artworkUrl100?: string
  url?: string
  genres?: { name?: string }[]
  chartMeta?: { rank: number }
}

interface ChartTrack extends Song {
  appleRank?: number
  appleArtwork?: string | null
  appleMusicUrl?: string | null
  appleGenre?: string | null
}

type ChartCache = Record<string, { tracks: ChartTrack[]; fetchedAt: number }>

// Mercados más relevantes; la lista completa de países la expone Apple
// en rss.marketingtools.apple.com si hace falta ampliar esto.
export const APPLE_CHART_COUNTRIES = [
  { id: 'us', label: 'EE. UU.' },
  { id: 'gb', label: 'Reino Unido' },
  { id: 'mx', label: 'México' },
  { id: 'es', label: 'España' },
  { id: 'ar', label: 'Argentina' },
  { id: 'br', label: 'Brasil' },
  { id: 'co', label: 'Colombia' },
  { id: 'jp', label: 'Japón' },
  { id: 'kr', label: 'Corea' },
]

// Preferencia de país para el chart "Top Global" del Home — se guarda acá
// (junto al resto del estado propio de este módulo) para que HomePage no
// tenga que manejar su propio localStorage ad-hoc.
const COUNTRY_PREF_KEY = 'xfy_apple_chart_country_v1'

export function getPreferredChartCountry(): string {
  try {
    const saved = localStorage.getItem(COUNTRY_PREF_KEY)
    if (saved && APPLE_CHART_COUNTRIES.some((c) => c.id === saved)) return saved
  } catch {
    // no crítico
  }
  return 'us'
}

export function setPreferredChartCountry(country: string): void {
  try {
    localStorage.setItem(COUNTRY_PREF_KEY, country)
  } catch {
    // no crítico
  }
}

function readCache(): ChartCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as ChartCache) : {}
  } catch {
    return {}
  }
}

function writeCache(cache: ChartCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // no crítico
  }
}

function upscaleArtwork(url: string | null | undefined): string | null {
  if (!url) return null
  // artworkUrl100 viene fijo en 100x100 — Apple sirve el mismo archivo en
  // cualquier tamaño reescribiendo "NNNxNNNbb" en el path (igual que el
  // truco de Wikipedia), hasta 1200x1200 de forma confiable. 600 se veía
  // borroso estirado a fondo de hero; 1200 es el tope real que Apple
  // entrega sin fallback a un tamaño menor.
  return url.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/1200x1200bb.$1')
}

// Trae el Top Songs crudo de Apple (solo metadata) para un país.
async function fetchRawChart(country: string, limit: number): Promise<ChartEntry[]> {
  const json = await fetchJsonRobust<{ feed?: { results?: ChartEntry[] } }>(
    `${BASE_URL}/${country}/music/most-played/${limit}/songs.json`,
    { timeoutMs: 10000, retries: 1 },
  )
  return json?.feed?.results ?? []
}

// Resuelve una entrada del chart contra YT Music. Devuelve null si no
// hay match razonable.
async function resolveAgainstYtMusic(entry: ChartEntry): Promise<ChartTrack | null> {
  try {
    const matches = (await searchSongs(`${entry.name} ${entry.artistName}`, 3)) as Song[]
    if (!matches?.length) return null

    const wantedTitle = entry.name.toLowerCase()
    const best =
      matches.find(
        (m) => m.title?.toLowerCase().includes(wantedTitle) || wantedTitle.includes(m.title?.toLowerCase() ?? '')
      ) ?? matches[0]

    return {
      ...(best as Song),
      appleRank: Number(entry.chartMeta?.rank) || undefined,
      appleArtwork: upscaleArtwork(entry.artworkUrl100),
      appleMusicUrl: entry.url,
      appleGenre: entry.genres?.[0]?.name,
      // OJO: NO pisar `source` acá. `best` ya trae `source: 'youtube'` desde
      // YT Music (es lo que realmente se reproduce — Apple Charts solo aportó
      // el rank/artwork/metadata). Antes esto lo sobreescribía a
      // 'apple-charts', y como isYouTubeSong() en el player exige
      // source === 'youtube', CADA pista de Top Global caía a la rama de
      // audio "externo", no encontraba audioSrc/streamUrl (esas pistas nunca
      // los tienen) y se auto-saltaba en silencio — Top Global estaba
      // completamente mudo, cada tema saltaba solo apenas le tocaba el turno.
    }
  } catch {
    return null
  }
}

// limit acota cuántas entradas del chart se intentan resolver contra
// YT Music (cada una implica una búsqueda de red aparte, así que 25 es
// un balance razonable entre cobertura y velocidad de carga).
export async function getTrendingTracks(country = 'us', limit = 25): Promise<ChartTrack[]> {
  const key = `${country}:${limit}`
  const cache = readCache()
  const cached = cache[key]
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.tracks
  }

  const raw = await fetchRawChart(country, limit)
  const withRank = raw.map((entry, i) => ({ ...entry, chartMeta: { rank: i + 1 } }))

  // Resolución en paralelo con concurrencia acotada para no disparar
  // 25 requests simultáneas de una.
  const CONCURRENCY = 5
  const resolved: ChartTrack[] = []
  for (let i = 0; i < withRank.length; i += CONCURRENCY) {
    const batch = withRank.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(resolveAgainstYtMusic))
    resolved.push(...results.filter((t): t is ChartTrack => t !== null))
  }

  const tracks = resolved.filter(Boolean).sort((a, b) => (a.appleRank ?? 999) - (b.appleRank ?? 999))

  cache[key] = { tracks, fetchedAt: Date.now() }
  writeCache(cache)
  return tracks
}

// El feed de Apple no tiene endpoint de búsqueda libre (solo charts
// fijos), así que para mantener la misma interfaz que los otros
// providers de DiscoverPage, una búsqueda acá cae directo a YT Music.
export function searchTracks(query: string, limit = 20) {
  return searchSongs(query, limit)
}
