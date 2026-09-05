// ============================================================
// PKCE (Proof Key for Code Exchange) para el login real de Spotify
// (Authorization Code Flow). No depende de ninguna librería — solo
// Web Crypto, disponible en cualquier navegador moderno bajo HTTPS
// (o localhost) que es donde corre XFY.
//
// Flujo: generateCodeVerifier() se guarda en sessionStorage y viaja
// "de ida" como code_challenge (su hash SHA-256 en base64url) dentro
// de la URL de autorización; a la vuelta, el verifier original se
// manda al backend para probar que quien pide el token es el mismo
// cliente que inició el login (sin necesitar un client secret en el
// navegador).
// ============================================================

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** String aleatorio criptográficamente seguro, 43-128 chars (spec RFC 7636). */
export function generateCodeVerifier(): string {
  const bytes = window.crypto.getRandomValues(new Uint8Array(64))
  return base64UrlEncode(bytes)
}

/** SHA-256(verifier) en base64url — lo que efectivamente viaja en la URL. */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const enc = new TextEncoder().encode(verifier)
  const digest = await window.crypto.subtle.digest('SHA-256', enc)
  return base64UrlEncode(new Uint8Array(digest))
}

/** Token anti-CSRF para el parámetro `state` del flujo OAuth. */
export function generateState(): string {
  return base64UrlEncode(window.crypto.getRandomValues(new Uint8Array(16)))
}
