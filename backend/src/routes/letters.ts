import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import { warning_letters, originators, remediation_cases, audit_logs } from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function logAudit(
  workspaceId: string,
  actor: string,
  action: string,
  entityId: string | null,
  detail: Record<string, unknown>,
) {
  await db.insert(audit_logs).values({
    workspace_id: workspaceId,
    actor,
    action,
    entity_type: 'warning_letter',
    entity_id: entityId,
    detail,
  })
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

const LETTER_TYPES = ['warning', 'inquiry', 'nd_notification', 'suspension'] as const
const LETTER_STATUS = ['open', 'responded', 'closed'] as const

const createSchema = z.object({
  originator_id: z.string().min(1),
  letter_type: z.enum(LETTER_TYPES).optional().default('warning'),
  subject: z.string().min(1),
  body: z.string().optional().default(''),
  received_date: z.string().min(1),
  response_due_date: z.string().optional().nullable(),
  related_rate_type: z.string().optional().nullable(),
  status: z.enum(LETTER_STATUS).optional().default('open'),
})

const updateSchema = z.object({
  letter_type: z.enum(LETTER_TYPES).optional(),
  subject: z.string().min(1).optional(),
  body: z.string().optional(),
  received_date: z.string().optional(),
  response_due_date: z.string().optional().nullable(),
  related_rate_type: z.string().optional().nullable(),
  status: z.enum(LETTER_STATUS).optional(),
})

// ---------------------------------------------------------------------------
// GET / — warning letters (filter originator_id, status)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id') ?? c.req.header('X-User-Id') ?? c.req.header('x-user-id')
  const originatorId = c.req.query('originator_id')
  const status = c.req.query('status')
  const conds = []
  if (workspaceId) conds.push(eq(warning_letters.workspace_id, workspaceId))
  if (originatorId) conds.push(eq(warning_letters.originator_id, originatorId))
  if (status) conds.push(eq(warning_letters.status, status))
  const rows = await db
    .select()
    .from(warning_letters)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(warning_letters.received_date))

  // Decorate with response-due tracking (days remaining / overdue).
  const now = Date.now()
  const decorated = rows.map((l) => {
    let due_in_days: number | null = null
    let overdue = false
    if (l.response_due_date && l.status === 'open') {
      const ms = new Date(l.response_due_date).getTime() - now
      due_in_days = Math.ceil(ms / 86_400_000)
      overdue = ms < 0
    }
    return { ...l, due_in_days, overdue }
  })
  return c.json(decorated)
})

// ---------------------------------------------------------------------------
// GET /:id — letter detail
// ---------------------------------------------------------------------------

router.get('/:id', async (c) => {
  const [l] = await db.select().from(warning_letters).where(eq(warning_letters.id, c.req.param('id')))
  if (!l) return c.json({ error: 'Not found' }, 404)
  let originator = null
  const [o] = await db.select().from(originators).where(eq(originators.id, l.originator_id))
  originator = o ?? null
  const cases = await db.select().from(remediation_cases).where(eq(remediation_cases.letter_id, l.id))
  let due_in_days: number | null = null
  let overdue = false
  if (l.response_due_date && l.status === 'open') {
    const ms = new Date(l.response_due_date).getTime() - Date.now()
    due_in_days = Math.ceil(ms / 86_400_000)
    overdue = ms < 0
  }
  return c.json({ ...l, originator, cases, due_in_days, overdue })
})

// ---------------------------------------------------------------------------
// POST / — log letter
// ---------------------------------------------------------------------------

router.post('/', authMiddleware, zValidator('json', createSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')

  // Ownership: originator must belong to caller's workspace.
  const [org] = await db.select().from(originators).where(eq(originators.id, body.originator_id))
  if (!org) return c.json({ error: 'Originator not found' }, 404)
  if (org.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)

  const received = parseDate(body.received_date)
  if (!received) return c.json({ error: 'Invalid received_date' }, 400)
  const due = body.response_due_date ? parseDate(body.response_due_date) : null
  if (body.response_due_date && !due) return c.json({ error: 'Invalid response_due_date' }, 400)

  const [l] = await db
    .insert(warning_letters)
    .values({
      workspace_id: userId,
      originator_id: body.originator_id,
      letter_type: body.letter_type,
      subject: body.subject,
      body: body.body,
      received_date: received,
      response_due_date: due,
      related_rate_type: body.related_rate_type ?? null,
      status: body.status,
      created_by: userId,
    })
    .returning()
  await logAudit(userId, userId, 'create', l.id, { originator_id: l.originator_id, letter_type: l.letter_type })
  return c.json(l, 201)
})

// ---------------------------------------------------------------------------
// PUT /:id — update letter (status/response)
// ---------------------------------------------------------------------------

router.put('/:id', authMiddleware, zValidator('json', updateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(warning_letters).where(eq(warning_letters.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const patch: Record<string, unknown> = {}
  if (body.letter_type !== undefined) patch.letter_type = body.letter_type
  if (body.subject !== undefined) patch.subject = body.subject
  if (body.body !== undefined) patch.body = body.body
  if (body.related_rate_type !== undefined) patch.related_rate_type = body.related_rate_type
  if (body.status !== undefined) patch.status = body.status
  if (body.received_date !== undefined) {
    const d = parseDate(body.received_date)
    if (!d) return c.json({ error: 'Invalid received_date' }, 400)
    patch.received_date = d
  }
  if (body.response_due_date !== undefined) {
    if (body.response_due_date === null || body.response_due_date === '') {
      patch.response_due_date = null
    } else {
      const d = parseDate(body.response_due_date)
      if (!d) return c.json({ error: 'Invalid response_due_date' }, 400)
      patch.response_due_date = d
    }
  }

  const [updated] = await db.update(warning_letters).set(patch).where(eq(warning_letters.id, id)).returning()
  await logAudit(userId, userId, 'update', id, patch)
  return c.json(updated)
})

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------

router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(warning_letters).where(eq(warning_letters.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)
  await db.delete(warning_letters).where(eq(warning_letters.id, id))
  await logAudit(userId, userId, 'delete', id, {})
  return c.json({ success: true })
})

export default router
