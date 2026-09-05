import { fetchJsonRobust } from '@shared/lib/httpClient'

/** Respuesta de /api/ytaudio: stream directo y/o proxied de respaldo. */
export interface YtAudioResolution {
  url: string | null
  proxiedUrl: string | null
  mimeType: string
  bitrate: number
  durationSecs: number
}

// ============================================================
// Resuelve un stream de audio real para un video de YouTube usando
// /api/ytaudio (youtubei.js + PO tokens en la Vercel Function, ver
// api/_lib/ytcore.js). Reproducir por <audio> en vez del IFrame
// habilita: playback que sobrevive el backgrounding de la PWA,
// Media Session consistente y caché de audio local.
//
// La respuesta trae dos URLs:
//   - url: googlevideo directa (rápida, sin intermediario)
//   - proxiedUrl: /api/ytstream — mismo origen que firmó la URL; si la
//     directa da 403 en el navegador (googlevideo ata la firma a la IP
//     que la generó), esta es la segunda chance antes de caer al IFrame.
// ============================================================
export async function resolveYouTubeAudio(videoId: string | null | undefined): Promise<YtAudioResolution | null> {
  if (!videoId) return null
  try {
    // timeoutMs corto y sin reintentos: el caller (usePlayerStore) cae al
    // IFrame Player como fallback en cuanto esto devuelve null — sin
    // timeout, un fetch() colgado acá retrasaría indefinidamente el "play".
    // (La primera llamada tras un cold start puede tardar varios segundos:
    // sesión Innertube + challenge BotGuard se arman una vez por instancia.)
    const data = await fetchJsonRobust<{
      url?: string
      proxiedUrl?: string
      mimeType?: string
      bitrate?: number
      durationSecs?: number
    }>(`/api/ytaudio?videoId=${encodeURIComponent(videoId)}`, {
      timeoutMs: 15000,
      retries: 0,
    })
    if (!data?.url && !data?.proxiedUrl) return null
    return {
      url: data.url || null,
      proxiedUrl: data.proxiedUrl ? new URL(data.proxiedUrl, window.location.origin).href : null,
      mimeType: data.mimeType || 'audio/mp4',
      bitrate: data.bitrate || 0,
      durationSecs: data.durationSecs || 0,
    }
  } catch {
    return null
  }
}

/** Fire-and-forget: calienta el cache del resolutor para la siguiente pista. */
export function warmYouTubeAudio(videoId: string | null | undefined): void {
  if (!videoId) return
  fetch(`/api/ytaudio?videoId=${encodeURIComponent(videoId)}`).catch(() => {})
}
