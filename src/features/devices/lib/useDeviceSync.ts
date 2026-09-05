// ============================================================
// Corazón del "Spotify Connect" de XFY: transporte HÍBRIDO con dos capas
// que se complementan, nunca se reemplazan una a la otra —
//
// 1) REALTIME (Ably, opcional — ver realtimeTransport.ts): cada
//    dispositivo abre su propia conexión WebSocket directo contra Ably
//    (nunca contra Vercel) y recibe los comandos (play/pause/transferir)
//    en milisegundos, sin tocar ninguna función serverless nuestra. Es
//    la vía "rápida" cuando está disponible.
// 2) LONG-POLL (siempre activo, sin excepción — ver pollCommands en
//    accountResources.ts): la función serverless se queda escuchando la
//    base hasta 25s en vez de devolver "no hay nada" al toque. Es la vía
//    confiable de fondo: entrega los mismos comandos si Ably no está
//    configurado, si el navegador bloquea WebSockets (redes corporativas,
//    por ejemplo), o si la conexión de Ably se cae un rato — Y además es
//    la única vía para sincronizar cambios de cuenta (nickname/avatar/
//    tema) entre dispositivos, algo que Ably no maneja acá.
//
// Por qué no reemplazar el long-poll directamente: cada capa cubre una
// falla distinta de la otra. Con las dos, el sistema entero sigue
// funcionando igual de bien en un deployment que nunca configuró
// ABLY_API_KEY — Ably es pura ganancia de velocidad cuando está, nunca
// una dependencia dura. La única optimización real que SÍ se aplica: con
// Ably conectado y entregando los comandos casi al instante, el long-poll
// se vuelve más espaciado (POLL_COOLDOWN_WITH_REALTIME_MS) en vez de
// reabrirse apenas termina cada vuelta — sigue vivo como red de
// seguridad y para la sync de cuenta, pero deja de competir por las
// mismas 12 funciones serverless del plan Hobby con el ritmo agresivo
// que sí hace falta cuando es la ÚNICA vía de entrega.
// ============================================================

import { useEffect } from 'react'
import { callApi, clearToken } from '@shared/lib/apiClient'
import { useAuthStore } from '@features/auth'
import { usePlayerStore } from '@features/player'
import { useCustomThemesStore } from '@features/settings/lib/customThemesStore'
import { songToPlayerStateSong, type PlayerStateSongDTO } from '@features/devices/lib/playerStatePayload'
import { connectDeviceRealtime } from '@features/devices/lib/realtimeTransport'
// Import de tipo únicamente (se borra en build) — directo al store y no al
// barrel de player/index.ts, que a propósito no reexporta nada pesado.
import type { PlayerSong } from '@features/player/store/usePlayerStore'

const HEARTBEAT_MS = 5000
const HEARTBEAT_BACKGROUND_MS = 20000
// Si el long-poll falla (red caída, función caída, etc.) esperar un toque
// antes de reintentar — sin esto un error persistente lo convertiría en un
// loop de reintentos inmediatos golpeando la API sin parar.
const POLL_RETRY_MS = 3000
// Con Ably activo y entregando los comandos, esperar esto entre el fin de
// una vuelta de long-poll y el arranque de la siguiente — sigue corriendo
// como red de seguridad + sync de cuenta, pero deja de reabrirse al toque.
const POLL_COOLDOWN_WITH_REALTIME_MS = 20000

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

interface RemoteCommand {
  // Generado en el backend (crypto.randomUUID(), ver accountResources.ts)
  // — el mismo comando puede llegar tanto por Ably como por el long-poll;
  // este id es lo que le permite al cliente aplicarlo una sola vez (ver
  // dedupeAndApply más abajo).
  id?: string
  // 'revoked': este dispositivo fue cerrado desde el panel de OTRO (ver
  // 'revoke' en accountResources.ts) — no es un comando de reproducción,
  // es un aviso de "andate ya" que se maneja aparte en dedupeAndApply, no
  // en applyRemoteCommand.
  type: 'transfer' | 'play' | 'pause' | 'seek' | 'setVolume' | 'next' | 'previous' | 'revoked'
  payload?: {
    song?: PlayerStateSongDTO
    currentTime?: number
    isPlaying?: boolean
    volume?: number
    time?: number
  } | null
}

// Cuántos ids recientes recordar para el dedupe entre Ably y el long-poll
// — no hace falta guardar más que unos pocos: alcanza con cubrir la
// ventana en la que las dos vías podrían entregar el mismo comando (unos
// segundos como mucho), no toda la sesión.
const MAX_RECENT_COMMAND_IDS = 50

export function useDeviceSync(): void {
  const currentUser = useAuthStore((s) => s.currentUser)

  useEffect(() => {
    if (!currentUser) return
    let heartbeatTimer: number
    let stopped = false
    // Reflejado por connectDeviceRealtime() cada vez que Ably conecta o se
    // cae — pollLoop lo lee en cada vuelta para decidir si reabre al toque
    // (sin Ably, o Ably caído) o espera el cooldown (Ably entregando).
    let realtimeConnected = false
    // Ids de comandos ya aplicados en esta sesión (más recientes primero)
    // — mismo comando puede llegar por Ably Y por el long-poll; sin esto
    // se aplicaría dos veces (un 'next' saltaría dos canciones en vez de
    // una). Array simple + slice en vez de un Set con expiración por
    // tiempo: alcanza con "los últimos N", no hace falta nada más fino.
    const recentCommandIds: string[] = []
    function dedupeAndApply(cmd: RemoteCommand) {
      if (cmd.id) {
        if (recentCommandIds.includes(cmd.id)) return
        recentCommandIds.unshift(cmd.id)
        recentCommandIds.length = Math.min(recentCommandIds.length, MAX_RECENT_COMMAND_IDS)
      }
      // 'revoked' no es un comando de reproducción — se maneja acá y no en
      // applyRemoteCommand: cierra sesión YA (sin esperar el próximo 401)
      // en vez de aplicarlo contra el reproductor. clearToken() primero,
      // igual que hace apiClient.ts antes de emitir 'xfy:session-expired',
      // para que ningún request en vuelo reintente con el token ya inválido.
      if (cmd.type === 'revoked') {
        stopped = true
        clearToken()
        useAuthStore.getState().handleSessionExpired()
        return
      }
      applyRemoteCommand(cmd)
    }
    // Última versión de cuenta que ESTE dispositivo ya tiene aplicada
    // (nickname/avatar/preferencias/tema/temas custom). Arranca desde lo
    // que ya trae currentUser; si un edit local propio la deja un tick
    // atrás del server, el próximo poll simplemente la vuelve a traer —
    // barato e idempotente, no hace falta distinguir "cambié yo" de
    // "cambió otro dispositivo".
    let knownAccountVersion = currentUser.updatedAt ? new Date(currentUser.updatedAt).getTime() : 0

    // Trae el user y los temas custom frescos y deja que los efectos que
    // ya existen en App.tsx (sobre currentUser.preferences.theme y sobre
    // el store de temas custom) reapliquen el tema — no hay que duplicar
    // esa lógica acá, solo actualizar los dos stores de origen.
    async function syncAccountFromServer() {
      await useAuthStore.getState().refreshUser()
      const email = useAuthStore.getState().currentUser?.email
      await useCustomThemesStore.getState().load(email)
    }

    function sendHeartbeat() {
      const player = usePlayerStore.getState()
      const song = player.currentSong()
      void callApi('devices', 'heartbeat', {
        playerState: song
          ? {
              song: songToPlayerStateSong(song),
              currentTime: player.currentTime,
              isPlaying: player.isPlaying,
              volume: player.volume,
              updatedAt: Date.now(),
            }
          : null,
      })
    }

    function scheduleHeartbeat() {
      if (stopped) return
      heartbeatTimer = window.setTimeout(() => {
        sendHeartbeat()
        scheduleHeartbeat()
      }, isHidden() ? HEARTBEAT_BACKGROUND_MS : HEARTBEAT_MS)
    }

    // Loop de long-poll: nunca hay un "esperar 3s antes de preguntar de
    // nuevo" — cada vuelta arranca apenas termina la anterior. La espera
    // real vive DENTRO de la respuesta del servidor (ver pollCommands).
    async function pollLoop() {
      while (!stopped) {
        try {
          const result = await callApi<{ commands?: RemoteCommand[]; accountVersion?: number | null }>(
            'devices',
            'pollCommands',
            { knownAccountVersion },
          )
          if (stopped) return
          const commands = result.commands ?? []
          for (const cmd of commands) dedupeAndApply(cmd)

          if (result.accountVersion != null && result.accountVersion > knownAccountVersion) {
            knownAccountVersion = result.accountVersion
            void syncAccountFromServer()
          }

          // Ably ya está entregando los comandos casi al instante — no
          // hace falta reabrir el long-poll apenas termina esta vuelta,
          // alcanza con que siga vivo de fondo como red de seguridad y
          // para la sync de cuenta (ver el comentario grande de arriba).
          if (!stopped && realtimeConnected) {
            await new Promise((resolve) => window.setTimeout(resolve, POLL_COOLDOWN_WITH_REALTIME_MS))
          }
        } catch {
          if (stopped) return
          await new Promise((resolve) => window.setTimeout(resolve, POLL_RETRY_MS))
        }
      }
    }

    // Capa realtime (opcional): si el backend no tiene ABLY_API_KEY
    // configurada, connectDeviceRealtime resuelve con una limpieza vacía y
    // realtimeConnected nunca pasa a true — pollLoop sigue exactamente
    // igual que antes, sin que el resto del código se entere de la
    // diferencia.
    let stopRealtime: (() => void) | null = null
    if (currentUser.id) {
      const deviceId = useAuthStore.getState().deviceId
      if (deviceId) {
        void connectDeviceRealtime(
          currentUser.id,
          deviceId,
          (data) => {
            if (stopped) return
            dedupeAndApply(data as RemoteCommand)
          },
          (connected) => {
            realtimeConnected = connected
          },
        ).then((stop) => {
          if (stopped) stop()
          else stopRealtime = stop
        })
      }
    }

    sendHeartbeat()
    scheduleHeartbeat()
    void pollLoop()

    // Al volver del background no hace falta un empujón manual: el
    // long-poll ya estaba corriendo (con la pestaña oculta el navegador
    // puede pausarlo un rato, pero la próxima vuelta del loop llega sola
    // apenas la respuesta en curso resuelve). Sí conviene mandar el
    // heartbeat ya mismo, para que "online" y el playerState se pongan al
    // día sin esperar el próximo tick de 5s.
    function handleVisibilityChange() {
      if (!isHidden()) {
        window.clearTimeout(heartbeatTimer)
        sendHeartbeat()
        scheduleHeartbeat()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      stopped = true
      window.clearTimeout(heartbeatTimer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      // Si connectDeviceRealtime todavía no había resuelto cuando se
      // desmontó, su .then de arriba ve `stopped` en true y limpia solo
      // apenas resuelva — acá solo hace falta el caso en que ya resolvió.
      stopRealtime?.()
    }
  }, [currentUser])
}

function applyRemoteCommand(cmd: RemoteCommand): void {
  const player = usePlayerStore.getState()
  switch (cmd.type) {
    case 'transfer': {
      const songDto = cmd.payload?.song
      if (!songDto) return
      // songDto ya viene con los MISMOS nombres de campo que PlayerSong
      // (ver playerStatePayload.ts: source/videoId/audioSrc/streamUrl/
      // isExternal/albumArtUrl) — antes acá solo llegaban título y
      // artista, así que playQueueAt no tenía cómo resolver audio real.
      const song: PlayerSong = {
        id: songDto.id,
        title: songDto.title,
        artist: songDto.artist,
        albumArtUrl: songDto.albumArtUrl,
        album: songDto.album,
        duration: songDto.duration,
        videoId: songDto.videoId,
        source: songDto.source,
        audioSrc: songDto.audioSrc,
        streamUrl: songDto.streamUrl,
        isExternal: songDto.isExternal,
      }
      void player.playQueueAt([song], 0).then(() => {
        // != null (no solo truthy): un currentTime de 0 es una posición
        // real y válida — con `if (currentTime)` a secas nunca se
        // aplicaba un seek a 0, que quedaba silenciosamente ignorado.
        if (cmd.payload?.currentTime != null) usePlayerStore.getState().seek(cmd.payload.currentTime)
        if (cmd.payload?.volume != null) usePlayerStore.getState().setVolume(cmd.payload.volume)
        if (cmd.payload?.isPlaying === false) usePlayerStore.getState().pause()
      })
      return
    }
    case 'play':
      void player.play()
      return
    case 'pause':
      player.pause()
      return
    case 'seek':
      if (cmd.payload?.time != null) player.seek(cmd.payload.time)
      return
    case 'setVolume':
      if (cmd.payload?.volume != null) player.setVolume(cmd.payload.volume)
      return
    case 'next':
      void player.next()
      return
    case 'previous':
      void player.previous()
      return
  }
}
