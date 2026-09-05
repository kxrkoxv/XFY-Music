import { useEffect, useState } from 'react'

interface AnchoredPlayerState {
  currentTime?: number
  isPlaying?: boolean
  updatedAt?: number
}

// ============================================================
// Interpola la posición de reproducción de OTRO dispositivo entre
// heartbeats, en vez de mostrar un número congelado que salta cada 5s.
//
// Esto es literalmente cómo Spotify Connect evita tener que retransmitir
// la posición todo el tiempo: el "cluster" manda un ancla
// (position_as_of_timestamp + timestamp) y cada cliente calcula
// posición_actual = ancla + (ahora - timestamp) mientras is_playing sea
// true, en vez de que el servidor tenga que empujar un update por
// segundo. Acá el mismo truco, con currentTime/updatedAt que YA vienen
// en cada heartbeat (ver useDeviceSync.ts) — no hace falta tocar el
// backend para tener una barra de progreso que se ve viva.
// ============================================================
export function useLivePlayerPosition(state: AnchoredPlayerState | null | undefined): number {
  const anchor = state?.currentTime ?? 0
  const anchoredAt = state?.updatedAt ?? Date.now()
  const isPlaying = !!state?.isPlaying

  const [elapsed, setElapsed] = useState(() => (isPlaying ? anchor + (Date.now() - anchoredAt) / 1000 : anchor))

  useEffect(() => {
    if (!isPlaying) {
      setElapsed(anchor)
      return
    }
    setElapsed(anchor + (Date.now() - anchoredAt) / 1000)
    const tick = window.setInterval(() => {
      setElapsed(anchor + (Date.now() - anchoredAt) / 1000)
    }, 1000)
    return () => window.clearInterval(tick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, anchoredAt, isPlaying])

  return elapsed
}
