// Tipos mínimos del IFrame Player API de YouTube — solo lo que XFY usa
// (el paquete @types/youtube existe pero trae el mundo entero).
export interface YTPlayer {
  loadVideoById(videoId: string): void
  loadVideoById(options: { videoId: string; startSeconds?: number; endSeconds?: number }): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  playVideo(): void
  pauseVideo(): void
  stopVideo(): void
  setVolume(volume: number): void
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
  destroy(): void
}

export interface YTNamespace {
  Player: new (
    element: HTMLElement | string,
    options: {
      videoId?: string
      host?: string
      width?: string | number
      height?: string | number
      playerVars?: Record<string, string | number>
      events?: {
        onReady?: (event: { target: YTPlayer }) => void
        onStateChange?: (event: { data: number; target: YTPlayer }) => void
        onError?: (event: { data: number }) => void
      }
    },
  ) => YTPlayer
  PlayerState: {
    UNSTARTED: number
    ENDED: number
    PLAYING: number
    PAUSED: number
    BUFFERING: number
    CUED: number
  }
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

// Carga (una sola vez) el IFrame Player API de YouTube y resuelve con el
// objeto global `YT` cuando está listo. Cualquier cantidad de llamadas
// comparten la misma promesa — el script solo se inyecta una vez.
//
// IMPORTANTE: esta promesa ANTES no tenía onerror ni timeout — si el
// <script src="https://www.youtube.com/iframe_api"> fallaba (red mala,
// ad-blocker, DNS, el dominio youtube.com tardando/cortado en la red del
// usuario) la promesa quedaba colgada PARA SIEMPRE. Como se memoiza en
// `apiPromise`, ni siquiera cambiar de canción o reintentar arreglaba
// nada: ytController nunca se registraba, así que el fallback "IFrame
// instantáneo" (ver usePlayerStore._playViaIframe) nunca arrancaba y el
// chip "Preparando audio para segundo plano…" quedaba pegado sin sonido,
// que es justo el síntoma reportado. Ahora: timeout + onerror rechazan la
// promesa Y limpian `apiPromise`/el <script> inyectado, para que el
// próximo intento (siguiente canción, o el watchdog del store) pueda
// reintentar desde cero en vez de quedar bloqueado por la memoización.
const LOAD_TIMEOUT_MS = 8000
let apiPromise: Promise<YTNamespace> | null = null

function resetApiPromise() {
  apiPromise = null
  window.onYouTubeIframeAPIReady = undefined
  document.querySelector('script[data-youtube-iframe-api]')?.remove()
}

export function loadYouTubeApi(): Promise<YTNamespace> {
  if (apiPromise) return apiPromise

  apiPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('No window'))
      return
    }

    if (window.YT && window.YT.Player) {
      resolve(window.YT)
      return
    }

    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      console.warn('[XFY] Timeout cargando el IFrame API de YouTube')
      resetApiPromise()
      reject(new Error('Timeout cargando YouTube IFrame API'))
    }, LOAD_TIMEOUT_MS)

    // YouTube llama a esta función global cuando el API terminó de cargar.
    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      prev?.()
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      if (window.YT) resolve(window.YT)
      else {
        resetApiPromise()
        reject(new Error('YT global ausente tras onYouTubeIframeAPIReady'))
      }
    }

    // Evitá inyectar el <script> dos veces si ya está en el DOM.
    let tag = document.querySelector<HTMLScriptElement>('script[data-youtube-iframe-api]')
    if (!tag) {
      tag = document.createElement('script')
      tag.src = 'https://www.youtube.com/iframe_api'
      tag.async = true
      tag.dataset.youtubeIframeApi = 'true'
      document.head.appendChild(tag)
    }
    tag.addEventListener('error', () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      console.warn('[XFY] No se pudo cargar el script del IFrame API de YouTube')
      resetApiPromise()
      reject(new Error('Falló la carga del script de YouTube IFrame API'))
    })
  })

  return apiPromise
}
