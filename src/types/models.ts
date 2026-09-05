// ============================================================
// Contratos de dominio compartidos entre la capa de servicios
// (src/services/api/*) y los consumidores (stores, componentes).
// Fase 3 de la migración TS: la forma de las respuestas deja de ser
// implícita y pasa a ser chequeada en compilación.
// ============================================================

/** Canción tal como la devuelven YT Music (/api/ytmusic) y el player. */
export interface Song {
  id: string
  videoId?: string
  title: string
  artist: string
  artistId?: string | null
  artists?: { name: string; artistId?: string | null }[]
  album?: string | null
  albumArtUrl?: string | null
  source?: string
  duration?: number
  /** Marca una pista inyectada por Smart Shuffle (no forma parte de la
   *  playlist/cola original) — la UI la muestra con el ícono ✨ y no se
   *  persiste si el usuario guarda la cola como playlist. */
  isRecommended?: boolean
}

/** Artista resuelto por búsqueda (YT Music). */
export interface ArtistResult {
  artistId: string
  name: string
  thumbUrl?: string | null
}

/** Álbum en formato básico (grilla de discografía). */
export interface AlbumBasic {
  id: string
  albumId?: string
  title: string
  year?: string | null
  thumbUrl?: string | null
}

/** Álbum con tracklist completo (página de álbum). */
export interface AlbumFull extends AlbumBasic {
  artist?: string | null
  artistId?: string | null
  songs: Song[]
}

/** Playlist pública encontrada por búsqueda (para importar). */
export interface PlaylistInfo {
  id: string
  playlistId?: string
  title: string
  author?: string | null
  thumbUrl?: string | null
  count?: number | null
}

/** Info de artista enriquecida (AudioDB + Wikipedia como fuentes). */
export interface ArtistInfo {
  name?: string
  genre?: string
  style?: string
  biography?: string | null
  biographyIsTranslated?: boolean
  yearFormed?: string
  thumb?: string | null
  country?: string
}

/** Bio de Wikipedia (con link y flag de traducción automática). */
export interface WikipediaBio {
  summary?: string | null
  thumb?: string | null
  wikipediaUrl?: string | null
  translated?: boolean
}

/** Portada resuelta por iTunes Search (ya upscaled). */
export type iTunesArtwork = string | null
