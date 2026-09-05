// ============================================================
// Notificaciones del sistema — la mitad que le faltaba al stack.
//
// El permiso ya se pedía con soft-ask (useNotificationPermission) y el
// service worker tenía los handlers 'push'/'notificationclick' listos,
// pero NADA mostraba notificaciones nunca: el copy de la tarjeta
// prometía "enterate de lanzamientos nuevos" y no existía el emisor.
// Este módulo es ese emisor, para los dos caminos que NO necesitan
// backend de push:
//
//   1. Eventos locales mientras la app está EN SEGUNDO PLANO (el audio
//      quedó listo para background, etc.) — notifyWhenHidden().
//   2. Novedades detectadas por el propio cliente (nuevo álbum/canción
//      de los artistas más escuchados, ver releaseWatch.ts).
//
// Por qué registration.showNotification y no new Notification(): la
// versión del SW hace que iOS/Android la asocien a XFY en la lista del
// sistema (con badge e ícono correctos) Y que el tap pase por nuestro
// handler 'notificationclick', que enfoca la pestaña existente. El
// fallback a `new Notification` cubre entornos sin SW (dev).
// ============================================================

const ICON = '/icons/icon-192.png'

export interface AppNotificationPayload {
  title: string
  body: string
  /** Agrupa reemplazando la anterior con el mismo tag (ej. un aviso por artista). */
  tag?: string
  /** Destino al tocar la notificación (default '/'). */
  url?: string
  /**
   * Portada/avatar grande (álbum, artista, canción). Si no hay, cae al ícono
   * de la app. El ícono de la app SIEMPRE va aparte como `badge` — así queda
   * el mismo layout que WhatsApp: avatar grande + badge chico de la app
   * superpuesto (Android lo pinta como círculo con el color de acento; iOS
   * usa el ícono de la app y no soporta el layout tipo "contacto").
   */
  image?: string
}

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (!notificationsSupported()) return 'unsupported'
  return Notification.permission
}

/** ¿Hay permiso concedido? Los emisores deben chequear esto antes que nada. */
export function canNotify(): boolean {
  return notificationsSupported() && Notification.permission === 'granted'
}

/**
 * Pide permiso si está pendiente. Llamar SOLO desde un gesto del usuario
 * (click de toggle/botón): dispararlo solo es exactamente lo que quema el
 * permiso para siempre — para eso existe el soft-ask.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

function isAppHidden(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'visible'
}

async function showViaSwOrFallback(payload: AppNotificationPayload): Promise<void> {
  // `icon` = avatar grande (portada si hay, si no el ícono de XFY).
  // `badge` = SIEMPRE el ícono de XFY: es el que Android superpone chico
  // sobre el avatar (y el que usa en la barra de estado), igual que el
  // badge verde de WhatsApp sobre la foto de perfil.
  const options: NotificationOptions & { data?: { url: string } } = {
    body: payload.body,
    tag: payload.tag,
    icon: payload.image || ICON,
    badge: ICON,
    data: { url: payload.url || '/' },
  }

  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration()
      if (reg) {
        await reg.showNotification(payload.title, options)
        return
      }
    }
  } catch {
    /* cae al fallback */
  }
  try {
    const n = new Notification(payload.title, { body: payload.body, tag: payload.tag, icon: payload.image || ICON })
    n.onclick = () => {
      window.focus()
      n.close()
    }
  } catch {
    /* Android Chrome sin SW no permite new Notification: silencio */
  }
}

interface NotifyOptions {
  /**
   * true = solo cuando la app está oculta (eventos "por si acaso": si el
   * usuario te está mirando, el toast in-app ya cubre el aviso y una
   * notificación del sistema encima es ruido). false = mostrar siempre.
   */
  onlyWhenHidden?: boolean
}

/**
 * Emite una notificación del sistema si corresponde. Devuelve true si la
 * mostró — el caller puede usarlo para decidir si además manda toast.
 */
export async function showAppNotification(
  payload: AppNotificationPayload,
  { onlyWhenHidden = false }: NotifyOptions = {},
): Promise<boolean> {
  if (!canNotify()) return false
  if (onlyWhenHidden && !isAppHidden()) return false
  await showViaSwOrFallback(payload)
  return true
}
