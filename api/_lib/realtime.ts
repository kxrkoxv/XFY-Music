/**
 * Transporte realtime opcional para el sistema de dispositivos (ver el
 * comentario grande en useDeviceSync.ts, del lado del cliente, para el
 * panorama completo).
 *
 * Por qué Ably y no un WebSocket propio: Vercel (cualquier plan, no solo
 * Hobby) no puede alojar un proceso que mantenga conexiones WebSocket
 * abiertas — cada invocación de una Serverless Function es de vida corta.
 * Ably resuelve exactamente ese problema: el NAVEGADOR abre la conexión
 * persistente directo contra la infraestructura de Ably (nunca contra
 * Vercel), y esta función solo necesita a) emitir tokens de corta duración
 * para que el cliente se autentique, y b) publicar un mensaje puntual
 * cuando hay un comando nuevo — dos llamadas HTTP normales, nada de estado
 * ni conexiones largas de este lado.
 *
 * Todo lo que sabe que el proveedor se llama específicamente "Ably" vive
 * en este único archivo — accountResources.ts solo llama a
 * mintDeviceToken()/publishToDevice()/isRealtimeConfigured(). Si el día de
 * mañana conviene migrar a Pusher, PartyKit o lo que sea, el resto del
 * backend no se entera.
 *
 * A propósito no es obligatorio: si ABLY_API_KEY no está seteada en las
 * variables de entorno de Vercel, estas funciones devuelven null / no
 * hacen nada, y el sistema entero sigue funcionando igual que antes —
 * enteramente sobre el long-poll de pollCommands. Ably es una capa de
 * "más rápido todavía" superpuesta, nunca una dependencia dura.
 */

import Ably from 'ably'

let restClient: Ably.Rest | null | undefined

function getRestClient(): Ably.Rest | null {
  if (restClient !== undefined) return restClient
  const key = process.env.ABLY_API_KEY
  restClient = key ? new Ably.Rest({ key }) : null
  return restClient
}

export function isRealtimeConfigured(): boolean {
  return getRestClient() !== null
}

// Canal privado de UN dispositivo puntual — ver mintDeviceToken(): el
// token que recibe el dueño de este dispositivo solo puede SUSCRIBIRSE acá
// (nunca publicar, nunca ver el canal de otro dispositivo, ni siquiera de
// la misma cuenta). Publicar es exclusivo del backend, con la API key
// maestra — el mismo modelo de confianza que ya existe para
// playback_commands (solo el backend inserta filas ahí).
function deviceChannelName(userId: string, deviceId: string): string {
  return `account:${userId}:device:${deviceId}`
}

/**
 * Token de corta duración (1h — el cliente de Ably lo renueva solo antes
 * de que expire, vía el mismo callback) con capability restringida al
 * canal de ESTE dispositivo. Devuelve null si ABLY_API_KEY no está
 * configurada — el cliente lo interpreta como "seguí con el long-poll".
 */
export async function mintDeviceToken(userId: string, deviceId: string): Promise<Record<string, unknown> | null> {
  const client = getRestClient()
  if (!client) return null
  try {
    const tokenRequest = await client.auth.createTokenRequest({
      clientId: deviceId,
      capability: { [deviceChannelName(userId, deviceId)]: ['subscribe'] },
      ttl: 60 * 60 * 1000,
    })
    return tokenRequest as unknown as Record<string, unknown>
  } catch (err) {
    console.warn('[realtime] no se pudo emitir token (el cliente sigue con el long-poll):', err)
    return null
  }
}

/**
 * Empuja un comando al canal de un dispositivo puntual, ADEMÁS de la fila
 * que ya se insertó en playback_commands (ver accountResources.ts) — nunca
 * en su lugar. Si Ably no está configurado, o la publicación falla por lo
 * que sea (canal caído, error de red, cuota agotada), esto nunca revienta
 * la request: el dispositivo destino igual recibe el comando, aunque sea
 * con la latencia del long-poll en vez de casi instantáneo.
 */
export async function publishToDevice(userId: string, deviceId: string, event: string, data: unknown): Promise<void> {
  const client = getRestClient()
  if (!client) return
  try {
    await client.channels.get(deviceChannelName(userId, deviceId)).publish(event, data)
  } catch (err) {
    console.warn('[realtime] no se pudo publicar (se sigue dependiendo del long-poll):', err)
  }
}
