import { create } from 'zustand'
import { lookupArtwork } from '@services/api/itunes'

const CONCURRENCY = 4

/** Shape mínimo de canción para enriquecer portadas. */
interface CatalogSong {
  id?: string | number | null
  title?: string
  artist?: string
  albumArtUrl?: string | null
}

interface CatalogState {
  /** songId -> url de portada mejorada. */
  artwork: Record<string, string>
  resolvedIds: Set<string>
  started: boolean
  enrichAllInBackground: (songs: CatalogSong[]) => Promise<void>
  getArtwork: (song: CatalogSong) => string | null | undefined
}

// Solo portadas — el audio y la info de las canciones son las tuyas
// propias (scr/songs.js). Esto únicamente mejora la imagen cuando la que
// ya tenías (links de Bing/Pinterest) es poco confiable.
export const useCatalogStore = create<CatalogState>()((set, get) => ({
  artwork: {}, // songId -> url
  resolvedIds: new Set<string>(),
  started: false,

  enrichAllInBackground: async (songs) => {
    if (get().started) return
    set({ started: true })

    const queue = [...songs]

    async function worker(): Promise<void> {
      while (queue.length > 0) {
        const song = queue.shift()
        if (!song || !song.id || get().resolvedIds.has(String(song.id))) continue
        const url = await lookupArtwork(song.title ?? '', song.artist ?? '')
        set((state) => ({
          artwork: url ? { ...state.artwork, [String(song.id)]: url } : state.artwork,
          resolvedIds: new Set(state.resolvedIds).add(String(song.id)),
        }))
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  },

  getArtwork: (song) => (song.id != null ? get().artwork[String(song.id)] : undefined) || song.albumArtUrl,
}))
