// ============================================================
// Smart Autoplay Engine
// Extends the queue with related tracks when playback nears completion.
//
// Signals used, en orden de calidad:
// 1. Radio de YT Music (getUpNexts) sobre las últimas canciones sonadas —
//    es el mismo grafo de relacionados que usa music.youtube.com para su
//    propio autoplay, así que entiende "canción parecida" de verdad y no
//    solo "mismo artista". Es también la base del Smart Shuffle.
// 2. Búsqueda por artista (fallback) — se usa solo si el radio no devuelve
//    nada para ninguna semilla (canción sin buen match en YT Music, error
//    de red, etc.), y para completar el cupo si el radio se queda corto.
// 3. Extended Taste: perfil general de gustos del usuario vía métricas.
//
// Nota sobre Spotify: no se usa acá — sus endpoints de Recommendations /
// Related Artists están cerrados para apps nuevas desde nov. 2024, así que
// no hay forma de pedirle "canciones parecidas" a su API pública. Spotify
// en esta app se queda como fuente de IMPORT (una playlist pública ->
// temas crudos que después se emparejan con YT Music, ver services/api/
// spotify.ts) — el motor de recomendación es 100% YT Music.
// ============================================================

import { searchSongs, getRelatedSongs } from '@services/api/ytmusic'
import { getTasteProfile } from '@shared/lib/metrics'
import { dedupeSongs, isSameSong, type SongLike } from '@shared/lib/songIdentity'

const RECENT_CONTEXT_SONGS = 5 // cuántas canciones del final de la cola definen "lo que se venía escuchando"
const MAX_SEEDS = 3
const SONGS_PER_SEED = 6
const MAX_EXTENSION = 8

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

/** Radio de YT Music para las últimas `RECENT_CONTEXT_SONGS` canciones de
 *  la cola — la señal "fuerte" (canción → relacionadas reales), a
 *  diferencia de la búsqueda por texto que solo entiende "mismo artista". */
async function getRadioSeeds(queue: SongLike[], known: SongLike[]): Promise<SongLike[][]> {
  const recentVideoIds = [
    ...new Set(
      queue
        .slice(-RECENT_CONTEXT_SONGS)
        .map((s) => s.videoId)
        .filter((id): id is string => Boolean(id)),
    ),
  ].slice(0, MAX_SEEDS)

  if (recentVideoIds.length === 0) return []

  return Promise.all(
    recentVideoIds.map((videoId) =>
      getRelatedSongs(videoId, SONGS_PER_SEED)
        .then((songs) => songs.filter((s) => !known.some((k) => isSameSong(k, s))))
        .catch(() => []),
    ),
  )
}

export async function getAutoplayExtension(
  queue: SongLike[],
  excludeSongs: SongLike[] | Iterable<SongLike>,
): Promise<SongLike[]> {
  // `excludeSongs`: objetos canción reales (no ids sueltos) — así se excluye
  // por identidad canónica y no se repite una canción ya en cola aunque esta
  // búsqueda la haya traído bajo otro videoId.
  const known = Array.isArray(excludeSongs) ? excludeSongs : [...excludeSongs]

  const radioLists = await getRadioSeeds(queue, known)
  const radioResults = dedupeSongs(interleave(radioLists))
  if (radioResults.length >= MAX_EXTENSION) return radioResults.slice(0, MAX_EXTENSION)

  // El radio se quedó corto (o vacío) — completa con el fallback de
  // siempre: búsqueda por nombre de artista.
  const recentArtists = [
    ...new Set(
      queue
        .slice(-RECENT_CONTEXT_SONGS)
        .map((s) => s.artist)
        .filter((a): a is string => Boolean(a)),
    ),
  ]
  const tasteArtists = getTasteProfile(2)

  const seen = new Set<string>()
  const seeds: string[] = []
  for (const name of [...recentArtists, ...tasteArtists]) {
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    seeds.push(name)
    if (seeds.length >= MAX_SEEDS) break
  }
  if (seeds.length === 0) return radioResults

  const alreadyKnown = [...known, ...radioResults]
  const perSeed = await Promise.all(
    seeds.map((artist) =>
      // searchSongs vive en un módulo JS sin tipos — el cast acá es el
      // borde de confianza hasta que services/api migre (Fase 3).
      (searchSongs(artist, SONGS_PER_SEED) as Promise<SongLike[]>)
        .then((songs) => songs.filter((s) => !alreadyKnown.some((k) => isSameSong(k, s))))
        .catch(() => []),
    ),
  )

  const merged = interleave([radioResults, ...perSeed])
  return dedupeSongs(merged).slice(0, MAX_EXTENSION)
}
