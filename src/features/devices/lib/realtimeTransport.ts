// ============================================================
// Transporte realtime opcional para recibir comandos de otro dispositivo
// casi instantáneo (Ably) — capa fina y aislada a propósito, ver el
// comentario grande en useDeviceSync.ts para el panorama completo de por
// qué esto es un COMPLEMENTO del long-poll existente y no un reemplazo.
//
// Import dinámico de 'ably/modular' (no 'ably' a secas): el build por
// defecto pesa ~58kB gzip porque incluye fallbacks de transporte (XHR
// streaming/polling), MessagePack y logging verboso que acá no hacen
// falta — con WebSocket disponible (todo navegador moderno) y HTTP nativo
// para el auth callback, el build modular con solo WebSocketTransport +
// FetchRequest baja bastante ese peso. Dinámico además de modular: nadie
// paga ni ese bundle recortado hasta que el usuario efectivamente inicia
// sesión y useDeviceSync arranca — la pantalla de login nunca lo descarga.
// ============================================================

import { callApi } from '@shared/lib/apiClient'
import type Ably from 'ably'
import type { InboundMessage } from 'ably'

type RealtimeClient = InstanceType<typeof import('ably/modular').BaseRealtime>

let clientPromise: Promise<RealtimeClient | null> | null = null

/** Mismo formato que deviceChannelName() en api/_lib/realtime.ts — si
 *  alguna vez cambia ahí, tiene que cambiar acá también. */
function deviceChannelName(userId: string, deviceId: string): string {
  return `account:${userId}:device:${deviceId}`
}

/** TokenRequest firmado por el backend (ver mintDeviceToken en
 *  api/_lib/realtime.ts) — el cliente nunca maneja una API key, solo le
 *  pide un token de corta duración a NUESTRO backend. Null si Ably no
 *  está configurado del lado del servidor. */
async function fetchTokenRequest(): Promise<Record<string, unknown> | null> {
  const result = await callApi<{ ok: boolean; tokenRequest?: Record<string, unknown> | null }>('devices', 'realtimeToken')
  return result.tokenRequest ?? null
}

/**
 * Cliente Ably compartido para toda la sesión, o null si Ably no está
 * configurado del lado del backend — en ese caso el caller simplemente se
 * queda con el long-poll de siempre, sin ningún error visible.
 * Memoizado en un módulo-level promise: sin esto, cada llamador terminaría
 * abriendo su propia conexión.
 */
function getRealtimeClient(): Promise<RealtimeClient | null> {
  if (clientPromise) return clientPromise

  clientPromise = (async () => {
    // Confirmar primero que el backend puede emitir un token evita
    // instanciar el SDK entero (con sus reintentos de conexión) en un
    // deployment que nunca configuró ABLY_API_KEY.
    const firstToken = await fetchTokenRequest()
    if (!firstToken) return null
    let pendingFirstToken: Record<string, unknown> | null = firstToken

    const { BaseRealtime, WebSocketTransport, FetchRequest } = await import('ably/modular')

    return new BaseRealtime({
      // authCallback en vez de authUrl: reusa callApi (headers de sesión,
      // manejo de 401 centralizado) en lugar de que Ably haga su propio
      // fetch pelado contra un endpoint separado.
      authCallback: (_params, callback) => {
        void (async () => {
          // El primer token ya se pidió arriba — no tiene sentido pedirlo
          // dos veces al toque de instanciar el cliente.
          const tokenRequest = pendingFirstToken ?? (await fetchTokenRequest())
          pendingFirstToken = null
          if (!tokenRequest) {
            callback('no se pudo obtener un token de Ably', null)
            return
          }
          callback(null, tokenRequest as unknown as Ably.TokenRequest)
        })()
      },
      plugins: { WebSocketTransport, FetchRequest },
      closeOnUnload: true,
    })
  })().catch((err: unknown) => {
    console.warn('[XFY] No se pudo inicializar el transporte realtime (Ably) — se sigue con el long-poll:', err)
    return null
  })

  return clientPromise
}

/**
 * Se conecta al canal PRIVADO de este dispositivo y llama a `onCommand`
 * con cada mensaje que llegue — devuelve una función de limpieza (nunca
 * null: si Ably no está disponible, la limpieza no hace nada) para usar
 * directo en el `return` de un `useEffect`.
 * `onConnectionChange` avisa cuando el transporte pasa a estar realmente
 * activo (o deja de estarlo) — useDeviceSync lo usa para bajarle el ritmo
 * al long-poll mientras Ably está entregando los comandos.
 */
export async function connectDeviceRealtime(
  userId: string,
  deviceId: string,
  onCommand: (data: unknown) => void,
  onConnectionChange: (connected: boolean) => void,
): Promise<() => void> {
  const client = await getRealtimeClient()
  if (!client) return () => {}

  const channel = client.channels.get(deviceChannelName(userId, deviceId))
  // Tipado explícito como messageCallback<InboundMessage> — es el único
  // overload de subscribe(eventName, listener) que Ably expone; pasarle un
  // listener con una forma de parámetro "inventada" (aunque estructuralmente
  // parecida) no matchea ninguno de sus overloads.
  const handleCommand: Ably.messageCallback<InboundMessage> = (msg) => onCommand(msg.data)
  void channel.subscribe('command', handleCommand)

  const handleConnectionUpdate = () => onConnectionChange(client.connection.state === 'connected')
  client.connection.on(['connected', 'disconnected', 'suspended', 'closed', 'failed'], handleConnectionUpdate)
  handleConnectionUpdate()

  return () => {
    channel.unsubscribe('command', handleCommand)
    client.connection.off(handleConnectionUpdate)
  }
}
