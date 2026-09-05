import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Laptop2 } from 'lucide-react'
import { useDevicesStore } from '@features/devices/store/useDevicesStore'
import DevicesPanel from './DevicesPanel'
import './ConnectButton.css'

/**
 * El ícono de "Connect" de Spotify: vive junto a los controles del
 * reproductor (no enterrado en Ajustes) y abre el mismo DevicesPanel
 * en un popover flotante. Un punto en la esquina avisa si hay OTRO
 * dispositivo online además de este, para que la opción de transferir
 * no pase desapercibida cuando de verdad hay algo para transferir.
 */
export default function ConnectButton({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ left: number; bottom: number } | null>(null)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const { devices, selfId, fetchDevices } = useDevicesStore()

  const otherOnline = devices.some((d) => d.id !== selfId && d.online)

  useEffect(() => {
    // Un fetch liviano al montar: así el puntito de "hay otro dispositivo
    // online" puede aparecer sin que el usuario tenga que abrir el popover
    // primero. DevicesPanel ya se encarga de refrescar en vivo mientras
    // está abierto.
    void fetchDevices()
  }, [fetchDevices])

  // La posición se mide en un efecto (nunca leyendo el ref durante el
  // render) y se recalcula si la ventana cambia de tamaño o el layout
  // se desplaza mientras el popover está abierto.
  useEffect(() => {
    if (!open) return undefined
    function measure() {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (!rect) return
      setCoords({
        left: Math.min(Math.max(12, rect.right - 340), window.innerWidth - 340 - 12),
        // Se ancla por abajo: crece HACIA ARRIBA desde el botón, así nunca
        // tapa el propio control que lo abrió ni se corta contra el borde
        // inferior de la pantalla.
        bottom: window.innerHeight - rect.top + 10,
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`connect-button ${className}`}
        aria-label="Escuchar en otro dispositivo"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Laptop2 size={18} />
        {otherOnline && <span className="connect-button-dot" aria-hidden="true" />}
      </button>

      {createPortal(
        <AnimatePresence>
          {open && coords && (
            <motion.div
              ref={popoverRef}
              className="connect-popover"
              style={{ position: 'fixed', left: coords.left, bottom: coords.bottom }}
              initial={{ opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.97 }}
              transition={{ type: 'spring', bounce: 0, duration: 0.22 }}
            >
              <DevicesPanel />
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}
