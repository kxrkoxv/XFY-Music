/**
 * POST /api/push — punto único de las operaciones push del cliente Y de
 * todo el backend de cuentas (Postgres/Neon): auth, playlists, temas
 * y migración desde IndexedDB.
 *
 * En el plan Hobby de Vercel cada archivo de api/ es UNA Serverless Function
 * con tope de 12 por deployment (ya estamos justo en el tope). Por eso todo
 * entra por acá con un campo `resource` en el body (mismo patrón que usa
 * /api/ytmusic con ?op=):
 *
 *   resource: 'push' (o ausente, retrocompatible) — comportamiento original:
 *     op: 'subscribe'   { token, subscription }  → registra/renueva el dispositivo
 *     op: 'state'       { token, artists[] }     → sincroniza artistas vigilados
 *     op: 'unsubscribe' { token }                → borra el registro
 *
 *   Cualquier otro resource ('auth' | 'user' | 'playlists' | 'themes' |
 *   'migrate') se delega íntegro a accountResources.ts — ver ese
 *   archivo para el detalle de cada `op`. Requiere DATABASE_URL (Neon) en
 *   las variables de entorno.
 *
 * El cron de envío sigue siendo una función aparte (api/push/cron-release-
 * watch.ts) porque necesita su propio path para vercel.json crons.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { parseSubscription, readSub, writeSub, deleteSub, type WatchedArtist } from './push/_lib/store.ts'
import { normName } from './push/_lib/releases.ts'
import { handleAccountResource } from './_lib/accountResources.ts'

const MAX_ARTISTS = 16

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<VercelResponse> {
  if (req.method !== 'POST') return res.status(405).json({ error: 'solo POST' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body ?? {}
  const resource = String((body as { resource?: unknown }).resource || 'push')
  const op = String((body as { op?: unknown }).op || '')

  if (resource !== 'push') return handleAccountResource(resource, op, body, req, res)

  switch (op) {
    case 'subscribe':
      return subscribe(body, res)
    case 'state':
      return syncState(body, res)
    case 'unsubscribe':
      return unsubscribe(body, res)
    default:
      return res.status(400).json({ error: 'op inválida — subscribe | state | unsubscribe' })
  }
}

// --- subscribe -------------------------------------------------------------

async function subscribe(body: Record<string, unknown>, res: VercelResponse): Promise<VercelResponse> {
  const token = String(body.token || '').slice(0, 64)
  const subscription = parseSubscription(body.subscription)
  if (!token || !/^[a-zA-Z0-9-]+$/.test(token)) return res.status(400).json({ error: 'token inválido' })
  if (!subscription) return res.status(400).json({ error: 'subscription inválida' })

  // Preservar artistas ya vigilados si el dispositivo se re-suscribe.
  const existing = await readSub(token)
  await writeSub({
    token,
    subscription,
    artists: existing?.artists ?? [],
    updatedAt: Date.now(),
  })
  return res.status(200).json({ ok: true })
}

// --- state -----------------------------------------------------------------

async function syncState(body: Record<string, unknown>, res: VercelResponse): Promise<VercelResponse> {
  const token = String(body.token || '')
  if (!token) return res.status(400).json({ error: 'falta token' })

  const existing = await readSub(token)
  if (!existing) return res.status(404).json({ error: 'suscripción inexistente — subscribe primero' })

  const rawArtists = Array.isArray(body.artists) ? (body.artists as Array<Record<string, unknown>>) : []
  const merged = new Map<string, WatchedArtist>()
  for (const a of existing.artists ?? []) merged.set(a.key, a)
  for (const raw of rawArtists.slice(0, MAX_ARTISTS)) {
    const key = normName(raw.key)
    const name = String(raw.name || '').slice(0, 120)
    if (!key || !name) continue
    const prev = merged.get(key)
    merged.set(key, {
      key,
      name,
      lastAlbumMs: numOr(raw.lastAlbumMs, prev?.lastAlbumMs),
      lastSongMs: numOr(raw.lastSongMs, prev?.lastSongMs),
      lastCheckAt: prev?.lastCheckAt,
    })
  }

  await writeSub({ ...existing, artists: [...merged.values()], updatedAt: Date.now() })
  return res.status(200).json({ ok: true, artists: merged.size })
}

// --- unsubscribe -----------------------------------------------------------

async function unsubscribe(body: Record<string, unknown>, res: VercelResponse): Promise<VercelResponse> {
  const token = String(body.token || '')
  if (!token) return res.status(400).json({ error: 'falta token' })
  await deleteSub(token)
  return res.status(200).json({ ok: true })
}

// --- helpers ---------------------------------------------------------------

function numOr(value: unknown, fallback?: number): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}
