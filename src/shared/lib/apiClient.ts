// ============================================================
// Cliente del backend de cuentas (Postgres/Neon), servido desde el MISMO
// proyecto de Vercel a través de /api/push (ver el comentario grande en ese
// archivo: entra por ahí junto con las suscripciones push para no pasarse
// del tope de 12 Serverless Functions del plan Hobby). Reemplaza el acceso
// directo a IndexedDB — ver legacyLocalDB.ts para la versión vieja (solo
// usada por la migración) y db.ts para la capa que el resto de la app
// consume.
// ============================================================

const TOKEN_KEY = 'xfy_device_token'
// Email del último usuario logueado en este dispositivo — separado del
// token porque hace falta ANTES de que /auth/me responda: es lo que le
// permite a useAuthStore leer su snapshot local (ver localSnapshot.ts) y
// pintar algo real en el primer frame, en vez de esperar a la red para
// saber siquiera qué caché mirar.
const LAST_EMAIL_KEY = 'xfy_last_user_email'

// Identidad ESTABLE de este navegador/instalación — la usa useDeviceSync
// (dispositivos → sync en casi tiempo real vía Ably, ver
// realtimeTransport.ts) para armar el canal privado de este dispositivo.
// Se genera una sola vez y se persiste en localStorage: sobrevive a
// cerrar pestañas/reiniciar la PWA, pero es propia de ESTA instalación
// del navegador (no viaja con la cuenta a otro dispositivo, que es
// justamente el punto — cada uno necesita la suya para tener su propio
// canal privado).
const DEVICE_ID_KEY = 'xfy_client_device_id'

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY)
}

export function getLastUserEmail(): string | null {
  return localStorage.getItem(LAST_EMAIL_KEY)
}

export function setLastUserEmail(email: string | null): void {
  if (email) localStorage.setItem(LAST_EMAIL_KEY, email.toLowerCase())
  else localStorage.removeItem(LAST_EMAIL_KEY)
}

export function setToken(token: string, persist: boolean): void {
  const storage = persist ? localStorage : sessionStorage
  const other = persist ? sessionStorage : localStorage
  storage.setItem(TOKEN_KEY, token)
  other.removeItem(TOKEN_KEY)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
  sessionStorage.removeItem(TOKEN_KEY)
}

export interface ApiCallOptions {
  /** Si es true, no manda Authorization (solo lo usan auth.register / auth.login). */
  anonymous?: boolean
  /**
   * Si es true, un 401 limpia el token pero NO dispara 'xfy:session-expired'.
   * Solo lo usa restoreSession() para su propio auth.me inicial: ese flujo
   * ya sabe manejar un token inválido en el arranque en frío (sin sesión
   * previa que "se cerró" de verdad) sin mostrar el toast de "se cerró
   * esta sesión desde otro dispositivo", que ahí sería confuso/falso.
   */
  silentOn401?: boolean
}

/**
 * Llama a POST /api/push con { resource, op, ...payload }.
 * Devuelve el JSON de la respuesta tal cual (cada resource define su propio shape).
 * Nunca tira por errores de red/HTTP — devuelve { error } para que el caller decida
 * cómo degradar, salvo que se pase `throwOnError`.
 */
export async function callApi<T = Record<string, unknown>>(
  resource: string,
  op: string,
  payload: Record<string, unknown> = {},
  options: ApiCallOptions = {},
): Promise<T & { error?: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (!options.anonymous && token) headers.Authorization = `Bearer ${token}`

  // MEJORA: el backend de 'devices' (heartbeat/list/pollCommands/
  // realtimeToken/...) necesita saber CUÁL dispositivo está llamando para
  // poder identificarlo entre los de la cuenta — ningún call site de
  // useDeviceSync.ts/useDevicesStore.ts lo mandaba explícitamente. Se
  // inyecta acá, una sola vez, en vez de en cada callApi('devices', ...)
  // desperdigado — así ningún caller nuevo puede "olvidarse" de mandarlo.
  const body: Record<string, unknown> = { resource, op, ...payload }
  if (resource === 'devices' && body.deviceId == null) body.deviceId = getDeviceId()

  try {
    const response = await fetch('/api/push', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (response.status === 401) {
      // Token inválido/revocado (p.ej. se cerró sesión desde otro dispositivo) — limpiar y avisar.
      clearToken()
      if (!options.silentOn401) window.dispatchEvent(new CustomEvent('xfy:session-expired'))
      return { error: 'no autenticado' } as T & { error?: string }
    }
    return (await response.json()) as T & { error?: string }
  } catch (err) {
    console.error('[XFY] Error de red hablando con el backend:', err)
    return { error: 'red' } as T & { error?: string }
  }
}

