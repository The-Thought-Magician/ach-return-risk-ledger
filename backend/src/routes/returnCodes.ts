import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import { return_codes, return_entries, audit_logs } from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// Resolve the effective category for a code given the requesting workspace.
// A workspace override only applies to the workspace that set it.
function effectiveCode(
  row: typeof return_codes.$inferSelect,
  workspaceId: string | null,
) {
  const overridden =
    !!workspaceId &&
    row.workspace_override === workspaceId &&
    !!row.override_category
  return {
    ...row,
    effective_category: overridden ? row.override_category! : row.category,
    is_overridden: overridden,
  }
}

// GET / — NACHA code dictionary with workspace overrides applied.
// Public read; workspace context (optional) comes from X-User-Id if present.
router.get('/', async (c) => {
  const workspaceId =
    c.req.header('X-User-Id') ?? c.req.header('x-user-id') ?? null
  const rows = await db.select().from(return_codes).orderBy(return_codes.code)
  return c.json(rows.map((r) => effectiveCode(r, workspaceId)))
})

// GET /:code — single code + the return entries (scoped to workspace) using it.
router.get('/:code', async (c) => {
  const code = c.req.param('code').toUpperCase()
  const workspaceId =
    c.req.header('X-User-Id') ?? c.req.header('x-user-id') ?? null
  const [row] = await db
    .select()
    .from(return_codes)
    .where(eq(return_codes.code, code))
  if (!row) return c.json({ error: 'Not found' }, 404)

  const entries = workspaceId
    ? await db
        .select()
        .from(return_entries)
        .where(
          and(
            eq(return_entries.return_code, code),
            eq(return_entries.workspace_id, workspaceId),
          ),
        )
        .orderBy(desc(return_entries.return_date))
    : await db
        .select()
        .from(return_entries)
        .where(eq(return_entries.return_code, code))
        .orderBy(desc(return_entries.return_date))

  return c.json({ code: effectiveCode(row, workspaceId), entries })
})

const reclassifySchema = z.object({
  category: z.enum(['unauthorized', 'administrative', 'other']),
})

// PUT /:code/reclassify — set workspace override category (audited).
router.put(
  '/:code/reclassify',
  authMiddleware,
  zValidator('json', reclassifySchema),
  async (c) => {
    const userId = getUserId(c)
    const code = c.req.param('code').toUpperCase()
    const { category } = c.req.valid('json')

    const [row] = await db
      .select()
      .from(return_codes)
      .where(eq(return_codes.code, code))
    if (!row) return c.json({ error: 'Not found' }, 404)

    const [updated] = await db
      .update(return_codes)
      .set({ workspace_override: userId, override_category: category })
      .where(eq(return_codes.code, code))
      .returning()

    await db.insert(audit_logs).values({
      workspace_id: userId,
      actor: userId,
      action: 'reclassify_return_code',
      entity_type: 'return_code',
      entity_id: row.id,
      detail: {
        code,
        from: row.override_category ?? row.category,
        to: category,
      },
    })

    return c.json(effectiveCode(updated, userId))
  },
)

export default router
