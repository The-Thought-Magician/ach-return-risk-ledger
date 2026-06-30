import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  reports,
  originators,
  originated_entries,
  return_entries,
  fee_records,
  representments,
  thresholds,
  audit_logs,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const UNAUTHORIZED = new Set(['R05', 'R07', 'R10', 'R11', 'R29', 'R51'])
const ADMINISTRATIVE = new Set(['R02', 'R03', 'R04'])

const DEFAULT_THRESHOLDS = {
  unauthorized_limit: 0.5,
  admin_limit: 3.0,
  overall_limit: 15.0,
  watch_pct: 0.6,
  warning_pct: 0.8,
  window_days: 60,
}

function statusFor(ratePct: number, limit: number, watchPct: number, warningPct: number): string {
  if (ratePct >= limit) return 'breach'
  if (ratePct >= limit * warningPct) return 'warning'
  if (ratePct >= limit * watchPct) return 'watch'
  return 'clear'
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
// GET / — saved reports (public read, workspace-scoped)
// ---------------------------------------------------------------------------
router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id') ?? getUserId(c)
  const conds = [] as any[]
  if (workspaceId) conds.push(eq(reports.workspace_id, workspaceId))
  const rows = await db
    .select()
    .from(reports)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(reports.created_at))
  return c.json(rows)
})

// ---------------------------------------------------------------------------
// GET /:id — report detail
// ---------------------------------------------------------------------------
router.get('/:id', async (c) => {
  const [row] = await db.select().from(reports).where(eq(reports.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json(row)
})

// ---------------------------------------------------------------------------
// POST /generate — generate a compliance report for a period (persists payload)
// body: { name, originator_id?, period_start, period_end, recurring? }
// ---------------------------------------------------------------------------
const generateSchema = z.object({
  name: z.string().min(1),
  originator_id: z.string().nullable().optional(),
  period_start: z.string().min(1),
  period_end: z.string().min(1),
  recurring: z.boolean().optional().default(false),
})

router.post('/generate', authMiddleware, zValidator('json', generateSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')

  const periodStart = new Date(body.period_start)
  const periodEnd = new Date(body.period_end)
  if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
    return c.json({ error: 'Invalid period dates' }, 400)
  }
  if (periodEnd.getTime() < periodStart.getTime()) {
    return c.json({ error: 'period_end must be after period_start' }, 400)
  }

  // Resolve thresholds for this workspace (fall back to NACHA defaults).
  const [th] = await db.select().from(thresholds).where(eq(thresholds.workspace_id, userId))
  const limits = th ?? DEFAULT_THRESHOLDS

  // Optionally constrain to a single originator (with ownership check).
  let originatorRow: { id: string; name: string } | undefined
  if (body.originator_id) {
    const [o] = await db.select().from(originators).where(eq(originators.id, body.originator_id))
    if (!o) return c.json({ error: 'Originator not found' }, 404)
    if (o.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)
    originatorRow = { id: o.id, name: o.name }
  }

  // Pull originated entries + returns + fees + representments for the workspace.
  const entryConds = [eq(originated_entries.workspace_id, userId)]
  if (body.originator_id) entryConds.push(eq(originated_entries.originator_id, body.originator_id))
  const allEntries = await db
    .select()
    .from(originated_entries)
    .where(and(...entryConds))

  const returnConds = [eq(return_entries.workspace_id, userId)]
  if (body.originator_id) returnConds.push(eq(return_entries.originator_id, body.originator_id))
  const allReturns = await db
    .select()
    .from(return_entries)
    .where(and(...returnConds))

  const feeConds = [eq(fee_records.workspace_id, userId)]
  if (body.originator_id) feeConds.push(eq(fee_records.originator_id, body.originator_id))
  const allFees = await db
    .select()
    .from(fee_records)
    .where(and(...feeConds))

  const repConds = [eq(representments.workspace_id, userId)]
  if (body.originator_id) repConds.push(eq(representments.originator_id, body.originator_id))
  const allReps = await db
    .select()
    .from(representments)
    .where(and(...repConds))

  const inPeriod = (d: Date | null) =>
    d !== null && d.getTime() >= periodStart.getTime() && d.getTime() <= periodEnd.getTime()

  const periodEntries = allEntries.filter((e) => inPeriod(e.entry_date as unknown as Date))
  const periodDebits = periodEntries.filter((e) => e.direction === 'debit')
  const debitCount = periodDebits.length

  const periodReturns = allReturns.filter((r) => inPeriod(r.return_date as unknown as Date))
  const unauthorizedReturns = periodReturns.filter((r) => UNAUTHORIZED.has(r.return_code))
  const adminReturns = periodReturns.filter((r) => ADMINISTRATIVE.has(r.return_code))

  const pct = (num: number) => (debitCount > 0 ? (num / debitCount) * 100 : 0)
  const unauthorizedRate = pct(unauthorizedReturns.length)
  const adminRate = pct(adminReturns.length)
  const overallRate = pct(periodReturns.length)

  // Return-code distribution within the period.
  const codeCounts: Record<string, number> = {}
  for (const r of periodReturns) codeCounts[r.return_code] = (codeCounts[r.return_code] ?? 0) + 1

  const periodFees = allFees.filter((f) => inPeriod(f.incurred_at as unknown as Date))
  const totalFeesCents = periodFees.reduce((s, f) => s + (f.amount_cents ?? 0), 0)

  const periodReps = allReps.filter((r) => inPeriod(r.representment_date as unknown as Date))
  const recoveredCents = periodReps.reduce((s, r) => s + (r.recovered_amount_cents ?? 0), 0)
  const recoveredCount = periodReps.filter((r) => r.outcome === 'recovered').length
  const recoveryRate = periodReps.length > 0 ? (recoveredCount / periodReps.length) * 100 : 0

  const returnedVolumeCents = periodReturns.reduce((s, r) => s + (r.amount_cents ?? 0), 0)
  const originatedVolumeCents = periodDebits.reduce((s, e) => s + (e.amount_cents ?? 0), 0)
  const lateReturns = periodReturns.filter((r) => r.is_late).length

  const payload = {
    period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
    scope: originatorRow ? { type: 'originator', ...originatorRow } : { type: 'portfolio' },
    thresholds: {
      unauthorized_limit: limits.unauthorized_limit,
      admin_limit: limits.admin_limit,
      overall_limit: limits.overall_limit,
      watch_pct: limits.watch_pct,
      warning_pct: limits.warning_pct,
    },
    volume: {
      debit_count: debitCount,
      total_entries: periodEntries.length,
      originated_volume_cents: originatedVolumeCents,
      returned_volume_cents: returnedVolumeCents,
    },
    rates: {
      unauthorized: {
        count: unauthorizedReturns.length,
        rate_pct: Number(unauthorizedRate.toFixed(4)),
        status: statusFor(
          unauthorizedRate,
          limits.unauthorized_limit,
          limits.watch_pct,
          limits.warning_pct,
        ),
      },
      administrative: {
        count: adminReturns.length,
        rate_pct: Number(adminRate.toFixed(4)),
        status: statusFor(adminRate, limits.admin_limit, limits.watch_pct, limits.warning_pct),
      },
      overall: {
        count: periodReturns.length,
        rate_pct: Number(overallRate.toFixed(4)),
        status: statusFor(overallRate, limits.overall_limit, limits.watch_pct, limits.warning_pct),
      },
    },
    returns: {
      total: periodReturns.length,
      late: lateReturns,
      code_distribution: Object.entries(codeCounts)
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count),
    },
    economics: {
      total_fees_cents: totalFeesCents,
      fee_count: periodFees.length,
      representments: periodReps.length,
      recovered_cents: recoveredCents,
      recovery_rate_pct: Number(recoveryRate.toFixed(4)),
      net_loss_cents: returnedVolumeCents - recoveredCents + totalFeesCents,
    },
    generated_at: new Date().toISOString(),
  }

  const [record] = await db
    .insert(reports)
    .values({
      workspace_id: userId,
      name: body.name,
      originator_id: body.originator_id ?? null,
      period_start: periodStart,
      period_end: periodEnd,
      recurring: body.recurring ?? false,
      payload,
      created_by: userId,
    } as any)
    .returning()

  await logAudit(userId, userId, 'report.generate', 'report', record.id, {
    name: body.name,
    originator_id: body.originator_id ?? null,
  })

  return c.json(record, 201)
})

// ---------------------------------------------------------------------------
// DELETE /:id — delete a report (ownership-checked)
// ---------------------------------------------------------------------------
router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(reports).where(eq(reports.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)
  await db.delete(reports).where(eq(reports.id, id))
  await logAudit(userId, userId, 'report.delete', 'report', id, {})
  return c.json({ success: true })
})

export default router
