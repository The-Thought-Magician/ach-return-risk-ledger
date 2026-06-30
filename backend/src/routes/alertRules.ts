import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import { alert_rules, audit_logs } from '../db/schema.js'
import { eq, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const triggerTypes = ['rate_status', 'velocity_spike', 'letter_logged', 'exposure', 'days_to_breach'] as const
const severities = ['info', 'warning', 'critical'] as const
const targets = ['all', 'originator', 'grade'] as const

const createSchema = z.object({
  name: z.string().min(1),
  trigger_type: z.enum(triggerTypes),
  severity: z.enum(severities).optional().default('warning'),
  config: z.record(z.string(), z.unknown()).optional().default({}),
  target: z.enum(targets).optional().default('all'),
  target_value: z.string().nullable().optional(),
  enabled: z.boolean().optional().default(true),
})

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  trigger_type: z.enum(triggerTypes).optional(),
  severity: z.enum(severities).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  target: z.enum(targets).optional(),
  target_value: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
})

// Public: list alert rules
router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const rows = workspaceId
    ? await db.select().from(alert_rules).where(eq(alert_rules.workspace_id, workspaceId)).orderBy(desc(alert_rules.created_at))
    : await db.select().from(alert_rules).orderBy(desc(alert_rules.created_at))
  return c.json(rows)
})

// Public: rule detail
router.get('/:id', async (c) => {
  const [rule] = await db.select().from(alert_rules).where(eq(alert_rules.id, c.req.param('id')))
  if (!rule) return c.json({ error: 'Not found' }, 404)
  return c.json(rule)
})

// Auth: create rule
router.post('/', authMiddleware, zValidator('json', createSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')
  const [created] = await db
    .insert(alert_rules)
    .values({
      workspace_id: userId,
      name: body.name,
      trigger_type: body.trigger_type,
      severity: body.severity,
      config: body.config as Record<string, unknown>,
      target: body.target,
      target_value: body.target_value ?? null,
      enabled: body.enabled,
      created_by: userId,
    })
    .returning()

  await db.insert(audit_logs).values({
    workspace_id: userId,
    actor: userId,
    action: 'create',
    entity_type: 'alert_rule',
    entity_id: created.id,
    detail: { name: created.name, trigger_type: created.trigger_type },
  })

  return c.json(created, 201)
})

// Auth: update rule
router.put('/:id', authMiddleware, zValidator('json', updateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(alert_rules).where(eq(alert_rules.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const patch: Partial<typeof alert_rules.$inferInsert> = {}
  if (body.name !== undefined) patch.name = body.name
  if (body.trigger_type !== undefined) patch.trigger_type = body.trigger_type
  if (body.severity !== undefined) patch.severity = body.severity
  if (body.config !== undefined) patch.config = body.config as Record<string, unknown>
  if (body.target !== undefined) patch.target = body.target
  if (body.target_value !== undefined) patch.target_value = body.target_value
  if (body.enabled !== undefined) patch.enabled = body.enabled

  const [updated] = await db.update(alert_rules).set(patch).where(eq(alert_rules.id, id)).returning()

  await db.insert(audit_logs).values({
    workspace_id: userId,
    actor: userId,
    action: 'update',
    entity_type: 'alert_rule',
    entity_id: id,
    detail: { enabled: updated.enabled },
  })

  return c.json(updated)
})

// Auth: delete rule
router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(alert_rules).where(eq(alert_rules.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)

  await db.delete(alert_rules).where(eq(alert_rules.id, id))

  await db.insert(audit_logs).values({
    workspace_id: userId,
    actor: userId,
    action: 'delete',
    entity_type: 'alert_rule',
    entity_id: id,
    detail: { name: existing.name },
  })

  return c.json({ success: true })
})

export default router
