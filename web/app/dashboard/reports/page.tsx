'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Stat } from '@/components/ui/Stat'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageSpinner } from '@/components/ui/Spinner'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'
import { Modal } from '@/components/ui/Modal'

interface Originator {
  id: string
  name: string
  status?: string
}

interface ReportRow {
  id: string
  name: string
  originator_id: string | null
  originator_name?: string | null
  period_start: string
  period_end: string
  recurring?: boolean
  payload?: Record<string, unknown> | null
  created_by?: string
  created_at?: string
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function fmtDate(v?: string | null): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function fmtPct(v: unknown): string {
  return `${num(v).toFixed(2)}%`
}

function fmtCents(v: unknown): string {
  return `$${(num(v) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function monthsAgoISO(months: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - months)
  return d.toISOString().slice(0, 10)
}

// Renders an arbitrary report payload section as labeled key/value chips.
function PayloadGrid({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => typeof v !== 'object' || v === null)
  if (entries.length === 0) return null
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {entries.map(([k, v]) => (
        <div key={k} className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">{k.replace(/_/g, ' ')}</div>
          <div className="mt-0.5 text-sm font-medium tabular-nums text-slate-200">
            {typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v ?? '—')}
          </div>
        </div>
      ))}
    </div>
  )
}

export default function ReportsPage() {
  const [reports, setReports] = useState<ReportRow[]>([])
  const [originators, setOriginators] = useState<Originator[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [originatorFilter, setOriginatorFilter] = useState('')

  // Generate form
  const [genOpen, setGenOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [form, setForm] = useState({
    name: '',
    originator_id: '',
    period_start: monthsAgoISO(1),
    period_end: todayISO(),
    recurring: false,
  })

  // Detail viewer
  const [detail, setDetail] = useState<ReportRow | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // Delete confirm
  const [toDelete, setToDelete] = useState<ReportRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [reps, orgs] = await Promise.all([
        api.getReports(),
        api.getOriginators().catch(() => []),
      ])
      setReports(Array.isArray(reps) ? reps : [])
      setOriginators(Array.isArray(orgs) ? orgs : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load reports')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const originatorName = useCallback(
    (id: string | null | undefined): string => {
      if (!id) return 'Portfolio-wide'
      const o = originators.find((x) => x.id === id)
      return o ? o.name : id
    },
    [originators],
  )

  const openGenerate = () => {
    setForm({
      name: '',
      originator_id: '',
      period_start: monthsAgoISO(1),
      period_end: todayISO(),
      recurring: false,
    })
    setGenOpen(true)
  }

  const generate = async () => {
    if (!form.period_start || !form.period_end) {
      setError('Period start and end are required')
      return
    }
    if (form.period_start > form.period_end) {
      setError('Period start must be on or before period end')
      return
    }
    setGenerating(true)
    setError(null)
    setActionMsg(null)
    try {
      const body: Record<string, unknown> = {
        name:
          form.name.trim() ||
          `Compliance report ${fmtDate(form.period_start)} – ${fmtDate(form.period_end)}`,
        period_start: form.period_start,
        period_end: form.period_end,
        recurring: form.recurring,
      }
      if (form.originator_id) body.originator_id = form.originator_id
      const created = (await api.generateReport(body)) as ReportRow
      setActionMsg(`Generated report "${created.name}"`)
      setGenOpen(false)
      await load()
      // Open the freshly generated report so the user sees the payload.
      if (created && created.id) void openDetail(created.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Report generation failed')
    } finally {
      setGenerating(false)
    }
  }

  const openDetail = async (id: string) => {
    setDetailLoading(true)
    setError(null)
    try {
      const r = (await api.getReport(id)) as ReportRow
      setDetail(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load report')
    } finally {
      setDetailLoading(false)
    }
  }

  const confirmDelete = async () => {
    if (!toDelete) return
    setDeleting(true)
    setError(null)
    try {
      await api.deleteReport(toDelete.id)
      setReports((prev) => prev.filter((r) => r.id !== toDelete.id))
      if (detail?.id === toDelete.id) setDetail(null)
      setActionMsg(`Deleted report "${toDelete.name}"`)
      setToDelete(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete report')
    } finally {
      setDeleting(false)
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return reports
      .filter((r) => {
        if (originatorFilter === 'portfolio' && r.originator_id) return false
        if (originatorFilter && originatorFilter !== 'portfolio' && r.originator_id !== originatorFilter)
          return false
        if (q) {
          const hay = `${r.name} ${originatorName(r.originator_id)}`.toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  }, [reports, search, originatorFilter, originatorName])

  const recurringCount = useMemo(() => reports.filter((r) => r.recurring).length, [reports])
  const portfolioCount = useMemo(() => reports.filter((r) => !r.originator_id).length, [reports])

  // Pull headline metrics out of a payload regardless of exact key naming.
  const payloadSummary = useMemo(() => {
    if (!detail?.payload) return null
    const p = detail.payload as Record<string, unknown>
    const scalar = Object.fromEntries(
      Object.entries(p).filter(([, v]) => typeof v !== 'object' || v === null),
    )
    const sections = Object.entries(p).filter(([, v]) => typeof v === 'object' && v !== null)
    return { scalar, sections }
  }, [detail])

  if (loading) return <PageSpinner label="Loading reports..." />

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Compliance Reports</h1>
          <p className="mt-1 text-sm text-slate-400">
            Generate point-in-time NACHA return-rate compliance reports for any originator or the full
            portfolio, then archive and review the snapshot.
          </p>
        </div>
        <Button onClick={openGenerate}>Generate report</Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {actionMsg && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          {actionMsg}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total reports" value={reports.length} />
        <Stat label="Portfolio-wide" value={portfolioCount} tone="sky" />
        <Stat label="Originator-scoped" value={reports.length - portfolioCount} />
        <Stat label="Recurring" value={recurringCount} tone={recurringCount > 0 ? 'emerald' : 'default'} />
      </div>

      <Card>
        <CardHeader className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search reports..."
            className="w-56 rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none"
          />
          <select
            value={originatorFilter}
            onChange={(e) => setOriginatorFilter(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500/50 focus:outline-none"
          >
            <option value="">All scopes</option>
            <option value="portfolio">Portfolio-wide</option>
            {originators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <span className="ml-auto text-xs text-slate-500">
            {filtered.length} of {reports.length}
          </span>
        </CardHeader>
        <CardBody className="p-0">
          {filtered.length === 0 ? (
            <EmptyState
              title={reports.length === 0 ? 'No reports yet' : 'No matches'}
              description={
                reports.length === 0
                  ? 'Generate your first compliance report to snapshot return rates for a period.'
                  : 'Adjust your search or scope filter.'
              }
              action={
                reports.length === 0 ? <Button onClick={openGenerate}>Generate report</Button> : undefined
              }
            />
          ) : (
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Report</TH>
                  <TH>Scope</TH>
                  <TH>Period</TH>
                  <TH>Recurring</TH>
                  <TH>Generated</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {filtered.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-medium text-white">{r.name}</TD>
                    <TD>
                      {r.originator_id ? (
                        <span className="text-slate-300">{originatorName(r.originator_id)}</span>
                      ) : (
                        <Badge tone="info">Portfolio</Badge>
                      )}
                    </TD>
                    <TD className="whitespace-nowrap text-slate-300">
                      {fmtDate(r.period_start)} <span className="text-slate-600">→</span> {fmtDate(r.period_end)}
                    </TD>
                    <TD>
                      {r.recurring ? (
                        <Badge tone="clear">Recurring</Badge>
                      ) : (
                        <span className="text-slate-500">One-off</span>
                      )}
                    </TD>
                    <TD className="whitespace-nowrap text-slate-400">{fmtDate(r.created_at)}</TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="secondary" onClick={() => openDetail(r.id)}>
                          View
                        </Button>
                        <Button variant="danger" onClick={() => setToDelete(r)}>
                          Delete
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

      {/* Generate modal */}
      <Modal
        open={genOpen}
        onClose={() => setGenOpen(false)}
        title="Generate compliance report"
        footer={
          <>
            <Button variant="ghost" onClick={() => setGenOpen(false)}>
              Cancel
            </Button>
            <Button onClick={generate} disabled={generating}>
              {generating ? 'Generating...' : 'Generate'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
              Report name
            </label>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Auto-named from period if left blank"
              className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
              Scope
            </label>
            <select
              value={form.originator_id}
              onChange={(e) => setForm((f) => ({ ...f, originator_id: e.target.value }))}
              className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500/50 focus:outline-none"
            >
              <option value="">Portfolio-wide (all originators)</option>
              {originators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
                Period start
              </label>
              <input
                type="date"
                value={form.period_start}
                onChange={(e) => setForm((f) => ({ ...f, period_start: e.target.value }))}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
                Period end
              </label>
              <input
                type="date"
                value={form.period_end}
                onChange={(e) => setForm((f) => ({ ...f, period_end: e.target.value }))}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500/50 focus:outline-none"
              />
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={form.recurring}
              onChange={(e) => setForm((f) => ({ ...f, recurring: e.target.checked }))}
              className="h-4 w-4 rounded border-slate-700 bg-slate-950 text-emerald-500 focus:ring-emerald-500/50"
            />
            Mark as recurring (regenerate on each period)
          </label>
        </div>
      </Modal>

      {/* Detail modal */}
      <Modal
        open={!!detail || detailLoading}
        onClose={() => setDetail(null)}
        title={detail ? detail.name : 'Report'}
        className="max-w-2xl"
        footer={
          detail ? (
            <>
              <Button
                variant="danger"
                onClick={() => {
                  setToDelete(detail)
                  setDetail(null)
                }}
              >
                Delete
              </Button>
              <Button variant="ghost" onClick={() => setDetail(null)}>
                Close
              </Button>
            </>
          ) : undefined
        }
      >
        {detailLoading ? (
          <div className="py-8">
            <PageSpinner label="Loading report..." />
          </div>
        ) : detail ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {detail.originator_id ? (
                <Badge tone="neutral">{originatorName(detail.originator_id)}</Badge>
              ) : (
                <Badge tone="info">Portfolio-wide</Badge>
              )}
              {detail.recurring && <Badge tone="clear">Recurring</Badge>}
              <Badge tone="neutral">
                {fmtDate(detail.period_start)} → {fmtDate(detail.period_end)}
              </Badge>
            </div>

            {payloadSummary && Object.keys(payloadSummary.scalar).length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Summary metrics
                </h3>
                <PayloadGrid data={payloadSummary.scalar} />
              </div>
            )}

            {payloadSummary?.sections.map(([key, val]) => {
              if (Array.isArray(val)) {
                const rows = val as Record<string, unknown>[]
                if (rows.length === 0) return null
                const cols = Array.from(
                  rows.reduce((set, row) => {
                    Object.keys(row).forEach((k) => set.add(k))
                    return set
                  }, new Set<string>()),
                ).slice(0, 6)
                return (
                  <div key={key}>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {key.replace(/_/g, ' ')}
                    </h3>
                    <div className="overflow-hidden rounded-lg border border-slate-800">
                      <Table>
                        <THead>
                          <TR className="hover:bg-transparent">
                            {cols.map((c) => (
                              <TH key={c}>{c.replace(/_/g, ' ')}</TH>
                            ))}
                          </TR>
                        </THead>
                        <TBody>
                          {rows.slice(0, 25).map((row, i) => (
                            <TR key={i}>
                              {cols.map((c) => {
                                const cell = row[c]
                                let text: string
                                if (cell == null) text = '—'
                                else if (/rate|pct|percent/i.test(c)) text = fmtPct(cell)
                                else if (/cents|amount/i.test(c)) text = fmtCents(cell)
                                else text = String(cell)
                                return (
                                  <TD key={c} className="tabular-nums">
                                    {text}
                                  </TD>
                                )
                              })}
                            </TR>
                          ))}
                        </TBody>
                      </Table>
                    </div>
                  </div>
                )
              }
              return (
                <div key={key}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {key.replace(/_/g, ' ')}
                  </h3>
                  <PayloadGrid data={val as Record<string, unknown>} />
                </div>
              )
            })}

            {(!detail.payload || Object.keys(detail.payload).length === 0) && (
              <p className="text-sm text-slate-500">This report has no stored payload.</p>
            )}
          </div>
        ) : null}
      </Modal>

      {/* Delete confirm */}
      <Modal
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete report"
        footer={
          <>
            <Button variant="ghost" onClick={() => setToDelete(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete} disabled={deleting}>
              {deleting ? 'Deleting...' : 'Delete'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-300">
          Delete <span className="font-medium text-white">{toDelete?.name}</span>? This permanently
          removes the archived compliance snapshot.
        </p>
      </Modal>
    </div>
  )
}
