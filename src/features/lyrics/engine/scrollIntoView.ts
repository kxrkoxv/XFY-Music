/**
 * Centra elementos dentro de un contenedor con scroll, con un easing que
 * acelera al principio, se pasa un poco (overshoot) y se asienta al final.
 *
 * Portado de ScrollIntoView/Center.ts de Spicy Lyrics (Spikerko/spicy-lyrics),
 * la misma curva de easing por tramos que le da esa sensación "con peso" al
 * saltar de línea en vez de un scrollIntoView lineal que se siente robótico.
 */

export const DEFAULT_DURATION = 700 // ms

export interface ScrollIntoCenterViewOptions {
  /** Desplazamiento extra (px) respecto al centrado exacto. */
  offset?: number
  /** Salto directo sin animación (también forzado por prefers-reduced-motion). */
  instant?: boolean
  /** Duración de la animación en ms. */
  duration?: number
}

/** Curva de easing por tramos: ease-in -> acelera -> overshoot -> asienta. */
function easeCenterScroll(progress: number): number {
  if (progress < 0.4) return 2.5 * progress ** 2
  if (progress < 0.65) return 0.7 + (progress - 0.4) * 1.2
  if (progress < 0.85) return 1.0 + (progress - 0.65) * 0.15
  return 1.03 - (progress - 0.85) * 0.2
}

// Solo una animación de scroll activa a la vez: si se pide centrar otra
// línea a mitad de camino, la anterior se cancela sola (chequea su propio id).
let activeScrollId = 0

/**
 * Centra `element` dentro de `container`.
 * @param container contenedor con overflow-y: auto/scroll
 * @param element elemento a centrar
 */
export function scrollIntoCenterView(
  container: HTMLElement,
  element: HTMLElement,
  opts: ScrollIntoCenterViewOptions = {},
): void {
  if (!container || !element) return
  const { offset = 0, instant = false, duration = DEFAULT_DURATION } = opts

  const targetScrollTop =
    element.offsetTop - (container.clientHeight / 2 - element.clientHeight / 2) - offset

  // prefers-reduced-motion: la línea se centra con un salto directo — el
  // seguimiento de letra sigue funcionando (es feedback funcional), pero sin
  // el desplazamiento animado que el usuario pidió reducir.
  if (
    instant ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  ) {
    activeScrollId++ // cancela cualquier animación suave en curso
    container.scrollTop = targetScrollTop
    return
  }

  const startScrollTop = container.scrollTop
  const distance = targetScrollTop - startScrollTop
  if (Math.abs(distance) < 1) return

  const startTime = performance.now()
  const myScrollId = ++activeScrollId

  function step(now: number): void {
    if (myScrollId !== activeScrollId) return // otra animación tomó el control
    const progress = Math.min((now - startTime) / duration, 1)
    container.scrollTop = startScrollTop + distance * easeCenterScroll(progress)
    if (progress < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}
