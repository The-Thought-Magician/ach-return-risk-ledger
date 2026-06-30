'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge, statusTone } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Stat } from '@/components/ui/Stat'
import { PageSpinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'

interface Originator {
  id: string
  name: string
}

interface ReturnEntry {
  id: string
  workspace_id: string
  originator_id: string
  originated_entry_id: string | null
  return_code: string
  category: string
  return_date: string
  amount_cents: number
  is_late: boolean | null
  matched: boolean | null
  external_ref: string | null
  created_at: string
}

interface OriginatedEntry {
  id: string
  originator_id: string
  entry_date: string
  amount_cents: number
  sec_code: string
  trace_number: string | null
}

const CATEGORIES = ['unauthorized', 'administrative', 'other']

function fmtUSD(cents: number) {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
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

function categoryTone(cat: string): 'breach' | 'warning' | 'neutral' {
  if (cat === 'unauthorized') return 'breach'
  if (cat === 'administrative') return 'warning'
  return 'neutral'
}

interface FormState {
  originator_id: string
  return_code: string
  category: string
  return_date: string
  amount: string
  external_ref: string
}

const emptyForm = (originatorId = ''): FormState => ({
  originator_id: originatorId,
  return_code: '',
  category: 'other',
  return_date: new Date().toISOString().slice(0, 10),
  amount: '',
  external_ref: '',
})

export default function ReturnsPage() {
  const [returns, setReturns] = useState<ReturnEntry[]>([])
  const [unmatched, setUnmatched] = useState<ReturnEntry[]>([])
  const [originators, setOriginators] = useState<Originator[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'all' | 'unmatched'>('all')

  // Filters
  const [filterOriginator, setFilterOriginator] = useState('')
  const [filterCode, setFilterCode] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [search, setSearch] = useState('')

  // Create/edit modal
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<ReturnEntry | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Match modal
  const [matchTarget, setMatchTarget] = useState<ReturnEntry | null>(null)
  const [candidates, setCandidates] = useState<OriginatedEntry[]>([])
  const [candidateLoading, setCandidateLoading] = useState(false)
  const [selectedEntry, setSelectedEntry] = useState('')
  const [matching, setMatching] = useState(false)
  const [matchError, setMatchError] = useState<string | null>(null)

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
      if (filterCode) params.return_code = filterCode.toUpperCase()
      if (filterCategory) params.category = filterCategory
      const [rows, un, origs] = await Promise.all([
        api.getReturns(params),
        api.getUnmatchedReturns(),
        api.getOriginators(),
      ])
      setReturns(Array.isArray(rows) ? rows : [])
      setUnmatched(Array.isArray(un) ? un : [])
      setOriginators(Array.isArray(origs) ? origs : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load returns')
    } finally {
      setLoading(false)
    }
  }, [filterOriginator, filterCode, filterCategory])

  useEffect(() => {
    load()
  }, [load])

  const source = tab === 'all' ? returns : unmatched

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return source
    return source.filter(
      (r) =>
        r.return_code.toLowerCase().includes(q) ||
        (r.external_ref ?? '').toLowerCase().includes(q) ||
        originatorName(r.originator_id).toLowerCase().includes(q),
    )
  }, [source, search, originatorName])

  const stats = useMemo(() => {
    const totalCents = returns.reduce((s, r) => s + (r.amount_cents || 0), 0)
    const unauthorized = returns.filter((r) => r.category === 'unauthorized').length
    const late = returns.filter((r) => r.is_late).length
    return {
      total: returns.length,
      unmatched: unmatched.length,
      unauthorized,
      late,
      totalCents,
    }
  }, [returns, unmatched])

  const codeDist = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of returns) map.set(r.return_code, (map.get(r.return_code) ?? 0) + 1)
    const arr = Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8)
    const max = Math.max(1, ...arr.map(([, c]) => c))
    return arr.map(([code, count]) => ({ code, count, pct: (count / max) * 100 }))
  }, [returns])

  function openCreate() {
    setEditing(null)
    setForm(emptyForm(filterOriginator || originators[0]?.id || ''))
    setFormError(null)
    setModalOpen(true)
  }

  function openEdit(r: ReturnEntry) {
    setEditing(r)
    setForm({
      originator_id: r.originator_id,
      return_code: r.return_code,
      category: r.category,
      return_date: toDateInput(r.return_date),
      amount: (r.amount_cents / 100).toFixed(2),
      external_ref: r.external_ref ?? '',
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
    if (!form.return_code.trim()) {
      setFormError('Enter a return code')
      return
    }
    const amountNum = Number(form.amount)
    if (!Number.isFinite(amountNum) || amountNum < 0) {
      setFormError('Enter a valid amount')
      return
    }
    const body: Record<string, unknown> = {
      originator_id: form.originator_id,
      return_code: form.return_code.trim().toUpperCase(),
      category: form.category,
      return_date: form.return_date ? new Date(form.return_date).toISOString() : new Date().toISOString(),
      amount_cents: Math.round(amountNum * 100),
      external_ref: form.external_ref || null,
    }
    setSaving(true)
    try {
      if (editing) await api.updateReturn(editing.id, body)
      else await api.createReturn(body)
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
      await api.deleteReturn(id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setDeletingId(null)
    }
  }

  async function openMatch(r: ReturnEntry) {
    setMatchTarget(r)
    setSelectedEntry('')
    setMatchError(null)
    setCandidates([])
    setCandidateLoading(true)
    try {
      // Pull originated entries for the same originator as match candidates.
      const rows = await api.getEntries({ originator_id: r.originator_id })
      setCandidates(Array.isArray(rows) ? rows : [])
    } catch (e) {
      setMatchError(e instanceof Error ? e.message : 'Failed to load candidate entries')
    } finally {
      setCandidateLoading(false)
    }
  }

  async function confirmMatch() {
    if (!matchTarget || !selectedEntry) {
      setMatchError('Select an originated entry to match')
      return
    }
    setMatching(true)
    setMatchError(null)
    try {
      await api.matchReturn(matchTarget.id, selectedEntry)
      setMatchTarget(null)
      await load()
    } catch (e) {
      setMatchError(e instanceof Error ? e.message : 'Match failed')
    } finally {
      setMatching(false)
    }
  }

  function resetFilters() {
    setFilterOriginator('')
    setFilterCode('')
    setFilterCategory('')
    setSearch('')
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Returns</h1>
          <p className="mt-1 text-sm text-slate-400">
            Return-entry ledger. Unauthorized and administrative returns drive your NACHA rate
            thresholds. Match returns to originated entries to close the loop.
          </p>
        </div>
        <Button onClick={openCreate} disabled={originators.length === 0}>
          + New Return
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Total Returns" value={stats.total.toLocaleString()} />
        <Stat label="Unmatched" value={stats.unmatched.toLocaleString()} tone={stats.unmatched > 0 ? 'amber' : 'emerald'} />
        <Stat label="Unauthorized" value={stats.unauthorized.toLocaleString()} tone={stats.unauthorized > 0 ? 'red' : 'emerald'} />
        <Stat label="Late Returns" value={stats.late.toLocaleString()} tone={stats.late > 0 ? 'amber' : 'emerald'} />
        <Stat label="Returned Volume" value={fmtUSD(stats.totalCents)} />
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-200">Top Return Codes</h2>
        </CardHeader>
        <CardBody className="space-y-2">
          {codeDist.length === 0 ? (
            <p className="text-sm text-slate-500">No returns recorded yet.</p>
          ) : (
            codeDist.map((d) => (
              <div key={d.code} className="flex items-center gap-3">
                <span className="w-12 font-mono text-xs text-slate-400">{d.code}</span>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full rounded-full bg-emerald-500/70" style={{ width: `${d.pct}%` }} />
                </div>
                <span className="w-10 text-right text-xs tabular-nums text-slate-400">{d.count}</span>
              </div>
            ))
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-200">Filters</h2>
        </CardHeader>
        <CardBody className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5">
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
            Return Code
            <input
              type="text"
              placeholder="e.g. R01"
              value={filterCode}
              onChange={(e) => setFilterCode(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm uppercase text-slate-100 placeholder:text-slate-600"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Category
            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            >
              <option value="">All</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Search
            <input
              type="text"
              placeholder="code / ref / originator"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
            />
          </label>
          <div className="flex items-end">
            <Button variant="ghost" onClick={resetFilters} className="px-2">
              Reset
            </Button>
          </div>
        </CardBody>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <Card>
        <CardHeader className="flex items-center justify-between">
          <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
            <button
              onClick={() => setTab('all')}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === 'all' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              All Returns
            </button>
            <button
              onClick={() => setTab('unmatched')}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === 'unmatched' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Unmatched Queue
              {stats.unmatched > 0 && (
                <span className="ml-2 rounded-full bg-amber-500/20 px-1.5 text-xs text-amber-300">
                  {stats.unmatched}
                </span>
              )}
            </button>
          </div>
          <span className="text-xs text-slate-500">{visible.length} rows</span>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <PageSpinner label="Loading returns..." />
          ) : visible.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title={tab === 'unmatched' ? 'No unmatched returns' : 'No returns'}
                description={
                  tab === 'unmatched'
                    ? 'Every return is matched to an originated entry. Nice and clean.'
                    : originators.length === 0
                    ? 'Add an originator first, then record returns to track your rates.'
                    : 'No returns match the current filters.'
                }
                action={
                  tab === 'all' && originators.length > 0 ? (
                    <Button onClick={openCreate}>+ New Return</Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Originator</TH>
                  <TH>Code</TH>
                  <TH>Category</TH>
                  <TH>Return Date</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Flags</TH>
                  <TH>Matched</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {visible.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-medium text-white">{originatorName(r.originator_id)}</TD>
                    <TD className="font-mono text-xs">{r.return_code}</TD>
                    <TD>
                      <Badge tone={categoryTone(r.category)}>{r.category}</Badge>
                    </TD>
                    <TD>{fmtDate(r.return_date)}</TD>
                    <TD className="text-right tabular-nums">{fmtUSD(r.amount_cents)}</TD>
                    <TD>
                      {r.is_late ? <Badge tone="breach">late</Badge> : <span className="text-xs text-slate-600">—</span>}
                    </TD>
                    <TD>
                      {r.matched ? (
                        <Badge tone="clear">matched</Badge>
                      ) : (
                        <Badge tone="warning">unmatched</Badge>
                      )}
                    </TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-2">
                        {!r.matched && (
                          <Button
                            variant="secondary"
                            className="px-2 py-1 text-xs"
                            onClick={() => openMatch(r)}
                          >
                            Match
                          </Button>
                        )}
                        <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => openEdit(r)}>
                          Edit
                        </Button>
                        <Button
                          variant="danger"
                          className="px-2 py-1 text-xs"
                          disabled={deletingId === r.id}
                          onClick={() => remove(r.id)}
                        >
                          {deletingId === r.id ? '...' : 'Delete'}
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

      {/* Create / edit modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Edit Return' : 'New Return Entry'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Return'}
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
              <span className="mb-1 block text-slate-300">Return Code</span>
              <input
                type="text"
                value={form.return_code}
                onChange={(e) => setForm({ ...form, return_code: e.target.value })}
                placeholder="R01"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 uppercase text-slate-100"
                required
              />
              <span className="mt-1 block text-xs text-slate-500">
                Category auto-classifies from the code on save.
              </span>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-slate-300">Category</span>
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="mb-1 block text-slate-300">Return Date</span>
              <input
                type="date"
                value={form.return_date}
                onChange={(e) => setForm({ ...form, return_date: e.target.value })}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                required
              />
            </label>
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
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-300">External Ref</span>
            <input
              type="text"
              value={form.external_ref}
              onChange={(e) => setForm({ ...form, external_ref: e.target.value })}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
            />
          </label>
        </form>
      </Modal>

      {/* Match modal */}
      <Modal
        open={!!matchTarget}
        onClose={() => setMatchTarget(null)}
        title="Match Return to Originated Entry"
        footer={
          <>
            <Button variant="ghost" onClick={() => setMatchTarget(null)} disabled={matching}>
              Cancel
            </Button>
            <Button onClick={confirmMatch} disabled={matching || !selectedEntry}>
              {matching ? 'Matching...' : 'Confirm Match'}
            </Button>
          </>
        }
      >
        {matchTarget && (
          <div className="space-y-4">
            {matchError && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {matchError}
              </div>
            )}
            <div className="rounded-lg border border-slate-800 bg-slate-950 px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Return</span>
                <Badge tone={categoryTone(matchTarget.category)}>{matchTarget.return_code}</Badge>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-slate-300">{originatorName(matchTarget.originator_id)}</span>
                <span className="tabular-nums text-white">{fmtUSD(matchTarget.amount_cents)}</span>
              </div>
            </div>
            <div>
              <span className="mb-2 block text-sm text-slate-300">Select originated entry</span>
              {candidateLoading ? (
                <PageSpinner label="Loading candidates..." />
              ) : candidates.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No originated entries found for this originator. Add an entry first.
                </p>
              ) : (
                <div className="max-h-64 space-y-2 overflow-y-auto">
                  {candidates.map((e) => (
                    <label
                      key={e.id}
                      className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${
                        selectedEntry === e.id
                          ? 'border-emerald-500/50 bg-emerald-500/10'
                          : 'border-slate-800 bg-slate-950 hover:border-slate-700'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="match-entry"
                          value={e.id}
                          checked={selectedEntry === e.id}
                          onChange={() => setSelectedEntry(e.id)}
                          className="accent-emerald-500"
                        />
                        <span className="text-slate-200">{fmtDate(e.entry_date)}</span>
                        <Badge tone="neutral">{e.sec_code}</Badge>
                        {e.trace_number && (
                          <span className="font-mono text-xs text-slate-500">{e.trace_number}</span>
                        )}
                      </span>
                      <span className="tabular-nums text-white">{fmtUSD(e.amount_cents)}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
