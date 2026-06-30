import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  forecasts,
  originators,
  rate_snapshots,
  thresholds,
  audit_logs,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// ---------------------------------------------------------------------------
// Threshold defaults (NACHA): unauthorized 0.5%, admin 3%, overall 15%
// ---------------------------------------------------------------------------

interface ThresholdSet {
  unauthorized_limit: number
  admin_limit: number
  overall_limit: number
  watch_pct: number
  warning_pct: number
  window_days: number
}

const DEFAULT_THRESHOLDS: ThresholdSet = {
  unauthorized_limit: 0.5,
  admin_limit: 3.0,
  overall_limit: 15.0,
  watch_pct: 0.6,
  warning_pct: 0.8,
  window_days: 60,
}

async function loadThresholds(workspaceId: string): Promise<ThresholdSet> {
  const [t] = await db.select().from(thresholds).where(eq(thresholds.workspace_id, workspaceId))
  if (!t) return { ...DEFAULT_THRESHOLDS }
  return {
    unauthorized_limit: t.unauthorized_limit,
    admin_limit: t.admin_limit,
    overall_limit: t.overall_limit,
    watch_pct: t.watch_pct,
    warning_pct: t.warning_pct,
    window_days: t.window_days,
  }
}

type RateType = 'unauthorized' | 'admin' | 'overall'

function limitForType(t: ThresholdSet, rateType: RateType): number {
  if (rateType === 'unauthorized') return t.unauthorized_limit
  if (rateType === 'admin') return t.admin_limit
  return t.overall_limit
}

function rateValue(snap: typeof rate_snapshots.$inferSelect, rateType: RateType): number {
  if (rateType === 'unauthorized') return snap.unauthorized_rate
  if (rateType === 'admin') return snap.admin_rate
  return snap.overall_rate
}

// ---------------------------------------------------------------------------
// Velocity models
// ---------------------------------------------------------------------------

interface Point {
  t: number // days since first point
  v: number // rate value
}

// Ordinary least-squares slope (rate units per day) + r^2 confidence.
function linearVelocity(points: Point[]): { velocity: number; confidence: number; current: number } {
  const n = points.length
  if (n === 0) return { velocity: 0, confidence: 0, current: 0 }
  const current = points[n - 1].v
  if (n === 1) return { velocity: 0, confidence: 0.2, current }
  const sumX = points.reduce((a, p) => a + p.t, 0)
  const sumY = points.reduce((a, p) => a + p.v, 0)
  const meanX = sumX / n
  const meanY = sumY / n
  let num = 0
  let denX = 0
  let denY = 0
  for (const p of points) {
    const dx = p.t - meanX
    const dy = p.v - meanY
    num += dx * dy
    denX += dx * dx
    denY += dy * dy
  }
  const velocity = denX === 0 ? 0 : num / denX
  const r2 = denX === 0 || denY === 0 ? 0 : (num * num) / (denX * denY)
  const confidence = Math.max(0, Math.min(1, r2))
  return { velocity, confidence, current }
}

// EWMA of first differences gives a smoothed recent velocity.
function ewmaVelocity(points: Point[], alpha = 0.4): { velocity: number; confidence: number; current: number } {
  const n = points.length
  if (n === 0) return { velocity: 0, confidence: 0, current: 0 }
  const current = points[n - 1].v
  if (n === 1) return { velocity: 0, confidence: 0.2, current }
  let ewma = 0
  let initialized = false
  for (let i = 1; i < n; i++) {
    const dt = points[i].t - points[i - 1].t
    if (dt <= 0) continue
    const perDay = (points[i].v - points[i - 1].v) / dt
    if (!initialized) {
      ewma = perDay
      initialized = true
    } else {
      ewma = alpha * perDay + (1 - alpha) * ewma
    }
  }
  // Confidence scales with sample size, capped.
  const confidence = Math.max(0, Math.min(1, (n - 1) / 6))
  return { velocity: ewma, confidence, current }
}

function projectBreach(
  current: number,
  velocity: number,
  limit: number,
  computedAt: Date,
): { daysToBreach: number | null; breachDate: Date | null } {
  if (current >= limit) return { daysToBreach: 0, breachDate: computedAt }
  if (velocity <= 0) return { daysToBreach: null, breachDate: null }
  const days = (limit - current) / velocity
  if (!Number.isFinite(days) || days <= 0) return { daysToBreach: null, breachDate: null }
  const capped = Math.min(days, 3650)
  const breachDate = new Date(computedAt.getTime() + capped * 86_400_000)
  return { daysToBreach: Math.round(capped), breachDate }
}

// Build chronological rate points for an originator + rate type from snapshots.
function buildPoints(snaps: (typeof rate_snapshots.$inferSelect)[], rateType: RateType): Point[] {
  const sorted = [...snaps].sort((a, b) => a.as_of.getTime() - b.as_of.getTime())
  if (sorted.length === 0) return []
  const t0 = sorted[0].as_of.getTime()
  return sorted.map((s) => ({
    t: (s.as_of.getTime() - t0) / 86_400_000,
    v: rateValue(s, rateType),
  }))
}

const RATE_TYPES: RateType[] = ['unauthorized', 'admin', 'overall']

// ---------------------------------------------------------------------------
// GET / — latest forecast per originator/rate_type
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = getUserId(c)
  const modelFilter = c.req.query('model')
  const rows = await db
    .select()
    .from(forecasts)
    .where(eq(forecasts.workspace_id, workspaceId))
    .orderBy(desc(forecasts.computed_at))

  // Keep only the latest row per (originator_id, rate_type[, model]).
  const seen = new Set<string>()
  const latest: typeof rows = []
  for (const r of rows) {
    if (modelFilter && r.model !== modelFilter) continue
    const key = `${r.originator_id}|${r.rate_type}|${r.model}`
    if (seen.has(key)) continue
    seen.add(key)
    latest.push(r)
  }
  return c.json(latest)
})

// ---------------------------------------------------------------------------
// GET /days-to-breach — portfolio ranked by soonest projected breach
// ---------------------------------------------------------------------------

router.get('/days-to-breach', async (c) => {
  const workspaceId = getUserId(c)
  const rows = await db
    .select()
    .from(forecasts)
    .where(eq(forecasts.workspace_id, workspaceId))
    .orderBy(desc(forecasts.computed_at))

  // Latest forecast per (originator, rate_type, model); then keep, per
  // originator+rate_type, the worst (soonest) projection across models.
  const latestByKey = new Map<string, (typeof rows)[number]>()
  for (const r of rows) {
    const key = `${r.originator_id}|${r.rate_type}|${r.model}`
    if (!latestByKey.has(key)) latestByKey.set(key, r)
  }

  const ranked = [...latestByKey.values()].filter((r) => r.days_to_breach !== null)
  ranked.sort((a, b) => (a.days_to_breach ?? Infinity) - (b.days_to_breach ?? Infinity))
  return c.json(ranked)
})

// ---------------------------------------------------------------------------
// POST /recompute — recompute linear + ewma forecasts for all originators
// ---------------------------------------------------------------------------

router.post('/recompute', authMiddleware, async (c) => {
  const workspaceId = getUserId(c)
  const t = await loadThresholds(workspaceId)
  const computedAt = new Date()

  const owned = await db
    .select()
    .from(originators)
    .where(eq(originators.workspace_id, workspaceId))

  // Clear prior forecasts for this workspace then recompute.
  await db.delete(forecasts).where(eq(forecasts.workspace_id, workspaceId))

  const created: (typeof forecasts.$inferSelect)[] = []

  for (const o of owned) {
    const snaps = await db
      .select()
      .from(rate_snapshots)
      .where(
        and(
          eq(rate_snapshots.workspace_id, workspaceId),
          eq(rate_snapshots.originator_id, o.id),
        ),
      )
      .orderBy(rate_snapshots.as_of)

    if (snaps.length === 0) continue

    for (const rateType of RATE_TYPES) {
      const points = buildPoints(snaps, rateType)
      const limit = limitForType(t, rateType)

      for (const model of ['linear', 'ewma'] as const) {
        const est =
          model === 'linear' ? linearVelocity(points) : ewmaVelocity(points)
        const { daysToBreach, breachDate } = projectBreach(
          est.current,
          est.velocity,
          limit,
          computedAt,
        )
        const [row] = await db
          .insert(forecasts)
          .values({
            workspace_id: workspaceId,
            originator_id: o.id,
            rate_type: rateType,
            model,
            current_rate: est.current,
            velocity_per_day: est.velocity,
            projected_breach_date: breachDate,
            days_to_breach: daysToBreach,
            confidence: est.confidence,
            computed_at: computedAt,
          })
          .returning()
        created.push(row)
      }
    }
  }

  await db.insert(audit_logs).values({
    workspace_id: workspaceId,
    actor: workspaceId,
    action: 'forecasts.recompute',
    entity_type: 'forecast',
    entity_id: null,
    detail: { computed: created.length, originators: owned.length },
  })

  return c.json({ computed: created.length, forecasts: created })
})

// ---------------------------------------------------------------------------
// POST /what-if — project effect of extra returns/entries (no persist)
// ---------------------------------------------------------------------------

const whatIfSchema = z.object({
  originator_id: z.string().min(1),
  rate_type: z.enum(['unauthorized', 'admin', 'overall']).optional().default('overall'),
  model: z.enum(['linear', 'ewma']).optional().default('linear'),
  extra_returns: z.number().int().min(0).optional().default(0),
  extra_entries: z.number().int().min(0).optional().default(0),
  horizon_days: z.number().int().min(1).max(3650).optional().default(60),
})

router.post('/what-if', authMiddleware, zValidator('json', whatIfSchema), async (c) => {
  const workspaceId = getUserId(c)
  const body = c.req.valid('json')

  const [o] = await db
    .select()
    .from(originators)
    .where(and(eq(originators.id, body.originator_id), eq(originators.workspace_id, workspaceId)))
  if (!o) return c.json({ error: 'Originator not found' }, 404)

  const t = await loadThresholds(workspaceId)
  const rateType = body.rate_type as RateType
  const limit = limitForType(t, rateType)

  const snaps = await db
    .select()
    .from(rate_snapshots)
    .where(
      and(
        eq(rate_snapshots.workspace_id, workspaceId),
        eq(rate_snapshots.originator_id, body.originator_id),
      ),
    )
    .orderBy(rate_snapshots.as_of)

  const computedAt = new Date()
  const points = buildPoints(snaps, rateType)
  const est = body.model === 'linear' ? linearVelocity(points) : ewmaVelocity(points)

  const latest = snaps.length ? snaps[snaps.length - 1] : null
  const baseDebits = latest?.debit_count ?? 0
  const baseReturns = latest?.total_returns ?? 0

  // Adjusted rate = (returns + extra_returns) / (debits + extra_entries) * 100.
  const adjReturns = baseReturns + body.extra_returns
  const adjDebits = baseDebits + body.extra_entries
  const adjustedRate = adjDebits > 0 ? (adjReturns / adjDebits) * 100 : est.current

  const base = projectBreach(est.current, est.velocity, limit, computedAt)
  const adjusted = projectBreach(adjustedRate, est.velocity, limit, computedAt)

  // Headroom after the horizon at current velocity.
  const projectedAtHorizon = adjustedRate + est.velocity * body.horizon_days

  return c.json({
    projection: {
      originator_id: body.originator_id,
      rate_type: rateType,
      model: body.model,
      limit,
      base_rate: est.current,
      adjusted_rate: adjustedRate,
      velocity_per_day: est.velocity,
      confidence: est.confidence,
      base_days_to_breach: base.daysToBreach,
      adjusted_days_to_breach: adjusted.daysToBreach,
      base_breach_date: base.breachDate,
      adjusted_breach_date: adjusted.breachDate,
      projected_rate_at_horizon: projectedAtHorizon,
      horizon_days: body.horizon_days,
      breaches_within_horizon: projectedAtHorizon >= limit,
      extra_returns: body.extra_returns,
      extra_entries: body.extra_entries,
      base_debit_count: baseDebits,
      base_return_count: baseReturns,
    },
  })
})

export default router
