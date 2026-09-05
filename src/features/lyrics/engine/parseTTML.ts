// Parser de TTML propio, standalone — el formato con timing por palabra
// que usa Apple Music / AMLL / Musixmatch. La extensión real (spicy-lyrics)
// NO trae un parser propio del lado del cliente: le manda el TTML crudo a
// un endpoint interno de Spotify que lo procesa server-side
// (utils/Lyrics/manager/parseTTML.ts → Query(["parseTTML", ...])), lo cual
// no es reusable fuera del cliente de Spotify. Este parser sigue la
// especificación pública que usa la base de datos AMLL TTML DB
// (github.com/amll-dev/amll-ttml-db, instructions/ttml-specification-en.md)
// para que el output sea compatible con TTML real exportado desde ahí,
// Musixmatch, o el editor amll-ttml-tool.
//
// Soporta lo que la extensión real anima pero que la versión anterior no
// leía del todo:
//   - Coros / voces de fondo: <span ttm:role="x-bg">...</span>
//     (normalmente anidado dentro de otro <span> o <p>)
//   - Traducciones: <span ttm:role="x-translation" xml:lang="es">...</span>
//     (no tienen begin/end propio — son texto plano asociado a la línea)
//   - Dúos / voces alternadas: atributo ttm:agent="v1"/"v2" en <p>, usado
//     para decidir side (OppositeAligned) igual que hace Synced/Syllable.ts
//     con LineData.OppositeAligned
//
// El día que tengas una fuente real de TTML (AMLL TTML DB, exportado de
// Musixmatch/Apple Music, o el editor amll-ttml-tool), esto te da
// directamente el mismo shape {time, text, words} que ya produce
// lrclib.js — pluggeable sin adaptador en LyricsPanel.

/** Palabra con timing propio (voz principal o fondo). */
export interface TTMLWord {
  text: string
  start: number
  end: number
}

/** Línea parseada — mismo shape que produce lrclib.js, pluggeable directo
 *  en LyricsPanel sin adaptador. */
export interface TTMLLine {
  time: number
  text: string
  words?: TTMLWord[]
  background?: TTMLWord[]
  translation?: string
  oppositeAligned?: boolean
}

function parseClock(str: string | null | undefined): number {
  if (!str) return 0
  const raw = String(str).trim()
  // Offset-time del estándar TTML: "12.5s" / "250ms". Es el formato que
  // usan los archivos reales de AMLL TTML DB — sin esto, Number('0.5s')
  // da NaN y TODA la letra quedaba con timings en 0.
  const offset = raw.match(/^(\d+(?:\.\d+)?)(ms|s)$/)
  if (offset) return offset[2] === 'ms' ? Number(offset[1]) / 1000 : Number(offset[1])
  // Soporta "ss.mmm", "mm:ss.mmm" y "hh:mm:ss.mmm"
  const parts = raw.split(':').map(Number)
  if (parts.some((n) => Number.isNaN(n))) return 0
  if (parts.length === 3) {
    const [h = 0, m = 0, s = 0] = parts
    return h * 3600 + m * 60 + s
  }
  if (parts.length === 2) {
    const [m = 0, s = 0] = parts
    return m * 60 + s
  }
  return Number(raw) || 0
}

/** Primer agent visto en el documento — se usa como "lado 1" para dúos. */
function detectPrimaryAgent(paragraphs: Element[]): string | null {
  for (const p of paragraphs) {
    const agent = p.getAttribute('ttm:agent') || p.getAttribute('agent')
    if (agent) return agent
  }
  return null
}

/**
 * Extrae los spans de palabra con timing propio de un <p> o <span> contenedor,
 * separando las de voz principal de las de fondo (ttm:role="x-bg") y las
 * traducciones (ttm:role="x-translation", sin timing propio).
 */
interface ExtractedSpans {
  words: TTMLWord[]
  background: TTMLWord[]
  translation: string | null
}

function extractSpans(container: Element): ExtractedSpans {
  const words: TTMLWord[] = []
  const background: TTMLWord[] = []
  let translation: string | null = null

  const directSpans = Array.from(container.children).filter((el) => el.tagName.toLowerCase() === 'span')

  directSpans.forEach((span) => {
    const role = span.getAttribute('ttm:role') || span.getAttribute('role')

    if (role === 'x-translation') {
      // Traducción: no tiene timing propio, es texto de apoyo para la línea.
      translation = (span.textContent || '').trim()
      return
    }

    if (role === 'x-bg') {
      // Voz de fondo: puede venir como un span contenedor con spans de
      // palabra adentro, o directamente como texto plano con su propio timing.
      const nestedWordSpans = Array.from(span.querySelectorAll('span')).filter((s) => s.hasAttribute('begin'))
      if (nestedWordSpans.length > 0) {
        nestedWordSpans.forEach((s) => {
          background.push({
            text: s.textContent || '',
            start: parseClock(s.getAttribute('begin')),
            end: parseClock(s.getAttribute('end') || s.getAttribute('begin')),
          })
        })
      } else if (span.hasAttribute('begin')) {
        background.push({
          text: span.textContent || '',
          start: parseClock(span.getAttribute('begin')),
          end: parseClock(span.getAttribute('end') || span.getAttribute('begin')),
        })
      }
      return
    }

    // Palabra de voz principal (span sin role, con begin/end propio).
    if (span.hasAttribute('begin')) {
      words.push({
        text: span.textContent || '',
        start: parseClock(span.getAttribute('begin')),
        end: parseClock(span.getAttribute('end') || span.getAttribute('begin')),
      })
    }
  })

  return { words, background, translation }
}

/**
 * @param ttml contenido crudo del archivo .ttml
 */
export function parseTTML(ttml: string): TTMLLine[] {
  const doc = new DOMParser().parseFromString(ttml, 'application/xml')
  const parserError = doc.querySelector('parsererror')
  if (parserError) return []

  const paragraphs = Array.from(doc.getElementsByTagName('p'))
  if (paragraphs.length === 0) return []

  const primaryAgent = detectPrimaryAgent(paragraphs)

  const lines: TTMLLine[] = paragraphs
    .map((p) => {
      const pBegin = parseClock(p.getAttribute('begin'))
      const { words, background, translation } = extractSpans(p)
      const agent = p.getAttribute('ttm:agent') || p.getAttribute('agent')

      // Texto plano de fallback: si por lo que sea no hay spans de palabra
      // (línea sin timing por palabra, solo begin/end de línea), usamos el
      // textContent completo del <p> — igual que hacía la versión anterior.
      const plainText = words.length > 0 ? words.map((w) => w.text).join('') : (p.textContent || '').trim()

      const line: TTMLLine = {
        time: pBegin,
        text: plainText,
        words: words.length > 0 ? words : undefined,
      }

      if (background.length > 0) line.background = background
      if (translation) line.translation = translation
      if (agent && primaryAgent && agent !== primaryAgent) line.oppositeAligned = true

      return line
    })
    .filter((line) => line.text.length > 0)

  return lines
}

export default parseTTML
