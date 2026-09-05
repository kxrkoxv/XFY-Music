import { useRef } from 'react'
import { useDrag } from '@use-gesture/react'
import { animate, useMotionValue, useTransform } from 'motion/react'

/**
 * Gesto de "volver" arrastrando desde el borde izquierdo — el equivalente
 * casero del interactivePopGestureRecognizer de iOS (UINavigationController)
 * y del predictive back de Android. Hace falta reimplementarlo a mano
 * porque XFY corre como PWA instalada (manifest con display: "standalone"),
 * y en standalone no hay chrome de navegador — por lo tanto tampoco hay
 * gesto nativo de swipe-back del sistema al que engancharse. Sin esto, la
 * única forma de volver es tocar un botón.
 *
 * Usa @use-gesture/react (igual que useDraggableTabPill, ver ese archivo
 * para el porqué) en vez de touch events a mano: resuelve por su cuenta
 * los detalles finos de touch-action/passive listeners que hacen que un
 * gesto "case" de verdad en Safari/Chrome Android reales, no solo en el
 * simulador de escritorio.
 *
 * Diseño calcado del de iOS:
 *  - Sólo arma si el toque EMPIEZA pegado al borde (los primeros ~24px) —
 *    igual que el reconocedor nativo, que ignora arrastres que empiezan
 *    en medio de la pantalla (así no compite con scroll horizontal de
 *    carruseles, sliders de progreso, etc.).
 *  - Es interactivo: la página sigue al dedo en vivo, no hay animación
 *    fija hasta soltar.
 *  - Al soltar, si se cruzó ~30% del ancho de pantalla O el flick fue
 *    rápido (aunque no se haya llegado al 30%), completa la navegación;
 *    si no, hace spring-back a la posición original — mismos dos criterios
 *    (distancia Y velocidad) que usa UIKit para decidir "completar vs.
 *    cancelar" un pop interactivo.
 *  - Solo mouse-touch real: en desktop (pointerType mouse) no arma, ahí no
 *    existe este gesto de forma nativa en ningún sistema operativo.
 */

const EDGE_ZONE_PX = 24
const COMMIT_DISTANCE_RATIO = 0.3
const COMMIT_VELOCITY = 0.55 // px/ms — flick rápido, mismo orden que otros umbrales de flick en la app

interface UseEdgeSwipeBackOptions {
  /** Si el gesto puede armar. Debe ser false en la home, login, o cuando no hay adónde volver. */
  enabled: boolean
  /** Se llama una vez que la animación de "completar" el swipe terminó — acá es donde hay que navegar de verdad. */
  onCommit: () => void
}

export function useEdgeSwipeBack({ enabled, onCommit }: UseEdgeSwipeBackOptions) {
  const x = useMotionValue(0)
  const widthRef = useRef(typeof window !== 'undefined' ? window.innerWidth : 390)
  // 0 → 1 a medida que el arrastre se acerca al umbral de commit — lo usa
  // la capa visual para desvanecer el scrim que "revela" la pantalla de atrás.
  const progress = useTransform(x, (v) => {
    const w = widthRef.current || 1
    return Math.max(0, Math.min(1, v / (w * COMMIT_DISTANCE_RATIO)))
  })

  useDrag(
    (state) => {
      const { first, last, movement, velocity, direction, event, cancel, memo } = state
      if (first) {
        widthRef.current = window.innerWidth
        const pointerEvent = event as PointerEvent
        const startClientX = typeof pointerEvent?.clientX === 'number' ? pointerEvent.clientX : state.xy[0]
        const isMouse = pointerEvent?.pointerType === 'mouse'
        if (!enabled || isMouse || startClientX > EDGE_ZONE_PX) {
          cancel()
          return memo
        }
        x.stop()
        return memo
      }

      if (!enabled) return memo

      const [mx] = movement
      const [vx] = velocity
      const [dx] = direction
      // Rubber-band si de algún modo mx da negativo (no debería, pero por
      // las dudas): no dejamos que la página se vaya para la izquierda.
      const clamped = Math.max(0, mx)
      x.set(clamped)

      if (last) {
        const distanceRatio = clamped / widthRef.current
        const shouldCommit = distanceRatio > COMMIT_DISTANCE_RATIO || (dx > 0 && vx > COMMIT_VELOCITY)
        if (shouldCommit) {
          void animate(x, widthRef.current, {
            type: 'tween',
            duration: 0.22,
            ease: [0.22, 1, 0.36, 1],
          }).then(onCommit)
        } else {
          void animate(x, 0, { type: 'spring', stiffness: 520, damping: 44 })
        }
      }
      return memo
    },
    {
      target: typeof window !== 'undefined' ? window : undefined,
      axis: 'x',
      filterTaps: true,
      pointer: { touch: true },
      eventOptions: { passive: false },
      enabled,
    },
  )

  return { x, progress }
}
