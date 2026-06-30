import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  originators,
  rate_snapshots,
  scorecards,
  forecasts,
  fee_records,
  representments,
  warning_letters,
  remediation_cases,
  audit_logs,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const originatorSchema = z.object({
  name: z.string().min(1),
  company_id: z.string().optional().nullable(),
  odfi_name: z.string().optional().nullable(),
  routing_number: z.string().optional().nullable(),
  mcc: z.string().optional().nullable(),
  expected_monthly_volume: z.number().int().nonnegative().optional().default(0),
  status: z.enum(['active', 'onboarding', 'suspended']).optional().default('active'),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
})

const bulkSchema = z.object({
  originators: z.array(originatorSchema).min(1),
})

async function audit(workspaceId: string, actor: string, action: string, entityId: string, detail: Record<string, unknown>) {
  await db.insert(audit_logs).values({
    workspace_id: workspaceId,
    actor,
    action,
    entity_type: 'originator',
    entity_id: entityId,
    detail,
  })
}

// Public: list workspace originators (filter by status). workspace scoped by ?workspace_id or by status only.
router.get('/', async (c) => {
  const status = c.req.query('status')
  const workspaceId = c.req.query('workspace_id')
  const conds = []
  if (status) conds.push(eq(originators.status, status))
  if (workspaceId) conds.push(eq(originators.workspace_id, workspaceId))
  const rows = conds.length
    ? await db.select().from(originators).where(and(...conds)).orderBy(desc(originators.created_at))
    : await db.select().from(originators).orderBy(desc(originators.created_at))
  return c.json(rows)
})

// Public: originator detail
router.get('/:id', async (c) => {
  const [row] = await db.select().from(originators).where(eq(originators.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json(row)
})

// Public: aggregated profile (latest rates, scorecard, forecast, fee totals, open letters/cases)
router.get('/:id/profile', async (c) => {
  const id = c.req.param('id')
  const [originator] = await db.select().from(originators).where(eq(originators.id, id))
  if (!originator) return c.json({ error: 'Not found' }, 404)

  const [rates] = await db
    .select()
    .from(rate_snapshots)
    .where(eq(rate_snapshots.originator_id, id))
    .orderBy(desc(rate_snapshots.as_of))
    .limit(1)

  const [scorecard] = await db
    .select()
    .from(scorecards)
    .where(eq(scorecards.originator_id, id))
    .orderBy(desc(scorecards.computed_at))
    .limit(1)

  const forecastRows = await db
    .select()
    .from(forecasts)
    .where(eq(forecasts.originator_id, id))
    .orderBy(desc(forecasts.computed_at))

  // Reduce to latest forecast per rate_type
  const forecastByType: Record<string, typeof forecastRows[number]> = {}
  for (const f of forecastRows) {
    if (!forecastByType[f.rate_type]) forecastByType[f.rate_type] = f
  }
  const forecast = Object.values(forecastByType)

  const fees = await db.select().from(fee_records).where(eq(fee_records.originator_id, id))
  const repays = await db.select().from(representments).where(eq(representments.originator_id, id))
  const feeTotalCents = fees.reduce((s, f) => s + (f.amount_cents ?? 0), 0)
  const recoveredCents = repays.reduce((s, r) => s + (r.recovered_amount_cents ?? 0), 0)
  const feeTotals = {
    feeCount: fees.length,
    feeTotalCents,
    recoveredCents,
    netCents: feeTotalCents - recoveredCents,
  }

  const letters = await db
    .select()
    .from(warning_letters)
    .where(and(eq(warning_letters.originator_id, id), eq(warning_letters.status, 'open')))
    .orderBy(desc(warning_letters.received_date))

  const cases = await db
    .select()
    .from(remediation_cases)
    .where(eq(remediation_cases.originator_id, id))
    .orderBy(desc(remediation_cases.created_at))
  const openCases = cases.filter((k) => k.status !== 'resolved')

  return c.json({ originator, rates: rates ?? null, scorecard: scorecard ?? null, forecast, feeTotals, letters, cases: openCases })
})

// Auth: create originator
router.post('/', authMiddleware, zValidator('json', originatorSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')
  const [row] = await db
    .insert(originators)
    .values({ ...body, workspace_id: userId, created_by: userId })
    .returning()
  await audit(userId, userId, 'create', row.id, { name: row.name })
  return c.json(row, 201)
})

// Auth: update originator
router.put('/:id', authMiddleware, zValidator('json', originatorSchema.partial()), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(originators).where(eq(originators.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const [updated] = await db
    .update(originators)
    .set({ ...body, updated_at: new Date() })
    .where(eq(originators.id, id))
    .returning()
  await audit(userId, userId, 'update', id, body as Record<string, unknown>)
  return c.json(updated)
})

// Auth: delete originator
router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(originators).where(eq(originators.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)
  await db.delete(originators).where(eq(originators.id, id))
  await audit(userId, userId, 'delete', id, { name: existing.name })
  return c.json({ success: true })
})

// Auth: bulk create originators
router.post('/bulk', authMiddleware, zValidator('json', bulkSchema), async (c) => {
  const userId = getUserId(c)
  const { originators: rows } = c.req.valid('json')
  const values = rows.map((r) => ({ ...r, workspace_id: userId, created_by: userId }))
  const inserted = await db.insert(originators).values(values).returning()
  await audit(userId, userId, 'bulk_create', 'bulk', { count: inserted.length })
  return c.json({ inserted: inserted.length, originators: inserted }, 201)
})

export default router
