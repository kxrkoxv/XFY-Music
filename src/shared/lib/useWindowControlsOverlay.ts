import { useEffect } from 'react'

// El manifest declara display_override: ["window-controls-overlay", ...],
// pero eso por sí solo NO reserva espacio para nada: en Windows/ChromeOS,
// instalar la PWA con WCO activo hace que el navegador pinte los botones
// nativos de minimizar/maximizar/cerrar flotando ARRIBA del contenido, en
// vez de en su propia barra separada — y sin este hook, el logo del
// Sidebar y el dock de FloatingHeader (ambos con top:0) quedan tapados o
// pegados contra esos botones, y la ventana no tiene ninguna zona
// arrastrable propia (el "titlebar" real mide 0px de alto en ese modo).
//
// Esto detecta el modo, agrega .pwa-wco a <html> para que el CSS pueda
// reservar esa franja (ver global.css), y mantiene sincronizadas las
// variables --wco-x/--wco-width/--wco-height con la geometría real que
// reporta el navegador (cambia con el tamaño/zoom de la ventana).
export default function useWindowControlsOverlay() {
  useEffect(() => {
    const nav = navigator as Navigator & {
      windowControlsOverlay?: {
        visible: boolean
        getTitlebarAreaRect: () => DOMRect
        ongeometrychange: unknown
        addEventListener: (type: 'geometrychange', cb: () => void) => void
        removeEventListener: (type: 'geometrychange', cb: () => void) => void
      }
    }
    const wco = nav.windowControlsOverlay
    if (!wco) return undefined

    const root = document.documentElement

    const sync = () => {
      const active = wco.visible
      root.classList.toggle('pwa-wco', active)
      if (!active) return
      const rect = wco.getTitlebarAreaRect()
      root.style.setProperty('--wco-x', `${rect.x}px`)
      root.style.setProperty('--wco-width', `${rect.width}px`)
      root.style.setProperty('--wco-height', `${rect.height}px`)
    }

    sync()
    wco.addEventListener('geometrychange', sync)
    return () => {
      wco.removeEventListener('geometrychange', sync)
      root.classList.remove('pwa-wco')
    }
  }, [])
}
