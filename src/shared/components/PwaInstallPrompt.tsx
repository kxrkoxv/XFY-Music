import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Download, X } from 'lucide-react'

/** Evento beforeinstallprompt (no estándar, ausente de lib.dom). */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

interface PwaInstallPromptProps {
  onVisibilityChange: (visible: boolean) => void
}

export default function PwaInstallPrompt({ onVisibilityChange }: PwaInstallPromptProps) {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [visible, setVisible] = useState(false)
  const reduceMotion = useReducedMotion()

  // Avisa a App.jsx para que el <Toaster /> (misma lane top-center en
  // pantalla) baje su offset mientras esta tarjeta esté visible.
  useEffect(() => {
    onVisibilityChange?.(visible)
  }, [visible, onVisibilityChange])

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault()
      setDeferredPrompt(event as BeforeInstallPromptEvent)
      setVisible(true)
    }

    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const handleInstall = async () => {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    const choice = await deferredPrompt.userChoice
    if (choice.outcome === 'accepted') {
      setVisible(false)
    }
    setDeferredPrompt(null)
  }

  if (!visible) return null

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="pwa-install-card"
          role="dialog"
          aria-label="Instalar XFY"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -18, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -12, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 420, damping: 34 }}
        >
          <div>
            <p className="pwa-install-title">Instala XFY como app</p>
            <p className="pwa-install-copy">Disfruta de reproducción y navegación rápida, incluso sin conexión.</p>
          </div>
          <div className="pwa-install-actions">
            <motion.button className="pwa-install-btn" onClick={handleInstall} whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.94 }}>
              <Download size={16} />
              Instalar
            </motion.button>
            <motion.button
              className="pwa-install-close"
              aria-label="Cerrar aviso"
              onClick={() => setVisible(false)}
              whileTap={{ scale: 0.85 }}
            >
              <X size={16} />
            </motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
