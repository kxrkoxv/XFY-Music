import { useLocation, useNavigate } from 'react-router-dom'
import { motion, useReducedMotion, useSpring, useTransform } from 'motion/react'
import type { MotionValue } from 'motion/react'
import { useAuthStore } from '@features/auth'
import { NAV_TABS, activeTabIndex } from '@shared/lib/navTabs'
import { useDraggableTabPill } from '@shared/lib/useDraggableTabPill'
import type { LucideIcon } from 'lucide-react'
import './MobileTabBar.css'

/**
 * Una tab de la barra. Cuando la lente se arrastra, cada tab se magnifica
 * por PROXIMIDAD al centro de la lente (la "deformación de agua" del tab
 * bar de iOS 26: la tab bajo el dedo crece, las vecinas un poco, y vuelve
 * todo a su lugar al soltar). El scale sale de un useTransform del motion
 * value `x` de la lente — cero estado por frame, cero re-renders durante
 * el drag: motion recalcula el string de transform por su cuenta.
 *
 * El useSpring del medio hace dos trabajos: al SOLTAR, el target salta de
 * 1.3 a 1 y el spring lo lleva suave en vez de un snap seco; y durante el
 * drag mete una inercia mínima de seguimiento — el agua no sigue al dedo
 * con rigidez perfecta, va medio paso atrás.
 */
interface TabItemProps {
  label: string
  icon: LucideIcon
  index: number
  x: MotionValue<number>
  itemWidth: number
  grabbing: boolean
  reduceMotion: boolean | null
  active: boolean
  onClick: () => void
}

function TabItem({ label, icon: Icon, index, x, itemWidth, grabbing, reduceMotion, active, onClick }: TabItemProps) {
  // d=0 → bajo la lente (scale máximo); d=1 → una tab de distancia (scale 1).
  // Falloff cuadrático: la caída es suave cerca del centro y se apaga antes
  // de llegar a la vecina — el agua "sube" bajo el dedo, no en toda la barra.
  const target = useTransform(x, (v) => {
    if (!grabbing || reduceMotion || !itemWidth) return 1
    const d = Math.abs(v + itemWidth / 2 - (index + 0.5) * itemWidth) / itemWidth
    return 1 + 0.3 * Math.max(0, 1 - d) ** 2
  })
  const scale = useSpring(target, { stiffness: 520, damping: 32 })
  const transform = useTransform(scale, (s) => `scale(${s.toFixed(3)})`)

  return (
    <motion.button
      className={`mobile-tab-item ${active ? 'active' : ''}`}
      style={{ transform }}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
    >
      {/* El ícono activo se levanta con un springito — la confirmación
          física de "estás acá" que acompaña al color y a la lente. Al
          desactivarse vuelve con el mismo spring, así el cambio de tab
          se lee como una sola ola: lente viaja, color cambia, ícono
          sube. */}
      <motion.span
        className="mobile-tab-icon"
        animate={{
          scale: active ? 1.14 : 1,
          y: active ? -1.5 : 0,
        }}
        transition={{ type: 'spring', stiffness: 500, damping: active ? 20 : 28 }}
      >
        <Icon size={22} strokeWidth={active ? 2.4 : 2} />
      </motion.span>
      <span className="mobile-tab-label">{label}</span>
    </motion.button>
  )
}

/** Mobile navigation bar synced with the mini-player and draggable gesture pill. */
export default function MobileTabBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const currentUser = useAuthStore((s) => s.currentUser)
  const reduceMotion = useReducedMotion()

  const activeIndex = activeTabIndex(location.pathname)
  const { trackRef, x, itemWidth, previewIndex, grabbing, onClickCapture } = useDraggableTabPill({
    activeIndex,
    tabCount: NAV_TABS.length,
    reduceMotion,
    onSettle: (idx) => {
      const target = NAV_TABS[idx]?.path
      if (target && target !== location.pathname) navigate(target)
    },
  })

  // Hide on unauthenticated or immersive views (login, player).
  //
  // OJO: esto solía ser `if (!show) return null`, y ERA el bug de la
  // píldora invisible. MobileTabBar se monta en cuanto App.jsx sale de
  // loading/idle — no cuando hay currentUser — así que si arrancás en
  // /login el componente ya vive montado con show=false. El <nav> (y su
  // ref) nunca tocaba el DOM en ese primer mount, así que el efecto que
  // mide itemWidth en useDraggableTabPill corría con trackRef.current en
  // null. Esa medición depende de tabCount (fijo, nunca cambia), así que
  // no se repetía después al loguearte: itemWidth se quedaba en 0 para
  // siempre y `itemWidth > 0 &&` nunca pintaba la píldora. Por eso ahora
  // el <nav> se monta SIEMPRE (una sola vez, con el ref enganchado desde
  // el arranque) y show solo esconde por CSS — ver .mobile-tab-bar--hidden.
  const show = !!currentUser && location.pathname !== '/login' && location.pathname !== '/player'

  return (
    /* El gesto vive acá, en la barra entera (los botones tapan la lente):
       useDraggableTabPill engancha el listener nativo directo al DOM del
       ref (@use-gesture con target, ver el hook) — no hace falta pasarle
       ningún handler de pointer acá. Tap sin movimiento = click normal
       del botón; movimiento = arrastrás. */
    <nav
      className={`mobile-tab-bar${show ? '' : ' mobile-tab-bar--hidden'}`}
      ref={trackRef}
      aria-label="Navegación principal"
      aria-hidden={!show}
      onClickCapture={onClickCapture}
    >
      {itemWidth > 0 && (
        <motion.div
          className="mobile-tab-pill"
          style={{ width: itemWidth, x }}
          /* Magnify-on-grab (iOS 26): la lente crece apenas la agarrás y
             vuelve con spring al soltar. Es la señal de "esto es agarrable"
             antes incluso de mover el dedo. */
          animate={{ scale: grabbing && !reduceMotion ? 1.07 : 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 26 }}
        />
      )}
      {NAV_TABS.map(({ path, label, icon: Icon, match }, i) => {
        const active = previewIndex !== null ? i === previewIndex : match(location.pathname)
        return (
          <TabItem
            key={path}
            label={label}
            icon={Icon}
            index={i}
            x={x}
            itemWidth={itemWidth}
            grabbing={grabbing}
            reduceMotion={reduceMotion}
            active={active}
            onClick={() => navigate(path)}
          />
        )
      })}
    </nav>
  )
}
