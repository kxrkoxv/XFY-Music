/**
 * Passkeys / WebAuthn — wrapper fino sobre @simplewebauthn/server con la
 * config de XFY. rpID/origin se derivan del host de la request salvo que
 * WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN estén seteadas en el entorno — conviene
 * fijarlas en producción para no depender del host que reenvía el proxy de
 * Vercel (y porque el rpID de una passkey queda atado para siempre al
 * dominio con el que se registró: si cambia, las passkeys viejas dejan de
 * poder usarse ahí).
 */
import type { VercelRequest } from '@vercel/node'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  WebAuthnCredential,
} from '@simplewebauthn/server'

export interface RpConfig {
  rpID: string
  rpName: string
  origin: string
}

// MEJORA: se avisa una sola vez por instancia tibia si se está corriendo el
// fallback de headers en vez de las env vars fijas — X-Forwarded-Host y
// X-Forwarded-Proto los agrega el proxy de Vercel, pero en teoría son
// headers, y confiar en ellos para derivar rpID/origin es más débil que una
// config fija. No es explotable hoy (Vercel controla ese proxy), pero si el
// deploy alguna vez queda detrás de otro proxy que reenvíe headers del
// cliente sin sanitizar, esto deja de ser cierto — de ahí el warning.
let warnedFallback = false

export function getRpConfig(req: VercelRequest): RpConfig {
  const envId = process.env.WEBAUTHN_RP_ID
  const envOrigin = process.env.WEBAUTHN_ORIGIN
  if (envId && envOrigin) return { rpID: envId, rpName: 'XFY', origin: envOrigin }
  if (!warnedFallback) {
    warnedFallback = true
    console.warn(
      '[webauthn] WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN no están seteadas — derivando rpID/origin de ' +
        'X-Forwarded-Host/Proto. Fijalas en las env vars de producción; si no, las passkeys quedan ' +
        'atadas al host que reenvíe el proxy en cada request.',
    )
  }
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost')
  const proto = String(req.headers['x-forwarded-proto'] || 'https')
  return { rpID: host.split(':')[0] || 'localhost', rpName: 'XFY', origin: `${proto}://${host}` }
}

export interface CredentialRow {
  id: string // credential id, base64url — también es la primary key en webauthn_credentials
  publicKey: string // clave pública COSE, base64 (NO base64url — ver bytesToBase64/base64ToBytes)
  counter: number
  transports: AuthenticatorTransportFuture[]
}

export function buildRegistrationOptions(rp: RpConfig, userId: string, userEmail: string, existing: CredentialRow[]) {
  return generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: userEmail,
    userID: new TextEncoder().encode(userId),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  })
}

export function checkRegistrationResponse(rp: RpConfig, response: RegistrationResponseJSON, expectedChallenge: string) {
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
  })
}

export function buildAuthenticationOptions(
  rp: RpConfig,
  allowCredentials?: { id: string; transports?: AuthenticatorTransportFuture[] }[],
) {
  return generateAuthenticationOptions({
    rpID: rp.rpID,
    // Sin allowCredentials: login "usernameless" — el browser deja elegir
    // entre las passkeys guardadas para este sitio (discoverable
    // credentials), que es como Apple/Google/1Password lo muestran hoy.
    allowCredentials,
    userVerification: 'preferred',
  })
}

export function checkAuthenticationResponse(
  rp: RpConfig,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  credential: CredentialRow,
) {
  const webAuthnCredential: WebAuthnCredential = {
    id: credential.id,
    publicKey: base64ToBytes(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
  }
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential: webAuthnCredential,
  })
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

// Cast a Uint8Array<ArrayBuffer>: incluso con un ArrayBuffer real atrás,
// TS 5.7+ infiere Uint8Array<ArrayBufferLike> acá — WebAuthnCredential
// exige el tipo más específico. Ver el comentario equivalente en totp.ts.
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(b64, 'base64')) as Uint8Array<ArrayBuffer>
}
