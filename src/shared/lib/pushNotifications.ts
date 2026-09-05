// Web Push — mitad cliente del sistema de notificaciones "con la app
// cerrada". La otra mitad vive en api/push/* (suscripciones en Vercel Blob
// + cron diario que consulta iTunes por los artistas vigilados de cada
// dispositivo y les manda el push).
//
// Flujo:
//   1. El usuario ya concedió permiso de notificaciones (prompt propio de
//      la app). Sin eso, push no tiene sentido: TODO push debe mostrar una
//      notificación visible (userVisibleOnly).
//   2. PwaRegistration llama ensurePushSubscription() → PushManager.
//      subscribe con la clave VAPID pública (VITE_VAPID_PUBLIC_KEY) → la
//      suscripción viaja a /api/push (op: 'subscribe') junto con un token
//      anónimo por dispositivo (localStorage).
//   3. Después de cada barrida de releaseWatch, syncPushWatchState()
//      sube los artistas vigilados + snapshots al server — es lo que el
//      cron lee para chequear lanzamientos cuando NADIE tiene la app abierta.
//
// Notas de plataforma:
//  - iOS/iPadOS 16.4+: push SOLO funciona con la PWA instalada (standalone)
//    — se gatea acá mismo para no pedir cosas que no van a llegar.
//  - Firefox no soporta PushManager en iOS y en desktop anda; donde no hay
//    soporte todo esto es un no-op silencioso.

const TOKEN_KEY = 'xfy:push:token'
const SYNCED_AT_KEY = 'xfy:push:state-synced-at'
/** Re-sincronizar estado al server como mucho cada 12 h. */
const STATE_SYNC_GAP_MS = 12 * 60 * 60 * 1000

export interface WatchedArtistPayload {
  key: string
  name: string
  lastAlbumMs?: number
  lastSongMs?: number
}

function vapidPublicKey(): string | undefined {
  const key = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined
  return key && key.length > 0 ? key : undefined
}

/** Token anónimo por dispositivo: identifica el registro en el server sin cuentas. */
function deviceToken(): string {
  try {
    const existing = localStorage.getItem(TOKEN_KEY)
    if (existing) return existing
    const token =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`
    localStorage.setItem(TOKEN_KEY, token)
    return token
  } catch {
    return 'anonymous'
  }
}

function supportsPush(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof PushManager !== 'undefined' &&
    !!vapidPublicKey()
  )
}

/** iOS/iPadOS exige PWA instalada para push; en el resto, standalone no es requisito. */
function needsStandalone(): boolean {
  const ua = navigator.userAgent || ''
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document)
  if (!isIOS) return false
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // navigator.standalone es el flag legacy de Safari "agregada a inicio".
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  return !standalone
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  // ArrayBuffer explícito: el overload de applicationServerKey exige
  // BufferSource sobre ArrayBuffer (no ArrayBufferLike/Shared).
  const buffer = new ArrayBuffer(raw.length)
  const output = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

/**
 * Garantiza suscripción activa + registro en el server. Idempotente: si ya
 * hay suscripción con la MISMA clave VAPID, solo re-valida el registro.
 * Devuelve el resultado para logging/UI; nunca tira.
 */
export async function ensurePushSubscription(): Promise<string> {
  try {
    if (!supportsPush()) return 'unsupported'
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return 'no-permission'
    if (needsStandalone()) return 'not-installed'

    const registration = await navigator.serviceWorker.ready
    if (!registration.pushManager) return 'unsupported'

    const publicKey = vapidPublicKey()!
    let sub = await registration.pushManager.getSubscription()

    // Suscripción vieja con OTRA clave VAPID (rotación): se renueva.
    if (sub) {
      const currentKey = new Uint8Array(sub.options.applicationServerKey as ArrayBuffer)
      const expected = urlBase64ToUint8Array(publicKey)
      const same = currentKey.length === expected.length && currentKey.every((b, i) => b === expected[i])
      if (!same) {
        await sub.unsubscribe().catch(() => {})
        sub = null
      }
    }

    if (!sub) {
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })
    }

    const res = await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'subscribe', token: deviceToken(), subscription: sub.toJSON() }),
    })
    if (!res.ok) return 'error'
    return 'subscribed'
  } catch {
    return 'error'
  }
}

/**
 * Sube al server los artistas vigilados + snapshots de ESTE dispositivo
 * (payload de releaseWatch). El cron diario los consulta para detectar
 * lanzamientos con la app cerrada. Fire-and-forget con throttle de 12 h;
 * `force` lo pide el flujo de suscripción inicial.
 */
export async function syncPushWatchState(
  artists: WatchedArtistPayload[],
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  try {
    if (!supportsPush()) return
    try {
      const lastSynced = Number(localStorage.getItem(SYNCED_AT_KEY)) || 0
      if (!force && Date.now() - lastSynced < STATE_SYNC_GAP_MS) return
    } catch {
      /* throttle best-effort */
    }
    if (artists.length === 0) return

    const res = await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'state', token: deviceToken(), artists }),
    })
    if (res.ok) {
      try {
        localStorage.setItem(SYNCED_AT_KEY, String(Date.now()))
      } catch {
        /* noop */
      }
    }
  } catch {
    /* background sync: fallar callado */
  }
}

/** Baja la suscripción local + avisa al server que borre el registro. */
export async function disablePush(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration()
      const sub = await registration?.pushManager?.getSubscription?.()
      if (sub) await sub.unsubscribe().catch(() => {})
    }
    await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'unsubscribe', token: deviceToken() }),
    }).catch(() => {})
  } catch {
    /* noop */
  }
}
