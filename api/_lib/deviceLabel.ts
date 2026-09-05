/**
 * Heurística chica (sin dependencia de ua-parser) para convertir un
 * User-Agent crudo en algo legible tipo "Chrome en Windows" — se usa para
 * etiquetar sesiones en Ajustes → Seguridad, no necesita ser exacta al
 * 100%, solo lo suficiente para que el usuario reconozca de un vistazo
 * cuál sesión es cuál.
 */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent || ''
  if (!ua) return 'Dispositivo desconocido'

  let browser = 'Navegador'
  if (/EdgA?\//.test(ua)) browser = 'Edge'
  else if (/OPR\//.test(ua)) browser = 'Opera'
  else if (/CriOS\//.test(ua)) browser = 'Chrome'
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome'
  else if (/FxiOS\//.test(ua) || /Firefox\//.test(ua)) browser = 'Firefox'
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari'

  let os = ''
  if (/Windows/.test(ua)) os = 'Windows'
  else if (/Mac OS X/.test(ua) && !/iPhone|iPad|iPod/.test(ua)) os = 'macOS'
  else if (/Android/.test(ua)) os = 'Android'
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS'
  else if (/Linux/.test(ua)) os = 'Linux'

  return os ? `${browser} en ${os}` : browser
}
