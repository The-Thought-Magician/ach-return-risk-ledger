import { Hono } from 'hono'
import { db } from '../db/index.js'
import {
  originators,
  originated_entries,
  return_entries,
  rate_snapshots,
  thresholds,
  audit_logs,
} from '../db/schema.js'
import { eq, and, desc, isNull } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// NACHA category buckets (build-plan notes).
const UNAUTHORIZED_CODES = new Set(['R05', 'R07', 'R10', 'R11', 'R29', 'R51'])
const ADMIN_CODES = new Set(['R02', 'R03', 'R04'])

const DAY_MS = 86_400_000

interface EffectiveThresholds {
  unauthorized_limit: number
  admin_limit: number
  overall_limit: number
  watch_pct: number
  warning_pct: number
  window_days: number
}

const DEFAULT_THRESHOLDS: EffectiveThresholds = {
  unauthorized_limit: 0.5,
  admin_limit: 3.0,
  overall_limit: 15.0,
  watch_pct: 0.6,
  warning_pct: 0.8,
  window_days: 60,
}

async function getThresholds(workspaceId: string): Promise<EffectiveThresholds> {
  const [t] = await db
    .select()
    .from(thresholds)
    .where(eq(thresholds.workspace_id, workspaceId))
  if (!t) return DEFAULT_THRESHOLDS
  return {
    unauthorized_limit: t.unauthorized_limit,
    admin_limit: t.admin_limit,
    overall_limit: t.overall_limit,
    watch_pct: t.watch_pct,
    warning_pct: t.warning_pct,
    window_days: t.window_days,
  }
}

function classify(
  ratePct: number,
  limit: number,
  watchPct: number,
  warningPct: number,
): string {
  if (ratePct >= limit) return 'breach'
  if (ratePct >= limit * warningPct) return 'warning'
  if (ratePct >= limit * watchPct) return 'watch'
  return 'clear'
}

interface ComputedRates {
  debit_count: number
  total_returns: number
  unauthorized_rate: number
  admin_rate: number
  overall_rate: number
  unauthorized_status: string
  admin_status: string
  overall_status: string
}

// Compute the three NACHA rates (as percentages) over a rolling window.
// denominator = count of originated DEBIT entries with entry_date within window.
function computeRates(
  debits: Array<{ entry_date: Date }>,
  returns: Array<{ return_code: string; return_date: Date }>,
  t: EffectiveThresholds,
  asOf: Date,
): ComputedRates {
  const windowStart = asOf.getTime() - t.window_days * DAY_MS
  const debitCount = debits.filter(
    (d) => d.entry_date.getTime() >= windowStart && d.entry_date.getTime() <= asOf.getTime(),
  ).length
  const windowReturns = returns.filter(
    (r) =>
      r.return_date.getTime() >= windowStart &&
      r.return_date.getTime() <= asOf.getTime(),
  )

  const unauthorizedCount = windowReturns.filter((r) =>
    UNAUTHORIZED_CODES.has(r.return_code.toUpperCase()),
  ).length
  const adminCount = windowReturns.filter((r) =>
    ADMIN_CODES.has(r.return_code.toUpperCase()),
  ).length
  const totalReturns = windowReturns.length

  const unauthorizedRate = debitCount > 0 ? (unauthorizedCount / debitCount) * 100 : 0
  const adminRate = debitCount > 0 ? (adminCount / debitCount) * 100 : 0
  const overallRate = debitCount > 0 ? (totalReturns / debitCount) * 100 : 0

  return {
    debit_count: debitCount,
    total_returns: totalReturns,
    unauthorized_rate: unauthorizedRate,
    admin_rate: adminRate,
    overall_rate: overallRate,
    unauthorized_status: classify(
      unauthorizedRate,
      t.unauthorized_limit,
      t.watch_pct,
      t.warning_pct,
    ),
    admin_status: classify(adminRate, t.admin_limit, t.watch_pct, t.warning_pct),
    overall_status: classify(
      overallRate,
      t.overall_limit,
      t.watch_pct,
      t.warning_pct,
    ),
  }
}

// GET / — current computed rates per originator (latest snapshot each).
router.get('/', async (c) => {
  const workspaceId =
    c.req.header('X-User-Id') ?? c.req.header('x-user-id') ?? null
  if (!workspaceId) return c.json([])

  const orgs = await db
    .select()
    .from(originators)
    .where(eq(originators.workspace_id, workspaceId))

  const rows = []
  for (const org of orgs) {
    const [snap] = await db
      .select()
      .from(rate_snapshots)
      .where(
        and(
          eq(rate_snapshots.workspace_id, workspaceId),
          eq(rate_snapshots.originator_id, org.id),
        ),
      )
      .orderBy(desc(rate_snapshots.as_of))
      .limit(1)
    rows.push({
      originator_id: org.id,
      originator_name: org.name,
      snapshot: snap ?? null,
    })
  }
  return c.json(rows)
})

// GET /portfolio — portfolio-wide computed rates + status (latest snapshot).
router.get('/portfolio', async (c) => {
  const workspaceId =
    c.req.header('X-User-Id') ?? c.req.header('x-user-id') ?? null
  if (!workspaceId) return c.json(null)
  const [snap] = await db
    .select()
    .from(rate_snapshots)
    .where(
      and(
        eq(rate_snapshots.workspace_id, workspaceId),
        isNull(rate_snapshots.originator_id),
      ),
    )
    .orderBy(desc(rate_snapshots.as_of))
    .limit(1)
  return c.json(snap ?? null)
})

// GET /originator/:id — rate snapshot timeline for one originator.
router.get('/originator/:id', async (c) => {
  const workspaceId =
    c.req.header('X-User-Id') ?? c.req.header('x-user-id') ?? null
  if (!workspaceId) return c.json([])
  const id = c.req.param('id')
  const snaps = await db
    .select()
    .from(rate_snapshots)
    .where(
      and(
        eq(rate_snapshots.workspace_id, workspaceId),
        eq(rate_snapshots.originator_id, id),
      ),
    )
    .orderBy(rate_snapshots.as_of)
  return c.json(snaps)
})

// Shared recompute logic, callable from other routes (e.g. after seeding sample data).
export async function recomputeSnapshots(userId: string) {
  const t = await getThresholds(userId)
  const asOf = new Date()

  const orgs = await db
    .select()
    .from(originators)
    .where(eq(originators.workspace_id, userId))

  const allDebits = await db
    .select()
    .from(originated_entries)
    .where(
      and(
        eq(originated_entries.workspace_id, userId),
        eq(originated_entries.direction, 'debit'),
      ),
    )
  const allReturns = await db
    .select()
    .from(return_entries)
    .where(eq(return_entries.workspace_id, userId))

  const snapshots = []

  for (const org of orgs) {
    const debits = allDebits.filter((d) => d.originator_id === org.id)
    const returns = allReturns.filter((r) => r.originator_id === org.id)
    const computed = computeRates(debits, returns, t, asOf)
    const [snap] = await db
      .insert(rate_snapshots)
      .values({
        workspace_id: userId,
        originator_id: org.id,
        window_days: t.window_days,
        as_of: asOf,
        ...computed,
      })
      .returning()
    snapshots.push(snap)
  }

  // Portfolio-wide (originator_id = null).
  const portfolioComputed = computeRates(allDebits, allReturns, t, asOf)
  const [portfolioSnap] = await db
    .insert(rate_snapshots)
    .values({
      workspace_id: userId,
      originator_id: null,
      window_days: t.window_days,
      as_of: asOf,
      ...portfolioComputed,
    })
    .returning()
  snapshots.push(portfolioSnap)

  await db.insert(audit_logs).values({
    workspace_id: userId,
    actor: userId,
    action: 'recompute_rates',
    entity_type: 'rate_snapshot',
    entity_id: null,
    detail: { computed: snapshots.length, as_of: asOf.toISOString() },
  })

  return { computed: snapshots.length, snapshots }
}

// POST /recompute — recompute snapshots for all originators + portfolio.
router.post('/recompute', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const result = await recomputeSnapshots(userId)
  return c.json(result)
})

export default router
