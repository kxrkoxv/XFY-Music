import { Home, Compass, Mic2, ListMusic, Settings } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Fuente única de las 5 secciones principales — la usan MobileTabBar
// (abajo, teléfono) y FloatingHeader (arriba, escritorio/tablet) para
// que ambas naveguen exactamente igual en vez de mantener dos listas
// desincronizadas del mismo menú.
export interface NavTab {
  path: string
  label: string
  icon: LucideIcon
  match: (pathname: string) => boolean
}

export const NAV_TABS = [
  { path: '/', label: 'Inicio', icon: Home, match: (p: string) => p === '/' },
  { path: '/discover', label: 'Descubre', icon: Compass, match: (p: string) => p.startsWith('/discover') },
  { path: '/artists', label: 'Artistas', icon: Mic2, match: (p: string) => p.startsWith('/artist') },
  { path: '/playlists', label: 'Playlists', icon: ListMusic, match: (p: string) => p.startsWith('/playlist') },
  { path: '/settings', label: 'Ajustes', icon: Settings, match: (p: string) => p.startsWith('/settings') },
] satisfies readonly NavTab[]

export function activeTabIndex(pathname: string): number {
  const i = NAV_TABS.findIndex((t) => t.match(pathname))
  return i === -1 ? 0 : i
}
