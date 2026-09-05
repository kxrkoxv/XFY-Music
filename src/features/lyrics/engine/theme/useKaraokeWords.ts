import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { Spring } from '../modules/Spring'
import type { WordTiming } from '../wordTiming'
import { clamp, WordScaleSpline, WordYOffsetSpline, WordGlowSpline, SPRING } from './curves'

// Anima cada SEGMENTO (una palabra entera, o una letra individual cuando
  // la palabra califica para énfasis por letra — ver letterEmphasis.js) con
  // física de resortes real (mismo motor que Spicy Lyrics, modules/Spring.ts
  // — port de Fraktality/spr), en vez de un simple `transition` de CSS.
  //
  // A propósito NO usamos useState para esto: escribir estado de React en
  // cada frame (varias veces por segundo, por cada segmento) sería exactamente
  // el problema de re-render que ya resolvió LyricsPanel. En cambio,
  // escribimos custom properties CSS directo sobre los <span> vía refs —
  // el mismo patrón imperativo que usa el motor original (que manipula el
  // DOM directo en vez de pasar por un framework), adaptado a refs de React.
  //
  // `segments`: [{ text, start, end, isLetter }] — timing plano de la línea,
  //   ya sea a nivel palabra o letra (ver buildAnimationSegments)
  // `getCurrentTime`: función que devuelve el tiempo actual en vivo (léelo de
  //   tu store de zustand con getState(), NO con el hook, para que este efecto
  //   no dependa de un valor que cambia cada tick)
  // `active`: si esta línea es la que se está cantando ahora mismo
  // `isPast`: cuando !active, si ya se cantó (fill 100%) o todavía no (fill 0%)
  //   — se usa SOLO para fijar el estado de reposo; el `.karaoke-word` tiene
  //   su propia transición CSS corta que suaviza el salto de "lo que sea que
  //   estuviera animando" a este valor final, así que no hace falta animarlo
  //   acá a mano.
export function useKaraokeWords(
  segments: readonly WordTiming[],
  getCurrentTime: () => number,
  active: boolean,
  isPast = false,
): RefObject<(HTMLSpanElement | null)[]> {
  const elRefs = useRef<(HTMLSpanElement | null)[]>([])
  const springsRef = useRef<{ scale: Spring; yOffset: Spring; glow: Spring }[]>([])

  elRefs.current = []

  useEffect(() => {
    if (!active) {
      // Línea no activa: la dejamos en su estado de reposo final (todo
      // cantado o nada cantado) de una sola vez — no tiene sentido correr
      // el resorte por segmento para algo que no se está cantando ahora.
      // Como el <span> es el MISMO nodo de siempre (nunca se desmonta al
      // dejar de estar activo, ver LyricLine.jsx), la transición CSS de
      // .karaoke-word agarra este cambio y lo suaviza sola.
      const fill = isPast ? '100%' : '0%'
      elRefs.current.forEach((el) => {
        if (!el) return
        el.style.setProperty('--word-scale', '1')
        el.style.setProperty('--word-y', '0%')
        el.style.setProperty('--word-glow', '0')
        el.style.setProperty('--word-fill', fill)
        el.classList.toggle('word-sung', isPast)
        el.classList.remove('word-active')
      })
      return undefined
    }

    springsRef.current = segments.map(() => ({
      scale: new Spring(1, SPRING.scale.frequency, SPRING.scale.damping, 1),
      yOffset: new Spring(0, SPRING.yOffset.frequency, SPRING.yOffset.damping, 0),
      glow: new Spring(0, SPRING.glow.frequency, SPRING.glow.damping, 0),
    }))

    // Reduced-motion: el rAF sigue corriendo porque el highlight funcional
    // (--word-fill + clases word-sung/word-active, que son color) es justo
    // lo que hay que conservar; lo que se anula es el movimiento — no se
    // pisan --word-scale/--word-y/--word-glow, que quedan en su valor de
    // reposo (1 / 0% / 0, escrito por la rama !active o por el CSS base).
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let rafId = 0
    let lastTime = performance.now()

    const frame = (now: number): void => {
      const dt = Math.min(0.1, (now - lastTime) / 1000)
      lastTime = now
      const t = getCurrentTime()

      segments.forEach((seg, i) => {
        const springs = springsRef.current[i]
        const el = elRefs.current[i]
        if (!springs || !el) return
        const duration = Math.max(0.05, seg.end - seg.start)
        const progress = clamp((t - seg.start) / duration, 0, 1)
        const isSinging = t >= seg.start && t < seg.end

        if (reduceMotion) {
          el.style.setProperty('--word-fill', `${(progress * 100).toFixed(1)}%`)
          el.classList.toggle('word-sung', t >= seg.end)
          el.classList.toggle('word-active', isSinging)
          return
        }

        if (isSinging) {
          springs.scale.SetGoal(WordScaleSpline.at(progress))
          springs.yOffset.SetGoal(WordYOffsetSpline.at(progress))
          springs.glow.SetGoal(WordGlowSpline.at(progress))
        } else {
          springs.scale.SetGoal(1)
          springs.yOffset.SetGoal(0)
          springs.glow.SetGoal(0)
        }

        const scale = springs.scale.Step(dt)
        const yOff = springs.yOffset.Step(dt)
        const glow = springs.glow.Step(dt)

        el.style.setProperty('--word-scale', scale.toFixed(4))
        el.style.setProperty('--word-y', `${(yOff * 100).toFixed(3)}%`)
        el.style.setProperty('--word-glow', glow.toFixed(3))
        el.style.setProperty('--word-fill', `${(progress * 100).toFixed(1)}%`)
        el.classList.toggle('word-sung', t >= seg.end)
        el.classList.toggle('word-active', isSinging)
      })

      rafId = requestAnimationFrame(frame)
    }

    rafId = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(rafId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, active, isPast])

  return elRefs
}
