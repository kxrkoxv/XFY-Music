// Énfasis letra-por-letra para palabras sostenidas (notas largas), portado
// de Spikerko/spicy-lyrics (Applyer/Utils/IsLetterCapable.ts + Emphasize.ts).
//
// El sistema actual (useKaraokeWords) llena cada PALABRA completa de una
// sola vez. Eso se ve perfecto en tempo normal, pero en baladas o notas
// sostenidas ("teeeeeengo que decirteeee...") una palabra puede durar 2-3s
// enteros, y llenarla de golpe se ve plano comparado con Apple Music /
// Musixmatch, que van iluminando letra por letra mientras dura la nota.
//
// La extensión real decide esto con un umbral simple: si la palabra dura
// más de ~1s Y tiene 12 letras o menos, se "emphasiza" (se parte en letras,
// cada una con una fracción igual del tiempo total). Palabras cortas y
// rápidas se quedan como una sola unidad — partirlas en letras ahí se
// vería como ruido, no como una nota sostenida.

import type { WordTiming } from './wordTiming'

/** Duración mínima (segundos) para que una palabra califique para animación letra por letra. */
const MIN_DURATION_S = 1.0
/** Largo máximo de letras — palabras muy largas no se parten (evita spans microscópicos). */
const MAX_LETTERS = 12

/** Segmento animable: una palabra entera o una letra individual, con la palabra dueña anotada. */
export interface AnimationSegment extends WordTiming {
  wordIndex: number
  isLetter: boolean
  isLast: boolean
}

export function isLetterCapable(text: string, durationS: number): boolean {
  const letters = Array.from(text || '').length
  if (letters === 0 || letters > MAX_LETTERS) return false
  return durationS >= MIN_DURATION_S
}

/**
 * Reparte la duración de una palabra en partes iguales por letra.
 * @param text texto de la palabra
 * @param start segundo de inicio
 * @param end segundo de fin
 */
export function splitIntoLetters(text: string, start: number, end: number): WordTiming[] {
  const letters = Array.from(text || '')
  if (letters.length === 0) return []

  const totalDuration = Math.max(0.01, end - start)
  const letterDuration = totalDuration / letters.length

  return letters.map((letter, i) => ({
    text: letter,
    start: start + i * letterDuration,
    end: start + (i + 1) * letterDuration,
  }))
}

/**
 * Aplana un arreglo de palabras {text,start,end} en "segmentos" animables:
 * una palabra entera si es corta/rápida, o sus letras individuales si
 * califica para énfasis. Cada segmento conserva `wordIndex` para que el
 * render pueda seguir agrupando visualmente las letras dentro de su palabra
 * (sin romper el layout de línea) mientras las anima por separado.
 */
export function buildAnimationSegments(words: WordTiming[]): AnimationSegment[] {
  const segments: AnimationSegment[] = []

  words.forEach((w, wordIndex) => {
    const duration = w.end - w.start
    if (isLetterCapable(w.text, duration)) {
      const letters = splitIntoLetters(w.text, w.start, w.end)
      letters.forEach((l, i) => {
        segments.push({ ...l, wordIndex, isLetter: true, isLast: i === letters.length - 1 })
      })
    } else {
      segments.push({ ...w, wordIndex, isLetter: false, isLast: true })
    }
  })

  return segments
}
