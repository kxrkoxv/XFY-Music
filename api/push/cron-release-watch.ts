/**
 * Cron job: chequeo diario de lanzamientos para PUSH "con la app cerrada".
 *
 * El cliente (releaseWatch) solo puede notificar mientras su app está
 * abierta. Este cron cierra el ciclo: recorre las suscripciones almacenadas
 * en el Blob store, consulta iTunes por los artistas que CADA dispositivo
 * tiene vigilados, y les manda su push vía web-push cuando hay algo nuevo.
 *
 * Seguridad: mismo criterio que api/ytaudit.ts (camino de cron) — solo Vercel Cron
 * (header x-vercel-cron inyectado por Vercel) o Bearer CRON_SECRET si está
 * configurado. Requiere VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY en env vars.
 *
 * Presupuesto: tandas con tope de tiempo; los dispositivos no alcanzados
 * quedan para la próxima corrida porque los snapshots SOLO se actualizan
 * al procesarlos (ningún lanzamiento se pierde, solo se demora).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import webpush from 'web-push'
import { listAllSubs, writeSub, deleteSub, type StoredSubscription } from './_lib/store.ts'
import { checkArtistReleases } from './_lib/releases.ts'

export const config = { maxDuration: 300 }

const TIME_BUDGET_MS = 250 * 1000 // margen bajo los 300s reales
const ARTIST_SPACING_MS = 350 // cortesía con iTunes entre requests
const MAX_SUBS_PER_RUN = 200

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<VercelResponse> {
  const isVercelCron = req.headers['x-vercel-cron'] === '1'
  const cronSecret = process.env.CRON_SECRET
  const hasValidSecret = !!cronSecret && req.headers['authorization'] === `Bearer ${cronSecret}`
  if (!isVercelCron && !hasValidSecret) {
    return res.status(401).json({ error: 'solo Vercel Cron puede disparar esto' })
  }

  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) {
    return res.status(500).json({ error: 'faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en env' })
  }
  webpush.setVapidDetails('mailto:admin@xfy.app', publicKey, privateKey)

  const startedAt = Date.now()
  const subs = await listAllSubs()
  let pushed = 0
  let pruned = 0
  let processed = 0

  for (const sub of subs) {
    if (Date.now() - startedAt > TIME_BUDGET_MS || processed >= MAX_SUBS_PER_RUN) break
    processed++
    try {
      const outcome = await processSub(sub, () => Date.now() - startedAt > TIME_BUDGET_MS)
      pushed += outcome.pushed
    } catch {
      await prune(sub).catch(() => {})
      pruned++
    }
  }

  return res.status(200).json({ ok: true, total: subs.length, processed, pushed, pruned })
}

async function processSub(
  sub: StoredSubscription,
  outOfTime: () => boolean,
): Promise<{ pushed: number }> {
  let pushed = 0
  let changed = false
  const artists = [...(sub.artists ?? [])]

  for (let i = 0; i < artists.length; i++) {
    if (outOfTime()) break
    const artist = artists[i]!
    try {
      const result = await checkArtistReleases(artist)
      artists[i] = {
        key: result.nextArtist.key,
        name: result.nextArtist.name,
        lastAlbumMs: result.nextArtist.lastAlbumMs,
        lastSongMs: result.nextArtist.lastSongMs,
        lastCheckAt: result.nextArtist.lastCheckAt,
      }
      changed = true

      if (result.notify && result.title) {
        await webpush.sendNotification(
          sub.subscription,
          JSON.stringify({
            title: result.title,
            body: result.body || '',
            url: '/?source=push',
            tag: `xfy-release-${artist.key}`,
          }),
          { TTL: 2 * 60 * 60, urgency: 'normal', topic: `xfy-${artist.key}` },
        )
        pushed++
      }
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      // 404/410 = suscripción muerta (desinstalada/rotada): podar. Otros
      // errores (429 rate limit, red) NO matan el registro.
      if (status === 404 || status === 410) throw err
    }
    await new Promise((r) => setTimeout(r, ARTIST_SPACING_MS))
  }

  if (changed) await writeSub({ ...sub, artists, updatedAt: Date.now() })
  return { pushed }
}

async function prune(sub: StoredSubscription): Promise<void> {
  await deleteSub(sub.token)
}
