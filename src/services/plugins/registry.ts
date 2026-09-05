// ============================================================
// Registro de plugins de fuente de música. Un solo Map en memoria +
// un set de ids habilitados persistido en localStorage (igual patrón
// que xfy_private_session / xfy_data_saver en metrics.ts/smartCache.ts).
//
// Uso típico (código nuevo que quiera abarcar todas las fuentes):
//   import { getEnabledSourcePlugins } from '@services/plugins'
//   const results = await Promise.all(
//     getEnabledSourcePlugins()
//       .filter((p) => p.capabilities.search)
//       .map((p) => p.search!(query).catch(() => [])),
//   )
// ============================================================

import type { MusicSourcePlugin } from './types'

const ENABLED_KEY = 'xfy_enabled_source_plugins'

const registry = new Map<string, MusicSourcePlugin>()

export function registerPlugin(plugin: MusicSourcePlugin): void {
  registry.set(plugin.id, plugin)
}

export function getPlugin(id: string): MusicSourcePlugin | undefined {
  return registry.get(id)
}

export function getAllPlugins(): MusicSourcePlugin[] {
  return [...registry.values()]
}

function readEnabledSet(): Set<string> | null {
  try {
    const raw = localStorage.getItem(ENABLED_KEY)
    if (!raw) return null // null = "nunca se tocó", todos habilitados por default
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr) : null
  } catch {
    return null
  }
}

function writeEnabledSet(ids: Set<string>): void {
  try {
    localStorage.setItem(ENABLED_KEY, JSON.stringify([...ids]))
  } catch {
    // no-op: si localStorage falla, todo sigue habilitado por default
  }
}

export function isPluginEnabled(id: string): boolean {
  const enabled = readEnabledSet()
  if (enabled === null) return true // default: todo prendido
  return enabled.has(id)
}

export function setPluginEnabled(id: string, enabled: boolean): void {
  // Arranca desde "todos los ids conocidos" la primera vez que se toca
  // algo, para que desactivar UNO no deje sin estado a los demás.
  const current = readEnabledSet() ?? new Set(getAllPlugins().map((p) => p.id))
  if (enabled) current.add(id)
  else current.delete(id)
  writeEnabledSet(current)
}

export function getEnabledSourcePlugins(): MusicSourcePlugin[] {
  return getAllPlugins().filter((p) => isPluginEnabled(p.id))
}
