/**
 * Store de suscripciones push, bajo xfy-push/subs/.
 *
 * Un registro por DISPOSITIVO (token anónimo generado en el cliente — ver
 * shared/lib/pushNotifications.ts). Cada registro guarda:
 *   - subscription: endpoint + claves de cifrado que entrega PushManager
 *   - artists: los artistas vigilados + snapshots (lo que el cron consulta)
 *
 * No hay cuentas ni PII: solo el token random del dispositivo y lo mínimo
 * para cifrar/mandar un push. Endpoints muertos se podan solos cuando el
 * push service responde 404/410.
 *
 * Vive en Cloudflare R2 (mismo bucket S3-compatible que el audio, prefijo
 * separado) en vez de Vercel Blob: un store de Blob suspendido/agotado no
 * puede tumbar las notificaciones push si el push nunca dependió de él.
 * Si R2 no está configurado, cae a Vercel Blob como red de seguridad —
 * mismo patrón que tieredAudioStore.ts para el audio.
 */

import { put as vercelPut, head as vercelHead, del as vercelDel } from '@vercel/blob'
import { r2Config } from '../../_lib/tieredAudioStore.ts'
import { s3Put, s3Get, s3Delete, s3List, s3PublicUrl } from '../../_lib/s3Compat.ts'

export const SUBS_PREFIX = 'xfy-push/subs/'

export interface WatchedArtist {
  key: string
  name: string
  lastAlbumMs?: number
  lastSongMs?: number
  lastCheckAt?: number
}

export interface StoredSubscription {
  token: string
  subscription: {
    endpoint: string
    keys: { p256dh: string; auth: string }
  }
  artists: WatchedArtist[]
  updatedAt: number
}

/** Validación del shape mínimo que web-push necesita para cifrar. */
export function parseSubscription(raw: unknown): StoredSubscription['subscription'] | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as StoredSubscription['subscription']
  if (typeof s.endpoint !== 'string' || !s.endpoint.startsWith('https://')) return null
  if (!s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') return null
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }
}

function subPath(token: string): string {
  return `${SUBS_PREFIX}${encodeURIComponent(token)}.json`
}

export async function readSub(token: string): Promise<StoredSubscription | null> {
  const r2 = r2Config()
  if (r2) {
    const buf = await s3Get(r2, subPath(token))
    if (!buf) return null
    try {
      return JSON.parse(buf.toString('utf8')) as StoredSubscription
    } catch {
      return null
    }
  }

  try {
    const meta = await vercelHead(subPath(token))
    const upstream = await fetch(meta.url)
    if (!upstream.ok) return null
    return (await upstream.json()) as StoredSubscription
  } catch {
    return null
  }
}

export async function writeSub(stored: StoredSubscription): Promise<void> {
  const r2 = r2Config()
  const body = JSON.stringify(stored)
  if (r2) {
    await s3Put(r2, subPath(stored.token), body, 'application/json')
    return
  }

  await vercelPut(subPath(stored.token), body, {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  })
}

export async function deleteSub(token: string): Promise<void> {
  const r2 = r2Config()
  if (r2) {
    await s3Delete(r2, subPath(token))
    return
  }

  try {
    await vercelDel(subPath(token))
  } catch {
    /* ya no existe: ok */
  }
}

/** Todos los registros almacenados (tolerante a blobs corruptos individuales). */
export async function listAllSubs(): Promise<StoredSubscription[]> {
  const result: StoredSubscription[] = []
  const r2 = r2Config()

  // MEJORA de performance: cada item de una página se traía con un `await
  // fetch(...)` DENTRO de un `for` — un solo fetch a la vez, esperando a
  // que termine antes de pedir el siguiente, aunque son descargas
  // completamente independientes entre sí (nada las serializa). Con cientos
  // de dispositivos suscritos, esto corre una vez por página en el cron
  // diario y solo agranda el presupuesto de tiempo del propio cron sin
  // motivo. Se resuelve toda la página en paralelo con Promise.allSettled
  // (tolerante a blobs individuales caídos/corruptos, igual que antes).
  async function fetchOne(url: string): Promise<StoredSubscription | null> {
    try {
      const upstream = await fetch(url)
      if (!upstream.ok) return null
      const parsed = (await upstream.json()) as StoredSubscription
      return parsed?.subscription?.endpoint && parsed.token ? parsed : null
    } catch {
      return null
    }
  }

  if (r2) {
    let token: string | undefined
    try {
      do {
        const page = await s3List(r2, SUBS_PREFIX, token)
        const settled = await Promise.allSettled(page.items.map((item) => fetchOne(s3PublicUrl(r2, item.key))))
        for (const s of settled) if (s.status === 'fulfilled' && s.value) result.push(s.value)
        token = page.nextToken
      } while (token && result.length < 5000)
    } catch {
      /* store inaccesible: devolvemos lo acumulado */
    }
    return result
  }

  const { list } = await import('@vercel/blob')
  let cursor: string | undefined
  try {
    do {
      const page = await list({ prefix: SUBS_PREFIX, cursor })
      const settled = await Promise.allSettled(page.blobs.map((blob) => fetchOne(blob.url)))
      for (const s of settled) if (s.status === 'fulfilled' && s.value) result.push(s.value)
      cursor = page.cursor
    } while (cursor && result.length < 5000)
  } catch {
    /* store inaccesible: devolvemos lo acumulado */
  }
  return result
}
