/**
 * Identidad canónica de una canción, independiente del videoId puntual que
 * la trajo.
 *
 * YT Music suele indexar la MISMA canción bajo varios videoId distintos
 * (audio oficial, video oficial, versión de álbum, lyric video, subida de
 * un canal distinto...), cada uno con su propia carátula y a veces
 * metadata levemente distinta. Como el resto de la app usa videoId como id
 * primario (hace falta para reproducir), dos favoritos / reproducciones
 * recientes / agregados a playlist de la MISMA canción real terminaban
 * viviendo como dos objetos separados con id distinto -> se veían como
 * "duplicados" con portadas que no coinciden (p. ej. "Andrea" apareciendo
 * dos veces en la biblioteca, una con la carátula correcta de "Un Verano
 * Sin Ti" y otra con un placeholder, porque cada favorito se guardó desde
 * un videoId distinto de la misma canción).
 *
 * getSongKey() da una clave estable por título + artista principal para
 * poder deduplicar y comparar identidad sin importar qué videoId
 * específico trajo cada copia. Todo lo que siga necesitando reproducir
 * sigue usando song.id / song.videoId como antes — esto es solo para
 * decidir "¿esto es la misma canción?".
 */

/** La forma mínima de canción que necesitan las utilidades de identidad. */
export interface SongLike {
  id?: string | number | null
  videoId?: string | null
  title?: string
  artist?: string
  artists?: { name?: string }[] | null
  album?: string | null
  albumArtUrl?: string | null
  duration?: number | null
  artistId?: string | null
}

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ') // (Official Video), [Explicit], (Remastered 2011)...
    .replace(/\b(feat|ft)\.?\s.*$/i, '') // corta "feat. X" / "ft. X" al final
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Reexportado para que otros módulos (p. ej. dedupe de álbumes en ArtistPage)
 *  puedan usar la misma normalización de títulos sin duplicar la lógica. */
export function normalizeTitle(title: string | null | undefined): string {
  return normalizeText(title)
}

/** Exportado para poder mandar el artista principal al server (dedupe de
 *  caché de audio por canción, ver ytblob.js / api/ytcache.js) sin
 *  duplicar esta lógica de extracción en cada call-site. */
export function primaryArtistName(song?: SongLike | null): string {
  if (Array.isArray(song?.artists) && song.artists.length) return song.artists[0]?.name || ''
  return String(song?.artist || '').split(',')[0] ?? ''
}

/** Clave canónica "titulo::artista-principal", normalizada. */
export function getSongKey(song?: SongLike | null): string {
  const title = normalizeText(song?.title)
  const artist = normalizeText(primaryArtistName(song))
  return `${title}::${artist}`
}

/** Puntúa qué tan completa está la metadata de una canción, para elegir
 *  cuál copia conservar cuando dos entradas resuelven a la misma clave
 *  canónica (nos quedamos con la de mayor puntaje, no con "la primera"). */
function completenessScore(song?: SongLike | null): number {
  let score = 0
  if (song?.albumArtUrl) score += 2
  if (song?.album) score += 1
  if (typeof song?.duration === 'number' && song.duration > 0) score += 1
  if (song?.artistId) score += 1
  return score
}

/** Devuelve la copia "más completa" entre dos objetos de la misma canción. */
export function pickBestSong<T extends SongLike>(a: T, b: T): T {
  return completenessScore(b) > completenessScore(a) ? b : a
}

/**
 * Deduplica un array de canciones por identidad canónica, preservando el
 * orden de primera aparición y quedándose con la copia de metadata más
 * completa entre las que colisionan.
 */
export function dedupeSongs<T extends SongLike>(songs: (T | null | undefined)[] | null | undefined): T[] {
  const byKey = new Map<string, T>()
  const order: string[] = []
  for (const song of songs || []) {
    if (!song || song.id == null) continue
    const key = getSongKey(song)
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, song)
      order.push(key)
    } else {
      byKey.set(key, pickBestSong(prev, song))
    }
  }
  return order.map((k) => byKey.get(k) as T)
}

/** ¿Estos dos objetos representan la misma canción (mismo id exacto, o
 *  misma identidad canónica título+artista)? Usado para evitar guardar
 *  duplicados al favoritear / agregar a recientes / agregar a playlists. */
export function isSameSong(
  a?: SongLike | null,
  b?: SongLike | null,
): boolean {
  if (!a || !b) return false
  if (String(a.id ?? '') === String(b.id ?? '') && a.id != null) return true
  return getSongKey(a) === getSongKey(b)
}

// ------------------------------------------------------------
// Fuzzy matching — inspirado en el uso de fuzzywuzzy de Spotube para
// machear metadata entre fuentes (Spotify ↔ Piped/YouTube/JioSaavn).
// getSongKey() ya cubre el caso exacto (mismo título+artista tras
// normalizar acentos/paréntesis/feat.); esto es una capa ADICIONAL para
// cuando el título difiere un poco entre fuentes (YT Music vs Audius vs
// import de playlist externa): typos, "Pt. 2" vs "Part 2", orden de
// palabras distinto, etc. No reemplaza a isSameSong/getSongKey en los
// call-sites existentes (favoritos, recientes, dedupeSongs) — es para
// matching cross-fuente donde no hay una clave exacta confiable, como
// al buscar el equivalente de una canción de Audius en YT Music o
// viceversa.
// ------------------------------------------------------------

/** Distancia de Levenshtein clásica (DP en una sola fila para no gastar
 *  O(n*m) de memoria — solo nos importa el número final). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const currRow = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      currRow[j] = Math.min(
        (prevRow[j] ?? 0) + 1, // borrado
        (currRow[j - 1] ?? 0) + 1, // inserción
        (prevRow[j - 1] ?? 0) + cost, // sustitución
      )
    }
    prevRow = currRow
  }
  return prevRow[b.length] ?? Math.max(a.length, b.length)
}

/** Similitud 0..1 entre dos strings normalizados, basada en Levenshtein
 *  (1 = idénticos, 0 = completamente distintos). */
function stringSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(a, b) / maxLen
}

/** Similitud por conjunto de palabras (Jaccard) — tolera orden distinto
 *  ("Verano Sin Ti Un" vs "Un Verano Sin Ti") mejor que Levenshtein solo. */
function tokenSetSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(' ').filter(Boolean))
  const setB = new Set(b.split(' ').filter(Boolean))
  if (setA.size === 0 && setB.size === 0) return 1
  let intersection = 0
  for (const tok of setA) if (setB.has(tok)) intersection++
  const union = setA.size + setB.size - intersection
  return union === 0 ? 1 : intersection / union
}

/** Puntaje de similitud 0..1 entre dos canciones, combinando título
 *  (Levenshtein + Jaccard de palabras) y artista principal. Pensado para
 *  matching cross-fuente, no para reemplazar la igualdad exacta. */
export function songSimilarity(a?: SongLike | null, b?: SongLike | null): number {
  if (!a || !b) return 0
  const titleA = normalizeText(a.title)
  const titleB = normalizeText(b.title)
  const artistA = normalizeText(primaryArtistName(a))
  const artistB = normalizeText(primaryArtistName(b))

  const titleScore = Math.max(stringSimilarity(titleA, titleB), tokenSetSimilarity(titleA, titleB))
  const artistScore = artistA && artistB ? Math.max(stringSimilarity(artistA, artistB), tokenSetSimilarity(artistA, artistB)) : 0.5

  // Título pesa más: dos versiones de la misma canción con artista escrito
  // distinto ("Bad Bunny" vs "Bad Bunny, Chencho Corleone") igual deberían
  // matchear si el título es casi idéntico.
  return titleScore * 0.7 + artistScore * 0.3
}

/** ¿Estas dos canciones son "probablemente la misma" cruzando fuentes
 *  distintas, aunque el título no sea un match exacto? Usado por el
 *  matching de plugins de fuente (ver services/plugins) para deduplicar
 *  resultados combinados de YT Music + Audius + Piped sin descartar
 *  falsos negativos por una coma o un "feat." escrito distinto. */
export function isFuzzySameSong(a?: SongLike | null, b?: SongLike | null, threshold = 0.82): boolean {
  if (isSameSong(a, b)) return true
  return songSimilarity(a, b) >= threshold
}
