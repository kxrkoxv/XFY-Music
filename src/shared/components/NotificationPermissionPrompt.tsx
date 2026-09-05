import { useEffect } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Bell, X } from 'lucide-react'
import { useNotificationPermission } from '@shared/lib/useNotificationPermission'
import './NotificationPermissionPrompt.css'

/**
 * Tarjeta de "soft-ask" para notificaciones — ver useNotificationPermission
 * para el porqué de pedir esto ANTES del prompt nativo del navegador.
 *
 * El look es intencionalmente el de una notificación real de iOS: ícono
 * en placa redondeada a la izquierda, título + copy a la derecha, todo
 * sobre el mismo material "vidrio líquido" grueso que la lente del tab
 * bar (ver MobileTabBar.css) — variante más "frosted" (blur y saturación
 * más altos, menos tinte de color) que es justo el material que Apple
 * usa en iOS 26 para el Centro de Notificaciones y el Lock Screen.
 */
interface NotificationPermissionPromptProps {
  stacked?: boolean
  onVisibilityChange: (visible: boolean) => void
}

export default function NotificationPermissionPrompt({
  stacked = false,
  onVisibilityChange,
}: NotificationPermissionPromptProps) {
  const { supported, visible, request, dismiss } = useNotificationPermission()
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    onVisibilityChange?.(supported && visible)
  }, [supported, visible, onVisibilityChange])

  if (!supported) return null

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className={`notif-prompt ${stacked ? 'notif-prompt--stacked' : ''}`}
          role="dialog"
          aria-label="Activar notificaciones"
          initial={reduceMotion ? false : { opacity: 0, y: -18, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -12, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 420, damping: 34 }}
        >
          <div className="notif-prompt-icon">
            <Bell size={19} strokeWidth={2.2} />
          </div>
          <div className="notif-prompt-body">
            <p className="notif-prompt-title">Activar notificaciones</p>
            <p className="notif-prompt-copy">
              Enterate cuando haya lanzamientos nuevos de tus artistas, sin tener XFY abierto.
            </p>
            <div className="notif-prompt-actions">
              <button className="notif-prompt-btn notif-prompt-btn--ghost" onClick={dismiss}>
                Ahora no
              </button>
              <button className="notif-prompt-btn notif-prompt-btn--accent" onClick={request}>
                Activar
              </button>
            </div>
          </div>
          <button className="notif-prompt-close" aria-label="Cerrar aviso" onClick={dismiss}>
            <X size={14} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
