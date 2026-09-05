import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion, animate, useMotionValue, useReducedMotion } from 'motion/react'
import { SkipForward, Heart } from 'lucide-react'
import { MorphIcon } from 'morphicons/react'
// morphicons consumes icon *data* (IconNode), not lucide-react's rendered components.
import { Play, Pause } from 'lucide'
import { usePlayerStore } from '@features/player/store/usePlayerStore'
import { useAuthStore, isSongFavorite } from '@features/auth'
import CachedImg from '@shared/components/CachedImg'
import { EASE_BACK, EASE_OUT } from '@shared/lib/motionTokens'
import './MiniPlayerBar.css'

// Umbrales del gesto (px y px/s): un flick corto vale más que un arrastre
// largo — misma idea que el dismiss por velocidad de iOS.
const DISMISS_OFFSET = 52
const DISMISS_VELOCITY = 380
const SWIPE_OFFSET = 60
const SWIPE_VELOCITY = 450
const AXIS_LOCK = 8 // px recorridos antes de decidir el eje dominante

export default function MiniPlayerBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const reduceMotion = useReducedMotion()
  // MEJORA de performance: antes esto era `const { queue, currentIndex,
  // isPlaying, currentTime, duration, toggle, next, previous } =
  // usePlayerStore()` — sin selector, zustand devuelve el store COMPLETO,
  // así que el componente se re-renderiza ante CUALQUIER cambio de estado
  // del reproductor (volumen, shuffle, buffering, reintentos de autoplay,
  // fallback de fuente, etc.), no solo los campos que realmente usa. Como
  // MiniPlayerBar está montado en casi todas las páginas de la app, eso es
  // un re-render de más — con toda su lógica de gestos (pointer events,
  // motion values) — por cada cambio de estado del reproductor, venga o no
  // al caso. Selectores por campo hacen que solo se re-renderice cuando
  // ESTOS campos puntuales cambian.
  const queue = usePlayerStore((s) => s.queue)
  const currentIndex = usePlayerStore((s) => s.currentIndex)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const duration = usePlayerStore((s) => s.duration)
  const toggle = usePlayerStore((s) => s.toggle)
  const next = usePlayerStore((s) => s.next)
  const previous = usePlayerStore((s) => s.previous)
  const { currentUser, toggleFavorite } = useAuthStore()
  const song = queue[currentIndex]

  // Gestos con Pointer Events nativos (window listeners + motion values),
  // NO el drag de motion: mismo motivo que la tab bar — el drag de la
  // librería depende de heurísticas que en motores móiles se tragan el
  // gesto. Con events propios el comportamiento es idéntico en todo.
  //
  // Mapa: vertical con energía = despedir (vuela y desaparece, vuelve con
  // la próxima canción); horizontal = cambiar de pista (sale por donde
  // empujás, entra la nueva desde el lado opuesto); sin intención = spring
  // de vuelta; tap limpio = abrir el player.
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const opacity = useMotionValue(1)
  const [grabbing, setGrabbing] = useState(false)
  const [dismissedFor, setDismissedFor] = useState<string | number | null | undefined>(null)
  const draggedRef = useRef(false)
  const busyRef = useRef(false)
  const detachRef = useRef<(() => void) | null>(null)

  const show = !!song && !!currentUser && location.pathname !== '/player' && location.pathname !== '/login'
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0
  const isFavorite = song && isSongFavorite(currentUser, song.id)

  const dismiss = (dir: number) => {
    // dir: -1 = vuela hacia arriba, 1 = hacia abajo. La barra reaparece
    // con la próxima canción (dismissedFor se compara contra song.id).
    if (!song) return
    const finish = () => {
      x.jump(0)
      y.jump(0)
      opacity.set(1)
      setDismissedFor(song.id)
    }
    if (reduceMotion) {
      finish()
      return
    }
    busyRef.current = true
    animate(y, dir * -190, { duration: 0.26, ease: EASE_OUT })
    animate(opacity, 0, { duration: 0.24, ease: 'easeOut', onComplete: finish })
  }

  const swapTrack = (dir: number) => {
    // dir 1 = swipe a la derecha → siguiente; -1 → anterior.
    const finish = () => {
      if (dir > 0) next()
      else previous()
      x.jump(-dir * 72)
      if (reduceMotion) {
        x.jump(0)
        opacity.set(1)
        busyRef.current = false
        return
      }
      animate(x, 0, { type: 'spring', stiffness: 380, damping: 30 })
      animate(opacity, 1, { duration: 0.2, ease: 'easeOut', onComplete: () => { busyRef.current = false } })
    }
    if (reduceMotion) {
      finish()
      return
    }
    busyRef.current = true
    animate(x, dir * 96, { duration: 0.15, ease: EASE_OUT })
    animate(opacity, 0, { duration: 0.15, ease: 'easeOut', onComplete: finish })
  }

  const springBack = () => {
    if (reduceMotion) {
      x.jump(0)
      y.jump(0)
      return
    }
    animate(x, 0, { type: 'spring', stiffness: 420, damping: 32 })
    animate(y, 0, { type: 'spring', stiffness: 420, damping: 32 })
  }

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (busyRef.current) return
    const pointerId = e.pointerId
    const start = { px: e.clientX, py: e.clientY }
    let last = { px: e.clientX, py: e.clientY, t: performance.now(), vx: 0, vy: 0 }
    let axis: 'x' | 'y' | null = null // se decide con el primer tramo firme
    draggedRef.current = false
    x.stop()
    y.stop()
    opacity.stop()
    setGrabbing(true)

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      const now = performance.now()
      const dt = Math.max(1, now - last.t)
      const vx = 0.8 * (((ev.clientX - last.px) / dt) * 1000) + 0.2 * last.vx
      const vy = 0.8 * (((ev.clientY - last.py) / dt) * 1000) + 0.2 * last.vy
      const ox = ev.clientX - start.px
      const oy = ev.clientY - start.py
      last = { px: ev.clientX, py: ev.clientY, t: now, vx, vy }
      if (!axis) {
        if (Math.abs(ox) < AXIS_LOCK && Math.abs(oy) < AXIS_LOCK) return
        // Direction lock: el eje dominante del primer tramo manda — sin
        // esto, una diagonal al empezar decidía el gesto equivocado.
        axis = Math.abs(ox) > Math.abs(oy) ? 'x' : 'y'
        draggedRef.current = true
      }
      if (axis === 'x') x.set(ox)
      else y.set(oy)
    }

    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      detach()
      setGrabbing(false)
      if (!draggedRef.current) return // tap limpio → onClick abre el player
      const ox = last.px - start.px
      const oy = last.py - start.py
      if (axis === 'y') {
        if (oy < -DISMISS_OFFSET || last.vy < -DISMISS_VELOCITY) return dismiss(-1)
        if (oy > DISMISS_OFFSET || last.vy > DISMISS_VELOCITY) return dismiss(1)
      }
      if (axis === 'x') {
        if (ox > SWIPE_OFFSET || last.vx > SWIPE_VELOCITY) return swapTrack(1)
        if (ox < -SWIPE_OFFSET || last.vx < -SWIPE_VELOCITY) return swapTrack(-1)
      }
      springBack()
    }

    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      detach()
      setGrabbing(false)
      springBack()
    }

    const detach = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('touchmove', onTouchMove)
      detachRef.current = null
    }
    detachRef.current = detach
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onCancel)
    // Mismo cinturón que la tab bar: Chrome Android dispara pointercancel
    // ante el primer movimiento aunque haya touch-action: none, y los
    // touch listeners en window son passive por default. Este touchmove
    // no-passivo se lo queda para la partida.
    const onTouchMove = (ev: TouchEvent) => {
      ev.preventDefault()
    }
    window.addEventListener('touchmove', onTouchMove, { passive: false })
  }

  // Limpieza si el componente se desmonta a mitad de gesto (ej. navegar).
  useEffect(() => () => detachRef.current?.(), [])

  const handleTap = () => {
    // Un drag real no debe disparar la navegación del click (con mouse el
    // click sí se dispara tras soltar). draggedRef lo marca.
    if (draggedRef.current) {
      draggedRef.current = false
      return
    }
    navigate('/player')
  }

  const hidden = dismissedFor !== null && dismissedFor === song?.id

  return (
    <AnimatePresence>
      {show && !hidden && (
        <motion.div
          className="mini-player-bar"
          data-grabbing={grabbing || undefined}
          // Reduced-motion: fade puro, sin el slide desde abajo.
          initial={reduceMotion ? { opacity: 0 } : { transform: 'translateY(80px)' }}
          animate={reduceMotion ? { opacity: 1 } : { transform: 'translateY(0px)' }}
          exit={reduceMotion ? { opacity: 0 } : { transform: 'translateY(80px)' }}
          transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
          style={{ x, y, opacity }}
          onPointerDown={onPointerDown}
          onClick={handleTap}
          role="button"
          tabIndex={0}
          aria-label={`Reproduciendo ${song.title} de ${song.artist}. Tocá para abrir el reproductor, deslizá arriba para ocultar, los lados para cambiar de pista.`}
        >
          <div
            className="mini-player-progress"
            style={{ transform: `scaleX(${progress / 100})` }}
          />
          <CachedImg className="mini-player-art" song={song} alt="" />
          <div className="mini-player-info">
            <p className="mini-player-title">{song.title}</p>
            <p className="mini-player-artist">{song.artist}</p>
          </div>
          <div className="mini-player-actions" onClick={(e) => e.stopPropagation()}>
            <motion.button
              className="mini-player-icon-btn"
              aria-label={isFavorite ? 'Quitar de favoritas' : 'Añadir a favoritas'}
              onClick={() => toggleFavorite(song)}
              whileTap={{ scale: 0.82 }}
            >
              <motion.span
                className="mini-player-heart"
                animate={isFavorite && !reduceMotion ? { scale: [0.7, 1.15, 1] } : { scale: 1 }}
                transition={{ duration: 0.32, ease: EASE_BACK }}
              >
                <Heart size={18} fill={isFavorite ? 'var(--accent-strong)' : 'none'} color={isFavorite ? 'var(--accent-strong)' : 'currentColor'} />
              </motion.span>
            </motion.button>
            <motion.button
              className="mini-player-icon-btn primary"
              aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
              onClick={toggle}
              whileTap={{ scale: 0.86 }}
            >
              <MorphIcon icon={isPlaying ? Pause : Play} size={18} spring="snappy" reducedMotion="user" />
            </motion.button>
            <motion.button className="mini-player-icon-btn" aria-label="Siguiente" onClick={next} whileTap={{ scale: 0.82 }}>
              <SkipForward size={18} />
            </motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
