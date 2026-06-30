import { Hono } from 'hono'
import { db } from '../db/index.js'
import {
  benchmarks,
  rate_snapshots,
  scorecards,
  originators,
  audit_logs,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const METRICS = ['unauthorized_rate', 'admin_rate', 'overall_rate', 'composite_score'] as const
type Metric = (typeof METRICS)[number]

// Linear-interpolation percentile over a sorted ascending numeric array.
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]
  const frac = rank - lo
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac
}

async function logAudit(
  workspaceId: string,
  actor: string,
  action: string,
  entityType: string,
  entityId: string | null,
  detail: Record<string, unknown>,
) {
  await db.insert(audit_logs).values({
    workspace_id: workspaceId,
    actor,
    action,
    entity_type: entityType,
    entity_id: entityId,
    detail,
  } as any)
}

// ---------------------------------------------------------------------------
// GET / — current benchmarks per metric (public read, workspace-scoped)
// ---------------------------------------------------------------------------
router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id') ?? getUserId(c)
  const conds = [] as any[]
  if (workspaceId) conds.push(eq(benchmarks.workspace_id, workspaceId))
  const rows = await db
    .select()
    .from(benchmarks)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(benchmarks.metric)
  return c.json(rows)
})

// ---------------------------------------------------------------------------
// POST /recompute — recompute portfolio percentiles per metric.
//   Per-originator latest rate snapshot feeds the three rate metrics;
//   the scorecards table feeds composite_score. Upserts on (workspace, metric).
// ---------------------------------------------------------------------------
router.post('/recompute', authMiddleware, async (c) => {
  const userId = getUserId(c)

  // All originators in this workspace.
  const wsOriginators = await db
    .select()
    .from(originators)
    .where(eq(originators.workspace_id, userId))

  // Latest per-originator rate snapshot (originator_id not null = per-originator).
  const snaps = await db
    .select()
    .from(rate_snapshots)
    .where(eq(rate_snapshots.workspace_id, userId))
    .orderBy(desc(rate_snapshots.as_of))

  const latestByOriginator = new Map<string, (typeof snaps)[number]>()
  for (const s of snaps) {
    if (!s.originator_id) continue // skip portfolio-wide rows
    if (!latestByOriginator.has(s.originator_id)) latestByOriginator.set(s.originator_id, s)
  }

  const unauthorizedValues: number[] = []
  const adminValues: number[] = []
  const overallValues: number[] = []
  for (const orig of wsOriginators) {
    const snap = latestByOriginator.get(orig.id)
    if (!snap) continue
    unauthorizedValues.push(snap.unauthorized_rate)
    adminValues.push(snap.admin_rate)
    overallValues.push(snap.overall_rate)
  }

  // Composite scores from scorecards.
  const cards = await db
    .select()
    .from(scorecards)
    .where(eq(scorecards.workspace_id, userId))
  const compositeValues = cards.map((s) => s.composite_score)

  const seriesByMetric: Record<Metric, number[]> = {
    unauthorized_rate: unauthorizedValues,
    admin_rate: adminValues,
    overall_rate: overallValues,
    composite_score: compositeValues,
  }

  const computedAt = new Date()
  const out: Array<Record<string, unknown>> = []

  for (const metric of METRICS) {
    const sorted = [...seriesByMetric[metric]].sort((a, b) => a - b)
    const p25 = Number(percentile(sorted, 25).toFixed(4))
    const p50 = Number(percentile(sorted, 50).toFixed(4))
    const p75 = Number(percentile(sorted, 75).toFixed(4))
    const p90 = Number(percentile(sorted, 90).toFixed(4))

    const [row] = await db
      .insert(benchmarks)
      .values({
        workspace_id: userId,
        metric,
        p25,
        p50,
        p75,
        p90,
        computed_at: computedAt,
      } as any)
      .onConflictDoUpdate({
        target: [benchmarks.workspace_id, benchmarks.metric],
        set: { p25, p50, p75, p90, computed_at: computedAt },
      })
      .returning()
    out.push({ ...row, sample_size: sorted.length })
  }

  await logAudit(userId, userId, 'benchmarks.recompute', 'benchmark', null, {
    metrics: METRICS.length,
    originators: wsOriginators.length,
  })

  return c.json({ computed: out.length, benchmarks: out })
})

export default router
