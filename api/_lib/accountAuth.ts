/**
 * Contraseñas: MISMO algoritmo (PBKDF2-SHA256, 100k iteraciones, formato
 * "saltHex:hashHex") que usaba AppDB en IndexedDB. Correr esto server-side
 * con Web Crypto (disponible en el runtime Node de Vercel) significa que
 * las contraseñas migradas de usuarios viejos verifican tal cual, sin
 * pedirles que las reseteen.
 */
import type { VercelRequest } from '@vercel/node'
import { webcrypto as crypto } from 'node:crypto'
import { waitUntil } from '@vercel/functions'
import { sql } from './accountDb.ts'

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await deriveHash(password, salt)
  return `${toHex(salt)}:${toHex(hash)}`
}

export async function verifyPassword(storedHash: string | null | undefined, password: string): Promise<boolean> {
  if (!storedHash || !password) return false
  const [saltHex, originalHash] = storedHash.split(':')
  if (!saltHex || !originalHash) return false
  try {
    const salt = fromHex(saltHex)
    const derived = await deriveHash(password, salt)
    // MEJORA: comparación en tiempo constante. `===` sobre strings corta
    // en el primer carácter que difiere, así que el tiempo de respuesta
    // de un intento de login filtra (mínimamente, pero es gratis evitarlo)
    // cuántos caracteres del hash acertaste. `timingSafeEqualHex` siempre
    // recorre el hash completo sin importar dónde está la primera
    // diferencia.
    return timingSafeEqualHex(toHex(derived), originalHash)
  } catch {
    return false
  }
}

/**
 * Login para un email que no existe en la base: hoy el caller (accountResources)
 * simplemente no llama a `verifyPassword` en ese caso, así que esa request
 * responde más rápido que un login con email válido pero password incorrecta
 * — un side-channel de bajo riesgo (permite inferir por timing qué emails
 * están registrados) pero gratis de tapar. `dummyVerify` hace el mismo
 * trabajo de PBKDF2 contra un hash fijo, para que el "no existe" tarde
 * aproximadamente lo mismo que el "existe pero password mal".
 */
const DUMMY_HASH = `${'00'.repeat(16)}:${'00'.repeat(32)}` // salt de 16 bytes, hash de 32 bytes — mismo formato que hashPassword
export async function dummyVerify(password: string): Promise<void> {
  await verifyPassword(DUMMY_HASH, password || 'x').catch(() => {})
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function deriveHash(password: string, salt: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, [
    'deriveKey',
  ])
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
  const exported = await crypto.subtle.exportKey('raw', key)
  return new Uint8Array(exported)
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const matches = hex.match(/.{1,2}/g) ?? []
  return new Uint8Array(matches.map((b) => Number.parseInt(b, 16)))
}

// --- Tokens de sesión / challenges ----------------------------------------
export function generateSessionToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

/** Mismo generador que generateSessionToken, con otro nombre para los usos
 *  que no son "el token que guarda el cliente en localStorage" (challenges
 *  de WebAuthn, token de 2FA pendiente) — mantenerlos como funciones
 *  separadas deja más claro en accountResources.ts qué es cada cosa. */
export function generateRandomToken(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

/**
 * MEJORA: antes una sesión no vencía nunca — un token filtrado (log, XSS en
 * otra parte, dispositivo robado) servía para siempre, incluso años después.
 * Ahora cada login expira a los 30 días; createSession() en
 * accountResources.ts es quien escribe expires_at, y requireAuth() de abajo
 * es quien lo valida en cada request.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface AuthedSession {
  sessionId: string
  userId: string
  email: string
  nickname: string
}

/** Resuelve el Authorization: Bearer <token> a un usuario + sesión, o null si no es válido. */
export async function requireAuth(req: VercelRequest): Promise<AuthedSession | null> {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return null

  const rows = await sql`
    select s.id as session_id, s.last_seen_at, u.id as user_id, u.email, u.nickname
    from sessions s
    join users u on u.id = s.user_id
    where s.token = ${token} and s.expires_at > now()
    limit 1
  `
  if (rows.length === 0) return null
  const row = rows[0]!

  // "Última vez visto" para la lista de sesiones en Ajustes → Seguridad —
  // se actualiza en segundo plano (waitUntil, no se espera) y solo si pasaron
  // más de 5 min desde el último touch, así no suma un UPDATE por cada
  // request autenticado (que sería la mayoría del tráfico de la app).
  const lastSeen = row.last_seen_at ? new Date(row.last_seen_at as string).getTime() : 0
  if (Date.now() - lastSeen > 5 * 60 * 1000) {
    waitUntil(
      sql`update sessions set last_seen_at = now() where id = ${row.session_id as string}`.catch(() => {}),
    )
  }

  return {
    sessionId: row.session_id as string,
    userId: row.user_id as string,
    email: row.email as string,
    nickname: row.nickname as string,
  }
}
