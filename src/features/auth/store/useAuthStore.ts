import { create } from 'zustand'
import { startAuthentication, WebAuthnError } from '@simplewebauthn/browser'
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { appDB, type User } from '@shared/lib/db'
import { callApi, getToken, setToken, clearToken, getLastUserEmail, setLastUserEmail, getDeviceId } from '@shared/lib/apiClient'
import { migrateLegacyDataIfNeeded } from '@features/auth/lib/migrateLegacyData'
import { usePlayerStore } from '@features/player'
import { dedupeSongs, isSameSong, type SongLike } from '@shared/lib/songIdentity'
import { userSnapshot, clearAllSnapshots } from '@shared/lib/localSnapshot'

// Cola de favoritos: ver el comentario largo que tenía este archivo antes
// de la migración — mismo problema de "lost update" con toggles casi
// simultáneos, misma solución (encolar el ciclo leer→calcular→escribir).
let favoriteQueue: Promise<unknown> = Promise.resolve()

type AuthStatus = 'idle' | 'loading' | 'ready'

/** Login con contraseña pendiente de segundo factor — ver login() más abajo:
 *  cuando la cuenta tiene 2FA, el servidor no crea sesión todavía y este es
 *  el "boleto" (challengeToken de corta vida) que hay que devolver junto al
 *  código en verifyTwoFactor(). */
interface PendingTwoFactor {
  challengeToken: string
  keepLoggedIn: boolean
}

interface AuthState {
  currentUser: User | null
  status: AuthStatus
  /** Id estable de este navegador/instalación — ver getDeviceId() en apiClient.ts. */
  deviceId: string
  pendingTwoFactor: PendingTwoFactor | null
  restoreSession: () => Promise<void>
  login: (
    email: string,
    password: string,
    keepLoggedIn: boolean,
  ) => Promise<{ ok: boolean; user?: User | null; requires2fa?: boolean }>
  /** Segundo paso del login cuando login() devolvió requires2fa — `code` es
   *  un TOTP de 6 dígitos o un código de respaldo XXXX-XXXX. */
  verifyTwoFactor: (code: string) => Promise<{ ok: boolean; user?: User | null }>
  cancelTwoFactor: () => void
  /** Login passwordless: el browser deja elegir entre las passkeys guardadas
   *  para este sitio. Tira si el browser no soporta WebAuthn o el usuario
   *  cancela el prompt — el caller decide cómo mostrarlo (toast, etc). */
  loginWithPasskey: (keepLoggedIn: boolean) => Promise<{ ok: boolean; user?: User | null }>
  register: (input: { nickname: string; email: string; password: string }) => Promise<{ ok: boolean; reason?: string }>
  logout: () => void
  handleSessionExpired: () => void
  toggleFavorite: (song: SongLike | string | number) => Promise<boolean | null>
  /** Variante en lote de toggleFavorite para imports masivos: agrega N
   *  canciones a favoritos en una sola request (en vez de N PATCH, cada uno
   *  reenviando el array de favoritos completo). No "destoggle" — solo
   *  agrega las que todavía no son favoritas. Devuelve cuántas se agregaron. */
  addFavorites: (songs: SongLike[]) => Promise<number>
  /** Reconsulta al servidor el usuario actual y actualiza currentUser — lo
   *  usa useDeviceSync cuando otro dispositivo cambió la cuenta (nickname,
   *  avatar, preferencias, tema) para traer eso sin esperar a un reload. */
  refreshUser: () => Promise<void>
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  currentUser: null,
  status: 'idle',
  deviceId: getDeviceId(),
  pendingTwoFactor: null,

  // "Ready" no significa "confirmado por el servidor" — significa "hay
  // algo confiable en pantalla". Igual que Spotify/Apple Music: si hay un
  // snapshot local del último usuario, la app arranca con ESO en el primer
  // frame (status:'ready' inmediato, sin spinner) y confirma/corrige contra
  // el servidor en segundo plano. Sin snapshot (primer login del
  // dispositivo, o se limpió el storage), cae al camino viejo: esperar la
  // red antes de mostrar nada, porque no hay nada honesto que mostrar.
  restoreSession: async () => {
    const token = getToken()
    if (!token) {
      set({ status: 'ready' })
      return
    }

    const cachedEmail = getLastUserEmail()
    const cached = userSnapshot.read(cachedEmail)
    if (cached) {
      set({ currentUser: cached, status: 'ready' })
    } else {
      set({ status: 'loading' })
    }

    const result = await callApi<{ user?: User; error?: string }>('auth', 'me', {}, { silentOn401: true })
    if (result.user) {
      setLastUserEmail(result.user.email)
      userSnapshot.write(result.user.email, result.user)
      set({ currentUser: result.user, status: 'ready' })
    } else {
      // Token inválido: el snapshot que se haya pintado optimistamente
      // era de otra sesión — hay que retirarlo, no dejarlo como si fuera
      // la cuenta activa.
      if (cachedEmail) userSnapshot.clear(cachedEmail)
      clearToken()
      setLastUserEmail(null)
      set({ currentUser: null, status: 'ready' })
    }
  },

  login: async (email, password, keepLoggedIn) => {
    const result = await callApi<{ ok: boolean; requires2fa?: boolean; challengeToken?: string; token?: string; user?: User }>(
      'auth',
      'login',
      { email: email.trim().toLowerCase(), password },
      { anonymous: true },
    )
    if (!result.ok) return { ok: false }

    // Contraseña correcta, pero la cuenta tiene 2FA activado — todavía no
    // hay sesión: se guarda el challenge pendiente y el caller (LoginForm)
    // pasa a pedir el código de la app autenticadora.
    if (result.requires2fa && result.challengeToken) {
      set({ pendingTwoFactor: { challengeToken: result.challengeToken, keepLoggedIn } })
      return { ok: true, requires2fa: true }
    }

    if (!result.token || !result.user) return { ok: false }
    setToken(result.token, keepLoggedIn)
    setLastUserEmail(result.user.email)
    userSnapshot.write(result.user.email, result.user)
    set({ currentUser: result.user })
    void migrateLegacyDataIfNeeded(result.user.email)
    return { ok: true, user: result.user }
  },

  verifyTwoFactor: async (code) => {
    const pending = get().pendingTwoFactor
    if (!pending) return { ok: false }
    const result = await callApi<{ ok: boolean; token?: string; user?: User; reason?: string }>(
      'auth',
      'login2fa',
      { challengeToken: pending.challengeToken, code },
      { anonymous: true },
    )
    if (!result.ok || !result.token || !result.user) return { ok: false }

    setToken(result.token, pending.keepLoggedIn)
    setLastUserEmail(result.user.email)
    userSnapshot.write(result.user.email, result.user)
    set({ currentUser: result.user, pendingTwoFactor: null })
    void migrateLegacyDataIfNeeded(result.user.email)
    return { ok: true, user: result.user }
  },

  cancelTwoFactor: () => set({ pendingTwoFactor: null }),

  loginWithPasskey: async (keepLoggedIn) => {
    const optionsResult = await callApi<{
      ok: boolean
      options?: PublicKeyCredentialRequestOptionsJSON
      challengeToken?: string
    }>('auth', 'webauthnLoginOptions', {}, { anonymous: true })
    if (!optionsResult.ok || !optionsResult.options || !optionsResult.challengeToken) return { ok: false }

    let response
    try {
      response = await startAuthentication({ optionsJSON: optionsResult.options })
    } catch (err) {
      // Cancelado por el usuario o el authenticator no tenía ninguna
      // passkey para este sitio — no es un error real, el caller lo trata
      // como "no se pudo" sin mostrar un toast alarmante.
      if (err instanceof WebAuthnError) return { ok: false }
      throw err
    }

    const verifyResult = await callApi<{ ok: boolean; token?: string; user?: User }>(
      'auth',
      'webauthnLoginVerify',
      { challengeToken: optionsResult.challengeToken, response },
      { anonymous: true },
    )
    if (!verifyResult.ok || !verifyResult.token || !verifyResult.user) return { ok: false }

    setToken(verifyResult.token, keepLoggedIn)
    setLastUserEmail(verifyResult.user.email)
    userSnapshot.write(verifyResult.user.email, verifyResult.user)
    set({ currentUser: verifyResult.user })
    void migrateLegacyDataIfNeeded(verifyResult.user.email)
    return { ok: true, user: verifyResult.user }
  },

  register: async ({ nickname, email, password }) => {
    const result = await callApi<{ ok: boolean; reason?: string; token?: string; user?: User }>(
      'auth',
      'register',
      { nickname: nickname.trim(), email: email.trim().toLowerCase(), password },
      { anonymous: true },
    )
    if (!result.ok) return { ok: false, reason: result.reason }
    if (result.token && result.user) {
      // Login automático tras registrarse — igual que antes.
      setToken(result.token, true)
      setLastUserEmail(result.user.email)
      userSnapshot.write(result.user.email, result.user)
      set({ currentUser: result.user })
      void migrateLegacyDataIfNeeded(result.user.email)
    }
    return { ok: true }
  },

  logout: () => {
    void callApi('auth', 'logout') // borra la sesión actual del lado del servidor
    clearAllSnapshots(get().currentUser?.email ?? getLastUserEmail())
    setLastUserEmail(null)
    clearToken()
    usePlayerStore.getState().reset()
    set({ currentUser: null, pendingTwoFactor: null })
  },

  // Se dispara sola cuando apiClient recibe un 401 (token inválido o
  // vencido). A diferencia de logout(), acá la sesión YA no existe del
  // lado del servidor, así que no tiene sentido pegarle a auth/logout de
  // nuevo: solo limpiar el estado local para que el router mande a /login.
  handleSessionExpired: () => {
    const email = get().currentUser?.email ?? getLastUserEmail()
    if (!email) return // no había sesión activa; nada que limpiar
    clearAllSnapshots(email)
    setLastUserEmail(null)
    clearToken() // ya debería estar limpio (apiClient lo hace antes de emitir el evento), pero por las dudas
    usePlayerStore.getState().reset()
    set({ currentUser: null })
  },

  // Reconsulta /auth/me y pisa currentUser con lo que responda el servidor
  // — mismo endpoint que restoreSession, pero sin la parte de arranque en
  // frío (snapshot optimista, status:'loading'): acá ya hay una sesión
  // andando, solo se trae lo último. silentOn401 porque un 401 en este
  // punto ya lo maneja el listener global de 'xfy:session-expired' en
  // apiClient — no hace falta duplicar el aviso.
  refreshUser: async () => {
    const result = await callApi<{ user?: User; error?: string }>('auth', 'me', {}, { silentOn401: true })
    if (result.user) {
      setLastUserEmail(result.user.email)
      userSnapshot.write(result.user.email, result.user)
      set({ currentUser: result.user })
    }
  },

  // Igual lógica que antes (matchea por identidad canónica, no solo id
  // exacto), solo que ahora la lectura/escritura pasa por el backend en
  // vez de IndexedDB.
  toggleFavorite: async (song) => {
    const candidate: SongLike = typeof song === 'object' && song !== null ? song : { id: song }
    const run = async (): Promise<boolean | null> => {
      const { currentUser } = get()
      if (!currentUser) return null
      const favorites = currentUser.preferences?.favorites || []
      const idx = favorites.findIndex((f) => isSameSong(f, candidate))
      const isNowFavorite = idx === -1
      const nextFavorites = [...favorites]
      if (idx > -1) nextFavorites.splice(idx, 1)
      else nextFavorites.push(candidate)

      const updatedPreferences = { ...currentUser.preferences, favorites: nextFavorites }
      const optimisticUser = { ...currentUser, preferences: updatedPreferences }
      // Optimista: se pinta y se cachea de una, antes de que el server
      // confirme — igual que tocar el corazón en Spotify. Si falla, se
      // revierte tanto el estado en memoria como el snapshot.
      set({ currentUser: optimisticUser })
      userSnapshot.write(currentUser.email, optimisticUser)
      const ok = await appDB.updateUser(currentUser.email, { preferences: updatedPreferences })
      if (!ok) {
        set({ currentUser })
        userSnapshot.write(currentUser.email, currentUser)
        return null
      }
      return isNowFavorite
    }
    const result = favoriteQueue.then(run, run)
    favoriteQueue = result.catch(() => undefined)
    return result
  },

  // Mismo patrón optimista + cola que toggleFavorite (para no pisarse si
  // el usuario togglea algo a mano mientras un import está en curso), pero
  // en un solo request para todo el lote en vez de uno por canción.
  addFavorites: async (songs) => {
    const candidates = songs.filter((s) => s && s.id != null)
    if (candidates.length === 0) return 0
    const run = async (): Promise<number> => {
      const { currentUser } = get()
      if (!currentUser) return 0
      const favorites = currentUser.preferences?.favorites || []
      const newOnes = candidates.filter((c) => !favorites.some((f) => isSameSong(f, c)))
      if (newOnes.length === 0) return 0

      const nextFavorites = dedupeSongs([...favorites, ...newOnes])
      const updatedPreferences = { ...currentUser.preferences, favorites: nextFavorites }
      const optimisticUser = { ...currentUser, preferences: updatedPreferences }
      set({ currentUser: optimisticUser })
      userSnapshot.write(currentUser.email, optimisticUser)

      const result = await appDB.addFavorites(newOnes)
      if (!result.ok) {
        set({ currentUser })
        userSnapshot.write(currentUser.email, currentUser)
        return 0
      }
      if (result.user) {
        set({ currentUser: result.user })
        userSnapshot.write(result.user.email, result.user)
      }
      return newOnes.length
    }
    const result = favoriteQueue.then(run, run)
    favoriteQueue = result.catch(() => 0)
    return result
  },
}))

export function getFavoriteSongs(currentUser: User | null | undefined): SongLike[] {
  const favorites = currentUser?.preferences?.favorites || []
  const valid = favorites.filter((f) => f && typeof f === 'object' && f.id != null && f.title)
  return dedupeSongs(valid)
}

export function isSongFavorite(
  currentUser: User | null | undefined,
  songOrId: SongLike | string | number | null | undefined,
): boolean {
  const favorites = currentUser?.preferences?.favorites || []
  const candidate: SongLike = typeof songOrId === 'object' && songOrId !== null ? songOrId : { id: songOrId as string | number }
  return favorites.some((f) => isSameSong(f, candidate))
}
