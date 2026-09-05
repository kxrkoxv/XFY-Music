/**
 * Best-effort diagnostics to identify why external media failed to load.
 * Analyzes HTTP headers to detect 404s, HTML fallbacks, or CORS issues.
 */

export async function diagnoseMediaFailure(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-511' } })
    const contentType = res.headers.get('content-type') || ''

    if (res.status === 404) {
      return `404: el recurso no existe en ${url}`
    }
    if (!res.ok) {
      return `HTTP ${res.status} al pedir ${url}`
    }
    if (contentType.includes('text/html')) {
      return 'el servidor devolvió HTML en vez del archivo (posible redirect o endpoint caído)'
    }
    if (!contentType.startsWith('audio/') && !contentType.startsWith('video/') && !contentType.startsWith('application/octet-stream')) {
      return `content-type inesperado ("${contentType || 'ninguno'}") para un archivo de audio/video`
    }
    return `respuesta ${res.status} con content-type "${contentType}" pero el navegador igual lo rechazó — probablemente truncado o corrupto`
  } catch (e) {
    return `no se pudo diagnosticar (${e instanceof Error ? e.message : String(e)}) — probablemente sin red o bloqueado por CORS`
  }
}
