// Punto de entrada del sistema de plugins: registra las fuentes
// integradas al importar este módulo una vez (ver App.tsx).
import { registerPlugin, getEnabledSourcePlugins, getAllPlugins, isPluginEnabled, setPluginEnabled } from './registry'
import { ytmusicSource } from './adapters/ytmusicSource'
import { audiusSource } from './adapters/audiusSource'
import { pipedSource } from './adapters/pipedSource'

let registered = false
export function registerBuiltinSources(): void {
  if (registered) return
  registered = true
  registerPlugin(ytmusicSource)
  registerPlugin(audiusSource)
  registerPlugin(pipedSource)
}

export { getEnabledSourcePlugins, getAllPlugins, isPluginEnabled, setPluginEnabled }
export type { MusicSourcePlugin, MusicSourceCapabilities, ResolvedStream } from './types'
