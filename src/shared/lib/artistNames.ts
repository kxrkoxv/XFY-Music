/**
 * Utilidades para trabajar con nombres de artistas "combinados", como
 * "Drake & Yebba" o "Bad Bunny, Feid" — resultado normal de canciones con
 * más de un artista, pero que hasta ahora se trataban como un único
 * nombre de artista literal en toda la app (bio, género, links, etc.),
 * lo cual rompía las búsquedas en Wikipedia/AudioDB y volvía el nombre
 * completo un solo bloque no clickeable.
 */

// Separadores comunes entre artistas colaboradores. Cuidado con " y ": solo
// se usa como separador cuando tiene espacios a los dos lados, para no
// romper nombres de artista que contengan esa letra (p. ej. "Ty Dolla $ign").
const SPLIT_REGEX = /\s*(?:,|&|\/| x | X | feat\.? | ft\.? | featuring | con | y | vs\.? )\s*/

/** Un artista clickeable: nombre + artistId (cuando la fuente lo distingue). */
export interface ArtistEntry {
  name: string
  artistId: string | null
}

/** La forma mínima de canción que necesita resolveArtistEntries. */
export interface SongLike {
  artists?: { name?: string; artistId?: string | null }[] | null
  artist?: string
  name?: string
  artistId?: string | null
}

/**
 * Divide un nombre de artista (posiblemente combinado) en sus componentes
 * individuales. "Drake & Yebba" -> ["Drake", "Yebba"]. Un nombre simple
 * como "Rosalía" devuelve ["Rosalía"].
 */
export function splitArtistNames(name: string | null | undefined): string[] {
  if (!name) return []
  return String(name)
    .split(SPLIT_REGEX)
    .map((n) => n.trim())
    .filter(Boolean)
}

/** El primer artista de un nombre combinado — el más representativo para buscar bio/género. */
export function getPrimaryArtistName(name: string | null | undefined): string {
  return splitArtistNames(name)[0] || String(name || '').trim()
}

/**
 * Construye la lista de artistas "clickeables" a partir de la forma más
 * confiable disponible: el array `artists` (con artistId real por cada
 * uno, cuando la fuente lo distingue) o, si no existe, el string
 * `artist`/`name` combinado, partido heurísticamente.
 */
export function resolveArtistEntries(song?: SongLike | null): ArtistEntry[] {
  if (Array.isArray(song?.artists) && song.artists.length > 0) {
    // Algunas fuentes agrupan colaboraciones bajo un solo "artista" cuyo
    // nombre ya viene con &/, adentro (p. ej. YT Music agrupa "Drake &
    // Yebba" como un solo canal) — si detectamos eso, igual lo separamos
    // para que cada nombre sea clickeable por separado.
    return song.artists.flatMap((a) => {
      const names = splitArtistNames(a?.name)
      if (names.length <= 1) {
        return [{ name: a?.name || names[0] || '', artistId: a?.artistId || null }]
      }
      // Un solo artistId agrupado no puede repartirse con certeza entre
      // varios nombres, así que solo el primero conserva el artistId.
      return names.map((n, i) => ({ name: n, artistId: i === 0 ? a?.artistId || null : null }))
    }).filter((a) => a.name)
  }
  const fallbackName = song?.artist || song?.name || ''
  const names = splitArtistNames(fallbackName)
  // Sin un array `artists`, lo único que puede haber es un artistId único
  // para el string completo (p. ej. canciones guardadas en biblioteca
  // antes de este cambio) — se lo asignamos solo al primer nombre, igual
  // que arriba, en vez de perderlo.
  return names.map((name, i) => ({ name, artistId: i === 0 ? song?.artistId || null : null }))
}
