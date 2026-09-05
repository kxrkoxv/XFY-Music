/**
 * Remux DASH → progresivo del audio cacheado de YouTube.
 *
 * Por qué existe: YouTube sirve el audio adaptive (itag 140 y amigos) como
 * MP4 *fragmentado* (ftyp + moov + sidx + N fragmentos moof/mdat). Chrome
 * calcula la duración de esos archivos escaneando los fragmentos y la muestra
 * bien, pero Safari/iOS la DOBLE: suma la duración declarada del moov más la
 * cobertura del sidx (303s + 303s = 10:06 en una canción de 5:03). Síntoma
 * reportado en el player: CHIHIRO marcaba 10:06 en iPhone y 5:03 en PC.
 *
 * El fix NO es transcodear a MP3 (re-encode con pérdida, archivos más
 * pesados, y MP3 VBR tiene SU propio bug de duración estimada en Safari) —
 * es reempaquetar el MISMO stream AAC/Opus bit-a-bit (`-c copy`) dentro de
 * un contenedor progresivo normal, cuyo mvhd es la única fuente de verdad
 * de duración para todos los navegadores. Tarda <1s por canción.
 *
 * Todo es best-effort con fallback: si ffmpeg no está, falla, o el output
 * no tiene pinta de audio, se devuelve el buffer original tal cual — el
 * comportamiento queda idéntico al de antes del fix, nunca peor.
 */

import { spawn } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'

const REMUX_TIMEOUT_MS = 60 * 1000

/**
 * ¿Es un MP4 fragmentado (DASH)? Recorre las cajas de primer nivel buscando
 * `sidx`/`moof` — un MP4 progresivo normal no tiene ninguna de las dos.
 * Devuelve false ante cualquier estructura que no pueda parsear: la usamos
 * para DECIDIR si reescribir un archivo ya cacheado, y un falso negativo
 * solo significa "no tocar", nunca corromper.
 */
export function isFragmentedMp4(buffer: Buffer): boolean {  try {
    let off = 0
    while (off + 8 <= buffer.length) {
      const size = buffer.readUInt32BE(off)
      if (size < 8 || off + size > buffer.length) return false
      const type = buffer.toString('latin1', off + 4, off + 8)
      if (type === 'sidx' || type === 'moof') return true
      off += size
    }
    return false
  } catch {
    return false
  }
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    // ffmpeg-static resuelve a string | null: si el binario no está,
    // devolvemos false y el caller cae al buffer original sin tocar nada.
    if (!ffmpegPath) {
      resolve(false)
      return
    }
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done(false)
    }, timeoutMs)
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 4000) stderr += c.toString()
    })
    child.on('error', () => done(false))
    child.on('close', (code) => done(code === 0))
    // Silencia lint de "stderr sin usar" sin perder el buffer para debug futuro.
    void stderr
  })
}

/** Resultado de un remux: buffer + mime del contenedor final. */
export interface RemuxResult {
  buffer: Buffer<ArrayBuffer>
  mimeType: string
}

/**
 * Extrae SOLO el audio de un archivo muxed (video+audio) — usado cuando
 * ytcore.ts tuvo que caer al fallback de formato muxed porque YouTube no
 * ofrecía audio-only para ningún cliente (ver pickMuxedFallbackFormat).
 * Re-encodea a AAC 160k: a diferencia del remux normal (-c copy, mismo
 * stream) acá SÍ hace falta decodificar el contenedor muxed para poder
 * tirar la pista de video, así que no hay forma de evitar el re-encode
 * del audio en este caso puntual. Ante cualquier falla, tira — es un
 * camino ya de por sí "mejor que nada", así que si ni esto funciona el
 * caller debe tratarlo como extracción fallida (no hay buffer original
 * "sin video" al que volver, como sí pasa en remuxToProgressive).
 */
export async function extractAudioOnly(buffer: Buffer<ArrayBuffer>): Promise<RemuxResult> {
  const inPath = join(tmpdir(), `xfy-demux-in-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`)
  const outPath = join(tmpdir(), `xfy-demux-out-${Date.now()}-${Math.random().toString(36).slice(2)}.m4a`)
  try {
    await writeFile(inPath, buffer)
    const ok = await runFfmpeg(
      ['-hide_banner', '-loglevel', 'error', '-i', inPath, '-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-f', 'mp4', outPath],
      REMUX_TIMEOUT_MS,
    )
    if (!ok) throw new Error('ffmpeg no pudo extraer el audio del formato muxed')
    const raw = await readFile(outPath)
    const out = Buffer.from(raw)
    if (!out || out.length < 1000) throw new Error('salida de extracción de audio vacía o corrupta')
    return { buffer: out, mimeType: 'audio/mp4' }
  } finally {
    await rm(inPath, { force: true }).catch(() => {})
    await rm(outPath, { force: true }).catch(() => {})
  }
}

/**
 * Reempaqueta `buffer` (audio de YouTube) a contenedor progresivo con
 * `-c copy` — sin re-encode, sin pérdida. m4a → MP4 progresivo (con
 * faststart, moov adelante); webm → WebM normal con Cues al final.
 * Ante cualquier falla devuelve la entrada intacta con su mime original.
 */
export async function remuxToProgressive(buffer: Buffer<ArrayBuffer>, mimeType: string): Promise<RemuxResult> {
  const isWebm = String(mimeType || '').includes('webm')
  const inPath = join(tmpdir(), `xfy-remux-in-${Date.now()}-${Math.random().toString(36).slice(2)}${isWebm ? '.webm' : '.m4a'}`)
  const outPath = join(tmpdir(), `xfy-remux-out-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const outMime = isWebm ? 'audio/webm' : 'audio/mp4'

  try {
    await writeFile(inPath, buffer)
    const ok = await runFfmpeg(
      isWebm
        ? ['-hide_banner', '-loglevel', 'error', '-i', inPath, '-map', '0:a:0', '-c', 'copy', '-f', 'webm', outPath]
        : ['-hide_banner', '-loglevel', 'error', '-i', inPath, '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', outPath],
      REMUX_TIMEOUT_MS,
    )
    if (!ok) return { buffer, mimeType }

    // Buffer.from(Uint8Array) → Buffer<ArrayBuffer>: mismo shape que la
    // entrada (y el que @vercel/blob espera en PutBody).
    const raw = await readFile(outPath)
    const out = Buffer.from(raw)
    // Sanity check: un remux `-c copy` conserva prácticamente todos los bytes
    // (solo se recorta el overhead de sidx/moof, unos KB). Un output ausente
    // o drásticamente más chico es un remux roto — mejor el original.
    if (!out || out.length < 1000 || out.length < buffer.length * 0.5) {
      return { buffer, mimeType }
    }
    return { buffer: out, mimeType: outMime }
  } catch {
    return { buffer, mimeType }
  } finally {
    await rm(inPath, { force: true }).catch(() => {})
    await rm(outPath, { force: true }).catch(() => {})
  }
}
