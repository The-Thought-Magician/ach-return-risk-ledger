import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  fee_records,
  originators,
  return_entries,
  representments,
  audit_logs,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// ---------------------------------------------------------------------------
// GET / — fee records (filter originator_id, fee_type)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = getUserId(c)
  const originatorId = c.req.query('originator_id')
  const feeType = c.req.query('fee_type')

  const conds = [eq(fee_records.workspace_id, workspaceId)]
  if (originatorId) conds.push(eq(fee_records.originator_id, originatorId))
  if (feeType) conds.push(eq(fee_records.fee_type, feeType))

  const rows = await db
    .select()
    .from(fee_records)
    .where(and(...conds))
    .orderBy(desc(fee_records.incurred_at))

  return c.json(rows)
})

// ---------------------------------------------------------------------------
// GET /summary — economics roll-up per originator (fees vs recovered)
// ---------------------------------------------------------------------------

router.get('/summary', async (c) => {
  const workspaceId = getUserId(c)

  const owned = await db
    .select()
    .from(originators)
    .where(eq(originators.workspace_id, workspaceId))

  const fees = await db
    .select()
    .from(fee_records)
    .where(eq(fee_records.workspace_id, workspaceId))

  const reps = await db
    .select()
    .from(representments)
    .where(eq(representments.workspace_id, workspaceId))

  const nameById = new Map(owned.map((o) => [o.id, o.name]))

  interface Row {
    originator_id: string
    originator_name: string
    fee_count: number
    total_fees_cents: number
    return_fees_cents: number
    nsf_fees_cents: number
    representment_fees_cents: number
    recovered_cents: number
    net_cents: number
  }
  const map = new Map<string, Row>()

  function ensure(id: string): Row {
    let r = map.get(id)
    if (!r) {
      r = {
        originator_id: id,
        originator_name: nameById.get(id) ?? id,
        fee_count: 0,
        total_fees_cents: 0,
        return_fees_cents: 0,
        nsf_fees_cents: 0,
        representment_fees_cents: 0,
        recovered_cents: 0,
        net_cents: 0,
      }
      map.set(id, r)
    }
    return r
  }

  // Seed all owned originators so zero-fee ones still appear.
  for (const o of owned) ensure(o.id)

  for (const f of fees) {
    const r = ensure(f.originator_id)
    r.fee_count += 1
    r.total_fees_cents += f.amount_cents ?? 0
    if (f.fee_type === 'return') r.return_fees_cents += f.amount_cents ?? 0
    else if (f.fee_type === 'nsf') r.nsf_fees_cents += f.amount_cents ?? 0
    else if (f.fee_type === 'representment') r.representment_fees_cents += f.amount_cents ?? 0
  }

  for (const rep of reps) {
    const r = ensure(rep.originator_id)
    r.recovered_cents += rep.recovered_amount_cents ?? 0
  }

  for (const r of map.values()) {
    // Net economics: recovered dollars minus fees paid.
    r.net_cents = r.recovered_cents - r.total_fees_cents
  }

  const rows = [...map.values()].sort((a, b) => b.total_fees_cents - a.total_fees_cents)

  const portfolio = rows.reduce(
    (acc, r) => {
      acc.total_fees_cents += r.total_fees_cents
      acc.recovered_cents += r.recovered_cents
      acc.fee_count += r.fee_count
      return acc
    },
    { total_fees_cents: 0, recovered_cents: 0, fee_count: 0, net_cents: 0 },
  )
  portfolio.net_cents = portfolio.recovered_cents - portfolio.total_fees_cents

  return c.json({ rows, portfolio })
})

// ---------------------------------------------------------------------------
// POST / — create fee record
// ---------------------------------------------------------------------------

const feeSchema = z.object({
  originator_id: z.string().min(1),
  return_entry_id: z.string().min(1).optional(),
  fee_type: z.enum(['return', 'nsf', 'representment']).optional().default('return'),
  amount_cents: z.number().int().min(0),
  incurred_at: z.string().datetime().optional(),
})

router.post('/', authMiddleware, zValidator('json', feeSchema), async (c) => {
  const workspaceId = getUserId(c)
  const body = c.req.valid('json')

  // Ownership: originator must belong to this workspace.
  const [o] = await db
    .select()
    .from(originators)
    .where(and(eq(originators.id, body.originator_id), eq(originators.workspace_id, workspaceId)))
  if (!o) return c.json({ error: 'Originator not found' }, 404)

  // If linked to a return, that return must belong to this workspace too.
  if (body.return_entry_id) {
    const [re] = await db
      .select()
      .from(return_entries)
      .where(
        and(
          eq(return_entries.id, body.return_entry_id),
          eq(return_entries.workspace_id, workspaceId),
        ),
      )
    if (!re) return c.json({ error: 'Return entry not found' }, 404)
  }

  const [row] = await db
    .insert(fee_records)
    .values({
      workspace_id: workspaceId,
      originator_id: body.originator_id,
      return_entry_id: body.return_entry_id ?? null,
      fee_type: body.fee_type,
      amount_cents: body.amount_cents,
      incurred_at: body.incurred_at ? new Date(body.incurred_at) : new Date(),
      created_by: workspaceId,
    })
    .returning()

  await db.insert(audit_logs).values({
    workspace_id: workspaceId,
    actor: workspaceId,
    action: 'fees.create',
    entity_type: 'fee_record',
    entity_id: row.id,
    detail: {
      originator_id: row.originator_id,
      fee_type: row.fee_type,
      amount_cents: row.amount_cents,
    },
  })

  return c.json(row, 201)
})

// ---------------------------------------------------------------------------
// DELETE /:id — delete fee record
// ---------------------------------------------------------------------------

router.delete('/:id', authMiddleware, async (c) => {
  const workspaceId = getUserId(c)
  const id = c.req.param('id')

  const [existing] = await db.select().from(fee_records).where(eq(fee_records.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== workspaceId) return c.json({ error: 'Forbidden' }, 403)

  await db.delete(fee_records).where(eq(fee_records.id, id))

  await db.insert(audit_logs).values({
    workspace_id: workspaceId,
    actor: workspaceId,
    action: 'fees.delete',
    entity_type: 'fee_record',
    entity_id: id,
    detail: { originator_id: existing.originator_id },
  })

  return c.json({ success: true })
})

export default router
