import type { ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import useTilt3D from '@shared/lib/useTilt3D'
import useCanHover from '@shared/lib/useCanHover'
import './Tilt3D.css'

interface Tilt3DProps {
  children: ReactNode
  className?: string
  max?: number
  lift?: number
}

/**
 * Envoltorio "haz que esta carátula sea 3D": pensado para portadas
 * estáticas (sin MotionArt) en carruseles y grillas — las que sí tienen
 * video ya se sienten vivas por su cuenta. Solo se activa con mouse real
 * (useCanHover) y respeta reduced-motion; en touch queda 100% estático,
 * cero listeners de más.
 */
export default function Tilt3D({ children, className = '', max, lift }: Tilt3DProps) {
  const canHover = useCanHover()
  const reduceMotion = useReducedMotion()
  const disabled = !canHover || !!reduceMotion
  const tilt = useTilt3D({ max, lift, disabled })

  if (disabled) {
    return <div className={`tilt3d tilt3d--static ${className}`}>{children}</div>
  }

  return (
    <motion.div
      ref={tilt.setNode as never}
      className={`tilt3d ${className}`}
      style={tilt.style}
      onPointerMove={tilt.onPointerMove}
      onPointerLeave={tilt.onPointerLeave}
    >
      {children}
      <motion.span className="tilt3d-glare" style={tilt.glareStyle} aria-hidden="true" />
    </motion.div>
  )
}
