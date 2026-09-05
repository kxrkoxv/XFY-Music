import { create } from 'zustand'
import { lookupArtwork } from '@services/api/appleClient'

// Apple Music (vía iTunes Search) es ahora la fuente de portada real;
// el thumbnail que trae YT Music sólo se usa como placeholder instantáneo
// mientras Apple resuelve — así la miniatura de YT nunca es la portada
// final salvo que Apple no tenga match.
//
// A diferencia del viejo useCatalogStore (que enriquecía TODO el catálogo
// de una sola vez en background), acá cada canción se resuelve sólo
// cuando de verdad se renderiza en pantalla (bajo demanda desde
// CachedImg). appleClient.js ya serializa y espacia esas requests, así
// que no hace falta un límite de concurrencia extra acá: pedir 20
// portadas visibles a la vez simplemente las encola.

/** Shape mínimo de canción que el store necesita para resolver portada. */
interface ArtworkRequest {
  id?: string | number | null
  title?: string
  artist?: string
  albumArtUrl?: string | null
}

interface ArtworkState {
  /** songId -> url resuelta | null (ya se intentó, sin match). */
  artwork: Record<string, string | null>
  pending: Set<string>
  resolve: (song: ArtworkRequest | null | undefined) => void
  getArtwork: (song: ArtworkRequest | null | undefined) => string | null
}

export const useArtworkStore = create<ArtworkState>()((set, get) => ({
  artwork: {}, // songId -> url resuelta | null (ya se intentó, sin match)
  pending: new Set<string>(),

  resolve: (song) => {
    if (!song?.id || !song.title || !song.artist) return
    const songId = String(song.id)
    if (songId in get().artwork) return
    if (get().pending.has(songId)) return

    set((state) => ({ pending: new Set(state.pending).add(songId) }))

    lookupArtwork(song.title, song.artist)
      .then((url: string | null) => {
        set((state) => {
          const pending = new Set(state.pending)
          pending.delete(songId)
          return { artwork: { ...state.artwork, [songId]: url }, pending }
        })
      })
      .catch(() => {
        set((state) => {
          const pending = new Set(state.pending)
          pending.delete(songId)
          return { pending }
        })
      })
  },

  // Portada a mostrar YA: Apple si ya se resolvió con éxito, si no el
  // thumbnail de YT Music (o el que traiga el proveedor) como relleno.
  getArtwork: (song) => {
    if (!song?.id) return null
    const resolved = get().artwork[String(song.id)]
    return resolved || song.albumArtUrl || null
  },
}))
