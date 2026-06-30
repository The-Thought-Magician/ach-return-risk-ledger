import { Hono } from 'hono'
import { db } from '../db/index.js'
import { dispute_windows, originated_entries, audit_logs } from '../db/schema.js'
import { eq, and } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const WINDOW_DAYS = 60
const DAY_MS = 86_400_000

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS)
}

// Reclassify status against "now": open windows whose expiry has passed become expired.
function effectiveStatus(stored: string, expiry: Date, now: Date): string {
  if (stored === 'disputed') return 'disputed'
  return expiry.getTime() <= now.getTime() ? 'expired' : 'open'
}

// Public: list dispute windows (filter status)
router.get('/', async (c) => {
  const status = c.req.query('status')
  const originatorId = c.req.query('originator_id')
  const conds = []
  if (originatorId) conds.push(eq(dispute_windows.originator_id, originatorId))
  const rows = conds.length
    ? await db.select().from(dispute_windows).where(and(...conds))
    : await db.select().from(dispute_windows)

  const now = new Date()
  const enriched = rows.map((r) => ({
    ...r,
    status: effectiveStatus(r.status, r.window_expiry, now),
  }))
  enriched.sort((a, b) => a.window_expiry.getTime() - b.window_expiry.getTime())
  const filtered = status ? enriched.filter((r) => r.status === status) : enriched
  return c.json(filtered)
})

// Public: open-window dollar exposure summary
router.get('/exposure', async (c) => {
  const originatorId = c.req.query('originator_id')
  const rows = originatorId
    ? await db.select().from(dispute_windows).where(eq(dispute_windows.originator_id, originatorId))
    : await db.select().from(dispute_windows)

  const now = new Date()
  const soonCutoff = addDays(now, 14)
  let openCount = 0
  let openCents = 0
  let expiringSoon = 0
  let expiringSoonCents = 0
  for (const r of rows) {
    const status = effectiveStatus(r.status, r.window_expiry, now)
    if (status !== 'open') continue
    openCount += 1
    openCents += r.amount_cents ?? 0
    if (r.window_expiry.getTime() <= soonCutoff.getTime()) {
      expiringSoon += 1
      expiringSoonCents += r.amount_cents ?? 0
    }
  }
  return c.json({ openCount, openCents, expiringSoon, expiringSoonCents })
})

// Public: windows expiring within N days (query days)
router.get('/expiring', async (c) => {
  const daysRaw = parseInt(c.req.query('days') ?? '7', 10)
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 7
  const originatorId = c.req.query('originator_id')
  const rows = originatorId
    ? await db.select().from(dispute_windows).where(eq(dispute_windows.originator_id, originatorId))
    : await db.select().from(dispute_windows)

  const now = new Date()
  const cutoff = addDays(now, days)
  const expiring = rows
    .map((r) => ({ ...r, status: effectiveStatus(r.status, r.window_expiry, now) }))
    .filter(
      (r) =>
        r.status === 'open' &&
        r.window_expiry.getTime() >= now.getTime() &&
        r.window_expiry.getTime() <= cutoff.getTime(),
    )
    .sort((a, b) => a.window_expiry.getTime() - b.window_expiry.getTime())
  return c.json(expiring)
})

// Auth: rebuild dispute windows from originated debit entries
router.post('/rebuild', authMiddleware, async (c) => {
  const userId = getUserId(c)

  const debits = await db
    .select()
    .from(originated_entries)
    .where(and(eq(originated_entries.workspace_id, userId), eq(originated_entries.direction, 'debit')))

  const existing = await db.select().from(dispute_windows).where(eq(dispute_windows.workspace_id, userId))
  const existingByEntry = new Map(existing.map((w) => [w.originated_entry_id, w]))

  let built = 0
  for (const entry of debits) {
    const settlement = entry.settlement_date ?? entry.entry_date
    if (!settlement) continue
    const expiry = addDays(settlement, WINDOW_DAYS)
    if (existingByEntry.has(entry.id)) continue
    await db.insert(dispute_windows).values({
      workspace_id: userId,
      originator_id: entry.originator_id,
      originated_entry_id: entry.id,
      settlement_date: settlement,
      window_expiry: expiry,
      amount_cents: entry.amount_cents ?? 0,
      status: expiry.getTime() <= Date.now() ? 'expired' : 'open',
    })
    built += 1
  }

  await db.insert(audit_logs).values({
    workspace_id: userId,
    actor: userId,
    action: 'rebuild',
    entity_type: 'dispute_window',
    entity_id: null,
    detail: { built, debits_scanned: debits.length },
  })

  return c.json({ built })
})

export default router
