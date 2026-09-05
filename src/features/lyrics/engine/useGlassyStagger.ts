import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { Spring } from './modules/Spring'
import { GLASSY_SPRING, GLASSY_SPRING_FAST } from './theme/curves'
import type { SpringConfig } from './theme/curves'

/**
 * GlassyFlow (better-lyrics-glassy/public/glassyflow.js), portado a
 * React/hooks: en vez de mover TODAS las líneas en bloque de una, cada
 * línea visible recibe un pequeño empujón vertical con un delay
 * proporcional a su distancia a la nueva línea activa (staggerStep) y lo
 * absorbe con física de resortes real — el mismo motor que ya usa el
 * karaoke palabra por palabra (modules/Spring.ts, port de Fraktality/spr).
 * El resultado es una "ola" que fluye hacia la línea activa en vez de que
 * todo salte al unísono.
 *
 * A diferencia del original (que reemplaza el scroll nativo con
 * translate por línea), acá se suma COMO CAPA sobre el centrado del
 * contenedor que ya hace scrollIntoCenterView (ver scrollIntoView.js /
 * useLyricsAutoScroll.js) — no lo reemplaza. Cada línea escribe su offset
 * en `--glassy-y` (ver `.lyrics-line { transform: translateY(...) }` en
 * spicyLyrics.css), el mismo patrón imperativo (refs + CSS custom
 * properties + rAF) que useKaraokeWords.js, para no meter re-renders de
 * React en un loop que corre varias veces por segundo.
 */

interface UseGlassyStaggerParams {
  /** refs por índice de línea (el mismo objeto que llena LyricsPanel) */
  lineRefs: RefObject<Record<number, HTMLElement>>
  activeIndex: number
  /** segundos entre el start de la línea activa y el de la anterior;
   *  gaps cortos (rap, coros) usan un resorte más rígido y stagger más
   *  corto (Fast Transition del original). */
  gapToNext: number | null
  /** cambia al cambiar de canción */
  resetKey: unknown
  /** se incrementa ante un seek/salto brusco */
  seekSignal: number
}

interface GlassyEntry {
  el: HTMLElement
  spring: Spring | null
  startAt: number
  kicked: boolean
  kick: number
  springCfg: SpringConfig
}

const STAGGER_STEP_MS = 40 // CFG.staggerStep del original
const FAST_STAGGER_STEP_MS = 30 // CFG.fastStaggerStep
const FAST_GAP_THRESHOLD_S = 1.5 // CFG.fastTransitionThreshold
// Empujón inicial por línea. Antes era 10px con tope x2 (hasta 20px de
// kick base, más el overshoot propio del resorte subamortiguado — fácil
// pasar de 25-30px reales en pantalla). Con el margen entre líneas que
// había antes, ese pico transitorio alcanzaba a pisar la línea vecina
// durante la "ola" — el efecto quedaba bien la mayor parte del tiempo,
// pero en las transiciones grandes (saltos de coro/dúo) se notaba como
// las letras chocándose. Bajado + tope más chico: la ola sigue
// sintiéndose, pero ya no invade el renglón de al lado.
const KICK_PX = 7
const MAX_KICK_MULTIPLIER = 1.6
const WINDOW = 12 // líneas hacia cada lado del índice activo a animar

export function useGlassyStagger({ lineRefs, activeIndex, gapToNext, resetKey, seekSignal }: UseGlassyStaggerParams): void {
  const prevActiveRef = useRef(activeIndex)
  const entriesRef = useRef<Record<number, GlassyEntry>>({}) // index -> { spring, el, startAt, kicked }
  const rafRef = useRef<number | null>(null)
  const skipNextRef = useRef(true) // primera línea de una canción: sin cascada

  const resetAll = (): void => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    Object.values(entriesRef.current).forEach(({ el }) => el?.style.setProperty('--glassy-y', '0px'))
    entriesRef.current = {}
  }

  // Cambio de canción: sin cascada para la primera línea (ya salta
  // instantáneo por scrollIntoCenterView), y se limpia cualquier resto
  // de resorte de la canción anterior.
  useEffect(() => {
    resetAll()
    prevActiveRef.current = activeIndex
    skipNextRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  // Seek / salto brusco: mismo criterio — el contenedor ya salta al toque,
  // así que la cascada de la próxima transición se salta para no pelear
  // visualmente con el salto instantáneo.
  useEffect(() => {
    skipNextRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekSignal])

  useEffect(() => {
    const prev = prevActiveRef.current
    prevActiveRef.current = activeIndex
    const shouldSkip = skipNextRef.current
    skipNextRef.current = false

    const delta = activeIndex - prev
    if (shouldSkip || delta === 0 || activeIndex < 0) return

    // Reduced-motion: la "ola" entera es movimiento decorativo — el centrado
    // de la línea ya salta directo (ver scrollIntoView.js), así que acá no
    // se empuja nada.
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return
    }

    const isFast = gapToNext != null && gapToNext < FAST_GAP_THRESHOLD_S
    const stagger = isFast ? FAST_STAGGER_STEP_MS : STAGGER_STEP_MS
    const springCfg = isFast ? GLASSY_SPRING_FAST : GLASSY_SPRING
    const direction = delta > 0 ? 1 : -1
    // Saltos grandes (dúo/coro con varias líneas activas a la vez) empujan
    // un poco más fuerte, con tope — mismo espíritu del Delta-Adaptive
    // LookAhead del original, simplificado a un factor de magnitud.
    const kick = KICK_PX * direction * Math.min(MAX_KICK_MULTIPLIER, Math.abs(delta))

    const now = performance.now()
    const entries = entriesRef.current
    for (let i = activeIndex - WINDOW; i <= activeIndex + WINDOW; i++) {
      const el = lineRefs.current[i]
      if (!el) continue
      const distance = Math.abs(i - activeIndex)
      entries[i] = {
        el,
        spring: null,
        startAt: now + distance * stagger,
        kicked: false,
        kick,
        springCfg,
      }
    }

    if (rafRef.current !== null) return // ya hay un loop corriendo, toma los nuevos goals solo

    let last = now
    const tick = (t: number): void => {
      const dt = Math.min(0.05, (t - last) / 1000)
      last = t
      let anyAlive = false

      for (const key in entries) {
        const entry = entries[key]
        if (!entry?.el) continue

        if (!entry.kicked) {
          if (t < entry.startAt) {
            anyAlive = true
            continue
          }
          entry.spring = new Spring(entry.kick, entry.springCfg.frequency, entry.springCfg.damping, 0)
          entry.kicked = true
        }

        const spring = entry.spring
        if (!spring) continue // inalcanzable en la práctica: kicked ⇒ spring creado arriba
        const val = spring.Step(dt)
        entry.el.style.setProperty('--glassy-y', `${val.toFixed(2)}px`)
        if (!spring.CanSleep()) anyAlive = true
      }

      if (anyAlive) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = null
        for (const key in entries) {
          entries[key]?.el?.style.setProperty('--glassy-y', '0px')
        }
        entriesRef.current = {}
      }
    }
    rafRef.current = requestAnimationFrame(tick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex])

  useEffect(() => resetAll, [])
}
