import type { PlayerSong } from '@features/player/store/usePlayerStore'

/**
 * Forma de canción que viaja por la red entre dispositivos (heartbeat Y
 * transfer) — a propósito es un subconjunto de PlayerSong con los MISMOS
 * nombres de campo, para que el dispositivo que la recibe pueda pasarla
 * directo a player.playQueueAt([song], 0) sin ninguna traducción.
 *
 * Bug real que esto arregla: antes, tanto el heartbeat como transferTo()
 * armaban esta forma a mano con solo { id, title, artist, artwork } — así
 * que un "Escuchar en otro dispositivo" le llegaba al destino sin
 * `source`/`videoId`/`audioSrc`/`streamUrl`. isYouTubeSong() (ver
 * usePlayerStore.ts) exige song.source === 'youtube', así que con esos
 * campos faltantes la canción transferida NUNCA entraba por la ruta de
 * YouTube ni por la de audio externo: _loadCurrentAndPlay caía al final a
 * "Sin URL de audio — saltando pista" y se quedaba en silencio. El único
 * motivo por el que title/artist SÍ se veían es que esos dos campos eran
 * los únicos que de verdad viajaban — quedaba metadata sin sonido.
 * También se usaba `artwork` como nombre de campo, que no existe en
 * PlayerSong/SongLike (el campo real es `albumArtUrl`) — quedaba siempre
 * undefined. Acá se usa el nombre real.
 */
export interface PlayerStateSongDTO {
  id: string | number
  title?: string
  artist?: string
  albumArtUrl?: string | null
  album?: string | null
  duration?: number | null
  videoId?: string | null
  source?: string | null
  audioSrc?: string | null
  streamUrl?: string | null
  isExternal?: boolean
}

/** Todo lo que necesita el dispositivo receptor para: a) mostrar qué está
 *  sonando, y b) poder reproducirlo de verdad (no solo mostrar el nombre). */
export function songToPlayerStateSong(song: PlayerSong): PlayerStateSongDTO {
  return {
    id: song.id as string | number,
    title: song.title,
    artist: song.artist,
    albumArtUrl: song.albumArtUrl ?? null,
    album: song.album ?? null,
    duration: song.duration ?? null,
    videoId: song.videoId ?? null,
    source: song.source ?? null,
    audioSrc: song.audioSrc ?? null,
    streamUrl: song.streamUrl ?? null,
    isExternal: song.isExternal,
  }
}
