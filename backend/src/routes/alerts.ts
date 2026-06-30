import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  alerts,
  alert_rules,
  originators,
  rate_snapshots,
  thresholds,
  forecasts,
  scorecards,
  dispute_windows,
  warning_letters,
  audit_logs,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RuleConfig = Record<string, unknown>

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

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
    entity_type: 'alert',
    entity_id: entityId,
    detail,
  })
}

// Latest rate snapshot per originator (and the portfolio snapshot) for a workspace.
async function latestSnapshots(workspaceId: string) {
  const rows = await db
    .select()
    .from(rate_snapshots)
    .where(eq(rate_snapshots.workspace_id, workspaceId))
    .orderBy(desc(rate_snapshots.as_of))
  const perOriginator = new Map<string, typeof rows[number]>()
  let portfolio: typeof rows[number] | undefined
  for (const r of rows) {
    if (r.originator_id === null) {
      if (!portfolio) portfolio = r
    } else if (!perOriginator.has(r.originator_id)) {
      perOriginator.set(r.originator_id, r)
    }
  }
  return { perOriginator, portfolio }
}

const STATUS_RANK: Record<string, number> = { clear: 0, watch: 1, warning: 2, breach: 3 }

// ---------------------------------------------------------------------------
// GET / — alert inbox (filter severity, status)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id') ?? c.req.header('X-User-Id') ?? c.req.header('x-user-id')
  const severity = c.req.query('severity')
  const status = c.req.query('status')
  const conds = []
  if (workspaceId) conds.push(eq(alerts.workspace_id, workspaceId))
  if (severity) conds.push(eq(alerts.severity, severity))
  if (status) conds.push(eq(alerts.status, status))
  const rows = await db
    .select()
    .from(alerts)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(alerts.fired_at))
  return c.json(rows)
})

// ---------------------------------------------------------------------------
// GET /:id — alert detail
// ---------------------------------------------------------------------------

router.get('/:id', async (c) => {
  const [a] = await db.select().from(alerts).where(eq(alerts.id, c.req.param('id')))
  if (!a) return c.json({ error: 'Not found' }, 404)
  let rule = null
  if (a.rule_id) {
    const [r] = await db.select().from(alert_rules).where(eq(alert_rules.id, a.rule_id))
    rule = r ?? null
  }
  let originator = null
  if (a.originator_id) {
    const [o] = await db.select().from(originators).where(eq(originators.id, a.originator_id))
    originator = o ?? null
  }
  return c.json({ ...a, rule, originator })
})

// ---------------------------------------------------------------------------
// POST /evaluate — evaluate all enabled rules now, fire alerts
// ---------------------------------------------------------------------------

router.post('/evaluate', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const now = new Date()

  const rules = await db
    .select()
    .from(alert_rules)
    .where(and(eq(alert_rules.workspace_id, userId), eq(alert_rules.enabled, true)))

  const orgs = await db.select().from(originators).where(eq(originators.workspace_id, userId))
  const orgById = new Map(orgs.map((o) => [o.id, o]))

  const [thr] = await db.select().from(thresholds).where(eq(thresholds.workspace_id, userId))
  const limits = {
    unauthorized: thr?.unauthorized_limit ?? 0.5,
    admin: thr?.admin_limit ?? 3.0,
    overall: thr?.overall_limit ?? 15.0,
  }

  const { perOriginator, portfolio } = await latestSnapshots(userId)

  const fired: typeof alerts.$inferSelect[] = []

  // Prevent duplicate firings: skip if an identical active alert already exists.
  const existingActive = await db
    .select()
    .from(alerts)
    .where(eq(alerts.workspace_id, userId))
  const activeKeys = new Set(
    existingActive
      .filter((a) => a.status === 'unread' || a.status === 'acknowledged')
      .map((a) => `${a.rule_id ?? ''}|${a.originator_id ?? ''}|${a.title}`),
  )

  async function fire(
    rule: typeof alert_rules.$inferSelect,
    originatorId: string | null,
    title: string,
    body: string,
    snapshot: Record<string, unknown>,
  ) {
    const key = `${rule.id}|${originatorId ?? ''}|${title}`
    if (activeKeys.has(key)) return
    activeKeys.add(key)
    const [a] = await db
      .insert(alerts)
      .values({
        workspace_id: userId,
        rule_id: rule.id,
        originator_id: originatorId,
        severity: rule.severity,
        title,
        body,
        snapshot,
        status: 'unread',
        fired_at: now,
      })
      .returning()
    fired.push(a)
  }

  // Resolve which originators a rule targets.
  function targetOriginatorIds(rule: typeof alert_rules.$inferSelect): string[] {
    if (rule.target === 'originator' && rule.target_value) {
      return orgs.filter((o) => o.id === rule.target_value).map((o) => o.id)
    }
    if (rule.target === 'grade' && rule.target_value) {
      // Filtered later against scorecards; default to all here, filtered below.
      return orgs.map((o) => o.id)
    }
    return orgs.map((o) => o.id)
  }

  // Pre-load scorecards for grade targeting.
  const cards = await db.select().from(scorecards).where(eq(scorecards.workspace_id, userId))
  const gradeByOrg = new Map(cards.map((s) => [s.originator_id, s.grade]))

  for (const rule of rules) {
    const cfg = (rule.config ?? {}) as RuleConfig

    if (rule.trigger_type === 'rate_status') {
      // Fire when any monitored rate reaches a configured minimum status.
      const minStatus = String(cfg.min_status ?? 'warning')
      const minRank = STATUS_RANK[minStatus] ?? 2
      for (const oid of targetOriginatorIds(rule)) {
        if (rule.target === 'grade' && rule.target_value && gradeByOrg.get(oid) !== rule.target_value) continue
        const snap = perOriginator.get(oid)
        if (!snap) continue
        const triggers: string[] = []
        if ((STATUS_RANK[snap.unauthorized_status] ?? 0) >= minRank) triggers.push(`unauthorized=${snap.unauthorized_status}`)
        if ((STATUS_RANK[snap.admin_status] ?? 0) >= minRank) triggers.push(`admin=${snap.admin_status}`)
        if ((STATUS_RANK[snap.overall_status] ?? 0) >= minRank) triggers.push(`overall=${snap.overall_status}`)
        if (triggers.length === 0) continue
        const org = orgById.get(oid)
        await fire(
          rule,
          oid,
          `${org?.name ?? 'Originator'}: rate status ${triggers.join(', ')}`,
          `Rate status threshold (>= ${minStatus}) reached for ${org?.name ?? oid}: ${triggers.join('; ')}.`,
          {
            unauthorized_rate: snap.unauthorized_rate,
            admin_rate: snap.admin_rate,
            overall_rate: snap.overall_rate,
            unauthorized_status: snap.unauthorized_status,
            admin_status: snap.admin_status,
            overall_status: snap.overall_status,
          },
        )
      }
    } else if (rule.trigger_type === 'velocity_spike') {
      // Fire when a forecast velocity exceeds a configured per-day threshold.
      const minVelocity = num(cfg.min_velocity_per_day, 0.05)
      const fcasts = await db.select().from(forecasts).where(eq(forecasts.workspace_id, userId)).orderBy(desc(forecasts.computed_at))
      const seen = new Set<string>()
      for (const f of fcasts) {
        const fkey = `${f.originator_id}|${f.rate_type}|${f.model}`
        if (seen.has(fkey)) continue
        seen.add(fkey)
        if (rule.target === 'originator' && rule.target_value && f.originator_id !== rule.target_value) continue
        if (rule.target === 'grade' && rule.target_value && gradeByOrg.get(f.originator_id) !== rule.target_value) continue
        if (f.velocity_per_day < minVelocity) continue
        const org = orgById.get(f.originator_id)
        await fire(
          rule,
          f.originator_id,
          `${org?.name ?? 'Originator'}: ${f.rate_type} velocity spike`,
          `${f.rate_type} rate is rising at ${f.velocity_per_day.toFixed(4)}/day (>= ${minVelocity}). Projected days to breach: ${f.days_to_breach ?? 'n/a'}.`,
          { rate_type: f.rate_type, velocity_per_day: f.velocity_per_day, days_to_breach: f.days_to_breach, model: f.model },
        )
      }
    } else if (rule.trigger_type === 'days_to_breach') {
      // Fire when projected days-to-breach falls under a configured horizon.
      const maxDays = num(cfg.max_days, 30)
      const fcasts = await db.select().from(forecasts).where(eq(forecasts.workspace_id, userId)).orderBy(desc(forecasts.computed_at))
      const seen = new Set<string>()
      for (const f of fcasts) {
        const fkey = `${f.originator_id}|${f.rate_type}|${f.model}`
        if (seen.has(fkey)) continue
        seen.add(fkey)
        if (rule.target === 'originator' && rule.target_value && f.originator_id !== rule.target_value) continue
        if (rule.target === 'grade' && rule.target_value && gradeByOrg.get(f.originator_id) !== rule.target_value) continue
        if (f.days_to_breach === null || f.days_to_breach === undefined) continue
        if (f.days_to_breach > maxDays) continue
        const org = orgById.get(f.originator_id)
        await fire(
          rule,
          f.originator_id,
          `${org?.name ?? 'Originator'}: ${f.rate_type} breach in ${f.days_to_breach}d`,
          `${f.rate_type} rate projected to breach in ${f.days_to_breach} day(s) (<= ${maxDays}).`,
          { rate_type: f.rate_type, days_to_breach: f.days_to_breach, projected_breach_date: f.projected_breach_date },
        )
      }
    } else if (rule.trigger_type === 'exposure') {
      // Fire when open dispute-window exposure exceeds a configured dollar amount.
      const minCents = num(cfg.min_cents, 0)
      const openWindows = await db
        .select()
        .from(dispute_windows)
        .where(and(eq(dispute_windows.workspace_id, userId), eq(dispute_windows.status, 'open')))
      const byOrg = new Map<string, number>()
      let total = 0
      for (const w of openWindows) {
        total += w.amount_cents
        byOrg.set(w.originator_id, (byOrg.get(w.originator_id) ?? 0) + w.amount_cents)
      }
      if (rule.target === 'all') {
        if (total >= minCents && total > 0) {
          await fire(
            rule,
            null,
            `Portfolio open exposure $${(total / 100).toFixed(2)}`,
            `Open dispute-window exposure of $${(total / 100).toFixed(2)} exceeds threshold $${(minCents / 100).toFixed(2)}.`,
            { open_cents: total, open_count: openWindows.length },
          )
        }
      } else {
        for (const [oid, cents] of byOrg) {
          if (rule.target === 'originator' && rule.target_value && oid !== rule.target_value) continue
          if (rule.target === 'grade' && rule.target_value && gradeByOrg.get(oid) !== rule.target_value) continue
          if (cents < minCents || cents <= 0) continue
          const org = orgById.get(oid)
          await fire(
            rule,
            oid,
            `${org?.name ?? 'Originator'}: open exposure $${(cents / 100).toFixed(2)}`,
            `Open dispute-window exposure of $${(cents / 100).toFixed(2)} exceeds threshold $${(minCents / 100).toFixed(2)}.`,
            { open_cents: cents },
          )
        }
      }
    } else if (rule.trigger_type === 'letter_logged') {
      // Fire for open warning letters not yet alerted.
      const openLetters = await db
        .select()
        .from(warning_letters)
        .where(and(eq(warning_letters.workspace_id, userId), eq(warning_letters.status, 'open')))
      for (const l of openLetters) {
        if (rule.target === 'originator' && rule.target_value && l.originator_id !== rule.target_value) continue
        if (rule.target === 'grade' && rule.target_value && gradeByOrg.get(l.originator_id) !== rule.target_value) continue
        const org = orgById.get(l.originator_id)
        // Key on the letter id so each letter only fires once per rule.
        const key = `${rule.id}|${l.originator_id}|letter:${l.id}`
        if (activeKeys.has(key)) continue
        activeKeys.add(key)
        const [a] = await db
          .insert(alerts)
          .values({
            workspace_id: userId,
            rule_id: rule.id,
            originator_id: l.originator_id,
            severity: rule.severity,
            title: `${org?.name ?? 'Originator'}: ${l.letter_type} letter — ${l.subject}`,
            body: `Open ${l.letter_type} letter logged${l.response_due_date ? `, response due ${new Date(l.response_due_date).toISOString().slice(0, 10)}` : ''}.`,
            snapshot: { letter_id: l.id, letter_type: l.letter_type, response_due_date: l.response_due_date },
            status: 'unread',
            fired_at: now,
          })
          .returning()
        fired.push(a)
      }
    }
  }

  await logAudit(userId, userId, 'evaluate', null, { rules: rules.length, fired: fired.length })
  return c.json({ fired: fired.length, alerts: fired })
})

// ---------------------------------------------------------------------------
// POST /:id/acknowledge
// ---------------------------------------------------------------------------

router.post('/:id/acknowledge', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(alerts).where(eq(alerts.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)
  const [updated] = await db
    .update(alerts)
    .set({ status: 'acknowledged' })
    .where(eq(alerts.id, id))
    .returning()
  await logAudit(userId, userId, 'acknowledge', id, {})
  return c.json(updated)
})

// ---------------------------------------------------------------------------
// POST /:id/snooze — body: until
// ---------------------------------------------------------------------------

const snoozeSchema = z.object({ until: z.string().min(1) })

router.post('/:id/snooze', authMiddleware, zValidator('json', snoozeSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const { until } = c.req.valid('json')
  const untilDate = new Date(until)
  if (Number.isNaN(untilDate.getTime())) return c.json({ error: 'Invalid until date' }, 400)
  const [existing] = await db.select().from(alerts).where(eq(alerts.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)
  const [updated] = await db
    .update(alerts)
    .set({ status: 'snoozed', snoozed_until: untilDate })
    .where(eq(alerts.id, id))
    .returning()
  await logAudit(userId, userId, 'snooze', id, { until: untilDate.toISOString() })
  return c.json(updated)
})

// ---------------------------------------------------------------------------
// POST /:id/read — mark read
// ---------------------------------------------------------------------------

router.post('/:id/read', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(alerts).where(eq(alerts.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.workspace_id !== userId) return c.json({ error: 'Forbidden' }, 403)
  const [updated] = await db
    .update(alerts)
    .set({ status: 'read' })
    .where(eq(alerts.id, id))
    .returning()
  await logAudit(userId, userId, 'read', id, {})
  return c.json(updated)
})

export default router
