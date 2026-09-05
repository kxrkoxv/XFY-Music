import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { scrollIntoCenterView, DEFAULT_DURATION } from './scrollIntoView'

// Pausas largas y deliberadas, portadas de better-lyrics-glassy
// (observer.ts / scrollEventHandler): 25s con letra sincronizada, o solo
// 5s si la letra no tiene timing exacto (no vale la pena hacer esperar
// tanto por un timing aproximado). Reemplaza el cooldown corto de 750ms
// que usaba Spicy Lyrics real — ese reclama el control casi al instante,
// esto es más respetuoso con quien está leyendo a su ritmo.
const USER_SCROLL_PAUSE_SYNCED_MS = 25000
const USER_SCROLL_PAUSE_UNSYNCED_MS = 5000

// Margen extra tras un scroll programático antes de volver a escuchar
// eventos 'scroll' reales. better-lyrics-glassy usa un contador de eventos
// discretos (skipScrolls) porque BL mueve el scroll en pasos puntuales;
// acá el scroll programático anima scrollTop en rAF continuo durante
// DEFAULT_DURATION, así que una ventana de tiempo cumple el mismo rol.
const PROGRAMMATIC_SCROLL_GRACE_MS = 120

/**
 * Auto-scroll de letras estilo Spicy Lyrics + GlassyFlow: centra la línea
 * activa a medida que avanza la canción, pero:
 *  - si el usuario scrollea manualmente (rueda, touch, scrollbar, teclado —
 *    se escucha el evento nativo 'scroll', no solo wheel/touchmove, igual
 *    que better-lyrics-glassy), pausa el auto-scroll por un rato largo y
 *    deliberado en vez de retomar el control casi al instante;
 *  - mientras está pausado, muestra un botón flotante "Reanudar auto-scroll"
 *    (ver LyricsPanel.jsx) que retoma antes de que se cumpla el timeout;
 *  - al cambiar de canción, o ante un seek/salto brusco, centra al toque
 *    (sin animación) en vez de recorrer todas las líneas de por medio;
 *  - de ahí en más, cada cambio de línea activa centra con una animación
 *    suave (ver scrollIntoView.js).
 *
 * Mientras el auto-scroll está pausado por scroll manual, el contenedor
 * recibe la clase `.lyrics-user-scrolling` (ver spicyLyrics.css) para
 * no mantener el blur/dim de foco sobre líneas que el usuario está leyendo
 * a propósito — el mismo rol que cumplía `.HideLineBlur` en Spicy Lyrics.
 */

interface UseLyricsAutoScrollParams {
  /** contenedor scrolleable */
  containerRef: RefObject<HTMLElement>
  /** refs por índice de línea */
  lineRefs: RefObject<Record<number, HTMLElement>>
  /** índice de la línea activa actual (-1 si ninguna aún) */
  activeIndex: number
  /** cambia cuando cambia de canción (ej. song.id) */
  resetKey: unknown
  /** se incrementa ante un seek/salto brusco de posición */
  forceSignal: number
  /** si la letra tiene timing exacto (afecta cuánto dura la pausa) */
  isSynced?: boolean
}

export function useLyricsAutoScroll({
  containerRef,
  lineRefs,
  activeIndex,
  resetKey,
  forceSignal,
  isSynced = true,
}: UseLyricsAutoScrollParams): { showResumeButton: boolean; resumeAutoScroll: () => void } {
  const isUserScrollingRef = useRef(false)
  const resumeTimeoutRef = useRef<number | undefined>(undefined)
  const programmaticRef = useRef(false)
  const programmaticTimeoutRef = useRef<number | undefined>(undefined)
  const lastScrolledIndexRef = useRef(-2)
  // Arranca en true: la primera línea de una canción recién cargada se
  // centra directo, sin animar desde scrollTop 0.
  const forceNextScrollRef = useRef(true)
  const [showResumeButton, setShowResumeButton] = useState(false)

  const clearUserScrollState = useCallback((container?: HTMLElement | null): void => {
    isUserScrollingRef.current = false
    clearTimeout(resumeTimeoutRef.current)
    resumeTimeoutRef.current = undefined
    container?.classList.remove('lyrics-user-scrolling')
    setShowResumeButton(false)
  }, [])

  // Marca que el próximo(s) evento(s) 'scroll' viene de NUESTRA animación,
  // no del usuario — evita que el propio auto-scroll se pause a sí mismo.
  const markProgrammaticScroll = useCallback((durationMs: number): void => {
    programmaticRef.current = true
    clearTimeout(programmaticTimeoutRef.current)
    programmaticTimeoutRef.current = window.setTimeout(() => {
      programmaticRef.current = false
    }, durationMs + PROGRAMMATIC_SCROLL_GRACE_MS)
  }, [])

  // Detecta scroll manual real del usuario y pausa el auto-scroll.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleScroll = () => {
      if (programmaticRef.current) return
      isUserScrollingRef.current = true
      container.classList.add('lyrics-user-scrolling')
      setShowResumeButton(true)
      clearTimeout(resumeTimeoutRef.current)
      const pauseDuration = isSynced ? USER_SCROLL_PAUSE_SYNCED_MS : USER_SCROLL_PAUSE_UNSYNCED_MS
      resumeTimeoutRef.current = window.setTimeout(() => {
        isUserScrollingRef.current = false
        container.classList.remove('lyrics-user-scrolling')
        setShowResumeButton(false)
      }, pauseDuration)
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', handleScroll)
      clearTimeout(resumeTimeoutRef.current)
      clearTimeout(programmaticTimeoutRef.current)
    }
  }, [containerRef, isSynced])
  // Cambio de canción: forzar el próximo scroll (instantáneo) e ignorar
  // cualquier pausa manual que haya quedado de la canción anterior.
  useEffect(() => {
    forceNextScrollRef.current = true
    lastScrolledIndexRef.current = -2
    clearUserScrollState(containerRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  // Seek / salto brusco de posición (detectado afuera, en LyricsPanel):
  // igual que arriba, cancela cualquier pausa y fuerza el próximo scroll.
  useEffect(() => {
    forceNextScrollRef.current = true
    clearUserScrollState(containerRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceSignal])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const targetIndex = activeIndex === -1 ? 0 : activeIndex
    const el = lineRefs.current[targetIndex]
    if (!el) return

    const isForced = forceNextScrollRef.current
    if (targetIndex === lastScrolledIndexRef.current && !isForced) return

    if (isForced) {
      clearUserScrollState(container)
      markProgrammaticScroll(0)
      scrollIntoCenterView(container, el, { instant: true })
      lastScrolledIndexRef.current = targetIndex
      forceNextScrollRef.current = false
      return
    }

    // El usuario está leyendo a su ritmo — no le peleamos el scroll hasta
    // que termine la pausa (o toque "Reanudar").
    if (isUserScrollingRef.current) return

    markProgrammaticScroll(DEFAULT_DURATION)
    scrollIntoCenterView(container, el, { instant: false })
    lastScrolledIndexRef.current = targetIndex
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, containerRef, lineRefs, markProgrammaticScroll])

  // Botón "Reanudar auto-scroll": corta la pausa y retoma ya mismo.
  //
  // OJO: acá NO alcanza con poner forceNextScrollRef.current = true y
  // esperar a que el useEffect de arriba se vuelva a ejecutar — mutar una
  // ref no dispara un re-render ni re-corre un efecto. Con eso solo, el
  // botón se quedaba sin efecto visible hasta que activeIndex cambiara por
  // sí solo (la línea siguiente se activara), que podía tardar varios
  // segundos si tocabas "Reanudar" a mitad de una línea larga. Por eso acá
  // se centra la línea activa YA, de forma imperativa, en vez de delegarlo
  // al efecto.
  const resumeAutoScroll = useCallback(() => {
    const container = containerRef.current
    clearUserScrollState(container)
    forceNextScrollRef.current = false

    const targetIndex = activeIndex === -1 ? 0 : activeIndex
    const el = container ? lineRefs.current[targetIndex] : null
    if (container && el) {
      markProgrammaticScroll(0)
      scrollIntoCenterView(container, el, { instant: true })
      lastScrolledIndexRef.current = targetIndex
    } else {
      // Sin contenedor/elemento todavía montado: al menos que el próximo
      // render del efecto de arriba lo centre apenas pueda.
      forceNextScrollRef.current = true
    }
  }, [containerRef, lineRefs, activeIndex, clearUserScrollState, markProgrammaticScroll])

  return { showResumeButton, resumeAutoScroll }
}
