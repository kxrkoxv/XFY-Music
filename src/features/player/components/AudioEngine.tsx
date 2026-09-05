import { useEffect } from 'react'
import { usePlayerStore, wireAudioElement } from '@features/player/store/usePlayerStore'

/**
 * Crea el elemento <audio> persistente de la app al montar y lo registra
 * en el store. TODO el wiring de eventos vive en `wireAudioElement`
 * (usePlayerStore.ts) para que el watchdog de segundo plano pueda
 * RECREAR el elemento —curando las regresiones de WebKit donde el nodo
 * viejo queda zombie (iOS 26 PWA reopen)— con exactamente la misma
 * semántica de eventos.
 */
export default function AudioEngine() {
  const setAudioElement = usePlayerStore((s) => s.setAudioElement)

  useEffect(() => {
    const el = wireAudioElement()
    setAudioElement(el)
    return () => {
      el.pause()
      el.removeAttribute('src')
    }
  }, [setAudioElement])

  return null
}
