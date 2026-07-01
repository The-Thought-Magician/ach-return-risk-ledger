'use client'

import { useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Card, CardHeader, CardBody } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge, statusTone } from '@/components/ui/Badge'
import { Stat } from '@/components/ui/Stat'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageSpinner } from '@/components/ui/Spinner'

// ---------------------------------------------------------------------------
// Types (defensive — backend returns rate_snapshot columns + originator info)
// ---------------------------------------------------------------------------
interface RateRow {
  id?: string
  originator_id?: string | null
  originator_name?: string
  originator?: string
  name?: string
  window_days?: number
  as_of?: string
  debit_count?: number
  total_returns?: number
  unauthorized_rate?: number
  admin_rate?: number
  overall_rate?: number
  unauthorized_status?: string
  admin_status?: string
  overall_status?: string
}

type RateKind = 'unauthorized' | 'admin' | 'overall'

// NACHA reference limits (display only; actual limits come from thresholds page)
const LIMITS: Record<RateKind, number> = { unauthorized: 0.5, admin: 3.0, overall: 15.0 }
const RATE_LABELS: Record<RateKind, string> = {
  unauthorized: 'Unauthorized',
  admin: 'Administrative',
  overall: 'Overall',
}

function originatorLabel(r: RateRow): string {
  return r.originator_name || r.originator || r.name || (r.originator_id ? `Originator ${String(r.originator_id).slice(0, 8)}` : 'Portfolio')
}

function pct(v?: number): string {
  if (v == null || Number.isNaN(v)) return '0.000%'
  return `${v.toFixed(3)}%`
}

function rateOf(r: RateRow, k: RateKind): number {
  if (k === 'unauthorized') return r.unauthorized_rate ?? 0
  if (k === 'admin') return r.admin_rate ?? 0
  return r.overall_rate ?? 0
}

function statusOf(r: RateRow, k: RateKind): string {
  if (k === 'unauthorized') return r.unauthorized_status ?? 'clear'
  if (k === 'admin') return r.admin_status ?? 'clear'
  return r.overall_status ?? 'clear'
}

// Headroom = how much of the limit remains before breach.
function headroom(rate: number, limit: number): number {
  return Math.max(0, limit - rate)
}
function utilization(rate: number, limit: number): number {
  if (!limit) return 0
  return Math.min(100, (rate / limit) * 100)
}

function statusColorHex(status: string): string {
  switch (status.toLowerCase()) {
    case 'breach':
      return '#f87171'
    case 'warning':
      return '#fb923c'
    case 'watch':
      return '#fbbf24'
    default:
      return '#34d399'
  }
}

// Compact horizontal utilization meter (no chart libs).
function RateMeter({ rate, limit, status }: { rate: number; limit: number; status: string }) {
  const util = utilization(rate, limit)
  const color = statusColorHex(status)
  // marker positions for watch (60%) and warning (80%) bands relative to limit
  return (
    <div className="min-w-[140px]">
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-800">
        <div className="h-full rounded-full transition-all" style={{ width: `${util}%`, backgroundColor: color }} />
        <span className="absolute top-0 h-full w-px bg-amber-400/50" style={{ left: '60%' }} title="Watch (60%)" />
        <span className="absolute top-0 h-full w-px bg-orange-400/60" style={{ left: '80%' }} title="Warning (80%)" />
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-slate-500">
        <span>{pct(rate)}</span>
        <span>limit {limit}%</span>
      </div>
    </div>
  )
}

export default function RatesPage() {
  const [rates, setRates] = useState<RateRow[]>([])
  const [portfolio, setPortfolio] = useState<RateRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [recomputing, setRecomputing] = useState(false)
  const [notice, setNotice] = useState('')

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [rateFocus, setRateFocus] = useState<'all' | RateKind>('all')
  const [sortKey, setSortKey] = useState<RateKind>('overall')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [r, p] = await Promise.all([api.getRates(), api.getPortfolioRate()])
      const flattened = Array.isArray(r)
        ? r.map((row: RateRow & { snapshot?: RateRow | null }) => ({ ...row, ...(row.snapshot ?? {}) }))
        : []
      setRates(flattened)
      setPortfolio(p && typeof p === 'object' ? p : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load rates')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function recompute() {
    setRecomputing(true)
    setNotice('')
    setError('')
    try {
      const res = await api.recomputeRates()
      const count = res && typeof res === 'object' && 'computed' in res ? (res as { computed: number }).computed : undefined
      setNotice(count != null ? `Recomputed ${count} snapshot${count === 1 ? '' : 's'}.` : 'Snapshots recomputed.')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recompute failed')
    } finally {
      setRecomputing(false)
    }
  }

  // Worst status across an originator's three rates, for status filtering / counts.
  function worstStatus(r: RateRow): string {
    const order = ['clear', 'watch', 'warning', 'breach']
    return ([statusOf(r, 'unauthorized'), statusOf(r, 'admin'), statusOf(r, 'overall')] as string[]).reduce(
      (worst, s) => (order.indexOf(s) > order.indexOf(worst) ? s : worst),
      'clear',
    )
  }

  const counts = useMemo(() => {
    const c = { clear: 0, watch: 0, warning: 0, breach: 0 }
    for (const r of rates) {
      const s = worstStatus(r) as keyof typeof c
      if (s in c) c[s]++
    }
    return c
  }, [rates])

  const filtered = useMemo(() => {
    let list = rates.slice()
    const q = search.trim().toLowerCase()
    if (q) list = list.filter((r) => originatorLabel(r).toLowerCase().includes(q))
    if (statusFilter !== 'all') list = list.filter((r) => worstStatus(r) === statusFilter)
    if (rateFocus !== 'all') {
      // only keep rows that are at least 'watch' on the focused rate when focusing
      list = list.filter((r) => statusOf(r, rateFocus) !== 'clear' || rateOf(r, rateFocus) > 0)
    }
    list.sort((a, b) => rateOf(b, sortKey) - rateOf(a, sortKey))
    return list
  }, [rates, search, statusFilter, rateFocus, sortKey])

  if (loading) return <PageSpinner label="Loading threshold monitor..." />

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Threshold Monitor</h1>
          <p className="mt-1 text-sm text-slate-400">
            Rolling return rates per originator versus NACHA limits, with headroom and status.
          </p>
        </div>
        <Button onClick={recompute} disabled={recomputing}>
          {recomputing ? 'Recomputing...' : 'Recompute Rates'}
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-700/60 bg-red-900/30 p-3 text-sm text-red-300">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-700/60 bg-emerald-900/20 p-3 text-sm text-emerald-300">
          {notice}
        </div>
      )}

      {/* Portfolio-wide gauges */}
      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Portfolio-Wide Rates</h2>
          {portfolio?.as_of && (
            <span className="text-xs text-slate-500">
              as of {new Date(portfolio.as_of).toLocaleString()} · {portfolio.window_days ?? 60}d window
            </span>
          )}
        </CardHeader>
        <CardBody>
          {portfolio ? (
            <div className="grid gap-4 sm:grid-cols-3">
              {(['unauthorized', 'admin', 'overall'] as RateKind[]).map((k) => {
                const rate = rateOf(portfolio, k)
                const status = statusOf(portfolio, k)
                const limit = LIMITS[k]
                return (
                  <div key={k} className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                        {RATE_LABELS[k]}
                      </span>
                      <Badge tone={statusTone(status)}>{status}</Badge>
                    </div>
                    <div className="mt-2 text-3xl font-semibold tabular-nums text-white">{pct(rate)}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      headroom {pct(headroom(rate, limit))} of {limit}% limit
                    </div>
                    <div className="mt-3">
                      <RateMeter rate={rate} limit={limit} status={status} />
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              No portfolio snapshot yet. Run a recompute after adding entries and returns.
            </p>
          )}
          {portfolio && (
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Stat label="Debit Entries" value={(portfolio.debit_count ?? 0).toLocaleString()} />
              <Stat label="Total Returns" value={(portfolio.total_returns ?? 0).toLocaleString()} />
              <Stat
                label="Worst Status"
                value={<Badge tone={statusTone(worstStatus(portfolio))}>{worstStatus(portfolio)}</Badge>}
              />
            </div>
          )}
        </CardBody>
      </Card>

      {/* Status counts */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Clear" value={counts.clear} tone="emerald" />
        <Stat label="Watch" value={counts.watch} tone="amber" />
        <Stat label="Warning" value={counts.warning} tone="amber" />
        <Stat label="Breach" value={counts.breach} tone="red" />
      </div>

      {/* Filters */}
      <Card>
        <CardBody className="flex flex-wrap items-center gap-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search originators..."
            className="min-w-[200px] flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
          >
            <option value="all">All statuses</option>
            <option value="clear">Clear</option>
            <option value="watch">Watch</option>
            <option value="warning">Warning</option>
            <option value="breach">Breach</option>
          </select>
          <select
            value={rateFocus}
            onChange={(e) => setRateFocus(e.target.value as 'all' | RateKind)}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
          >
            <option value="all">All rate types</option>
            <option value="unauthorized">Unauthorized</option>
            <option value="admin">Administrative</option>
            <option value="overall">Overall</option>
          </select>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as RateKind)}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
          >
            <option value="overall">Sort by overall</option>
            <option value="unauthorized">Sort by unauthorized</option>
            <option value="admin">Sort by administrative</option>
          </select>
        </CardBody>
      </Card>

      {/* Per-originator table */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-white">Per-Originator Rates ({filtered.length})</h2>
        </CardHeader>
        <CardBody className="p-0">
          {filtered.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title={rates.length === 0 ? 'No rate snapshots yet' : 'No originators match your filters'}
                description={
                  rates.length === 0
                    ? 'Add originators, entries and returns, then recompute to populate the monitor.'
                    : 'Adjust the search or status filter above.'
                }
                action={
                  rates.length === 0 ? (
                    <Button onClick={recompute} disabled={recomputing}>
                      {recomputing ? 'Recomputing...' : 'Recompute Rates'}
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Originator</TH>
                  <TH className="text-right">Unauthorized</TH>
                  <TH className="text-right">Administrative</TH>
                  <TH className="text-right">Overall</TH>
                  <TH className="text-right">Debits</TH>
                  <TH className="text-right">Returns</TH>
                </TR>
              </THead>
              <TBody>
                {filtered.map((r, i) => (
                  <TR key={r.id ?? r.originator_id ?? i}>
                    <TD className="font-medium text-white">
                      <div>{originatorLabel(r)}</div>
                      {r.as_of && (
                        <div className="text-[11px] text-slate-500">
                          {r.window_days ?? 60}d · {new Date(r.as_of).toLocaleDateString()}
                        </div>
                      )}
                    </TD>
                    {(['unauthorized', 'admin', 'overall'] as RateKind[]).map((k) => {
                      const rate = rateOf(r, k)
                      const status = statusOf(r, k)
                      const limit = LIMITS[k]
                      return (
                        <TD key={k} className="text-right align-top">
                          <div className="flex flex-col items-end gap-1.5">
                            <Badge tone={statusTone(status)}>{status}</Badge>
                            <RateMeter rate={rate} limit={limit} status={status} />
                            <span className="text-[10px] text-slate-500">
                              headroom {pct(headroom(rate, limit))}
                            </span>
                          </div>
                        </TD>
                      )
                    })}
                    <TD className="text-right tabular-nums">{(r.debit_count ?? 0).toLocaleString()}</TD>
                    <TD className="text-right tabular-nums">{(r.total_returns ?? 0).toLocaleString()}</TD>
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
