'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Stat } from '@/components/ui/Stat'
import { Badge, statusTone } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageSpinner } from '@/components/ui/Spinner'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'
import { Modal } from '@/components/ui/Modal'

interface Representment {
  id: string
  originator_id: string
  originator_name?: string
  return_entry_id?: string | null
  attempt_number: number
  representment_date?: string
  amount_cents: number
  outcome: string
  recovered_amount_cents: number
  created_at?: string
}

interface RecoveryRow {
  originator_id: string
  originator_name?: string
  name?: string
  attempts?: number
  total_attempts?: number
  recovered_count?: number
  recovered_cents?: number
  recovered_amount_cents?: number
  attempted_cents?: number
  recovery_rate?: number
}

const OUTCOMES = ['pending', 'recovered', 'failed', 'returned_again']

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function dollars(cents: unknown): string {
  return (num(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function fmtDate(v?: string): string {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function recoveryName(r: RecoveryRow): string {
  return r.originator_name || r.name || r.originator_id
}

function attemptsOf(r: RecoveryRow): number {
  return num(r.attempts ?? r.total_attempts)
}

function recoveredCentsOf(r: RecoveryRow): number {
  return num(r.recovered_cents ?? r.recovered_amount_cents)
}

function rateOf(r: RecoveryRow): number {
  if (r.recovery_rate != null) return num(r.recovery_rate) <= 1 ? num(r.recovery_rate) * 100 : num(r.recovery_rate)
  const att = attemptsOf(r)
  if (!att) return 0
  return (num(r.recovered_count) / att) * 100
}

function outcomeTone(outcome: string) {
  switch (outcome) {
    case 'recovered':
      return 'clear' as const
    case 'pending':
      return 'watch' as const
    case 'failed':
    case 'returned_again':
      return 'breach' as const
    default:
      return statusTone(outcome)
  }
}

export default function RepresentmentsPage() {
  const [reps, setReps] = useState<Representment[]>([])
  const [recovery, setRecovery] = useState<RecoveryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [originatorFilter, setOriginatorFilter] = useState('')
  const [outcomeFilter, setOutcomeFilter] = useState('')

  const [createOpen, setCreateOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({
    originator_id: '',
    return_entry_id: '',
    attempt_number: '1',
    representment_date: '',
    amount: '',
    outcome: 'pending',
    recovered: '',
  })

  const [editing, setEditing] = useState<Representment | null>(null)
  const [editForm, setEditForm] = useState({ outcome: 'pending', recovered: '' })
  const [savingEdit, setSavingEdit] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, unknown> = {}
      if (originatorFilter) params.originator_id = originatorFilter
      if (outcomeFilter) params.outcome = outcomeFilter
      const [repRows, rec] = await Promise.all([
        api.getRepresentments(Object.keys(params).length ? params : undefined),
        api.getRecovery(),
      ])
      setReps(Array.isArray(repRows) ? repRows : [])
      setRecovery(Array.isArray(rec) ? rec : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load re-presentments')
    } finally {
      setLoading(false)
    }
  }, [originatorFilter, outcomeFilter])

  useEffect(() => {
    load()
  }, [load])

  const originatorOptions = useMemo(() => {
    const map = new Map<string, string>()
    recovery.forEach((r) => map.set(r.originator_id, recoveryName(r)))
    reps.forEach((r) => {
      if (!map.has(r.originator_id)) map.set(r.originator_id, r.originator_name || r.originator_id)
    })
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }))
  }, [recovery, reps])

  const openCreate = () => {
    setForm({
      originator_id: originatorFilter || originatorOptions[0]?.id || '',
      return_entry_id: '',
      attempt_number: '1',
      representment_date: new Date().toISOString().slice(0, 10),
      amount: '',
      outcome: 'pending',
      recovered: '',
    })
    setError(null)
    setCreateOpen(true)
  }

  const submit = async () => {
    if (!form.originator_id || !form.amount) {
      setError('Originator and amount are required')
      return
    }
    const amountCents = Math.round(parseFloat(form.amount) * 100)
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setError('Enter a valid amount')
      return
    }
    const attempt = parseInt(form.attempt_number, 10)
    if (![1, 2].includes(attempt)) {
      setError('Attempt number must be 1 or 2 (NACHA limit)')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await api.createRepresentment({
        originator_id: form.originator_id,
        return_entry_id: form.return_entry_id || undefined,
        attempt_number: attempt,
        representment_date: form.representment_date || undefined,
        amount_cents: amountCents,
        outcome: form.outcome,
        recovered_amount_cents:
          form.outcome === 'recovered' ? Math.round(parseFloat(form.recovered || form.amount) * 100) : 0,
      })
      setCreateOpen(false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to record re-presentment')
    } finally {
      setSubmitting(false)
    }
  }

  const openEdit = (r: Representment) => {
    setEditing(r)
    setEditForm({
      outcome: r.outcome || 'pending',
      recovered: r.recovered_amount_cents ? (num(r.recovered_amount_cents) / 100).toFixed(2) : '',
    })
    setError(null)
  }

  const saveEdit = async () => {
    if (!editing) return
    setSavingEdit(true)
    setError(null)
    try {
      const recoveredCents =
        editForm.outcome === 'recovered'
          ? Math.round(parseFloat(editForm.recovered || String(num(editing.amount_cents) / 100)) * 100)
          : 0
      await api.updateRepresentment(editing.id, {
        outcome: editForm.outcome,
        recovered_amount_cents: Number.isFinite(recoveredCents) ? recoveredCents : 0,
      })
      setEditing(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update re-presentment')
    } finally {
      setSavingEdit(false)
    }
  }

  const totals = useMemo(() => {
    const attempts = reps.length
    const recovered = reps.filter((r) => r.outcome === 'recovered').length
    const recoveredCents = reps.reduce((acc, r) => acc + num(r.recovered_amount_cents), 0)
    const attemptedCents = reps.reduce((acc, r) => acc + num(r.amount_cents), 0)
    const rate = attempts ? (recovered / attempts) * 100 : 0
    return { attempts, recovered, recoveredCents, attemptedCents, rate }
  }, [reps])

  if (loading) return <PageSpinner label="Loading re-presentments..." />

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Re-presentment Tracking</h1>
          <p className="mt-1 text-sm text-slate-400">
            Monitor re-presentment attempts (max 2 per NACHA) and recovery performance across originators.
          </p>
        </div>
        <Button onClick={openCreate} disabled={originatorOptions.length === 0}>
          Record re-presentment
        </Button>
      </div>

      {error && !createOpen && !editing && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Attempts" value={totals.attempts} />
        <Stat
          label="Recovery rate"
          value={`${totals.rate.toFixed(1)}%`}
          tone={totals.rate >= 60 ? 'emerald' : totals.rate >= 30 ? 'amber' : 'red'}
          hint={`${totals.recovered} recovered`}
        />
        <Stat label="Recovered" value={dollars(totals.recoveredCents)} tone="emerald" />
        <Stat label="Attempted value" value={dollars(totals.attemptedCents)} />
      </div>

      <Card>
        <CardHeader>
          <span className="text-sm font-semibold text-white">Recovery rate by originator</span>
        </CardHeader>
        <CardBody className="p-0">
          {recovery.length === 0 ? (
            <EmptyState title="No recovery data" description="Recovery summary appears once re-presentments are recorded." />
          ) : (
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Originator</TH>
                  <TH className="text-right">Attempts</TH>
                  <TH className="text-right">Recovered</TH>
                  <TH className="text-right">Recovery rate</TH>
                  <TH className="w-44">Rate</TH>
                </TR>
              </THead>
              <TBody>
                {recovery.map((r) => {
                  const rate = rateOf(r)
                  const color = rate >= 60 ? 'bg-emerald-500' : rate >= 30 ? 'bg-amber-500' : 'bg-red-500'
                  return (
                    <TR key={r.originator_id}>
                      <TD className="font-medium text-white">{recoveryName(r)}</TD>
                      <TD className="text-right tabular-nums text-slate-300">{attemptsOf(r)}</TD>
                      <TD className="text-right tabular-nums text-emerald-300">{dollars(recoveredCentsOf(r))}</TD>
                      <TD className="text-right font-semibold tabular-nums text-slate-200">{rate.toFixed(1)}%</TD>
                      <TD>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                          <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, rate)}%` }} />
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

      <Card>
        <CardHeader className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-white">Re-presentment log</span>
          <select
            value={originatorFilter}
            onChange={(e) => setOriginatorFilter(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500/50 focus:outline-none"
          >
            <option value="">All originators</option>
            {originatorOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <select
            value={outcomeFilter}
            onChange={(e) => setOutcomeFilter(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500/50 focus:outline-none"
          >
            <option value="">All outcomes</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <span className="ml-auto text-xs text-slate-500">{reps.length} records</span>
        </CardHeader>
        <CardBody className="p-0">
          {reps.length === 0 ? (
            <EmptyState
              title="No re-presentments"
              description={
                originatorFilter || outcomeFilter
                  ? 'No re-presentments match the current filters.'
                  : 'Record a re-presentment to begin tracking recovery.'
              }
              action={
                !originatorFilter && !outcomeFilter ? (
                  <Button onClick={openCreate} disabled={originatorOptions.length === 0}>
                    Record re-presentment
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Originator</TH>
                  <TH className="text-center">Attempt</TH>
                  <TH>Date</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Outcome</TH>
                  <TH className="text-right">Recovered</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {reps.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-medium text-white">{r.originator_name || r.originator_id}</TD>
                    <TD className="text-center">
                      <Badge tone={num(r.attempt_number) >= 2 ? 'warning' : 'neutral'}>#{num(r.attempt_number)}</Badge>
                    </TD>
                    <TD className="text-slate-400">{fmtDate(r.representment_date || r.created_at)}</TD>
                    <TD className="text-right tabular-nums text-slate-300">{dollars(r.amount_cents)}</TD>
                    <TD>
                      <Badge tone={outcomeTone(r.outcome)}>{(r.outcome || 'pending').replace(/_/g, ' ')}</Badge>
                    </TD>
                    <TD className="text-right tabular-nums text-emerald-300">
                      {num(r.recovered_amount_cents) > 0 ? dollars(r.recovered_amount_cents) : '—'}
                    </TD>
                    <TD className="text-right">
                      <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => openEdit(r)}>
                        Update
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Record re-presentment"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting ? 'Saving...' : 'Record'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && createOpen && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Originator</label>
            <select
              value={form.originator_id}
              onChange={(e) => setForm((f) => ({ ...f, originator_id: e.target.value }))}
              className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500/50 focus:outline-none"
            >
              <option value="">Select originator</option>
              {originatorOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Attempt #</label>
              <select
                value={form.attempt_number}
                onChange={(e) => setForm((f) => ({ ...f, attempt_number: e.target.value }))}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500/50 focus:outline-none"
              >
                <option value="1">1</option>
                <option value="2">2</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Date</label>
              <input
                type="date"
                value={form.representment_date}
                onChange={(e) => setForm((f) => ({ ...f, representment_date: e.target.value }))}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500/50 focus:outline-none"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
              Return entry ID (optional)
            </label>
            <input
              value={form.return_entry_id}
              onChange={(e) => setForm((f) => ({ ...f, return_entry_id: e.target.value }))}
              placeholder="Link to a return entry"
              className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Amount (USD)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                placeholder="0.00"
                className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Outcome</label>
              <select
                value={form.outcome}
                onChange={(e) => setForm((f) => ({ ...f, outcome: e.target.value }))}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500/50 focus:outline-none"
              >
                {OUTCOMES.map((o) => (
                  <option key={o} value={o}>
                    {o.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {form.outcome === 'recovered' && (
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
                Recovered (USD)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.recovered}
                onChange={(e) => setForm((f) => ({ ...f, recovered: e.target.value }))}
                placeholder="Defaults to full amount"
                className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none"
              />
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Update re-presentment"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={savingEdit}>
              {savingEdit ? 'Saving...' : 'Save'}
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            {error && editing && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </div>
            )}
            <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-400">
              {editing.originator_name || editing.originator_id} · attempt #{num(editing.attempt_number)} ·{' '}
              {dollars(editing.amount_cents)}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Outcome</label>
              <select
                value={editForm.outcome}
                onChange={(e) => setEditForm((f) => ({ ...f, outcome: e.target.value }))}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500/50 focus:outline-none"
              >
                {OUTCOMES.map((o) => (
                  <option key={o} value={o}>
                    {o.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>
            {editForm.outcome === 'recovered' && (
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
                  Recovered (USD)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={editForm.recovered}
                  onChange={(e) => setEditForm((f) => ({ ...f, recovered: e.target.value }))}
                  placeholder={(num(editing.amount_cents) / 100).toFixed(2)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none"
                />
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
