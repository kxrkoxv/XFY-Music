/**
 * Romanización de letras (kanji/kana → romaji, cirílico → latín, hangul →
 * romanización, etc.) bajo demanda, vía el endpoint público NO OFICIAL de
 * Google Translate (translate.googleapis.com/translate_a/single, client=gtx
 * — mismo endpoint sin key/CORS abierto que usan extensiones de traducción
 * en el navegador desde hace años, agregando `dt=rm` para pedir además la
 * transliteración de origen). MyMemory (translate.ts) no ofrece esto, y no
 * existe una librería liviana equivalente para TODOS los scripts a la vez
 * (kuroshiro+kuromoji para japonés solo ya pesa ~10MB de diccionario).
 *
* ADVERTENCIA HONESTA: este endpoint no tiene documentación oficial y su
  * forma de respuesta (un array anidado sin nombres de campo) puede cambiar
  * sin aviso — el parseo de abajo es defensivo: en
  * lugar de asumir un índice fijo del array, recorre toda la respuesta
  * buscando el string que "parece romanización" (script latino, longitud
  * comparable al original) y si no encuentra nada razonable, simplemente
  * no muestra romanización para esa línea en vez de mostrar basura.
  *
  * Igual que translate.ts: cachea cada línea PERMANENTE en el IndexedDB de
 * lyricsCache.ts (la romanización de una línea tampoco cambia nunca).
 */
import { readLyricCache, writeLyricCache } from '@features/lyrics/engine/lyricsCache'

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single'
// Mismo espaciado conservador que translate.ts para no ráfaga-pedir una
// letra larga de una — este endpoint no es una API con cuota documentada,
// así que conviene ser igual de prudente.
const REQUEST_DELAY_MS = 180

function cacheKey(text: string): string {
  return `romanize:${text}`
}

/** Solo letras latinas, dígitos, diacríticos, y puntuación/espacio típicos de una transliteración. */
const LOOKS_LATIN = /^[\p{Script=Latin}\d\s'".,!?¿¡…\-]+$/u

// Recorre recursivamente la respuesta (array anidado sin forma fija) y
// junta todos los strings hoja, en orden. El shape real conocido pone la
// romanización en algún tuple de data[0][i], pero el índice exacto varía
// según la versión del endpoint — por eso no se asume una posición fija.
function collectStringLeaves(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    if (node.trim()) out.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) collectStringLeaves(child, out)
  }
}

/**
 * Heurística: de todos los strings que aparecen en la respuesta, la
 * romanización es la que (a) es puramente script latino, (b) no es
 * idéntica al texto original, (c) no es un código de idioma de 2-3
 * letras suelto (ej. "ja", "auto"), y (d) tiene una longitud del mismo
 * orden que el original (para no agarrar un string latino suelto de
 * metadata interna sin relación con el texto pedido).
 */
function pickRomanization(raw: unknown, original: string): string | null {
  const leaves: string[] = []
  collectStringLeaves(raw, leaves)

  const normalizedOriginal = original.trim().toLowerCase()
  let best: string | null = null
  let bestScore = -Infinity

  for (const leaf of leaves) {
    const trimmed = leaf.trim()
    if (!trimmed || trimmed.toLowerCase() === normalizedOriginal) continue
    if (trimmed.length <= 3 && /^[a-z]+$/i.test(trimmed)) continue // probable código de idioma
    if (!LOOKS_LATIN.test(trimmed)) continue

    const lengthRatio = trimmed.length / Math.max(original.length, 1)
    if (lengthRatio < 0.3 || lengthRatio > 3) continue // muy corto/largo para ser la transliteración

    // Preferimos la longitud más cercana a la del original.
    const score = -Math.abs(1 - lengthRatio)
    if (score > bestScore) {
      bestScore = score
      best = trimmed
    }
  }

  return best
}

async function romanizeOne(text: string): Promise<{ text: string | null; fromNetwork: boolean }> {
  const trimmed = text.trim()
  if (!trimmed) return { text: '', fromNetwork: false }

  const key = cacheKey(trimmed)
  const cached = await readLyricCache<string | null>(key)
  if (cached !== undefined) return { text: cached, fromNetwork: false }

  try {
    const params = new URLSearchParams({
      client: 'gtx',
      sl: 'auto',
      tl: 'es',
      dt: 't',
    })
    params.append('dt', 'rm')
    params.set('q', trimmed)
    const res = await fetch(`${ENDPOINT}?${params}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const romanization = pickRomanization(data, trimmed)

    if (!romanization) {
      console.warn('[XFY] Romanización: forma de respuesta inesperada, se omite esta línea')
    }

    await writeLyricCache(key, romanization)
    return { text: romanization, fromNetwork: true }
  } catch {
    console.warn('[XFY] Romanización de letra falló')
    return { text: null, fromNetwork: true }
  }
}

/**
 * Romaniza un arreglo de líneas en orden, avisando línea por línea a medida
 * que llegan — mismo patrón que translateLyrics en translate.ts.
 */
export async function romanizeLyrics(
  lines: string[],
  onLine: (index: number, romanization: string | null) => void,
  signal?: AbortSignal,
): Promise<void> {
  for (let i = 0; i < lines.length; i++) {
    if (signal?.aborted) return
    const { text, fromNetwork } = await romanizeOne(lines[i] ?? '')
    if (signal?.aborted) return
    onLine(i, text)
    if (fromNetwork) await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS))
  }
}
