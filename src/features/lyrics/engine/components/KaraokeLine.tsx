import { memo, useMemo } from 'react'
import type { RefObject } from 'react'
import { estimateWordTimings } from '../wordTiming'
import { useKaraokeWords } from '../theme/useKaraokeWords'
import type { TTMLWord } from '../parseTTML'

// Línea activa, renderizada palabra por palabra con animación de resorte.
// Se usa SOLO para la línea que está sonando ahora mismo; el resto de las
// líneas se siguen mostrando con tu <LyricLine> normal (gradiente por
// línea), que ya está optimizado con memo(). Total: nunca hay más de una
// KaraokeLine montada a la vez.
//
// `getCurrentTime`: función estable que lee el tiempo en vivo desde el
// store (evita que el efecto de animación se reinicie en cada tick).
// `exactWords`: timing real por palabra (Enhanced LRC vía lrclib.js, o un
// futuro .ttml vía parseTTML.js) — cuando está presente se usa tal cual,
// en vez del reparto estimado por longitud de palabra de wordTiming.js.
function KaraokeLine({
  text,
  start,
  singEnd,
  exactWords,
  getCurrentTime,
  onLineClick,
}: {
  text: string
  start: number
  singEnd: number
  exactWords?: TTMLWord[]
  getCurrentTime: () => number
  onLineClick: (time: number) => void
}) {
  const words = useMemo<TTMLWord[]>(
    () => (exactWords && exactWords.length > 0 ? exactWords : estimateWordTimings(text, start, singEnd)),
    [exactWords, text, start, singEnd],
  )
  // borde JS->TS: useKaraokeWords.js no tipa su return (useRef([]) => never[]).
  const elRefs = useKaraokeWords(words, getCurrentTime, true) as RefObject<(HTMLSpanElement | null)[]>

  return (
    <p className="lyrics-line lyrics-line--karaoke active" onClick={() => onLineClick(start)}>
      {words.map((w, i) => (
        <span key={`${i}-${w.text}`}>
          <span
            ref={(el) => {
              elRefs.current[i] = el
            }}
            className="karaoke-word"
          >
            {w.text}
          </span>
          {i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </p>
  )
}

export default memo(KaraokeLine)
