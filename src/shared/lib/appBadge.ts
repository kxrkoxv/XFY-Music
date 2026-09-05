// Badging API — puntito/número sobre el ícono de la PWA instalada.
// Lo usamos para "hay lanzamientos nuevos que no viste": releaseWatch suma
// 1 por notificación emitida y el contador se limpia cuando el usuario
// abre la app de nuevo (ver PwaRegistration). Best-effort total: donde no
// hay soporte (Firefox/Safari desktop) es un no-op invisible.

const COUNT_KEY = 'xfy:app-badge-count'

function readCount(): number {
  try {
    return Number(localStorage.getItem(COUNT_KEY)) || 0
  } catch {
    return 0
  }
}

function writeCount(n: number): void {
  try {
    localStorage.setItem(COUNT_KEY, String(n))
  } catch {
    /* noop */
  }
}

/** Suma `n` al contador y refleja el badge en el ícono (si el SO lo permite). */
export async function bumpAppBadge(n = 1): Promise<void> {
  const next = readCount() + n
  writeCount(next)
  try {
    await navigator.setAppBadge?.(next)
  } catch {
    /* sin soporte / no instalada: noop */
  }
}

/** Limpia badge + contador — se llama al volver la app a primer plano. */
export async function clearAppBadge(): Promise<void> {
  if (readCount() === 0) return
  writeCount(0)
  try {
    await navigator.clearAppBadge?.()
  } catch {
    /* noop */
  }
}
