import { useRef } from 'react'
import { useMotionValue, useSpring, useTransform, type MotionValue } from 'motion/react'

interface Tilt3DOptions {
  /** Grados máximos de inclinación en cada eje. */
  max?: number
  /** Cuánto "sale" la carátula hacia la cámara al pasar el mouse (px de translateZ). */
  lift?: number
  /** Se apaga entero (sin listeners, transform fijo) — usado para touch / reduced-motion. */
  disabled?: boolean
}

export interface Tilt3DBind {
  setNode: (node: HTMLElement | null) => void
  style: {
    transform: MotionValue<string>
    transformStyle: 'preserve-3d'
  }
  glareStyle: {
    background: MotionValue<string>
  }
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
  onPointerLeave: () => void
}

/**
 * Tilt 3D estilo Apple Music/Spotify "now playing" card: la carátula gira
 * en perspectiva siguiendo el puntero y vuelve a plano con un spring al
 * salir. Pensado para portadas ESTÁTICAS (sin MotionArt) — les da algo de
 * la misma sensación "viva" que las que sí tienen video, sin pagar el
 * costo de un stream HLS. Cero dependencias nuevas: motion values +
 * transform, mismo patrón que ya usa MobileTabBar para su lente.
 */
export default function useTilt3D({ max = 14, lift = 22, disabled = false }: Tilt3DOptions = {}): Tilt3DBind {
  const elRef = useRef<HTMLElement | null>(null)
  const rotX = useMotionValue(0)
  const rotY = useMotionValue(0)
  const glareX = useMotionValue(50)
  const glareY = useMotionValue(50)

  const springX = useSpring(rotX, { stiffness: 300, damping: 24, mass: 0.6 })
  const springY = useSpring(rotY, { stiffness: 300, damping: 24, mass: 0.6 })
  const springLift = useSpring(0, { stiffness: 300, damping: 26 })

  const transform = useTransform([springX, springY, springLift], ([x, y, z]) => {
    if (disabled) return 'none'
    return `perspective(700px) rotateX(${x}deg) rotateY(${y}deg) translateZ(${z}px)`
  })

  const glareBackground = useTransform([glareX, glareY], ([gx, gy]) =>
    `radial-gradient(circle at ${gx}% ${gy}%, rgba(255,255,255,0.22), transparent 60%)`,
  )

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (disabled || e.pointerType !== 'mouse') return
    const el = elRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const px = (e.clientX - rect.left) / rect.width
    const py = (e.clientY - rect.top) / rect.height
    rotY.set((px - 0.5) * max * 2)
    rotX.set(-(py - 0.5) * max * 2)
    springLift.set(lift)
    glareX.set(px * 100)
    glareY.set(py * 100)
  }

  const onPointerLeave = () => {
    rotX.set(0)
    rotY.set(0)
    springLift.set(0)
  }

  return {
    setNode: (node) => {
      elRef.current = node
    },
    style: { transform, transformStyle: 'preserve-3d' },
    glareStyle: { background: glareBackground },
    onPointerMove,
    onPointerLeave,
  }
}
