/**
 * Todo el backend de cuentas/datos de XFY (auth, playlists, temas,
 * migración desde IndexedDB), fusionado dentro del mismo proyecto de
 * Vercel — ver el comentario grande en api/push.ts sobre por qué esto vive
 * ahí adentro en vez de ser su propio archivo bajo api/ (tope de 12
 * funciones del plan Hobby).
 *
 * resource: 'auth'      op: register | login | me | logout
 * resource: 'user'      op: update
 * resource: 'playlists' op: list | get | create | update | remove | addSong | addSongs | removeSong
 * resource: 'themes'    op: list | save | remove
 * resource: 'migrate'   op: import
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql } from './accountDb.ts'
import {
  hashPassword,
  verifyPassword,
  dummyVerify,
  generateSessionToken,
  generateRandomToken,
  requireAuth,
  SESSION_TTL_MS,
  type AuthedSession,
} from './accountAuth.ts'
import { checkRateLimit, clientIp } from './rateLimit.ts'
import { describeDevice } from './deviceLabel.ts'
import { mintDeviceToken, publishToDevice } from './realtime.ts'
import { waitUntil } from '@vercel/functions'
import {
  generateTotpSecret,
  totpUri,
  verifyTotpCode,
  generateBackupCodes,
  hashBackupCode,
  findUnusedBackupCode,
  type StoredBackupCode,
} from './totp.ts'
import {
  getRpConfig,
  buildRegistrationOptions,
  checkRegistrationResponse,
  buildAuthenticationOptions,
  checkAuthenticationResponse,
  bytesToBase64,
  type CredentialRow,
} from './webauthn.ts'
import type { RegistrationResponseJSON, AuthenticationResponseJSON, AuthenticatorTransportFuture } from '@simplewebauthn/server'

/** Código de error de Postgres para "unique_violation" (constraint duplicado). */
const PG_UNIQUE_VIOLATION = '23505'

// MEJORA: límites duros contra brute force y payloads absurdos. Sin esto,
// nada impedía miles de intentos de login por segundo desde el mismo IP
// (o registros masivos para llenar la tabla `users`), y una password de
// varios MB hubiera forzado a PBKDF2 (100k iteraciones) a hashear ese
// tamaño en CADA intento — DoS barato contra el propio backend.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const MAX_EMAIL_LEN = 254 // límite del propio estándar de email (RFC 5321)
const MAX_NICKNAME_LEN = 60
const MAX_PASSWORD_LEN = 256 // más que de sobra para cualquier password real; corta inputs absurdos
const LOGIN_LIMIT = { max: 15, windowMs: 15 * 60 * 1000 } // 15 intentos / 15 min por IP
const REGISTER_LIMIT = { max: 8, windowMs: 60 * 60 * 1000 } // 8 registros / hora por IP
const MAX_SONGS_PER_BATCH = 2000 // addSongs: tope defensivo, no hay import legítimo más grande que esto
const MAX_FAVORITES_PER_BATCH = 2000 // addFavorites: mismo criterio que MAX_SONGS_PER_BATCH
const MAX_PLAYLIST_NAME_LEN = 200 // MEJORA: name/description de playlist no tenían tope, a diferencia del resto de los campos de texto
const MAX_PLAYLIST_DESC_LEN = 1000

// --- devices (sistema de dispositivos / "Spotify Connect") ---------------
// MEJORA: el resource 'devices' que ya llama todo src/features/devices/
// (heartbeat/list/rename/revoke/transfer/command/pollCommands/realtimeToken)
// no tenía NINGÚN case acá — cada llamada caía en el `default` de más abajo
// y devolvía 400 "resource inválido". El panel de dispositivos, el botón
// "Connect" y el long-poll de useDeviceSync llevaban tiempo corriendo
// contra un endpoint que no existía del lado del servidor; ver también el
// DROP de `devices`/`playback_commands` al principio de db-schema.sql, de
// una versión anterior de este mismo sistema. Esto lo reconstruye entero
// (tablas nuevas al final de db-schema.sql) sobre el mismo contrato que ya
// espera el cliente, sin tocar ni un import de src/features/devices/.
const DEVICE_ID_MAX_LEN = 128
const DEVICE_NAME_MAX_LEN = 60
// 3x el intervalo de heartbeat (5s, ver HEARTBEAT_MS en useDeviceSync.ts) +
// margen para jitter de red — si no llegó ningún heartbeat en esta ventana,
// el dispositivo se pinta "sin conexión" en vez de asumir que sigue vivo.
const DEVICE_ONLINE_THRESHOLD_MS = 16000
// Tope defensivo por cuenta: sin esto, un usuario que borra localStorage
// seguido (o un bot) generaría un device_key nuevo cada vez y la tabla
// crecería sin límite. Al superarlo se podan los MENOS vistos recientemente
// — ver pruneExcessDevices más abajo, solo corre cuando aparece un
// device_key realmente nuevo (no en cada heartbeat).
const MAX_DEVICES_PER_USER = 20
// Mismo valor que el comentario grande de useDeviceSync.ts documenta del
// lado del cliente ("hasta 25s") — api/push.ts ya tiene maxDuration: 30 en
// vercel.json. Se deja en 22s (no 25s) para que el peor caso —~22 vueltas
// del loop de abajo, cada una con su propio round-trip a Neon— tenga margen
// real antes de que Vercel mate la función a los 30s; si eso pasara, el
// cliente lo ve como un error de red normal y reintenta solo (ver
// POLL_RETRY_MS en useDeviceSync.ts), pero mejor evitarlo.
const POLL_WAIT_MS = 22000
const POLL_STEP_MS = 1000
const COMMAND_MAX_AGE_MS = 2 * 60 * 1000 // comandos sin consumir por más de esto se descartan (dispositivo que nunca volvió a preguntar)
const ALLOWED_REMOTE_COMMAND_TYPES = new Set(['play', 'pause', 'seek', 'setVolume', 'next', 'previous'])

// Segundo factor (TOTP/código de respaldo): 6 dígitos son solo ~1M
// combinaciones, así que sin límite un script podría agotarlas contra un
// challenge pendiente. 10 intentos / 10 min por IP alcanza de sobra para un
// humano tipeando mal y frena fuerza bruta automatizada.
const TWOFA_LIMIT = { max: 10, windowMs: 10 * 60 * 1000 }
// WebAuthn no tiene el mismo riesgo (la firma criptográfica no se puede
// adivinar), pero igual se limita por las dudas de abuso/DoS del propio
// endpoint de verificación.
const WEBAUTHN_LIMIT = { max: 20, windowMs: 10 * 60 * 1000 }

export async function handleAccountResource(
  resource: string,
  op: string,
  body: Record<string, unknown>,
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  try {
    if (resource === 'auth') return await authResource(req, op, body, res)

    // Todo lo demás requiere sesión autenticada.
    const auth = await requireAuth(req)
    if (!auth) return res.status(401).json({ error: 'no autenticado' })

    switch (resource) {
      case 'user':
        return await userResource(op, body, auth, res)
      case 'playlists':
        return await playlistsResource(op, body, auth, res)
      case 'themes':
        return await themesResource(op, body, auth, res)
      case 'migrate':
        return await migrateResource(op, body, auth, res)
      case 'security':
        return await securityResource(op, body, auth, req, res)
      case 'devices':
        return await devicesResource(op, body, auth, req, res)
      default:
        return res.status(400).json({ error: 'resource inválido' })
    }
  } catch (err) {
    console.error('[api/push:account] error:', err)
    return res.status(500).json({ error: 'error interno' })
  }
}

// --- auth --------------------------------------------------------------

async function authResource(
  req: VercelRequest,
  op: string,
  body: Record<string, unknown>,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (op === 'register') {
    const limit = await checkRateLimit(`register:${clientIp(req)}`, REGISTER_LIMIT.max, REGISTER_LIMIT.windowMs)
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds))
      return res.status(429).json({ ok: false, reason: 'rate_limited' })
    }

    const nickname = String(body.nickname || '').trim().slice(0, MAX_NICKNAME_LEN)
    const email = String(body.email || '').toLowerCase().trim().slice(0, MAX_EMAIL_LEN)
    const password = String(body.password || '').slice(0, MAX_PASSWORD_LEN)
    if (!nickname || !email || !EMAIL_RE.test(email) || password.length < 8) {
      return res.status(400).json({ ok: false, reason: 'invalid' })
    }
    // MEJORA: este SELECT + INSERT sigue teniendo la MISMA carrera que
    // tenía addSong (dos registros con el mismo email casi simultáneos
    // pueden pasar ambos el SELECT antes de que cualquiera haga el INSERT).
    // No hay forma de resolverlo del todo sin un constraint `unique` en
    // `email` a nivel de base — si la tabla ya lo tiene, el try/catch de
    // abajo convierte el 500 que tirarías hoy en una respuesta prolija de
    // "duplicate"; si no lo tiene, agregalo (`alter table users add
    // constraint users_email_key unique (email)`) para que esto sea
    // realmente imposible y no solo "poco probable".
    const existing = await sql`select id from users where email = ${email} limit 1`
    if (existing.length > 0) return res.status(200).json({ ok: false, reason: 'duplicate' })

    const passwordHash = await hashPassword(password)
    const avatarUrl = `https://placehold.co/100x100/7c3aed/ffffff?text=${nickname.charAt(0).toUpperCase()}`
    const preferences = { theme: 'default-dark', volume: 0.8, playbackSpeed: 1.0, autoPlayNext: true, favorites: [] }
    try {
      const userRows = await sql`
        insert into users (nickname, email, password_hash, avatar_url, preferences)
        values (${nickname}, ${email}, ${passwordHash}, ${avatarUrl}, ${JSON.stringify(preferences)})
        returning id, nickname, email, avatar_url, preferences, created_at, updated_at
      `
      const user = userRows[0]!
      const session = await createSession(user.id as string, req)
      return res.status(200).json({ ok: true, token: session.token, user: toUserDTO(user) })
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(200).json({ ok: false, reason: 'duplicate' })
      throw err
    }
  }

  if (op === 'login') {
    // MEJORA: rate limit por IP antes de tocar la base — sin esto, un
    // script probando passwords contra un email conocido no tenía ningún
    // freno más que el costo de PBKDF2 (100k iteraciones sigue siendo
    // rápido en cómputo dedicado). 15 intentos / 15 min alcanza de sobra
    // para un usuario real que se equivoca de password, y frena brute
    // force automatizado.
    const limit = await checkRateLimit(`login:${clientIp(req)}`, LOGIN_LIMIT.max, LOGIN_LIMIT.windowMs)
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds))
      return res.status(429).json({ ok: false, reason: 'rate_limited' })
    }

    const email = String(body.email || '').toLowerCase().trim().slice(0, MAX_EMAIL_LEN)
    const password = String(body.password || '').slice(0, MAX_PASSWORD_LEN)
    const rows = await sql`select * from users where email = ${email} limit 1`
    const user = rows[0]
    // MEJORA: antes, cuando el email no existía, se saltaba directamente
    // verifyPassword() — esa rama respondía notablemente más rápido que un
    // login con email válido y password incorrecta (que sí hace el hashing
    // PBKDF2 de 100k iteraciones). Ese delta de tiempo es un side-channel
    // que permite inferir qué emails están registrados sin necesidad de
    // ver la respuesta. dummyVerify() hace el mismo trabajo de hashing
    // contra un hash fijo para que ambas ramas tarden lo mismo.
    const ok = user
      ? await verifyPassword(user.password_hash as string, password)
      : await dummyVerify(password).then(() => false)
    if (!ok || !user) return res.status(200).json({ ok: false })

    // Segundo factor: la contraseña ya se verificó, pero todavía no se crea
    // la sesión — se emite un challengeToken de corta vida (auth_challenges,
    // 5 min) que el cliente tiene que devolver junto al código de la app
    // autenticadora (o un código de respaldo) en `auth/login2fa`. Así un
    // atacante que solo tiene la contraseña (filtrada, reusada de otro
    // sitio, etc.) no puede loguearse sin also tener el segundo factor.
    if (user.totp_enabled) {
      const challengeToken = generateRandomToken()
      await sql`
        insert into auth_challenges (id, user_id, type, expires_at)
        values (${challengeToken}, ${user.id as string}, '2fa-login', now() + interval '5 minutes')
      `
      return res.status(200).json({ ok: true, requires2fa: true, challengeToken })
    }

    const session = await createSession(user.id as string, req)
    return res.status(200).json({ ok: true, token: session.token, user: toUserDTO(user) })
  }

  // Segundo paso del login cuando la cuenta tiene 2FA: valida el
  // challengeToken emitido por `login` + un código TOTP de 6 dígitos O un
  // código de respaldo, y recién ahí crea la sesión.
  if (op === 'login2fa') {
    const limit = await checkRateLimit(`2fa:${clientIp(req)}`, TWOFA_LIMIT.max, TWOFA_LIMIT.windowMs)
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds))
      return res.status(429).json({ ok: false, reason: 'rate_limited' })
    }

    const challengeToken = String(body.challengeToken || '')
    const code = String(body.code || '').trim()
    const challengeRows = await sql`
      delete from auth_challenges
      where id = ${challengeToken} and type = '2fa-login' and expires_at > now()
      returning user_id
    `
    if (challengeRows.length === 0) return res.status(200).json({ ok: false, reason: 'challenge_expired' })
    const userId = challengeRows[0]!.user_id as string

    const userRows = await sql`select * from users where id = ${userId} limit 1`
    if (userRows.length === 0) return res.status(200).json({ ok: false })
    const user = userRows[0]!

    let verified = await verifyTotpCode(user.totp_secret as string | null, code)
    if (!verified) {
      // No era un código TOTP válido — probar como código de respaldo. Si
      // matchea, se consume (usedAt) y se persiste de una: un código de
      // respaldo usado no puede reusarse aunque el atacante lo haya visto.
      const backupCodes = (user.backup_codes as StoredBackupCode[]) || []
      const idx = await findUnusedBackupCode(backupCodes, code)
      if (idx !== -1) {
        backupCodes[idx] = { ...backupCodes[idx]!, usedAt: new Date().toISOString() }
        await sql`update users set backup_codes = ${JSON.stringify(backupCodes)} where id = ${userId}`
        verified = true
      }
    }
    if (!verified) return res.status(200).json({ ok: false })

    const session = await createSession(userId, req)
    return res.status(200).json({ ok: true, token: session.token, user: toUserDTO(user) })
  }

  // --- Passkeys: login "usernameless" (sin escribir email/contraseña) ------

  if (op === 'webauthnLoginOptions') {
    const rp = getRpConfig(req)
    const options = await buildAuthenticationOptions(rp)
    const challengeToken = generateRandomToken()
    await sql`
      insert into auth_challenges (id, type, challenge, expires_at)
      values (${challengeToken}, 'webauthn-auth', ${options.challenge}, now() + interval '5 minutes')
    `
    return res.status(200).json({ ok: true, options, challengeToken })
  }

  if (op === 'webauthnLoginVerify') {
    const limit = await checkRateLimit(`webauthn:${clientIp(req)}`, WEBAUTHN_LIMIT.max, WEBAUTHN_LIMIT.windowMs)
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds))
      return res.status(429).json({ ok: false, reason: 'rate_limited' })
    }

    const challengeToken = String(body.challengeToken || '')
    const response = body.response as AuthenticationResponseJSON
    const challengeRows = await sql`
      delete from auth_challenges
      where id = ${challengeToken} and type = 'webauthn-auth' and expires_at > now()
      returning challenge
    `
    if (challengeRows.length === 0 || !response?.id) return res.status(200).json({ ok: false, reason: 'challenge_expired' })
    const expectedChallenge = challengeRows[0]!.challenge as string

    const credRows = await sql`select * from webauthn_credentials where id = ${response.id} limit 1`
    if (credRows.length === 0) return res.status(200).json({ ok: false })
    const credRow = credRows[0]!
    const credential: CredentialRow = {
      id: credRow.id as string,
      publicKey: credRow.public_key as string,
      counter: Number(credRow.counter),
      transports: (credRow.transports as AuthenticatorTransportFuture[]) || [],
    }

    const rp = getRpConfig(req)
    let verification
    try {
      verification = await checkAuthenticationResponse(rp, response, expectedChallenge, credential)
    } catch {
      return res.status(200).json({ ok: false })
    }
    if (!verification.verified) return res.status(200).json({ ok: false })

    await sql`
      update webauthn_credentials set counter = ${verification.authenticationInfo.newCounter}, last_used_at = now()
      where id = ${credRow.id as string}
    `
    const userRows = await sql`select * from users where id = ${credRow.user_id as string} limit 1`
    if (userRows.length === 0) return res.status(200).json({ ok: false })
    const user = userRows[0]!

    const session = await createSession(user.id as string, req)
    return res.status(200).json({ ok: true, token: session.token, user: toUserDTO(user) })
  }

  if (op === 'me') {
    const auth = await requireAuth(req)
    if (!auth) return res.status(401).json({ error: 'no autenticado' })
    const rows = await sql`select * from users where id = ${auth.userId} limit 1`
    if (rows.length === 0) return res.status(404).json({ error: 'usuario no existe' })
    return res.status(200).json({ user: toUserDTO(rows[0]!) })
  }

  if (op === 'logout') {
    const auth = await requireAuth(req)
    if (!auth) return res.status(200).json({ ok: true }) // ya no hay nada que cerrar
    await sql`delete from sessions where id = ${auth.sessionId}`
    return res.status(200).json({ ok: true })
  }

  return res.status(400).json({ error: 'op inválida para auth' })
}

async function createSession(userId: string, req: VercelRequest) {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 512)
  const deviceName = describeDevice(userAgent)
  const ip = clientIp(req)
  const rows = await sql`
    insert into sessions (user_id, token, expires_at, device_name, user_agent, ip, last_seen_at)
    values (${userId}, ${token}, ${expiresAt}, ${deviceName}, ${userAgent}, ${ip}, now())
    returning id, user_id, token, created_at, expires_at
  `
  return rows[0]!
}

/** Neon serverless propaga el `code` de Postgres en el error — 23505 = unique_violation. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === PG_UNIQUE_VIOLATION
}

function toUserDTO(row: Record<string, unknown>) {
  return {
    id: row.id,
    nickname: row.nickname,
    email: row.email,
    avatarUrl: row.avatar_url,
    preferences: row.preferences,
    totpEnabled: !!row.totp_enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// --- user ----------------------------------------------------------------

async function userResource(
  op: string,
  body: Record<string, unknown>,
  auth: AuthedSession,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (op === 'addFavorites') {
    // Variante en lote de 'update' para favoritos. Un import masivo (ej.
    // "Me Gusta" de Spotify con 465 temas) marcaba cada uno con
    // toggleFavorite() por separado — no solo 465 PATCH secuenciales de más,
    // sino que CADA UNO reenviaba el array de favoritos completo, cada vez
    // más largo (payload O(n²), no O(n)). Acá entra el lote entero y se
    // resuelve en 1 SELECT + 1 UPDATE sin importar cuántas canciones se
    // agreguen, mismo patrón que addSongs/migrateResource. Como esto lo
    // dispara una sola acción de usuario (no N requests en paralelo sobre
    // la misma fila, que fue el bug real de addSong), un SELECT+UPDATE
    // simple alcanza sin necesitar el UPDATE atómico condicional que usan
    // addSong/addSongs para las escrituras concurrentes.
    const songsIn = (Array.isArray(body.songs) ? body.songs : []) as Record<string, unknown>[]
    const songsToAdd = songsIn.filter((s) => s && s.id != null).slice(0, MAX_FAVORITES_PER_BATCH)
    if (songsToAdd.length === 0) return res.status(200).json({ ok: true, added: 0 })

    const rows = await sql`select * from users where id = ${auth.userId} limit 1`
    if (rows.length === 0) return res.status(404).json({ error: 'usuario no existe' })
    const current = rows[0]!
    const currentPrefs = (current.preferences as Record<string, unknown>) || {}
    const currentFavorites = (currentPrefs.favorites as Record<string, unknown>[]) || []
    const mergedFavorites = dedupeSongs([...currentFavorites, ...songsToAdd])
    const nextPrefs = { ...currentPrefs, favorites: mergedFavorites }

    const updated = await sql`
      update users set preferences = ${JSON.stringify(nextPrefs)}, updated_at = now()
      where id = ${auth.userId}
      returning id, nickname, email, avatar_url, preferences, created_at, updated_at
    `
    return res.status(200).json({
      ok: true,
      added: mergedFavorites.length - currentFavorites.length,
      user: toUserDTO(updated[0]!),
    })
  }

  if (op !== 'update') return res.status(400).json({ error: 'op inválida para user' })

  const patch = (body.patch || {}) as { nickname?: string; avatarUrl?: string; preferences?: Record<string, unknown> }
  const rows = await sql`select * from users where id = ${auth.userId} limit 1`
  if (rows.length === 0) return res.status(404).json({ error: 'usuario no existe' })
  const current = rows[0]!

  const nickname = patch.nickname?.trim() || (current.nickname as string)
  const avatarUrl = patch.avatarUrl || (current.avatar_url as string)
  const preferences = patch.preferences
    ? { ...(current.preferences as Record<string, unknown>), ...patch.preferences }
    : current.preferences

  const updated = await sql`
    update users
    set nickname = ${nickname}, avatar_url = ${avatarUrl}, preferences = ${JSON.stringify(preferences)}, updated_at = now()
    where id = ${auth.userId}
    returning id, nickname, email, avatar_url, preferences, created_at, updated_at
  `
  return res.status(200).json({ ok: true, user: toUserDTO(updated[0]!) })
}

// --- playlists -------------------------------------------------------------

async function playlistsResource(
  op: string,
  body: Record<string, unknown>,
  auth: AuthedSession,
  res: VercelResponse,
): Promise<VercelResponse> {
  switch (op) {
    case 'list': {
      const rows = await sql`select * from playlists where user_id = ${auth.userId} order by created_at asc`
      const catalog = await fetchCatalog(rows.flatMap((r) => idsOf(r)))
      return res.status(200).json({ playlists: rows.map((r) => toPlaylistDTO(r, catalog)) })
    }
    case 'get': {
      const rows = await sql`select * from playlists where id = ${String(body.id)} and user_id = ${auth.userId} limit 1`
      if (rows.length === 0) return res.status(404).json({ playlist: null })
      const catalog = await fetchCatalog(idsOf(rows[0]!))
      return res.status(200).json({ playlist: toPlaylistDTO(rows[0]!, catalog) })
    }
    case 'create': {
      const name = String(body.name || '').trim().slice(0, MAX_PLAYLIST_NAME_LEN)
      if (!name) return res.status(400).json({ playlist: null })
      const description = String(body.description || '').trim().slice(0, MAX_PLAYLIST_DESC_LEN)
      const rows = await sql`
        insert into playlists (user_id, name, description, songs)
        values (${auth.userId}, ${name}, ${description}, '[]'::jsonb)
        returning *
      `
      return res.status(200).json({ playlist: toPlaylistDTO(rows[0]!, new Map()) })
    }
    case 'update': {
      const id = String(body.id)
      const patch = (body.patch || {}) as { name?: string; coverUrl?: string; description?: string }
      const existing = await sql`select * from playlists where id = ${id} and user_id = ${auth.userId} limit 1`
      if (existing.length === 0) return res.status(200).json({ ok: false })
      const name = (patch.name ?? (existing[0]!.name as string)).slice(0, MAX_PLAYLIST_NAME_LEN)
      const coverUrl = patch.coverUrl ?? (existing[0]!.cover_url as string | null)
      const description = (patch.description ?? (existing[0]!.description as string)).slice(0, MAX_PLAYLIST_DESC_LEN)
      // MEJORA: se agrega "and user_id" acá también — antes el UPDATE final
      // confiaba en el SELECT de arriba para la verificación de dueño, sin
      // repetirla en la sentencia que realmente escribe. Hoy no es
      // explotable (nada te deja pisar ese SELECT), pero es defensa en
      // profundidad: si mañana alguien refactoriza y el SELECT desaparece o
      // cambia de orden, esto sigue sin poder tocar playlists ajenas. Mismo
      // criterio aplicado abajo en remove/addSong/addSongs/removeSong.
      await sql`
        update playlists set name = ${name}, cover_url = ${coverUrl}, description = ${description}, updated_at = now()
        where id = ${id} and user_id = ${auth.userId}
      `
      return res.status(200).json({ ok: true })
    }
    case 'remove': {
      await sql`delete from playlists where id = ${String(body.id)} and user_id = ${auth.userId}`
      return res.status(200).json({ ok: true })
    }
    case 'addSong': {
      const id = String(body.id)
      const song = body.song as Record<string, unknown> | string | number
      const isFullSong = song !== null && typeof song === 'object'
      const candidateId = String(isFullSong ? (song as Record<string, unknown>).id : song)
      if (!candidateId) return res.status(200).json({ ok: false })

      const owns = await sql`select 1 from playlists where id = ${id} and user_id = ${auth.userId} limit 1`
      if (owns.length === 0) return res.status(200).json({ ok: false })

      if (!(await upsertCatalogEntry(candidateId, isFullSong ? song : null))) {
        return res.status(200).json({ ok: false })
      }

      // BUGFIX (el reporte original): esto antes era un SELECT (leer
      // `songs`) + UPDATE (escribir `songs` viejo + el nuevo id) en dos
      // round-trips HTTP separados (Neon serverless no mantiene conexión
      // persistente entre queries). El import de Spotify dispara varias
      // canciones EN PARALELO por playlist (Promise.all de a 6) — dos
      // requests podían hacer el SELECT casi al mismo tiempo, ambas leer el
      // mismo array "viejo" sin la canción que la otra ya había agregado, y
      // la que terminaba de escribir última pisaba el UPDATE de la otra.
      // Resultado: el cliente recibía ok:true para las 465-475 canciones,
      // pero la fila en Postgres se quedaba con muchas menos — de ahí que
      // al reabrir la app la playlist apareciera con 121 canciones en vez
      // de las importadas.
      //
      // El fix es un solo UPDATE atómico que lee y escribe `songs` en la
      // MISMA sentencia. Postgres serializa los UPDATE concurrentes sobre
      // la misma fila (lock de fila + re-lectura en READ COMMITTED), así
      // que cada request ve siempre el valor más reciente — ninguna pisa
      // el trabajo de otra, sin importar cuántas lleguen en paralelo.
      await sql`
        update playlists
        set songs = songs || jsonb_build_array(${candidateId}::text),
            updated_at = now()
        where id = ${id} and user_id = ${auth.userId}
          and not (songs @> jsonb_build_array(${candidateId}::text))
      `
      return res.status(200).json({ ok: true })
    }
    case 'addSongs': {
      // MEJORA de performance: variante en lote de addSong. Un import de
      // Spotify de 465 canciones significaba 465 round-trips HTTP a Neon
      // (uno por canción) — lento y le pega a la cuota de forma innecesaria
      // cuando en realidad todas van a la MISMA fila de playlist.
      //
      // CORRECCIÓN: el comentario original decía "se resuelve el catálogo
      // de cada canción en paralelo", pero el código de abajo era en
      // realidad un `for...of` con `await upsertCatalogEntry(...)` DENTRO
      // del loop — o sea, exactamente los mismos N round-trips secuenciales
      // que esta misma función dice estar evitando (465 canciones = 465
      // fetch HTTP a Neon, uno esperando al anterior). Se reemplaza por dos
      // batches: un solo INSERT multi-fila (vía unnest) para todas las
      // canciones que traen metadata completa, y un solo SELECT ... = any()
      // para verificar cuáles ids sueltos (sin metadata) ya existen en el
      // catálogo. De N+1 round-trips pasa a 2 como mucho.
      const id = String(body.id)
      const songsInRaw = (Array.isArray(body.songs) ? body.songs : []) as (Record<string, unknown> | string | number)[]
      // Tope defensivo: ningún import legítimo (ni Spotify ni YT Music) arma
      // lotes de este tamaño; sin este corte, un body armado a mano podría
      // forzar miles de upserts a `songs` en una sola invocación.
      const songsIn = songsInRaw.slice(0, MAX_SONGS_PER_BATCH)
      if (songsIn.length === 0) return res.status(200).json({ ok: true, added: 0 })

      const owns = await sql`select 1 from playlists where id = ${id} and user_id = ${auth.userId} limit 1`
      if (owns.length === 0) return res.status(200).json({ ok: false, added: 0 })

      const candidateIds = await resolveCatalogIdsBatch(songsIn)
      if (candidateIds.length === 0) return res.status(200).json({ ok: true, added: 0 })

      // jsonb_build_array(...) con spread de todos los ids nuevos, y el
      // `- (select ... where songs @> ...)` de más abajo no hace falta:
      // concatenar ids que ya estén en el array no rompe nada (jsonb no
      // fuerza unicidad), así que se dedupea después con la misma lógica
      // que ya usa `idsOf` — se filtran duplicados client-side al leer.
      // Para no repetir ids YA presentes en el array (y no hacerlo crecer
      // sin sentido en imports repetidos), se restan antes de concatenar.
      const rows = await sql`
        update playlists
        set songs = songs || (
              select coalesce(jsonb_agg(elem), '[]'::jsonb)
              from jsonb_array_elements_text(${JSON.stringify(candidateIds)}::jsonb) as elem
              where not (songs @> jsonb_build_array(elem))
            ),
            updated_at = now()
        where id = ${id} and user_id = ${auth.userId}
        returning jsonb_array_length(songs) as total
      `
      return res.status(200).json({ ok: true, added: candidateIds.length, total: rows[0]?.total ?? null })
    }
    case 'removeSong': {
      const id = String(body.id)
      const songId = String(body.songId)
      const owns = await sql`select 1 from playlists where id = ${id} and user_id = ${auth.userId} limit 1`
      if (owns.length === 0) return res.status(200).json({ ok: false })
      // Mismo fix que addSong: UPDATE atómico en vez de SELECT + UPDATE.
      await sql`
        update playlists
        set songs = songs - ${songId}::text,
            updated_at = now()
        where id = ${id} and user_id = ${auth.userId}
      `
      return res.status(200).json({ ok: true })
    }
    default:
      return res.status(400).json({ error: 'op inválida para playlists' })
  }
}

// --- security (passkeys, 2FA, sesiones) -------------------------------------

interface SessionDTO {
  id: string
  deviceName: string
  ip: string | null
  isCurrent: boolean
  createdAt: string
  lastSeenAt: string
}

function toSessionDTO(row: Record<string, unknown>, currentSessionId: string): SessionDTO {
  return {
    id: row.id as string,
    deviceName: (row.device_name as string) || 'Dispositivo desconocido',
    // El IP completo no viaja al cliente — alcanza con los primeros octetos
    // para reconocer "es de mi casa/laburo" sin exponer el dato entero a
    // quien mire por encima del hombro la pantalla de Ajustes.
    ip: maskIp(row.ip as string | null),
    isCurrent: row.id === currentSessionId,
    createdAt: row.created_at as string,
    lastSeenAt: row.last_seen_at as string,
  }
}

function maskIp(ip: string | null): string | null {
  if (!ip || ip === 'unknown') return null
  if (ip.includes('.')) {
    const parts = ip.split('.')
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.•••` : ip
  }
  if (ip.includes(':')) {
    const parts = ip.split(':')
    return `${parts.slice(0, 3).join(':')}:•••`
  }
  return ip
}

interface CredentialDTO {
  id: string
  deviceName: string
  createdAt: string
  lastUsedAt: string | null
}

function toCredentialDTO(row: Record<string, unknown>): CredentialDTO {
  return {
    id: row.id as string,
    deviceName: (row.device_name as string) || 'Passkey',
    createdAt: row.created_at as string,
    lastUsedAt: (row.last_used_at as string | null) ?? null,
  }
}

async function securityResource(
  op: string,
  body: Record<string, unknown>,
  auth: AuthedSession,
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  switch (op) {
    // --- estado general: lo que pinta el panel de Ajustes → Seguridad al abrir
    case 'status': {
      const userRows = await sql`select totp_enabled from users where id = ${auth.userId} limit 1`
      const credRows = await sql`
        select id, device_name, created_at, last_used_at from webauthn_credentials
        where user_id = ${auth.userId} order by created_at asc
      `
      const sessionRows = await sql`
        select id from sessions where user_id = ${auth.userId} and expires_at > now()
      `
      return res.status(200).json({
        totpEnabled: !!userRows[0]?.totp_enabled,
        passkeys: credRows.map(toCredentialDTO),
        sessionsCount: sessionRows.length,
      })
    }

    // --- sesiones activas --------------------------------------------------
    case 'sessionsList': {
      const rows = await sql`
        select * from sessions where user_id = ${auth.userId} and expires_at > now()
        order by last_seen_at desc
      `
      return res.status(200).json({ sessions: rows.map((r) => toSessionDTO(r, auth.sessionId)) })
    }
    case 'sessionsRevoke': {
      const sessionId = String(body.sessionId || '')
      await sql`delete from sessions where id = ${sessionId} and user_id = ${auth.userId}`
      return res.status(200).json({ ok: true })
    }
    case 'sessionsRevokeOthers': {
      await sql`delete from sessions where user_id = ${auth.userId} and id != ${auth.sessionId}`
      return res.status(200).json({ ok: true })
    }

    // --- 2FA por TOTP --------------------------------------------------------
    // setupStart: genera un secret nuevo y lo guarda YA en users.totp_secret,
    // pero totp_enabled sigue en false hasta que setupVerify confirme que el
    // usuario efectivamente lo cargó en su app autenticadora (si abandona a
    // mitad de camino, el secret queda ahí sin efecto — el próximo
    // setupStart lo pisa sin problema).
    case 'totpSetupStart': {
      const userRows = await sql`select email, totp_enabled from users where id = ${auth.userId} limit 1`
      if (userRows.length === 0) return res.status(404).json({ error: 'usuario no existe' })
      if (userRows[0]!.totp_enabled) return res.status(200).json({ ok: false, reason: 'already_enabled' })

      const secret = generateTotpSecret()
      await sql`update users set totp_secret = ${secret} where id = ${auth.userId}`
      return res.status(200).json({ ok: true, secret, otpauthUrl: totpUri(secret, userRows[0]!.email as string) })
    }
    case 'totpSetupVerify': {
      const code = String(body.code || '').trim()
      const userRows = await sql`select totp_secret from users where id = ${auth.userId} limit 1`
      const secret = userRows[0]?.totp_secret as string | null
      if (!secret) return res.status(200).json({ ok: false, reason: 'not_started' })

      const limit = await checkRateLimit(`2fa-setup:${auth.userId}`, TWOFA_LIMIT.max, TWOFA_LIMIT.windowMs)
      if (!limit.allowed) return res.status(429).json({ ok: false, reason: 'rate_limited' })

      const valid = await verifyTotpCode(secret, code)
      if (!valid) return res.status(200).json({ ok: false, reason: 'invalid_code' })

      const plainCodes = generateBackupCodes()
      const storedCodes: StoredBackupCode[] = await Promise.all(
        plainCodes.map(async (c) => ({ hash: await hashBackupCode(c), usedAt: null })),
      )
      await sql`
        update users set totp_enabled = true, backup_codes = ${JSON.stringify(storedCodes)}
        where id = ${auth.userId}
      `
      // Los códigos en texto plano se devuelven UNA sola vez acá — a partir
      // de este punto el servidor solo guarda sus hashes, así que si el
      // usuario los pierde la única salida es regenerarlos (backupCodesRegenerate).
      return res.status(200).json({ ok: true, backupCodes: plainCodes })
    }
    case 'totpDisable': {
      const password = String(body.password || '')
      const userRows = await sql`select password_hash from users where id = ${auth.userId} limit 1`
      if (userRows.length === 0) return res.status(404).json({ error: 'usuario no existe' })
      // Desactivar 2FA baja la seguridad de la cuenta — se re-pide la
      // contraseña (no alcanza con tener la sesión abierta) para que un
      // token de sesión robado no alcance por sí solo para desarmar el
      // segundo factor.
      const ok = await verifyPassword(userRows[0]!.password_hash as string, password)
      if (!ok) return res.status(200).json({ ok: false, reason: 'wrong_password' })

      await sql`
        update users set totp_enabled = false, totp_secret = null, backup_codes = '[]'::jsonb
        where id = ${auth.userId}
      `
      return res.status(200).json({ ok: true })
    }
    case 'backupCodesRegenerate': {
      const password = String(body.password || '')
      const userRows = await sql`select password_hash, totp_enabled from users where id = ${auth.userId} limit 1`
      if (userRows.length === 0) return res.status(404).json({ error: 'usuario no existe' })
      if (!userRows[0]!.totp_enabled) return res.status(200).json({ ok: false, reason: 'not_enabled' })
      const ok = await verifyPassword(userRows[0]!.password_hash as string, password)
      if (!ok) return res.status(200).json({ ok: false, reason: 'wrong_password' })

      const plainCodes = generateBackupCodes()
      const storedCodes: StoredBackupCode[] = await Promise.all(
        plainCodes.map(async (c) => ({ hash: await hashBackupCode(c), usedAt: null })),
      )
      await sql`update users set backup_codes = ${JSON.stringify(storedCodes)} where id = ${auth.userId}`
      return res.status(200).json({ ok: true, backupCodes: plainCodes })
    }

    // --- passkeys (WebAuthn) -------------------------------------------------
    case 'webauthnList': {
      const rows = await sql`
        select id, device_name, created_at, last_used_at from webauthn_credentials
        where user_id = ${auth.userId} order by created_at asc
      `
      return res.status(200).json({ passkeys: rows.map(toCredentialDTO) })
    }
    case 'webauthnRegisterOptions': {
      const userRows = await sql`select email from users where id = ${auth.userId} limit 1`
      if (userRows.length === 0) return res.status(404).json({ error: 'usuario no existe' })
      const existingRows = await sql`
        select id, transports from webauthn_credentials where user_id = ${auth.userId}
      `
      const existing: CredentialRow[] = existingRows.map((r) => ({
        id: r.id as string,
        publicKey: '',
        counter: 0,
        transports: (r.transports as AuthenticatorTransportFuture[]) || [],
      }))
      const rp = getRpConfig(req)
      const options = await buildRegistrationOptions(rp, auth.userId, userRows[0]!.email as string, existing)
      const challengeToken = generateRandomToken()
      await sql`
        insert into auth_challenges (id, user_id, type, challenge, expires_at)
        values (${challengeToken}, ${auth.userId}, 'webauthn-register', ${options.challenge}, now() + interval '5 minutes')
      `
      return res.status(200).json({ ok: true, options, challengeToken })
    }
    case 'webauthnRegisterVerify': {
      const challengeToken = String(body.challengeToken || '')
      const response = body.response as RegistrationResponseJSON
      const deviceName = String(body.deviceName || '').trim().slice(0, 60) || 'Passkey'

      const challengeRows = await sql`
        delete from auth_challenges
        where id = ${challengeToken} and user_id = ${auth.userId} and type = 'webauthn-register' and expires_at > now()
        returning challenge
      `
      if (challengeRows.length === 0 || !response) return res.status(200).json({ ok: false, reason: 'challenge_expired' })
      const expectedChallenge = challengeRows[0]!.challenge as string

      const rp = getRpConfig(req)
      let verification
      try {
        verification = await checkRegistrationResponse(rp, response, expectedChallenge)
      } catch {
        return res.status(200).json({ ok: false })
      }
      if (!verification.verified || !verification.registrationInfo) return res.status(200).json({ ok: false })

      const { credential } = verification.registrationInfo
      try {
        await sql`
          insert into webauthn_credentials (id, user_id, public_key, counter, transports, device_name)
          values (
            ${credential.id}, ${auth.userId}, ${bytesToBase64(credential.publicKey)}, ${credential.counter},
            ${JSON.stringify(credential.transports || [])}, ${deviceName}
          )
        `
      } catch (err) {
        if (isUniqueViolation(err)) return res.status(200).json({ ok: false, reason: 'already_registered' })
        throw err
      }
      return res.status(200).json({ ok: true })
    }
    case 'webauthnRemove': {
      const credentialId = String(body.credentialId || '')
      await sql`delete from webauthn_credentials where id = ${credentialId} and user_id = ${auth.userId}`
      return res.status(200).json({ ok: true })
    }

    default:
      return res.status(400).json({ error: 'op inválida para security' })
  }
}

// --- devices (sistema de dispositivos / "Spotify Connect") ---------------

async function devicesResource(
  op: string,
  body: Record<string, unknown>,
  auth: AuthedSession,
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  switch (op) {
    // --- heartbeat: cada dispositivo manda esto cada 5s (20s en background,
    // ver useDeviceSync.ts) con su playerState actual. Hace de upsert (crea
    // la fila la primera vez que se ve ese device_key) Y de "sigo vivo".
    case 'heartbeat': {
      const deviceId = sanitizeDeviceId(body.deviceId)
      if (!deviceId) return res.status(400).json({ error: 'deviceId inválido' })

      const userAgent = String(req.headers['user-agent'] || '').slice(0, 512)
      const defaultName = describeDevice(userAgent)
      const kind = classifyDeviceKind(userAgent)
      const playerState = sanitizePlayerState(body.playerState)

      // (xmax = 0) es el truco estándar de Postgres para distinguir un
      // INSERT de un UPDATE dentro del mismo upsert — solo podamos el resto
      // de los dispositivos cuando esta fila es realmente nueva (device_key
      // nunca visto antes para esta cuenta), no en cada heartbeat.
      const rows = await sql`
        insert into devices (user_id, device_key, name, kind, session_id, player_state, last_seen_at)
        values (${auth.userId}, ${deviceId}, ${defaultName}, ${kind}, ${auth.sessionId}, ${JSON.stringify(playerState)}, now())
        on conflict (user_id, device_key) do update
          set kind = excluded.kind,
              session_id = excluded.session_id,
              player_state = excluded.player_state,
              last_seen_at = now(),
              name = case when devices.name_custom then devices.name else excluded.name end
        returning id, (xmax = 0) as inserted
      `
      const deviceRowId = rows[0]!.id as string
      if (rows[0]!.inserted) {
        waitUntil(pruneExcessDevices(auth.userId).catch(() => {}))
      }

      // Igual que Spotify Connect: el dispositivo que está sonando de
      // verdad ahora mismo ES "el activo", sin esperar una transferencia
      // explícita — pero pausar/no tener nada cargado NUNCA le saca el
      // mando a nadie (si sacara el mando al pausar, "pausar" y "perder el
      // control remoto" serían la misma acción, que no es lo que se espera).
      if (playerState?.isPlaying) {
        await sql`
          update devices set is_active = (id = ${deviceRowId})
          where user_id = ${auth.userId} and (id = ${deviceRowId} or is_active = true)
        `
      }
      return res.status(200).json({ ok: true })
    }

    // --- list: lo que pinta DevicesPanel — todos los dispositivos de la
    // cuenta, "online" recalculado acá (nunca confiar en lo que mandó el
    // cliente la última vez) y selfId resuelto por device_key.
    case 'list': {
      const deviceId = sanitizeDeviceId(body.deviceId)
      const rows = await sql`
        select id, device_key, name, kind, is_active, player_state, last_seen_at, created_at
        from devices where user_id = ${auth.userId} order by last_seen_at desc
      `
      const selfRow = deviceId ? rows.find((r) => r.device_key === deviceId) : undefined
      return res.status(200).json({
        devices: rows.map(toDeviceDTO),
        selfId: selfRow ? String(selfRow.id) : null,
      })
    }

    case 'rename': {
      const deviceId = String(body.deviceId || '')
      const name = String(body.name || '').trim().slice(0, DEVICE_NAME_MAX_LEN)
      if (!deviceId || !name) return res.status(200).json({ ok: false })
      const rows = await sql`
        update devices set name = ${name}, name_custom = true
        where id = ${deviceId} and user_id = ${auth.userId}
        returning id
      `
      return res.status(200).json({ ok: rows.length > 0 })
    }

    // --- revoke: "Cerrar sesión en ese dispositivo" del panel — no es solo
    // sacarlo de la lista de Connect, también le mata la sesión de login
    // (si todavía tiene una) para que dependiendo de qué se comparta, no
    // pueda seguir haciendo requests autenticados. Se le avisa YA por Ably
    // (si está configurado) en vez de que se entere recién cuando su
    // próximo request falle con 401.
    case 'revoke': {
      const deviceId = String(body.deviceId || '')
      if (!deviceId) return res.status(200).json({ ok: false })
      const rows = await sql`
        delete from devices where id = ${deviceId} and user_id = ${auth.userId}
        returning device_key, session_id
      `
      if (rows.length === 0) return res.status(200).json({ ok: false })
      const deviceKey = rows[0]!.device_key as string
      const sessionId = rows[0]!.session_id as string | null
      if (sessionId) {
        await sql`delete from sessions where id = ${sessionId} and user_id = ${auth.userId}`
      }
      void publishToDevice(auth.userId, deviceKey, 'command', { type: 'revoked' })
      return res.status(200).json({ ok: true })
    }

    // --- transfer: "Escuchar en otro dispositivo" — el destino pasa a ser
    // el activo YA (con el playerState que mandó quien transfiere, no el
    // que tenía de su último heartbeat propio, que puede estar desactualizado
    // o directamente no existir si nunca sonó nada ahí) y recibe un comando
    // 'transfer' con la canción completa para poder arrancarla de verdad.
    case 'transfer': {
      const targetDeviceId = String(body.targetDeviceId || '')
      if (!targetDeviceId) return res.status(200).json({ ok: false })
      const playerState = sanitizePlayerState(body.playerState)

      const targetRows = await sql`
        update devices set is_active = true, player_state = ${JSON.stringify(playerState)}
        where id = ${targetDeviceId} and user_id = ${auth.userId}
        returning id, device_key
      `
      if (targetRows.length === 0) return res.status(200).json({ ok: false })
      const target = targetRows[0]!
      const deviceKey = target.device_key as string

      await sql`
        update devices set is_active = false
        where user_id = ${auth.userId} and id != ${targetDeviceId} and is_active = true
      `

      const commandId = generateRandomToken(16)
      const payload = {
        song: playerState?.song ?? null,
        currentTime: playerState?.currentTime ?? null,
        isPlaying: playerState?.isPlaying ?? null,
        volume: playerState?.volume ?? null,
      }
      await sql`
        insert into playback_commands (id, user_id, device_key, type, payload)
        values (${commandId}, ${auth.userId}, ${deviceKey}, 'transfer', ${JSON.stringify(payload)})
      `
      void publishToDevice(auth.userId, deviceKey, 'command', { id: commandId, type: 'transfer', payload })
      return res.status(200).json({ ok: true })
    }

    // --- command: control remoto sin transferir (play/pause/seek/
    // setVolume/next/previous) — el dispositivo activo sigue sonando donde
    // está, solo recibe la orden.
    case 'command': {
      const targetDeviceId = String(body.targetDeviceId || '')
      const command = (body.command || {}) as { type?: string; payload?: unknown }
      const type = String(command.type || '')
      if (!targetDeviceId || !ALLOWED_REMOTE_COMMAND_TYPES.has(type)) return res.status(200).json({ ok: false })

      const targetRows = await sql`
        select device_key from devices where id = ${targetDeviceId} and user_id = ${auth.userId} limit 1
      `
      if (targetRows.length === 0) return res.status(200).json({ ok: false })
      const deviceKey = targetRows[0]!.device_key as string
      const payload = sanitizeCommandPayload(type, command.payload)

      const commandId = generateRandomToken(16)
      await sql`
        insert into playback_commands (id, user_id, device_key, type, payload)
        values (${commandId}, ${auth.userId}, ${deviceKey}, ${type}, ${JSON.stringify(payload)})
      `
      void publishToDevice(auth.userId, deviceKey, 'command', { id: commandId, type, payload })
      return res.status(200).json({ ok: true })
    }

    // --- pollCommands: long-poll (hasta POLL_WAIT_MS) que hace de red de
    // seguridad SIEMPRE activa además de Ably (ver el comentario grande en
    // useDeviceSync.ts) y de único canal para sincronizar cambios de cuenta
    // (nickname/avatar/tema) entre dispositivos. Cada vuelta consume (borra)
    // los comandos pendientes de ESTE device_key — entrega exactamente una
    // vez por esta vía; si Ably TAMBIÉN entregó el mismo comando, el cliente
    // ya dedupea por id (ver dedupeAndApply en useDeviceSync.ts).
    case 'pollCommands': {
      const deviceId = sanitizeDeviceId(body.deviceId)
      if (!deviceId) return res.status(400).json({ error: 'deviceId inválido' })
      const knownAccountVersion = Number(body.knownAccountVersion) || 0
      const deadline = Date.now() + POLL_WAIT_MS

      // Limpieza oportunista de comandos que nadie vino a buscar (el
      // dispositivo destino cerró la pestaña, revocó su sesión, etc.) —
      // apoyada en el tráfico que ya existe, sin necesidad de un cron aparte.
      waitUntil(
        sql`delete from playback_commands where created_at < now() - (${COMMAND_MAX_AGE_MS} * interval '1 millisecond')`.catch(
          () => {},
        ),
      )

      for (;;) {
        const rows = await sql`
          with cmds as (
            delete from playback_commands
            where id in (
              select id from playback_commands
              where user_id = ${auth.userId} and device_key = ${deviceId}
              order by created_at asc limit 20
            )
            returning id, type, payload
          )
          select
            (select coalesce(json_agg(json_build_object('id', id, 'type', type, 'payload', payload)), '[]'::json) from cmds) as commands,
            (select extract(epoch from updated_at) * 1000 from users where id = ${auth.userId}) as account_version
        `
        const row = rows[0]
        const commands = (row?.commands as unknown[]) ?? []
        const accountVersionRaw = row?.account_version
        const accountVersion = accountVersionRaw != null ? Math.floor(Number(accountVersionRaw)) : knownAccountVersion

        if (commands.length > 0 || accountVersion > knownAccountVersion || Date.now() >= deadline) {
          return res.status(200).json({ commands, accountVersion })
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_STEP_MS))
      }
    }

    // --- realtimeToken: token de Ably de corta duración restringido al
    // canal privado de ESTE dispositivo — ver mintDeviceToken() en
    // realtime.ts. null si ABLY_API_KEY no está configurada; el cliente lo
    // interpreta como "seguir solo con el long-poll", nunca como error.
    case 'realtimeToken': {
      const deviceId = sanitizeDeviceId(body.deviceId)
      if (!deviceId) return res.status(200).json({ ok: false, tokenRequest: null })
      const tokenRequest = await mintDeviceToken(auth.userId, deviceId)
      return res.status(200).json({ ok: true, tokenRequest })
    }

    default:
      return res.status(400).json({ error: 'op inválida para devices' })
  }
}

function sanitizeDeviceId(raw: unknown): string | null {
  const id = String(raw || '').trim().slice(0, DEVICE_ID_MAX_LEN)
  return id || null
}

/** 'mobile' para teléfonos (icono Smartphone en DevicesPanel), 'desktop'
 *  para todo lo demás (icono Monitor) — sin más granularidad porque el
 *  cliente no manda ninguna pista propia, solo tenemos el User-Agent. */
function classifyDeviceKind(userAgent: string): 'web' | 'mobile' | 'desktop' {
  if (/Mobi|Android|iPhone|iPod/.test(userAgent)) return 'mobile'
  return userAgent ? 'desktop' : 'web'
}

const PLAYER_STATE_TEXT_MAX_LEN = 300
const PLAYER_STATE_URL_MAX_LEN = 2000

/** Valida/recorta el playerState que manda el cliente (heartbeat/transfer)
 *  antes de guardarlo — nunca confiar ciegamente en JSON arbitrario del
 *  cliente en una fila que van a leer OTROS dispositivos de la misma
 *  cuenta. `updatedAt` lo pone el servidor siempre (nunca el reloj del
 *  cliente, que puede estar desfasado) — es el ancla que usa
 *  useLivePlayerPosition del lado de quien lo recibe. */
function sanitizePlayerState(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const songRaw = r.song
  let song: Record<string, unknown> | null = null
  if (songRaw && typeof songRaw === 'object') {
    const s = songRaw as Record<string, unknown>
    if (s.id != null) {
      song = {
        id: s.id,
        title: s.title != null ? String(s.title).slice(0, PLAYER_STATE_TEXT_MAX_LEN) : undefined,
        artist: s.artist != null ? String(s.artist).slice(0, PLAYER_STATE_TEXT_MAX_LEN) : undefined,
        albumArtUrl: typeof s.albumArtUrl === 'string' ? s.albumArtUrl.slice(0, PLAYER_STATE_URL_MAX_LEN) : null,
        album: s.album != null ? String(s.album).slice(0, PLAYER_STATE_TEXT_MAX_LEN) : null,
        duration: typeof s.duration === 'number' && Number.isFinite(s.duration) ? s.duration : null,
        videoId: typeof s.videoId === 'string' ? s.videoId.slice(0, 64) : null,
        source: typeof s.source === 'string' ? s.source.slice(0, 32) : null,
        audioSrc: typeof s.audioSrc === 'string' ? s.audioSrc.slice(0, PLAYER_STATE_URL_MAX_LEN) : null,
        streamUrl: typeof s.streamUrl === 'string' ? s.streamUrl.slice(0, PLAYER_STATE_URL_MAX_LEN) : null,
        isExternal: !!s.isExternal,
      }
    }
  }
  return {
    song,
    currentTime: typeof r.currentTime === 'number' && Number.isFinite(r.currentTime) ? Math.max(0, r.currentTime) : null,
    isPlaying: !!r.isPlaying,
    volume: typeof r.volume === 'number' && Number.isFinite(r.volume) ? Math.min(1, Math.max(0, r.volume)) : null,
    updatedAt: Date.now(),
  }
}

function sanitizeCommandPayload(type: string, raw: unknown): Record<string, unknown> | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (type === 'setVolume') {
    const volume = typeof r.volume === 'number' && Number.isFinite(r.volume) ? Math.min(1, Math.max(0, r.volume)) : null
    return volume == null ? null : { volume }
  }
  if (type === 'seek') {
    const time = typeof r.time === 'number' && Number.isFinite(r.time) ? Math.max(0, r.time) : null
    return time == null ? null : { time }
  }
  return null
}

function toDeviceDTO(row: Record<string, unknown>) {
  const lastSeenIso = row.last_seen_at as string
  const online = Date.now() - new Date(lastSeenIso).getTime() < DEVICE_ONLINE_THRESHOLD_MS
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    isActive: !!row.is_active,
    online,
    playerState: row.player_state ?? null,
    lastSeen: lastSeenIso,
    createdAt: row.created_at,
  }
}

/** Solo corre cuando aparece un device_key NUEVO (ver `inserted` en el
 *  upsert de heartbeat) — nunca en cada heartbeat de un dispositivo ya
 *  conocido, para no sumar una query extra al camino más caliente. */
async function pruneExcessDevices(userId: string): Promise<void> {
  await sql`
    delete from devices where id in (
      select id from devices where user_id = ${userId}
      order by last_seen_at desc offset ${MAX_DEVICES_PER_USER}
    )
  `
}

// MEJORA (envenenamiento de catálogo compartido): `songs` es UNA fila por
// id para TODOS los usuarios — antes, cualquiera con sesión podía mandar
// `addSong`/`addSongs` con un id de una canción real (que ya está en la
// playlist de otra persona) y un `song` completamente inventado, y el
// ON CONFLICT DO UPDATE lo pisaba sin preguntar. Resultado: un usuario
// podía reescribir el título/artista/portada/URL de audio que ve CUALQUIER
// otro usuario para ese id, sin que su propia cuenta quedara comprometida
// para lograrlo.
//
// Fix: "primero en escribir, gana" — ON CONFLICT DO NOTHING. La primera
// vez que un id entra al catálogo (típicamente resuelto desde una fuente
// real: YT Music/Spotify/iTunes) su metadata queda fija; intentos
// posteriores de "actualizarla" desde el cliente ya no tienen efecto, solo
// referencian lo que ya hay. Se pierde la posibilidad de un refresh
// legítimo (ej. una portada que cambió de URL), pero es preferible a que
// cualquier cuenta pueda reescribir lo que ve todo el mundo; si hace falta
// refrescar metadata más adelante, mejor hacerlo server-side contra la
// fuente real, no confiando en el JSON que manda el cliente.
const MAX_SONG_JSON_BYTES = 8 * 1024 // tope defensivo: ninguna metadata real pesa esto

/**
 * Upsert de una canción al catálogo compartido (tabla `songs`, una sola
 * copia de metadata sin importar en cuántas playlists termine referenciada).
 * Devuelve false cuando vino solo un id (sin objeto) y ese id todavía no
 * existe en el catálogo — no hay metadata que guardar, no se puede
 * referenciar. Extraído de `addSong` para poder reusarlo en `addSongs` sin
 * duplicar la lógica.
 */
async function upsertCatalogEntry(candidateId: string, fullSong: Record<string, unknown> | null): Promise<boolean> {
  if (fullSong) {
    const json = JSON.stringify(fullSong)
    if (json.length > MAX_SONG_JSON_BYTES) return false
    await sql`
      insert into songs (id, data) values (${candidateId}, ${json})
      on conflict (id) do nothing
    `
    return true
  }
  const inCatalog = await sql`select 1 from songs where id = ${candidateId} limit 1`
  return inCatalog.length > 0
}

/**
 * Variante en lote de upsertCatalogEntry: resuelve TODA una lista de
 * canciones (mezcla de objetos completos e ids sueltos) en como mucho 2
 * round-trips a Neon en vez de 1 por canción — usada por addSongs y por la
 * migración desde IndexedDB. Mismo criterio de "primero en escribir, gana"
 * (on conflict do nothing) que upsertCatalogEntry.
 */
async function resolveCatalogIdsBatch(
  songs: (Record<string, unknown> | string | number)[],
): Promise<string[]> {
  const fullIds: string[] = []
  const fullData: string[] = []
  const bareIds: string[] = []
  const order: { id: string; full: boolean }[] = []

  for (const song of songs) {
    const isFullSong = song !== null && typeof song === 'object'
    const candidateId = String(isFullSong ? (song as Record<string, unknown>).id : song)
    if (!candidateId) continue
    if (isFullSong) {
      const json = JSON.stringify(song)
      if (json.length > MAX_SONG_JSON_BYTES) continue
      fullIds.push(candidateId)
      fullData.push(json)
    } else {
      bareIds.push(candidateId)
    }
    order.push({ id: candidateId, full: isFullSong })
  }

  if (fullIds.length > 0) {
    // Un solo INSERT multi-fila: unnest empareja los dos arrays posición a
    // posición, así que cada (id, data) llega como su propia fila. Postgres
    // resuelve el conflicto fila por fila igual que N inserts separados,
    // pero en una sola sentencia/round-trip.
    await sql`
      insert into songs (id, data)
      select * from unnest(${fullIds}::text[], ${fullData}::jsonb[]) as t(id, data)
      on conflict (id) do nothing
    `
  }

  let existingBare = new Set<string>()
  if (bareIds.length > 0) {
    const uniqueBare = [...new Set(bareIds)]
    const rows = await sql`select id from songs where id = any(${uniqueBare})`
    existingBare = new Set(rows.map((r) => String(r.id)))
  }

  const out: string[] = []
  for (const { id, full } of order) {
    if (full || existingBare.has(id)) out.push(id)
  }
  return out
}

function idsOf(row: Record<string, unknown>): string[] {
  return ((row.songs as unknown[]) || []).map(String)
}

/** Trae del catálogo, en UNA sola query, la metadata de un lote de IDs. */
async function fetchCatalog(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>()
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return map
  const rows = await sql`select id, data from songs where id = any(${uniqueIds})`
  for (const row of rows) map.set(String(row.id), row.data as Record<string, unknown>)
  return map
}

function toPlaylistDTO(row: Record<string, unknown>, catalog: Map<string, Record<string, unknown>>) {
  const songIds = idsOf(row)
  const songs = songIds.map((id) => catalog.get(id)).filter((s): s is Record<string, unknown> => Boolean(s))
  return {
    id: row.id,
    userEmail: undefined, // se completa client-side desde currentUser; ya no viaja server-side
    name: row.name,
    description: row.description,
    songs,
    songIds,
    coverUrl: row.cover_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// --- temas personalizados ---------------------------------------------------

async function themesResource(
  op: string,
  body: Record<string, unknown>,
  auth: AuthedSession,
  res: VercelResponse,
): Promise<VercelResponse> {
  switch (op) {
    case 'list': {
      const rows = await sql`select * from custom_themes where user_id = ${auth.userId} order by created_at asc`
      return res.status(200).json({ themes: rows.map(toThemeDTO) })
    }
    case 'save': {
      const theme = (body.theme || {}) as { id?: string; name?: string; colors?: Record<string, string> }
      if (!theme.id || !theme.name) return res.status(200).json({ ok: false })
      // MEJORA (IDOR): el id lo genera el cliente (`custom_${randomUUID().slice(0,8)}`,
      // 32 bits de entropía) y antes el ON CONFLICT actualizaba name/colors sin
      // volver a chequear el dueño de la fila — alguien que adivinara/fuerza bruta
      // el id de OTRO usuario podía sobrescribirle su tema. El WHERE en el DO UPDATE
      // hace que el conflicto solo aplique si la fila existente ya es tuya; si el id
      // choca con el tema de otro usuario, esa rama no matchea y no se toca nada.
      const rows = await sql`
        insert into custom_themes (id, user_id, name, colors)
        values (${theme.id}, ${auth.userId}, ${theme.name}, ${JSON.stringify(theme.colors || {})})
        on conflict (id) do update set name = excluded.name, colors = excluded.colors
        where custom_themes.user_id = ${auth.userId}
        returning id
      `
      if (rows.length === 0) return res.status(200).json({ ok: false, reason: 'id_taken' })
      // MEJORA: pollCommands (ver devicesResource) usa users.updated_at como
      // "versión de cuenta" para avisarle a los OTROS dispositivos que hay
      // algo nuevo que traer (nickname/avatar/preferencias/temas — ver el
      // comentario grande de useDeviceSync.ts). Sin este bump, un tema
      // custom nuevo o editado nunca disparaba esa sync entre dispositivos:
      // quedaba guardado en el servidor pero solo visible localmente hasta
      // el próximo refresh manual.
      waitUntil(sql`update users set updated_at = now() where id = ${auth.userId}`.catch(() => {}))
      return res.status(200).json({ ok: true })
    }
    case 'remove': {
      await sql`delete from custom_themes where id = ${String(body.id)} and user_id = ${auth.userId}`
      waitUntil(sql`update users set updated_at = now() where id = ${auth.userId}`.catch(() => {}))
      return res.status(200).json({ ok: true })
    }
    default:
      return res.status(400).json({ error: 'op inválida para themes' })
  }
}

function toThemeDTO(row: Record<string, unknown>) {
  return { id: row.id, userEmail: undefined, name: row.name, colors: row.colors }
}

// --- migración desde IndexedDB ----------------------------------------------

interface MigratePayload {
  preferences?: Record<string, unknown>
  favorites?: Record<string, unknown>[]
  playlists?: { name: string; description?: string; songs?: Record<string, unknown>[]; coverUrl?: string | null }[]
  customThemes?: { id: string; name: string; colors: Record<string, string> }[]
}

async function migrateResource(
  op: string,
  body: Record<string, unknown>,
  auth: AuthedSession,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (op !== 'import') return res.status(400).json({ error: 'op inválida para migrate' })

  const userRows = await sql`select preferences from users where id = ${auth.userId} limit 1`
  const currentPrefs = (userRows[0]?.preferences as Record<string, unknown>) || {}
  if (currentPrefs.migratedLegacy) {
    return res.status(200).json({ ok: true, skipped: true })
  }

  const payload = (body.payload || {}) as MigratePayload

  // Preferencias + favoritos: se fusionan sobre las que ya existan en el
  // servidor (por si el usuario ya usó la app en otro dispositivo primero).
  const mergedFavorites = dedupeSongs([
    ...(((currentPrefs.favorites as Record<string, unknown>[]) || [])),
    ...(payload.favorites || []),
  ])
  const nextPrefs = {
    ...(payload.preferences || {}),
    ...currentPrefs,
    favorites: mergedFavorites,
    migratedLegacy: true,
  }
  // MEJORA: el chequeo de `migratedLegacy` de arriba es un SELECT — dos
  // pestañas del mismo usuario disparando la migración casi al mismo
  // tiempo (ej. login en dos dispositivos apenas después de registrarse)
  // podían pasar ambas ese chequeo antes de que cualquiera escribiera el
  // flag, y las dos terminaban corriendo el loop de `insert into
  // playlists` de más abajo — mismas playlists duplicadas dos veces. El
  // `where` de este UPDATE hace que el flag solo se pueda setear una vez:
  // si dos requests llegan a la vez, el UPDATE de Postgres las serializa
  // (misma garantía que en addSong) y la segunda ve `migratedLegacy` ya en
  // `true` en su propio WHERE, así que no actualiza ninguna fila.
  const flagged = await sql`
    update users set preferences = ${JSON.stringify(nextPrefs)}, updated_at = now()
    where id = ${auth.userId}
      and coalesce((preferences->>'migratedLegacy')::boolean, false) = false
    returning id
  `
  if (flagged.length === 0) {
    // Otra request ganó la carrera y ya migró — no duplicar playlists/temas.
    return res.status(200).json({ ok: true, skipped: true })
  }

  // MEJORA de performance: esto antes hacía, por cada playlist importada, un
  // INSERT a `songs` por CADA canción de esa playlist más un INSERT para la
  // playlist misma — con una cuenta de Spotify de varios cientos de
  // canciones repartidas en varias playlists, fácilmente varios cientos de
  // round-trips HTTP secuenciales a Neon (mismo patrón que tenía addSongs,
  // ver resolveCatalogIdsBatch más arriba) durante una migración que además
  // corre una sola vez al loguearse por primera vez, bloqueando ese login.
  // Se junta TODA la metadata de canciones de TODAS las playlists en un
  // único batch (dedupeada, primero-en-aparecer gana) y se resuelven las
  // playlists con un solo INSERT multi-fila vía unnest — de "cientos de
  // queries" pasa a un puñado, sin importar cuántas playlists/canciones
  // traiga la migración.
  const playlistsIn = (payload.playlists || []).filter((p) => p.name?.trim())
  const allSongs = playlistsIn.flatMap((p) => p.songs || [])
  await resolveCatalogIdsBatch(allSongs as (Record<string, unknown> | string | number)[])

  if (playlistsIn.length > 0) {
    const names = playlistsIn.map((p) => p.name.trim())
    const descriptions = playlistsIn.map((p) => p.description || '')
    const songIdArrays = playlistsIn.map((p) =>
      JSON.stringify((p.songs || []).map((s) => String((s as Record<string, unknown>).id ?? '')).filter(Boolean)),
    )
    const coverUrls = playlistsIn.map((p) => p.coverUrl ?? null)
    await sql`
      insert into playlists (user_id, name, description, songs, cover_url)
      select ${auth.userId}, name, description, songs, cover_url
      from unnest(${names}::text[], ${descriptions}::text[], ${songIdArrays}::jsonb[], ${coverUrls}::text[])
        as t(name, description, songs, cover_url)
    `
  }

  const themesIn = (payload.customThemes || []).filter((t) => t.id && t.name)
  if (themesIn.length > 0) {
    const ids = themesIn.map((t) => t.id)
    const names = themesIn.map((t) => t.name)
    const colors = themesIn.map((t) => JSON.stringify(t.colors || {}))
    await sql`
      insert into custom_themes (id, user_id, name, colors)
      select id, ${auth.userId}, name, colors
      from unnest(${ids}::text[], ${names}::text[], ${colors}::jsonb[]) as t(id, name, colors)
      on conflict (id) do nothing
    `
  }

  return res.status(200).json({ ok: true, skipped: false })
}

function dedupeSongs(songs: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>()
  const out: Record<string, unknown>[] = []
  for (const s of songs) {
    const key = `${String(s.title || '').toLowerCase()}::${String(s.artist || '').toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}
