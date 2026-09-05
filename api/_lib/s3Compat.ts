/**
 * Cliente S3-compatible mínimo para Cloudflare R2 y Backblaze B2, hecho
 * con aws4fetch en vez de @aws-sdk/client-s3: el SDK de AWS pesa varios
 * MB y arrastra dependencias de Node que no hacen falta acá — aws4fetch
 * son ~5kB, firma SigV4 sobre `fetch` nativo y corre igual de bien en
 * Vercel Functions. Cubre SOLO lo que XFY necesita (put/head/get/del/
 * list) — no es un cliente S3 general.
 */
import { AwsClient } from 'aws4fetch'

export interface S3TierConfig {
  /** https://<account-id>.r2.cloudflarestorage.com  |  https://s3.us-west-004.backblazeb2.com */
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** R2 = 'auto'; B2 = el código de región de su propio endpoint (ej. 'us-west-004'). */
  region: string
  /** Dominio público desde donde el CLIENTE lee directo (custom domain, r2.dev, o el "Friendly URL" de B2). */
  publicBaseUrl: string
}

function client(cfg: S3TierConfig): AwsClient {
  return new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: 's3',
    region: cfg.region,
  })
}

function objectUrl(cfg: S3TierConfig, key: string): string {
  return `${cfg.endpoint}/${cfg.bucket}/${key}`
}

/**
 * `cacheControl` es opcional a propósito: los objetos "de control" (el
 * ledger de bytes, el índice de canciones, la metadata) cambian y no
 * deberían quedar pegados en el edge cache. Solo el audio en sí —
 * inmutable por diseño de path — manda el header agresivo (ver
 * IMMUTABLE_AUDIO_CACHE_CONTROL en storageBudget.ts). Un cache-control
 * fuerte en R2 es lo que evita que cada reproducción cuente como
 * operación Class B contra el bucket de origen.
 */
export async function s3Put(
  cfg: S3TierConfig,
  key: string,
  body: Buffer | string,
  contentType: string,
  cacheControl?: string,
): Promise<void> {
  const headers: Record<string, string> = { 'content-type': contentType }
  if (cacheControl) headers['cache-control'] = cacheControl
  const res = await client(cfg).fetch(objectUrl(cfg, key), {
    method: 'PUT',
    body,
    headers,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`s3Put ${key}: ${res.status} ${detail.slice(0, 200)}`)
  }
}

export async function s3Head(cfg: S3TierConfig, key: string): Promise<{ size: number; uploadedAt: number } | null> {
  try {
    const res = await client(cfg).fetch(objectUrl(cfg, key), { method: 'HEAD' })
    if (!res.ok) return null
    return {
      size: Number(res.headers.get('content-length') || 0),
      uploadedAt: Date.parse(res.headers.get('last-modified') || '') || 0,
    }
  } catch {
    return null
  }
}

export async function s3Get(cfg: S3TierConfig, key: string): Promise<Buffer | null> {
  try {
    const res = await client(cfg).fetch(objectUrl(cfg, key))
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

export async function s3Delete(cfg: S3TierConfig, key: string): Promise<void> {
  try {
    await client(cfg).fetch(objectUrl(cfg, key), { method: 'DELETE' })
  } catch {
    /* best-effort: un delete que falla no debe tumbar al caller */
  }
}

export interface S3ListItem {
  key: string
  size: number
  uploadedAt: number
}

/**
 * ListObjectsV2 con paginación por continuation-token. El parseo del XML
 * es a mano (regex sobre `<Contents>...</Contents>`) a propósito: el
 * shape de esta respuesta es plano y siempre igual, no vale la pena sumar
 * una dependencia de parsing XML completa solo para esto.
 */
export async function s3List(
  cfg: S3TierConfig,
  prefix: string,
  continuationToken?: string,
): Promise<{ items: S3ListItem[]; nextToken?: string }> {
  const params = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' })
  if (continuationToken) params.set('continuation-token', continuationToken)
  const res = await client(cfg).fetch(`${cfg.endpoint}/${cfg.bucket}?${params.toString()}`)
  if (!res.ok) throw new Error(`s3List ${prefix}: ${res.status}`)
  const xml = await res.text()

  const items: S3ListItem[] = []
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1] ?? ''
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1]
    const size = /<Size>([\s\S]*?)<\/Size>/.exec(block)?.[1]
    const modified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1]
    if (!key) continue
    items.push({ key, size: Number(size || 0), uploadedAt: modified ? Date.parse(modified) : 0 })
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml)
  const nextToken = truncated ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined
  return { items, nextToken }
}

export function s3PublicUrl(cfg: S3TierConfig, key: string): string {
  return `${cfg.publicBaseUrl.replace(/\/$/, '')}/${key}`
}
