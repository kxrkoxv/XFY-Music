import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { getStreak, getListenedTodayMs, formatMinutes } from '@shared/lib/metrics'
import { Flame, Clock3, Sun, SunDim, Moon, MoonStar } from 'lucide-react'

// @animateicons/react es un monolito de ~830 kB SIN tree-shaking posible
// (todos los iconos viven en un solo módulo con un export map gigante).
// Acá se usan 4, así que el paquete entra por dynamic import después del
// primer render: el primer paint muestra el icono estático de lucide y
// unos ms después se swappea al animado. Estático en el bundle inicial,
// el barrel entero en un chunk diferido.
const STATIC_ICONS = { Sun, SunDim, Moon, MoonStar }

type HeroIconKey = keyof typeof STATIC_ICONS

function getGreeting(): { text: string; iconKey: HeroIconKey } {
  const h = new Date().getHours()
  if (h >= 5 && h < 12) return { text: 'Buenos días', iconKey: 'Sun' }
  if (h >= 12 && h < 18) return { text: 'Buenas tardes', iconKey: 'SunDim' }
  if (h >= 18 && h < 22) return { text: 'Buenas noches', iconKey: 'Moon' }
  return { text: 'Buenas noches', iconKey: 'MoonStar' }
}

interface HeroGreetingProps {
  userName?: string
}

export default function HeroGreeting({ userName }: HeroGreetingProps) {
  const reduceMotion = useReducedMotion()
  const [animated, setAnimated] = useState<typeof import('@animateicons/react/lucide') | null>(null)

  useEffect(() => {
    let active = true
    import('@animateicons/react/lucide')
      .then((m) => { if (active) setAnimated(m) })
      .catch(() => {})
    return () => { active = false }
  }, [])

  const { text, iconKey } = getGreeting()
  const Icon = animated?.[iconKey] || STATIC_ICONS[iconKey]
  const streak = getStreak()
  const todayMs = getListenedTodayMs()
  const todayText = formatMinutes(todayMs)
  const name = userName?.split(' ')[0] || ''

  return (
    <motion.div
      className="hero-greeting"
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 28 }}
    >
      <div className="hero-greeting-top">
        {/* div, no p: el Icon de @animateicons renderiza un wrapper
            <motion.div>, y un div dentro de p es DOM inválido (React
            lo loguea como error y puede romper la hidratación). */}
        <div className="hero-greeting-text">
          <Icon size={28} className="hero-greeting-icon" /> {text}{name ? `, ${name}` : ''}
        </div>
        <div className="hero-greeting-stats">
          {streak > 1 && (
            <motion.span
              className="hero-stat"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: 'spring', stiffness: 400, damping: 26, delay: 0.15 }}
            >
              <Flame size={13} />
              {streak} días seguidos
            </motion.span>
          )}
          {todayMs > 0 && (
            <motion.span
              className="hero-stat"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: 'spring', stiffness: 400, damping: 26, delay: 0.22 }}
            >
              <Clock3 size={13} />
              {todayText} hoy
            </motion.span>
          )}
        </div>
      </div>
    </motion.div>
  )
}
