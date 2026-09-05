/**
 * Serverless Function: auditoría del audio ya cacheado en Vercel Blob.
 *
 * Por qué existe: hasta ahora una descarga de googlevideo que se cortaba
 * a mitad de camino (sin que undici tirara error de red) se subía tal
 * cual al Blob como si estuviera completa — el síntoma es un archivo que
 * termina de sonar antes de lo que en teoría dura. api/ytcache.js ya no
 * deja pasar eso hacia adelante (ver _lib/ytstore.js, valida el tamaño
 * descargado contra el Content-Length declarado), pero no arregla lo que
 * YA quedó mal cacheado de antes de ese fix. Este endpoint es la barrida
 * retroactiva: por cada archivo cacheado, compara su duración REAL
 * (parseada del propio archivo) contra la duración que YouTube declaró
 * al momento de extraerlo (guardada como metadata desde ese mismo fix) —
 * si no coincide, lo borra y lo re-extrae con la misma lógica ya
 * validada de ytcache.js.
 *
 * Segunda barrida (duración doblada en Safari): YouTube entrega el audio
 * como MP4/WebM fragmentado (DASH) y Safari/iOS DOBLA la duración que
 * muestra para esos archivos (suma moov + sidx — CHIHIRO marcaba 10:06 en
 * iPhone y 5:03 en PC). Desde el fix de remux (ver _lib/remux.js) la
 * extracción sube contenedores progresivos, pero los archivos cacheados
 * ANTES del fix siguen fragmentados. Para esos no hace falta re-extraer
 * de YouTube (lo lento/frágil): se re-empaqueta el MISMO audio bit-a-bit
 * (`-c copy`) y se re-subbe al mismo path, y recién después se corre el
 * chequeo de duración de arriba sobre el archivo final.
 *
 * GET/POST /api/ytaudit?limit=15&cursor=...&dryRun=true
 *   Authorization: Bearer <ADMIN_TOKEN>
 *   → { checked, corrupt, repaired, failed, skipped, cursor, hasMore, details }
 *
 * Protegido por ADMIN_TOKEN (env var) — a diferencia de /api/ytcache, esto
 * no lo dispara el player: borra y re-descarga contenido ya cacheado, así
 * que dejarlo abierto al público sería una superficie de abuso barata
 * (cualquiera podría forzar re-extracciones masivas). El token va SOLO por
 * header, nunca por query param: los query strings quedan registrados en
 * los logs de acceso de Vercel/CDN/proxies intermedios — un header no.
 *
 * Este endpoint tiene DOS caminos, fusionados en un solo archivo (el plan
 * Hobby de Vercel tope en 12 Serverless Functions por deployment — ver
 * vercel.json — y separarlos hacía saltar ese techo, mismo motivo por el
 * que existen api/proxyutils.ts y api/push.ts):
 *
 *   1) Vercel Cron (header `x-vercel-cron: 1`, o Bearer CRON_SECRET si
 *      está configurado): barrida PERIÓDICA y automática, sin admin de
 *      por medio. Antes de auditar, desaloja los audios más viejos si el
 *      caché supera el cupo blando (SOFT_CAP_BYTES) — con el store lleno,
 *      las extracciones nuevas fallan aunque el audio sea válido. Corre
 *      tandas de runAuditBatch() en loop hasta terminar la barrida
 *      completa o quedarse sin presupuesto de ESTA invocación; el cursor
 *      donde quedó se persiste en el Blob store (audit-cursor.json) para
 *      retomar ahí la próxima corrida en vez de arrancar de cero.
 *
 *   2) Manual (Authorization: Bearer <ADMIN_TOKEN>): una sola tanda, para
 *      debug puntual (dryRun, mirar `details` de una tanda a mano).
 *
 * GET/POST /api/ytaudit?limit=15&cursor=...&dryRun=true
 *   Authorization: Bearer <ADMIN_TOKEN>
 *   → { checked, corrupt, repaired, failed, skipped, cursor, hasMore, details }
 *
 * Procesa en lotes chicos (limit, default 15) y devuelve `cursor` para la
 * próxima tanda — con miles de canciones cacheadas, auditar todo no entra
 * en una sola invocación de 300s, así que esto está pensado para llamarse
 * repetidas veces hasta que `hasMore` sea false.
 */

import { list, del, put } from '@vercel/blob'
import { parseBuffer } from 'music-metadata'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { alreadyCached, extractAndStore, readJsonBlob, PATH_PREFIX } from './_lib/ytstore.ts'
import type { SongMeta } from './_lib/ytstore.ts'
import { isFragmentedMp4, remuxToProgressive } from './_lib/remux.ts'
import { getSongKey, asVideoId, metaIndexPathFor } from '../src/shared/lib/audioCacheKey.ts'

export const config = { maxDuration: 300 }

const TIME_BUDGET_MS = 270 * 1000 // margen bajo los 300s reales del plan
const CRON_TIME_BUDGET_MS = 280 * 1000 // la corrida de cron usa un poco más de margen
const DEFAULT_LIMIT = 15
const CRON_BATCH_LIMIT = 15
const CURSOR_PATH = `${PATH_PREFIX}/_index/audit-cursor.json`

// --- Eviction del caché de audio (solo en el camino de cron) ---
const SOFT_CAP_BYTES = 850 * 1024 * 1024 // arriba de acá se empieza a desalojar
const TARGET_BYTES = 700 * 1024 * 1024 // se baja hasta acá por corrida
const MAX_EVICTIONS_PER_RUN = 40 // techo de `del` por corrida (presupuesto de advanced ops)
const AUDIO_BLOB_RE = /^yt-audio\/([A-Za-z0-9_-]{11})\.(m4a|webm)$/

interface EvictionResult {
  evicted: number
  bytesFreed: number
  totalBefore: number
}

/**
 * Desaloja los audios más viejos si el total del caché supera el cupo
 * blando. uploadedAt hace de proxy de recencia: se refresca en cada
 * re-extracción (allowOverwrite), así que lo primero en salir es lo que
 * llev más tiempo sin revalidarse.
 */
async function evictOldAudio(): Promise<EvictionResult> {
  const audio: { url: string; videoId: string; size: number; uploadedAt: number }[] = []
  let cursor: string | undefined
  let totalBefore = 0

  // Páginas de 1000: el caché entero entra en 1-2 llamadas de list.
  do {
    const page = await list({ prefix: `${PATH_PREFIX}/`, cursor })
    for (const blob of page.blobs) {
      const m = AUDIO_BLOB_RE.exec(blob.pathname)
      if (!m) continue // _index/*.json y otros no-audio no se tocan acá
      audio.push({ url: blob.url, videoId: m[1]!, size: blob.size || 0, uploadedAt: blob.uploadedAt?.getTime?.() ?? 0 })
      totalBefore += blob.size || 0
    }
    cursor = page.cursor
  } while (cursor && audio.length < 5000)

  if (totalBefore <= SOFT_CAP_BYTES) return { evicted: 0, bytesFreed: 0, totalBefore }

  audio.sort((a, b) => a.uploadedAt - b.uploadedAt)

  let total = totalBefore
  let evicted = 0
  let bytesFreed = 0
  for (const item of audio) {
    if (total <= TARGET_BYTES || evicted >= MAX_EVICTIONS_PER_RUN) break
    try {
      await del(item.url)
      // La metadata _by-video es determinística por videoId: fuera también,
      // para que ytaudit no la lea como referencia de un audio que ya no está.
      await del(metaIndexPathFor(asVideoId(item.videoId))).catch(() => {})
      total -= item.size
      bytesFreed += item.size
      evicted++
    } catch {
      /* blob ya ido u error puntual: sigue con el próximo */
    }
  }

  console.log('[ytaudit/cron] eviction', JSON.stringify({ evicted, bytesFreed, totalBefore }))
  return { evicted, bytesFreed, totalBefore }
}

async function readCursor(): Promise<string | undefined> {
  const saved = await readJsonBlob<{ cursor?: string }>(CURSOR_PATH)
  return saved?.cursor || undefined
}

async function saveCursor(cursor: string | null | undefined): Promise<void> {
  await put(CURSOR_PATH, JSON.stringify({ cursor, updatedAt: Date.now() }), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  })
}

/** Camino de Vercel Cron: eviction + barrida completa (todas las tandas que entren en el tiempo). */
async function runCronSweep(res: VercelResponse): Promise<VercelResponse> {
  const startedAt = Date.now()
  const timeLeft = () => CRON_TIME_BUDGET_MS - (Date.now() - startedAt)

  // Eviction primero: liberar espacio es más urgente que auditar (con el
  // store lleno, las extracciones nuevas fallan aunque el audio sea válido).
  let eviction: EvictionResult = { evicted: 0, bytesFreed: 0, totalBefore: 0 }
  try {
    eviction = await evictOldAudio()
  } catch (err) {
    console.warn('[ytaudit/cron] eviction falló (se continúa con la auditoría):', String(err instanceof Error ? err.message : err).slice(0, 120))
  }

  let cursor: string | null | undefined = await readCursor()
  const totals = { batches: 0, checked: 0, corrupt: 0, repaired: 0, failed: 0, skipped: 0 }
  let hasMore = true
  let sweepCompleted = false

  while (hasMore && timeLeft() > 30 * 1000) {
    const batch: AuditBatchResult = await runAuditBatch({ limit: CRON_BATCH_LIMIT, cursor, dryRun: false, timeLeft })
    totals.batches++
    totals.checked += batch.checked
    totals.corrupt += batch.corrupt
    totals.repaired += batch.repaired
    totals.failed += batch.failed
    totals.skipped += batch.skipped

    cursor = batch.cursor
    hasMore = batch.hasMore
    if (!hasMore) sweepCompleted = true
  }

  // Si terminamos la barrida completa, arrancamos de cero la próxima vez.
  // Si nos quedamos sin tiempo a mitad de camino, guardamos el cursor
  // para retomar justo ahí en la corrida siguiente.
  await saveCursor(sweepCompleted ? null : cursor)

  console.log('[ytaudit/cron]', JSON.stringify({ ...totals, sweepCompleted, ...eviction }))

  return res.status(200).json({ ...totals, sweepCompleted, eviction })
}

// Tolerancia: el contenedor real (bitrate variable, padding del muxer)
// nunca da un segundo EXACTO contra lo que YouTube declaró — solo nos
// interesan discrepancias grandes, compatibles con "el archivo quedó
// cortado a mitad de camino", no el ruido normal de redondeo.
const TOLERANCE_ABS_SECS = 5
const TOLERANCE_RATIO = 0.1 // 10%

function isMismatch(actualSecs: number, expectedSecs: number): boolean {
  if (!actualSecs || !expectedSecs) return false // sin uno de los dos datos, no hay nada que comparar
  const diff = Math.abs(actualSecs - expectedSecs)
  return diff > Math.max(TOLERANCE_ABS_SECS, expectedSecs * TOLERANCE_RATIO)
}

function videoIdFromPathname(pathname: string): string | null {
  const m = pathname.match(/^yt-audio\/([A-Za-z0-9_-]{11})\.(m4a|webm)$/)
  return m?.[1] ?? null
}

/** Entrada del reporte por cada archivo auditado. */
export interface AuditDetail {
  videoId: string
  status: string
  reason?: string
  remuxed?: boolean
  actualSecs?: number
  expectedSecs?: number
}

/** Shape completo que devuelven runAuditBatch() y el handler HTTP. */
export interface AuditBatchResult {
  checked: number
  corrupt: number
  repaired: number
  failed: number
  skipped: number
  details: AuditDetail[]
  cursor: string | null
  hasMore: boolean
}

interface RunAuditBatchOptions {
  limit?: number
  cursor?: string | null | undefined
  dryRun?: boolean
  timeLeft?: () => number
}

/**
 * Una sola tanda de auditoría (un `list()` page, hasta `limit` blobs de
 * audio). Compartida con runCronSweep() (mismo archivo, camino de cron)
 * — un fix acá aplica a los dos caminos por igual.
 */
export async function runAuditBatch({
  limit = DEFAULT_LIMIT,
  cursor,
  dryRun = false,
  timeLeft = () => TIME_BUDGET_MS,
}: RunAuditBatchOptions = {}): Promise<AuditBatchResult> {
  // Solo los archivos de audio reales (yt-audio/{videoId}.ext) — el mismo
  // prefijo también contiene yt-audio/_index/*.json, que no nos interesa acá.
  const page = await list({ prefix: `${PATH_PREFIX}/`, cursor: cursor || undefined, limit: limit * 2 })
  const audioBlobs = page.blobs
    .map((b) => ({ blob: b, videoId: videoIdFromPathname(b.pathname) }))
    .filter((e): e is { blob: (typeof page.blobs)[number]; videoId: string } => Boolean(e.videoId))
    .slice(0, limit)

  const result: Omit<AuditBatchResult, 'cursor' | 'hasMore'> = { checked: 0, corrupt: 0, repaired: 0, failed: 0, skipped: 0, details: [] }

  for (const { blob, videoId } of audioBlobs) {
    if (timeLeft() < 20 * 1000) break // no arrancar algo que no vamos a poder terminar

    result.checked++
    try {
      const meta = await readJsonBlob<SongMeta>(metaIndexPathFor(asVideoId(videoId)))
      if (!meta?.durationSecs) {
        result.skipped++
        result.details.push({ videoId, status: 'skipped', reason: 'sin duración de referencia (cacheado antes de este fix)' })
        continue
      }

      const fileRes = await fetch(blob.url)
      if (!fileRes.ok) {
        result.failed++
        result.details.push({ videoId, status: 'failed', reason: `no se pudo descargar (${fileRes.status})` })
        continue
      }
      let buffer = Buffer.from(await fileRes.arrayBuffer())
      let mimeHint = blob.pathname.endsWith('.webm') ? 'audio/webm' : 'audio/mp4'

      // Barrida "doblado en Safari": los archivos cacheados antes del fix
      // de remux son MP4/WebM fragmentados (DASH). Se re-empaquetan in-place
      // sin tocar YouTube — el mismo audio, contenedor progresivo. El chequeo
      // de duración de abajo corre sobre el archivo FINAL, así un archivo
      // que además esté truncado igual termina en re-extracción.
      let remuxed = false
      if (isFragmentedMp4(buffer)) {
        const r = await remuxToProgressive(buffer, mimeHint)
        if (r.buffer !== buffer) {
          await put(blob.pathname, r.buffer, {
            access: 'public',
            contentType: r.mimeType,
            addRandomSuffix: false,
            allowOverwrite: true,
          })
          buffer = r.buffer
          mimeHint = r.mimeType
          remuxed = true
        }
      }

      const parsed = await parseBuffer(buffer, mimeHint).catch((e: unknown) => {
        throw new Error(`archivo ilegible: ${e instanceof Error ? e.message : String(e)}`)
      })
      const actualSecs = parsed?.format?.duration || 0

      if (!isMismatch(actualSecs, meta.durationSecs)) {
        result.details.push({
          videoId,
          status: 'ok',
          remuxed,
          actualSecs: Math.round(actualSecs),
          expectedSecs: meta.durationSecs,
        })
        continue
      }

      result.corrupt++
      result.details.push({
        videoId,
        status: dryRun ? 'corrupt (dry-run)' : 'corrupt',
        actualSecs: Math.round(actualSecs),
        expectedSecs: meta.durationSecs,
      })
      if (dryRun) continue

      await del(blob.url)
      const songKey = getSongKey(meta.title ?? undefined, meta.artist ?? undefined)
      await extractAndStore(videoId, { songKey, title: meta.title ?? undefined, artist: meta.artist ?? undefined })
      // Confirmar que quedó de verdad (extractAndStore puede haber fallado
      // en silencio si resolveAudioUrl encontró el video pero sin formato).
      if (await alreadyCached(videoId)) {
        result.repaired++
        result.details[result.details.length - 1]!.status = 'repaired'
      } else {
        result.failed++
        result.details[result.details.length - 1]!.status = 'delete-only (re-extracción falló)'
      }
    } catch (err) {
      result.failed++
      result.details.push({ videoId, status: 'failed', reason: String(err instanceof Error ? err.message : err).slice(0, 150) })
    }
  }

  return { ...result, cursor: page.hasMore ? (page.cursor ?? null) : null, hasMore: page.hasMore }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<VercelResponse | void> {
  const hasOidc = !!(process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN)
  const hasStaticToken = !!process.env.BLOB_READ_WRITE_TOKEN
  if (!hasOidc && !hasStaticToken) {
    return res.status(503).json({ error: 'Store de Blob no conectado (falta OIDC o BLOB_READ_WRITE_TOKEN)' })
  }

  // Camino 1: Vercel Cron. Header `x-vercel-cron: 1` no falsificable desde
  // afuera (Vercel lo agrega él mismo al llamar) + CRON_SECRET opcional
  // como segunda vía. Si viene por acá, es la barrida periódica completa
  // (eviction + loop de tandas), no el debug manual de una sola tanda.
  const isVercelCron = req.headers['x-vercel-cron'] === '1'
  const cronSecret = process.env.CRON_SECRET
  const hasValidCronSecret = !!cronSecret && req.headers['authorization'] === `Bearer ${cronSecret}`
  if (isVercelCron || hasValidCronSecret) {
    return runCronSweep(res)
  }

  // Camino 2: manual, protegido por ADMIN_TOKEN — una sola tanda (debug,
  // dryRun, mirar `details` a mano).
  const raw: Record<string, unknown> = ((req.method === 'POST' ? req.body : req.query) || {}) as Record<string, unknown>
  const pick = (key: string): string | undefined => {
    const v = raw[key]
    if (typeof v === 'string') return v
    if (Array.isArray(v)) return v.map(String).join(',')
    return undefined
  }

  const adminToken = process.env.ADMIN_TOKEN
  if (!adminToken) {
    return res.status(503).json({ error: 'ADMIN_TOKEN no configurado — auditoría deshabilitada' })
  }
  // Solo header: Authorization: Bearer <token> (o x-admin-token como
  // alias cómodo para curl sin comillas). Nada por query param.
  const authHeader = String(req.headers?.authorization || '')
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const presented = bearer || String(req.headers?.['x-admin-token'] || '').trim()
  if (presented !== adminToken) {
    return res.status(401).json({ error: 'token inválido' })
  }

  const limit = Math.min(Math.max(Number(pick('limit')) || DEFAULT_LIMIT, 1), 50)
  const dryRun = pick('dryRun') === 'true'
  const startedAt = Date.now()
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - startedAt)

  const result = await runAuditBatch({ limit, cursor: pick('cursor'), dryRun, timeLeft })
  return res.status(200).json(result)
}
