import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import { representments, return_entries, originators, audit_logs } from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const MAX_ATTEMPTS = 2

const createSchema = z.object({
  originator_id: z.string().min(1),
  return_entry_id: z.string().min(1),
  representment_date: z.string().min(1),
  amount_cents: z.number().int().nonnegative().default(0),
  attempt_number: z.number().int().min(1).max(MAX_ATTEMPTS).optional(),
  outcome: z.enum(['pending', 'recovered', 'returned']).optional().default('pending'),
  recovered_amount_cents: z.number().int().nonnegative().optional().default(0),
})

const updateSchema = z.object({
  outcome: z.enum(['pending', 'recovered', 'returned']).optional(),
  recovered_amount_cents: z.number().int().nonnegative().optional(),
  representment_date: z.string().optional(),
  amount_cents: z.number().int().nonnegative().optional(),
})

// Public: list re-presentments (filter originator_id, outcome)
router.get('/', async (c) => {
  const originatorId = c.req.query('originator_id')
  const outcome = c.req.query('outcome')
  const conds = []
  if (originatorId) conds.push(eq(representments.originator_id, originatorId))
  if (outcome) conds.push(eq(representments.outcome, outcome))
  const rows = conds.length
    ? await db.select().from(representments).where(and(...conds)).orderBy(desc(representments.representment_date))
    : await db.select().from(representments).orderBy(desc(representments.representment_date))
  return c.json(rows)
})

// Public: recovery-rate summary per originator
router.get('/recovery', async (c) => {
  const originatorId = c.req.query('originator_id')
  const rows = originatorId
    ? await db.select().from(representments).where(eq(representments.originator_id, originatorId))
    : await db.select().from(representments)

  const byOriginator = new Map<
    string,
    { attempts: number; recovered: number; returned: number; pending: number; attemptedCents: number; recoveredCents: number }
  >()
  for (const r of rows) {
    const key = r.originator_id
    if (!byOriginator.has(key)) {
      byOriginator.set(key, { attempts: 0, recovered: 0, returned: 0, pending: 0, attemptedCents: 0, recoveredCents: 0 })
    }
    const agg = byOriginator.get(key)!
    agg.attempts += 1
    agg.attemptedCents += r.amount_cents ?? 0
    agg.recoveredCents += r.recovered_amount_cents ?? 0
    if (r.outcome === 'recovered') agg.recovered += 1
    else if (r.outcome === 'returned') agg.returned += 1
    else agg.pending += 1
  }

  const originatorRows = await db.select().from(originators)
  const nameById = new Map(originatorRows.map((o) => [o.id, o.name]))

  const summary = [...byOriginator.entries()].map(([id, agg]) => {
    const resolved = agg.recovered + agg.returned
    const recoveryRate = resolved > 0 ? agg.recovered / resolved : 0
    const dollarRecoveryRate = agg.attemptedCents > 0 ? agg.recoveredCents / agg.attemptedCents : 0
    return {
      originator_id: id,
      originator_name: nameById.get(id) ?? null,
      attempts: agg.attempts,
      recovered: agg.recovered,
      returned: agg.returned,
      pending: agg.pending,
      attempted_cents: agg.attemptedCents,
      recovered_cents: agg.recoveredCents,
      recovery_rate: recoveryRate,
      dollar_recovery_rate: dollarRecoveryRate,
    }
  })
  summary.sort((a, b) => b.attempts - a.attempts)
  return c.json(summary)
})

// Auth: record a re-presentment (enforces max attempt_number 2)
router.post('/', authMiddleware, zValidator('json', createSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')

  // Ownership: originator must belong to the workspace.
  const [orig] = await db.select().from(originators).where(eq(originators.id, body.originator_id))
  if (!orig) return c.json({ error: 'Originator not found' }, 404)
  if (orig.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)

  // Ownership: the return entry must belong to the workspace.
  const [ret] = await db.select().from(return_entries).where(eq(return_entries.id, body.return_entry_id))
  if (!ret) return c.json({ error: 'Return entry not found' }, 404)
  if (ret.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)

  // Enforce max NSF attempts (2) per return entry.
  const existing = await db
    .select()
    .from(representments)
    .where(and(eq(representments.return_entry_id, body.return_entry_id), eq(representments.workspace_id, userId)))
  if (existing.length >= MAX_ATTEMPTS) {
    return c.json({ error: `Maximum of ${MAX_ATTEMPTS} re-presentment attempts already recorded for this return` }, 400)
  }
  const attemptNumber = body.attempt_number ?? existing.length + 1
  if (attemptNumber > MAX_ATTEMPTS) {
    return c.json({ error: `attempt_number cannot exceed ${MAX_ATTEMPTS}` }, 400)
  }

  const [created] = await db
    .insert(representments)
    .values({
      workspace_id: userId,
      originator_id: body.originator_id,
      return_entry_id: body.return_entry_id,
      attempt_number: attemptNumber,
      representment_date: new Date(body.representment_date),
      amount_cents: body.amount_cents,
      outcome: body.outcome,
      recovered_amount_cents: body.recovered_amount_cents,
      created_by: userId,
    })
    .returning()

  await db.insert(audit_logs).values({
    workspace_id: userId,
    actor: userId,
    action: 'create',
    entity_type: 'representment',
    entity_id: created.id,
    detail: { return_entry_id: body.return_entry_id, attempt_number: attemptNumber },
  })

  return c.json(created, 201)
})

// Auth: update outcome / recovered amount
router.put('/:id', authMiddleware, zValidator('json', updateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(representments).where(eq(representments.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const patch: Partial<typeof representments.$inferInsert> = {}
  if (body.outcome !== undefined) patch.outcome = body.outcome
  if (body.recovered_amount_cents !== undefined) patch.recovered_amount_cents = body.recovered_amount_cents
  if (body.amount_cents !== undefined) patch.amount_cents = body.amount_cents
  if (body.representment_date !== undefined) patch.representment_date = new Date(body.representment_date)

  const [updated] = await db.update(representments).set(patch).where(eq(representments.id, id)).returning()

  await db.insert(audit_logs).values({
    workspace_id: userId,
    actor: userId,
    action: 'update',
    entity_type: 'representment',
    entity_id: id,
    detail: { outcome: updated.outcome, recovered_amount_cents: updated.recovered_amount_cents },
  })

  return c.json(updated)
})

export default router
