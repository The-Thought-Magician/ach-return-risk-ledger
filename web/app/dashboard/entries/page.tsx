'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Stat } from '@/components/ui/Stat'
import { PageSpinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'

interface Originator {
  id: string
  name: string
  status?: string
}

interface OriginatedEntry {
  id: string
  workspace_id: string
  originator_id: string
  entry_date: string
  settlement_date: string | null
  direction: string
  sec_code: string
  amount_cents: number
  trace_number: string | null
  external_ref: string | null
  created_at: string
}

const SEC_CODES = ['PPD', 'CCD', 'WEB', 'TEL']
const DIRECTIONS = ['debit', 'credit']

function fmtUSD(cents: number) {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  })
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return '—'
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function toDateInput(d: string | null) {
  if (!d) return ''
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return ''
  return dt.toISOString().slice(0, 10)
}

interface FormState {
  originator_id: string
  entry_date: string
  settlement_date: string
  direction: string
  sec_code: string
  amount: string
  trace_number: string
  external_ref: string
}

const emptyForm = (originatorId = ''): FormState => ({
  originator_id: originatorId,
  entry_date: new Date().toISOString().slice(0, 10),
  settlement_date: '',
  direction: 'debit',
  sec_code: 'PPD',
  amount: '',
  trace_number: '',
  external_ref: '',
})

export default function EntriesPage() {
  const [entries, setEntries] = useState<OriginatedEntry[]>([])
  const [originators, setOriginators] = useState<Originator[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [filterOriginator, setFilterOriginator] = useState('')
  const [filterSec, setFilterSec] = useState('')
  const [filterDirection, setFilterDirection] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [search, setSearch] = useState('')

  // Modal / form
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<OriginatedEntry | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const originatorName = useCallback(
    (id: string) => originators.find((o) => o.id === id)?.name ?? id.slice(0, 8),
    [originators],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, unknown> = {}
      if (filterOriginator) params.originator_id = filterOriginator
      if (filterSec) params.sec_code = filterSec
      if (fromDate) params.from = fromDate
      if (toDate) params.to = toDate
      const [rows, origs] = await Promise.all([
        api.getEntries(params),
        api.getOriginators(),
      ])
      setEntries(Array.isArray(rows) ? rows : [])
      setOriginators(Array.isArray(origs) ? origs : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load entries')
    } finally {
      setLoading(false)
    }
  }, [filterOriginator, filterSec, fromDate, toDate])

  useEffect(() => {
    load()
  }, [load])

  const visible = useMemo(() => {
    let rows = entries
    if (filterDirection) rows = rows.filter((e) => e.direction === filterDirection)
    const q = search.trim().toLowerCase()
    if (q) {
      rows = rows.filter(
        (e) =>
          (e.trace_number ?? '').toLowerCase().includes(q) ||
          (e.external_ref ?? '').toLowerCase().includes(q) ||
          originatorName(e.originator_id).toLowerCase().includes(q),
      )
    }
    return rows
  }, [entries, filterDirection, search, originatorName])

  const stats = useMemo(() => {
    const debits = visible.filter((e) => e.direction === 'debit')
    const credits = visible.filter((e) => e.direction === 'credit')
    const debitCents = debits.reduce((s, e) => s + (e.amount_cents || 0), 0)
    const creditCents = credits.reduce((s, e) => s + (e.amount_cents || 0), 0)
    return {
      count: visible.length,
      debitCount: debits.length,
      debitCents,
      creditCents,
    }
  }, [visible])

  // SEC code distribution for a simple SVG-free bar chart.
  const secDist = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of visible) map.set(e.sec_code, (map.get(e.sec_code) ?? 0) + 1)
    const max = Math.max(1, ...Array.from(map.values()))
    return SEC_CODES.map((code) => ({
      code,
      count: map.get(code) ?? 0,
      pct: ((map.get(code) ?? 0) / max) * 100,
    }))
  }, [visible])

  function openCreate() {
    setEditing(null)
    setForm(emptyForm(filterOriginator || originators[0]?.id || ''))
    setFormError(null)
    setModalOpen(true)
  }

  function openEdit(e: OriginatedEntry) {
    setEditing(e)
    setForm({
      originator_id: e.originator_id,
      entry_date: toDateInput(e.entry_date),
      settlement_date: toDateInput(e.settlement_date),
      direction: e.direction,
      sec_code: e.sec_code,
      amount: (e.amount_cents / 100).toFixed(2),
      trace_number: e.trace_number ?? '',
      external_ref: e.external_ref ?? '',
    })
    setFormError(null)
    setModalOpen(true)
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault()
    setFormError(null)
    if (!form.originator_id) {
      setFormError('Select an originator')
      return
    }
    const amountNum = Number(form.amount)
    if (!Number.isFinite(amountNum) || amountNum < 0) {
      setFormError('Enter a valid amount')
      return
    }
    const body: Record<string, unknown> = {
      originator_id: form.originator_id,
      entry_date: form.entry_date ? new Date(form.entry_date).toISOString() : new Date().toISOString(),
      settlement_date: form.settlement_date ? new Date(form.settlement_date).toISOString() : null,
      direction: form.direction,
      sec_code: form.sec_code,
      amount_cents: Math.round(amountNum * 100),
      trace_number: form.trace_number || null,
      external_ref: form.external_ref || null,
    }
    setSaving(true)
    try {
      if (editing) await api.updateEntry(editing.id, body)
      else await api.createEntry(body)
      setModalOpen(false)
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: string) {
    setDeletingId(id)
    try {
      await api.deleteEntry(id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setDeletingId(null)
    }
  }

  function resetFilters() {
    setFilterOriginator('')
    setFilterSec('')
    setFilterDirection('')
    setFromDate('')
    setToDate('')
    setSearch('')
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Originated Entries</h1>
          <p className="mt-1 text-sm text-slate-400">
            The originated-entry ledger. Debit entries form the denominator for NACHA return-rate
            calculations and open 60-day dispute windows.
          </p>
        </div>
        <Button onClick={openCreate} disabled={originators.length === 0}>
          + New Entry
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Entries Shown" value={stats.count.toLocaleString()} />
        <Stat label="Debit Entries" value={stats.debitCount.toLocaleString()} tone="sky" hint="Return-rate denominator" />
        <Stat label="Debit Volume" value={fmtUSD(stats.debitCents)} tone="emerald" />
        <Stat label="Credit Volume" value={fmtUSD(stats.creditCents)} tone="amber" />
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-200">Filters</h2>
        </CardHeader>
        <CardBody className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Originator
            <select
              value={filterOriginator}
              onChange={(e) => setFilterOriginator(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            >
              <option value="">All</option>
              {originators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            SEC Code
            <select
              value={filterSec}
              onChange={(e) => setFilterSec(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            >
              <option value="">All</option>
              {SEC_CODES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Direction
            <select
              value={filterDirection}
              onChange={(e) => setFilterDirection(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            >
              <option value="">All</option>
              {DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            From
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            To
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Search
            <input
              type="text"
              placeholder="trace / ref / originator"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
            />
          </label>
          <div className="md:col-span-3 lg:col-span-6">
            <Button variant="ghost" onClick={resetFilters} className="px-2">
              Reset filters
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-200">SEC Code Mix</h2>
        </CardHeader>
        <CardBody className="space-y-2">
          {secDist.map((s) => (
            <div key={s.code} className="flex items-center gap-3">
              <span className="w-12 text-xs font-medium text-slate-400">{s.code}</span>
              <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full rounded-full bg-emerald-500/70"
                  style={{ width: `${s.pct}%` }}
                />
              </div>
              <span className="w-10 text-right text-xs tabular-nums text-slate-400">{s.count}</span>
            </div>
          ))}
        </CardBody>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-200">Ledger</h2>
          <span className="text-xs text-slate-500">{visible.length} rows</span>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <PageSpinner label="Loading entries..." />
          ) : visible.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No originated entries"
                description={
                  originators.length === 0
                    ? 'Create an originator first, then add originated entries to begin tracking return rates.'
                    : 'No entries match the current filters. Adjust filters or add a new entry.'
                }
                action={
                  originators.length > 0 ? <Button onClick={openCreate}>+ New Entry</Button> : undefined
                }
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Originator</TH>
                  <TH>Entry Date</TH>
                  <TH>Settlement</TH>
                  <TH>Direction</TH>
                  <TH>SEC</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Trace #</TH>
                  <TH>Ref</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {visible.map((e) => (
                  <TR key={e.id}>
                    <TD className="font-medium text-white">{originatorName(e.originator_id)}</TD>
                    <TD>{fmtDate(e.entry_date)}</TD>
                    <TD>{fmtDate(e.settlement_date)}</TD>
                    <TD>
                      <Badge tone={e.direction === 'debit' ? 'info' : 'neutral'}>{e.direction}</Badge>
                    </TD>
                    <TD>
                      <Badge tone="neutral">{e.sec_code}</Badge>
                    </TD>
                    <TD className="text-right tabular-nums">{fmtUSD(e.amount_cents)}</TD>
                    <TD className="font-mono text-xs text-slate-400">{e.trace_number || '—'}</TD>
                    <TD className="text-xs text-slate-400">{e.external_ref || '—'}</TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => openEdit(e)}>
                          Edit
                        </Button>
                        <Button
                          variant="danger"
                          className="px-2 py-1 text-xs"
                          disabled={deletingId === e.id}
                          onClick={() => remove(e.id)}
                        >
                          {deletingId === e.id ? '...' : 'Delete'}
                        </Button>
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Edit Entry' : 'New Originated Entry'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Entry'}
            </Button>
          </>
        }
      >
        <form onSubmit={submit} className="space-y-4">
          {formError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {formError}
            </div>
          )}
          <label className="block text-sm">
            <span className="mb-1 block text-slate-300">Originator</span>
            <select
              value={form.originator_id}
              onChange={(e) => setForm({ ...form, originator_id: e.target.value })}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
              required
            >
              <option value="">Select originator</option>
              {originators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="mb-1 block text-slate-300">Entry Date</span>
              <input
                type="date"
                value={form.entry_date}
                onChange={(e) => setForm({ ...form, entry_date: e.target.value })}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                required
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-slate-300">Settlement Date</span>
              <input
                type="date"
                value={form.settlement_date}
                onChange={(e) => setForm({ ...form, settlement_date: e.target.value })}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="mb-1 block text-slate-300">Direction</span>
              <select
                value={form.direction}
                onChange={(e) => setForm({ ...form, direction: e.target.value })}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
              >
                {DIRECTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-slate-300">SEC Code</span>
              <select
                value={form.sec_code}
                onChange={(e) => setForm({ ...form, sec_code: e.target.value })}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
              >
                {SEC_CODES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-300">Amount (USD)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              placeholder="0.00"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
              required
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="mb-1 block text-slate-300">Trace Number</span>
              <input
                type="text"
                value={form.trace_number}
                onChange={(e) => setForm({ ...form, trace_number: e.target.value })}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-slate-300">External Ref</span>
              <input
                type="text"
                value={form.external_ref}
                onChange={(e) => setForm({ ...form, external_ref: e.target.value })}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
              />
            </label>
          </div>
        </form>
      </Modal>
    </div>
  )
}
