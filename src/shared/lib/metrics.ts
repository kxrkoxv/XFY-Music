// ============================================================
// Real Listening Metrics — accurate tracking of listening time, top artists/songs, and streaks.
//
// 1. `totals` (xfy_metrics_totals): Cumulative aggregated data (PERMANENT). Tracks all-time totals without bound.
// 2. `events` (xfy_metrics_events): Individual listening events, capped at MAX_EVENTS. Used for recent time-windowed queries.
// ============================================================

const TOTALS_KEY = 'xfy_metrics_totals'
const EVENTS_KEY = 'xfy_metrics_events'
const MAX_EVENTS = 3000
const MAX_DAY_KEYS = 400 // ~13 meses de historial diario para el gráfico/racha
// Minimum milliseconds of playback required for a track to "count" towards metrics.
const MIN_MS_TO_COUNT = 5000
// Interval at which in-progress listening time is flushed to storage to prevent data loss on tab close.
export const FLUSH_INTERVAL_MS = 15000
// Estilo "sesión privada" de Spotify: mientras está activa, esta pestaña no
// suma escuchas a los totales ni a "Para ti". Es por dispositivo (no viaja
// con la cuenta), consistente con que las métricas ya son locales.
const PRIVATE_SESSION_KEY = 'xfy_private_session'

// --- Tipos del dominio de métricas ---
export type Period = '7d' | '30d' | 'all'

interface SongTotals {
  ms: number
  count: number
  title?: string
  artist?: string
  artistId?: string | null
  albumArtUrl?: string | null
  lastPlayedAt?: number
  // Nuevos campos para affinity
  completionSum?: number
  replayCount?: number
  skipCount?: number
  likeBoost?: number
}

interface ArtistTotals {
  ms: number
  count: number
  name?: string
  thumb?: string | null
  completionWeightedMs?: number
}

interface Totals {
  totalMs: number
  firstListenAt: number | null
  songs: Record<string, SongTotals>
  artists: Record<string, ArtistTotals>
  days: Record<string, number>
}

export type StartReason = 'play' | 'next' | 'prev' | 'autoplay' | 'radio' | 'shuffle'
export type EndReason = 'ended' | 'skip_early' | 'skip_mid' | 'skip_late' | 'pause' | 'app_close' | 'error'
export type PlayContext = 'playlist' | 'radio' | 'search' | 'shuffle' | 'smart_shuffle'

export interface ListenEvent {
  songId: string
  title?: string
  artist?: string
  artistId?: string | null
  albumArtUrl?: string | null
  album?: string
  genre?: string
  ts: number
  ms: number
  duration?: number
  completionPct?: number
  startReason?: StartReason
  endReason?: EndReason
  isReplay?: boolean
  context?: PlayContext
}

export interface SkipEvent {
  songId: string
  ts: number
  percentPlayed: number
  isEarlySkip: boolean
}

export interface TopArtist {
  name?: string
  ms: number
  count: number
  thumb?: string | null
}

export interface TopSong {
  id: string
  title?: string
  artist?: string
  artistId?: string | null
  albumArtUrl?: string | null
  ms: number
  count: number
}

/** Canción que llega a recordListen — shape mínimo del player store. */
interface ListenInput {
  id?: string | number | null
  title?: string
  artist?: string
  artistId?: string | null
  albumArtUrl?: string | null
  duration?: number | null
}

export function isPrivateSessionEnabled(): boolean {
  try {
    return localStorage.getItem(PRIVATE_SESSION_KEY) === '1'
  } catch {
    return false
  }
}

export function setPrivateSessionEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(PRIVATE_SESSION_KEY, '1')
    else localStorage.removeItem(PRIVATE_SESSION_KEY)
  } catch {
    // no-op: si localStorage falla, la sesión privada simplemente no persiste
  }
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (e) {
    console.warn('[XFY] No se pudieron guardar las estadísticas')
  }
}

function emptyTotals(): Totals {
  return { totalMs: 0, firstListenAt: null, songs: {}, artists: {}, days: {} }
}

function readTotals(): Totals {
  return readJson(TOTALS_KEY, emptyTotals())
}

function writeTotals(totals: Totals): void {
  writeJson(TOTALS_KEY, totals)
}

const SKIPS_KEY = 'xfy_metrics_skips_v1'
const MAX_SKIPS = 500

function readEvents(): ListenEvent[] {
  const events = readJson(EVENTS_KEY, [])
  return Array.isArray(events) ? events : []
}

function writeEvents(events: ListenEvent[]): void {
  // Trim by quantity, not date, to cap storage size.
  const trimmed = events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events
  writeJson(EVENTS_KEY, trimmed)
}

function readSkips(): SkipEvent[] {
  const skips = readJson(SKIPS_KEY, [])
  return Array.isArray(skips) ? skips : []
}

function writeSkips(skips: SkipEvent[]): void {
  const trimmed = skips.length > MAX_SKIPS ? skips.slice(skips.length - MAX_SKIPS) : skips
  writeJson(SKIPS_KEY, trimmed)
}

function dateKey(timestamp: number): string {
  const d = new Date(timestamp)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function trimDayKeys(days: Record<string, number>): Record<string, number> {
  const keys = Object.keys(days).sort()
  if (keys.length <= MAX_DAY_KEYS) return days
  const toDrop = keys.slice(0, keys.length - MAX_DAY_KEYS)
  toDrop.forEach((k) => delete days[k])
  return days
}

// Lightweight heartbeat: bumps totalMs/days only. Used for the periodic
// (every FLUSH_INTERVAL_MS) safety-net flush during playback so we don't
// lose "time listened today" data on tab close, WITHOUT touching per-song/
// per-artist aggregates — those are committed once per real listen segment
// via recordListen() (see usePlayerStore._flushMetrics). Calling recordListen
// itself on every periodic tick was the old behavior and diluted completion%
// and inflated play counts for anything longer than one flush interval.
export function recordPlaytime(ms: number): void {
  if (!ms || ms <= 0) return
  if (isPrivateSessionEnabled()) return

  const totals = readTotals()
  totals.totalMs += ms
  if (!totals.firstListenAt) totals.firstListenAt = Date.now()

  const key = dateKey(Date.now())
  totals.days[key] = (totals.days[key] || 0) + ms
  totals.days = trimDayKeys(totals.days)

  writeTotals(totals)
}

// Main entry point. Called by usePlayerStore once per real listen segment
// (pause/skip/end/error) with the FULL cumulative ms listened for that
// segment. `skipGlobalTotals` is set when the caller already accounted for
// this ms in totals.totalMs/days via recordPlaytime() heartbeats, to avoid
// double-counting.
export function recordListen(params: {
  song: ListenInput
  ms: number
  duration?: number
  completionPct?: number
  startReason?: StartReason
  endReason?: EndReason
  isReplay?: boolean
  context?: PlayContext
  skipGlobalTotals?: boolean
}): void {
  const { song, ms, duration, completionPct, startReason, endReason, context, skipGlobalTotals } = params
  if (!song?.id || !ms || ms < MIN_MS_TO_COUNT) return
  if (isPrivateSessionEnabled()) return

  const ts = Date.now()
  const songId = String(song.id)

  // Auto-detect replays from today's session events rather than trusting a
  // hand-rolled heuristic upstream — a replay is simply "this song already
  // has an event today". Callers can still force it true.
  const isReplay = params.isReplay || readEvents().some((e) => e.songId === songId && dateKey(e.ts) === dateKey(ts))

  const totals = readTotals()
  if (!skipGlobalTotals) {
    totals.totalMs += ms
    if (!totals.firstListenAt) totals.firstListenAt = ts
  }

  const prevSong = totals.songs[songId] || { ms: 0, count: 0, completionSum: 0, replayCount: 0, skipCount: 0, likeBoost: 0 }
  
  const isSkip = endReason && endReason.startsWith('skip')
  
  totals.songs[songId] = {
    ms: prevSong.ms + ms,
    count: prevSong.count + 1,
    title: song.title,
    artist: song.artist,
    artistId: song.artistId || null,
    albumArtUrl: song.albumArtUrl || prevSong.albumArtUrl || null,
    lastPlayedAt: Date.now(),
    completionSum: (prevSong.completionSum || 0) + Math.min(100, Math.max(0, completionPct || 0)),
    replayCount: (prevSong.replayCount || 0) + (isReplay ? 1 : 0),
    skipCount: (prevSong.skipCount || 0) + (isSkip ? 1 : 0),
    likeBoost: prevSong.likeBoost || 0,
  }

  const artistKey = String(song.artist || '').toLowerCase().trim()
  if (artistKey) {
    const prevArtist = totals.artists[artistKey] || { ms: 0, count: 0, thumb: null, completionWeightedMs: 0 }
    
    // Completion weight: 1.0 = 100%, 0.1 = 10%
    const weight = completionPct !== undefined ? Math.max(0.1, completionPct / 100) : 0.5
    
    totals.artists[artistKey] = {
      ms: prevArtist.ms + ms,
      count: prevArtist.count + 1,
      name: song.artist,
      thumb: prevArtist.thumb || song.albumArtUrl || null,
      completionWeightedMs: (prevArtist.completionWeightedMs || 0) + (ms * weight),
    }
  }

  if (!skipGlobalTotals) {
    const key = dateKey(ts)
    totals.days[key] = (totals.days[key] || 0) + ms
    totals.days = trimDayKeys(totals.days)
  }

  writeTotals(totals)

  writeEvents([
    ...readEvents(),
    {
      songId,
      title: song.title,
      artist: song.artist,
      artistId: song.artistId || null,
      albumArtUrl: song.albumArtUrl || null,
      ts,
      ms,
      duration,
      completionPct,
      startReason,
      endReason,
      isReplay,
      context
    },
  ])
  
  if (isSkip && completionPct !== undefined) {
    writeSkips([
      ...readSkips(),
      {
        songId,
        ts,
        percentPlayed: completionPct,
        isEarlySkip: endReason === 'skip_early' || completionPct < 20
      }
    ])
  }
}

export function recordSave(song: ListenInput): void {
  const songId = String(song.id)
  if (!songId) return
  
  const totals = readTotals()
  if (totals.songs[songId]) {
    totals.songs[songId].likeBoost = (totals.songs[songId].likeBoost || 0) + 1
    writeTotals(totals)
  }
}

function periodStartMs(period: Period): number {
  const now = Date.now()
  if (period === '7d') return now - 7 * 24 * 60 * 60 * 1000
  if (period === '30d') return now - 30 * 24 * 60 * 60 * 1000
  return 0 // 'all'
}

function eventsInPeriod(period: Period): ListenEvent[] {
  if (period === 'all') return readEvents()
  const since = periodStartMs(period)
  return readEvents().filter((e) => e.ts >= since)
}

export function getTotalMs(period: Period = 'all'): number {
  if (period === 'all') return readTotals().totalMs
  return eventsInPeriod(period).reduce((sum, e) => sum + e.ms, 0)
}

export function getTopArtists(period: Period = 'all', limit = 5): TopArtist[] {
  if (period === 'all') {
    return Object.values(readTotals().artists)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, limit)
  }
  const map = new Map()
  eventsInPeriod(period).forEach((e) => {
    const key = String(e.artist || '').toLowerCase().trim()
    if (!key) return
    const cur = map.get(key) || { name: e.artist, ms: 0, count: 0, thumb: e.albumArtUrl }
    cur.ms += e.ms
    cur.count += 1
    if (!cur.thumb) cur.thumb = e.albumArtUrl
    map.set(key, cur)
  })
  return [...map.values()].sort((a, b) => b.ms - a.ms).slice(0, limit)
}

export function getTopSongs(period: Period = 'all', limit = 5): TopSong[] {
  if (period === 'all') {
    return Object.entries(readTotals().songs)
      .map(([id, s]) => ({ id, ...s }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, limit)
  }
  const map = new Map()
  eventsInPeriod(period).forEach((e) => {
    const cur = map.get(e.songId) || {
      id: e.songId,
      title: e.title,
      artist: e.artist,
      artistId: e.artistId,
      albumArtUrl: e.albumArtUrl,
      ms: 0,
      count: 0,
    }
    cur.ms += e.ms
    cur.count += 1
    map.set(e.songId, cur)
  })
  return [...map.values()].sort((a, b) => b.ms - a.ms).slice(0, limit)
}

// Daily listening minutes for activity graphs. Reads from totals.days to cover up to ~13 months.
export function getDailyActivity(days = 14): { date: string; ms: number }[] {
  const totals = readTotals()
  const result = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = dateKey(d.getTime())
    result.push({ date: key, ms: totals.days[key] || 0 })
  }
  return result
}

// Current listening streak in days. Does not break if today has no listens yet.
export function getStreak(): number {
  const totals = readTotals()
  const now = new Date()
  let streak = 0
  for (let i = 0; i < MAX_DAY_KEYS; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = dateKey(d.getTime())
    const hasListen = (totals.days[key] || 0) > 0
    if (hasListen) {
      streak += 1
    } else if (i === 0) {
      continue // hoy sin escuchar todavía — no corta la racha
    } else {
      break
    }
  }
  return streak
}

export function getFirstListenAt(): number | null {
  return readTotals().firstListenAt
}

// Clears all listening history (both totals and events). Resets recommendations.
export function clearMetrics(): void {
  try {
    localStorage.removeItem(TOTALS_KEY)
    localStorage.removeItem(EVENTS_KEY)
    localStorage.removeItem(SKIPS_KEY)
  } catch (e) {
    console.warn('[XFY] No se pudo borrar el historial de escucha')
  }
}

// ------------------------------------------------------------
// Spotify BaRT-inspired Affinity Scoring
// ------------------------------------------------------------
const HALF_LIFE_DAYS = 21
const EVENTS_WINDOW_DAYS = 90
const LONG_TERM_FLOOR_WEIGHT = 0.12

function decayFactor(ageDays: number): number {
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
}

export function getSongAffinityScores(): Map<string, number> {
  const totals = readTotals()
  const scores = new Map<string, number>()
  const now = Date.now()
  
  Object.entries(totals.songs).forEach(([songId, s]) => {
    // 1. Completion average (0-1)
    const avgCompletion = s.count > 0 ? (s.completionSum || 0) / s.count / 100 : 0.5
    
    // 2. Base score using Spotify-like weights
    let score = (avgCompletion * 2.0)
    score += ((s.replayCount || 0) * 1.5)
    score += ((s.likeBoost || 0) * 3.0)
    
    // 3. Skip penalties
    const earlySkips = readSkips().filter(sk => sk.songId === songId && sk.isEarlySkip).length
    const lateSkips = (s.skipCount || 0) - earlySkips
    score -= (earlySkips * 1.2)
    score -= (lateSkips * 0.5)
    
    // 4. Temporal decay based on last played
    const ageDays = s.lastPlayedAt ? (now - s.lastPlayedAt) / (24 * 60 * 60 * 1000) : EVENTS_WINDOW_DAYS
    const decayed = Math.max(0, score) * decayFactor(Math.max(0, ageDays))
    
    // Normalization baseline (ms based)
    const msScore = (s.ms / 60000) * 0.1 // 1 point per 10 minutes
    
    scores.set(songId, decayed + msScore)
  })
  
  return scores
}

export function getAffinityForSong(songId: string | number | null | undefined): number {
  if (songId === null || songId === undefined) return 0
  return getSongAffinityScores().get(String(songId)) || 0
}

export function getArtistAffinityScores(): Map<string, { name: string, score: number, thumb: string | null }> {
  const totals = readTotals()
  const now = Date.now()
  const since = now - EVENTS_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const scores = new Map()
  
  const recentEvents = readEvents().filter(e => e.ts >= since)
  
  recentEvents.forEach(e => {
    const key = String(e.artist || '').toLowerCase().trim()
    if (!key) return
    const ageDays = (now - e.ts) / (24 * 60 * 60 * 1000)
    
    // Completion weighting
    const weight = e.completionPct !== undefined ? Math.max(0.1, e.completionPct / 100) : 0.5
    const recencyBoost = ageDays <= 3 ? 2.0 : 1.0 // Recency bias for last 72h
    
    const weighted = e.ms * weight * recencyBoost * decayFactor(ageDays)
    
    const cur = scores.get(key) || { name: e.artist, score: 0, thumb: e.albumArtUrl }
    cur.score += weighted
    if (!cur.thumb) cur.thumb = e.albumArtUrl
    scores.set(key, cur)
  })
  
  Object.entries(totals.artists).forEach(([key, a]) => {
    const cur = scores.get(key) || { name: a.name, score: 0, thumb: a.thumb }
    // Usa completionWeightedMs si existe
    const baseMs = a.completionWeightedMs || a.ms
    cur.score += baseMs * LONG_TERM_FLOOR_WEIGHT
    if (!cur.thumb) cur.thumb = a.thumb
    scores.set(key, cur)
  })
  
  return scores
}

export function getTasteProfileV2(limit = 5): string[] {
  return [...getArtistAffinityScores().values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.name)
}

// Backward compatibility
export function getTasteProfile(limit = 5): string[] {
  return getTasteProfileV2(limit)
}

export function getAffinityForArtist(artistName: string): number {
  if (!artistName) return 0
  const key = artistName.toLowerCase().trim()
  const scores = getArtistAffinityScores()
  return scores.get(key)?.score || 0
}

export function getSessionContext(): ListenEvent[] {
  // Las últimas 50 canciones de hoy
  const today = new Date().setHours(0,0,0,0)
  return readEvents().filter(e => e.ts >= today).slice(-50)
}

// Combined summary of listening statistics.
export function getStatsSummary(period: Period = 'all') {
  return {
    totalMs: getTotalMs(period),
    topArtists: getTopArtists(period, 5),
    topSongs: getTopSongs(period, 5),
    dailyActivity: getDailyActivity(14),
    streak: getStreak(),
    firstListenAt: getFirstListenAt(),
  }
}

export function formatMinutes(ms: number): string {
  const totalMinutes = Math.round(ms / 60000)
  if (totalMinutes < 60) return `${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60
  return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`
}

// Total milliseconds listened today.
export function getListenedTodayMs(): number {
  const totals = readTotals()
  const key = dateKey(Date.now())
  return totals.days[key] || 0
}

// Infers dominant genre based on recent listening events, by pattern-matching
// against a fixed keyword list in whatever album/genre text each source provides.
export function getTopGenre(limit = 1): string[] {
  const genreMap = new Map()

  readEvents()
    .slice(-500) // Limit to the last 500 events for performance.
    .forEach((e) => {
      const raw = String(e.album || e.genre || '').trim()
      if (!raw || raw.length > 28 || /\d{4}/.test(raw)) return // Skip values that look like years or albums.
      const matched = matchGenre(raw, GENRE_KEYWORDS)
      if (!matched) return
      const cur = genreMap.get(matched) || { genre: matched, ms: 0 }
      cur.ms += e.ms
      genreMap.set(matched, cur)
    })

  return [...genreMap.values()]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit)
    .map((g) => g.genre)
}

// ------------------------------------------------------------
// Niche Mixes — taxonomía de géneros más fina que la lista plana de antes
// (que agrupaba todo lo electrónico como "Electronic" sin distinguir
// house/techno/dnb, todo lo rockero como "Rock" sin distinguir punk/metal
// de indie, etc). GENRE_TO_PARENT deja usar el subgénero fino para
// clustering de nicho y el género padre para las secciones ya existentes
// (getTopGenre / "Hot en X") sin romper nada de lo que ya consumía esos
// nombres.
// ------------------------------------------------------------
const GENRE_TO_PARENT: Record<string, string> = {
  'House': 'Electronic', 'Techno': 'Electronic', 'Trance': 'Electronic',
  'Drum And Bass': 'Electronic', 'Dubstep': 'Electronic', 'EDM': 'Electronic',
  'Electronic': 'Electronic',
  'Trap': 'Hip-Hop', 'Drill': 'Hip-Hop', 'Boom Bap': 'Hip-Hop', 'Hip-Hop': 'Hip-Hop', 'Rap': 'Hip-Hop',
  'Pop': 'Pop', 'K-Pop': 'Pop', 'Synth-Pop': 'Pop', 'Dream Pop': 'Pop',
  'Punk': 'Rock', 'Post-Punk': 'Rock', 'Shoegaze': 'Rock', 'Grunge': 'Rock', 'Rock': 'Rock',
  'R&B': 'R&B', 'Soul': 'R&B', 'Neo-Soul': 'R&B',
  'Alternative': 'Alternative', 'Slowcore': 'Alternative',
  'Ambient': 'Ambient', 'Lo-Fi': 'Ambient',
  'Jazz': 'Jazz', 'Classical': 'Classical', 'Metal': 'Metal',
  'Country': 'Country', 'Latin': 'Latin', 'Reggaeton': 'Latin', 'Corridos': 'Latin',
  'Reggae': 'Reggae', 'Dancehall': 'Reggae',
  'Funk': 'Funk', 'Blues': 'Blues', 'Indie': 'Indie', 'Folk': 'Folk',
}
const NICHE_GENRE_KEYWORDS = Object.keys(GENRE_TO_PARENT)
const GENRE_KEYWORDS = [...new Set(Object.values(GENRE_TO_PARENT))]

function matchGenre(raw: string, keywords: string[]): string | undefined {
  return keywords.find((g) => raw.toLowerCase().includes(g.toLowerCase()) || g.toLowerCase().includes(raw.toLowerCase()))
}

// Calculates the user's peak listening hour (0-23) to contextualize greetings and recommendations.
export function getActiveHour(): number | null {
  const hourMap = new Array(24).fill(0)
  readEvents()
    .slice(-200)
    .forEach((e) => {
      const hour = new Date(e.ts).getHours()
      hourMap[hour] += e.ms
    })
  const max = Math.max(...hourMap)
  if (max === 0) return null // sin datos
  return hourMap.indexOf(max)
}

export function getMoodContext() {
  const now = new Date()
  const hour = now.getHours()
  const weekday = now.getDay()
  let energy: 'high' | 'medium' | 'low' = 'medium'
  
  if (hour >= 6 && hour < 11) energy = 'high'
  else if (hour >= 11 && hour < 18) energy = 'medium'
  else energy = 'low'
  
  return { hour, weekday, energy }
}

export function getGenreAffinityScores(): Map<string, number> {
  const scores = new Map<string, number>()
  const now = Date.now()
  const since = now - EVENTS_WINDOW_DAYS * 24 * 60 * 60 * 1000
  
  readEvents().filter(e => e.ts >= since).forEach(e => {
    const raw = String(e.album || e.genre || '').trim()
    if (!raw || raw.length > 28 || /\d{4}/.test(raw)) return
    
    const matched = matchGenre(raw, GENRE_KEYWORDS)
    if (!matched) return
    
    const ageDays = (now - e.ts) / (24 * 60 * 60 * 1000)
    const weight = e.completionPct !== undefined ? Math.max(0.1, e.completionPct / 100) : 0.5
    const weighted = e.ms * weight * decayFactor(ageDays)
    
    scores.set(matched, (scores.get(matched) || 0) + weighted)
  })
  
  return scores
}

/** Igual que getGenreAffinityScores pero con la taxonomía fina (subgéneros)
 *  en vez del género padre — la fuente de las Niche Mixes. */
export function getNicheGenreAffinityScores(): Map<string, number> {
  const scores = new Map<string, number>()
  const now = Date.now()
  const since = now - EVENTS_WINDOW_DAYS * 24 * 60 * 60 * 1000

  readEvents().filter(e => e.ts >= since).forEach(e => {
    const raw = String(e.album || e.genre || '').trim()
    if (!raw || raw.length > 28 || /\d{4}/.test(raw)) return

    const matched = matchGenre(raw, NICHE_GENRE_KEYWORDS)
    if (!matched) return

    const ageDays = (now - e.ts) / (24 * 60 * 60 * 1000)
    const weight = e.completionPct !== undefined ? Math.max(0.1, e.completionPct / 100) : 0.5
    scores.set(matched, (scores.get(matched) || 0) + e.ms * weight * decayFactor(ageDays))
  })

  return scores
}

export function getTopNicheGenres(limit = 3): string[] {
  return [...getNicheGenreAffinityScores().entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map((g) => g[0])
}

// ------------------------------------------------------------
// On Repeat / Repeat Rewind / Time Capsule
// Todas reconstruyen objetos reproducibles directamente desde totals.songs
// (song.id === videoId para canciones de YT, ver songIdentity.ts), sin
// tener que volver a buscarlas — son canciones que el usuario YA escuchó.
// ------------------------------------------------------------
interface MixSong {
  id: string
  videoId: string
  title?: string
  artist?: string
  artistId?: string | null
  albumArtUrl?: string | null
}

function songToMixEntry(id: string, s: SongTotals): MixSong {
  return { id, videoId: id, title: s.title, artist: s.artist, artistId: s.artistId || null, albumArtUrl: s.albumArtUrl || null }
}

/** Lo que más escuchaste en los últimos 30 días — equivalente a "On Repeat". */
export function getOnRepeat(limit = 20): MixSong[] {
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000
  const recentMs = new Map<string, number>()
  readEvents().filter((e) => e.ts >= since).forEach((e) => {
    recentMs.set(e.songId, (recentMs.get(e.songId) || 0) + e.ms)
  })
  const totals = readTotals()
  return [...recentMs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => totals.songs[id] && songToMixEntry(id, totals.songs[id]))
    .filter((s): s is MixSong => Boolean(s))
}

/** Canciones que amaste mucho históricamente pero no tocaste en 30+ días —
 *  el "che, hace rato no escuchás esto" de Spotify. */
export function getRepeatRewind(limit = 20): MixSong[] {
  const totals = readTotals()
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  return Object.entries(totals.songs)
    .filter(([, s]) => (s.lastPlayedAt || 0) < cutoff && s.ms > 60000)
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, limit)
    .map(([id, s]) => songToMixEntry(id, s))
}

/** Favoritas viejas, olvidadas hace mucho (90+ días) — nostalgia pura. */
export function getTimeCapsule(limit = 20): MixSong[] {
  const totals = readTotals()
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
  return Object.entries(totals.songs)
    .filter(([, s]) => (s.lastPlayedAt || 0) < cutoff && s.count >= 2)
    .sort((a, b) => (a[1].lastPlayedAt || 0) - (b[1].lastPlayedAt || 0))
    .slice(0, limit)
    .map(([id, s]) => songToMixEntry(id, s))
}

// ------------------------------------------------------------
// Wrapped / Replay
// ------------------------------------------------------------
export interface WrappedStats {
  totalMs: number
  topSongs: TopSong[]
  topArtists: TopArtist[]
  topGenres: string[]
  streak: number
  firstListenAt: number | null
  mostRepeatedSong: TopSong | null
  personality: string
}

const PERSONALITY_BY_GENRE: Record<string, string> = {
  'Electronic': 'Explorador de sintetizadores',
  'Hip-Hop': 'Cabeza de rimas',
  'Pop': 'Fan de los hits',
  'Rock': 'Alma de guitarra',
  'R&B': 'Oído para el groove',
  'Alternative': 'Fuera del mapa',
  'Ambient': 'Buscador de calma',
  'Jazz': 'Oído fino',
  'Classical': 'Melómano clásico',
  'Metal': 'Puro volumen',
  'Country': 'Alma viajera',
  'Latin': 'Ritmo en las venas',
  'Reggae': 'Vibras tranquilas',
  'Funk': 'Groove infinito',
  'Blues': 'Sentimiento crudo',
  'Indie': 'Descubridor nato',
  'Folk': 'Historias con guitarra',
}

/** Resumen tipo "Wrapped" para un período dado — todo sale de datos que ya
 *  tenías guardados, no agrega ninguna colección nueva a localStorage. */
export function getWrappedStats(period: Period = 'all'): WrappedStats {
  const topSongs = getTopSongs(period, 10)
  const topArtists = getTopArtists(period, 10)
  const topGenres = getTopGenre(3)
  const mostRepeatedSong = [...topSongs].sort((a, b) => b.count - a.count)[0] || null
  const personality = topGenres[0] ? PERSONALITY_BY_GENRE[topGenres[0]] || 'Oyente ecléctico' : 'Recién empezando'

  return {
    totalMs: getTotalMs(period),
    topSongs,
    topArtists,
    topGenres,
    streak: getStreak(),
    firstListenAt: getFirstListenAt(),
    mostRepeatedSong,
    personality,
  }
}

// ------------------------------------------------------------
// Blend — mezcla de gustos entre dos usuarios, 100% local (sin backend
// propio): un usuario exporta su "taste code" (top artistas/géneros
// afinados, comprimido en base64) y el otro lo pega para generar una
// mezcla. No identifica a la persona más allá de los nombres que ya
// aparecen en su propia biblioteca.
// ------------------------------------------------------------
export interface TasteCode {
  v: 1
  artists: { name: string; score: number }[]
  genres: { name: string; score: number }[]
}

export function exportTasteCode(limit = 15): string {
  const artists = [...getArtistAffinityScores().values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((a) => ({ name: a.name, score: Math.round(a.score) }))
  const genres = [...getGenreAffinityScores().entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, score]) => ({ name, score: Math.round(score) }))
  const payload: TasteCode = { v: 1, artists, genres }
  return btoa(encodeURIComponent(JSON.stringify(payload)))
}

export function parseTasteCode(code: string): TasteCode | null {
  try {
    const decoded = JSON.parse(decodeURIComponent(atob(code.trim())))
    if (!decoded || decoded.v !== 1 || !Array.isArray(decoded.artists)) return null
    return decoded as TasteCode
  } catch {
    return null
  }
}

/** Mezcla el perfil local con uno importado: normaliza ambos a 0-1 y
 *  promedia, priorizando artistas/géneros que aparecen en los DOS perfiles
 *  (el "overlap" es lo que hace que un Blend se sienta acertado). */
export function buildBlendSeeds(remote: TasteCode, limit = 8): { artists: string[]; genres: string[] } {
  const localArtists = [...getArtistAffinityScores().values()].sort((a, b) => b.score - a.score).slice(0, 15)
  const localMax = localArtists[0]?.score || 1
  const remoteMax = remote.artists[0]?.score || 1

  const merged = new Map<string, number>()
  localArtists.forEach((a) => merged.set(a.name.toLowerCase(), (a.score / localMax) * 0.5))
  remote.artists.forEach((a) => {
    const key = a.name.toLowerCase()
    const normalized = (a.score / remoteMax) * 0.5
    merged.set(key, (merged.get(key) || 0) + normalized + (merged.has(key) ? 0.3 : 0)) // bonus por overlap
  })

  const localGenres = [...getGenreAffinityScores().entries()]
  const localGenreMax = localGenres[0]?.[1] || 1
  const remoteGenreMax = remote.genres[0]?.score || 1
  const mergedGenres = new Map<string, number>()
  localGenres.forEach(([name, score]) => mergedGenres.set(name, (score / localGenreMax) * 0.5))
  remote.genres.forEach((g) => {
    const normalized = (g.score / remoteGenreMax) * 0.5
    mergedGenres.set(g.name, (mergedGenres.get(g.name) || 0) + normalized + (mergedGenres.has(g.name) ? 0.3 : 0))
  })

  return {
    artists: [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name]) => name),
    genres: [...mergedGenres.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name),
  }
}

