/**
 * Extracción + almacenamiento en Vercel Blob del audio de YouTube.
 * Antes vivía duplicado (o iba a empezar a duplicarse) entre
 * api/ytcache.js (extracción normal, disparada por el player) y
 * api/ytaudit.js (re-extracción de archivos que el auditor detecta
 * truncados/corruptos) — se centraliza acá para que un fix de la
 * descarga o de la validación aplique a los dos caminos por igual.
 */

import { head, put } from '@vercel/blob'
import { remuxToProgressive, extractAudioOnly } from './remux.ts'
import { audioExistsTiered, writeAudioTiered } from './tieredAudioStore.ts'
import { getSongKey, asVideoId, candidateAudioPaths, indexPathFor, metaPathFor, metaIndexPathFor } from '../../src/shared/lib/audioCacheKey.ts'
// resolveAudioUrl (ytcore.ts) se importa DINÁMICAMENTE dentro de
// extractAndStore(), no acá arriba — ver el porqué en ese import.

export const PATH_PREFIX = 'yt-audio'

const EXT_BY_MIME = (mime = ''): 'webm' | 'm4a' => {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('mp4') || mime.includes('aac') || mime.includes('m4a')) return 'm4a'
  return 'm4a' // default razonable para audio de YT
}

/** Metadata persistida junto al audio (yt-audio-meta/_by-video/{id}.json). */
export interface SongMeta {
  title?: string | null
  artist?: string | null
  durationSecs?: number | null
  updatedAt?: number
}

export async function alreadyCached(videoId: string): Promise<boolean> {
  for (const pathname of candidateAudioPaths(asVideoId(videoId))) {
    if (await audioExistsTiered(pathname)) return true
  }
  return false
}

export async function readJsonBlob<T>(pathname: string): Promise<T | null> {
  try {
    const meta = await head(pathname)
    const upstream = await fetch(meta.url)
    if (!upstream.ok) return null
    return (await upstream.json()) as T
  } catch {
    return null // no existe, o no es JSON válido — tratamos igual
  }
}

/** ¿Ya tenemos ESTA canción (por título+artista) cacheada bajo otro
 *  videoId? Devuelve ese videoId si el audio referenciado sigue existiendo. */
export async function findCanonicalVideoId(songKey: string | null | undefined): Promise<string | null> {
  if (!songKey) return null
  const entry = await readJsonBlob<{ videoId?: string }>(indexPathFor(asSongKeyOf(songKey)))
  if (!entry?.videoId) return null
  return (await alreadyCached(entry.videoId)) ? entry.videoId : null
}

// getSongKey devuelve SongKey|null (tipo con brand); los callers de este
// módulo ya validaron el shape, acá solo ajustamos el tipo sin re-normalizar.
function asSongKeyOf(key: string) {
  return key as Parameters<typeof indexPathFor>[0]
}

export async function writeSongIndex(
  songKey: string | null | undefined,
  videoId: string,
  title: string | null | undefined,
  artist: string | null | undefined,
): Promise<void> {
  if (!songKey) return
  try {
    await put(indexPathFor(songKey as Parameters<typeof indexPathFor>[0]), JSON.stringify({ videoId, title, artist, updatedAt: Date.now() }), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    })
  } catch (err) {
    console.warn('[ytstore] no se pudo guardar el índice de canción:', String(err instanceof Error ? err.message : err).slice(0, 120))
  }
}

export async function writeSongMeta(
  videoId: string,
  title: string | null | undefined,
  artist: string | null | undefined,
  durationSecs: number | null | undefined,
): Promise<void> {
  if (!title && !artist) return
  const payload = JSON.stringify({ title, artist, durationSecs: durationSecs || null, updatedAt: Date.now() })
  const opts = { access: 'public' as const, contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true }
  try {
    await put(metaPathFor(asVideoId(videoId), artist || ''), payload, opts)
    // Índice plano por videoId — ver comentario en metaIndexPathFor() de
    // audioCacheKey. Se escribe SIEMPRE junto con la metadata agrupada
    // por artista de arriba, nunca por separado, para que nunca queden
    // desincronizadas entre sí.
    await put(metaIndexPathFor(asVideoId(videoId)), payload, opts)
  } catch (err) {
    console.warn('[ytstore] no se pudo guardar metadata:', String(err instanceof Error ? err.message : err).slice(0, 120))
  }
}

const DOWNLOAD_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Plazo duro de la fase de descarga: mejor fallar rápido y liberar el slot
 *  de la cola que sostener un job zombi hasta el timeout de 300s (visto en
 *  logs: un solo job comiendo el presupuesto completo de la instancia). */
const DOWNLOAD_DEADLINE_MS = 150 * 1000

/** Debajo de este tamaño ni molesta paralelizar (overhead > ganancia). */
const PARALLEL_MIN_BYTES = 4 * 1024 * 1024
/** Conexiones simultáneas por descarga — googlevideo limita POR CONEXIÓN,
 *  y el "terminated" de undici casi siempre es UNA conexión cortada a mitad:
 *  trocear por rangos reparte el riesgo y multiplica el throughput real. */
const RANGE_CHUNKS = 4

function fetchRangeChunk(url: string, start: number, end: number, signal: AbortSignal): Promise<Buffer> {
  return fetch(url, {
    headers: { 'User-Agent': DOWNLOAD_UA, Range: `bytes=${start}-${end}` },
    signal,
  }).then(async (res) => {
    if (!res.ok && res.status !== 206) {
      throw new Error(`chunk ${start}-${end}: googlevideo respondió ${res.status}`)
    }
    return Buffer.from(await res.arrayBuffer())
  })
}

/**
 * Descarga `url` en N rangos paralelos y concatena. Cada chunk reintenta
 * solo (el "terminated" típico mata una conexión, no el archivo entero).
 */
async function fetchParallelRanges(url: string, totalBytes: number, deadlineSignal: AbortSignal): Promise<Buffer<ArrayBuffer>> {
  const chunkSize = Math.ceil(totalBytes / RANGE_CHUNKS)
  const chunks = await Promise.all(
    Array.from({ length: RANGE_CHUNKS }, (_, i) => {
      const start = i * chunkSize
      const end = Math.min(totalBytes - 1, start + chunkSize - 1)
      // Reintentos por chunk con backoff corto — mucho más barato que
      // re-descargar TODO el archivo porque se cortó el último tramo.
      const attempt = async (triesLeft: number): Promise<Buffer> => {
        try {
          return await fetchRangeChunk(url, start, end, deadlineSignal)
        } catch (err) {
          if (triesLeft <= 0 || deadlineSignal.aborted) throw err
          await new Promise((r) => setTimeout(r, 600))
          console.warn(
            `[ytstore] chunk ${i + 1}/${RANGE_CHUNKS} reintento (${triesLeft - 1} restantes):`,
            String(err instanceof Error ? err.message : err).slice(0, 100),
          )
          return attempt(triesLeft - 1)
        }
      }
      return attempt(3)
    }),
  )
  const joined = Buffer.concat(chunks)
  return Buffer.from(joined)
}

/**
 * Descarga el audio de googlevideo lo más rápido que la plataforma permite:
 * sondeo del tamaño real → descarga PARALELA por rangos (4 conexiones) con
 * reintentos por chunk → validación estricta del total contra lo declarado.
 *
 * El "terminated" de undici en los logs era UNA conexión single-stream
 * cortada a mitad — obligando a reintentar la descarga COMPLETA (hasta 3x),
 * y con canciones grandes eso empujaba jobs enteros al timeout de 300s.
 *
 * Fallback: si googlevideo no coopera con Content-Range (total desconocido),
 * cae al camino single-stream clásico con sus reintentos.
 */
export async function fetchUpstreamWithRetry(url: string, attempts = 3): Promise<Buffer<ArrayBuffer>> {
  const deadline = new AbortController()
  const deadlineTimer = setTimeout(() => deadline.abort(), DOWNLOAD_DEADLINE_MS)
  try {
    // 1) Sonda bytes=0-0: nos da el tamaño TOTAL vía Content-Range sin bajar nada.
    let totalBytes = 0
    try {
      const probe = await fetch(url, {
        headers: { 'User-Agent': DOWNLOAD_UA, Range: 'bytes=0-0' },
        signal: deadline.signal,
      })
      if (probe.status === 206) {
        const m = /bytes\s+0-0\/(\d+)/i.exec(probe.headers.get('content-range') || '')
        if (m) totalBytes = Number(m[1])
        try {
          await probe.body?.cancel?.()
        } catch {
          /* noop */
        }
      } else {
        try {
          await probe.body?.cancel?.()
        } catch {
          /* noop */
        }
      }
    } catch {
      /* sin sonda: cae al camino single-stream de abajo */
    }

    // 2) Camino rápido: rangos paralelos cuando sabemos el tamaño.
    if (totalBytes >= PARALLEL_MIN_BYTES && totalBytes < 200 * 1024 * 1024) {
      const buffer = await fetchParallelRanges(url, totalBytes, deadline.signal)
      if (buffer.length < totalBytes * 0.99) {
        throw new Error(`descarga incompleta (paralela): ${buffer.length}/${totalBytes} bytes`)
      }
      return buffer
    }

    // 3) Single-stream clásico (archivos chicos o servidor sin ranges).
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try {
        const upstream = await fetch(url, {
          headers: { 'User-Agent': DOWNLOAD_UA },
          signal: deadline.signal,
        })
        if (!upstream.ok && upstream.status !== 206) {
          throw new Error(`googlevideo respondió ${upstream.status}`)
        }
        const declaredLength = Number(upstream.headers.get('content-length') || 0)
        const buffer = Buffer.from(await upstream.arrayBuffer())
        if (declaredLength > 0 && buffer.length < declaredLength * 0.99) {
          throw new Error(`descarga incompleta: ${buffer.length}/${declaredLength} bytes`)
        }
        return buffer
      } catch (err) {
        lastErr = err
        if (i < attempts - 1) {
          console.warn(
            `[ytstore] descarga de googlevideo falló (intento ${i + 1}/${attempts}):`,
            String(err instanceof Error ? err.message : err).slice(0, 120),
          )
        }
      }
    }
    throw lastErr
  } finally {
    clearTimeout(deadlineTimer)
  }
}

/** Opcionales que el cliente puede mandar para dedupe por canción. */
export interface ExtractAndStoreOptions {
  songKey?: string | null
  title?: string | null
  artist?: string | null
}

/** Resultado de una extracción exitosa. */
export interface ExtractResult {
  bytes: number
  durationSecs: number
  ext: 'm4a' | 'webm'
}

/**
 * Extrae `videoId` de YouTube y lo sube al Blob store, con índice y
 * metadata (incluida la duración real declarada por YouTube para ESE
 * formato de audio — no la del catálogo). No hace el chequeo de
 * "¿ya está cacheado?" — eso lo decide el caller (ytcache.js lo evita
 * de entrada para no re-extraer de gusto; ytaudit.js lo llama
 * justamente DESPUÉS de borrar un archivo corrupto, así que acá no
 * corresponde).
 */
export async function extractAndStore(videoId: string, { songKey, title, artist }: ExtractAndStoreOptions = {}): Promise<ExtractResult> {
  // Import dinámico a propósito: jsdom + youtubei.js + bgutils-js son las
  // dependencias más pesadas del proyecto (arman una VM de BotGuard entera).
  // Si esto fuera un import estático arriba del archivo, TODA invocación de
  // /api/ytcache pagaría el costo de parsear/evaluar esas librerías en cada
  // cold start — incluidas las respuestas rápidas de "ya está cacheado" o
  // "es alias de otro videoId", que son la mayoría y nunca llegan a esta
  // función. Con el import acá adentro, ese costo solo se paga cuando de
  // verdad hay que extraer de YouTube (ver guía de Vercel sobre cold
  // starts: "usar imports dinámicos para paths de código divergentes").
  const { resolveAudioUrl, getLastFailureReason } = await import('./ytcore.ts')

  const resolved = await resolveAudioUrl(videoId)
  if (!resolved?.url) throw new Error(`extracción falló: ${getLastFailureReason() || 'sin motivo'}`)

  // El server fetchéa la URL que él mismo firmó — misma IP, sin CORS.
  const buffer = await fetchUpstreamWithRetry(resolved.url)

  // resolveAudioUrl puede haber caído al fallback de formato muxed
  // (video+audio) cuando no había audio-only para ningún cliente — en
  // ese caso hay que tirar la pista de video antes de guardar (ver
  // pickMuxedFallbackFormat en ytcore.ts / extractAudioOnly en remux.ts).
  // Fuera de ese caso puntual, el camino de siempre: YouTube entrega el
  // audio como MP4/WebM fragmentado (DASH). Tal cual, Safari/iOS DOBLA la
  // duración reportada (suma moov + sidx — CHIHIRO marcaba 10:06 en
  // iPhone y 5:03 en PC). Reempaquetamos a contenedor progresivo con
  // -c copy: mismo audio bit-a-bit, sin re-encode, y la duración pasa a
  // salir de una única fuente que todos los navegadores leen igual. Si
  // el remux falla (ffmpeg ausente, input raro) sigue el buffer
  // original: nunca peor que antes del fix.
  const { buffer: storeBuffer, mimeType: storeMime } = resolved.isMuxed
    ? await extractAudioOnly(buffer)
    : await remuxToProgressive(buffer, resolved.mimeType)
  const ext = EXT_BY_MIME(storeMime)

  // allowOverwrite (implícito en R2/B2 vía PUT normal, explícito en Vercel
  // Blob) es clave para la concurrencia real de Fluid Compute (dos
  // invocaciones extrayendo el mismo video casi a la vez no chocan) y
  // también es lo que permite que ytaudit.js reemplace un archivo corrupto
  // por el mismo path determinístico sin un delete+put en dos pasos.
  // El nivel de destino (R2 si está configurado, si no Vercel Blob) lo
  // decide writeAudioTiered — ver tieredAudioStore.ts.
  await writeAudioTiered(`${PATH_PREFIX}/${videoId}.${ext}`, storeBuffer, storeMime)

  await writeSongIndex(songKey, videoId, title, artist)
  await writeSongMeta(videoId, title, artist, resolved.durationSecs)

  return { bytes: storeBuffer.length, durationSecs: resolved.durationSecs, ext }
}

export { getSongKey }
