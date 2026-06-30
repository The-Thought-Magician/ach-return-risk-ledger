import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import { saved_views, audit_logs } from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const viewSchema = z.object({
  name: z.string().min(1),
  scope: z.enum(['scorecards', 'entries', 'returns']).default('scorecards'),
  filters: z.record(z.string(), z.unknown()).optional().default({}),
})

// ---------------------------------------------------------------------------
// GET / — saved views for the current user, optionally filtered by scope.
// Scoped to the requesting user's workspace + user_id.
// ---------------------------------------------------------------------------
router.get('/', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json([])
  const scope = c.req.query('scope')

  const conditions = [eq(saved_views.workspace_id, userId), eq(saved_views.user_id, userId)]
  if (scope) conditions.push(eq(saved_views.scope, scope))

  const rows = await db
    .select()
    .from(saved_views)
    .where(and(...conditions))
    .orderBy(desc(saved_views.created_at))

  return c.json(rows)
})

// ---------------------------------------------------------------------------
// POST / — create a saved view (auth).
// ---------------------------------------------------------------------------
router.post('/', authMiddleware, zValidator('json', viewSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')

  const [view] = await db
    .insert(saved_views)
    .values({
      workspace_id: userId,
      user_id: userId,
      name: body.name,
      scope: body.scope,
      filters: body.filters as Record<string, unknown>,
    })
    .returning()

  await db.insert(audit_logs).values({
    workspace_id: userId,
    actor: userId,
    action: 'view.create',
    entity_type: 'saved_view',
    entity_id: view.id,
    detail: { name: view.name, scope: view.scope },
  })

  return c.json(view, 201)
})

// ---------------------------------------------------------------------------
// DELETE /:id — delete a saved view (auth + ownership).
// ---------------------------------------------------------------------------
router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')

  const [existing] = await db.select().from(saved_views).where(eq(saved_views.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId || existing.user_id !== userId) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  await db.delete(saved_views).where(eq(saved_views.id, id))

  await db.insert(audit_logs).values({
    workspace_id: userId,
    actor: userId,
    action: 'view.delete',
    entity_type: 'saved_view',
    entity_id: id,
    detail: { name: existing.name, scope: existing.scope },
  })

  return c.json({ success: true })
})

export default router
