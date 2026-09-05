// ============================================================
// Home precache — calienta ANTES de tiempo las listas "universales" del
// Home (Tendencias YT Music, Top Global de Apple Music) para que cuando
// el usuario efectivamente entre a /home el primer paint ya tenga datos,
// en vez de arrancar en blanco/skeleton y esperar la red.
//
// No reinventa cacheo: getTrendingTracks/getAppleCharts ya pasan por
// cachedFetch() (localStorage + TTL, ver requestCache.ts) — este módulo
// simplemente los LLAMA temprano (al boot de la app, con la sesión ya
// restaurada) para que esa "verificación" de TTL ocurra por adelantado:
//
//   - Si el caché sigue fresco (< TTL), cachedFetch resuelve del
//     localStorage sin pegarle a la red — el warm-up es gratis.
//   - Si venció, dispara el fetch acá, en segundo plano, en vez de que
//     lo pague el usuario recién al abrir Home.
//
// Las secciones PERSONALIZADAS (Para ti, On Repeat, Descubrimiento...)
// quedan afuera a propósito: dependen de favoriteSongs/recentSongs que
// recién están disponibles una vez que loadPlaylists/metrics hidratan, y
// HomePage ya las resuelve rápido porque son puro cálculo local o
// requests chicos — el costo real está en las dos listas de catálogo de
// arriba, que son las que de verdad tardan.
// ============================================================

import { getTrendingTracks } from '@services/api/ytmusic'
import { getTrendingTracks as getAppleCharts, getPreferredChartCountry } from '@services/api/appleCharts'

const WARM_MIN_GAP_MS = 20 * 60 * 1000 // no repetir el warm-up más de 1 vez cada 20 min
let lastWarmAt = 0
let warming = false

/** Precachea (o revalida si venció el TTL) las listas de catálogo del
 *  Home. Fire-and-forget, silenciosa ante errores: es un adelanto de
 *  trabajo que igual se haría al entrar a Home, nunca algo bloqueante. */
export async function warmHomeCatalogCache(force = false): Promise<void> {
  const now = Date.now()
  if (!force && now - lastWarmAt < WARM_MIN_GAP_MS) return
  if (warming) return
  warming = true
  lastWarmAt = now

  try {
    await Promise.all([
      getTrendingTracks(16).catch(() => {}),
      getAppleCharts(getPreferredChartCountry(), 20).catch(() => {}),
    ])
  } finally {
    warming = false
  }
}
