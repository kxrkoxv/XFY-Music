import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AnimatePresence, motion } from 'motion/react'
import { Laptop, Smartphone, Monitor, Pencil, LogOut, SkipBack, SkipForward, Play, Pause, Volume1, Volume2, VolumeX } from 'lucide-react'
import { useDevicesStore, type DeviceDTO } from '@features/devices/store/useDevicesStore'
import { useLivePlayerPosition } from '@features/devices/lib/useLivePlayerPosition'
import './DevicesPanel.css'

// Spring compartido por toda la lista: entra/sale de forma consistente sin
// definir una curva de easing distinta en cada lugar donde se anima un item.
const ITEM_SPRING = { type: 'spring', stiffness: 420, damping: 34 } as const

const ICONS = { web: Laptop, mobile: Smartphone, desktop: Monitor } as const

// Mismo umbral que el backend (DEVICE_ONLINE_THRESHOLD_MS en
// accountResources.ts) — solo para decidir cada cuánto refrescar la
// lista acá, la verdad de "online" siempre la manda el servidor.
// Bajado de 8s a 4s: el heartbeat de cada dispositivo llega cada 5s (ver
// useDeviceSync.ts), así que refrescar más espaciado que eso solo suma
// delay percibido sin ahorrar mucho. Transferir/pausar/etc. ya no
// dependen de este timer — son optimistas o llegan por el long-poll de
// comandos — este intervalo ahora solo importa para ver el "ahora
// suena…" de un dispositivo que vos NO estás controlando.
const PANEL_REFRESH_MS = 4000
const PANEL_REFRESH_BACKGROUND_MS = 30000

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'ahora'
  if (min < 60) return `hace ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `hace ${h} h`
  return `hace ${Math.floor(h / 24)} d`
}

function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(s / 60)
  const rest = s % 60
  return `${m}:${rest.toString().padStart(2, '0')}`
}

// Barritas animadas tipo ecualizador — el mismo lenguaje visual que
// Spotify usa para marcar "esto es lo que está sonando ahora mismo",
// en vez de un check genérico que no distingue "activo" de "sonando".
function NowPlayingBars() {
  return (
    <span className="devices-panel__bars" aria-hidden="true">
      <i /><i /><i />
    </span>
  )
}

/**
 * Selector de dispositivos, pensado para abrirse como modal/drawer desde el
 * mini-player (igual que el ícono de "Connect" de Spotify) o embeberse en
 * Ajustes como lista de sesiones activas.
 */
export default function DevicesPanel() {
  const { devices, selfId, loading, fetchDevices, renameDevice, revokeDevice, transferTo, sendCommand } = useDevicesStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  useEffect(() => {
    void fetchDevices()
    let timer: number
    function schedule() {
      const delay = document.visibilityState === 'hidden' ? PANEL_REFRESH_BACKGROUND_MS : PANEL_REFRESH_MS
      timer = window.setTimeout(async () => {
        await fetchDevices()
        schedule()
      }, delay)
    }
    function onVisible() {
      if (document.visibilityState !== 'hidden') {
        window.clearTimeout(timer)
        void fetchDevices()
        schedule()
      }
    }
    schedule()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [fetchDevices])

  async function handleTransfer(deviceId: string) {
    if (deviceId === selfId) return
    const ok = await transferTo(deviceId)
    toast[ok ? 'success' : 'error'](ok ? 'Reproducción transferida.' : 'No se pudo transferir.')
  }

  async function handleRename(deviceId: string) {
    const name = editingName.trim()
    if (!name) return setEditingId(null)
    const ok = await renameDevice(deviceId, name)
    if (!ok) toast.error('No se pudo renombrar el dispositivo.')
    setEditingId(null)
  }

  async function handleRevoke(deviceId: string) {
    const ok = await revokeDevice(deviceId)
    toast[ok ? 'success' : 'error'](ok ? 'Sesión cerrada en ese dispositivo.' : 'No se pudo cerrar esa sesión.')
  }

  return (
    <div className="devices-panel">
      <h3 className="devices-panel__title">Dispositivos</h3>
      <p className="devices-panel__subtitle">Elegí dónde seguir escuchando.</p>

      {loading && devices.length === 0 && <DevicesSkeleton />}
      {!loading && devices.length === 0 && (
        <motion.p
          className="devices-panel__empty"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18 }}
        >
          No hay otras sesiones activas.
        </motion.p>
      )}

      <ul className="devices-panel__list">
        <AnimatePresence initial={false}>
          {devices.map((device) => (
            <motion.li
              key={device.id}
              layout
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.14 } }}
              transition={ITEM_SPRING}
              className={[
                'devices-panel__item',
                device.isActive ? 'is-active' : '',
                !device.online ? 'is-offline' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <DeviceListItem
                device={device}
                isSelf={device.id === selfId}
                editing={editingId === device.id}
                editingName={editingName}
                onEditingNameChange={setEditingName}
                onStartEdit={() => {
                  setEditingId(device.id)
                  setEditingName(device.name)
                }}
                onTransfer={() => handleTransfer(device.id)}
                onRename={() => handleRename(device.id)}
                onRevoke={() => handleRevoke(device.id)}
                onCommand={(command) => sendCommand(device.id, command)}
              />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  )
}

/** Placeholders pulsantes mientras llega el primer fetch — reemplaza el
 *  texto suelto de "Buscando dispositivos…" por algo que ya insinúa la
 *  forma final de la lista, así no hay un salto de layout cuando llega. */
function DevicesSkeleton() {
  return (
    <ul className="devices-panel__list" aria-hidden="true">
      {[0, 1].map((i) => (
        <li className="devices-panel__item devices-panel__skeleton-item" key={i}>
          <span className="devices-panel__skeleton devices-panel__skeleton--icon" />
          <div className="devices-panel__skeleton-lines">
            <span className="devices-panel__skeleton devices-panel__skeleton--line" style={{ width: '55%' }} />
            <span className="devices-panel__skeleton devices-panel__skeleton--line" style={{ width: '80%' }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

interface DeviceListItemProps {
  device: DeviceDTO
  isSelf: boolean
  editing: boolean
  editingName: string
  onEditingNameChange: (name: string) => void
  onStartEdit: () => void
  onTransfer: () => void
  onRename: () => void
  onRevoke: () => void
  onCommand: (command: { type: string; payload?: unknown }) => void
}

function DeviceListItem({
  device,
  isSelf,
  editing,
  editingName,
  onEditingNameChange,
  onStartEdit,
  onTransfer,
  onRename,
  onRevoke,
  onCommand,
}: DeviceListItemProps) {
  const Icon = ICONS[device.kind] ?? Laptop
  const nowPlaying = device.playerState?.song
  const isLive = !!nowPlaying && device.online
  const elapsed = useLivePlayerPosition(isLive ? device.playerState : null)

  return (
    <>
      <button type="button" className="devices-panel__main" onClick={onTransfer} disabled={isSelf}>
        <span className="devices-panel__icon-wrap">
          <Icon size={19} className="devices-panel__icon" />
          <span className={`devices-panel__dot ${device.online ? 'is-online' : ''}`} aria-hidden="true" />
        </span>
        <div className="devices-panel__info">
          <span className="devices-panel__name">
            {device.name} {isSelf && <em>(este dispositivo)</em>}
          </span>
          <span className="devices-panel__meta">
            {!device.online
              ? `Sin conexión · visto ${timeAgo(device.lastSeen)}`
              : nowPlaying
                ? `${device.playerState?.isPlaying ? `Reproduciendo · ${formatTime(elapsed)}` : 'En pausa'} · ${nowPlaying.title}`
                : `Activo · visto ${timeAgo(device.lastSeen)}`}
          </span>
        </div>
        {device.isActive && device.online && device.playerState?.isPlaying ? (
          <NowPlayingBars />
        ) : device.isActive ? (
          <span className="devices-panel__active-label">Activo</span>
        ) : null}
      </button>

      <div className="devices-panel__actions">
        {editing ? (
          <input
            autoFocus
            className="devices-panel__rename-input"
            value={editingName}
            onChange={(e) => onEditingNameChange(e.target.value)}
            onBlur={onRename}
            onKeyDown={(e) => e.key === 'Enter' && onRename()}
          />
        ) : (
          <button type="button" className="devices-panel__icon-btn" aria-label="Renombrar dispositivo" onClick={onStartEdit}>
            <Pencil size={16} />
          </button>
        )}
        <button
          type="button"
          className="devices-panel__icon-btn devices-panel__icon-btn--danger"
          aria-label="Cerrar sesión en este dispositivo"
          onClick={onRevoke}
        >
          <LogOut size={16} />
        </button>
      </div>

      {/* Igual que Spotify Connect: una vez que OTRO dispositivo es el
          activo, este panel se vuelve su control remoto — pausar, saltar
          o subirle el volumen sin mover el audio de dónde está sonando.
          Entra/sale con un collapse de altura en vez de aparecer de golpe,
          para que el resto de la lista se reacomode con suavidad. */}
      <AnimatePresence initial={false}>
        {device.isActive && !isSelf && device.online && (
          <motion.div
            key="remote"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            style={{ overflow: 'hidden', width: '100%' }}
          >
            <RemoteControls playerState={device.playerState} onCommand={onCommand} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

function RemoteControls({
  playerState,
  onCommand,
}: {
  playerState: DeviceDTO['playerState']
  onCommand: (command: { type: string; payload?: unknown }) => void
}) {
  const isPlaying = !!playerState?.isPlaying
  const volume = playerState?.volume ?? 1
  const volumeTimer = useRef<number | null>(null)

  function handleVolumeChange(next: number) {
    // Debounced: mientras se arrastra el slider solo se manda el último
    // valor (cada mensaje es una escritura + un poll consumido del otro
    // lado), igual que el volumen de Spotify Connect no manda un comando
    // por cada pixel de movimiento.
    if (volumeTimer.current) window.clearTimeout(volumeTimer.current)
    volumeTimer.current = window.setTimeout(() => {
      onCommand({ type: 'setVolume', payload: { volume: next } })
    }, 120)
  }

  const VolumeIcon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2

  return (
    <div className="devices-panel__remote" onClick={(e) => e.stopPropagation()}>
      <div className="devices-panel__remote-transport">
        <button type="button" className="devices-panel__icon-btn" aria-label="Anterior" onClick={() => onCommand({ type: 'previous' })}>
          <SkipBack size={16} />
        </button>
        <button
          type="button"
          className="devices-panel__remote-play"
          aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
          onClick={() => onCommand({ type: isPlaying ? 'pause' : 'play' })}
        >
          {isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button type="button" className="devices-panel__icon-btn" aria-label="Siguiente" onClick={() => onCommand({ type: 'next' })}>
          <SkipForward size={16} />
        </button>
      </div>
      <div className="devices-panel__remote-volume">
        <VolumeIcon size={14} className="devices-panel__remote-volume-icon" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          defaultValue={volume}
          key={Math.round(volume * 20)}
          onChange={(e) => handleVolumeChange(Number(e.target.value))}
          aria-label="Volumen remoto"
        />
      </div>
    </div>
  )
}
