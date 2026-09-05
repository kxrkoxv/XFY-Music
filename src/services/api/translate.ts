/**
 * Traducción de letras bajo demanda, vía MyMemory (gratis, sin API key,
 * CORS habilitado desde el navegador — mismo criterio que LRCLIB en
 * lrclib.ts: se llama directo, sin backend propio).
 *
 * Cada línea se cachea de forma PERMANENTE en el mismo IndexedDB que usa
 * lyricsCache.ts: la traducción de una letra no cambia nunca, así que una
 * vez pedida no tiene sentido volver a pagar la cuota diaria por ella.
 */
import { readLyricCache, writeLyricCache } from '@features/lyrics/engine/lyricsCache'

const ENDPOINT = 'https://api.mymemory.translated.net/get'
// MyMemory cobra por request contra la cuota diaria sin key (~5000
// caracteres); este delay es solo para no ráfaga-pedir toda una letra
// larga de una vez. Los hits de caché (letra ya traducida antes) no lo pagan.
const REQUEST_DELAY_MS = 180
// Límite de bytes por request que documenta la API.
const MAX_QUERY_LEN = 490

function cacheKey(text: string, targetLang: string): string {
  return `translate:${targetLang}:${text}`
}

async function translateOne(
  text: string,
  targetLang: string,
  sourceLang: string,
): Promise<{ text: string | null; fromNetwork: boolean }> {
  const trimmed = text.trim()
  if (!trimmed) return { text: '', fromNetwork: false }

  const key = cacheKey(trimmed, targetLang)
  const cached = await readLyricCache<string | null>(key)
  if (cached !== undefined) return { text: cached, fromNetwork: false }

  try {
    const params = new URLSearchParams({
      q: trimmed.slice(0, MAX_QUERY_LEN),
      langpair: `${sourceLang}|${targetLang}`,
    })
    const res = await fetch(`${ENDPOINT}?${params}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const translated = data?.responseData?.translatedText

    // Cuota agotada o error: MyMemory los devuelve como si fueran una
    // traducción normal (mismo campo). Se filtra para no cachear ni
    // mostrar ese aviso como si fuera parte de la letra.
    if (typeof translated !== 'string' || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(translated)) {
      return { text: null, fromNetwork: true }
    }

    await writeLyricCache(key, translated)
    return { text: translated, fromNetwork: true }
  } catch {
    console.warn('[XFY] Traducción de letra falló')
    return { text: null, fromNetwork: true }
  }
}

/**
 * Traduce un arreglo de líneas de letra en orden, avisando línea por línea
 * a medida que llegan (`onLine`) en vez de esperar a que termine la canción
 * entera. Se corta apenas `signal` se aborta (cambio de canción a mitad de
 * carga) — evita pintar traducciones de una letra que el usuario ya dejó atrás.
 */
export async function translateLyrics(
  lines: string[],
  targetLang: string,
  onLine: (index: number, translation: string | null) => void,
  signal?: AbortSignal,
  sourceLang = 'autodetect',
): Promise<void> {
  for (let i = 0; i < lines.length; i++) {
    if (signal?.aborted) return
    const { text, fromNetwork } = await translateOne(lines[i] ?? '', targetLang, sourceLang)
    if (signal?.aborted) return
    onLine(i, text)
    if (fromNetwork) await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS))
  }
}
