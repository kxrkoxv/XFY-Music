// ============================================================
// db.ts — antes hablaba directo con IndexedDB, ahora es un cliente fino del
// backend de cuentas en Postgres/Neon, servido por /api/push (resource !==
// 'push', ver ese archivo). Se mantienen los MISMOS nombres de tipos y el
// MISMO objeto `appDB` con las mismas firmas que ya consumían App.tsx,
// SettingsPage, customThemesStore, usePlaylistsStore y useSpotifyConnectStore
// — así ningún otro archivo tuvo que tocarse para migrar de IndexedDB a
// una base de datos real.
//
// El login/registro/sesión (que sí cambia de forma — ahora es por token en
// vez de sesiones locales) vive en features/auth/store/useAuthStore.ts, que
// habla con apiClient.ts directamente en vez de pasar por acá.
//
// Los datos de otro usuario nunca viajan: cada request se autentica con el
// token del dispositivo (ver apiClient.ts), así que el parámetro `email`
// que reciben estos métodos ya no se usa para autorizar nada — se conserva
// solo para no romper las firmas que ya llamaba el resto de la app.
// ============================================================

import { callApi } from '@shared/lib/apiClient'
import type { SongLike } from '@shared/lib/songIdentity'

export interface SpotifyAuthPrefs {
  accessToken: string
  refreshToken: string
  expiresAt: number
  profileId: string
  displayName: string | null
  avatarUrl: string | null
}

export interface UserPreferences {
  theme: string
  glassClarity?: 'clear' | 'balanced' | 'tinted'
  volume: number
  playbackSpeed: number
  autoPlayNext: boolean
  favorites: SongLike[]
  spotifyAuth?: SpotifyAuthPrefs
  [key: string]: unknown
}

export interface User {
  id?: string
  nickname: string
  email: string
  avatarUrl: string
  preferences: UserPreferences
  /** Si la cuenta tiene 2FA (TOTP) activado — ver features/settings/store/useSecurityStore.ts. */
  totpEnabled?: boolean
  createdAt: string
  updatedAt: string
}

export interface PlaylistSong extends SongLike {
  id: string | number
}

export interface Playlist {
  id: string
  userEmail: string
  name: string
  description: string
  songs: PlaylistSong[]
  songIds: (string | number)[]
  coverUrl: string | null
  createdAt: string
  updatedAt: string
}

export interface CustomThemeRecord {
  id: string
  userEmail: string
  name: string
  colors: Record<string, string>
  [key: string]: unknown
}

class RemoteDB {
  // --- Usuario / preferencias ---
  async updateUser(
    _email: string,
    userDataToUpdate: Partial<Omit<User, 'preferences'>> & { preferences?: Partial<UserPreferences> },
  ): Promise<boolean> {
    const result = await callApi<{ ok: boolean }>('user', 'update', {
      patch: {
        nickname: userDataToUpdate.nickname,
        avatarUrl: userDataToUpdate.avatarUrl,
        preferences: userDataToUpdate.preferences,
      },
    })
    return !!result.ok
  }

  // Variante en lote de toggleFavorite para imports masivos: manda TODAS
  // las canciones nuevas en un solo request en vez de una llamada (con el
  // array de favoritos completo reenviado cada vez) por canción.
  async addFavorites(songs: SongLike[]): Promise<{ ok: boolean; user: User | null }> {
    if (songs.length === 0) return { ok: true, user: null }
    const result = await callApi<{ ok: boolean; user?: User | null }>('user', 'addFavorites', { songs })
    return { ok: !!result.ok, user: result.user ?? null }
  }

  // --- Playlists ---
  async createPlaylist(
    userEmail: string | null | undefined,
    { name, description = '' }: { name?: string; description?: string } = {},
  ): Promise<Playlist | null> {
    if (!userEmail || !name?.trim()) return null
    const result = await callApi<{ playlist: Playlist | null }>('playlists', 'create', { name, description })
    return result.playlist ?? null
  }

  async getPlaylistsForUser(userEmail: string | null | undefined): Promise<Playlist[]> {
    if (!userEmail) return []
    const result = await callApi<{ playlists: Playlist[] }>('playlists', 'list')
    return result.playlists ?? []
  }

  async getPlaylist(id: string | null | undefined): Promise<Playlist | null> {
    if (!id) return null
    const result = await callApi<{ playlist: Playlist | null }>('playlists', 'get', { id })
    return result.playlist ?? null
  }

  async updatePlaylist(id: string, patch: Partial<Playlist>): Promise<boolean> {
    const result = await callApi<{ ok: boolean }>('playlists', 'update', { id, patch })
    return !!result.ok
  }

  async deletePlaylist(id: string | null | undefined): Promise<boolean> {
    if (!id) return false
    const result = await callApi<{ ok: boolean }>('playlists', 'remove', { id })
    return !!result.ok
  }

  async addSongToPlaylist(id: string, song: PlaylistSong | string | number): Promise<boolean> {
    const result = await callApi<{ ok: boolean }>('playlists', 'addSong', { id, song })
    return !!result.ok
  }

  // Variante en lote de addSongToPlaylist: usa el endpoint `addSongs` del
  // backend (ya optimizado a 2 round-trips como mucho) en vez de disparar
  // un request HTTP por canción — pensado para imports (Spotify/YT Music).
  async addSongsToPlaylist(id: string, songs: (PlaylistSong | string | number)[]): Promise<{ ok: boolean; added: number }> {
    if (songs.length === 0) return { ok: true, added: 0 }
    const result = await callApi<{ ok: boolean; added?: number }>('playlists', 'addSongs', { id, songs })
    return { ok: !!result.ok, added: result.added ?? 0 }
  }

  async removeSongFromPlaylist(id: string, songId: string | number): Promise<boolean> {
    const result = await callApi<{ ok: boolean }>('playlists', 'removeSong', { id, songId })
    return !!result.ok
  }

  // --- Temas personalizados ---
  async saveCustomTheme(theme: CustomThemeRecord): Promise<boolean> {
    if (!theme?.id) return false
    const result = await callApi<{ ok: boolean }>('themes', 'save', { theme })
    return !!result.ok
  }

  async getCustomThemesByUser(userEmail: string | null | undefined): Promise<CustomThemeRecord[]> {
    if (!userEmail) return []
    const result = await callApi<{ themes: CustomThemeRecord[] }>('themes', 'list')
    return result.themes ?? []
  }

  async deleteCustomTheme(id: string | null | undefined): Promise<boolean> {
    if (!id) return false
    const result = await callApi<{ ok: boolean }>('themes', 'remove', { id })
    return !!result.ok
  }
}

export const appDB = new RemoteDB()
