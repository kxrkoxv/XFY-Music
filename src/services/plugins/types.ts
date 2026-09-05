// ============================================================
// Arquitectura de plugins de fuente de música — inspirada en el
// diseño "bring your own source" de Spotube (cada plataforma de audio
// es un plugin intercambiable detrás de una interfaz común, en vez de
// estar hardcodeada en toda la app).
//
// XFY ya tenía 2 fuentes bien integradas (YT Music, Audius) llamadas
// directo desde stores/páginas. Esto NO las reemplaza de un día para
// el otro — envuelve cada una en un adapter que cumple MusicSourcePlugin,
// y agrega Piped como tercera fuente (útil sobre todo como FALLBACK de
// stream cuando YT Music/youtubei.js está bloqueado por bot-detection,
// ver adapters/pipedSource.ts). Los call-sites existentes que importan
// `@services/api/ytmusic` directo siguen funcionando igual; el registry
// es la vía para código NUEVO que quiera "buscá en todas las fuentes
// habilitadas" sin acoplarse a cuáles son.
// ============================================================

import type { Song, ArtistResult } from '@/types/models'

/** Capacidades que un plugin puede declarar. No todos implementan todo
 *  (Piped, por ejemplo, es sobre todo un resolutor de stream — no tiene
 *  búsqueda de artistas propia). */
export interface MusicSourceCapabilities {
  search: boolean
  artistSearch: boolean
  resolveStream: boolean
}

/** Resultado de resolver una URL de stream reproducible para una pista. */
export interface ResolvedStream {
  url: string
  mimeType?: string
  /** Si viene de una fuente que no es el pipeline principal (p. ej. Piped
   *  como fallback de YT Music), para poder loguear/mostrarlo en debug. */
  viaFallback?: boolean
}

/** Contrato común que debe cumplir cualquier fuente de música registrada. */
export interface MusicSourcePlugin {
  /** Id estable, usado como key de habilitado/deshabilitado en localStorage. */
  id: string
  /** Nombre mostrado en Ajustes → Fuentes. */
  name: string
  capabilities: MusicSourceCapabilities
  /** Búsqueda de canciones. Debe devolver [] en vez de tirar si falla. */
  search?(query: string, limit?: number): Promise<Song[]>
  /** Búsqueda de artistas. */
  searchArtists?(query: string, limit?: number): Promise<ArtistResult[]>
  /** Resuelve una URL reproducible para el id de la fuente. */
  resolveStream?(sourceId: string): Promise<ResolvedStream | null>
}
