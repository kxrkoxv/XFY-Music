import { create } from 'zustand'
import { callApi } from '@shared/lib/apiClient'
import { songToPlayerStateSong, type PlayerStateSongDTO } from '@features/devices/lib/playerStatePayload'

export interface DeviceDTO {
  id: string
  name: string
  kind: 'web' | 'mobile' | 'desktop'
  isActive: boolean
  // Distinto de isActive — ver el comentario en accountResources.ts
  // (toDeviceDTO). isActive: "a quién se transfirió el mando". online:
  // "¿sigue mandando señales de vida ahora mismo?".
  online: boolean
  playerState: {
    song?: PlayerStateSongDTO | null
    currentTime?: number
    isPlaying?: boolean
    volume?: number
    updatedAt?: number
  } | null
  lastSeen: string
  createdAt: string
}

interface DevicesState {
  devices: DeviceDTO[]
  selfId: string | null
  loading: boolean
  fetchDevices: () => Promise<void>
  renameDevice: (deviceId: string, name: string) => Promise<boolean>
  revokeDevice: (deviceId: string) => Promise<boolean>
  transferTo: (targetDeviceId: string) => Promise<boolean>
  sendCommand: (targetDeviceId: string, command: { type: string; payload?: unknown }) => Promise<boolean>
}

export const useDevicesStore = create<DevicesState>()((set, get) => ({
  devices: [],
  selfId: null,
  loading: false,

  fetchDevices: async () => {
    set({ loading: true })
    const result = await callApi<{ devices?: DeviceDTO[]; selfId?: string }>('devices', 'list')
    set({ devices: result.devices ?? [], selfId: result.selfId ?? null, loading: false })
  },

  renameDevice: async (deviceId, name) => {
    const result = await callApi<{ ok: boolean }>('devices', 'rename', { deviceId, name })
    if (result.ok) {
      set({ devices: get().devices.map((d) => (d.id === deviceId ? { ...d, name } : d)) })
    }
    return !!result.ok
  },

  revokeDevice: async (deviceId) => {
    const result = await callApi<{ ok: boolean }>('devices', 'revoke', { deviceId })
    if (result.ok) {
      set({ devices: get().devices.filter((d) => d.id !== deviceId) })
    }
    return !!result.ok
  },

  // Le manda al dispositivo destino el estado actual de reproducción de
  // ESTE dispositivo (currentSong/currentTime/isPlaying/volume) — igual
  // que "Escuchar en otro dispositivo" en Spotify: el que transfiere le
  // pasa la posta con dónde iba la canción. songToPlayerStateSong manda
  // la canción COMPLETA (no solo título/artista) — es lo que le permite
  // al destino de verdad reproducir audio y no solo mostrar el nombre
  // (ver el comentario grande en playerStatePayload.ts).
  // Optimista: el destino pasa a "Activo" en el panel al toque, sin
  // esperar el round-trip de fetchDevices() — antes era la única acción
  // del store que sí esperaba esa vuelta completa, y por eso se sentía
  // más lenta que pausar/cambiar volumen (que ya eran optimistas).
  transferTo: async (targetDeviceId) => {
    const { usePlayerStore } = await import('@features/player')
    const player = usePlayerStore.getState()
    const song = player.currentSong()
    const wasPlaying = player.isPlaying
    const playerState = song
      ? {
          song: songToPlayerStateSong(song),
          currentTime: player.currentTime,
          isPlaying: player.isPlaying,
          volume: player.volume,
          updatedAt: Date.now(),
        }
      : null

    const prevDevices = get().devices
    set({
      devices: prevDevices.map((d) => ({
        ...d,
        isActive: d.id === targetDeviceId,
        playerState: d.id === targetDeviceId ? { ...d.playerState, ...playerState } : d.playerState,
      })),
    })

    // Igual que "Escuchar en otro dispositivo" en Spotify: ESTE
    // dispositivo se calla al instante al transferir — no espera ningún
    // round-trip de red. Antes esto no pasaba (o pasaba recién cuando
    // llegaba, por casualidad, el próximo heartbeat), así que la canción
    // seguía sonando acá Y en el destino a la vez. Si la transferencia
    // termina fallando, se retoma más abajo.
    if (wasPlaying) player.pause()

    const result = await callApi<{ ok: boolean }>('devices', 'transfer', { targetDeviceId, playerState })
    if (!result.ok) {
      set({ devices: prevDevices }) // no se pudo transferir: revertir el optimismo
      if (wasPlaying) void usePlayerStore.getState().play() // ...y retomar acá lo que se había cortado
    } else {
      // Avisarle al servidor de inmediato que este dispositivo ya no es
      // el que suena (sin esperar el próximo heartbeat de hasta 5s), para
      // que el panel de cualquier OTRO dispositivo no lo siga mostrando
      // como "Reproduciendo" unos segundos de más después de la transferencia.
      if (playerState) {
        void callApi('devices', 'heartbeat', {
          playerState: { ...playerState, isPlaying: false, updatedAt: Date.now() },
        })
      }
      // Reconciliar en segundo plano, sin bloquear la UI (que ya muestra
      // el resultado final): trae el estado real del destino apenas su
      // primer heartbeat post-transferencia llegue al servidor.
      void get().fetchDevices()
    }
    return !!result.ok
  },

  // Controlar OTRO dispositivo a distancia SIN transferirle la reproducción
  // — el "el teléfono queda de control remoto" de Spotify Connect: una vez
  // que un dispositivo es el activo, cualquier otro puede pausarlo, saltar
  // canción o subirle el volumen sin que el audio se mueva de ahí.
  // Optimista en play/pause/setVolume (se nota al toque en este panel) Y
  // además el destino ahora lo recibe casi al instante — pollCommands es
  // long-polling (ver useDeviceSync.ts / accountResources.ts), no un
  // timer de unos segundos.
  sendCommand: async (targetDeviceId, command) => {
    const prevDevices = get().devices
    set({
      devices: prevDevices.map((d) => {
        if (d.id !== targetDeviceId || !d.playerState) return d
        if (command.type === 'play') return { ...d, playerState: { ...d.playerState, isPlaying: true } }
        if (command.type === 'pause') return { ...d, playerState: { ...d.playerState, isPlaying: false } }
        if (command.type === 'setVolume') {
          const payload = command.payload as { volume?: number } | undefined
          if (payload?.volume == null) return d
          return { ...d, playerState: { ...d.playerState, volume: payload.volume } }
        }
        return d
      }),
    })
    const result = await callApi<{ ok: boolean }>('devices', 'command', { targetDeviceId, command })
    if (!result.ok) set({ devices: prevDevices }) // no se pudo entregar: revertir el optimismo
    return !!result.ok
  },
}))
