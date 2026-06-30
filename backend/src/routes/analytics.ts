import { Hono } from 'hono'
import { db } from '../db/index.js'
import {
  rate_snapshots,
  return_entries,
  originators,
} from '../db/schema.js'
import { eq, and, desc, isNull } from 'drizzle-orm'
import { getUserId } from '../lib/auth.js'

const router = new Hono()

// Workspace scope: public reads still scope to the requesting user's workspace
// when an X-User-Id header is present; otherwise scope is empty (no rows).
function workspaceId(c: any): string {
  return getUserId(c)
}

function dayKey(d: Date): string {
  return new Date(d).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// GET /trends — rate trend series (portfolio + optionally one originator)
// Returns chronological snapshot series for the three rates.
// ---------------------------------------------------------------------------
router.get('/trends', async (c) => {
  const ws = workspaceId(c)
  if (!ws) return c.json({ series: { portfolio: [], originator: null } })

  const originatorId = c.req.query('originator_id')

  // Portfolio series (originator_id IS NULL on rate_snapshots).
  const portfolioRows = await db
    .select()
    .from(rate_snapshots)
    .where(and(eq(rate_snapshots.workspace_id, ws), isNull(rate_snapshots.originator_id)))
    .orderBy(rate_snapshots.as_of)

  const toPoint = (r: typeof portfolioRows[number]) => ({
    as_of: r.as_of,
    window_days: r.window_days,
    debit_count: r.debit_count,
    total_returns: r.total_returns,
    unauthorized_rate: r.unauthorized_rate,
    admin_rate: r.admin_rate,
    overall_rate: r.overall_rate,
    unauthorized_status: r.unauthorized_status,
    admin_status: r.admin_status,
    overall_status: r.overall_status,
  })

  let originatorSeries: ReturnType<typeof toPoint>[] | null = null
  if (originatorId) {
    const rows = await db
      .select()
      .from(rate_snapshots)
      .where(
        and(
          eq(rate_snapshots.workspace_id, ws),
          eq(rate_snapshots.originator_id, originatorId),
        ),
      )
      .orderBy(rate_snapshots.as_of)
    originatorSeries = rows.map(toPoint)
  }

  return c.json({
    series: {
      portfolio: portfolioRows.map(toPoint),
      originator: originatorSeries,
      originatorId: originatorId ?? null,
    },
  })
})

// ---------------------------------------------------------------------------
// GET /code-distribution — return-code distribution over time.
// Buckets returns by day and by return_code, plus an overall tally.
// ---------------------------------------------------------------------------
router.get('/code-distribution', async (c) => {
  const ws = workspaceId(c)
  if (!ws) return c.json({ buckets: [], totals: [] })

  const rows = await db
    .select()
    .from(return_entries)
    .where(eq(return_entries.workspace_id, ws))
    .orderBy(return_entries.return_date)

  // day -> code -> { count, amount_cents }
  const byDay = new Map<string, Map<string, { count: number; amount_cents: number; category: string }>>()
  // code -> aggregate totals
  const totalsMap = new Map<string, { code: string; category: string; count: number; amount_cents: number }>()

  for (const r of rows) {
    const day = dayKey(r.return_date as unknown as Date)
    if (!byDay.has(day)) byDay.set(day, new Map())
    const codeMap = byDay.get(day)!
    const existing = codeMap.get(r.return_code) ?? { count: 0, amount_cents: 0, category: r.category }
    existing.count += 1
    existing.amount_cents += r.amount_cents ?? 0
    existing.category = r.category
    codeMap.set(r.return_code, existing)

    const t = totalsMap.get(r.return_code) ?? {
      code: r.return_code,
      category: r.category,
      count: 0,
      amount_cents: 0,
    }
    t.count += 1
    t.amount_cents += r.amount_cents ?? 0
    t.category = r.category
    totalsMap.set(r.return_code, t)
  }

  const buckets = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, codeMap]) => ({
      day,
      codes: [...codeMap.entries()]
        .map(([code, v]) => ({ code, category: v.category, count: v.count, amount_cents: v.amount_cents }))
        .sort((a, b) => b.count - a.count),
    }))

  const totals = [...totalsMap.values()].sort((a, b) => b.count - a.count)

  return c.json({ buckets, totals })
})

// ---------------------------------------------------------------------------
// GET /cohorts — originators grouped by onboarding cohort (month of created_at).
// ---------------------------------------------------------------------------
router.get('/cohorts', async (c) => {
  const ws = workspaceId(c)
  if (!ws) return c.json({ cohorts: [] })

  const origs = await db
    .select()
    .from(originators)
    .where(eq(originators.workspace_id, ws))
    .orderBy(originators.created_at)

  // Latest per-originator snapshot for rate context.
  const snaps = await db
    .select()
    .from(rate_snapshots)
    .where(eq(rate_snapshots.workspace_id, ws))
    .orderBy(desc(rate_snapshots.as_of))

  const latestByOrig = new Map<string, typeof snaps[number]>()
  for (const s of snaps) {
    if (s.originator_id && !latestByOrig.has(s.originator_id)) {
      latestByOrig.set(s.originator_id, s)
    }
  }

  // cohort key = YYYY-MM of created_at
  const cohortMap = new Map<
    string,
    {
      cohort: string
      count: number
      originators: Array<{ id: string; name: string; status: string; overall_rate: number }>
      avgOverallRate: number
      _rateSum: number
      _rateN: number
    }
  >()

  for (const o of origs) {
    const cohort = new Date(o.created_at as unknown as Date).toISOString().slice(0, 7)
    if (!cohortMap.has(cohort)) {
      cohortMap.set(cohort, {
        cohort,
        count: 0,
        originators: [],
        avgOverallRate: 0,
        _rateSum: 0,
        _rateN: 0,
      })
    }
    const entry = cohortMap.get(cohort)!
    const snap = latestByOrig.get(o.id)
    const overall = snap?.overall_rate ?? 0
    entry.count += 1
    entry.originators.push({ id: o.id, name: o.name, status: o.status, overall_rate: overall })
    if (snap) {
      entry._rateSum += overall
      entry._rateN += 1
    }
  }

  const cohorts = [...cohortMap.values()]
    .map((e) => ({
      cohort: e.cohort,
      count: e.count,
      originators: e.originators,
      avgOverallRate: e._rateN > 0 ? e._rateSum / e._rateN : 0,
    }))
    .sort((a, b) => a.cohort.localeCompare(b.cohort))

  return c.json({ cohorts })
})

// ---------------------------------------------------------------------------
// GET /volume-correlation — volume vs return-rate scatter data per originator.
// x = expected_monthly_volume (or observed debit count), y = overall_rate.
// ---------------------------------------------------------------------------
router.get('/volume-correlation', async (c) => {
  const ws = workspaceId(c)
  if (!ws) return c.json({ points: [], correlation: 0 })

  const origs = await db
    .select()
    .from(originators)
    .where(eq(originators.workspace_id, ws))

  const snaps = await db
    .select()
    .from(rate_snapshots)
    .where(eq(rate_snapshots.workspace_id, ws))
    .orderBy(desc(rate_snapshots.as_of))

  const latestByOrig = new Map<string, typeof snaps[number]>()
  for (const s of snaps) {
    if (s.originator_id && !latestByOrig.has(s.originator_id)) {
      latestByOrig.set(s.originator_id, s)
    }
  }

  const points = origs.map((o) => {
    const snap = latestByOrig.get(o.id)
    const observedVolume = snap?.debit_count ?? 0
    return {
      originatorId: o.id,
      name: o.name,
      expectedMonthlyVolume: o.expected_monthly_volume ?? 0,
      observedVolume,
      overallRate: snap?.overall_rate ?? 0,
      unauthorizedRate: snap?.unauthorized_rate ?? 0,
      grade: o.status,
    }
  })

  // Pearson correlation between volume (expected) and overall return rate.
  const withData = points.filter((p) => p.expectedMonthlyVolume > 0 || p.overallRate > 0)
  let correlation = 0
  const n = withData.length
  if (n >= 2) {
    const xs = withData.map((p) => p.expectedMonthlyVolume)
    const ys = withData.map((p) => p.overallRate)
    const mx = xs.reduce((a, b) => a + b, 0) / n
    const my = ys.reduce((a, b) => a + b, 0) / n
    let num = 0
    let dx = 0
    let dy = 0
    for (let i = 0; i < n; i++) {
      const a = xs[i] - mx
      const b = ys[i] - my
      num += a * b
      dx += a * a
      dy += b * b
    }
    const denom = Math.sqrt(dx * dy)
    correlation = denom > 0 ? num / denom : 0
  }

  return c.json({ points, correlation })
})

export default router
