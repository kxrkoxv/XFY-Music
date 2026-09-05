// ============================================================
// Release Watch — "salió algo nuevo de mis artistas".
//
// Qué hace: cada cierto tiempo toma los artistas que el usuario REALMENTE
// escucha (top de métricas locales de los últimos 30 días — ver metrics.ts,
// nada sale del dispositivo) y consulta a iTunes si tiene lanzamientos
// más nuevos que la última vez que se vio. Si hay álbum o canción nueva:
// notificación del sistema si la app está en segundo plano, o toast
// in-app si el usuario la está mirando en ese momento (nunca las dos a
// la vez: ver "onlyWhenHidden" en checkArtist).
//
// Por qué iTunes y no YT Music: es la misma fuente que ya alimenta
// portadas y bios en toda la app, expone releaseDate por ítem, es
// pública/CORS-free vía el proxy /api/itunes que ya existe para eso, y no
// necesita autenticación. El matching es por nombre normalizado + artistId
// de Apple cacheado la primera vez (estable entre sweeps).
//
// Reglas anti-spam (las que separan esto de un spam-bot):
//   - Solo artistas con escucha real reciente (umbral abajo).
//   - Primer sweep de un artista = SOLO línea base: nunca notifica cosas
//     viejas "nuevas" para el usuario.
//   - Máximo UNA notificación por artista por sweep (tag colapsa duplicados).
//   - Gap mínimo entre sweeps completos + jitter; respeta ahorro de datos.
//   - Toggle del usuario en Configuración (default ON, pero inerte sin
//     permiso de notificaciones concedido).
// ============================================================

import { getTopArtists } from './metrics'
import { canNotify, showAppNotification } from './appNotifications'
import { toast } from 'sonner'
import { bumpAppBadge } from './appBadge'
import { syncPushWatchState, type WatchedArtistPayload } from './pushNotifications'

const STORAGE_KEY = 'xfy:release-watch:v1'
const ENABLED_KEY = 'xfy:release-watch:enabled'
const SWEEP_MIN_GAP_MS = 6 * 60 * 60 * 1000 // una barrida completa como mucho cada 6 h
const ARTIST_CHECK_GAP_MS = 12 * 60 * 60 * 1000 // por artista, cada 12 h alcanza
const BOOT_DELAY_MS = 45 * 1000 // dejar respirar al arranque (login, SW, prefetch)
const TICK_INTERVAL_MS = 30 * 60 * 1000 // latido de chequeo del gap

/** Escucha mínima para considerar que al usuario LE IMPORTA este artista. */
const MIN_LISTEN_MS = 5 * 60 * 1000 // ≥5 minutos en 30 días...
const MIN_PLAYS = 3 // ...o ≥3 sesiones

interface ArtistSnapshot {
  name: string
  /** ID de artista de Apple (iTunes), estable entre sweeps. */
  appleId?: number
  lastAlbumMs?: number
  lastSongMs?: number
  lastCheckAt?: number
}

interface WatchState {
  artists: Record<string, ArtistSnapshot>
  lastSweepAt?: number
}

function readState(): WatchState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object' && parsed.artists) return parsed as WatchState
  } catch {
    /* estado corrupto: arrancamos limpio */
  }
  return { artists: {} }
}

function writeState(state: WatchState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* storage lleno/modo privado: el watch simplemente no persiste */
  }
}

export function isReleaseWatchEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== '0'
  } catch {
    return true
  }
}

export function setReleaseWatchEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0')
  } catch {
    /* noop */
  }
}

// --- Detección pura (exportada para tests) -------------------------------

export interface ReleaseDiff {
  newAlbum: boolean
  newSong: boolean
  /**
   * false cuando NO había snapshot previo: la primera vez que vemos un
   * artista solo fijamos baseline — avisar "hay nuevo" con el catálogo
   * entero de la primera corrida sería spam garantizado.
   */
  hasBaseline: boolean
}

/**
 * Compara lo último conocido contra lo recién consultado. Un timestamp
 * anterior/igual nunca es "nuevo"; undefined en previo = baseline.
 */
export function diffReleases(
  prev: { lastAlbumMs?: number; lastSongMs?: number } | undefined,
  latest: { albumMs: number; songMs: number },
): ReleaseDiff {
  if (!prev) return { newAlbum: false, newSong: false, hasBaseline: false }
  return {
    hasBaseline: true,
    newAlbum: latest.albumMs > (prev.lastAlbumMs ?? 0),
    newSong: latest.songMs > (prev.lastSongMs ?? 0),
  }
}

// --- Consulta a iTunes ----------------------------------------------------

interface ITunesReleaseItem {
  wrapperType?: string
  artistId?: number
  artistName?: string
  collectionName?: string
  trackName?: string
  releaseDate?: string
  kind?: string
  artworkUrl100?: string
}

/** iTunes sirve el thumb en 100x100 — para avatar de notificación pedimos más resolución. */
function upscaleArtwork(url: string | undefined): string | undefined {
  if (!url) return undefined
  return url.replace(/\/\d+x\d+bb\.(jpg|png)$/i, '/300x300bb.$1')
}

function normName(s: unknown): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

async function itunesSearch(entity: 'album' | 'song', term: string, limit: number): Promise<ITunesReleaseItem[]> {
  const url = `/api/itunes/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`iTunes ${res.status}`)
  const data = (await res.json()) as { results?: ITunesReleaseItem[] }
  return data.results ?? []
}

/** El item más nuevo cuyo artista coincide (evita robar releases de homónimos). */
function newestForArtist(items: ITunesReleaseItem[], artistKey: string): { ms: number; label: string; appleId?: number; artwork?: string } | null {
  let best: { ms: number; label: string; appleId?: number; artwork?: string } | null = null
  for (const it of items) {
    if (!it.releaseDate || !it.artistName) continue
    const n = normName(it.artistName)
    if (!(n === artistKey || n.includes(artistKey) || artistKey.includes(n))) continue
    const ms = Date.parse(it.releaseDate)
    if (!Number.isFinite(ms)) continue
    if (!best || ms > best.ms) {
      best = {
        ms,
        appleId: it.artistId,
        label: it.collectionName || it.trackName || '',
        artwork: upscaleArtwork(it.artworkUrl100),
      }
    }
  }
  return best
}

// --- Barrida --------------------------------------------------------------

let sweeping = false
let bootTimerStarted = false

/**
 * Snapshot actual de los artistas vigilados, en el shape que el server
 * (api/push/state + cron de lanzamientos) espera para poder chequear
 * lanzamientos cuando la app está CERRADA. Solo datos no sensibles:
 * nombre normalizado + últimos timestamps conocidos.
 */
export function watchStatePayload(): WatchedArtistPayload[] {
  const state = readState()
  return Object.values(state.artists)
    .filter((a) => a.name)
    .map((a) => ({
      key: normName(a.name),
      name: a.name,
      lastAlbumMs: a.lastAlbumMs,
      lastSongMs: a.lastSongMs,
    }))
}

/** Artistas calificados según escucha real de los últimos 30 días. */
export function qualifiedArtists(): { name: string; key: string }[] {
  return getTopArtists('30d', 8)
    .filter((a) => a.ms >= MIN_LISTEN_MS || a.count >= MIN_PLAYS)
    .map((a) => ({ name: String(a.name || ''), key: normName(a.name) }))
    .filter((a) => a.name && a.key)
}

async function checkArtist(
  state: WatchState,
  key: string,
  name: string,
): Promise<void> {
  const snap = state.artists[key]

  // Gap por artista: ni iTunes ni el usuario necesitan que martillemos.
  if (snap?.lastCheckAt && Date.now() - snap.lastCheckAt < ARTIST_CHECK_GAP_MS) return

  const [albums, songs] = await Promise.all([
    itunesSearch('album', name, 12),
    itunesSearch('song', name, 25),
  ])

  const albumInfo = newestForArtist(albums, key)
  const songInfo = newestForArtist(songs, key)
  if (!albumInfo && !songInfo) {
    // Sin resultados útiles: igual marcamos el chequeo para no reintentar
    // en loop dentro de la misma hora.
    state.artists[key] = { ...(snap || { name }), lastCheckAt: Date.now() }
    return
  }

  const latest = {
    albumMs: albumInfo?.ms ?? snap?.lastAlbumMs ?? 0,
    songMs: songInfo?.ms ?? snap?.lastSongMs ?? 0,
  }
  const diff = diffReleases(snap, latest)

  // Actualizar SIEMPRE el snapshot (baseline incluido), antes de notificar.
  state.artists[key] = {
    name,
    appleId: albumInfo?.appleId ?? songInfo?.appleId ?? snap?.appleId,
    lastAlbumMs: latest.albumMs || snap?.lastAlbumMs,
    lastSongMs: latest.songMs || snap?.lastSongMs,
    lastCheckAt: Date.now(),
  }

  if (!diff.hasBaseline) return // primera vez: solo baseline, cero spam

  const parts: string[] = []
  if (diff.newAlbum && albumInfo?.label) parts.push(`Álbum: “${albumInfo.label}”`)
  else if (diff.newSong && songInfo?.label) parts.push(`Canción: “${songInfo.label}”`)
  if (parts.length === 0) return

  // Notificación del sistema SOLO si la app está en segundo plano (PWA
  // minimizada/cerrada de tab): ahí es donde realmente hace falta, porque
  // no hay ningún toast en pantalla que la reemplace. Si el usuario está
  // mirando XFY en ese momento, el toast in-app ya cubre el aviso y una
  // notificación del sistema encima sería ruido duplicado — por eso
  // "onlyWhenHidden" y por eso el toast solo se dispara cuando la
  // notificación NO se mostró.
  // Portada del ítem que efectivamente disparó el aviso (álbum si es lo
  // nuevo, si no la de la canción) — así el avatar de la notificación es
  // el arte real del lanzamiento, no un genérico.
  const artwork = (diff.newAlbum && albumInfo?.artwork) || songInfo?.artwork || albumInfo?.artwork

  const notified = await showAppNotification(
    {
      title: `Nuevo lanzamiento de ${name}`,
      body: parts.join(' · '),
      tag: `xfy-release-${key}`,
      image: artwork,
    },
    { onlyWhenHidden: true },
  )
  if (!notified) {
    toast(`Nuevo lanzamiento de ${name}`, { description: parts.join(' · ') })
  }
  // Badge del ícono de la PWA instalada: "hay algo que no viste". Se limpia
  // cuando la app vuelve a primer plano (ver PwaRegistration).
  void bumpAppBadge(1)
}

/**
 * Una pasada por todos los artistas calificados. `force` ignora el gap
 * global (para el toggle manual de Configuración), nunca el permiso.
 */
export async function sweepReleases({ force = false }: { force?: boolean } = {}): Promise<number> {
  if (!isReleaseWatchEnabled() || !canNotify()) return 0
  if (sweeping) return 0
  const state = readState()
  const now = Date.now()
  if (!force && state.lastSweepAt && now - state.lastSweepAt < SWEEP_MIN_GAP_MS) return 0
  sweeping = true
  try {
    // Ahorro de datos activo: esta barrida puede esperar.
    let saveData = false
    try {
      saveData = !!navigator.connection?.saveData
    } catch {
      /* noop */
    }
    if (saveData && !force) return 0

    const artists = qualifiedArtists()
    for (const { key, name } of artists) {
      try {
        await checkArtist(state, key, name)
      } catch {
        /* un artista caído no corta la barrida */
      }
      // Espaciado fino entre requests: misma cortesía que motionart/musicbrainz.
      await new Promise((r) => setTimeout(r, 400))
    }
    state.lastSweepAt = Date.now()
    writeState(state)
    // Espejo al server para el push "app cerrada" (cron diario de
    // api/push/cron-release-watch.ts). Fire-and-forget con throttle interno.
    void syncPushWatchState(watchStatePayload())
    return artists.length
  } finally {
    sweeping = false
  }
}

/**
 * Arranca el latido del watch (una sola vez por sesión de app).
 * Se engancha desde PwaRegistration: después del arranque, cada 30 min
 * evalúa el gap y barre si corresponde.
 */
export function startReleaseWatch(): void {
  if (bootTimerStarted || typeof window === 'undefined') return
  bootTimerStarted = true

  const tick = () => {
    void sweepReleases().catch(() => {})
  }

  window.setTimeout(tick, BOOT_DELAY_MS)
  window.setInterval(tick, TICK_INTERVAL_MS)
}
