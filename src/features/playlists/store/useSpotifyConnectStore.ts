// ============================================================
// Conexión con la cuenta de Spotify del usuario. A diferencia de un
// simple "token en localStorage", esto vive en preferences (ver
// SpotifyAuthPrefs en db.ts) — la conexión sigue a la cuenta de XFY, no
// al dispositivo/navegador donde se hizo el login.
//
// No usa `persist` de zustand a propósito: la fuente de verdad es
// appDB (IndexedDB, atado al User), este store es solo una vista en
// memoria de ese dato para la sesión actual. `load()` lo hidrata al
// iniciar sesión (ver App.tsx) y cada acción que cambia el token
// (refresh, disconnect) escribe de vuelta a appDB.
// ============================================================
import { create } from 'zustand'
import { appDB, type SpotifyAuthPrefs } from '@shared/lib/db'
import {
  buildSpotifyAuthorizeUrl,
  refreshSpotifyToken,
  fetchSpotifyLibrary,
  type SpotifyLibrary,
} from '@services/api/spotifyAuth'

type ConnectStatus = 'idle' | 'connecting' | 'connected'
// 'restricted': la cuenta hizo login bien, pero Spotify la rechaza con 403
// porque no está en la allowlist de la app (dev mode, cupo de testers) —
// distinto de 'error', que es una falla real (red, token roto, etc).
type LibraryStatus = 'idle' | 'loading' | 'ready' | 'error' | 'restricted'

interface SpotifyConnectState {
  status: ConnectStatus
  auth: SpotifyAuthPrefs | null
  library: SpotifyLibrary | null
  libraryStatus: LibraryStatus
  load: (userEmail: string | null | undefined, auth: SpotifyAuthPrefs | null | undefined) => void
  connect: () => Promise<void>
  disconnect: (userEmail: string) => Promise<void>
  /** Devuelve un access token válido, refrescándolo primero si está por
   *  vencer. Null si no hay conexión activa. */
  ensureAccessToken: (userEmail: string) => Promise<string | null>
  loadLibrary: (userEmail: string) => Promise<void>
}

// Margen de seguridad: refrescar un poco antes de que venza de verdad,
// para no arrancar una llamada a la Web API con un token que expira a
// mitad de la request.
const REFRESH_MARGIN_MS = 60_000

export const useSpotifyConnectStore = create<SpotifyConnectState>()((set, get) => ({
  status: 'idle',
  auth: null,
  library: null,
  libraryStatus: 'idle',

  load: (userEmail, auth) => {
    if (!userEmail) {
      set({ status: 'idle', auth: null, library: null, libraryStatus: 'idle' })
      return
    }
    set({ status: auth ? 'connected' : 'idle', auth: auth || null, library: null, libraryStatus: 'idle' })
  },

  connect: async () => {
    const url = await buildSpotifyAuthorizeUrl()
    window.location.href = url
  },

  disconnect: async (userEmail) => {
    await appDB.updateUser(userEmail, { preferences: { spotifyAuth: undefined } })
    set({ status: 'idle', auth: null, library: null, libraryStatus: 'idle' })
  },

  ensureAccessToken: async (userEmail) => {
    const { auth } = get()
    if (!auth) return null
    if (auth.expiresAt - Date.now() > REFRESH_MARGIN_MS) return auth.accessToken

    try {
      const fresh = await refreshSpotifyToken(auth.refreshToken)
      const nextAuth: SpotifyAuthPrefs = { ...auth, accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, expiresAt: fresh.expiresAt }
      await appDB.updateUser(userEmail, { preferences: { spotifyAuth: nextAuth } })
      set({ auth: nextAuth })
      return nextAuth.accessToken
    } catch {
      // Refresh token inválido/revocado del lado de Spotify — la
      // conexión quedó muerta, hay que volver a loguearse.
      await appDB.updateUser(userEmail, { preferences: { spotifyAuth: undefined } })
      set({ status: 'idle', auth: null, library: null, libraryStatus: 'idle' })
      return null
    }
  },

  loadLibrary: async (userEmail) => {
    const { auth } = get()
    if (!auth) return
    set({ libraryStatus: 'loading' })
    const token = await get().ensureAccessToken(userEmail)
    if (!token) {
      set({ libraryStatus: 'error' })
      return
    }
    try {
      const library = await fetchSpotifyLibrary(token, auth.profileId)
      set({ library, libraryStatus: 'ready' })
    } catch (err) {
      const status = (err as { status?: number } | null)?.status
      set({ libraryStatus: status === 403 ? 'restricted' : 'error' })
    }
  },
}))
