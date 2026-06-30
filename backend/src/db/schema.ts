import { pgTable, text, integer, boolean, timestamp, jsonb, unique, real } from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Core registry
// ---------------------------------------------------------------------------

export const originators = pgTable('originators', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  name: text('name').notNull(),
  company_id: text('company_id'),
  odfi_name: text('odfi_name'),
  routing_number: text('routing_number'),
  mcc: text('mcc'),
  expected_monthly_volume: integer('expected_monthly_volume').default(0),
  status: text('status').notNull().default('active'), // active | onboarding | suspended
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Ledgers
// ---------------------------------------------------------------------------

export const originated_entries = pgTable('originated_entries', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  originator_id: text('originator_id').notNull().references(() => originators.id),
  entry_date: timestamp('entry_date').notNull(),
  settlement_date: timestamp('settlement_date'),
  direction: text('direction').notNull().default('debit'), // debit | credit
  sec_code: text('sec_code').notNull().default('PPD'), // PPD | CCD | WEB | TEL
  amount_cents: integer('amount_cents').notNull().default(0),
  trace_number: text('trace_number'),
  external_ref: text('external_ref'),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const return_entries = pgTable('return_entries', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  originator_id: text('originator_id').notNull().references(() => originators.id),
  originated_entry_id: text('originated_entry_id').references(() => originated_entries.id),
  return_code: text('return_code').notNull(),
  category: text('category').notNull().default('other'), // unauthorized | administrative | other
  return_date: timestamp('return_date').notNull(),
  amount_cents: integer('amount_cents').notNull().default(0),
  is_late: boolean('is_late').default(false),
  matched: boolean('matched').default(false),
  external_ref: text('external_ref'),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Reference dictionary
// ---------------------------------------------------------------------------

export const return_codes = pgTable('return_codes', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  code: text('code').notNull().unique(),
  description: text('description').notNull(),
  category: text('category').notNull().default('other'), // unauthorized | administrative | other
  consumer: boolean('consumer').default(false),
  workspace_override: text('workspace_override'), // workspace id that reclassified, null = global default
  override_category: text('override_category'),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Rates & thresholds
// ---------------------------------------------------------------------------

export const rate_snapshots = pgTable('rate_snapshots', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  originator_id: text('originator_id').references(() => originators.id), // null = portfolio-wide
  window_days: integer('window_days').notNull().default(60),
  as_of: timestamp('as_of').notNull(),
  debit_count: integer('debit_count').notNull().default(0),
  total_returns: integer('total_returns').notNull().default(0),
  unauthorized_rate: real('unauthorized_rate').notNull().default(0),
  admin_rate: real('admin_rate').notNull().default(0),
  overall_rate: real('overall_rate').notNull().default(0),
  unauthorized_status: text('unauthorized_status').notNull().default('clear'),
  admin_status: text('admin_status').notNull().default('clear'),
  overall_status: text('overall_status').notNull().default('clear'),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const thresholds = pgTable('thresholds', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().unique(),
  unauthorized_limit: real('unauthorized_limit').notNull().default(0.5),
  admin_limit: real('admin_limit').notNull().default(3.0),
  overall_limit: real('overall_limit').notNull().default(15.0),
  watch_pct: real('watch_pct').notNull().default(0.6), // fraction of limit -> watch
  warning_pct: real('warning_pct').notNull().default(0.8), // fraction of limit -> warning
  window_days: integer('window_days').notNull().default(60),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
})

export const threshold_history = pgTable('threshold_history', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  unauthorized_limit: real('unauthorized_limit').notNull(),
  admin_limit: real('admin_limit').notNull(),
  overall_limit: real('overall_limit').notNull(),
  watch_pct: real('watch_pct').notNull(),
  warning_pct: real('warning_pct').notNull(),
  window_days: integer('window_days').notNull(),
  effective_at: timestamp('effective_at').notNull(),
  changed_by: text('changed_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Forecasting & scoring
// ---------------------------------------------------------------------------

export const forecasts = pgTable('forecasts', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  originator_id: text('originator_id').notNull().references(() => originators.id),
  rate_type: text('rate_type').notNull(), // unauthorized | admin | overall
  model: text('model').notNull().default('linear'), // linear | ewma
  current_rate: real('current_rate').notNull().default(0),
  velocity_per_day: real('velocity_per_day').notNull().default(0),
  projected_breach_date: timestamp('projected_breach_date'),
  days_to_breach: integer('days_to_breach'),
  confidence: real('confidence').notNull().default(0),
  computed_at: timestamp('computed_at').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const scorecards = pgTable('scorecards', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  originator_id: text('originator_id').notNull().references(() => originators.id),
  composite_score: real('composite_score').notNull().default(0),
  grade: text('grade').notNull().default('A'), // A-F
  headroom_score: real('headroom_score').notNull().default(0),
  velocity_score: real('velocity_score').notNull().default(0),
  volume_score: real('volume_score').notNull().default(0),
  representment_score: real('representment_score').notNull().default(0),
  percentile: real('percentile').notNull().default(0),
  computed_at: timestamp('computed_at').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [unique().on(t.workspace_id, t.originator_id)])

// ---------------------------------------------------------------------------
// Economics
// ---------------------------------------------------------------------------

export const fee_records = pgTable('fee_records', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  originator_id: text('originator_id').notNull().references(() => originators.id),
  return_entry_id: text('return_entry_id').references(() => return_entries.id),
  fee_type: text('fee_type').notNull().default('return'), // return | nsf | representment
  amount_cents: integer('amount_cents').notNull().default(0),
  incurred_at: timestamp('incurred_at').notNull(),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const representments = pgTable('representments', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  originator_id: text('originator_id').notNull().references(() => originators.id),
  return_entry_id: text('return_entry_id').notNull().references(() => return_entries.id),
  attempt_number: integer('attempt_number').notNull().default(1), // max 2 for NSF within 180 days
  representment_date: timestamp('representment_date').notNull(),
  amount_cents: integer('amount_cents').notNull().default(0),
  outcome: text('outcome').notNull().default('pending'), // pending | recovered | returned
  recovered_amount_cents: integer('recovered_amount_cents').default(0),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Dispute windows
// ---------------------------------------------------------------------------

export const dispute_windows = pgTable('dispute_windows', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  originator_id: text('originator_id').notNull().references(() => originators.id),
  originated_entry_id: text('originated_entry_id').notNull().references(() => originated_entries.id),
  settlement_date: timestamp('settlement_date').notNull(),
  window_expiry: timestamp('window_expiry').notNull(), // settlement + 60 days
  amount_cents: integer('amount_cents').notNull().default(0),
  status: text('status').notNull().default('open'), // open | expired | disputed
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [unique().on(t.originated_entry_id)])

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------

export const alert_rules = pgTable('alert_rules', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  name: text('name').notNull(),
  trigger_type: text('trigger_type').notNull(), // rate_status | velocity_spike | letter_logged | exposure | days_to_breach
  severity: text('severity').notNull().default('warning'), // info | warning | critical
  config: jsonb('config').$type<Record<string, unknown>>().default({}),
  target: text('target').notNull().default('all'), // all | originator | grade
  target_value: text('target_value'),
  enabled: boolean('enabled').notNull().default(true),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const alerts = pgTable('alerts', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  rule_id: text('rule_id').references(() => alert_rules.id),
  originator_id: text('originator_id').references(() => originators.id),
  severity: text('severity').notNull().default('warning'),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>().default({}),
  status: text('status').notNull().default('unread'), // unread | read | acknowledged | snoozed
  snoozed_until: timestamp('snoozed_until'),
  fired_at: timestamp('fired_at').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Letters & cases
// ---------------------------------------------------------------------------

export const warning_letters = pgTable('warning_letters', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  originator_id: text('originator_id').notNull().references(() => originators.id),
  letter_type: text('letter_type').notNull().default('warning'), // warning | inquiry | nd_notification | suspension
  subject: text('subject').notNull(),
  body: text('body').default(''),
  received_date: timestamp('received_date').notNull(),
  response_due_date: timestamp('response_due_date'),
  related_rate_type: text('related_rate_type'),
  status: text('status').notNull().default('open'), // open | responded | closed
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const remediation_cases = pgTable('remediation_cases', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  originator_id: text('originator_id').notNull().references(() => originators.id),
  letter_id: text('letter_id').references(() => warning_letters.id),
  title: text('title').notNull(),
  description: text('description').default(''),
  status: text('status').notNull().default('open'), // open | in_progress | monitoring | resolved
  priority: text('priority').notNull().default('medium'), // low | medium | high
  notes: jsonb('notes').$type<Array<{ at: string; by: string; text: string }>>().default([]),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
})

export const case_actions = pgTable('case_actions', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  case_id: text('case_id').notNull().references(() => remediation_cases.id),
  title: text('title').notNull(),
  done: boolean('done').notNull().default(false),
  due_date: timestamp('due_date'),
  assigned_to: text('assigned_to'),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Imports, views, reports, benchmarks, audit
// ---------------------------------------------------------------------------

export const imports = pgTable('imports', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  kind: text('kind').notNull(), // originated | returns | originators | nacha | sample
  filename: text('filename'),
  row_count: integer('row_count').notNull().default(0),
  inserted_count: integer('inserted_count').notNull().default(0),
  error_count: integer('error_count').notNull().default(0),
  errors: jsonb('errors').$type<Array<{ row: number; message: string }>>().default([]),
  status: text('status').notNull().default('completed'), // completed | failed | partial
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const saved_views = pgTable('saved_views', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  user_id: text('user_id').notNull(),
  name: text('name').notNull(),
  scope: text('scope').notNull().default('scorecards'), // scorecards | entries | returns
  filters: jsonb('filters').$type<Record<string, unknown>>().default({}),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const reports = pgTable('reports', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  name: text('name').notNull(),
  originator_id: text('originator_id').references(() => originators.id), // null = portfolio
  period_start: timestamp('period_start').notNull(),
  period_end: timestamp('period_end').notNull(),
  recurring: boolean('recurring').notNull().default(false),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const benchmarks = pgTable('benchmarks', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  metric: text('metric').notNull(), // unauthorized_rate | admin_rate | overall_rate | composite_score
  p25: real('p25').notNull().default(0),
  p50: real('p50').notNull().default(0),
  p75: real('p75').notNull().default(0),
  p90: real('p90').notNull().default(0),
  computed_at: timestamp('computed_at').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [unique().on(t.workspace_id, t.metric)])

export const audit_logs = pgTable('audit_logs', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entity_type: text('entity_type').notNull(),
  entity_id: text('entity_id'),
  detail: jsonb('detail').$type<Record<string, unknown>>().default({}),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Billing (Stripe-optional, free-plan default)
// ---------------------------------------------------------------------------

export const plans = pgTable('plans', {
  id: text('id').primaryKey(), // 'free' | 'pro'
  name: text('name').notNull(),
  price_cents: integer('price_cents').notNull().default(0),
})

export const subscriptions = pgTable('subscriptions', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  user_id: text('user_id').notNull().unique(),
  plan_id: text('plan_id').notNull().default('free'),
  stripe_customer_id: text('stripe_customer_id'),
  stripe_subscription_id: text('stripe_subscription_id'),
  status: text('status').notNull().default('active'),
  current_period_end: timestamp('current_period_end'),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
})
