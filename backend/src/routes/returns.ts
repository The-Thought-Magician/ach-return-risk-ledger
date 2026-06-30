import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  return_entries,
  return_codes,
  originated_entries,
  originators,
  audit_logs,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const DAY_MS = 86_400_000

// NACHA classification fallbacks (used if a code is missing from the dictionary).
const UNAUTHORIZED_CODES = new Set(['R05', 'R07', 'R10', 'R11', 'R29', 'R51'])
const ADMIN_CODES = new Set(['R02', 'R03', 'R04'])

const returnSchema = z.object({
  originator_id: z.string().min(1),
  originated_entry_id: z.string().optional().nullable(),
  return_code: z.string().min(1),
  return_date: z.string().min(1),
  amount_cents: z.number().int().nonnegative().optional().default(0),
  external_ref: z.string().optional().nullable(),
})

async function audit(workspaceId: string, actor: string, action: string, entityId: string, detail: Record<string, unknown>) {
  await db.insert(audit_logs).values({
    workspace_id: workspaceId,
    actor,
    action,
    entity_type: 'return_entry',
    entity_id: entityId,
    detail,
  })
}

// Resolve the category for a return code, honoring a workspace override.
async function classify(workspaceId: string, code: string): Promise<{ category: string; consumer: boolean }> {
  const upper = code.toUpperCase()
  const [dict] = await db.select().from(return_codes).where(eq(return_codes.code, upper))
  if (dict) {
    if (dict.workspace_override === workspaceId && dict.override_category) {
      return { category: dict.override_category, consumer: !!dict.consumer }
    }
    return { category: dict.category, consumer: !!dict.consumer }
  }
  if (UNAUTHORIZED_CODES.has(upper)) return { category: 'unauthorized', consumer: true }
  if (ADMIN_CODES.has(upper)) return { category: 'administrative', consumer: false }
  return { category: 'other', consumer: false }
}

// Late detection: a return arriving after its allowed return timeframe.
// Unauthorized/consumer returns get the 60-day window from settlement; others
// get 2 banking days (approximated as 2 calendar days) from settlement.
async function detectLate(
  workspaceId: string,
  category: string,
  consumer: boolean,
  originatedEntryId: string | null | undefined,
  returnDate: Date,
): Promise<boolean> {
  if (!originatedEntryId) return false
  const [entry] = await db.select().from(originated_entries).where(eq(originated_entries.id, originatedEntryId))
  if (!entry) return false
  const settlement = entry.settlement_date ?? entry.entry_date
  const allowedDays = category === 'unauthorized' || consumer ? 60 : 2
  const deadline = new Date(new Date(settlement).getTime() + allowedDays * DAY_MS)
  return returnDate.getTime() > deadline.getTime()
}

// Public: list return entries (filter originator_id, return_code, category)
router.get('/', async (c) => {
  const originatorId = c.req.query('originator_id')
  const returnCode = c.req.query('return_code')
  const category = c.req.query('category')
  const workspaceId = c.req.query('workspace_id')
  const conds = []
  if (originatorId) conds.push(eq(return_entries.originator_id, originatorId))
  if (returnCode) conds.push(eq(return_entries.return_code, returnCode.toUpperCase()))
  if (category) conds.push(eq(return_entries.category, category))
  if (workspaceId) conds.push(eq(return_entries.workspace_id, workspaceId))
  const rows = conds.length
    ? await db.select().from(return_entries).where(and(...conds)).orderBy(desc(return_entries.return_date))
    : await db.select().from(return_entries).orderBy(desc(return_entries.return_date))
  return c.json(rows)
})

// Public: unmatched queue (matched=false)
router.get('/unmatched', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const conds = [eq(return_entries.matched, false)]
  if (workspaceId) conds.push(eq(return_entries.workspace_id, workspaceId))
  const rows = await db
    .select()
    .from(return_entries)
    .where(and(...conds))
    .orderBy(desc(return_entries.return_date))
  return c.json(rows)
})

// Public: return detail
router.get('/:id', async (c) => {
  const [row] = await db.select().from(return_entries).where(eq(return_entries.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json(row)
})

// Auth: create return (auto-classify category, late detection)
router.post('/', authMiddleware, zValidator('json', returnSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')

  const [originator] = await db.select().from(originators).where(eq(originators.id, body.originator_id))
  if (!originator) return c.json({ error: 'Originator not found' }, 404)
  if (originator.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)

  const code = body.return_code.toUpperCase()
  const { category, consumer } = await classify(userId, code)
  const returnDate = new Date(body.return_date)
  const matched = !!body.originated_entry_id

  if (body.originated_entry_id) {
    const [entry] = await db.select().from(originated_entries).where(eq(originated_entries.id, body.originated_entry_id))
    if (!entry) return c.json({ error: 'Originated entry not found' }, 404)
    if (entry.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)
  }

  const isLate = await detectLate(userId, category, consumer, body.originated_entry_id, returnDate)

  const [row] = await db
    .insert(return_entries)
    .values({
      workspace_id: userId,
      originator_id: body.originator_id,
      originated_entry_id: body.originated_entry_id ?? null,
      return_code: code,
      category,
      return_date: returnDate,
      amount_cents: body.amount_cents,
      is_late: isLate,
      matched,
      external_ref: body.external_ref ?? null,
      created_by: userId,
    })
    .returning()

  await audit(userId, userId, 'create', row.id, { return_code: code, category, is_late: isLate, matched })
  return c.json(row, 201)
})

// Auth: update return (re-classify on code change, recompute late)
router.put('/:id', authMiddleware, zValidator('json', returnSchema.partial()), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(return_entries).where(eq(return_entries.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')

  const patch: Record<string, unknown> = {}
  if (body.originator_id !== undefined) patch.originator_id = body.originator_id
  if (body.amount_cents !== undefined) patch.amount_cents = body.amount_cents
  if (body.external_ref !== undefined) patch.external_ref = body.external_ref ?? null
  if (body.originated_entry_id !== undefined) {
    patch.originated_entry_id = body.originated_entry_id ?? null
    patch.matched = !!body.originated_entry_id
  }

  const code = body.return_code !== undefined ? body.return_code.toUpperCase() : existing.return_code
  let category = existing.category
  let consumer = false
  if (body.return_code !== undefined) {
    patch.return_code = code
    const cls = await classify(userId, code)
    category = cls.category
    consumer = cls.consumer
    patch.category = category
  } else {
    consumer = (await classify(userId, code)).consumer
  }

  const returnDate = body.return_date !== undefined ? new Date(body.return_date) : existing.return_date
  if (body.return_date !== undefined) patch.return_date = returnDate

  const originatedEntryId =
    body.originated_entry_id !== undefined ? body.originated_entry_id ?? null : existing.originated_entry_id
  patch.is_late = await detectLate(userId, category, consumer, originatedEntryId, returnDate)

  const [updated] = await db.update(return_entries).set(patch).where(eq(return_entries.id, id)).returning()
  await audit(userId, userId, 'update', id, patch)
  return c.json(updated)
})

// Auth: match to an originated_entry
router.post(
  '/:id/match',
  authMiddleware,
  zValidator('json', z.object({ originated_entry_id: z.string().min(1) })),
  async (c) => {
    const userId = getUserId(c)
    const id = c.req.param('id')
    const { originated_entry_id } = c.req.valid('json')

    const [existing] = await db.select().from(return_entries).where(eq(return_entries.id, id))
    if (!existing) return c.json({ error: 'Not found' }, 404)
    if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)

    const [entry] = await db.select().from(originated_entries).where(eq(originated_entries.id, originated_entry_id))
    if (!entry) return c.json({ error: 'Originated entry not found' }, 404)
    if (entry.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)

    const consumer = (await classify(userId, existing.return_code)).consumer
    const isLate = await detectLate(userId, existing.category, consumer, originated_entry_id, existing.return_date)

    const [updated] = await db
      .update(return_entries)
      .set({ originated_entry_id, matched: true, is_late: isLate })
      .where(eq(return_entries.id, id))
      .returning()
    await audit(userId, userId, 'match', id, { originated_entry_id, is_late: isLate })
    return c.json(updated)
  },
)

// Auth: delete return
router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(return_entries).where(eq(return_entries.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)
  await db.delete(return_entries).where(eq(return_entries.id, id))
  await audit(userId, userId, 'delete', id, {})
  return c.json({ success: true })
})

export default router
