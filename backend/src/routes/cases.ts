import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  remediation_cases,
  case_actions,
  originators,
  warning_letters,
  audit_logs,
} from '../db/schema.js'
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
  })
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

type CaseNote = { at: string; by: string; text: string }

const CASE_STATUS = ['open', 'in_progress', 'monitoring', 'resolved'] as const
const CASE_PRIORITY = ['low', 'medium', 'high'] as const

const createSchema = z.object({
  originator_id: z.string().min(1),
  letter_id: z.string().optional().nullable(),
  title: z.string().min(1),
  description: z.string().optional().default(''),
  status: z.enum(CASE_STATUS).optional().default('open'),
  priority: z.enum(CASE_PRIORITY).optional().default('medium'),
})

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(CASE_STATUS).optional(),
  priority: z.enum(CASE_PRIORITY).optional(),
  letter_id: z.string().optional().nullable(),
  note: z.string().min(1).optional(), // appended to notes[]
})

const actionCreateSchema = z.object({
  title: z.string().min(1),
  done: z.boolean().optional().default(false),
  due_date: z.string().optional().nullable(),
  assigned_to: z.string().optional().nullable(),
})

const actionUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  done: z.boolean().optional(),
  due_date: z.string().optional().nullable(),
  assigned_to: z.string().optional().nullable(),
})

// ---------------------------------------------------------------------------
// GET / — remediation cases (filter status, originator_id)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id') ?? c.req.header('X-User-Id') ?? c.req.header('x-user-id')
  const status = c.req.query('status')
  const originatorId = c.req.query('originator_id')
  const conds = []
  if (workspaceId) conds.push(eq(remediation_cases.workspace_id, workspaceId))
  if (status) conds.push(eq(remediation_cases.status, status))
  if (originatorId) conds.push(eq(remediation_cases.originator_id, originatorId))
  const rows = await db
    .select()
    .from(remediation_cases)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(remediation_cases.created_at))

  // Decorate each case with action progress counts.
  const ids = rows.map((r) => r.id)
  const actionCounts = new Map<string, { total: number; done: number }>()
  if (ids.length) {
    const allActions = await db
      .select()
      .from(case_actions)
      .where(workspaceId ? eq(case_actions.workspace_id, workspaceId) : undefined)
    for (const a of allActions) {
      if (!ids.includes(a.case_id)) continue
      const cur = actionCounts.get(a.case_id) ?? { total: 0, done: 0 }
      cur.total += 1
      if (a.done) cur.done += 1
      actionCounts.set(a.case_id, cur)
    }
  }
  const decorated = rows.map((r) => ({
    ...r,
    action_total: actionCounts.get(r.id)?.total ?? 0,
    action_done: actionCounts.get(r.id)?.done ?? 0,
  }))
  return c.json(decorated)
})

// ---------------------------------------------------------------------------
// GET /:id — case detail with actions
// ---------------------------------------------------------------------------

router.get('/:id', async (c) => {
  const [cs] = await db.select().from(remediation_cases).where(eq(remediation_cases.id, c.req.param('id')))
  if (!cs) return c.json({ error: 'Not found' }, 404)
  const actions = await db
    .select()
    .from(case_actions)
    .where(eq(case_actions.case_id, cs.id))
    .orderBy(case_actions.created_at)
  let originator = null
  const [o] = await db.select().from(originators).where(eq(originators.id, cs.originator_id))
  originator = o ?? null
  let letter = null
  if (cs.letter_id) {
    const [l] = await db.select().from(warning_letters).where(eq(warning_letters.id, cs.letter_id))
    letter = l ?? null
  }
  return c.json({ case: { ...cs, originator, letter }, actions })
})

// ---------------------------------------------------------------------------
// POST / — open case
// ---------------------------------------------------------------------------

router.post('/', authMiddleware, zValidator('json', createSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')

  const [org] = await db.select().from(originators).where(eq(originators.id, body.originator_id))
  if (!org) return c.json({ error: 'Originator not found' }, 404)
  if (org.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)

  if (body.letter_id) {
    const [l] = await db.select().from(warning_letters).where(eq(warning_letters.id, body.letter_id))
    if (!l) return c.json({ error: 'Letter not found' }, 404)
    if (l.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)
  }

  const [cs] = await db
    .insert(remediation_cases)
    .values({
      workspace_id: userId,
      originator_id: body.originator_id,
      letter_id: body.letter_id ?? null,
      title: body.title,
      description: body.description,
      status: body.status,
      priority: body.priority,
      notes: [],
      created_by: userId,
    })
    .returning()
  await logAudit(userId, userId, 'create', 'remediation_case', cs.id, { originator_id: cs.originator_id, title: cs.title })
  return c.json(cs, 201)
})

// ---------------------------------------------------------------------------
// PUT /:id — update case (status/priority/notes append)
// ---------------------------------------------------------------------------

router.put('/:id', authMiddleware, zValidator('json', updateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(remediation_cases).where(eq(remediation_cases.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const patch: Record<string, unknown> = { updated_at: new Date() }
  if (body.title !== undefined) patch.title = body.title
  if (body.description !== undefined) patch.description = body.description
  if (body.status !== undefined) patch.status = body.status
  if (body.priority !== undefined) patch.priority = body.priority
  if (body.letter_id !== undefined) {
    if (body.letter_id) {
      const [l] = await db.select().from(warning_letters).where(eq(warning_letters.id, body.letter_id))
      if (!l) return c.json({ error: 'Letter not found' }, 404)
      if (l.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)
    }
    patch.letter_id = body.letter_id || null
  }
  if (body.note !== undefined) {
    const notes: CaseNote[] = Array.isArray(existing.notes) ? (existing.notes as CaseNote[]) : []
    patch.notes = [...notes, { at: new Date().toISOString(), by: userId, text: body.note }]
  }

  const [updated] = await db.update(remediation_cases).set(patch).where(eq(remediation_cases.id, id)).returning()
  await logAudit(userId, userId, 'update', 'remediation_case', id, {
    status: body.status,
    priority: body.priority,
    note_appended: body.note !== undefined,
  })
  return c.json(updated)
})

// ---------------------------------------------------------------------------
// POST /:id/actions — add action item
// ---------------------------------------------------------------------------

router.post('/:id/actions', authMiddleware, zValidator('json', actionCreateSchema), async (c) => {
  const userId = getUserId(c)
  const caseId = c.req.param('id')
  const [cs] = await db.select().from(remediation_cases).where(eq(remediation_cases.id, caseId))
  if (!cs) return c.json({ error: 'Case not found' }, 404)
  if (cs.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  let due: Date | null = null
  if (body.due_date) {
    due = parseDate(body.due_date)
    if (!due) return c.json({ error: 'Invalid due_date' }, 400)
  }

  const [action] = await db
    .insert(case_actions)
    .values({
      workspace_id: userId,
      case_id: caseId,
      title: body.title,
      done: body.done,
      due_date: due,
      assigned_to: body.assigned_to ?? null,
      created_by: userId,
    })
    .returning()
  await db.update(remediation_cases).set({ updated_at: new Date() }).where(eq(remediation_cases.id, caseId))
  await logAudit(userId, userId, 'create', 'case_action', action.id, { case_id: caseId, title: action.title })
  return c.json(action, 201)
})

// ---------------------------------------------------------------------------
// PUT /:id/actions/:actionId — toggle/update action
// ---------------------------------------------------------------------------

router.put('/:id/actions/:actionId', authMiddleware, zValidator('json', actionUpdateSchema), async (c) => {
  const userId = getUserId(c)
  const caseId = c.req.param('id')
  const actionId = c.req.param('actionId')
  const [cs] = await db.select().from(remediation_cases).where(eq(remediation_cases.id, caseId))
  if (!cs) return c.json({ error: 'Case not found' }, 404)
  if (cs.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)
  const [existing] = await db.select().from(case_actions).where(eq(case_actions.id, actionId))
  if (!existing || existing.case_id !== caseId) return c.json({ error: 'Action not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const patch: Record<string, unknown> = {}
  if (body.title !== undefined) patch.title = body.title
  if (body.done !== undefined) patch.done = body.done
  if (body.assigned_to !== undefined) patch.assigned_to = body.assigned_to || null
  if (body.due_date !== undefined) {
    if (body.due_date === null || body.due_date === '') {
      patch.due_date = null
    } else {
      const d = parseDate(body.due_date)
      if (!d) return c.json({ error: 'Invalid due_date' }, 400)
      patch.due_date = d
    }
  }

  const [updated] = await db.update(case_actions).set(patch).where(eq(case_actions.id, actionId)).returning()
  await db.update(remediation_cases).set({ updated_at: new Date() }).where(eq(remediation_cases.id, caseId))
  await logAudit(userId, userId, 'update', 'case_action', actionId, patch)
  return c.json(updated)
})

export default router
