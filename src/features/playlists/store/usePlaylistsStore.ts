import { create } from 'zustand'
import { appDB, type Playlist, type PlaylistSong } from '@shared/lib/db'
import { playlistsSnapshot } from '@shared/lib/localSnapshot'

type PlaylistsStatus = 'idle' | 'loading' | 'ready'

interface PlaylistsState {
  playlists: Playlist[]
  status: PlaylistsStatus
  loadedFor: string | null
  loadPlaylists: (userEmail: string | null | undefined) => Promise<void>
  createPlaylist: (userEmail: string, name: string, description?: string) => Promise<Playlist | null>
  renamePlaylist: (id: string, name: string) => Promise<boolean>
  setPlaylistCover: (id: string, coverUrl: string | null) => Promise<boolean>
  deletePlaylist: (id: string) => Promise<boolean>
  addSong: (id: string, song: PlaylistSong | string | number) => Promise<boolean>
  /** Variante en lote de addSong — una sola request para N canciones, usada
   *  por los imports de YT Music/Spotify. Devuelve cuántas se agregaron. */
  addSongs: (id: string, songs: (PlaylistSong | string | number)[]) => Promise<number>
  removeSong: (id: string, songId: string | number) => Promise<boolean>
  getPlaylist: (id: string) => Playlist | null
}

function sortByRecent(playlists: Playlist[]): Playlist[] {
  return [...playlists].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

export const usePlaylistsStore = create<PlaylistsState>()((set, get) => ({
  playlists: [],
  status: 'idle', // idle | loading | ready
  loadedFor: null,

  // Igual patrón que useAuthStore.restoreSession: si hay un snapshot local
  // de ESTE usuario, se pinta de inmediato (status:'ready' sin esperar la
  // red) y se reconcilia en segundo plano. La UI nunca queda en blanco por
  // un round-trip a Postgres si ya viste tus playlists antes en este
  // dispositivo — que es exactamente lo que hace Spotify al abrir la app.
  loadPlaylists: async (userEmail) => {
    if (!userEmail) return

    const cached = playlistsSnapshot.read(userEmail)
    if (cached) {
      set({ playlists: sortByRecent(cached), status: 'ready', loadedFor: userEmail })
    } else {
      set({ status: 'loading' })
    }

    const playlists = sortByRecent(await appDB.getPlaylistsForUser(userEmail))
    set({ playlists, status: 'ready', loadedFor: userEmail })
    playlistsSnapshot.write(userEmail, playlists)
  },

  createPlaylist: async (userEmail, name, description = '') => {
    const playlist = await appDB.createPlaylist(userEmail, { name, description })
    if (playlist) {
      const next = [playlist, ...get().playlists]
      set({ playlists: next })
      playlistsSnapshot.write(userEmail, next)
    }
    return playlist
  },

  // Optimista: el nombre cambia en pantalla al instante; si el server
  // rechaza el cambio, se revierte al valor anterior en vez de dejar la UI
  // mintiendo sobre algo que no se guardó.
  renamePlaylist: async (id, name) => {
    const prev = get().playlists
    const email = get().playlists.find((p) => p.id === id)?.userEmail
    const next = prev.map((p) => (p.id === id ? { ...p, name } : p))
    set({ playlists: next })
    playlistsSnapshot.write(email, next)

    const ok = await appDB.updatePlaylist(id, { name })
    if (!ok) {
      set({ playlists: prev })
      playlistsSnapshot.write(email, prev)
    }
    return ok
  },

  // coverUrl en null vuelve al collage automático de portadas de canciones.
  setPlaylistCover: async (id, coverUrl) => {
    const prev = get().playlists
    const email = get().playlists.find((p) => p.id === id)?.userEmail
    const next = prev.map((p) => (p.id === id ? { ...p, coverUrl } : p))
    set({ playlists: next })
    playlistsSnapshot.write(email, next)

    const ok = await appDB.updatePlaylist(id, { coverUrl })
    if (!ok) {
      set({ playlists: prev })
      playlistsSnapshot.write(email, prev)
    }
    return ok
  },

  deletePlaylist: async (id) => {
    const prev = get().playlists
    const email = prev.find((p) => p.id === id)?.userEmail
    const next = prev.filter((p) => p.id !== id)
    set({ playlists: next })
    playlistsSnapshot.write(email, next)

    const ok = await appDB.deletePlaylist(id)
    if (!ok) {
      set({ playlists: prev })
      playlistsSnapshot.write(email, prev)
    }
    return ok
  },

  // Optimista — se guarda la playlist tal como estaba antes por si el
  // server la rechaza (ej. canción duplicada según una regla del backend
  // que el cliente no valida localmente).
  addSong: async (id, song) => {
    const prev = get().playlists
    const email = prev.find((p) => p.id === id)?.userEmail
    const songId = String(typeof song === 'object' ? song.id : song)
    const next = prev.map((p) => {
      if (p.id !== id) return p
      const songIds = [...new Set([...(p.songIds || []).map(String), songId])]
      const songs = (p.songs || []).some((existing) => String(existing.id) === songId)
        ? p.songs
        : [...(p.songs || []), typeof song === 'object' ? song : { id: song }]
      return { ...p, songIds, songs }
    })
    set({ playlists: next })
    playlistsSnapshot.write(email, next)

    const ok = await appDB.addSongToPlaylist(id, song)
    if (!ok) {
      set({ playlists: prev })
      playlistsSnapshot.write(email, prev)
    }
    return ok
  },

  // Mismo patrón optimista que addSong, pero para todo el lote de una: se
  // pintan las N canciones de una y se revierte todo junto si el server
  // rechaza el batch.
  addSongs: async (id, songs) => {
    if (songs.length === 0) return 0
    const prev = get().playlists
    const email = prev.find((p) => p.id === id)?.userEmail
    const next = prev.map((p) => {
      if (p.id !== id) return p
      const existingIds = new Set((p.songIds || []).map(String))
      const newFullSongs = songs.filter(
        (s) => typeof s === 'object' && !existingIds.has(String(s.id)),
      ) as PlaylistSong[]
      const songIds = [...new Set([...(p.songIds || []).map(String), ...songs.map((s) => String(typeof s === 'object' ? s.id : s))])]
      return { ...p, songIds, songs: [...(p.songs || []), ...newFullSongs] }
    })
    set({ playlists: next })
    playlistsSnapshot.write(email, next)

    const result = await appDB.addSongsToPlaylist(id, songs)
    if (!result.ok) {
      set({ playlists: prev })
      playlistsSnapshot.write(email, prev)
      return 0
    }
    return result.added
  },

  removeSong: async (id, songId) => {
    const prev = get().playlists
    const email = prev.find((p) => p.id === id)?.userEmail
    const next = prev.map((p) =>
      p.id === id
        ? {
            ...p,
            songIds: (p.songIds || []).filter((sid) => String(sid) !== String(songId)),
            songs: (p.songs || []).filter((s) => String(s.id) !== String(songId)),
          }
        : p,
    )
    set({ playlists: next })
    playlistsSnapshot.write(email, next)

    const ok = await appDB.removeSongFromPlaylist(id, songId)
    if (!ok) {
      set({ playlists: prev })
      playlistsSnapshot.write(email, prev)
    }
    return ok
  },

  getPlaylist: (id) => get().playlists.find((p) => p.id === id) || null,
}))
