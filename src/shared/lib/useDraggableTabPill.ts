import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDrag } from '@use-gesture/react'
import { animate, useMotionValue } from 'motion/react'

// Convierte una fila de tabs en un slider de verdad: además de poder
// tocar cada botón (como cualquier tab bar de toda la vida), se puede
// agarrar la píldora y arrastrarla — se mueve en vivo con el dedo/mouse,
// muestra en tiempo real qué sección quedaría activa, y al soltar hace
// snap a la más cercana y navega.
//
// IMPLEMENTACIÓN: @use-gesture/react (useDrag) en vez de Pointer Events a
// mano. Motivo del cambio: la versión casera con pointerdown/pointermove
// en window + preventDefault/setPointerCapture seguía sin agarrar el
// gesto en algunos navegadores/PWAs reales — @use-gesture es la misma
// familia de herramientas que usan Framework7/Swiper (los motores de
// touch más maduros del ecosistema web) y resuelve puertas adentro todos
// los detalles finos de touch-action, passive listeners y las
// peculiaridades de Safari/Chrome Android que veníamos parchando a mano.
// `target: trackRef` + `eventOptions: { passive: false }` es lo que le
// permite llamar preventDefault() con seguridad ni bien arranca el touch.
//
// Vive en un hook aparte (no adentro de MobileTabBar) porque FloatingHeader
// necesita el mismo gesto arriba, en escritorio, y no queríamos dos
// implementaciones del mismo drag desincronizándose con el tiempo.
export function useDraggableTabPill({
  activeIndex,
  tabCount,
  onSettle,
  reduceMotion,
}: {
  activeIndex: number
  tabCount: number
  onSettle: (idx: number) => void
  reduceMotion: boolean | null
}) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [itemWidth, setItemWidth] = useState(0)
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [grabbing, setGrabbing] = useState(false)
  const x = useMotionValue(0)
  const movedRef = useRef(false)

  // useLayoutEffect, no useEffect: mide ANTES de que el navegador pinte.
  // Con useEffect, el primer frame se pintaba con itemWidth=0 (píldora sin
  // renderizar, `itemWidth > 0 &&` en MobileTabBar.jsx) y recién en el
  // frame siguiente aparecía con su ancho real — ese salto es exactamente
  // el "brinco" que se nota cada vez que la barra se monta de cero (login
  // → home, o el remount completo que dispara un reload). Con
  // useLayoutEffect la medición corre en el mismo ciclo de commit, antes
  // del paint, así que el primer frame visible ya sale con el ancho
  // correcto.
  useLayoutEffect(() => {
    const el = trackRef.current
    if (!el || tabCount === 0) return undefined
    const measure = () => setItemWidth(el.getBoundingClientRect().width / tabCount)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [tabCount])

  // Sigue la ruta activa con un spring — salvo mientras el usuario tiene
  // la píldora agarrada, ahí manda el dedo, no la ruta. Sin guardes de
  // "último índice" a propósito: la lente tiene que quedar SIEMPRE de
  // acuerdo con la ruta (que es lo que pinta el violeta). Un guard acá
  // producía la desincronización del bug reportado: lente parada en una
  // tab, color activo en otra. React batchea navigate + grabbing en el
  // mismo render, así que no hay carrera que defender.
  useEffect(() => {
    if (grabbing || !itemWidth) return
    if (reduceMotion) {
      x.jump(activeIndex * itemWidth)
      return
    }
    animate(x, activeIndex * itemWidth, { type: 'spring', stiffness: 420, damping: 34 })
  }, [activeIndex, itemWidth, x, reduceMotion, grabbing])

  const nearestIndex = useCallback(
    (value: number) => {
      if (!itemWidth) return activeIndex
      return Math.min(tabCount - 1, Math.max(0, Math.round(value / itemWidth)))
    },
    [itemWidth, tabCount, activeIndex],
  )

  const settle = useCallback(
    (idx: number) => {
      if (reduceMotion) x.jump(idx * itemWidth)
      else animate(x, idx * itemWidth, { type: 'spring', stiffness: 480, damping: 32 })
      onSettle(idx)
    },
    [itemWidth, x, reduceMotion, onSettle],
  )

  // useDrag de @use-gesture le da manejo robusto — cross-browser, real
  // device — a exactamente lo que antes hacíamos a mano: origin al
  // agarrar, delta en vivo con rubber-band en los bordes, y velocidad
  // para permitir un flick rápido aunque el dedo no cruce la mitad de la
  // tab siguiente.
  const bind = useDrag(
    ({ movement: [mx], velocity: [vx], direction: [dx], first, last, tap, memo }) => {
      if (first) {
        movedRef.current = false
        setGrabbing(true)
        x.stop() // corta cualquier settle en curso: el dedo manda
        return x.get() // memo = origin, el x al momento de agarrar
      }
      const origin = memo ?? x.get()

      if (tap) {
        // Tap limpio sin movimiento: no tocamos x, dejamos que el click
        // normal del botón navegue (ver onClickCapture más abajo).
        if (last) setGrabbing(false)
        return origin
      }

      movedRef.current = true
      const raw = origin + mx
      const max = itemWidth * (tabCount - 1)
      // Rubber band en los bordes: la lente se estira un 15% del excedente,
      // mismo feel que iOS cuando empujás más allá del fin de la barra.
      const clamped = raw < 0 ? raw * 0.15 : raw > max ? max + (raw - max) * 0.15 : raw
      x.set(clamped)
      setPreviewIndex(nearestIndex(clamped))

      if (last) {
        setGrabbing(false)
        // Reset del preview: si queda stale, el color activo seguía
        // clavado en la tab del viejo drag aunque la ruta cambiara por
        // otra vía (atrás del PWA, deep link...) — lente y violeta
        // desincronizados, el bug de la captura. Desde acá el color lo
        // decide la ruta, igual que la posición de la lente.
        setPreviewIndex(null)
        if (!itemWidth) return origin
        let idx = nearestIndex(x.get())
        // Flick rápido (~110 px/s, mismo umbral que el dismiss del mini
        // player): avanza aunque el dedo no haya llegado a la mitad de la
        // tab siguiente. velocity de use-gesture ya viene en px/ms.
        if (Math.abs(vx) * 1000 > 110) {
          const projected = x.get() / itemWidth + (dx > 0 ? 1 : -1)
          idx = Math.min(tabCount - 1, Math.max(0, Math.round(projected)))
        }
        settle(idx)
      }

      return origin
    },
    {
      target: trackRef,
      axis: 'x',
      filterTaps: true,
      pointer: { touch: true },
      eventOptions: { passive: false },
    },
  )

  // Tras un drag real, el click que el mouse/touch dispara sobre el botón
  // donde se soltó no debe navegar (el settle ya navegó a la tab más
  // cercana). En un tap limpio dejamos pasar el click sin tocar nada.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (movedRef.current) {
      e.stopPropagation()
      movedRef.current = false
    }
  }, [])

  return {
    trackRef,
    x,
    itemWidth,
    previewIndex,
    grabbing,
    bind,
    onClickCapture,
  }
}
