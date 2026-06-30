import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import { originated_entries, originators, dispute_windows, audit_logs } from '../db/schema.js'
import { eq, and, gte, lte, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const DAY_MS = 86_400_000

const entrySchema = z.object({
  originator_id: z.string().min(1),
  entry_date: z.string().min(1),
  settlement_date: z.string().optional().nullable(),
  direction: z.enum(['debit', 'credit']).optional().default('debit'),
  sec_code: z.enum(['PPD', 'CCD', 'WEB', 'TEL']).optional().default('PPD'),
  amount_cents: z.number().int().nonnegative().optional().default(0),
  trace_number: z.string().optional().nullable(),
  external_ref: z.string().optional().nullable(),
})

async function audit(workspaceId: string, actor: string, action: string, entityId: string, detail: Record<string, unknown>) {
  await db.insert(audit_logs).values({
    workspace_id: workspaceId,
    actor,
    action,
    entity_type: 'originated_entry',
    entity_id: entityId,
    detail,
  })
}

// Upsert dispute window for a debit entry (settlement_date + 60 days).
async function upsertDisputeWindow(entry: typeof originated_entries.$inferSelect) {
  if (entry.direction !== 'debit') return
  const settlement = entry.settlement_date ?? entry.entry_date
  const expiry = new Date(new Date(settlement).getTime() + 60 * DAY_MS)
  await db
    .insert(dispute_windows)
    .values({
      workspace_id: entry.workspace_id,
      originator_id: entry.originator_id,
      originated_entry_id: entry.id,
      settlement_date: settlement,
      window_expiry: expiry,
      amount_cents: entry.amount_cents,
      status: 'open',
    })
    .onConflictDoUpdate({
      target: dispute_windows.originated_entry_id,
      set: { settlement_date: settlement, window_expiry: expiry, amount_cents: entry.amount_cents },
    })
}

// Public: list originated entries (filter originator_id, sec_code, date range)
router.get('/', async (c) => {
  const originatorId = c.req.query('originator_id')
  const secCode = c.req.query('sec_code')
  const from = c.req.query('from')
  const to = c.req.query('to')
  const workspaceId = c.req.query('workspace_id')
  const conds = []
  if (originatorId) conds.push(eq(originated_entries.originator_id, originatorId))
  if (secCode) conds.push(eq(originated_entries.sec_code, secCode))
  if (workspaceId) conds.push(eq(originated_entries.workspace_id, workspaceId))
  if (from) conds.push(gte(originated_entries.entry_date, new Date(from)))
  if (to) conds.push(lte(originated_entries.entry_date, new Date(to)))
  const rows = conds.length
    ? await db.select().from(originated_entries).where(and(...conds)).orderBy(desc(originated_entries.entry_date))
    : await db.select().from(originated_entries).orderBy(desc(originated_entries.entry_date))
  return c.json(rows)
})

// Public: entry detail
router.get('/:id', async (c) => {
  const [row] = await db.select().from(originated_entries).where(eq(originated_entries.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json(row)
})

// Auth: create originated entry (upserts dispute_window for debits)
router.post('/', authMiddleware, zValidator('json', entrySchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')

  const [originator] = await db.select().from(originators).where(eq(originators.id, body.originator_id))
  if (!originator) return c.json({ error: 'Originator not found' }, 404)
  if (originator.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)

  const [row] = await db
    .insert(originated_entries)
    .values({
      workspace_id: userId,
      originator_id: body.originator_id,
      entry_date: new Date(body.entry_date),
      settlement_date: body.settlement_date ? new Date(body.settlement_date) : null,
      direction: body.direction,
      sec_code: body.sec_code,
      amount_cents: body.amount_cents,
      trace_number: body.trace_number ?? null,
      external_ref: body.external_ref ?? null,
      created_by: userId,
    })
    .returning()

  await upsertDisputeWindow(row)
  await audit(userId, userId, 'create', row.id, { originator_id: row.originator_id, direction: row.direction, amount_cents: row.amount_cents })
  return c.json(row, 201)
})

// Auth: update entry
router.put('/:id', authMiddleware, zValidator('json', entrySchema.partial()), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(originated_entries).where(eq(originated_entries.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const patch: Record<string, unknown> = {}
  if (body.originator_id !== undefined) patch.originator_id = body.originator_id
  if (body.entry_date !== undefined) patch.entry_date = new Date(body.entry_date as string)
  if (body.settlement_date !== undefined) patch.settlement_date = body.settlement_date ? new Date(body.settlement_date) : null
  if (body.direction !== undefined) patch.direction = body.direction
  if (body.sec_code !== undefined) patch.sec_code = body.sec_code
  if (body.amount_cents !== undefined) patch.amount_cents = body.amount_cents
  if (body.trace_number !== undefined) patch.trace_number = body.trace_number ?? null
  if (body.external_ref !== undefined) patch.external_ref = body.external_ref ?? null
  const [updated] = await db.update(originated_entries).set(patch).where(eq(originated_entries.id, id)).returning()
  await upsertDisputeWindow(updated)
  await audit(userId, userId, 'update', id, patch)
  return c.json(updated)
})

// Auth: delete entry
router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(originated_entries).where(eq(originated_entries.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)
  await db.delete(dispute_windows).where(eq(dispute_windows.originated_entry_id, id))
  await db.delete(originated_entries).where(eq(originated_entries.id, id))
  await audit(userId, userId, 'delete', id, {})
  return c.json({ success: true })
})

export default router
