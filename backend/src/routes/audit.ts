import { Hono } from 'hono'
import { db } from '../db/index.js'
import { audit_logs } from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { getUserId } from '../lib/auth.js'

const router = new Hono()

// ---------------------------------------------------------------------------
// GET / — append-only audit log read, scoped to the requesting workspace.
// Filters: entity_type, entity_id, action; limit (default 200, max 1000).
// ---------------------------------------------------------------------------
router.get('/', async (c) => {
  const ws = getUserId(c)
  if (!ws) return c.json([])

  const entityType = c.req.query('entity_type')
  const entityId = c.req.query('entity_id')
  const action = c.req.query('action')
  const limitRaw = parseInt(c.req.query('limit') ?? '200', 10)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 1000)) : 200

  const conditions = [eq(audit_logs.workspace_id, ws)]
  if (entityType) conditions.push(eq(audit_logs.entity_type, entityType))
  if (entityId) conditions.push(eq(audit_logs.entity_id, entityId))
  if (action) conditions.push(eq(audit_logs.action, action))

  const rows = await db
    .select()
    .from(audit_logs)
    .where(and(...conditions))
    .orderBy(desc(audit_logs.created_at))
    .limit(limit)

  return c.json(rows)
})

export default router
