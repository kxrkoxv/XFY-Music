import { create } from 'zustand'
import { startRegistration, WebAuthnError } from '@simplewebauthn/browser'
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser'
import { callApi } from '@shared/lib/apiClient'

export interface SessionDTO {
  id: string
  deviceName: string
  ip: string | null
  isCurrent: boolean
  createdAt: string
  lastSeenAt: string
}

export interface PasskeyDTO {
  id: string
  deviceName: string
  createdAt: string
  lastUsedAt: string | null
}

interface SecurityState {
  loadedOnce: boolean
  totpEnabled: boolean
  passkeys: PasskeyDTO[]
  sessions: SessionDTO[]
  sessionsLoading: boolean

  /** Trae el estado general (2FA on/off, lista de passkeys) — lo que pinta
   *  el panel al abrirse. No trae sesiones (fetchSessions es aparte, es una
   *  lista más pesada que solo hace falta si el usuario abre esa sección). */
  fetchStatus: () => Promise<void>
  fetchSessions: () => Promise<void>
  revokeSession: (sessionId: string) => Promise<boolean>
  revokeOtherSessions: () => Promise<boolean>

  /** Ceremonia completa de alta de passkey: pide las options al server,
   *  dispara navigator.credentials.create() vía @simplewebauthn/browser, y
   *  manda la respuesta a verificar. Devuelve reason:'cancelled' si el
   *  usuario cerró el prompt del navegador/OS (no es un error real). */
  addPasskey: (deviceName: string) => Promise<{ ok: boolean; reason?: string }>
  removePasskey: (credentialId: string) => Promise<boolean>

  totpSetupStart: () => Promise<{ ok: boolean; secret?: string; otpauthUrl?: string; reason?: string }>
  totpSetupVerify: (code: string) => Promise<{ ok: boolean; backupCodes?: string[]; reason?: string }>
  totpDisable: (password: string) => Promise<{ ok: boolean; reason?: string }>
  regenerateBackupCodes: (password: string) => Promise<{ ok: boolean; backupCodes?: string[]; reason?: string }>
}

export const useSecurityStore = create<SecurityState>()((set, get) => ({
  loadedOnce: false,
  totpEnabled: false,
  passkeys: [],
  sessions: [],
  sessionsLoading: false,

  fetchStatus: async () => {
    const result = await callApi<{ totpEnabled?: boolean; passkeys?: PasskeyDTO[] }>('security', 'status')
    set({
      totpEnabled: !!result.totpEnabled,
      passkeys: result.passkeys ?? [],
      loadedOnce: true,
    })
  },

  fetchSessions: async () => {
    set({ sessionsLoading: true })
    const result = await callApi<{ sessions?: SessionDTO[] }>('security', 'sessionsList')
    set({ sessions: result.sessions ?? [], sessionsLoading: false })
  },

  revokeSession: async (sessionId) => {
    const result = await callApi<{ ok: boolean }>('security', 'sessionsRevoke', { sessionId })
    if (result.ok) set({ sessions: get().sessions.filter((s) => s.id !== sessionId) })
    return !!result.ok
  },

  revokeOtherSessions: async () => {
    const result = await callApi<{ ok: boolean }>('security', 'sessionsRevokeOthers')
    if (result.ok) set({ sessions: get().sessions.filter((s) => s.isCurrent) })
    return !!result.ok
  },

  addPasskey: async (deviceName) => {
    const optionsResult = await callApi<{
      ok: boolean
      options?: PublicKeyCredentialCreationOptionsJSON
      challengeToken?: string
    }>('security', 'webauthnRegisterOptions')
    if (!optionsResult.ok || !optionsResult.options || !optionsResult.challengeToken) return { ok: false }

    let response
    try {
      response = await startRegistration({ optionsJSON: optionsResult.options })
    } catch (err) {
      if (err instanceof WebAuthnError) return { ok: false, reason: 'cancelled' }
      throw err
    }

    const verifyResult = await callApi<{ ok: boolean; reason?: string }>('security', 'webauthnRegisterVerify', {
      challengeToken: optionsResult.challengeToken,
      response,
      deviceName: deviceName.trim() || 'Passkey',
    })
    if (verifyResult.ok) await get().fetchStatus()
    return { ok: !!verifyResult.ok, reason: verifyResult.reason }
  },

  removePasskey: async (credentialId) => {
    const result = await callApi<{ ok: boolean }>('security', 'webauthnRemove', { credentialId })
    if (result.ok) set({ passkeys: get().passkeys.filter((p) => p.id !== credentialId) })
    return !!result.ok
  },

  totpSetupStart: async () => {
    const result = await callApi<{ ok: boolean; secret?: string; otpauthUrl?: string; reason?: string }>(
      'security',
      'totpSetupStart',
    )
    return result
  },

  totpSetupVerify: async (code) => {
    const result = await callApi<{ ok: boolean; backupCodes?: string[]; reason?: string }>('security', 'totpSetupVerify', {
      code,
    })
    if (result.ok) set({ totpEnabled: true })
    return result
  },

  totpDisable: async (password) => {
    const result = await callApi<{ ok: boolean; reason?: string }>('security', 'totpDisable', { password })
    if (result.ok) set({ totpEnabled: false })
    return result
  },

  regenerateBackupCodes: async (password) => {
    return callApi<{ ok: boolean; backupCodes?: string[]; reason?: string }>('security', 'backupCodesRegenerate', {
      password,
    })
  },
}))
