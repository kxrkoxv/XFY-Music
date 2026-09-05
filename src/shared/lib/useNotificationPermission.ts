import { useCallback, useEffect, useState } from 'react'

const DISMISS_KEY = 'xfy:notif-prompt-dismissed-at'
// Si el usuario cierra la tarjeta con "Ahora no", no la volvemos a mostrar
// por un tiempo — insistir en cada sesión es exactamente el patrón que
// hace que la gente le tenga bronca a los permisos de notificación.
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000 // 7 días

function readSnooze(): number {
  const raw = Number(localStorage.getItem(DISMISS_KEY))
  return Number.isFinite(raw) ? raw : 0
}

/**
 * Maneja el ciclo de vida del permiso de notificaciones con un "soft-ask"
 * previo al prompt nativo del navegador.
 *
 * Por qué un soft-ask: el permiso nativo del browser solo se puede pedir
 * una vez de forma "limpia" — si el usuario lo rechaza (aunque sea porque
 * apareció de sorpresa sin contexto), la única forma de volver a
 * preguntarle es que ÉL MISMO vaya a la configuración del sitio en el
 * navegador. Nadie hace eso. Por eso primero mostramos NUESTRA tarjeta
 * (sin gastar el permiso real) explicando el porqué, y solo si el
 * usuario confirma ahí, disparamos Notification.requestPermission().
 */
export function useNotificationPermission() {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  )
  const [visible, setVisible] = useState(false)

  const supported = typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator

  useEffect(() => {
    if (!supported) return
    if (Notification.permission !== 'default') return
    if (Date.now() - readSnooze() < SNOOZE_MS) return
    // Pequeño delay: dejar que la app respire (login, primer render, el
    // aviso de instalar la PWA si corresponde) antes de sumar otra tarjeta
    // arriba de la pantalla — pedir todo de una es lo que hace que un
    // usuario nuevo cierre todo sin leer nada.
    const t = setTimeout(() => setVisible(true), 4000)
    return () => clearTimeout(t)
  }, [supported])

  const request = useCallback(async (): Promise<NotificationPermission | 'unsupported' | 'default'> => {
    if (!supported) return 'unsupported'
    try {
      const result = await Notification.requestPermission()
      setPermission(result)
      setVisible(false)
      return result
    } catch {
      setVisible(false)
      return 'default'
    }
  }, [supported])

  const dismiss = useCallback(() => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
    setVisible(false)
  }, [])

  return { supported, permission, visible, request, dismiss }
}
