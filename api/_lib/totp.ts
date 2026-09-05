/**
 * TOTP (RFC 6238) + códigos de respaldo, implementado a mano con Web Crypto
 * (mismo runtime que accountAuth.ts) para no sumar una dependencia nueva
 * solo por HMAC-SHA1 + Base32. Compatible con cualquier app autenticadora
 * estándar (Google Authenticator, Authy, 1Password, Bitwarden, Microsoft
 * Authenticator...).
 */
import { webcrypto as crypto } from 'node:crypto'

const STEP_SECONDS = 30
const DIGITS = 6
// Cuántos pasos de 30s hacia atrás/adelante se aceptan al verificar, para
// tolerar reloj desincronizado entre el teléfono del usuario y nuestro
// servidor — ±1 paso (30s) es el margen estándar que usan la mayoría de las
// apps (Google/GitHub/etc), sin abrir una ventana tan grande que facilite
// fuerza bruta.
const WINDOW_STEPS = 1

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Secret de 160 bits (tamaño estándar recomendado por RFC 4226), en Base32. */
export function generateTotpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return base32Encode(bytes)
}

/** URI otpauth:// que codifica el QR — lo lee cualquier app autenticadora. */
export function totpUri(secret: string, email: string): string {
  const label = encodeURIComponent(`XFY:${email}`)
  const issuer = encodeURIComponent('XFY')
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`
}

export async function verifyTotpCode(secret: string | null | undefined, code: string): Promise<boolean> {
  if (!secret) return false
  const clean = String(code || '').replace(/\s+/g, '')
  if (!/^\d{6}$/.test(clean)) return false
  const key = base32Decode(secret)
  if (key.length === 0) return false
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS)
  for (let offset = -WINDOW_STEPS; offset <= WINDOW_STEPS; offset += 1) {
    const expected = await hotp(key, counter + offset)
    if (timingSafeEqualStr(expected, clean)) return true
  }
  return false
}

async function hotp(key: Uint8Array, counter: number): Promise<string> {
  const counterBytes = new Uint8Array(8)
  let c = BigInt(counter)
  for (let i = 7; i >= 0; i -= 1) {
    counterBytes[i] = Number(c & 0xffn)
    c >>= 8n
  }
  // Cast a BufferSource: node:crypto tipa su Uint8Array como
  // Uint8Array<ArrayBufferLike> (TS 5.7+), pero en runtime siempre son
  // buffers reales — el cast es solo para calmar al compilador, no cambia
  // ningún comportamiento.
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as NodeJS.BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, counterBytes as NodeJS.BufferSource))
  const offset = sig[sig.length - 1]! & 0x0f
  const binCode =
    ((sig[offset]! & 0x7f) << 24) |
    ((sig[offset + 1]! & 0xff) << 16) |
    ((sig[offset + 2]! & 0xff) << 8) |
    (sig[offset + 3]! & 0xff)
  return String(binCode % 10 ** DIGITS).padStart(DIGITS, '0')
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(bytes)
}

// --- códigos de respaldo ---------------------------------------------------

export interface StoredBackupCode {
  hash: string
  usedAt: string | null
}

/** 10 códigos de un solo uso, formato XXXX-XXXX (mismo alfabeto que Base32
 *  para que no haya ambigüedad 0/O 1/I al transcribirlos a mano). */
export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(5))
    const raw = base32Encode(bytes).slice(0, 8)
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`)
  }
  return codes
}

/** Nunca se guarda el código en texto plano — mismo criterio que
 *  password_hash en accountAuth.ts, solo que acá alcanza con SHA-256 liso
 *  (son de un solo uso y de alta entropía, no hace falta el costo de
 *  PBKDF2 pensado para resistir diccionarios de passwords humanas). */
export async function hashBackupCode(code: string): Promise<string> {
  const normalized = code.trim().toUpperCase()
  const data = new TextEncoder().encode(normalized)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Índice del código sin usar que matchea, o -1. Consume: el caller debe
 *  marcar codes[índice].usedAt y persistir el array actualizado. */
export async function findUnusedBackupCode(codes: StoredBackupCode[], code: string): Promise<number> {
  if (!code.trim()) return -1
  const hash = await hashBackupCode(code)
  return codes.findIndex((c) => !c.usedAt && timingSafeEqualStr(c.hash, hash))
}
