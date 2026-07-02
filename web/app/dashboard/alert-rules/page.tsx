'use client'

import { useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Card, CardHeader, CardBody } from '@/components/ui/card'
import { Stat } from '@/components/ui/Stat'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/button'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'
import { EmptyState } from '@/components/ui/EmptyState'
import { Modal } from '@/components/ui/Modal'
import { PageSpinner } from '@/components/ui/Spinner'

interface AlertRule {
  id: string
  workspace_id: string
  name: string
  trigger_type: string
  severity: string
  config: Record<string, unknown> | null
  target: string | null
  target_value: string | null
  enabled: boolean
  created_by: string | null
  created_at: string | null
}

const TRIGGER_TYPES = [
  { value: 'rate_threshold', label: 'Rate threshold breach' },
  { value: 'days_to_breach', label: 'Days to breach' },
  { value: 'dispute_expiring', label: 'Dispute window expiring' },
  { value: 'scorecard_grade', label: 'Scorecard grade drop' },
  { value: 'fee_spike', label: 'Fee spike' },
] as const

const SEVERITIES = ['watch', 'warning', 'breach'] as const

const TARGETS = [
  { value: 'portfolio', label: 'Portfolio-wide' },
  { value: 'originator', label: 'Single originator' },
] as const

type FormState = {
  name: string
  trigger_type: string
  severity: string
  target: string
  target_value: string
  configText: string
  enabled: boolean
}

const EMPTY_FORM: FormState = {
  name: '',
  trigger_type: 'rate_threshold',
  severity: 'warning',
  target: 'portfolio',
  target_value: '',
  configText: '{\n  "threshold": 0.5,\n  "rate_type": "unauthorized"\n}',
  enabled: true,
}

function severityTone(sev: string): 'watch' | 'warning' | 'breach' | 'neutral' {
  switch ((sev ?? '').toLowerCase()) {
    case 'watch':
      return 'watch'
    case 'warning':
      return 'warning'
    case 'breach':
      return 'breach'
    default:
      return 'neutral'
  }
}

export default function AlertRulesPage() {
  const [rules, setRules] = useState<AlertRule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<AlertRule | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const r = await api.getAlertRules()
      setRules(Array.isArray(r) ? r : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load alert rules')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormError(null)
    setModalOpen(true)
  }

  async function openEdit(rule: AlertRule) {
    setEditing(rule)
    setFormError(null)
    // Refetch detail to get freshest config.
    let detail = rule
    try {
      const d = await api.getAlertRule(rule.id)
      if (d && d.id) detail = d
    } catch {
      /* fall back to row */
    }
    setForm({
      name: detail.name ?? '',
      trigger_type: detail.trigger_type ?? 'rate_threshold',
      severity: detail.severity ?? 'warning',
      target: detail.target ?? 'portfolio',
      target_value: detail.target_value ?? '',
      configText: detail.config ? JSON.stringify(detail.config, null, 2) : '{}',
      enabled: detail.enabled ?? true,
    })
    setModalOpen(true)
  }

  function buildBody(): Record<string, unknown> | null {
    let config: unknown = {}
    const raw = form.configText.trim()
    if (raw) {
      try {
        config = JSON.parse(raw)
      } catch {
        setFormError('Config must be valid JSON')
        return null
      }
    }
    return {
      name: form.name.trim(),
      trigger_type: form.trigger_type,
      severity: form.severity,
      target: form.target,
      target_value: form.target === 'originator' ? form.target_value.trim() || null : null,
      config,
      enabled: form.enabled,
    }
  }

  async function onSave() {
    setFormError(null)
    if (!form.name.trim()) {
      setFormError('Name is required')
      return
    }
    const body = buildBody()
    if (!body) return
    setSaving(true)
    try {
      if (editing) {
        await api.updateAlertRule(editing.id, body)
        setNotice(`Updated rule "${form.name.trim()}".`)
      } else {
        await api.createAlertRule(body)
        setNotice(`Created rule "${form.name.trim()}".`)
      }
      setModalOpen(false)
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function onToggle(rule: AlertRule) {
    setBusyId(rule.id)
    setError(null)
    try {
      await api.updateAlertRule(rule.id, { ...ruleToBody(rule), enabled: !rule.enabled })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to toggle rule')
    } finally {
      setBusyId(null)
    }
  }

  async function onDelete(rule: AlertRule) {
    if (!confirm(`Delete alert rule "${rule.name}"? This cannot be undone.`)) return
    setBusyId(rule.id)
    setError(null)
    try {
      await api.deleteAlertRule(rule.id)
      setNotice(`Deleted rule "${rule.name}".`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusyId(null)
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rules
    return rules.filter((r) =>
      [r.name, r.trigger_type, r.severity, r.target].some((v) =>
        String(v ?? '').toLowerCase().includes(q),
      ),
    )
  }, [rules, search])

  const enabledCount = rules.filter((r) => r.enabled).length
  const breachCount = rules.filter((r) => (r.severity ?? '').toLowerCase() === 'breach').length

  if (loading) return <PageSpinner label="Loading alert rules..." />

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Alert Rules</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Define the conditions that fire compliance alerts. Rules are evaluated on demand from the
            Alerts inbox and on the monitoring schedule.
          </p>
        </div>
        <Button variant="primary" onClick={openCreate}>
          New rule
        </Button>
      </header>

      {notice && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Total rules" value={rules.length.toLocaleString()} tone="sky" />
        <Stat label="Enabled" value={enabledCount.toLocaleString()} hint="Active in evaluation" tone="emerald" />
        <Stat label="Breach-severity" value={breachCount.toLocaleString()} hint="Highest priority" tone="red" />
      </div>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-white">Rules</h2>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search rules…"
            className="w-56 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-amber-500/50 focus:outline-none"
          />
        </CardHeader>
        <CardBody>
          {filtered.length === 0 ? (
            <EmptyState
              title="No alert rules yet"
              description="Create a rule to be notified when an originator approaches or breaches a NACHA threshold, when dispute windows are about to expire, or when scorecards drop."
              action={
                <Button variant="primary" onClick={openCreate}>
                  Create your first rule
                </Button>
              }
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Trigger</TH>
                  <TH>Severity</TH>
                  <TH>Target</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {filtered.map((r) => {
                  const triggerLabel =
                    TRIGGER_TYPES.find((t) => t.value === r.trigger_type)?.label ?? r.trigger_type
                  return (
                    <TR key={r.id}>
                      <TD className="font-medium text-white">{r.name}</TD>
                      <TD className="text-zinc-300">{triggerLabel}</TD>
                      <TD>
                        <Badge tone={severityTone(r.severity)}>{r.severity}</Badge>
                      </TD>
                      <TD className="text-zinc-400">
                        {r.target === 'originator' && r.target_value
                          ? `originator ${String(r.target_value).slice(0, 8)}`
                          : r.target ?? 'portfolio'}
                      </TD>
                      <TD>
                        <Badge tone={r.enabled ? 'clear' : 'neutral'}>
                          {r.enabled ? 'enabled' : 'disabled'}
                        </Badge>
                      </TD>
                      <TD className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            className="px-2 py-1 text-xs"
                            onClick={() => onToggle(r)}
                            disabled={busyId === r.id}
                          >
                            {r.enabled ? 'Disable' : 'Enable'}
                          </Button>
                          <Button
                            variant="secondary"
                            className="px-2 py-1 text-xs"
                            onClick={() => openEdit(r)}
                            disabled={busyId === r.id}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="danger"
                            className="px-2 py-1 text-xs"
                            onClick={() => onDelete(r)}
                            disabled={busyId === r.id}
                          >
                            Delete
                          </Button>
                        </div>
                      </TD>
                    </TR>
                  )
                })}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Edit alert rule' : 'New alert rule'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onSave} disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Create rule'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {formError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {formError}
            </div>
          )}
          <Field label="Name">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Unauthorized rate watch"
              className={inputClass}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Trigger type">
              <select
                value={form.trigger_type}
                onChange={(e) => setForm({ ...form, trigger_type: e.target.value })}
                className={inputClass}
              >
                {TRIGGER_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Severity">
              <select
                value={form.severity}
                onChange={(e) => setForm({ ...form, severity: e.target.value })}
                className={inputClass}
              >
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Target">
              <select
                value={form.target}
                onChange={(e) => setForm({ ...form, target: e.target.value })}
                className={inputClass}
              >
                {TARGETS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            {form.target === 'originator' && (
              <Field label="Originator ID">
                <input
                  value={form.target_value}
                  onChange={(e) => setForm({ ...form, target_value: e.target.value })}
                  placeholder="originator id"
                  className={inputClass}
                />
              </Field>
            )}
          </div>
          <Field label="Config (JSON)" hint="Trigger-specific parameters, e.g. threshold, rate_type, days.">
            <textarea
              value={form.configText}
              onChange={(e) => setForm({ ...form, configText: e.target.value })}
              rows={6}
              spellCheck={false}
              className={`${inputClass} font-mono text-xs`}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              className="h-4 w-4 rounded border-zinc-600 bg-zinc-950 text-amber-500 focus:ring-amber-500/50"
            />
            Enabled
          </label>
        </div>
      </Modal>
    </div>
  )
}

const inputClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-amber-500/50 focus:outline-none'

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-zinc-600">{hint}</span>}
    </label>
  )
}

function ruleToBody(r: AlertRule): Record<string, unknown> {
  return {
    name: r.name,
    trigger_type: r.trigger_type,
    severity: r.severity,
    target: r.target,
    target_value: r.target_value,
    config: r.config ?? {},
    enabled: r.enabled,
  }
}
