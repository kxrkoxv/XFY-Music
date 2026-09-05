import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { usePlayerStore } from '@features/player'

const VOLUME_STEP = 0.05

function isTypingTarget(el: HTMLElement | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

// Atajos globales estilo YouTube/Spotify: barra espaciadora reproduce/pausa,
// flechas arriba/abajo suben o bajan volumen de a 5%, y Escape sale del
// reproductor a pantalla completa (vuelve al home). Se registra una sola
// vez a nivel de App, no por página, para que funcione sin importar dónde
// esté parado el usuario (igual que en YT/Spotify, no hace falta estar
// "dentro" del player).
export default function useMediaKeyboardShortcuts() {
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // No robar la tecla si el usuario está escribiendo en un input,
      // buscador, campo de playlist, etc.
      if (isTypingTarget(document.activeElement as HTMLElement | null)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const { toggle, volume, setVolume, queue, currentIndex } = usePlayerStore.getState()
      const hasSong = currentIndex !== -1 && queue.length > 0

      switch (e.key) {
        case ' ':
        case 'Spacebar': // Safari viejo
          if (!hasSong) return
          e.preventDefault() // evita que la barra espaciadora scrollee la página
          toggle()
          break

        case 'ArrowUp':
          if (!hasSong) return
          e.preventDefault()
          setVolume(Math.min(1, Math.round((volume + VOLUME_STEP) * 100) / 100))
          break

        case 'ArrowDown':
          if (!hasSong) return
          e.preventDefault()
          setVolume(Math.max(0, Math.round((volume - VOLUME_STEP) * 100) / 100))
          break

        case 'Escape':
          if (location.pathname === '/player') navigate('/')
          break

        default:
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [navigate, location.pathname])
}
