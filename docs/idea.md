# ACH Return Risk Ledger

## Overview

ACH Return Risk Ledger is a continuous NACHA-compliance monitoring platform that tracks ACH return rates and unauthorized-debit rates for every originator against NACHA's regulatory suspension thresholds, and forecasts which originators will breach. It turns the manual, spreadsheet-driven discipline of return-rate monitoring into an always-on ledger with concrete triggers, a breach-forecast engine, return-fee economics, and originator scorecards.

NACHA enforces three hard return-rate thresholds: 0.5% for unauthorized-debit returns (R05, R07, R10, R11, R29, R51), 3.0% for administrative returns (R02, R03, R04), and 15.0% overall returns across all reason codes. A breach triggers a NACHA inquiry, fines that can reach roughly $500,000 per month, and ultimately suspension of an originator's ability to send ACH debits, which is existential for any biller that collects via ACH. Today most risk and ops teams compute these rates by hand at month-end, far too late to intervene. This platform computes the rates continuously over rolling 60-day windows, surfaces velocity-based forecasts of when a threshold will be crossed, and gives compliance teams a defensible audit trail.

## Problem

NACHA's return-rate rules (the Risk Management and Enforcement framework) impose suspension thresholds that ODFIs are obligated to police on their originators. The pain:

- Monitoring is manual and lagging. Teams pull return reports, paste into Excel, and compute ratios at month-end. By the time a 0.5% unauthorized rate is visible, the breach has already happened.
- The denominators are subtle. NACHA's unauthorized rate uses a 60-day rolling count of debit entries as the denominator and counts only specific unauthorized return codes in the numerator. Getting the window and the code buckets wrong produces false comfort or false alarms.
- There is no early-warning velocity signal. A originator going from 0.2% to 0.45% in two weeks is on a collision course, but a static threshold check does not show the trajectory.
- ODFIs send warning letters and there is no system of record tying a letter, an inquiry, a remediation plan, and the underlying return data together.
- Return fees, re-presentment economics, and the 60-day consumer dispute window for unauthorized returns are tracked separately if at all.

## Target Users

- Risk and compliance managers at payment facilitators (payfacs) who must police thousands of sub-merchant originators.
- ACH operations leads at ODFIs and sponsor banks who answer to a bank risk committee.
- Compliance leads at high-volume ACH billers (utilities, lenders, insurers, subscription businesses) who originate directly and must keep their own rates clean.

### Buyer

The economic buyer is the risk/compliance manager or ACH operations lead at a payfac, ODFI, or high-volume biller who personally owns NACHA compliance and reports to the bank's risk committee. A single avoided origination suspension dwarfs the price of the product.

## Why this is NOT an existing project

Near-neighbor corpora and why this is distinct:

- Transaction-monitoring / AML surveillance (e.g. sanctions screening, suspicious-activity detection). Those watch transaction content and counterparties for laundering and fraud typologies. They do not compute NACHA return-rate ratios over rolling debit-count denominators, do not bucket return reason codes into NACHA's unauthorized/admin/overall categories, and do not track regulatory suspension thresholds.
- Bank reconciliation / settlement reconcilers. Those match ledger entries to bank statements and settlement files. They have no concept of NACHA return thresholds, breach forecasting, or originator return scorecards.
- `sla-credit-recovery-desk` (nearest base project): tracks vendor SLA credits and recovery. Different domain entirely (vendor credits vs ACH compliance).
- `payout-payee-screening-desk` (nearest sibling): screens outbound payees for fraud/sanctions before payout. Outbound payee risk, not inbound ACH return-rate compliance.
- `settlement-funding-reconciler` (nearest sibling): reconciles card settlement and funding flows. Card rails, settlement timing, not NACHA ACH return rates with suspension as the stake.

The unique, defensible core here is: NACHA-specific return-rate computation (correct numerator code buckets, correct 60-day rolling debit-count denominator), threshold monitoring against the three regulatory limits, and velocity-based breach forecasting tied to suspension risk. No project in the corpus does this.

## Major Features

### 1. NACHA Threshold Monitor
Computes, per originator and per rolling window, the three NACHA rates: unauthorized rate (0.5% limit), administrative rate (3.0% limit), and overall return rate (15.0% limit).
- Rolling 60-day window computation for the unauthorized rate denominator (debit entries).
- Configurable windows (30/60/90 day) for overall and admin rates.
- Per-originator current rate vs threshold with headroom (basis points to limit).
- Status classification: clear / watch / warning / breach for each of the three rates.
- Portfolio roll-up of all originators by status.
- Snapshot history so a rate timeline can be charted.

### 2. Return-Reason Classifier
Buckets every ACH return code into NACHA categories with trend lines.
- Full NACHA return-code dictionary (R01-R85) with description, category (unauthorized/admin/overall-only), and consumer-vs-corporate flag.
- Automatic bucketing of imported returns into unauthorized / administrative / other.
- Per-code counts, per-code trend over time, top contributing codes per originator.
- Reclassification override (mark a code's bucket per workspace policy) with audit.
- Reason-code drilldown showing every return entry for a code.

### 3. Breach-Forecast Engine
Projects when an originator will cross a threshold based on return velocity.
- Linear and exponentially-weighted velocity models on the rate timeline.
- Projected breach date per rate per originator with confidence band.
- "Days to breach" ranking across the portfolio.
- What-if: project the effect of N additional returns or M additional originated entries.
- Forecast accuracy backtest against realized rates.

### 4. Return-Fee and Re-Presentment Economics Ledger
Tracks the dollar economics of returns and re-presentments.
- Per-return fee accrual (ODFI return fee, NSF re-presentment fee).
- Re-presentment tracking (Reinitiated Entry rules: max 2 re-presentments within 180 days for NSF).
- Recovery rate on re-presented entries.
- Net economics per originator: fees paid vs amounts recovered.
- Cost-of-returns dashboard with monthly trend.

### 5. Originator Scorecard
Ranks sub-merchants/originators by composite ACH risk.
- Composite risk score from rate headroom, velocity, volume, and re-presentment behavior.
- Letter grade (A-F) per originator.
- Sortable, filterable scorecard table.
- Per-originator profile page with full rate, return, fee, and forecast detail.
- Peer comparison against portfolio percentile.

### 6. 60-Day Consumer Unauthorized-Return Dispute-Window Tracker
Tracks the 60-calendar-day window in which a consumer may return an unauthorized debit.
- Per debit entry, computes the dispute-window expiry (settlement date + 60 days).
- Open-window exposure: dollars still inside the dispute window.
- Alerts for entries nearing window expiry.
- Window-expiry calendar / timeline.
- Late-return detection (unauthorized return received after the 60-day window).

### 7. CSV / NACHA-File Import with Sample Seeder
Ingests return and origination data.
- CSV import for originated entries and for returns (column mapping).
- NACHA ACH file (return addenda / dishonored returns) parse stub for structured import.
- Validation and import-error reporting per row.
- Built-in sample-data seeder that generates a realistic multi-originator return history for instant demoability.
- Re-runnable imports with dedupe.

### 8. Originator Registry
- CRUD for originators (sub-merchants): name, company ID, ODFI, MCC, expected monthly volume.
- Active/suspended/onboarding lifecycle state.
- Per-originator settlement and routing metadata.
- Bulk import of originators.

### 9. Originated-Entry Ledger
- Records of debit/credit entries originated (date, amount, SEC code, originator).
- Volume and dollar totals per originator per window (denominator source for rates).
- SEC-code breakdown (PPD, CCD, WEB, TEL).
- Entry search and filter.

### 10. Return-Entry Ledger
- Records of returns (return code, return date, original entry reference, amount).
- Links each return to its originated entry where matched.
- Unmatched-return queue.
- Return search, filter, export.

### 11. Threshold Configuration
- Per-workspace overridable thresholds (default to NACHA 0.5/3/15).
- Watch and warning sub-thresholds (e.g. warn at 80% of limit).
- Window-length configuration.
- Effective-date history of threshold settings.

### 12. Alert Rules and Triggers
- Concrete trigger conditions: rate crosses watch/warning/breach, velocity spike, ODFI warning letter logged, dispute-window exposure threshold, forecast days-to-breach below N.
- Per-rule severity and target originators (all / specific / by-grade).
- Trigger evaluation on each data import and on a schedule.

### 13. Alert Inbox / Notification Feed
- Per-user feed of fired alerts.
- Read/unread, acknowledge, snooze.
- Filter by severity, originator, rule.
- Alert detail with the underlying data snapshot.

### 14. ODFI Warning-Letter Tracker
- Log inbound ODFI/NACHA warning letters and inquiries against an originator.
- Letter type (warning, inquiry, ND notification, suspension notice), received date, response-due date.
- Link letters to the return data that triggered them.
- Response-due reminders.

### 15. Remediation Case Management
- Open a remediation case for an at-risk or breached originator.
- Case status workflow (open / in-progress / monitoring / resolved).
- Action items / tasks within a case.
- Link case to letters, alerts, and originator.
- Case notes / activity log.

### 16. Compliance Reporting
- Generate a NACHA return-rate compliance report per originator or portfolio for a period.
- Exportable report (rate table, code breakdown, breach status, remediation summary).
- Saved/recurring report definitions.
- Report history.

### 17. Audit Trail
- Append-only audit log of all writes (originator edits, threshold changes, reclassifications, case actions).
- Per-entity audit timeline.
- Actor, action, before/after where relevant.

### 18. Portfolio Dashboard
- Top-line counts: originators by status, portfolio rates, total open exposure, fees this period.
- At-risk originators list (sorted by days-to-breach).
- Recent alerts.
- Trend sparklines for the three portfolio rates.

### 19. Analytics and Trends
- Rate trend charts per originator and portfolio.
- Return-code distribution over time.
- Cohort analysis (originators onboarded in period X).
- Volume vs return correlation.

### 20. Benchmarks
- Portfolio percentile benchmarks per metric.
- Industry-style reference bands (NACHA limits as reference lines).
- Originator-vs-peer comparison.

### 21. Saved Views and Filters
- Save filter/sort combinations for scorecards and ledgers.
- Per-user saved views.
- Quick switch between views.

### 22. Settings and Workspace
- Workspace profile, member-visible metadata.
- Notification preferences.
- API/import preferences.
- Billing (all features free; Stripe optional, 503 when unconfigured).

## Data Model (tables)

- originators
- originated_entries
- return_entries
- return_codes (reference dictionary)
- rate_snapshots
- thresholds
- threshold_history
- forecasts
- scorecards
- fee_records
- representments
- dispute_windows
- alert_rules
- alerts
- warning_letters
- remediation_cases
- case_actions
- imports
- saved_views
- reports
- benchmarks
- audit_logs
- plans
- subscriptions

## API Surface

Mounted under `/api/v1`:

- /originators — CRUD originators, bulk import, profile
- /entries — originated-entry ledger CRUD/list
- /returns — return-entry ledger CRUD/list, unmatched queue
- /return-codes — NACHA code dictionary, reclassification override
- /rates — computed rates per originator/portfolio, snapshots, recompute
- /thresholds — threshold config + history
- /forecasts — breach forecasts, what-if, days-to-breach ranking
- /scorecards — composite scores, grades, ranking
- /fees — fee records, economics roll-up
- /representments — re-presentment tracking, recovery
- /dispute-windows — 60-day window tracker, exposure
- /alert-rules — alert rule CRUD
- /alerts — alert inbox, ack/snooze
- /letters — ODFI warning-letter tracker
- /cases — remediation cases + actions
- /imports — CSV/NACHA import + sample seeder
- /reports — compliance reports
- /benchmarks — portfolio benchmarks
- /analytics — trends, distributions, cohorts
- /views — saved views
- /audit — audit log
- /dashboard — portfolio summary
- /billing — plan/checkout/portal/webhook

## Frontend Pages (~24)

Public:
1. `/` — landing (static marketing)
2. `/auth/sign-in`
3. `/auth/sign-up`
4. `/pricing`

Dashboard:
5. `/dashboard` — portfolio overview
6. `/dashboard/originators` — originator registry list
7. `/dashboard/originators/[id]` — originator profile
8. `/dashboard/entries` — originated-entry ledger
9. `/dashboard/returns` — return-entry ledger
10. `/dashboard/return-codes` — NACHA code dictionary + reclassification
11. `/dashboard/rates` — threshold monitor (three rates per originator)
12. `/dashboard/thresholds` — threshold configuration
13. `/dashboard/forecasts` — breach-forecast engine + days-to-breach
14. `/dashboard/scorecards` — originator scorecards
15. `/dashboard/fees` — return-fee economics ledger
16. `/dashboard/representments` — re-presentment tracking
17. `/dashboard/dispute-windows` — 60-day dispute-window tracker
18. `/dashboard/alert-rules` — alert rule management
19. `/dashboard/alerts` — alert inbox
20. `/dashboard/letters` — ODFI warning-letter tracker
21. `/dashboard/cases` — remediation case management
22. `/dashboard/imports` — CSV/NACHA import + sample seeder
23. `/dashboard/reports` — compliance reporting
24. `/dashboard/analytics` — analytics and trends
25. `/dashboard/benchmarks` — benchmarks
26. `/dashboard/settings` — settings and billing
