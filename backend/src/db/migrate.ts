import { db } from './index.js'
import { sql } from 'drizzle-orm'

// Idempotent self-provisioning DDL. Column names/types match schema.ts exactly.
// Timestamps use timestamptz; integers use integer; floats use real; JSON uses jsonb.

const statements: string[] = [
  `CREATE TABLE IF NOT EXISTS originators (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    name text NOT NULL,
    company_id text,
    odfi_name text,
    routing_number text,
    mcc text,
    expected_monthly_volume integer DEFAULT 0,
    status text NOT NULL DEFAULT 'active',
    metadata jsonb DEFAULT '{}'::jsonb,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS originated_entries (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    originator_id text NOT NULL REFERENCES originators(id),
    entry_date timestamptz NOT NULL,
    settlement_date timestamptz,
    direction text NOT NULL DEFAULT 'debit',
    sec_code text NOT NULL DEFAULT 'PPD',
    amount_cents integer NOT NULL DEFAULT 0,
    trace_number text,
    external_ref text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS return_entries (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    originator_id text NOT NULL REFERENCES originators(id),
    originated_entry_id text REFERENCES originated_entries(id),
    return_code text NOT NULL,
    category text NOT NULL DEFAULT 'other',
    return_date timestamptz NOT NULL,
    amount_cents integer NOT NULL DEFAULT 0,
    is_late boolean DEFAULT false,
    matched boolean DEFAULT false,
    external_ref text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS return_codes (
    id text PRIMARY KEY,
    code text NOT NULL UNIQUE,
    description text NOT NULL,
    category text NOT NULL DEFAULT 'other',
    consumer boolean DEFAULT false,
    workspace_override text,
    override_category text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS rate_snapshots (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    originator_id text REFERENCES originators(id),
    window_days integer NOT NULL DEFAULT 60,
    as_of timestamptz NOT NULL,
    debit_count integer NOT NULL DEFAULT 0,
    total_returns integer NOT NULL DEFAULT 0,
    unauthorized_rate real NOT NULL DEFAULT 0,
    admin_rate real NOT NULL DEFAULT 0,
    overall_rate real NOT NULL DEFAULT 0,
    unauthorized_status text NOT NULL DEFAULT 'clear',
    admin_status text NOT NULL DEFAULT 'clear',
    overall_status text NOT NULL DEFAULT 'clear',
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS thresholds (
    id text PRIMARY KEY,
    workspace_id text NOT NULL UNIQUE,
    unauthorized_limit real NOT NULL DEFAULT 0.5,
    admin_limit real NOT NULL DEFAULT 3.0,
    overall_limit real NOT NULL DEFAULT 15.0,
    watch_pct real NOT NULL DEFAULT 0.6,
    warning_pct real NOT NULL DEFAULT 0.8,
    window_days integer NOT NULL DEFAULT 60,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS threshold_history (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    unauthorized_limit real NOT NULL,
    admin_limit real NOT NULL,
    overall_limit real NOT NULL,
    watch_pct real NOT NULL,
    warning_pct real NOT NULL,
    window_days integer NOT NULL,
    effective_at timestamptz NOT NULL,
    changed_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS forecasts (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    originator_id text NOT NULL REFERENCES originators(id),
    rate_type text NOT NULL,
    model text NOT NULL DEFAULT 'linear',
    current_rate real NOT NULL DEFAULT 0,
    velocity_per_day real NOT NULL DEFAULT 0,
    projected_breach_date timestamptz,
    days_to_breach integer,
    confidence real NOT NULL DEFAULT 0,
    computed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS scorecards (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    originator_id text NOT NULL REFERENCES originators(id),
    composite_score real NOT NULL DEFAULT 0,
    grade text NOT NULL DEFAULT 'A',
    headroom_score real NOT NULL DEFAULT 0,
    velocity_score real NOT NULL DEFAULT 0,
    volume_score real NOT NULL DEFAULT 0,
    representment_score real NOT NULL DEFAULT 0,
    percentile real NOT NULL DEFAULT 0,
    computed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, originator_id)
  )`,

  `CREATE TABLE IF NOT EXISTS fee_records (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    originator_id text NOT NULL REFERENCES originators(id),
    return_entry_id text REFERENCES return_entries(id),
    fee_type text NOT NULL DEFAULT 'return',
    amount_cents integer NOT NULL DEFAULT 0,
    incurred_at timestamptz NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS representments (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    originator_id text NOT NULL REFERENCES originators(id),
    return_entry_id text NOT NULL REFERENCES return_entries(id),
    attempt_number integer NOT NULL DEFAULT 1,
    representment_date timestamptz NOT NULL,
    amount_cents integer NOT NULL DEFAULT 0,
    outcome text NOT NULL DEFAULT 'pending',
    recovered_amount_cents integer DEFAULT 0,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS dispute_windows (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    originator_id text NOT NULL REFERENCES originators(id),
    originated_entry_id text NOT NULL REFERENCES originated_entries(id),
    settlement_date timestamptz NOT NULL,
    window_expiry timestamptz NOT NULL,
    amount_cents integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'open',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (originated_entry_id)
  )`,

  `CREATE TABLE IF NOT EXISTS alert_rules (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    name text NOT NULL,
    trigger_type text NOT NULL,
    severity text NOT NULL DEFAULT 'warning',
    config jsonb DEFAULT '{}'::jsonb,
    target text NOT NULL DEFAULT 'all',
    target_value text,
    enabled boolean NOT NULL DEFAULT true,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS alerts (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    rule_id text REFERENCES alert_rules(id),
    originator_id text REFERENCES originators(id),
    severity text NOT NULL DEFAULT 'warning',
    title text NOT NULL,
    body text NOT NULL DEFAULT '',
    snapshot jsonb DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'unread',
    snoozed_until timestamptz,
    fired_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS warning_letters (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    originator_id text NOT NULL REFERENCES originators(id),
    letter_type text NOT NULL DEFAULT 'warning',
    subject text NOT NULL,
    body text DEFAULT '',
    received_date timestamptz NOT NULL,
    response_due_date timestamptz,
    related_rate_type text,
    status text NOT NULL DEFAULT 'open',
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS remediation_cases (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    originator_id text NOT NULL REFERENCES originators(id),
    letter_id text REFERENCES warning_letters(id),
    title text NOT NULL,
    description text DEFAULT '',
    status text NOT NULL DEFAULT 'open',
    priority text NOT NULL DEFAULT 'medium',
    notes jsonb DEFAULT '[]'::jsonb,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS case_actions (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    case_id text NOT NULL REFERENCES remediation_cases(id),
    title text NOT NULL,
    done boolean NOT NULL DEFAULT false,
    due_date timestamptz,
    assigned_to text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS imports (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    kind text NOT NULL,
    filename text,
    row_count integer NOT NULL DEFAULT 0,
    inserted_count integer NOT NULL DEFAULT 0,
    error_count integer NOT NULL DEFAULT 0,
    errors jsonb DEFAULT '[]'::jsonb,
    status text NOT NULL DEFAULT 'completed',
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS saved_views (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    scope text NOT NULL DEFAULT 'scorecards',
    filters jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS reports (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    name text NOT NULL,
    originator_id text REFERENCES originators(id),
    period_start timestamptz NOT NULL,
    period_end timestamptz NOT NULL,
    recurring boolean NOT NULL DEFAULT false,
    payload jsonb DEFAULT '{}'::jsonb,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS benchmarks (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    metric text NOT NULL,
    p25 real NOT NULL DEFAULT 0,
    p50 real NOT NULL DEFAULT 0,
    p75 real NOT NULL DEFAULT 0,
    p90 real NOT NULL DEFAULT 0,
    computed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, metric)
  )`,

  `CREATE TABLE IF NOT EXISTS audit_logs (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    actor text NOT NULL,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text,
    detail jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS plans (
    id text PRIMARY KEY,
    name text NOT NULL,
    price_cents integer NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS subscriptions (
    id text PRIMARY KEY,
    user_id text NOT NULL UNIQUE,
    plan_id text NOT NULL DEFAULT 'free',
    stripe_customer_id text,
    stripe_subscription_id text,
    status text NOT NULL DEFAULT 'active',
    current_period_end timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
]

const indexes: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_originators_workspace ON originators(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_originated_entries_workspace ON originated_entries(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_originated_entries_originator ON originated_entries(originator_id)`,
  `CREATE INDEX IF NOT EXISTS idx_return_entries_workspace ON return_entries(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_return_entries_originator ON return_entries(originator_id)`,
  `CREATE INDEX IF NOT EXISTS idx_return_entries_originated ON return_entries(originated_entry_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rate_snapshots_workspace ON rate_snapshots(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rate_snapshots_originator ON rate_snapshots(originator_id)`,
  `CREATE INDEX IF NOT EXISTS idx_forecasts_workspace ON forecasts(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_forecasts_originator ON forecasts(originator_id)`,
  `CREATE INDEX IF NOT EXISTS idx_scorecards_workspace ON scorecards(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fee_records_workspace ON fee_records(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fee_records_originator ON fee_records(originator_id)`,
  `CREATE INDEX IF NOT EXISTS idx_representments_workspace ON representments(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_representments_return ON representments(return_entry_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dispute_windows_workspace ON dispute_windows(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dispute_windows_originator ON dispute_windows(originator_id)`,
  `CREATE INDEX IF NOT EXISTS idx_alert_rules_workspace ON alert_rules(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_workspace ON alerts(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_rule ON alerts(rule_id)`,
  `CREATE INDEX IF NOT EXISTS idx_warning_letters_workspace ON warning_letters(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_warning_letters_originator ON warning_letters(originator_id)`,
  `CREATE INDEX IF NOT EXISTS idx_remediation_cases_workspace ON remediation_cases(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_remediation_cases_originator ON remediation_cases(originator_id)`,
  `CREATE INDEX IF NOT EXISTS idx_case_actions_workspace ON case_actions(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_case_actions_case ON case_actions(case_id)`,
  `CREATE INDEX IF NOT EXISTS idx_imports_workspace ON imports(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_saved_views_workspace ON saved_views(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_saved_views_user ON saved_views(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_workspace ON reports(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_benchmarks_workspace ON benchmarks(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace ON audit_logs(workspace_id)`,
]

export async function migrate() {
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt))
  }
  for (const idx of indexes) {
    await db.execute(sql.raw(idx))
  }
  console.log('Migration complete: all tables and indexes provisioned')
}
