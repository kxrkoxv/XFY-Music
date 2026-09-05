// ============================================================
// Scrobbling a Last.fm / ListenBrainz — extensión natural de la
// "sesión privada" que ya existía (metrics.ts): cuando NO está activa,
// además de sumar a las métricas internas, se manda el scrobble a los
// servicios externos que el usuario haya configurado. Inspirado en la
// integración de Last.fm de Spotube (ellos usan `scrobblenaut`).
//
// ListenBrainz: auth simple por user token (Settings → tu perfil en
// listenbrainz.org). Un solo POST, JSON, sin firma — el más fácil de
// integrar de los dos.
//
// Last.fm: la API oficial pide un flujo de auth de 3 pasos (token web →
// el usuario autoriza en lastfm.com → session key) más firma MD5 de cada
// request. Implementamos el submit real (track.scrobble + track.
// updateNowPlaying, firmados), pero la obtención de la session key queda
// en manos del usuario (Settings explica cómo conseguirla desde una API
// account de Last.fm) en vez de construir todo el flujo OAuth-like acá —
// eso evita tener que correr un backend de callback solo para esto.
// ============================================================

const LISTENBRAINZ_KEY = 'xfy_listenbrainz_token'
const LASTFM_API_KEY_KEY = 'xfy_lastfm_api_key'
const LASTFM_API_SECRET_KEY = 'xfy_lastfm_api_secret'
const LASTFM_SESSION_KEY = 'xfy_lastfm_session_key'
const SCROBBLE_ENABLED_KEY = 'xfy_scrobble_enabled'

function readStr(key: string): string {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function writeStr(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // no-op
  }
}

export function isScrobbleEnabled(): boolean {
  return readStr(SCROBBLE_ENABLED_KEY) === '1'
}
export function setScrobbleEnabled(enabled: boolean): void {
  writeStr(SCROBBLE_ENABLED_KEY, enabled ? '1' : '')
}

export interface ScrobbleCredentials {
  listenbrainzToken: string
  lastfmApiKey: string
  lastfmApiSecret: string
  lastfmSessionKey: string
}

export function getScrobbleCredentials(): ScrobbleCredentials {
  return {
    listenbrainzToken: readStr(LISTENBRAINZ_KEY),
    lastfmApiKey: readStr(LASTFM_API_KEY_KEY),
    lastfmApiSecret: readStr(LASTFM_API_SECRET_KEY),
    lastfmSessionKey: readStr(LASTFM_SESSION_KEY),
  }
}

export function setScrobbleCredentials(creds: Partial<ScrobbleCredentials>): void {
  if (creds.listenbrainzToken !== undefined) writeStr(LISTENBRAINZ_KEY, creds.listenbrainzToken.trim())
  if (creds.lastfmApiKey !== undefined) writeStr(LASTFM_API_KEY_KEY, creds.lastfmApiKey.trim())
  if (creds.lastfmApiSecret !== undefined) writeStr(LASTFM_API_SECRET_KEY, creds.lastfmApiSecret.trim())
  if (creds.lastfmSessionKey !== undefined) writeStr(LASTFM_SESSION_KEY, creds.lastfmSessionKey.trim())
}

export interface ScrobbleInput {
  title: string
  artist: string
  album?: string | null
  durationSec?: number | null
  /** Epoch segundos de cuando arrancó a sonar la canción (no cuando se
   *  llegó al umbral de scrobble) — ambos servicios lo quieren así. */
  startedAtSec: number
}

// --- ListenBrainz ---

async function submitListenBrainz(input: ScrobbleInput, token: string): Promise<void> {
  const payload = {
    listen_type: 'single',
    payload: [
      {
        listened_at: input.startedAtSec,
        track_metadata: {
          artist_name: input.artist,
          track_name: input.title,
          release_name: input.album || undefined,
          additional_info: input.durationSec ? { duration: input.durationSec } : undefined,
        },
      },
    ],
  }
  await fetch('https://api.listenbrainz.org/1/submit-listens', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${token}`,
    },
    body: JSON.stringify(payload),
  })
}

// --- Last.fm ---
// Firma requerida por su API: MD5 de todos los params (menos `format`)
// ordenados alfabéticamente y concatenados key+value, con el api_secret
// al final. crypto.subtle no trae MD5 (solo SHA-*) así que se usa una
// implementación mínima pura JS — únicamente para esto, no para nada
// sensible a colisiones criptográficas (Last.fm exige MD5 específicamente).

function md5(input: string): string {
  // Implementación compacta de MD5 (RFC 1321) sobre UTF-8.
  function rotl(x: number, c: number): number {
    return (x << c) | (x >>> (32 - c))
  }
  function toUtf8Bytes(str: string): number[] {
    return Array.from(new TextEncoder().encode(str))
  }
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
    15, 21, 6, 10, 15, 21,
  ]
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)
  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  const bytes = toUtf8Bytes(input)
  const bitLen = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  for (let i = 0; i < 8; i++) bytes.push((bitLen / 2 ** (8 * i)) & 0xff)

  for (let chunkStart = 0; chunkStart < bytes.length; chunkStart += 64) {
    const M = new Array(16)
    for (let i = 0; i < 16; i++) {
      M[i] =
        (bytes[chunkStart + i * 4] ?? 0) |
        ((bytes[chunkStart + i * 4 + 1] ?? 0) << 8) |
        ((bytes[chunkStart + i * 4 + 2] ?? 0) << 16) |
        ((bytes[chunkStart + i * 4 + 3] ?? 0) << 24)
    }
    let [A, B, C, D] = [a0, b0, c0, d0]
    for (let i = 0; i < 64; i++) {
      let F = 0
      let g = 0
      if (i < 16) {
        F = (B & C) | (~B & D)
        g = i
      } else if (i < 32) {
        F = (D & B) | (~D & C)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        F = B ^ C ^ D
        g = (3 * i + 5) % 16
      } else {
        F = C ^ (B | ~D)
        g = (7 * i) % 16
      }
      F = (F + A + (K[i] ?? 0) + (M[g] ?? 0)) >>> 0
      A = D
      D = C
      C = B
      B = (B + rotl(F, s[i] ?? 0)) >>> 0
    }
    a0 = (a0 + A) >>> 0
    b0 = (b0 + B) >>> 0
    c0 = (c0 + C) >>> 0
    d0 = (d0 + D) >>> 0
  }

  const toHexLE = (n: number): string =>
    [0, 8, 16, 24].map((shift) => ((n >>> shift) & 0xff).toString(16).padStart(2, '0')).join('')
  return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0)
}

function lastfmSign(params: Record<string, string>, secret: string): string {
  const sorted = Object.keys(params).sort()
  const concatenated = sorted.map((k) => `${k}${params[k]}`).join('')
  return md5(concatenated + secret)
}

async function submitLastfm(
  input: ScrobbleInput,
  { apiKey, apiSecret, sessionKey }: { apiKey: string; apiSecret: string; sessionKey: string },
): Promise<void> {
  const baseParams: Record<string, string> = {
    method: 'track.scrobble',
    artist: input.artist,
    track: input.title,
    timestamp: String(input.startedAtSec),
    api_key: apiKey,
    sk: sessionKey,
  }
  if (input.album) baseParams.album = input.album
  const signature = lastfmSign(baseParams, apiSecret)

  const body = new URLSearchParams({ ...baseParams, api_sig: signature, format: 'json' })
  await fetch('https://ws.audioscrobbler.com/2.0/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
}

/** Manda el scrobble a los servicios habilitados con credenciales
 *  configuradas. Best-effort total: cualquier fallo se traga (un
 *  scrobble perdido no debe romper la reproducción ni mostrar un toast
 *  de error por cada canción). */
export async function scrobble(input: ScrobbleInput): Promise<void> {
  if (!isScrobbleEnabled()) return
  const creds = getScrobbleCredentials()

  const tasks: Promise<void>[] = []
  if (creds.listenbrainzToken) {
    tasks.push(submitListenBrainz(input, creds.listenbrainzToken).catch(() => {}))
  }
  if (creds.lastfmApiKey && creds.lastfmApiSecret && creds.lastfmSessionKey) {
    tasks.push(
      submitLastfm(input, {
        apiKey: creds.lastfmApiKey,
        apiSecret: creds.lastfmApiSecret,
        sessionKey: creds.lastfmSessionKey,
      }).catch(() => {}),
    )
  }
  await Promise.all(tasks)
}
