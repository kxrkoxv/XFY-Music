import { useEffect } from 'react'

// Screen Wake Lock API — mantiene la pantalla encendida mientras `active`.
// Caso de uso en XFY: letras karaoke sonando — es exactamente el escenario
// "leer la pantalla sin tocarla" para el que existe la API.
//
// Detalles del protocolo (MDN/Chrome docs):
//  - El lock se libera SOLO cuando la pestaña pasa a hidden o el sistema
//    decide ahorro de energía → hay que RE-adquirir en visibilitychange.
//  - El sentinel es de un solo uso: tras release() hay que pedir uno nuevo.
//  - Best-effort: sin permiso prompt (el navegador lo concede/rechaza solo),
//    cualquier rechazo (batería baja, política) deja la pantalla normal.
export default function useScreenWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return undefined

    let sentinel: WakeLockSentinel | null = null
    let cancelled = false

    const request = async (): Promise<void> => {
      if (sentinel && !sentinel.released) return
      if (document.visibilityState !== 'visible') return
      try {
        // El lock solo aplica a documento visible; si llegó acá oculto, no
        // tiene sentido pedirlo (NotAllowedError seguro).
        sentinel = await navigator.wakeLock.request('screen')
      } catch {
        /* batería baja / política del sistema: se vive sin lock */
      }
    }

    const release = (): void => {
      // No await: el efecto debe poder limpiar sincrónico. Un rejection del
      // release interno no afecta nada visible.
      void sentinel?.release().catch(() => {})
      sentinel = null
    }

    const onVisibility = (): void => {
      if (cancelled) return
      if (document.visibilityState === 'visible') void request()
      else release()
    }

    void request()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      release()
    }
  }, [active])
}
