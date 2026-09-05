// Genera timing por palabra a partir de letras sincronizadas por LÍNEA
// (formato LRC, que es lo que devuelve el servidor de letras/LRCLIB).
//
// Spicy Lyrics real usa TTML/Musixmatch con timing por palabra exacto.
// Nosotros no tenemos esa fuente (la extensión usa la API interna de
// Spotify, que no es reutilizable fuera del cliente), así que "actuamos"
// el timing: repartimos la duración de la línea entre sus palabras, en
// proporción a la longitud de cada una (las palabras largas duran un
// poco más que las cortas — igual que hace Musixmatch en su modo
// "estimado" cuando no hay datos exactos).
//
// Si en algún momento conseguís una fuente real con timing por palabra
// (por ejemplo un .ttml), hay que mapearla al mismo shape de salida
// (ver parseTTML.js) y esto deja de usarse para esa canción.

/** Una palabra con su ventana de tiempo estimada, en segundos. */
export interface WordTiming {
  text: string
  start: number
  end: number
}

/**
 * Peso "silábico" de una palabra: cuenta grupos vocálicos (aproximación
 * de sílabas en español/inglés sin diccionario). Cantar "extraordinariamente"
 * toma mucho más que cantar "y" — y el largo en LETRAS mide mal eso
 * ("y" tiene 1 letra pero igual lleva su golpe de voz). Mínimo 1: toda
 * palabra ocupa al menos su ataque.
 */
function syllableWeight(word: string): number {
  const groups = word.toLowerCase().match(/[aeiouáéíóúü]+/g)
  return Math.max(1, groups ? groups.length : 1)
}

/**
 * @param text texto de la línea
 * @param start segundo de inicio de la línea
 * @param singEnd segundo estimado en que termina de cantarse la línea
 */
export function estimateWordTimings(
  text: string | null | undefined,
  start: number,
  singEnd: number,
): WordTiming[] {
  const words = String(text || '')
    .split(/(\s+)/)
    .filter((chunk) => chunk.length > 0)

  const wordChunks = words.filter((w) => !/^\s+$/.test(w))
  if (wordChunks.length === 0) return []

  const totalDuration = Math.max(0.15, singEnd - start)

  // Peso silábico por palabra — reparte el tiempo como canta la boca,
  // no como se escribe la palabra.
  const weights = wordChunks.map(syllableWeight)
  const totalWeight = weights.reduce((a, b) => a + b, 0)

  let cursor = start
  const result: WordTiming[] = []
  wordChunks.forEach((w, i) => {
    const dur = ((weights[i] ?? 0) / totalWeight) * totalDuration
    result.push({ text: w, start: cursor, end: cursor + dur })
    cursor += dur
  })

  return result
}
