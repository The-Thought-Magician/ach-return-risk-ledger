// ---------------------------------------------------------------------------
// THE ENGINE — pure, deterministic scheduling primitives.
//
// Self-contained: no DB, no network, no external services. Every function is a
// pure transformation of its inputs into a typed result. Three schedule kinds
// are supported:
//   - 'cron'   : a 5/6-field cron expression, parsed with cron-parser v5.
//   - 'rate'   : a natural-language rate string, "every N minutes|hours|days".
//   - 'oneoff' : a single ISO instant; fires once if it is in the future.
// ---------------------------------------------------------------------------

import { CronExpressionParser } from 'cron-parser'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScheduleKind = 'cron' | 'rate' | 'oneoff'

export interface ValidationResult {
  valid: boolean
  error?: string
}

export interface JobSpec {
  id: string
  kind: ScheduleKind
  expr: string
  timezone?: string
  resourceId?: string
}

export interface CollisionWindow {
  windowStart: string
  windowEnd: string
  jobIds: string[]
  severity: 'low' | 'medium' | 'high'
  resourceId?: string
}

export interface HeatmapBucket {
  bucket: string
  count: number
}

export type DstTrapType = 'double_fire' | 'skip' | 'ambiguous'

export interface DstTrap {
  type: DstTrapType
  atLocal: string
  atUtc: string
}

export interface CoverageWindow {
  start: string // ISO
  end: string // ISO
}

export interface CoverageGap {
  gapStart: string
  gapEnd: string
  durationMinutes: number
}

export interface SpreadSuggestion {
  jobId: string
  suggestedExpr: string
  reason: string
}

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const RATE_RE = /^every\s+(\d+)\s+(minute|minutes|hour|hours|day|days)$/i

interface RateParts {
  count: number
  unit: 'minute' | 'hour' | 'day'
  stepMs: number
}

function parseRate(expr: string): RateParts | null {
  const m = RATE_RE.exec(expr.trim())
  if (!m) return null
  const count = parseInt(m[1], 10)
  if (!Number.isFinite(count) || count <= 0) return null
  const raw = m[2].toLowerCase()
  const unit: RateParts['unit'] = raw.startsWith('minute')
    ? 'minute'
    : raw.startsWith('hour')
      ? 'hour'
      : 'day'
  const stepMs = unit === 'minute' ? count * MINUTE_MS : unit === 'hour' ? count * HOUR_MS : count * DAY_MS
  return { count, unit, stepMs }
}

function parseISO(iso: string): Date | null {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

// Truncate a Date to the start of its UTC minute, return ISO string.
function minuteKey(d: Date): string {
  const ms = Math.floor(d.getTime() / MINUTE_MS) * MINUTE_MS
  return new Date(ms).toISOString()
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// Offset (in minutes) of the given UTC instant in a named IANA timezone.
function tzOffsetMinutes(date: Date, timeZone: string): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const parts = dtf.formatToParts(date)
    const map: Record<string, number> = {}
    for (const p of parts) {
      if (p.type !== 'literal') map[p.type] = parseInt(p.value, 10)
    }
    // Build a UTC timestamp from the wall-clock components the tz reports.
    const asUTC = Date.UTC(
      map.year,
      (map.month ?? 1) - 1,
      map.day ?? 1,
      map.hour === 24 ? 0 : (map.hour ?? 0),
      map.minute ?? 0,
      map.second ?? 0,
    )
    return Math.round((asUTC - date.getTime()) / MINUTE_MS)
  } catch {
    return 0
  }
}

function localISO(date: Date, timeZone: string): string {
  const off = tzOffsetMinutes(date, timeZone)
  const shifted = new Date(date.getTime() + off * MINUTE_MS)
  // Render the shifted wall-clock with an explicit offset suffix.
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const oh = String(Math.floor(abs / 60)).padStart(2, '0')
  const om = String(abs % 60).padStart(2, '0')
  return shifted.toISOString().slice(0, 19) + sign + oh + ':' + om
}

// ---------------------------------------------------------------------------
// validateExpression
// ---------------------------------------------------------------------------

export function validateExpression(kind: ScheduleKind, expr: string): ValidationResult {
  if (!expr || !expr.trim()) return { valid: false, error: 'Expression is empty' }
  switch (kind) {
    case 'cron': {
      try {
        CronExpressionParser.parse(expr.trim())
        return { valid: true }
      } catch (e) {
        return { valid: false, error: e instanceof Error ? e.message : 'Invalid cron expression' }
      }
    }
    case 'rate': {
      const parts = parseRate(expr)
      if (!parts) return { valid: false, error: 'Rate must look like "every N minutes|hours|days"' }
      return { valid: true }
    }
    case 'oneoff': {
      const d = parseISO(expr.trim())
      if (!d) return { valid: false, error: 'One-off must be a valid ISO 8601 instant' }
      return { valid: true }
    }
    default:
      return { valid: false, error: `Unknown schedule kind: ${kind}` }
  }
}

// ---------------------------------------------------------------------------
// describeExpression
// ---------------------------------------------------------------------------

export function describeExpression(kind: ScheduleKind, expr: string, timezone = 'UTC'): string {
  const v = validateExpression(kind, expr)
  if (!v.valid) return `Invalid ${kind} expression: ${v.error}`
  switch (kind) {
    case 'cron':
      return describeCron(expr.trim(), timezone)
    case 'rate': {
      const parts = parseRate(expr)!
      const unitWord = parts.count === 1 ? parts.unit : parts.unit + 's'
      return `Every ${parts.count} ${unitWord} (${timezone})`
    }
    case 'oneoff': {
      const d = parseISO(expr.trim())!
      return `Once at ${localISO(d, timezone)} (${timezone})`
    }
    default:
      return expr
  }
}

function describeCron(expr: string, timezone: string): string {
  const fields = expr.split(/\s+/)
  // Support 5-field (min hour dom mon dow) and 6-field (sec min hour ...).
  let sec = '0'
  let rest = fields
  if (fields.length === 6) {
    sec = fields[0]
    rest = fields.slice(1)
  }
  const [min, hour, dom, mon, dow] = rest
  const parts: string[] = []
  if (min === '*' && hour === '*') {
    parts.push('every minute')
  } else if (hour === '*') {
    parts.push(`at minute ${min} of every hour`)
  } else if (min !== '*' && hour !== '*') {
    parts.push(`at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`)
  } else {
    parts.push(`minute=${min} hour=${hour}`)
  }
  if (sec !== '0' && sec !== '*') parts.push(`second ${sec}`)
  if (dom !== '*') parts.push(`on day-of-month ${dom}`)
  if (mon !== '*') parts.push(`in month ${mon}`)
  if (dow !== '*') parts.push(`on weekday ${dow}`)
  return parts.join(', ') + ` (${timezone})`
}

// ---------------------------------------------------------------------------
// nextFirings
// ---------------------------------------------------------------------------

export function nextFirings(
  kind: ScheduleKind,
  expr: string,
  timezone = 'UTC',
  fromISO?: string,
  count = 10,
): string[] {
  const v = validateExpression(kind, expr)
  if (!v.valid) return []
  const from = fromISO ? parseISO(fromISO) : new Date()
  if (!from) return []
  const n = Math.max(0, Math.min(count, 1000))
  if (n === 0) return []

  switch (kind) {
    case 'cron': {
      try {
        const it = CronExpressionParser.parse(expr.trim(), {
          tz: timezone,
          currentDate: new Date(from.getTime()),
        })
        const out: string[] = []
        for (let i = 0; i < n; i++) {
          const next = it.next().toDate()
          out.push(next.toISOString())
        }
        return out
      } catch {
        return []
      }
    }
    case 'rate': {
      const parts = parseRate(expr)!
      const out: string[] = []
      let t = from.getTime() + parts.stepMs
      for (let i = 0; i < n; i++) {
        out.push(new Date(t).toISOString())
        t += parts.stepMs
      }
      return out
    }
    case 'oneoff': {
      const d = parseISO(expr.trim())!
      if (d.getTime() > from.getTime()) return [d.toISOString()]
      return []
    }
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// Firing enumeration over a bounded horizon (internal helper used below)
// ---------------------------------------------------------------------------

function firingsInHorizon(job: JobSpec, fromISO: string, horizonDays: number): Date[] {
  const from = parseISO(fromISO) ?? new Date()
  const end = from.getTime() + horizonDays * DAY_MS
  const tz = job.timezone ?? 'UTC'

  if (job.kind === 'cron') {
    const v = validateExpression('cron', job.expr)
    if (!v.valid) return []
    try {
      const it = CronExpressionParser.parse(job.expr.trim(), {
        tz,
        currentDate: new Date(from.getTime()),
      })
      const out: Date[] = []
      // Cap iterations to avoid pathological every-second expressions.
      const cap = 200_000
      for (let i = 0; i < cap; i++) {
        const next = it.next().toDate()
        if (next.getTime() > end) break
        out.push(next)
      }
      return out
    } catch {
      return []
    }
  }

  if (job.kind === 'rate') {
    const parts = parseRate(job.expr)
    if (!parts) return []
    const out: Date[] = []
    let t = from.getTime() + parts.stepMs
    const cap = 200_000
    for (let i = 0; i < cap && t <= end; i++) {
      out.push(new Date(t))
      t += parts.stepMs
    }
    return out
  }

  if (job.kind === 'oneoff') {
    const d = parseISO(job.expr.trim())
    if (d && d.getTime() > from.getTime() && d.getTime() <= end) return [d]
    return []
  }

  return []
}

// ---------------------------------------------------------------------------
// computeCollisions
// ---------------------------------------------------------------------------

export function computeCollisions(
  jobs: JobSpec[],
  opts: { horizonDays?: number; threshold?: number; fromISO?: string } = {},
): CollisionWindow[] {
  const horizonDays = opts.horizonDays ?? 7
  const threshold = Math.max(2, opts.threshold ?? 3)
  const fromISO = opts.fromISO ?? new Date().toISOString()

  // bucket -> set of jobIds, and bucket -> resourceId -> jobIds
  const byMinute = new Map<string, Set<string>>()
  const byMinuteResource = new Map<string, Map<string, Set<string>>>()

  for (const job of jobs) {
    const firings = firingsInHorizon(job, fromISO, horizonDays)
    for (const f of firings) {
      const key = minuteKey(f)
      if (!byMinute.has(key)) byMinute.set(key, new Set())
      byMinute.get(key)!.add(job.id)
      if (job.resourceId) {
        if (!byMinuteResource.has(key)) byMinuteResource.set(key, new Map())
        const rmap = byMinuteResource.get(key)!
        if (!rmap.has(job.resourceId)) rmap.set(job.resourceId, new Set())
        rmap.get(job.resourceId)!.add(job.id)
      }
    }
  }

  const windows: CollisionWindow[] = []
  for (const [key, ids] of byMinute) {
    const concurrency = ids.size
    // Detect a resource that has >=2 jobs sharing it in this minute.
    let collisionResource: string | undefined
    const rmap = byMinuteResource.get(key)
    if (rmap) {
      for (const [resId, resIds] of rmap) {
        if (resIds.size >= 2) {
          collisionResource = resId
          break
        }
      }
    }
    const flagged = concurrency >= threshold || !!collisionResource
    if (!flagged) continue
    const start = new Date(key)
    const end = new Date(start.getTime() + MINUTE_MS)
    let severity: CollisionWindow['severity'] = 'low'
    if (concurrency >= threshold * 2) severity = 'high'
    else if (concurrency >= threshold || collisionResource) severity = 'medium'
    windows.push({
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      jobIds: [...ids].sort(),
      severity,
      resourceId: collisionResource,
    })
  }

  windows.sort((a, b) => a.windowStart.localeCompare(b.windowStart))
  return windows
}

// ---------------------------------------------------------------------------
// loadHeatmap
// ---------------------------------------------------------------------------

export function loadHeatmap(
  jobs: JobSpec[],
  opts: { horizonDays?: number; fromISO?: string; bucketBy?: 'hour' | 'day' } = {},
): HeatmapBucket[] {
  const horizonDays = opts.horizonDays ?? 7
  const fromISO = opts.fromISO ?? new Date().toISOString()
  const bucketBy = opts.bucketBy ?? (horizonDays <= 2 ? 'hour' : 'day')

  const counts = new Map<string, number>()
  for (const job of jobs) {
    const firings = firingsInHorizon(job, fromISO, horizonDays)
    for (const f of firings) {
      const key =
        bucketBy === 'hour'
          ? new Date(Math.floor(f.getTime() / HOUR_MS) * HOUR_MS).toISOString()
          : dayKey(f)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  return [...counts.entries()]
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
}

// ---------------------------------------------------------------------------
// dstTraps
// ---------------------------------------------------------------------------

export function dstTraps(
  kind: ScheduleKind,
  expr: string,
  timezone: string,
  fromISO: string,
  days = 365,
): DstTrap[] {
  const v = validateExpression(kind, expr)
  if (!v.valid || !timezone || timezone === 'UTC') return []
  const from = parseISO(fromISO)
  if (!from) return []

  const traps: DstTrap[] = []
  const end = from.getTime() + days * DAY_MS

  // Walk hour by hour, watching for offset transitions in the target tz.
  let prev = from.getTime()
  let prevOff = tzOffsetMinutes(new Date(prev), timezone)
  for (let t = from.getTime() + HOUR_MS; t <= end; t += HOUR_MS) {
    const off = tzOffsetMinutes(new Date(t), timezone)
    if (off !== prevOff) {
      // A transition occurred between prev and t.
      const transitionAt = new Date(t)
      if (off > prevOff) {
        // Spring forward: clocks jump ahead -> a wall-clock hour is skipped.
        traps.push({
          type: 'skip',
          atLocal: localISO(transitionAt, timezone),
          atUtc: transitionAt.toISOString(),
        })
      } else {
        // Fall back: clocks repeat -> a wall-clock hour is ambiguous and a
        // fixed wall-clock schedule may double-fire.
        traps.push({
          type: 'ambiguous',
          atLocal: localISO(transitionAt, timezone),
          atUtc: transitionAt.toISOString(),
        })
        traps.push({
          type: 'double_fire',
          atLocal: localISO(transitionAt, timezone),
          atUtc: transitionAt.toISOString(),
        })
      }
      prevOff = off
    }
    prev = t
  }

  return traps
}

// ---------------------------------------------------------------------------
// coverageGaps
// ---------------------------------------------------------------------------

export function coverageGaps(
  windows: CoverageWindow[],
  jobs: JobSpec[],
  opts: { horizonDays?: number; fromISO?: string } = {},
): CoverageGap[] {
  const horizonDays = opts.horizonDays ?? 7
  const fromISO = opts.fromISO ?? new Date().toISOString()
  const from = parseISO(fromISO) ?? new Date()
  const end = from.getTime() + horizonDays * DAY_MS

  // Collect all firing instants across all jobs within the horizon.
  const firings: number[] = []
  for (const job of jobs) {
    for (const f of firingsInHorizon(job, fromISO, horizonDays)) {
      firings.push(f.getTime())
    }
  }
  firings.sort((a, b) => a - b)

  // Normalize required-coverage windows (clamped to horizon) and merge.
  const reqRaw: Array<[number, number]> = []
  for (const w of windows) {
    const s = parseISO(w.start)
    const e = parseISO(w.end)
    if (!s || !e) continue
    const start = Math.max(s.getTime(), from.getTime())
    const finish = Math.min(e.getTime(), end)
    if (finish > start) reqRaw.push([start, finish])
  }
  reqRaw.sort((a, b) => a[0] - b[0])
  const req: Array<[number, number]> = []
  for (const [s, e] of reqRaw) {
    const last = req[req.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else req.push([s, e])
  }

  const gaps: CoverageGap[] = []
  for (const [s, e] of req) {
    // Firings landing inside this required window, sorted.
    const inside = firings.filter((f) => f >= s && f <= e)
    let cursor = s
    for (const f of inside) {
      if (f - cursor > 0) {
        gaps.push(makeGap(cursor, f))
      }
      cursor = Math.max(cursor, f)
    }
    if (e - cursor > 0) gaps.push(makeGap(cursor, e))
  }

  // Filter zero-length gaps (defensive) and sort.
  return gaps.filter((g) => g.durationMinutes > 0).sort((a, b) => a.gapStart.localeCompare(b.gapStart))
}

function makeGap(startMs: number, endMs: number): CoverageGap {
  return {
    gapStart: new Date(startMs).toISOString(),
    gapEnd: new Date(endMs).toISOString(),
    durationMinutes: Math.round((endMs - startMs) / MINUTE_MS),
  }
}

// ---------------------------------------------------------------------------
// autoSpread
// ---------------------------------------------------------------------------

export function autoSpread(
  jobs: JobSpec[],
  opts: { threshold?: number; horizonDays?: number; fromISO?: string } = {},
): SpreadSuggestion[] {
  const threshold = Math.max(2, opts.threshold ?? 3)
  const horizonDays = opts.horizonDays ?? 7
  const fromISO = opts.fromISO ?? new Date().toISOString()

  const collisions = computeCollisions(jobs, { horizonDays, threshold, fromISO })
  if (collisions.length === 0) return []

  // Tally how often each job participates in a collision window.
  const offenseCount = new Map<string, number>()
  for (const w of collisions) {
    for (const id of w.jobIds) {
      offenseCount.set(id, (offenseCount.get(id) ?? 0) + 1)
    }
  }

  const jobsById = new Map(jobs.map((j) => [j.id, j]))
  const suggestions: SpreadSuggestion[] = []

  // For each colliding window, keep the first job on its slot and stagger the
  // rest. We only emit one suggestion per job (its worst offense).
  const suggested = new Set<string>()
  for (const w of collisions) {
    const sorted = [...w.jobIds].sort()
    // first job keeps its slot; subsequent jobs get a staggered minute offset
    for (let i = 1; i < sorted.length; i++) {
      const id = sorted[i]
      if (suggested.has(id)) continue
      const job = jobsById.get(id)
      if (!job) continue
      const offsetMin = i // deterministic per-position stagger
      const suggestedExpr = staggerExpr(job, offsetMin)
      suggestions.push({
        jobId: id,
        suggestedExpr,
        reason:
          `Collides with ${sorted.length - 1} other job(s) at ${w.windowStart}` +
          (w.resourceId ? ` on resource ${w.resourceId}` : '') +
          `; stagger by ${offsetMin} minute(s) to spread load`,
      })
      suggested.add(id)
    }
  }

  return suggestions.sort((a, b) => (offenseCount.get(b.jobId) ?? 0) - (offenseCount.get(a.jobId) ?? 0))
}

// Produce a staggered version of a job's expression by shifting its minute
// field (cron) or nudging its start (rate/oneoff) by `offsetMin` minutes.
function staggerExpr(job: JobSpec, offsetMin: number): string {
  if (job.kind === 'cron') {
    const fields = job.expr.trim().split(/\s+/)
    let idx = 0
    if (fields.length === 6) idx = 1 // skip seconds field
    const minField = fields[idx]
    // Only stagger when the minute is a single concrete value.
    if (/^\d+$/.test(minField)) {
      const m = (parseInt(minField, 10) + offsetMin) % 60
      fields[idx] = String(m)
      return fields.join(' ')
    }
    // For wildcard/list minutes, append an offset annotation instead.
    return job.expr.trim()
  }
  if (job.kind === 'oneoff') {
    const d = parseISO(job.expr.trim())
    if (d) return new Date(d.getTime() + offsetMin * MINUTE_MS).toISOString()
    return job.expr
  }
  // rate: keep cadence, the engine consumer can apply an initial delay.
  return job.expr
}
