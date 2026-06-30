'use client'

import { useEffect, useState } from 'react'
import api from '@/lib/api'
import { Card, CardHeader, CardBody } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Stat } from '@/components/ui/Stat'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageSpinner } from '@/components/ui/Spinner'

interface Threshold {
  id?: string
  workspace_id?: string
  unauthorized_limit: number
  admin_limit: number
  overall_limit: number
  watch_pct: number
  warning_pct: number
  window_days: number
  created_at?: string
  updated_at?: string
}

interface ThresholdHistoryRow extends Threshold {
  effective_at?: string
  changed_by?: string
}

// NACHA regulatory defaults — shown as reference.
const NACHA = { unauthorized_limit: 0.5, admin_limit: 3.0, overall_limit: 15.0 }

type FormState = {
  unauthorized_limit: string
  admin_limit: string
  overall_limit: string
  watch_pct: string
  warning_pct: string
  window_days: string
}

function toForm(t: Threshold): FormState {
  return {
    unauthorized_limit: String(t.unauthorized_limit),
    admin_limit: String(t.admin_limit),
    overall_limit: String(t.overall_limit),
    watch_pct: String(t.watch_pct),
    warning_pct: String(t.warning_pct),
    window_days: String(t.window_days),
  }
}

function fmtDate(s?: string): string {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

export default function ThresholdsPage() {
  const [current, setCurrent] = useState<Threshold | null>(null)
  const [history, setHistory] = useState<ThresholdHistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState<FormState | null>(null)
  const [formError, setFormError] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [t, h] = await Promise.all([api.getThresholds(), api.getThresholdHistory()])
      const thr = t && typeof t === 'object' ? (t as Threshold) : null
      setCurrent(thr)
      if (thr) setForm(toForm(thr))
      setHistory(Array.isArray(h) ? h : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load thresholds')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  function setField(k: keyof FormState, v: string) {
    setForm((f) => (f ? { ...f, [k]: v } : f))
  }

  function validate(f: FormState): string | null {
    const nums = {
      unauthorized_limit: parseFloat(f.unauthorized_limit),
      admin_limit: parseFloat(f.admin_limit),
      overall_limit: parseFloat(f.overall_limit),
      watch_pct: parseFloat(f.watch_pct),
      warning_pct: parseFloat(f.warning_pct),
      window_days: parseInt(f.window_days, 10),
    }
    for (const [k, v] of Object.entries(nums)) {
      if (Number.isNaN(v)) return `${k.replace(/_/g, ' ')} must be a number`
      if (v < 0) return `${k.replace(/_/g, ' ')} cannot be negative`
    }
    if (nums.watch_pct > 1 || nums.warning_pct > 1) return 'Watch/Warning percentages are fractions of the limit (0–1)'
    if (nums.watch_pct >= nums.warning_pct) return 'Watch fraction must be below the warning fraction'
    if (nums.window_days < 1 || nums.window_days > 365) return 'Window days must be between 1 and 365'
    return null
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!form) return
    setFormError('')
    const v = validate(form)
    if (v) {
      setFormError(v)
      return
    }
    setSaving(true)
    setNotice('')
    setError('')
    try {
      const body = {
        unauthorized_limit: parseFloat(form.unauthorized_limit),
        admin_limit: parseFloat(form.admin_limit),
        overall_limit: parseFloat(form.overall_limit),
        watch_pct: parseFloat(form.watch_pct),
        warning_pct: parseFloat(form.warning_pct),
        window_days: parseInt(form.window_days, 10),
      }
      await api.updateThresholds(body)
      setNotice('Thresholds saved. New rates use these limits on next recompute.')
      await load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save thresholds')
    } finally {
      setSaving(false)
    }
  }

  function resetToNacha() {
    setForm((f) =>
      f
        ? {
            ...f,
            unauthorized_limit: String(NACHA.unauthorized_limit),
            admin_limit: String(NACHA.admin_limit),
            overall_limit: String(NACHA.overall_limit),
          }
        : f,
    )
  }

  function revertForm() {
    if (current) setForm(toForm(current))
    setFormError('')
  }

  if (loading) return <PageSpinner label="Loading thresholds..." />

  const fields: { key: keyof FormState; label: string; hint: string; step: string }[] = [
    { key: 'unauthorized_limit', label: 'Unauthorized Limit (%)', hint: 'NACHA cap: 0.5%', step: '0.01' },
    { key: 'admin_limit', label: 'Administrative Limit (%)', hint: 'NACHA cap: 3.0%', step: '0.1' },
    { key: 'overall_limit', label: 'Overall Limit (%)', hint: 'NACHA cap: 15.0%', step: '0.1' },
    { key: 'watch_pct', label: 'Watch Fraction', hint: 'Fraction of limit (e.g. 0.6)', step: '0.05' },
    { key: 'warning_pct', label: 'Warning Fraction', hint: 'Fraction of limit (e.g. 0.8)', step: '0.05' },
    { key: 'window_days', label: 'Rolling Window (days)', hint: 'Rate computation window', step: '1' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Thresholds</h1>
        <p className="mt-1 text-sm text-slate-400">
          Configure return-rate limits and the watch/warning bands used to classify each originator.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-700/60 bg-red-900/30 p-3 text-sm text-red-300">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-700/60 bg-emerald-900/20 p-3 text-sm text-emerald-300">
          {notice}
        </div>
      )}

      {/* Current values */}
      {current && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Stat label="Unauthorized Limit" value={`${current.unauthorized_limit}%`} tone="red" hint="NACHA 0.5%" />
          <Stat label="Administrative Limit" value={`${current.admin_limit}%`} tone="amber" hint="NACHA 3.0%" />
          <Stat label="Overall Limit" value={`${current.overall_limit}%`} tone="sky" hint="NACHA 15.0%" />
          <Stat label="Watch Band" value={`${Math.round(current.watch_pct * 100)}%`} hint="of limit" />
          <Stat label="Warning Band" value={`${Math.round(current.warning_pct * 100)}%`} hint="of limit" />
          <Stat label="Window" value={`${current.window_days}d`} hint="rolling" />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        {/* Config form */}
        <Card className="lg:col-span-3">
          <CardHeader className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Edit Thresholds</h2>
            <button
              type="button"
              onClick={resetToNacha}
              className="text-xs text-emerald-400 hover:text-emerald-300"
            >
              Reset limits to NACHA
            </button>
          </CardHeader>
          <CardBody>
            {form ? (
              <form onSubmit={save} className="space-y-4">
                {formError && (
                  <div className="rounded-lg border border-red-700/60 bg-red-900/30 p-3 text-sm text-red-300">
                    {formError}
                  </div>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  {fields.map((fld) => (
                    <div key={fld.key}>
                      <label className="mb-1 block text-sm font-medium text-slate-300">{fld.label}</label>
                      <input
                        type="number"
                        step={fld.step}
                        min="0"
                        value={form[fld.key]}
                        onChange={(e) => setField(fld.key, e.target.value)}
                        className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white focus:border-emerald-500 focus:outline-none"
                      />
                      <p className="mt-1 text-xs text-slate-500">{fld.hint}</p>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3 pt-2">
                  <Button type="submit" disabled={saving}>
                    {saving ? 'Saving...' : 'Save Thresholds'}
                  </Button>
                  <Button type="button" variant="secondary" onClick={revertForm} disabled={saving}>
                    Revert
                  </Button>
                </div>
              </form>
            ) : (
              <p className="text-sm text-slate-500">Thresholds unavailable.</p>
            )}
          </CardBody>
        </Card>

        {/* Band explainer */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <h2 className="text-sm font-semibold text-white">How status is classified</h2>
          </CardHeader>
          <CardBody className="space-y-3 text-sm text-slate-400">
            <div className="flex items-start gap-3">
              <span className="mt-1 h-3 w-3 shrink-0 rounded-full bg-emerald-400" />
              <span>
                <span className="font-medium text-emerald-300">Clear</span> — rate below the watch band.
              </span>
            </div>
            <div className="flex items-start gap-3">
              <span className="mt-1 h-3 w-3 shrink-0 rounded-full bg-amber-400" />
              <span>
                <span className="font-medium text-amber-300">Watch</span> — at or above{' '}
                {current ? Math.round(current.watch_pct * 100) : 60}% of limit.
              </span>
            </div>
            <div className="flex items-start gap-3">
              <span className="mt-1 h-3 w-3 shrink-0 rounded-full bg-orange-400" />
              <span>
                <span className="font-medium text-orange-300">Warning</span> — at or above{' '}
                {current ? Math.round(current.warning_pct * 100) : 80}% of limit.
              </span>
            </div>
            <div className="flex items-start gap-3">
              <span className="mt-1 h-3 w-3 shrink-0 rounded-full bg-red-400" />
              <span>
                <span className="font-medium text-red-300">Breach</span> — at or above the limit.
              </span>
            </div>
            <p className="pt-2 text-xs text-slate-500">
              Changes apply on the next rate recompute and are recorded in the change history below.
            </p>
          </CardBody>
        </Card>
      </div>

      {/* Change history */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-white">Change History ({history.length})</h2>
        </CardHeader>
        <CardBody className="p-0">
          {history.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No threshold changes recorded"
                description="Each save appends a row here so you can audit when limits changed and who changed them."
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Effective</TH>
                  <TH className="text-right">Unauthorized</TH>
                  <TH className="text-right">Admin</TH>
                  <TH className="text-right">Overall</TH>
                  <TH className="text-right">Watch</TH>
                  <TH className="text-right">Warning</TH>
                  <TH className="text-right">Window</TH>
                  <TH>Changed By</TH>
                </TR>
              </THead>
              <TBody>
                {history.map((h, i) => (
                  <TR key={h.id ?? i}>
                    <TD className="whitespace-nowrap text-slate-300">{fmtDate(h.effective_at ?? h.created_at)}</TD>
                    <TD className="text-right tabular-nums">{h.unauthorized_limit}%</TD>
                    <TD className="text-right tabular-nums">{h.admin_limit}%</TD>
                    <TD className="text-right tabular-nums">{h.overall_limit}%</TD>
                    <TD className="text-right tabular-nums">{Math.round(h.watch_pct * 100)}%</TD>
                    <TD className="text-right tabular-nums">{Math.round(h.warning_pct * 100)}%</TD>
                    <TD className="text-right tabular-nums">{h.window_days}d</TD>
                    <TD className="truncate text-slate-400">{h.changed_by ?? '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
