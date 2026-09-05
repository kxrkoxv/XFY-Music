// ============================================================
// Migración IndexedDB → Postgres, una vez por cuenta.
//
// Se llama automáticamente después de un login/register exitoso (ver
// useAuthStore). Es segura de llamar de más: primero chequea un flag local
// (rápido, evita el trabajo de leer IndexedDB en cada login) y el propio
// backend además ignora una segunda migración para la misma cuenta
// (preferences.migratedLegacy), así que ni un doble-click ni loguear la
// misma cuenta en dos pestañas puede duplicar playlists.
// ============================================================

import { callApi } from '@shared/lib/apiClient'
import { hasLegacyData, readLegacyUser, readLegacyPlaylists, readLegacyThemes } from '@shared/lib/legacyLocalDB'

const MIGRATED_FLAG_PREFIX = 'xfy_migrated_'

function flagKey(email: string): string {
  return `${MIGRATED_FLAG_PREFIX}${email.toLowerCase().trim()}`
}

export async function migrateLegacyDataIfNeeded(email: string): Promise<void> {
  try {
    if (localStorage.getItem(flagKey(email)) === 'done') return
    if (!(await hasLegacyData(email))) {
      localStorage.setItem(flagKey(email), 'done') // nada que migrar, no volver a chequear
      return
    }

    const [user, playlists, customThemes] = await Promise.all([
      readLegacyUser(email),
      readLegacyPlaylists(email),
      readLegacyThemes(email),
    ])

    const payload = {
      preferences: user?.preferences || {},
      favorites: user?.preferences?.favorites || [],
      playlists: playlists.map((p) => ({
        name: p.name,
        description: p.description,
        songs: p.songs,
        coverUrl: p.coverUrl,
      })),
      customThemes: customThemes.map((t) => ({ id: t.id, name: t.name, colors: t.colors })),
    }

    const result = await callApi<{ ok: boolean; skipped?: boolean }>('migrate', 'import', { payload })
    if (result.ok) {
      localStorage.setItem(flagKey(email), 'done')
    }
    // Si falló (red caída, etc.) no marcamos el flag — se reintenta en el próximo login.
  } catch (err) {
    console.error('[XFY] Migración de datos locales falló, se reintentará en el próximo login:', err)
  }
}
