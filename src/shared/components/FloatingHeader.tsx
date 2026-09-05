import { useLocation, useNavigate } from 'react-router-dom'
import { motion, useReducedMotion } from 'motion/react'
import { useAuthStore } from '@features/auth'
import { NAV_TABS, activeTabIndex } from '@shared/lib/navTabs'
import { useDraggableTabPill } from '@shared/lib/useDraggableTabPill'
import './FloatingHeader.css'

/** Desktop floating quick navigation dock. Syncs state with MobileTabBar using the draggable pill hook. */
export default function FloatingHeader() {
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

  // Only render when a user is authenticated, and exclude fullscreen pages (login/player).
  //
  // Mismo fix que MobileTabBar: antes hacía `if (!show) return null`, y el
  // <nav> (con el ref de useDraggableTabPill) no tocaba el DOM hasta el
  // login — para entonces el efecto que mide itemWidth ya había corrido
  // una vez, con trackRef.current en null, y nunca se repetía. El dock
  // ahora se monta siempre; show solo controla visibilidad por CSS
  // (.floating-header-dock--hidden).
  const show = !!currentUser && location.pathname !== '/login' && location.pathname !== '/player'

  return (
    /* El gesto vive en la barra entera — mismo patrón que MobileTabBar
       (useDraggableTabPill enganchado vía @use-gesture con target, sin
       handlers manuales acá). */
    <div className={`floating-header-dock${show ? '' : ' floating-header-dock--hidden'}`} aria-hidden={!show}>
      <motion.nav
        className="floating-header"
        ref={trackRef}
        aria-label="Navegación rápida"
        initial={reduceMotion ? false : { opacity: 0, y: -14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 340, damping: 30 }}
        onClickCapture={onClickCapture}
      >
        {itemWidth > 0 && (
          <motion.div
            className="floating-header-pill"
            style={{ width: itemWidth, x }}
            animate={{ scale: grabbing && !reduceMotion ? 1.06 : 1 }}
            transition={{ type: 'spring', stiffness: 400, damping: 26 }}
          />
        )}
        {NAV_TABS.map(({ path, label, icon: Icon, match }, i) => {
          const active = previewIndex !== null ? i === previewIndex : match(location.pathname)
          return (
            <button
              key={path}
              className={`floating-header-item ${active ? 'active' : ''}`}
              onClick={() => navigate(path)}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              title={label}
            >
              <Icon size={18} strokeWidth={active ? 2.4 : 2} />
            </button>
          )
        })}
      </motion.nav>
    </div>
  )
}
