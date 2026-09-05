// ============================================================
// Aleatorio inteligente ("smart shuffle") — reemplaza el Math.random()
// puro (que puede repetir la misma canción varias veces antes de tocar
// otras) por un algoritmo de "bolsa" tipo Spotify:
//
//   1. Se arma una permutación de TODOS los índices de la cola (Fisher–
//      Yates), así que cada canción suena exactamente una vez antes de
//      que alguna se repita.
//   2. La canción que acaba de sonar nunca queda primera en la bolsa
//      siguiente (evita el "salté de shuffle y volvió a sonar lo mismo").
//   3. Un pase local intenta separar canciones consecutivas del mismo
//      artista, para que no salgan dos temas seguidos del mismo artista
//      si hay alternativas disponibles en la bolsa.
//
// Se usa tanto para "shuffle" general de una cola como para favoritos
// (que es una cola como cualquier otra desde la perspectiva del player).
//
// ---------------------------------------------------------------------
// Smart Shuffle (distinto del shuffle de arriba)
// ---------------------------------------------------------------------
// El Smart Shuffle real de Spotify NO es el algoritmo anti-repetición de
// arriba (eso es su "Shuffle" clásico, documentado en su blog de 2014).
// Smart Shuffle intercala canciones NUEVAS que no están en la playlist,
// elegidas según el "vibe" del contenido: ~1 sugerida cada 3 originales,
// solo en playlists de 15+ temas, marcadas con ✨ y sin modificar la
// playlist a menos que el usuario las guarde.
//
// Acá se replica ese comportamiento usando el radio de YT Music
// (getUpNexts, vía getRelatedSongs) como motor de recomendación — Spotify
// cerró sus endpoints públicos de Recommendations/Related Artists para
// apps nuevas en nov. 2024, así que no hay forma de pedirle "parecidas" a
// su API real. buildSmartShuffleQueue() arma la cola EXTENDIDA (original +
// recomendadas, tageadas isRecommended) que después se le pasa a
// buildShuffleBag() como si fuera la cola normal — así las recomendadas
// quedan mezcladas por todo el recorrido, no solo pegadas al final.
// ============================================================

import { primaryArtistName, dedupeSongs, isSameSong, type SongLike } from '@shared/lib/songIdentity'
import { getRelatedSongs } from '@services/api/ytmusic'
import { getSongAffinityScores } from '@shared/lib/metrics'

/** Umbral mínimo de la cola para activar Smart Shuffle — el mismo que usa
 *  Spotify (playlists de menos de 15 temas no dan suficiente señal de
 *  "vibe" como para recomendar algo con sentido). */
export const SMART_SHUFFLE_MIN_QUEUE = 15
/** 1 recomendación cada N canciones originales — ratio real de Spotify. */
const RECOMMENDATION_RATIO = 3
/** Tope duro de recomendaciones por armado, para no pegarle demasiadas
 *  requests a /api/ytmusic de una sola vez en colas gigantes. */
const MAX_RECOMMENDATIONS = 12
/** De cuántas canciones "semilla" de la cola se pide radio — no hace falta
 *  pedirle a cada una, con una muestra repartida alcanza para capturar el
 *  vibe general sin disparar N requests para una cola de N canciones. */
const MAX_SEEDS = 5

/** Arma la cola extendida para Smart Shuffle: la cola original + hasta
 *  `queue.length / RECOMMENDATION_RATIO` canciones nuevas (tageadas
 *  `isRecommended: true`) sacadas del radio de YT Music de un puñado de
 *  semillas repartidas por la cola. Si la cola no llega al mínimo, o no
 *  hay ninguna canción con videoId reproducible como semilla, devuelve la
 *  cola tal cual (Smart Shuffle simplemente no aporta nada acá, como en
 *  Spotify cuando la playlist es muy chica). */
export async function buildSmartShuffleQueue<T extends SongLike & { videoId?: string | null; isRecommended?: boolean }>(
  queue: T[],
): Promise<T[]> {
  if (queue.length < SMART_SHUFFLE_MIN_QUEUE) return queue

  const seedPool = queue.filter((s) => s.videoId)
  if (seedPool.length === 0) return queue

  // Sort potential seeds by affinity score so recommendations match user taste
  const scores = getSongAffinityScores()
  const scoredSeeds = seedPool.map(s => ({
    seed: s,
    score: scores.get(String(s.id)) || 0
  })).sort((a, b) => b.score - a.score)

  // Pick top seeds based on affinity, distributed if possible
  const seeds: T[] = scoredSeeds.slice(0, MAX_SEEDS).map(s => s.seed)

  const wanted = Math.min(MAX_RECOMMENDATIONS, Math.floor(queue.length / RECOMMENDATION_RATIO))
  if (wanted <= 0) return queue

  const perSeedLimit = Math.max(2, Math.ceil((wanted * 2) / seeds.length))
  const results = await Promise.all(
    seeds.map((seed) =>
      getRelatedSongs(seed.videoId, perSeedLimit)
        .then((songs) => songs.filter((s) => !queue.some((q) => isSameSong(q, s))))
        .catch(() => []),
    ),
  )

  const recommended = dedupeSongs(results.flat())
    .slice(0, wanted)
    .map((s) => ({ ...s, isRecommended: true }) as unknown as T)

  if (recommended.length === 0) return queue
  return [...queue, ...recommended]
}

export function buildShuffleBag<T extends SongLike>(songs: T[], excludeIndex: number | null | undefined): number[] {
  const indices = songs.map((_, i) => i).filter((i) => i !== excludeIndex)
  if (indices.length <= 1) return indices
  
  const scores = getSongAffinityScores()
  const hasScores = indices.some(idx => (scores.get(String(songs[idx]?.id)) || 0) > 0)

  if (hasScores) {
    // Weighted Fisher-Yates
    // We want songs with higher affinity to have a higher chance of being picked earlier.
    for (let i = 0; i < indices.length - 1; i++) {
      // Calculate total weight for remaining items
      let totalWeight = 0
      const remainingWeights = []
      
      for (let j = i; j < indices.length; j++) {
        const songId = String(songs[indices[j]!]?.id)
        // Ensure baseline weight of 1 for songs with no score
        const weight = Math.max(1, scores.get(songId) || 1)
        totalWeight += weight
        remainingWeights.push({ idx: j, weight, accum: totalWeight })
      }
      
      // Random pick weighted by affinity
      let rand = Math.random() * totalWeight
      let pickedJ = i
      for (const rw of remainingWeights) {
        if (rand <= rw.accum) {
          pickedJ = rw.idx
          break
        }
      }
      
      // Swap selected element into current position i
      ;[indices[i], indices[pickedJ]] = [indices[pickedJ]!, indices[i]!]
    }
  } else {
    // Standard Fisher-Yates
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[indices[i], indices[j]] = [indices[j]!, indices[i]!]
    }
  }

  // Pase de separación de artistas consecutivos (best-effort, no exhaustivo:
  // si no hay con quién swapear se deja como está en vez de trabarse).
  const excludedArtist = excludeIndex != null ? primaryArtistName(songs[excludeIndex]) : ''
  let prevArtist = excludedArtist
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]!
    const currArtist = primaryArtistName(songs[idx])
    if (prevArtist && currArtist && prevArtist === currArtist) {
      const swapAt = indices.slice(i + 1).findIndex((swapIdx) => primaryArtistName(songs[swapIdx]) !== currArtist)
      if (swapAt !== -1) {
        const realIdx = i + 1 + swapAt
        ;[indices[i], indices[realIdx]] = [indices[realIdx]!, indices[i]!]
      }
    }
    prevArtist = primaryArtistName(songs[indices[i]!])
  }

  return indices
}

/** Saca el próximo índice de la bolsa, regenerándola si está vacía o si
 *  ya no es válida para el tamaño actual de la cola (canciones agregadas/
 *  quitadas). Devuelve el índice a reproducir y la bolsa restante. */
export function takeNextFromShuffleBag<T extends SongLike>(
  songs: T[],
  currentIndex: number,
  bag: number[],
): { nextIndex: number; bag: number[] } {
  let usableBag = bag.filter((i) => i >= 0 && i < songs.length && i !== currentIndex)

  if (usableBag.length === 0) {
    usableBag = buildShuffleBag(songs, currentIndex)
  }

  if (usableBag.length === 0) {
    // Cola de un solo tema: no hay a dónde saltar.
    return { nextIndex: currentIndex, bag: [] }
  }

  // usableBag.length > 0 acá, así que el primer elemento siempre existe.
  const [nextIndex, ...rest] = usableBag
  return { nextIndex: nextIndex!, bag: rest }
}
