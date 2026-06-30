import { Hono } from 'hono'
import { db } from '../db/index.js'
import {
  scorecards,
  originators,
  rate_snapshots,
  thresholds,
  forecasts,
  representments,
  audit_logs,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

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

function gradeFor(score: number): string {
  if (score >= 90) return 'A'
  if (score >= 80) return 'B'
  if (score >= 70) return 'C'
  if (score >= 60) return 'D'
  return 'F'
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n))
}

// ---------------------------------------------------------------------------
// GET / — scorecards for all originators (sortable)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = getUserId(c)
  const sort = c.req.query('sort') ?? 'composite_score'
  const dir = c.req.query('dir') ?? 'desc'

  const rows = await db
    .select()
    .from(scorecards)
    .where(eq(scorecards.workspace_id, workspaceId))

  const allowed: Record<string, (r: typeof scorecards.$inferSelect) => number | string> = {
    composite_score: (r) => r.composite_score,
    grade: (r) => r.grade,
    percentile: (r) => r.percentile,
    headroom_score: (r) => r.headroom_score,
    velocity_score: (r) => r.velocity_score,
    volume_score: (r) => r.volume_score,
    representment_score: (r) => r.representment_score,
  }
  const keyFn = allowed[sort] ?? allowed.composite_score
  rows.sort((a, b) => {
    const av = keyFn(a)
    const bv = keyFn(b)
    let cmp: number
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv
    else cmp = String(av).localeCompare(String(bv))
    return dir === 'asc' ? cmp : -cmp
  })

  return c.json(rows)
})

// ---------------------------------------------------------------------------
// GET /:originatorId — scorecard for one originator
// ---------------------------------------------------------------------------

router.get('/:originatorId', async (c) => {
  const workspaceId = getUserId(c)
  const originatorId = c.req.param('originatorId')
  const [row] = await db
    .select()
    .from(scorecards)
    .where(
      and(
        eq(scorecards.workspace_id, workspaceId),
        eq(scorecards.originator_id, originatorId),
      ),
    )
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json(row)
})

// ---------------------------------------------------------------------------
// POST /recompute — recompute composite scores/grades/percentiles
// ---------------------------------------------------------------------------

router.post('/recompute', authMiddleware, async (c) => {
  const workspaceId = getUserId(c)
  const t = await loadThresholds(workspaceId)
  const computedAt = new Date()

  const owned = await db
    .select()
    .from(originators)
    .where(eq(originators.workspace_id, workspaceId))

  if (owned.length === 0) {
    await db.delete(scorecards).where(eq(scorecards.workspace_id, workspaceId))
    return c.json({ computed: 0, scorecards: [] })
  }

  const maxVolume = Math.max(1, ...owned.map((o) => o.expected_monthly_volume ?? 0))

  interface Computed {
    originator_id: string
    composite_score: number
    headroom_score: number
    velocity_score: number
    volume_score: number
    representment_score: number
  }
  const partial: Computed[] = []

  for (const o of owned) {
    // Latest per-originator rate snapshot.
    const [snap] = await db
      .select()
      .from(rate_snapshots)
      .where(
        and(
          eq(rate_snapshots.workspace_id, workspaceId),
          eq(rate_snapshots.originator_id, o.id),
        ),
      )
      .orderBy(desc(rate_snapshots.as_of))

    // Headroom: how far below each limit, averaged across the three rates.
    // 100 = comfortably clear, 0 = at/over limit.
    let headroomScore = 100
    if (snap) {
      const u = 1 - snap.unauthorized_rate / t.unauthorized_limit
      const a = 1 - snap.admin_rate / t.admin_limit
      const ov = 1 - snap.overall_rate / t.overall_limit
      headroomScore = clamp(((u + a + ov) / 3) * 100)
    }

    // Velocity: worst-case (soonest) days-to-breach across this originator's
    // forecasts. Sooner breach -> lower score.
    const fc = await db
      .select()
      .from(forecasts)
      .where(
        and(
          eq(forecasts.workspace_id, workspaceId),
          eq(forecasts.originator_id, o.id),
        ),
      )
    let velocityScore = 100
    const dtbs = fc.map((f) => f.days_to_breach).filter((d): d is number => d !== null)
    if (dtbs.length > 0) {
      const soonest = Math.min(...dtbs)
      // 0 days -> 0, >=180 days -> 100, linear in between.
      velocityScore = clamp((soonest / 180) * 100)
    }

    // Volume: larger originators carry more risk weight -> lower headroom-of-error.
    // Score is inverse of relative volume share (smaller volume = safer).
    const vol = o.expected_monthly_volume ?? 0
    const volumeScore = clamp(100 - (vol / maxVolume) * 60)

    // Representment recovery: recovered amount / attempted amount.
    const reps = await db
      .select()
      .from(representments)
      .where(
        and(
          eq(representments.workspace_id, workspaceId),
          eq(representments.originator_id, o.id),
        ),
      )
    let representmentScore = 80 // neutral default when no representments
    if (reps.length > 0) {
      const attempted = reps.reduce((s, r) => s + (r.amount_cents ?? 0), 0)
      const recovered = reps.reduce((s, r) => s + (r.recovered_amount_cents ?? 0), 0)
      representmentScore = attempted > 0 ? clamp((recovered / attempted) * 100) : 80
    }

    // Weighted composite.
    const composite = clamp(
      headroomScore * 0.45 +
        velocityScore * 0.3 +
        volumeScore * 0.1 +
        representmentScore * 0.15,
    )

    partial.push({
      originator_id: o.id,
      composite_score: composite,
      headroom_score: headroomScore,
      velocity_score: velocityScore,
      volume_score: volumeScore,
      representment_score: representmentScore,
    })
  }

  // Percentile rank of each originator's composite within the portfolio.
  const scoresAsc = [...partial.map((p) => p.composite_score)].sort((a, b) => a - b)
  function percentileOf(score: number): number {
    if (scoresAsc.length <= 1) return 100
    const below = scoresAsc.filter((s) => s < score).length
    return clamp((below / (scoresAsc.length - 1)) * 100)
  }

  // Upsert one scorecard per originator (UNIQUE(workspace_id, originator_id)).
  const result: (typeof scorecards.$inferSelect)[] = []
  for (const p of partial) {
    const [row] = await db
      .insert(scorecards)
      .values({
        workspace_id: workspaceId,
        originator_id: p.originator_id,
        composite_score: p.composite_score,
        grade: gradeFor(p.composite_score),
        headroom_score: p.headroom_score,
        velocity_score: p.velocity_score,
        volume_score: p.volume_score,
        representment_score: p.representment_score,
        percentile: percentileOf(p.composite_score),
        computed_at: computedAt,
      })
      .onConflictDoUpdate({
        target: [scorecards.workspace_id, scorecards.originator_id],
        set: {
          composite_score: p.composite_score,
          grade: gradeFor(p.composite_score),
          headroom_score: p.headroom_score,
          velocity_score: p.velocity_score,
          volume_score: p.volume_score,
          representment_score: p.representment_score,
          percentile: percentileOf(p.composite_score),
          computed_at: computedAt,
        },
      })
      .returning()
    result.push(row)
  }

  await db.insert(audit_logs).values({
    workspace_id: workspaceId,
    actor: workspaceId,
    action: 'scorecards.recompute',
    entity_type: 'scorecard',
    entity_id: null,
    detail: { computed: result.length },
  })

  return c.json({ computed: result.length, scorecards: result })
})

export default router
