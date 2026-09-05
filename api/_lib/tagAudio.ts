/**
 * Incrusta metadata (título/artista/álbum + carátula) en un archivo de
 * audio ya extraído, para la feature de "descargar canción" — inspirado
 * en el "Freely downloadable tracks with tagged metadata" de Spotube.
 *
 * Reusa el mismo patrón de remux.ts (spawn de ffmpeg-static, todo en
 * archivos temporales, timeout, limpieza en finally) en vez de re-encodear
 * el audio: `-c:a copy` conserva el stream bit-a-bit, solo se agregan
 * los átomos/tags de metadata y —si hay carátula— una pista de video
 * "adjunta" (attached_pic), que es como iTunes/la mayoría de los
 * reproductores guardan la carátula embebida en m4a/mp3.
 */

import { spawn } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'

const TAG_TIMEOUT_MS = 30 * 1000

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    if (!ffmpegPath) {
      resolve(false)
      return
    }
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
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
    }, TAG_TIMEOUT_MS)
    child.on('error', () => done(false))
    child.on('close', (code) => done(code === 0))
  })
}

export interface TrackTags {
  title: string
  artist: string
  album?: string | null
}

export interface TagAudioResult {
  buffer: Buffer<ArrayBuffer>
  mimeType: string
  ext: string
}

/**
 * Incrusta tags (+ carátula opcional) en `buffer` (m4a o webm/opus, el
 * mismo mime que ya usa el resto del pipeline de audio). Ante cualquier
 * fallo de ffmpeg devuelve el buffer ORIGINAL sin tags — mejor un
 * archivo sin metadata que ningún archivo.
 */
export async function tagAudio(
  buffer: Buffer<ArrayBuffer>,
  mimeType: string,
  tags: TrackTags,
  coverBuffer?: Buffer<ArrayBuffer> | null,
): Promise<TagAudioResult> {
  const isWebm = mimeType.includes('webm')
  const ext = isWebm ? 'webm' : 'm4a'
  const rand = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const inPath = join(tmpdir(), `xfy-tag-in-${rand}.${ext}`)
  const coverPath = coverBuffer ? join(tmpdir(), `xfy-tag-cover-${rand}.jpg`) : null
  const outPath = join(tmpdir(), `xfy-tag-out-${rand}.${ext}`)

  try {
    await writeFile(inPath, buffer)
    if (coverPath && coverBuffer) await writeFile(coverPath, coverBuffer)

    const metadataArgs = [
      '-metadata',
      `title=${tags.title}`,
      '-metadata',
      `artist=${tags.artist}`,
      ...(tags.album ? ['-metadata', `album=${tags.album}`] : []),
    ]

    // webm/opus no soporta pistas de imagen adjunta de la misma forma que
    // mp4 (sin `attached_pic` estándar cross-player) — para ese caso solo
    // se incrustan los tags de texto, sin carátula, en vez de arriesgar
    // un archivo que algunos reproductores no abran.
    const args =
      coverPath && !isWebm
        ? [
            '-hide_banner', '-loglevel', 'error',
            '-i', inPath,
            '-i', coverPath,
            '-map', '0:a', '-map', '1:v',
            '-c:a', 'copy', '-c:v', 'mjpeg',
            '-disposition:v:0', 'attached_pic',
            ...metadataArgs,
            '-f', 'mp4', outPath,
          ]
        : [
            '-hide_banner', '-loglevel', 'error',
            '-i', inPath,
            '-map', '0:a',
            '-c:a', 'copy',
            ...metadataArgs,
            '-f', isWebm ? 'webm' : 'mp4', outPath,
          ]

    const ok = await runFfmpeg(args)
    if (!ok) return { buffer, mimeType, ext }

    const raw = await readFile(outPath)
    const out = Buffer.from(raw)
    if (!out || out.length < 1000) return { buffer, mimeType, ext }
    return { buffer: out, mimeType, ext }
  } catch {
    return { buffer, mimeType, ext }
  } finally {
    await rm(inPath, { force: true }).catch(() => {})
    if (coverPath) await rm(coverPath, { force: true }).catch(() => {})
    await rm(outPath, { force: true }).catch(() => {})
  }
}
