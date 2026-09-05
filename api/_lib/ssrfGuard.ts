/**
 * Protección SSRF para cualquier endpoint que reciba una URL del cliente y
 * la fetchee server-side (hoy: `cover` en api/download.ts).
 *
 * El riesgo: sin esto, un cliente puede pasar `cover=http://169.254.169.254/...`
 * (metadata de la nube), `http://localhost:5432/...` (Postgres/servicios
 * internos del propio deployment), o cualquier IP de una red privada, y el
 * SERVIDOR hace el fetch por vos — el clásico ataque server-side request
 * forgery. Como Vercel corre en infraestructura compartida, esto también
 * podría exponer metadata de la plataforma si no se resuelve y valida la IP
 * real detrás del hostname (un dominio público puede resolver a una IP
 * privada — DNS rebinding).
 *
 * `isPublicHttpUrl` valida: (1) esquema http/https, (2) el hostname no es
 * un literal de IP privada/loopback/link-local, y (3) ninguna de las IPs a
 * las que resuelve el hostname cae en esos rangos tampoco.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true // no parseable → tratar como no seguro
  const [a, b] = parts as [number, number, number, number]
  if (a === 127) return true // loopback
  if (a === 10) return true // privada
  if (a === 172 && b >= 16 && b <= 31) return true // privada
  if (a === 192 && b === 168) return true // privada
  if (a === 169 && b === 254) return true // link-local (incluye metadata de nube: 169.254.169.254)
  if (a === 0) return true // "esta" red
  if (a >= 224) return true // multicast/reservado
  return false
}

function isPrivateOrReservedIPv6(ip: string): boolean {
  const norm = ip.toLowerCase()
  if (norm === '::1') return true // loopback
  if (norm.startsWith('::ffff:')) return isPrivateOrReservedIPv4(norm.slice(7)) // IPv4-mapped
  if (norm.startsWith('fe80:') || norm.startsWith('fc') || norm.startsWith('fd')) return true // link-local / ULA
  return false
}

function isPrivateOrReservedIp(ip: string): boolean {
  return isIP(ip) === 6 ? isPrivateOrReservedIPv6(ip) : isPrivateOrReservedIPv4(ip)
}

/** true si la URL es http(s) pública y no apunta (directo o vía DNS) a una red privada/interna. */
export async function isPublicHttpUrl(rawUrl: string): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  const hostname = parsed.hostname
  if (hostname === 'localhost') return false
  if (isIP(hostname)) return !isPrivateOrReservedIp(hostname)

  try {
    const results = await lookup(hostname, { all: true, verbatim: true })
    if (results.length === 0) return false
    return results.every((r) => !isPrivateOrReservedIp(r.address))
  } catch {
    return false // no resuelve → no lo tratamos como seguro
  }
}
