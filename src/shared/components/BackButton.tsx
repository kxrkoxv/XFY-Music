import { motion, useReducedMotion } from 'motion/react'
import { ArrowLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { smartGoBack } from '@shared/lib/backStack'
import useCanHover from '@shared/lib/useCanHover'

interface BackButtonProps {
  /** Texto junto al ícono. "Volver" por defecto. */
  label?: string
  /** Adónde ir si no hay historial propio dentro de la app (deep link, atajo de PWA, notificación...). Home por defecto. */
  fallback?: string
  /** Destino fijo en vez de "atrás" — p. ej. un detalle de playlist siempre vuelve a /playlists, sin importar por dónde se entró. */
  to?: string
  className?: string
}

/**
 * Reemplaza los botones "Volver" que antes cada página reimplementaba a
 * mano con `onClick={() => navigate(-1)}`. Dos problemas que tenía eso:
 *
 *  1. `navigate(-1)` a secas rompe apenas se entra a la página por un
 *     link directo (deep link, atajo del ícono de la PWA, notificación) —
 *     no hay historial propio y el back terminaba saliendo de la app o
 *     sin hacer nada. Ver smartGoBack() en backStack.ts.
 *  2. Media docena de copias del mismo botón, con estilos y comportamiento
 *     ligeramente distintos según quién lo escribió. Este es el único.
 */
export default function BackButton({ label = 'Volver', fallback = '/', to, className = '' }: BackButtonProps) {
  const navigate = useNavigate()
  const reduceMotion = useReducedMotion()
  const canHover = useCanHover()

  const handleClick = () => {
    if (to) navigate(to)
    else smartGoBack(navigate, fallback)
  }

  return (
    <motion.button
      type="button"
      className={`page-back ${className}`.trim()}
      onClick={handleClick}
      whileHover={canHover ? { scale: 1.03 } : undefined}
      whileTap={reduceMotion ? undefined : { scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 500, damping: 32 }}
    >
      <ArrowLeft size={18} />
      <span>{label}</span>
    </motion.button>
  )
}
