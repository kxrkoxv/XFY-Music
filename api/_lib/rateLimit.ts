/**
 * Rate limiting por IP usando la MISMA base Neon que ya usa el resto del
 * backend (no hace falta sumar Redis/Upstash solo para esto). Ventana fija
 * ("fixed window"): cada `key` cuenta requests dentro de un intervalo de
 * `windowMs`; al expirar la ventana el contador se reinicia solo.
 *
 * El UPSERT es atómico (una sola sentencia, sin SELECT + UPDATE separados),
 * así que dos requests concurrentes del mismo IP no pueden "pisarse" y
 * saltarse el límite — mismo patrón que ya usa accountResources.ts para
 * evitar race conditions en updates concurrentes.
 *
 * Requiere la tabla `rate_limits` (ver migración al final de db-schema.sql).
 */

import { sql } from './accountDb.ts'

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

/**
 * @param key        identificador único del bucket, ej. `login:203.0.113.4`
 * @param limit       máximo de requests permitidos dentro de la ventana
 * @param windowMs    duración de la ventana en milisegundos
 */
export async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const nextResetIso = new Date(now + windowMs).toISOString()

  try {
    const rows = await sql`
      insert into rate_limits (key, count, reset_at)
      values (${key}, 1, ${nextResetIso})
      on conflict (key) do update
        set count = case
              when rate_limits.reset_at <= ${nowIso} then 1
              else rate_limits.count + 1
            end,
            reset_at = case
              when rate_limits.reset_at <= ${nowIso} then ${nextResetIso}::timestamptz
              else rate_limits.reset_at
            end
      returning count, reset_at
    `
    const row = rows[0]!
    const count = Number(row.count)
    const resetAt = new Date(row.reset_at as string).getTime()
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    }
  } catch (err) {
    // Si la tabla todavía no existe (deploy sin correr la migración) o la
    // DB no responde, preferimos DEJAR PASAR el request antes que tirar
    // abajo login/registro por completo — el rate limiting es defensa
    // adicional, no la única barrera (PBKDF2 + timing-safe compare ya
    // encarecen el brute force). Se loguea para notar el problema.
    console.error('[rateLimit] fallback a "permitir" — revisar tabla rate_limits:', err)
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 }
  }
}

/** IP del cliente detrás del proxy de Vercel. */
export function clientIp(req: { headers: Record<string, string | string[] | undefined> }): string {
  const fwd = req.headers['x-forwarded-for']
  const first = Array.isArray(fwd) ? fwd[0] : fwd
  const ip = first?.split(',')[0]?.trim()
  return ip || 'unknown'
}
