import { Home, LogOut, Compass, ListMusic, Settings, Mic2 } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { motion, useReducedMotion } from 'motion/react'
import { useAuthStore } from '@features/auth'
import './Sidebar.css'

/** Animated active indicator utilizing Framer Motion's layoutId for seamless transitions between navigation items. */
function ActiveBar() {
  const reduceMotion = useReducedMotion()
  return (
    <motion.span
      layoutId="sidebar-active-bar"
      className="sidebar-active-bar"
      transition={
        reduceMotion
          ? { type: false }
          : { type: 'spring', stiffness: 500, damping: 38 }
      }
    />
  )
}

export default function Sidebar() {
  const { currentUser, logout } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const isHome = location.pathname === '/'

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src="/icons/xfy-mark.png" alt="XFY" />
      </div>

      <nav className="sidebar-nav">
        <motion.button
          className={`sidebar-nav-item ${isHome ? 'active' : ''}`}
          onClick={() => navigate('/')}
          whileTap={{ scale: 0.97 }}
        >
          {isHome && <ActiveBar />}
          <Home size={19} />
          Inicio
        </motion.button>
        <motion.button
          className={`sidebar-nav-item ${location.pathname === '/discover' ? 'active' : ''}`}
          onClick={() => navigate('/discover')}
          whileTap={{ scale: 0.97 }}
        >
          {location.pathname === '/discover' && <ActiveBar />}
          <Compass size={19} />
          Descubre
        </motion.button>
        <motion.button
          className={`sidebar-nav-item ${location.pathname.startsWith('/artist') ? 'active' : ''}`}
          onClick={() => navigate('/artists')}
          whileTap={{ scale: 0.97 }}
        >
          {location.pathname.startsWith('/artist') && <ActiveBar />}
          <Mic2 size={19} />
          Artistas
        </motion.button>
        <motion.button
          className={`sidebar-nav-item ${location.pathname.startsWith('/playlist') ? 'active' : ''}`}
          onClick={() => navigate('/playlists')}
          whileTap={{ scale: 0.97 }}
        >
          {location.pathname.startsWith('/playlist') && <ActiveBar />}
          <ListMusic size={19} />
          Playlists
        </motion.button>
      </nav>

      <div className="sidebar-footer">
        <motion.button
          className={`sidebar-nav-item sidebar-settings ${location.pathname === '/settings' ? 'active' : ''}`}
          onClick={() => navigate('/settings')}
          whileTap={{ scale: 0.97 }}
        >
          {location.pathname === '/settings' && <ActiveBar />}
          <Settings size={19} />
          Configuración
        </motion.button>
        <div className="sidebar-footer-row">
          <button className="sidebar-user" onClick={() => navigate('/settings')}>
            <img src={currentUser?.avatarUrl || 'https://placehold.co/32x32/8b5cf6/ffffff?text=U'} alt="" />
            <span>{currentUser?.nickname}</span>
          </button>
          <motion.button
            className="sidebar-logout"
            aria-label="Cerrar sesión"
            onClick={logout}
            whileTap={{ scale: 0.88 }}
          >
            <LogOut size={17} />
          </motion.button>
        </div>
      </div>
    </aside>
  )
}
