import { forwardRef, memo, useEffect, useMemo } from 'react'
import type { CSSProperties, Ref, RefObject } from 'react'
import { motion, useReducedMotion, useSpring, useTransform } from 'motion/react'
import type { MotionStyle } from 'motion/react'
import { estimateWordTimings } from '../wordTiming'
import { useKaraokeWords } from '../theme/useKaraokeWords'
import { buildAnimationSegments } from '../letterEmphasis'
import { isRtl, ArabicPersianRegex, ensureRtlFontLoaded } from '../isRtl'
import type { TTMLWord } from '../parseTTML'

// La misma arquitectura que antes (UN solo nodo persistente por línea),
// pero ahora motion/react maneja filter/opacity/scale con spring physics
// en vez de CSS transitions — mucho más suave y sin el salto brusco que
// se notaba al cambiar de línea activa.
//
// El ghost de texto a la izquierda se resolvió en PlayerPage.css: las
// líneas no activas ya no usan background-clip:text (que mezclado con
// filter:blur + will-change + muchos elementos = bug de composición de Chrome).
// Solo la línea activa lo usa (via .lyrics-line--karaoke), una a la vez.
//
// Segmentos: cada palabra pasa por buildAnimationSegments (letterEmphasis.js,
// portado de IsLetterCapable.ts/Emphasize.ts de Spicy Lyrics real). Las
// palabras cortas/rápidas siguen animándose como una unidad; las notas
// sostenidas (>=1s, <=12 letras) se parten en letras individuales, cada
// una con su propio spring — así una nota larga se ve "iluminarse" letra
// por letra en vez de rellenarse de golpe.
//
// Coros de fondo (`background`) y dúos (`oppositeAligned`): solo llegan
// cuando la fuente es TTML real (parseTTML.js) — LRCLIB/estimación no
// tienen ese dato, así que la línea de coro simplemente no se renderiza
// si `background` viene vacío/undefined. Es un segundo <KaraokeWords>
// independiente, más chico y tenue, con su propio hook de animación.

/** Segmento animable que produce buildAnimationSegments (letterEmphasis.js). */
interface AnimSegment {
  text: string
  start: number
  end: number
  wordIndex: number
  isLetter: boolean
  isLast: boolean
}

interface WordGroup {
  wordIndex: number
  isLetterGroup: boolean
  segments: (AnimSegment & { segIndex: number })[]
}

/** Agrupa segmentos por palabra y los renderiza como spans karaoke — extraído
 * para reusar entre la línea principal y la línea de coro de fondo. */
function KaraokeWords({
  segments,
  elRefs,
}: {
  segments: AnimSegment[]
  elRefs: RefObject<(HTMLSpanElement | null)[]>
}) {
  const wordsForRender = useMemo(() => {
    const grouped: (WordGroup | undefined)[] = []
    segments.forEach((seg, segIndex) => {
      let group = grouped[seg.wordIndex]
      if (!group) {
        group = { wordIndex: seg.wordIndex, isLetterGroup: seg.isLetter, segments: [] }
        grouped[seg.wordIndex] = group
      }
      group.segments.push({ ...seg, segIndex })
    })
    return grouped.filter((group): group is WordGroup => Boolean(group))
  }, [segments])

  return wordsForRender.map((group, i) => (
    <span
      key={`w-${group.wordIndex}-${group.segments[0]!.text}`}
      // Índice de palabra para la cascada de entrada (ver
      // .lyrics-line--karaoke .karaoke-word en spicyLyrics.css): cada palabra
      // entra con un delay proporcional a su posición en la línea.
      style={{ '--wi': i } as CSSProperties}
    >
      {group.isLetterGroup ? (
        <span className="karaoke-word letterGroup">
          {group.segments.map((seg) => (
            <span
              key={seg.segIndex}
              ref={(el) => {
                elRefs.current[seg.segIndex] = el
              }}
              className="karaoke-word letter"
            >
              <span className="karaoke-word-fill">{seg.text}</span>
            </span>
          ))}
        </span>
      ) : (
        <span
          ref={(el) => {
            elRefs.current[group.segments[0]!.segIndex] = el
          }}
          className="karaoke-word"
        >
          <span className="karaoke-word-fill">{group.segments[0]!.text}</span>
        </span>
      )}
      {i < wordsForRender.length - 1 ? ' ' : ''}
    </span>
  ))
}

export interface LyricLineProps {
  text: string
  start: number
  singEnd: number
  exactWords?: TTMLWord[]
  background?: TTMLWord[]
  oppositeAligned?: boolean
  /** Traducción de la línea (translate.ts / MyMemory). `undefined` = no pedida
   * todavía o toggle apagado; `null` = se pidió y falló/no hay. Sin fallback
   * de estimación — igual que el coro de fondo, no se inventa nada. */
  translation?: string | null
  /** Romanización de la línea (romanize.ts). Mismo criterio undefined/null que `translation`. */
  romanization?: string | null
  isActive: boolean
  isPast: boolean
  distance: number
  getCurrentTime: () => number
  onLineClick: (time: number) => void
}

function LyricLineInner(
  {
    text,
    start,
    singEnd,
    exactWords,
    background,
    oppositeAligned,
    translation,
    romanization,
    isActive,
    isPast,
    distance,
    getCurrentTime,
    onLineClick,
  }: LyricLineProps,
  ref: Ref<HTMLParagraphElement>,
) {
  const words = useMemo(
    () => (exactWords && exactWords.length > 0 ? exactWords : estimateWordTimings(text, start, singEnd)),
    [exactWords, text, start, singEnd],
  )

  const segments = useMemo(() => buildAnimationSegments(words), [words])
  const lineIsRtl = useMemo(() => isRtl(text), [text])
  const isArabicPersian = useMemo(() => ArabicPersianRegex.test(text || ''), [text])

  // Carga la tipografía Vazirmatn recién ahora, la primera vez que hace
  // falta de verdad (ver ensureRtlFontLoaded en isRtl.ts) — antes se
  // pedía siempre desde index.html sin importar el idioma de la letra.
  useEffect(() => {
    if (isArabicPersian) ensureRtlFontLoaded()
  }, [isArabicPersian])

  // borde JS->TS: useKaraokeWords.js no tipa su return (useRef([]) => never[]).
  const elRefs = useKaraokeWords(segments, getCurrentTime, isActive, isPast) as RefObject<(HTMLSpanElement | null)[]>

  // Coro de fondo: solo existe cuando parseTTML.js extrajo un span
  // ttm:role="x-bg". Sin fallback de estimación — si no hay dato real
  // de timing no tiene sentido inventar una voz de fondo que no existe.
  const bgSegments = useMemo(
    () => (background && background.length > 0 ? buildAnimationSegments(background) : []),
    [background],
  )
  const bgElRefs = useKaraokeWords(bgSegments, getCurrentTime, isActive, isPast) as RefObject<(HTMLSpanElement | null)[]>

  // Spring suave para las props de "cluster focus":
  // filter blur, opacity, y scale — misma sensación que Spicy Lyrics pero
  // con física real en vez de CSS transition que salta.
  //
  // Reduced-motion: el fade de opacidad se conserva (es feedback legible,
  // no desplazamiento); blur y scale se anulan porque son exactamente el
  // tipo de movimiento que estos usuarios piden reducir.
  const reduceMotion = useReducedMotion()
  const blurSpring  = useSpring(isActive ? 0 : Math.min(distance * 1.1, 4.4), { stiffness: 180, damping: 28 })
  const opacSpring  = useSpring(isActive ? 1 : Math.max(0.28, 1 - distance * 0.18), { stiffness: 200, damping: 30 })
  const scaleSpring = useSpring(isActive ? 1.06 : Math.max(0.88, 1 - distance * 0.025), { stiffness: 200, damping: 26 })

  // Actualizar goals de los springs cuando cambian las props
  blurSpring.set(reduceMotion ? 0 : (isActive ? 0 : Math.min(distance * 1.1, 4.4)))
  opacSpring.set(isActive ? 1 : Math.max(0.28, 1 - distance * 0.18))
  scaleSpring.set(reduceMotion ? 1 : (isActive ? 1.06 : Math.max(0.88, 1 - distance * 0.025)))

  const filterMotion = useTransform(blurSpring, (v) => `blur(${v.toFixed(2)}px)`)

  return (
    <div className={`lyrics-line-group ${oppositeAligned ? 'duet-opposite' : ''}`}>
      <motion.p
        ref={ref}
        className={`lyrics-line ${isActive ? 'active lyrics-line--karaoke' : ''} ${isPast ? 'past' : ''} ${lineIsRtl ? 'rtl' : ''}`}
        dir={lineIsRtl ? 'rtl' : undefined}
        onClick={() => onLineClick(start)}
        // borde JS->TS: las CSS custom properties no entran en MotionStyle.
        style={
          {
            '--distance': distance,
            '--fill': isPast ? '100%' : '0%',
            filter: filterMotion,
            opacity: opacSpring,
            scale: scaleSpring,
            fontFamily: isArabicPersian ? "'Vazirmatn', var(--font-sans)" : undefined,
          } as MotionStyle
        }
      >
        {isActive ? <KaraokeWords segments={segments} elRefs={elRefs} /> : text}
      </motion.p>
      {isActive && bgSegments.length > 0 && (
        <p className={`lyrics-line-bg lyrics-line--karaoke ${lineIsRtl ? 'rtl' : ''}`} dir={lineIsRtl ? 'rtl' : undefined}>
          <KaraokeWords segments={bgSegments} elRefs={bgElRefs} />
        </p>
      )}
      {romanization && (
        <motion.p className="lyrics-line-romanization" style={{ opacity: opacSpring } as MotionStyle}>
          {romanization}
        </motion.p>
      )}
      {translation && (
        <motion.p className="lyrics-line-translation" style={{ opacity: opacSpring } as MotionStyle}>
          {translation}
        </motion.p>
      )}
    </div>
  )
}

export default memo(forwardRef(LyricLineInner))
