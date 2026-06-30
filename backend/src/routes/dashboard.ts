import { Hono } from 'hono'
import { db } from '../db/index.js'
import {
  originators,
  rate_snapshots,
  dispute_windows,
  fee_records,
  forecasts,
  scorecards,
  alerts,
} from '../db/schema.js'
import { and, eq, isNull, desc, gte, inArray } from 'drizzle-orm'
import { getUserId } from '../lib/auth.js'

const router = new Hono()

// ---------------------------------------------------------------------------
// GET /summary — portfolio summary for the current workspace.
// Public read; scoped to the X-User-Id header (== workspace_id) when present.
// Returns: status counts, portfolio rates + status, open dispute exposure,
// fees this period, top at-risk originators, recent alerts, trend sparklines.
// ---------------------------------------------------------------------------
router.get('/summary', async (c) => {
  const workspaceId = getUserId(c)
  if (!workspaceId) {
    return c.json({
      statusCounts: { active: 0, onboarding: 0, suspended: 0, total: 0 },
      portfolioRates: null,
      exposure: { openCount: 0, openCents: 0, expiringSoon: 0 },
      feesPeriod: { totalCents: 0, count: 0, byType: {} },
      atRisk: [],
      recentAlerts: [],
      sparklines: { unauthorized: [], admin: [], overall: [] },
    })
  }

  // --- Originator status counts --------------------------------------------
  const orgs = await db
    .select()
    .from(originators)
    .where(eq(originators.workspace_id, workspaceId))

  const statusCounts = { active: 0, onboarding: 0, suspended: 0, total: orgs.length }
  for (const o of orgs) {
    if (o.status === 'active') statusCounts.active++
    else if (o.status === 'onboarding') statusCounts.onboarding++
    else if (o.status === 'suspended') statusCounts.suspended++
  }
  const orgNameById = new Map(orgs.map((o) => [o.id, o.name]))

  // --- Latest portfolio-wide rate snapshot (originator_id IS NULL) ----------
  const [portfolioRates] = await db
    .select()
    .from(rate_snapshots)
    .where(
      and(
        eq(rate_snapshots.workspace_id, workspaceId),
        isNull(rate_snapshots.originator_id),
      ),
    )
    .orderBy(desc(rate_snapshots.as_of))
    .limit(1)

  // --- Open dispute-window exposure -----------------------------------------
  const openWindows = await db
    .select()
    .from(dispute_windows)
    .where(
      and(
        eq(dispute_windows.workspace_id, workspaceId),
        eq(dispute_windows.status, 'open'),
      ),
    )
  let openCents = 0
  let expiringSoon = 0
  const now = Date.now()
  const soonCutoff = now + 14 * 24 * 60 * 60 * 1000
  for (const w of openWindows) {
    openCents += w.amount_cents ?? 0
    const expiry = new Date(w.window_expiry as unknown as string).getTime()
    if (expiry <= soonCutoff) expiringSoon++
  }
  const exposure = { openCount: openWindows.length, openCents, expiringSoon }

  // --- Fees this period (current calendar month) ----------------------------
  const periodStart = new Date()
  periodStart.setUTCDate(1)
  periodStart.setUTCHours(0, 0, 0, 0)
  const periodFees = await db
    .select()
    .from(fee_records)
    .where(
      and(
        eq(fee_records.workspace_id, workspaceId),
        gte(fee_records.incurred_at, periodStart),
      ),
    )
  let feesTotalCents = 0
  const feesByType: Record<string, number> = {}
  for (const f of periodFees) {
    feesTotalCents += f.amount_cents ?? 0
    feesByType[f.fee_type] = (feesByType[f.fee_type] ?? 0) + (f.amount_cents ?? 0)
  }
  const feesPeriod = {
    totalCents: feesTotalCents,
    count: periodFees.length,
    byType: feesByType,
  }

  // --- Top at-risk originators ----------------------------------------------
  // Combine latest per-originator rate snapshots, scorecards, and soonest
  // forecast breach to rank originators by risk.
  const orgIds = orgs.map((o) => o.id)

  const orgSnapshots = orgIds.length
    ? await db
        .select()
        .from(rate_snapshots)
        .where(
          and(
            eq(rate_snapshots.workspace_id, workspaceId),
            inArray(rate_snapshots.originator_id, orgIds),
          ),
        )
        .orderBy(desc(rate_snapshots.as_of))
    : []
  // Keep only the latest snapshot per originator.
  const latestSnapByOrg = new Map<string, (typeof orgSnapshots)[number]>()
  for (const s of orgSnapshots) {
    if (s.originator_id && !latestSnapByOrg.has(s.originator_id)) {
      latestSnapByOrg.set(s.originator_id, s)
    }
  }

  const orgScorecards = orgIds.length
    ? await db
        .select()
        .from(scorecards)
        .where(eq(scorecards.workspace_id, workspaceId))
    : []
  const scorecardByOrg = new Map(orgScorecards.map((s) => [s.originator_id, s]))

  const orgForecasts = orgIds.length
    ? await db
        .select()
        .from(forecasts)
        .where(eq(forecasts.workspace_id, workspaceId))
        .orderBy(desc(forecasts.computed_at))
    : []
  // Soonest days_to_breach per originator across all rate types.
  const soonestBreachByOrg = new Map<string, number>()
  for (const f of orgForecasts) {
    if (f.days_to_breach == null) continue
    const cur = soonestBreachByOrg.get(f.originator_id)
    if (cur == null || f.days_to_breach < cur) {
      soonestBreachByOrg.set(f.originator_id, f.days_to_breach)
    }
  }

  const statusRank: Record<string, number> = {
    breach: 4,
    warning: 3,
    watch: 2,
    clear: 1,
  }

  const atRisk = orgs
    .map((o) => {
      const snap = latestSnapByOrg.get(o.id)
      const sc = scorecardByOrg.get(o.id)
      const daysToBreach = soonestBreachByOrg.get(o.id) ?? null
      const worstStatus = snap
        ? [snap.unauthorized_status, snap.admin_status, snap.overall_status].reduce(
            (worst, s) => ((statusRank[s] ?? 0) > (statusRank[worst] ?? 0) ? s : worst),
            'clear',
          )
        : 'clear'
      // Risk score: status weight dominates, then composite score (inverted),
      // then proximity of breach.
      const statusWeight = (statusRank[worstStatus] ?? 0) * 1000
      const compositePenalty = sc ? (100 - sc.composite_score) : 0
      const breachPenalty =
        daysToBreach != null ? Math.max(0, 365 - daysToBreach) / 10 : 0
      const riskScore = statusWeight + compositePenalty + breachPenalty
      return {
        originatorId: o.id,
        name: o.name,
        status: o.status,
        worstStatus,
        unauthorizedRate: snap?.unauthorized_rate ?? 0,
        adminRate: snap?.admin_rate ?? 0,
        overallRate: snap?.overall_rate ?? 0,
        grade: sc?.grade ?? null,
        compositeScore: sc?.composite_score ?? null,
        daysToBreach,
        riskScore,
      }
    })
    .filter((r) => r.riskScore > 0)
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 10)

  // --- Recent alerts --------------------------------------------------------
  const recentAlertsRaw = await db
    .select()
    .from(alerts)
    .where(eq(alerts.workspace_id, workspaceId))
    .orderBy(desc(alerts.fired_at))
    .limit(10)
  const recentAlerts = recentAlertsRaw.map((a) => ({
    ...a,
    originatorName: a.originator_id ? orgNameById.get(a.originator_id) ?? null : null,
  }))

  // --- Trend sparklines (portfolio rate snapshots over time) ----------------
  const portfolioSnaps = await db
    .select()
    .from(rate_snapshots)
    .where(
      and(
        eq(rate_snapshots.workspace_id, workspaceId),
        isNull(rate_snapshots.originator_id),
      ),
    )
    .orderBy(desc(rate_snapshots.as_of))
    .limit(30)
  // Reverse to chronological order for sparkline rendering.
  const chronological = [...portfolioSnaps].reverse()
  const sparklines = {
    unauthorized: chronological.map((s) => ({
      as_of: s.as_of,
      value: s.unauthorized_rate,
    })),
    admin: chronological.map((s) => ({ as_of: s.as_of, value: s.admin_rate })),
    overall: chronological.map((s) => ({ as_of: s.as_of, value: s.overall_rate })),
  }

  return c.json({
    statusCounts,
    portfolioRates: portfolioRates ?? null,
    exposure,
    feesPeriod,
    atRisk,
    recentAlerts,
    sparklines,
  })
})

export default router
