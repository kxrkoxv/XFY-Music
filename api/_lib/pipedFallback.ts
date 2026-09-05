/**
 * Fallback de última instancia cuando TODO el CLIENT_CHAIN de youtubei.js
 * (YTMUSIC/MWEB/ANDROID_VR/TV, con BotGuard y sin él) devuelve bloqueo
 * anti-bot. Inspirado en cómo Spotube resuelve streams: en vez de un solo
 * método de extracción, prueba una cadena de proveedores (NewPipeExtractor,
 * Piped, Invidious) y usa el primero que responda.
 *
 * Piped/Invidious son frontends alternativos de YouTube que ya resuelven
 * el desafío anti-bot desde SU infraestructura (no la nuestra) — cuando
 * nuestra IP de Vercel está marcada, una instancia pública de Piped con
 * otra reputación de IP suele seguir funcionando. No reemplaza al pipeline
 * principal (peor calidad de audio típicamente, y depende de terceros
 * fuera de nuestro control) — es la red de seguridad antes de fallar del
 * todo.
 *
 * Misma lista de instancias que el plugin de cliente (ver
 * src/services/plugins/adapters/pipedSource.ts) — si una instancia cae
 * hay que actualizar ambas listas.
 */

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.yt',
  'https://piped-api.lunar.icu',
  'https://pipedapi.adminforge.de',
]

const INVIDIOUS_INSTANCES = ['https://invidious.nerdvpn.de', 'https://iv.melmac.space']

const FETCH_TIMEOUT_MS = 6000

interface PipedAudioStream {
  url: string
  mimeType?: string
  bitrate?: number
}

interface InvidiousAdaptiveFormat {
  url?: string
  type?: string // "audio/mp4; codecs=..."
  bitrate?: string
  audioQuality?: string
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface FallbackResolved {
  url: string
  mimeType: string
  bitrate: number
  durationSecs: number
  client: string
}

async function tryPiped(videoId: string): Promise<FallbackResolved | null> {
  for (const instance of PIPED_INSTANCES) {
    const data = await fetchJson<{ audioStreams?: PipedAudioStream[]; duration?: number }>(
      `${instance}/streams/${videoId}`,
    )
    const streams = data?.audioStreams || []
    if (!streams.length) continue
    const best = [...streams].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]
    if (!best?.url) continue
    return {
      url: best.url,
      mimeType: (best.mimeType || 'audio/mp4').split(';')[0] ?? 'audio/mp4',
      bitrate: best.bitrate || 0,
      durationSecs: data?.duration || 0,
      client: `piped:${new URL(instance).hostname}`,
    }
  }
  return null
}

async function tryInvidious(videoId: string): Promise<FallbackResolved | null> {
  for (const instance of INVIDIOUS_INSTANCES) {
    const data = await fetchJson<{ adaptiveFormats?: InvidiousAdaptiveFormat[]; lengthSeconds?: number }>(
      `${instance}/api/v1/videos/${videoId}`,
    )
    const formats = (data?.adaptiveFormats || []).filter((f) => f.type?.startsWith('audio/'))
    if (!formats.length) continue
    const best = [...formats].sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0))[0]
    if (!best?.url) continue
    return {
      url: best.url,
      mimeType: (best.type || 'audio/mp4').split(';')[0] ?? 'audio/mp4',
      bitrate: Number(best.bitrate || 0),
      durationSecs: data?.lengthSeconds || 0,
      client: `invidious:${new URL(instance).hostname}`,
    }
  }
  return null
}

/** Prueba Piped primero (catálogo de música más confiable), después
 *  Invidious. Devuelve null (nunca tira) si ambos fallan — el caller
 *  decide qué hacer con eso. */
export async function resolveViaExternalFallback(videoId: string): Promise<FallbackResolved | null> {
  return (await tryPiped(videoId)) || (await tryInvidious(videoId))
}
