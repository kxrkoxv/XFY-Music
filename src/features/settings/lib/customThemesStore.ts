// ============================================================
// Store compartido de temas personalizados del usuario.
//
// EL BUG QUE ARREGLA ESTO: applyTheme() necesita la lista de temas
// custom para poder resolver un id que no está en THEMES (los
// predefinidos). Antes, esa lista solo vivía como useState LOCAL de
// SettingsPage — nadie más la tenía. App.tsx aplica el tema del
// usuario en un useEffect propio (arranca la app, cambia de sesión,
// etc.) llamando a applyTheme(id) SIN pasar esa lista, así que un
// tema custom nunca resolvía ahí: caía al fallback ('default-dark').
//
// Como persistTheme() (en SettingsPage) actualiza currentUser en
// useAuthStore, y ESE efecto en App.tsx corre en cuanto cambia
// currentUser.preferences.theme, la secuencia real al crear/elegir un
// tema custom era: 1) SettingsPage aplica el tema custom (correcto,
// tiene su lista local) → 2) persiste el id → 3) el efecto de App.tsx
// se dispara por el cambio de currentUser y vuelve a aplicar el tema
// por id, esta vez SIN la lista → no lo encuentra → pisa todo con
// default-dark. El usuario ve su tema "prenderse y apagarse solo".
//
// La solución: UNA sola fuente de verdad para los temas custom,
// compartida por cualquiera que llame a applyTheme (App.tsx,
// SettingsPage, o quien sea en el futuro), en vez de estado de
// componente. Con un plus: un snapshot en localStorage (síncrono, a
// diferencia de IndexedDB) para que el primer applyTheme del boot —
// antes de que la promesa de IndexedDB resuelva — ya tenga los temas
// disponibles y no haya un parpadeo a default-dark en cada carga.
// ============================================================
import { create } from 'zustand'
import { appDB, type CustomThemeRecord } from '@shared/lib/db'

const SNAPSHOT_PREFIX = 'xfy:custom-themes:'

function snapshotKey(email: string): string {
  return `${SNAPSHOT_PREFIX}${email.toLowerCase().trim()}`
}

/** Lee el snapshot síncrono (localStorage) para un usuario — instantáneo,
 * disponible antes de que IndexedDB termine de abrir. Best-effort: en modo
 * privado estricto o con localStorage lleno, simplemente no hay snapshot. */
function readSnapshot(email: string): CustomThemeRecord[] {
  try {
    const raw = localStorage.getItem(snapshotKey(email))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeSnapshot(email: string, themes: CustomThemeRecord[]): void {
  try {
    localStorage.setItem(snapshotKey(email), JSON.stringify(themes))
  } catch {
    /* cuota llena o storage no disponible: la fuente de verdad sigue siendo IndexedDB */
  }
}

interface CustomThemesState {
  email: string | null
  themes: CustomThemeRecord[]
  /** Carga los temas del usuario: primero el snapshot síncrono (sin parpadeo),
   * después reconcilia con IndexedDB (fuente de verdad) en segundo plano. */
  load: (email: string | null | undefined) => Promise<void>
  upsert: (theme: CustomThemeRecord) => void
  remove: (id: string) => void
  clear: () => void
}

export const useCustomThemesStore = create<CustomThemesState>((set, get) => ({
  email: null,
  themes: [],

  load: async (rawEmail) => {
    const email = rawEmail?.toLowerCase().trim() || null
    if (!email) {
      set({ email: null, themes: [] })
      return
    }
    // Fast path síncrono: pinta con lo último conocido de inmediato.
    set({ email, themes: readSnapshot(email) })
    // Reconciliación en segundo plano: IndexedDB manda si hay diferencias
    // (ej. un tema borrado en otra pestaña/sesión).
    const fresh = await appDB.getCustomThemesByUser(email)
    if (get().email !== email) return // el usuario cambió mientras esperábamos
    set({ themes: fresh })
    writeSnapshot(email, fresh)
  },

  upsert: (theme) => {
    const { email, themes } = get()
    if (!email) return
    const next = [...themes.filter((t) => t.id !== theme.id), theme]
    set({ themes: next })
    writeSnapshot(email, next)
  },

  remove: (id) => {
    const { email, themes } = get()
    if (!email) return
    const next = themes.filter((t) => t.id !== id)
    set({ themes: next })
    writeSnapshot(email, next)
  },

  clear: () => set({ email: null, themes: [] }),
}))
