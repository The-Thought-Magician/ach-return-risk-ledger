import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import { thresholds, threshold_history, audit_logs } from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// NACHA defaults: unauthorized 0.5%, administrative 3%, overall 15%.
const DEFAULTS = {
  unauthorized_limit: 0.5,
  admin_limit: 3.0,
  overall_limit: 15.0,
  watch_pct: 0.6,
  warning_pct: 0.8,
  window_days: 60,
}

// GET / — current workspace thresholds (defaults to NACHA 0.5/3/15 if none).
router.get('/', async (c) => {
  const workspaceId =
    c.req.header('X-User-Id') ?? c.req.header('x-user-id') ?? null
  if (!workspaceId) {
    return c.json({ workspace_id: null, ...DEFAULTS, is_default: true })
  }
  const [t] = await db
    .select()
    .from(thresholds)
    .where(eq(thresholds.workspace_id, workspaceId))
  if (!t) {
    return c.json({ workspace_id: workspaceId, ...DEFAULTS, is_default: true })
  }
  return c.json({ ...t, is_default: false })
})

// GET /history — threshold change history (newest first).
router.get('/history', async (c) => {
  const workspaceId =
    c.req.header('X-User-Id') ?? c.req.header('x-user-id') ?? null
  if (!workspaceId) return c.json([])
  const rows = await db
    .select()
    .from(threshold_history)
    .where(eq(threshold_history.workspace_id, workspaceId))
    .orderBy(desc(threshold_history.effective_at))
  return c.json(rows)
})

const thresholdSchema = z.object({
  unauthorized_limit: z.number().min(0).max(100).optional(),
  admin_limit: z.number().min(0).max(100).optional(),
  overall_limit: z.number().min(0).max(100).optional(),
  watch_pct: z.number().min(0).max(1).optional(),
  warning_pct: z.number().min(0).max(1).optional(),
  window_days: z.number().int().min(1).max(365).optional(),
})

// PUT / — upsert thresholds (writes threshold_history + audit).
router.put(
  '/',
  authMiddleware,
  zValidator('json', thresholdSchema),
  async (c) => {
    const userId = getUserId(c)
    const body = c.req.valid('json')
    const now = new Date()

    const [existing] = await db
      .select()
      .from(thresholds)
      .where(eq(thresholds.workspace_id, userId))

    const base = existing
      ? {
          unauthorized_limit: existing.unauthorized_limit,
          admin_limit: existing.admin_limit,
          overall_limit: existing.overall_limit,
          watch_pct: existing.watch_pct,
          warning_pct: existing.warning_pct,
          window_days: existing.window_days,
        }
      : { ...DEFAULTS }

    const merged = {
      unauthorized_limit: body.unauthorized_limit ?? base.unauthorized_limit,
      admin_limit: body.admin_limit ?? base.admin_limit,
      overall_limit: body.overall_limit ?? base.overall_limit,
      watch_pct: body.watch_pct ?? base.watch_pct,
      warning_pct: body.warning_pct ?? base.warning_pct,
      window_days: body.window_days ?? base.window_days,
    }

    let saved
    if (existing) {
      ;[saved] = await db
        .update(thresholds)
        .set({ ...merged, updated_at: now })
        .where(eq(thresholds.workspace_id, userId))
        .returning()
    } else {
      ;[saved] = await db
        .insert(thresholds)
        .values({
          workspace_id: userId,
          ...merged,
          created_by: userId,
          created_at: now,
          updated_at: now,
        })
        .returning()
    }

    // Record the new effective config in history.
    await db.insert(threshold_history).values({
      workspace_id: userId,
      ...merged,
      effective_at: now,
      changed_by: userId,
    })

    await db.insert(audit_logs).values({
      workspace_id: userId,
      actor: userId,
      action: existing ? 'update_thresholds' : 'create_thresholds',
      entity_type: 'threshold',
      entity_id: saved.id,
      detail: { from: base, to: merged },
    })

    return c.json({ ...saved, is_default: false })
  },
)

export default router
