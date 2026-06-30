# ACH Return Risk Ledger — Build Plan (Authoritative Build Contract)

This is the single source of truth. Every filename, mount path, api method name, and page file declared here is binding. Stack per `_template-report.md`: Hono 4.12.27 backend, drizzle-orm 0.45.2 + @neondatabase/serverless on Neon, Next.js 16 + React 19 + Tailwind 4 frontend, auth via `@neondatabase/auth@0.4.2-beta`. Web uses `proxy.ts` only. Backend trusts `X-User-Id` via `getUserId(c)`. Routes mount under `/api/v1` via a child Hono `api` router. Frontend calls `fetch('/api/proxy/<path>')` mapping 1:1 to `/api/v1/<path>`.

Conventions:
- All app tables carry `workspace_id` (== owning user id) for scoping; ownership checks compare `workspace_id`/`created_by` to `getUserId(c)`.
- Public reads, auth-gated writes with zod validation.
- Every domain route file does `export default router`.
- Each api method maps to exactly one endpoint; each endpoint is consumed by at least one page.

---

## (a) Tables

| Table | Key columns |
|-------|-------------|
| `originators` | id, workspace_id, name, company_id, odfi_name, routing_number, mcc, expected_monthly_volume, status, metadata(jsonb), created_by, created_at, updated_at |
| `originated_entries` | id, workspace_id, originator_id→originators, entry_date, settlement_date, direction, sec_code, amount_cents, trace_number, external_ref, created_by, created_at |
| `return_entries` | id, workspace_id, originator_id→originators, originated_entry_id→originated_entries, return_code, category, return_date, amount_cents, is_late, matched, external_ref, created_by, created_at |
| `return_codes` | id, code(unique), description, category, consumer, workspace_override, override_category, created_at |
| `rate_snapshots` | id, workspace_id, originator_id→originators(nullable=portfolio), window_days, as_of, debit_count, total_returns, unauthorized_rate, admin_rate, overall_rate, unauthorized_status, admin_status, overall_status, created_at |
| `thresholds` | id, workspace_id(unique), unauthorized_limit, admin_limit, overall_limit, watch_pct, warning_pct, window_days, created_by, created_at, updated_at |
| `threshold_history` | id, workspace_id, unauthorized_limit, admin_limit, overall_limit, watch_pct, warning_pct, window_days, effective_at, changed_by, created_at |
| `forecasts` | id, workspace_id, originator_id→originators, rate_type, model, current_rate, velocity_per_day, projected_breach_date, days_to_breach, confidence, computed_at, created_at |
| `scorecards` | id, workspace_id, originator_id→originators, composite_score, grade, headroom_score, velocity_score, volume_score, representment_score, percentile, computed_at, created_at; UNIQUE(workspace_id, originator_id) |
| `fee_records` | id, workspace_id, originator_id→originators, return_entry_id→return_entries, fee_type, amount_cents, incurred_at, created_by, created_at |
| `representments` | id, workspace_id, originator_id→originators, return_entry_id→return_entries, attempt_number, representment_date, amount_cents, outcome, recovered_amount_cents, created_by, created_at |
| `dispute_windows` | id, workspace_id, originator_id→originators, originated_entry_id→originated_entries, settlement_date, window_expiry, amount_cents, status, created_at; UNIQUE(originated_entry_id) |
| `alert_rules` | id, workspace_id, name, trigger_type, severity, config(jsonb), target, target_value, enabled, created_by, created_at |
| `alerts` | id, workspace_id, rule_id→alert_rules, originator_id→originators, severity, title, body, snapshot(jsonb), status, snoozed_until, fired_at, created_at |
| `warning_letters` | id, workspace_id, originator_id→originators, letter_type, subject, body, received_date, response_due_date, related_rate_type, status, created_by, created_at |
| `remediation_cases` | id, workspace_id, originator_id→originators, letter_id→warning_letters, title, description, status, priority, notes(jsonb), created_by, created_at, updated_at |
| `case_actions` | id, workspace_id, case_id→remediation_cases, title, done, due_date, assigned_to, created_by, created_at |
| `imports` | id, workspace_id, kind, filename, row_count, inserted_count, error_count, errors(jsonb), status, created_by, created_at |
| `saved_views` | id, workspace_id, user_id, name, scope, filters(jsonb), created_at |
| `reports` | id, workspace_id, name, originator_id→originators(nullable), period_start, period_end, recurring, payload(jsonb), created_by, created_at |
| `benchmarks` | id, workspace_id, metric, p25, p50, p75, p90, computed_at, created_at; UNIQUE(workspace_id, metric) |
| `audit_logs` | id, workspace_id, actor, action, entity_type, entity_id, detail(jsonb), created_at |
| `plans` | id('free'/'pro'), name, price_cents |
| `subscriptions` | id, user_id(unique), plan_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, created_at, updated_at |

---

## (b) Backend route files

All mounted in `index.ts` via `api.route('/<mount>', router)` then `app.route('/api/v1', api)`. Auth column: pub = public read, auth = requires X-User-Id.

### `originators.ts` — mount `/originators`
- `GET /` — pub — list workspace originators (filter by status) — `Originator[]`
- `GET /:id` — pub — originator detail — `Originator`
- `GET /:id/profile` — pub — aggregated profile (latest rates, scorecard, forecast, fee totals, open letters/cases) — `{ originator, rates, scorecard, forecast, feeTotals, letters, cases }`
- `POST /` — auth — create originator — `Originator`
- `PUT /:id` — auth — update originator — `Originator`
- `DELETE /:id` — auth — delete originator — `{ success }`
- `POST /bulk` — auth — bulk create originators — `{ inserted, originators }`

### `entries.ts` — mount `/entries`
- `GET /` — pub — list originated entries (filter originator_id, sec_code, date range) — `OriginatedEntry[]`
- `GET /:id` — pub — entry detail — `OriginatedEntry`
- `POST /` — auth — create originated entry (also upserts dispute_window for debits) — `OriginatedEntry`
- `PUT /:id` — auth — update entry — `OriginatedEntry`
- `DELETE /:id` — auth — delete entry — `{ success }`

### `returns.ts` — mount `/returns`
- `GET /` — pub — list return entries (filter originator_id, return_code, category) — `ReturnEntry[]`
- `GET /unmatched` — pub — returns with matched=false — `ReturnEntry[]`
- `GET /:id` — pub — return detail — `ReturnEntry`
- `POST /` — auth — create return (auto-classify category via return_codes, late detection) — `ReturnEntry`
- `PUT /:id` — auth — update return — `ReturnEntry`
- `POST /:id/match` — auth — match to an originated_entry — `ReturnEntry`
- `DELETE /:id` — auth — delete return — `{ success }`

### `returnCodes.ts` — mount `/return-codes`
- `GET /` — pub — NACHA code dictionary (with workspace overrides applied) — `ReturnCode[]`
- `GET /:code` — pub — single code + return entries using it — `{ code, entries }`
- `PUT /:code/reclassify` — auth — set workspace override category (audited) — `ReturnCode`

### `rates.ts` — mount `/rates`
- `GET /` — pub — current computed rates per originator (latest snapshot each) — `RateRow[]`
- `GET /portfolio` — pub — portfolio-wide computed rates + status — `RateRow`
- `GET /originator/:id` — pub — rate snapshot timeline for one originator — `RateSnapshot[]`
- `POST /recompute` — auth — recompute snapshots for all originators + portfolio — `{ computed, snapshots }`

### `thresholds.ts` — mount `/thresholds`
- `GET /` — pub — current workspace thresholds (defaults to NACHA 0.5/3/15 if none) — `Threshold`
- `GET /history` — pub — threshold change history — `ThresholdHistory[]`
- `PUT /` — auth — upsert thresholds (writes threshold_history + audit) — `Threshold`

### `forecasts.ts` — mount `/forecasts`
- `GET /` — pub — latest forecast per originator/rate_type — `Forecast[]`
- `GET /days-to-breach` — pub — portfolio ranked by soonest projected breach — `Forecast[]`
- `POST /recompute` — auth — recompute forecasts (linear + ewma) for all — `{ computed, forecasts }`
- `POST /what-if` — auth — project effect of extra returns/entries (no persist) — `{ projection }`

### `scorecards.ts` — mount `/scorecards`
- `GET /` — pub — scorecards for all originators (sortable) — `Scorecard[]`
- `GET /:originatorId` — pub — scorecard for one originator — `Scorecard`
- `POST /recompute` — auth — recompute composite scores/grades/percentiles — `{ computed, scorecards }`

### `fees.ts` — mount `/fees`
- `GET /` — pub — fee records (filter originator_id, fee_type) — `FeeRecord[]`
- `GET /summary` — pub — economics roll-up per originator (fees vs recovered) — `FeeSummaryRow[]`
- `POST /` — auth — create fee record — `FeeRecord`
- `DELETE /:id` — auth — delete fee record — `{ success }`

### `representments.ts` — mount `/representments`
- `GET /` — pub — re-presentments (filter originator_id, outcome) — `Representment[]`
- `GET /recovery` — pub — recovery-rate summary per originator — `RecoveryRow[]`
- `POST /` — auth — record re-presentment (enforces max attempt_number 2) — `Representment`
- `PUT /:id` — auth — update outcome/recovered amount — `Representment`

### `disputeWindows.ts` — mount `/dispute-windows`
- `GET /` — pub — dispute windows (filter status) — `DisputeWindow[]`
- `GET /exposure` — pub — open-window dollar exposure summary — `{ openCount, openCents, expiringSoon }`
- `GET /expiring` — pub — windows expiring within N days (query `days`) — `DisputeWindow[]`
- `POST /rebuild` — auth — rebuild dispute windows from originated debit entries — `{ built }`

### `alertRules.ts` — mount `/alert-rules`
- `GET /` — pub — alert rules — `AlertRule[]`
- `GET /:id` — pub — rule detail — `AlertRule`
- `POST /` — auth — create rule — `AlertRule`
- `PUT /:id` — auth — update rule — `AlertRule`
- `DELETE /:id` — auth — delete rule — `{ success }`

### `alerts.ts` — mount `/alerts`
- `GET /` — pub — alert inbox (filter severity, status) — `Alert[]`
- `GET /:id` — pub — alert detail — `Alert`
- `POST /evaluate` — auth — evaluate all enabled rules now, fire alerts — `{ fired, alerts }`
- `POST /:id/acknowledge` — auth — acknowledge — `Alert`
- `POST /:id/snooze` — auth — snooze until (body: until) — `Alert`
- `POST /:id/read` — auth — mark read — `Alert`

### `letters.ts` — mount `/letters`
- `GET /` — pub — warning letters (filter originator_id, status) — `WarningLetter[]`
- `GET /:id` — pub — letter detail — `WarningLetter`
- `POST /` — auth — log letter — `WarningLetter`
- `PUT /:id` — auth — update letter (status/response) — `WarningLetter`
- `DELETE /:id` — auth — delete letter — `{ success }`

### `cases.ts` — mount `/cases`
- `GET /` — pub — remediation cases (filter status, originator_id) — `RemediationCase[]`
- `GET /:id` — pub — case detail with actions — `{ case, actions }`
- `POST /` — auth — open case — `RemediationCase`
- `PUT /:id` — auth — update case (status/priority/notes append) — `RemediationCase`
- `POST /:id/actions` — auth — add action item — `CaseAction`
- `PUT /:id/actions/:actionId` — auth — toggle/update action — `CaseAction`

### `imports.ts` — mount `/imports`
- `GET /` — pub — import history — `Import[]`
- `POST /csv` — auth — import CSV rows (body: kind, rows[]) with validation — `Import`
- `POST /nacha` — auth — parse NACHA return file text (body: content) — `Import`
- `POST /sample` — auth — seed sample originators/entries/returns/fees — `{ import, summary }`

### `reports.ts` — mount `/reports`
- `GET /` — pub — saved reports — `Report[]`
- `GET /:id` — pub — report detail — `Report`
- `POST /generate` — auth — generate a compliance report for period (persists payload) — `Report`
- `DELETE /:id` — auth — delete report — `{ success }`

### `benchmarks.ts` — mount `/benchmarks`
- `GET /` — pub — current benchmarks per metric — `Benchmark[]`
- `POST /recompute` — auth — recompute portfolio percentiles — `{ computed, benchmarks }`

### `analytics.ts` — mount `/analytics`
- `GET /trends` — pub — rate trend series (portfolio + per-originator, query originator_id) — `{ series }`
- `GET /code-distribution` — pub — return-code distribution over time — `{ buckets }`
- `GET /cohorts` — pub — originators grouped by onboarding cohort — `{ cohorts }`
- `GET /volume-correlation` — pub — volume vs return-rate scatter data — `{ points }`

### `views.ts` — mount `/views`
- `GET /` — pub — saved views for current user/scope (query scope) — `SavedView[]`
- `POST /` — auth — create saved view — `SavedView`
- `DELETE /:id` — auth — delete saved view — `{ success }`

### `audit.ts` — mount `/audit`
- `GET /` — pub — audit log (filter entity_type, entity_id) — `AuditLog[]`

### `dashboard.ts` — mount `/dashboard`
- `GET /summary` — pub — portfolio summary (status counts, portfolio rates, open exposure, fees this period, top at-risk, recent alerts, trend sparklines) — `{ statusCounts, portfolioRates, exposure, feesPeriod, atRisk, recentAlerts, sparklines }`

### `billing.ts` — mount `/billing`
- `GET /plan` — auth — current subscription + plan + stripeEnabled — `{ subscription, plan, stripeEnabled }`
- `POST /checkout` — auth — Stripe checkout (503 if unconfigured) — `{ url }`
- `POST /portal` — auth — Stripe billing portal (503 if unconfigured) — `{ url }`
- `POST /webhook` — pub — Stripe webhook (503 if unconfigured) — `{ received }`

Route file count: 24.

---

## (c) lib/api.ts methods

`web/lib/api.ts` — each is `fetch('/api/proxy/<path>')`, default export `api`.

| Method | Path (`/api/proxy/...`) | Verb |
|--------|--------------------------|------|
| `getOriginators(status?)` | `originators?status=` | GET |
| `getOriginator(id)` | `originators/:id` | GET |
| `getOriginatorProfile(id)` | `originators/:id/profile` | GET |
| `createOriginator(body)` | `originators` | POST |
| `updateOriginator(id, body)` | `originators/:id` | PUT |
| `deleteOriginator(id)` | `originators/:id` | DELETE |
| `bulkCreateOriginators(rows)` | `originators/bulk` | POST |
| `getEntries(params?)` | `entries?...` | GET |
| `getEntry(id)` | `entries/:id` | GET |
| `createEntry(body)` | `entries` | POST |
| `updateEntry(id, body)` | `entries/:id` | PUT |
| `deleteEntry(id)` | `entries/:id` | DELETE |
| `getReturns(params?)` | `returns?...` | GET |
| `getUnmatchedReturns()` | `returns/unmatched` | GET |
| `getReturn(id)` | `returns/:id` | GET |
| `createReturn(body)` | `returns` | POST |
| `updateReturn(id, body)` | `returns/:id` | PUT |
| `matchReturn(id, entryId)` | `returns/:id/match` | POST |
| `deleteReturn(id)` | `returns/:id` | DELETE |
| `getReturnCodes()` | `return-codes` | GET |
| `getReturnCode(code)` | `return-codes/:code` | GET |
| `reclassifyReturnCode(code, category)` | `return-codes/:code/reclassify` | PUT |
| `getRates()` | `rates` | GET |
| `getPortfolioRate()` | `rates/portfolio` | GET |
| `getOriginatorRates(id)` | `rates/originator/:id` | GET |
| `recomputeRates()` | `rates/recompute` | POST |
| `getThresholds()` | `thresholds` | GET |
| `getThresholdHistory()` | `thresholds/history` | GET |
| `updateThresholds(body)` | `thresholds` | PUT |
| `getForecasts()` | `forecasts` | GET |
| `getDaysToBreach()` | `forecasts/days-to-breach` | GET |
| `recomputeForecasts()` | `forecasts/recompute` | POST |
| `forecastWhatIf(body)` | `forecasts/what-if` | POST |
| `getScorecards()` | `scorecards` | GET |
| `getScorecard(originatorId)` | `scorecards/:originatorId` | GET |
| `recomputeScorecards()` | `scorecards/recompute` | POST |
| `getFees(params?)` | `fees?...` | GET |
| `getFeeSummary()` | `fees/summary` | GET |
| `createFee(body)` | `fees` | POST |
| `deleteFee(id)` | `fees/:id` | DELETE |
| `getRepresentments(params?)` | `representments?...` | GET |
| `getRecovery()` | `representments/recovery` | GET |
| `createRepresentment(body)` | `representments` | POST |
| `updateRepresentment(id, body)` | `representments/:id` | PUT |
| `getDisputeWindows(status?)` | `dispute-windows?status=` | GET |
| `getDisputeExposure()` | `dispute-windows/exposure` | GET |
| `getExpiringWindows(days)` | `dispute-windows/expiring?days=` | GET |
| `rebuildDisputeWindows()` | `dispute-windows/rebuild` | POST |
| `getAlertRules()` | `alert-rules` | GET |
| `getAlertRule(id)` | `alert-rules/:id` | GET |
| `createAlertRule(body)` | `alert-rules` | POST |
| `updateAlertRule(id, body)` | `alert-rules/:id` | PUT |
| `deleteAlertRule(id)` | `alert-rules/:id` | DELETE |
| `getAlerts(params?)` | `alerts?...` | GET |
| `getAlert(id)` | `alerts/:id` | GET |
| `evaluateAlerts()` | `alerts/evaluate` | POST |
| `acknowledgeAlert(id)` | `alerts/:id/acknowledge` | POST |
| `snoozeAlert(id, until)` | `alerts/:id/snooze` | POST |
| `readAlert(id)` | `alerts/:id/read` | POST |
| `getLetters(params?)` | `letters?...` | GET |
| `getLetter(id)` | `letters/:id` | GET |
| `createLetter(body)` | `letters` | POST |
| `updateLetter(id, body)` | `letters/:id` | PUT |
| `deleteLetter(id)` | `letters/:id` | DELETE |
| `getCases(params?)` | `cases?...` | GET |
| `getCase(id)` | `cases/:id` | GET |
| `createCase(body)` | `cases` | POST |
| `updateCase(id, body)` | `cases/:id` | PUT |
| `addCaseAction(id, body)` | `cases/:id/actions` | POST |
| `updateCaseAction(id, actionId, body)` | `cases/:id/actions/:actionId` | PUT |
| `getImports()` | `imports` | GET |
| `importCsv(body)` | `imports/csv` | POST |
| `importNacha(body)` | `imports/nacha` | POST |
| `seedSample()` | `imports/sample` | POST |
| `getReports()` | `reports` | GET |
| `getReport(id)` | `reports/:id` | GET |
| `generateReport(body)` | `reports/generate` | POST |
| `deleteReport(id)` | `reports/:id` | DELETE |
| `getBenchmarks()` | `benchmarks` | GET |
| `recomputeBenchmarks()` | `benchmarks/recompute` | POST |
| `getTrends(originatorId?)` | `analytics/trends?originator_id=` | GET |
| `getCodeDistribution()` | `analytics/code-distribution` | GET |
| `getCohorts()` | `analytics/cohorts` | GET |
| `getVolumeCorrelation()` | `analytics/volume-correlation` | GET |
| `getViews(scope?)` | `views?scope=` | GET |
| `createView(body)` | `views` | POST |
| `deleteView(id)` | `views/:id` | DELETE |
| `getAudit(params?)` | `audit?...` | GET |
| `getDashboardSummary()` | `dashboard/summary` | GET |
| `getBillingPlan()` | `billing/plan` | GET |
| `createCheckout()` | `billing/checkout` | POST |
| `createPortal()` | `billing/portal` | POST |

---

## (d) Pages

`kind`: public = no auth chrome; dashboard = under `/dashboard/*`, wrapped by `DashboardLayout`, client guard via `authClient.getSession()`.

| URL | File (under `web/`) | Kind | API methods used | Renders |
|-----|---------------------|------|------------------|---------|
| `/` | `app/page.tsx` | public | (none) | Static landing: hero, NACHA threshold explainer, feature grid, CTAs |
| `/auth/sign-in` | `app/auth/sign-in/page.tsx` | public | (authClient) | Email/password sign-in |
| `/auth/sign-up` | `app/auth/sign-up/page.tsx` | public | (authClient) | Email/password sign-up |
| `/pricing` | `app/pricing/page.tsx` | public | (none) | Free vs Pro plan cards |
| `/dashboard` | `app/dashboard/page.tsx` | dashboard | `getDashboardSummary`, `getDaysToBreach`, `getAlerts` | Status counts, portfolio rate gauges, exposure, at-risk list, recent alerts, sparklines |
| `/dashboard/originators` | `app/dashboard/originators/page.tsx` | dashboard | `getOriginators`, `createOriginator`, `updateOriginator`, `deleteOriginator`, `bulkCreateOriginators` | Registry table, create/edit/delete, bulk import |
| `/dashboard/originators/[id]` | `app/dashboard/originators/[id]/page.tsx` | dashboard | `getOriginatorProfile`, `getOriginatorRates`, `getScorecard` | Originator profile: rates, scorecard, forecast, fee totals, letters, cases |
| `/dashboard/entries` | `app/dashboard/entries/page.tsx` | dashboard | `getEntries`, `getOriginators`, `createEntry`, `updateEntry`, `deleteEntry` | Originated-entry ledger with filters + CRUD |
| `/dashboard/returns` | `app/dashboard/returns/page.tsx` | dashboard | `getReturns`, `getUnmatchedReturns`, `getOriginators`, `createReturn`, `updateReturn`, `matchReturn`, `deleteReturn` | Return-entry ledger, unmatched queue, match action |
| `/dashboard/return-codes` | `app/dashboard/return-codes/page.tsx` | dashboard | `getReturnCodes`, `getReturnCode`, `reclassifyReturnCode` | NACHA code dictionary, per-code drilldown, reclassify |
| `/dashboard/rates` | `app/dashboard/rates/page.tsx` | dashboard | `getRates`, `getPortfolioRate`, `recomputeRates` | Threshold monitor: three rates per originator with status + headroom, recompute |
| `/dashboard/thresholds` | `app/dashboard/thresholds/page.tsx` | dashboard | `getThresholds`, `getThresholdHistory`, `updateThresholds` | Threshold config form + change history |
| `/dashboard/forecasts` | `app/dashboard/forecasts/page.tsx` | dashboard | `getForecasts`, `getDaysToBreach`, `recomputeForecasts`, `forecastWhatIf` | Breach forecasts, days-to-breach ranking, what-if tool |
| `/dashboard/scorecards` | `app/dashboard/scorecards/page.tsx` | dashboard | `getScorecards`, `recomputeScorecards`, `getViews`, `createView` | Sortable scorecard table, grades, saved views |
| `/dashboard/fees` | `app/dashboard/fees/page.tsx` | dashboard | `getFees`, `getFeeSummary`, `getOriginators`, `createFee`, `deleteFee` | Fee economics ledger + roll-up |
| `/dashboard/representments` | `app/dashboard/representments/page.tsx` | dashboard | `getRepresentments`, `getRecovery`, `createRepresentment`, `updateRepresentment` | Re-presentment tracking + recovery rates |
| `/dashboard/dispute-windows` | `app/dashboard/dispute-windows/page.tsx` | dashboard | `getDisputeWindows`, `getDisputeExposure`, `getExpiringWindows`, `rebuildDisputeWindows` | 60-day window tracker, exposure, expiring calendar |
| `/dashboard/alert-rules` | `app/dashboard/alert-rules/page.tsx` | dashboard | `getAlertRules`, `getAlertRule`, `createAlertRule`, `updateAlertRule`, `deleteAlertRule` | Alert rule CRUD |
| `/dashboard/alerts` | `app/dashboard/alerts/page.tsx` | dashboard | `getAlerts`, `getAlert`, `evaluateAlerts`, `acknowledgeAlert`, `snoozeAlert`, `readAlert` | Alert inbox with ack/snooze/read, evaluate now |
| `/dashboard/letters` | `app/dashboard/letters/page.tsx` | dashboard | `getLetters`, `getLetter`, `getOriginators`, `createLetter`, `updateLetter`, `deleteLetter` | ODFI warning-letter tracker |
| `/dashboard/cases` | `app/dashboard/cases/page.tsx` | dashboard | `getCases`, `getCase`, `getOriginators`, `createCase`, `updateCase`, `addCaseAction`, `updateCaseAction` | Remediation case management + actions |
| `/dashboard/imports` | `app/dashboard/imports/page.tsx` | dashboard | `getImports`, `importCsv`, `importNacha`, `seedSample` | CSV/NACHA import, sample seeder, import history |
| `/dashboard/reports` | `app/dashboard/reports/page.tsx` | dashboard | `getReports`, `getReport`, `getOriginators`, `generateReport`, `deleteReport` | Compliance report generation + history |
| `/dashboard/analytics` | `app/dashboard/analytics/page.tsx` | dashboard | `getTrends`, `getCodeDistribution`, `getCohorts`, `getVolumeCorrelation`, `getOriginators` | Trend charts, code distribution, cohorts, volume correlation |
| `/dashboard/benchmarks` | `app/dashboard/benchmarks/page.tsx` | dashboard | `getBenchmarks`, `recomputeBenchmarks` | Portfolio percentile benchmarks + NACHA reference bands |
| `/dashboard/audit` | `app/dashboard/audit/page.tsx` | dashboard | `getAudit` | Audit log timeline with filters |
| `/dashboard/settings` | `app/dashboard/settings/page.tsx` | dashboard | `getBillingPlan`, `createCheckout`, `createPortal` | Workspace settings + billing |

Page count: 27 (4 public + 23 dashboard). Plus route handlers `app/api/auth/[...path]/route.ts` and `app/api/proxy/[...path]/route.ts`.

---

## (e) DashboardLayout sidebar nav

`web/components/DashboardLayout.tsx` — `'use client'`, `<aside>` with sectioned `NavLink`s, active state via `usePathname()`, mobile drawer. `web/app/dashboard/layout.tsx` renders it.

- **Overview**
  - Dashboard → `/dashboard`
- **Monitoring**
  - Threshold Monitor → `/dashboard/rates`
  - Breach Forecasts → `/dashboard/forecasts`
  - Scorecards → `/dashboard/scorecards`
  - Dispute Windows → `/dashboard/dispute-windows`
- **Ledgers**
  - Originators → `/dashboard/originators`
  - Originated Entries → `/dashboard/entries`
  - Returns → `/dashboard/returns`
  - Return Codes → `/dashboard/return-codes`
- **Economics**
  - Fees → `/dashboard/fees`
  - Re-presentments → `/dashboard/representments`
- **Compliance Workflow**
  - Alerts → `/dashboard/alerts`
  - Alert Rules → `/dashboard/alert-rules`
  - Warning Letters → `/dashboard/letters`
  - Remediation Cases → `/dashboard/cases`
- **Insights**
  - Analytics → `/dashboard/analytics`
  - Benchmarks → `/dashboard/benchmarks`
  - Reports → `/dashboard/reports`
- **Admin**
  - Thresholds → `/dashboard/thresholds`
  - Imports → `/dashboard/imports`
  - Audit Log → `/dashboard/audit`
  - Settings → `/dashboard/settings`

---

## Notes for implementing agents

- `db/index.ts` per template; `index.ts` calls `migrate()` (from `db/migrate.ts`) before `seedIfEmpty()` so a fresh Neon DB self-provisions, then seeds `plans` ('free'/'pro') and `return_codes` (NACHA R01-R85 dictionary).
- Rate computation: numerator = returns in window by category bucket; denominator = count of originated debit entries in the rolling window. Unauthorized codes: R05, R07, R10, R11, R29, R51. Admin codes: R02, R03, R04. Overall = all returns / debit count.
- Status classification per rate: clear (< watch_pct*limit), watch (>= watch_pct), warning (>= warning_pct), breach (>= limit).
- Dispute window = settlement_date + 60 days; created on debit entry insert and via `/dispute-windows/rebuild`.
- All writes append to `audit_logs`.
- billing.ts is the full Stripe-optional-503 variant (matches schema text plan_id 'free'/'pro').
