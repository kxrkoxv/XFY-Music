import { motion, useReducedMotion } from 'motion/react'
import './AppLoader.css'

/**
 * Branded splash/loading state. Replaces bare `<div style={{ height: '100dvh' }} />`
 * placeholders (auth session restore, Suspense fallback for lazy routes) so the app
 * never flashes an empty screen.
 *
 * Rediseño: en vez de un wordmark pulsando (el placeholder más genérico posible,
 * indistinguible de cualquier app), un disco girando + brazo que baja una vez +
 * un ecualizador de barras abajo — toma prestado del objeto real del que trata
 * la app (un tocadiscos) en vez de un logo abstracto. Un solo momento orquestado
 * (el brazo baja al entrar) en vez de efectos sueltos por todos lados.
 *
 * BUGFIX visual: en App.tsx este componente se montaba/desmontaba con un
 * simple `{condición && <AppLoader />}` — sin AnimatePresence ni exit, React
 * lo saca del DOM en el frame siguiente a que `status` cambia. Contra un
 * fondo casi negro eso se siente como un corte seco (el "flash" que
 * reportaban), no como una transición. Ahora la raíz es un motion.div con
 * su propio `exit`, así que en cuanto el padre lo envuelva en
 * AnimatePresence, la salida se anima (fade + un leve scale down) en vez
 * de cortar de golpe — y si el padre NO usa AnimatePresence, este exit
 * simplemente no corre y el comportamiento es idéntico al de antes.
 */
export default function AppLoader() {
  const reduceMotion = useReducedMotion()

  return (
    <motion.div
      className="app-loader"
      role="status"
      aria-label="Cargando"
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 1.02 }}
      transition={{ duration: 0.32, ease: [0.4, 0, 0.2, 1] }}
    >
      <div className="app-loader-deck">
        <motion.svg
          className="app-loader-disc"
          viewBox="0 0 120 120"
          animate={reduceMotion ? undefined : { rotate: 360 }}
          transition={reduceMotion ? undefined : { duration: 3.4, repeat: Infinity, ease: 'linear' }}
        >
          <circle cx="60" cy="60" r="58" className="app-loader-disc-rim" />
          <circle cx="60" cy="60" r="47" className="app-loader-disc-groove" />
          <circle cx="60" cy="60" r="38" className="app-loader-disc-groove" />
          <circle cx="60" cy="60" r="29" className="app-loader-disc-groove" />
          <circle cx="60" cy="60" r="16" className="app-loader-disc-label" />
          <circle cx="60" cy="60" r="2.5" className="app-loader-disc-spindle" />
        </motion.svg>
        <motion.span
          className="app-loader-arm"
          initial={{ rotate: -30 }}
          animate={{ rotate: -6 }}
          transition={{ duration: 0.85, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>
      <div className="app-loader-eq" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <motion.i
            key={i}
            animate={reduceMotion ? undefined : { scaleY: [0.3, 1, 0.45, 0.8, 0.3] }}
            transition={
              reduceMotion
                ? undefined
                : { duration: 1.1 + i * 0.08, repeat: Infinity, ease: 'easeInOut', delay: i * 0.09 }
            }
          />
        ))}
      </div>
      <span className="app-loader-word">xfy</span>
    </motion.div>
  )
}
