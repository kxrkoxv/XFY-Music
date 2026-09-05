// ============================================================
// Multi-signal Recommendations Engine
// Integrates explicit favorites, taste profile, dominant genre, and time-of-day energy matching.
// Source: YT Music (Audius se sacó — el catálogo nunca resultó reproducible en la práctica).
// ============================================================

import { searchSongs } from '@services/api/ytmusic'
import {
  getTasteProfileV2,
  getArtistAffinityScores,
  getGenreAffinityScores,
  getSessionContext,
  getMoodContext,
  getTopNicheGenres,
  buildBlendSeeds,
  type TasteCode,
} from '@shared/lib/metrics'
import { dedupeSongs, isSameSong, type SongLike } from '@shared/lib/songIdentity'

const MAX_SEED_ARTISTS = 6
const SONGS_PER_ARTIST = 8
const MAX_RESULTS = 24

type Energy = 'high' | 'medium' | 'low'

// Energy heuristic based on track title and artist keywords.
function guessSongEnergy(song: SongLike): Energy {
  const text = `${song.title || ''} ${song.artist || ''}`.toLowerCase()
  if (/\b(remix|dance|energy|beat|hype|fire|rage|drill|trap|banger)\b/.test(text)) return 'high'
  if (/\b(lofi|lo-fi|chill|sleep|relax|ambient|calm|soft|slow|night)\b/.test(text)) return 'low'
  return 'medium'
}

function buildSeeds(favoriteSongs: SongLike[]): string[] {
  const favoriteNames = favoriteSongs.map((s) => String(s?.artist || '').trim()).filter(Boolean)
  const tasteNames = getTasteProfileV2(MAX_SEED_ARTISTS + 2)
  const session = getSessionContext()
  const sessionNames = session.map(e => String(e.artist || '').trim()).filter(Boolean).reverse().slice(0, 2)
  
  const seen = new Set<string>()
  const ordered: string[] = []
  
  // Prioridad 1: Contexto de sesión actual (lo que está escuchando ahora mismo)
  for (const name of sessionNames) {
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    ordered.push(name)
  }
  
  // Prioridad 2: Favoritos + Taste Profile a largo plazo
  for (const name of [...favoriteNames, ...tasteNames]) {
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    ordered.push(name)
  }
  return ordered.slice(0, MAX_SEED_ARTISTS)
}

// Interleaves results from multiple lists to ensure variety.
function interleave<T>(lists: T[][]): T[] {
  const result: T[] = []
  const max = Math.max(0, ...lists.map((l) => l.length))
  for (let i = 0; i < max; i++) {
    for (const list of lists) {
      const item = list[i]
      if (item) result.push(item)
    }
  }
  return result
}

/** Búsqueda JS->TS: searchSongs vive en un módulo sin tipos (Fase 3 lo tipa). */
function searchSongsTyped(artist: string, limit: number): Promise<SongLike[]> {
  return (searchSongs(artist, limit) as Promise<SongLike[]>).catch(() => [])
}

export async function getRecommendations(
  favoriteSongs: SongLike[],
  recentSongs: SongLike[],
): Promise<SongLike[]> {
  const seeds = buildSeeds(favoriteSongs)
  if (seeds.length === 0) return []

  const known = [...favoriteSongs, ...recentSongs]
  
  const mood = getMoodContext()
  const targetEnergy = mood.energy

  const genreScores = getGenreAffinityScores()
  const topGenres = [...genreScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0])

  // Búsqueda en YT Music para cada artista semilla. Fallas se ignoran en silencio.
  const perArtist = await Promise.all(
    seeds.map(async (artist) => {
      // 10% chance to search by genre + artist if high affinity genre exists to diversify
      const useGenre = topGenres.length > 0 && Math.random() > 0.9
      const query = useGenre ? `${topGenres[0]} ${artist}` : artist
      const songs = await searchSongsTyped(query, SONGS_PER_ARTIST)
      return songs.filter((s) => !known.some((k) => isSameSong(k, s)))
    }),
  )

  const merged = interleave(perArtist)
  const deduped = dedupeSongs(merged)

  // Soft reordering based on target energy for the current time of day.
  const scored = deduped.map((s, idx) => {
    const energy = guessSongEnergy(s)
    const energyMatch = energy === targetEnergy ? -3 : energy === 'medium' ? -1 : 0
    return { s, score: idx + energyMatch }
  })
  scored.sort((a, b) => a.score - b.score)

  return scored.slice(0, MAX_RESULTS).map((x) => x.s)
}

export function getPersonalizedSeeds() {
  const artistScores = [...getArtistAffinityScores().values()].sort((a, b) => b.score - a.score)
  const genreScores = [...getGenreAffinityScores().entries()].sort((a, b) => b[1] - a[1])
  
  return {
    artists: artistScores.slice(0, 10).map(a => ({ name: a.name, score: a.score })),
    genres: genreScores.slice(0, 5).map(g => ({ name: g[0], score: g[1] })),
    session: getSessionContext(),
    mood: getMoodContext()
  }
}

// "Because you liked X" section: fetch relevant tracks for a specific artist,
// excluyendo canciones ya conocidas. `knownSongs` son objetos canción reales
// (no ids sueltos): así se puede excluir por identidad canónica (título+artista)
// y no solo por id exacto — si ya tenés "Andrea" favoriteada bajo un videoId, no
// queremos volver a sugerirla acá solo porque esta búsqueda trajo OTRO videoId
// de la misma canción.
export async function getTopArtistRecommendations(
  artistName: string | null | undefined,
  knownSongs: SongLike[] | Iterable<SongLike> = [],
  limit = 16,
): Promise<SongLike[]> {
  if (!artistName) return []
  const songs = await searchSongsTyped(artistName, limit)
  const known = Array.isArray(knownSongs) ? knownSongs : [...knownSongs]
  const filtered = songs.filter((s) => !known.some((k) => isSameSong(k, s)))
  return dedupeSongs(filtered).slice(0, limit)
}

// "Hot in [genre]" section: antes traía trending de Audius filtrado por
// género; ahora, sin Audius, se resuelve con una búsqueda directa en YT
// Music por género (p. ej. "Lo-Fi music").
export async function getGenreTrending(genre: string | null | undefined, limit = 16): Promise<SongLike[]> {
  if (!genre) return []
  return dedupeSongs(await searchSongsTyped(`${genre} music`, limit)).slice(0, limit)
}

// ------------------------------------------------------------
// Daylist — mini-mix que cambia según hora del día + día de la semana +
// género de nicho más escuchado en esa franja, estilo Spotify (que llega a
// refrescarlo varias veces por día). No guarda nada nuevo: combina
// getMoodContext() + getTopNicheGenres(), que ya existían para otras
// secciones, con una búsqueda directa a YT Music.
// ------------------------------------------------------------
const DAYPART_LABEL: Record<'high' | 'medium' | 'low', string[]> = {
  high: ['mañana con energía', 'arranque de día', 'para despertar'],
  medium: ['tarde productiva', 'mitad de día', 'foco de tarde'],
  low: ['noche tranquila', 'para relajar', 'de noche'],
}
const WEEKDAY_LABEL = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']

export interface DaylistMeta {
  title: string
  genre: string | null
  energy: 'high' | 'medium' | 'low'
}

export function getDaylistMeta(): DaylistMeta {
  const mood = getMoodContext()
  const genres = getTopNicheGenres(3)
  const genre = genres[Math.floor(Math.random() * genres.length)] || genres[0] || null
  const labels = DAYPART_LABEL[mood.energy]
  const label = labels[mood.hour % labels.length] || labels[0]
  const dayName = WEEKDAY_LABEL[mood.weekday] || ''
  const title = genre ? `${dayName} · ${label} · ${genre}` : `${dayName} · ${label}`
  return { title, genre, energy: mood.energy }
}

export async function getDaylistSongs(limit = 24): Promise<SongLike[]> {
  const meta = getDaylistMeta()
  const seedArtists = getTasteProfileV2(3)
  const queries = meta.genre
    ? [`${meta.genre} music`, ...seedArtists.map((a) => `${meta.genre} ${a}`)]
    : seedArtists.length
      ? seedArtists
      : ['popular music']

  const results = await Promise.all(queries.map((q) => searchSongsTyped(q, 10)))
  const merged = interleave(results)
  return dedupeSongs(merged).slice(0, limit)
}

// ------------------------------------------------------------
// Blend — arma una cola de canciones a partir de los seeds ya mezclados
// por buildBlendSeeds() (metrics.ts), priorizando artistas/géneros que
// aparecen en AMBOS perfiles.
// ------------------------------------------------------------
export async function getBlendSongs(remote: TasteCode, limit = 30): Promise<SongLike[]> {
  const seeds = buildBlendSeeds(remote, 8)
  if (seeds.artists.length === 0) return []

  const results = await Promise.all(seeds.artists.map((artist) => searchSongsTyped(artist, 6)))
  const merged = interleave(results)
  return dedupeSongs(merged).slice(0, limit)
}
