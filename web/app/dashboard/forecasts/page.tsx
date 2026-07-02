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

interface Forecast {
  id?: string
  originator_id?: string
  originator_name?: string
  originator?: string
  name?: string
  rate_type: string // unauthorized | admin | overall
  model: string // linear | ewma
  current_rate: number
  velocity_per_day: number
  projected_breach_date?: string | null
  days_to_breach?: number | null
  confidence: number
  computed_at?: string
}

interface WhatIfProjection {
  current_rate?: number
  projected_rate?: number
  rate?: number
  status?: string
  days_to_breach?: number | null
  projected_breach_date?: string | null
  velocity_per_day?: number
  message?: string
  [k: string]: unknown
}

const RATE_LABELS: Record<string, string> = {
  unauthorized: 'Unauthorized',
  admin: 'Administrative',
  overall: 'Overall',
}

function forecastOriginator(f: Forecast): string {
  return (
    f.originator_name ||
    f.originator ||
    f.name ||
    (f.originator_id ? `Originator ${String(f.originator_id).slice(0, 8)}` : 'Unknown')
  )
}

function fmtDate(s?: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString()
}

function pct(v?: number | null): string {
  if (v == null || Number.isNaN(v)) return '0.000%'
  return `${v.toFixed(3)}%`
}

// Tone by urgency of days-to-breach.
function breachTone(days?: number | null): 'clear' | 'watch' | 'warning' | 'breach' {
  if (days == null) return 'clear'
  if (days <= 0) return 'breach'
  if (days <= 14) return 'breach'
  if (days <= 30) return 'warning'
  if (days <= 90) return 'watch'
  return 'clear'
}

function breachLabel(days?: number | null): string {
  if (days == null) return 'No breach projected'
  if (days <= 0) return 'In breach'
  return `${days}d to breach`
}

// Horizontal urgency bar: closer breach = fuller / redder.
function UrgencyBar({ days }: { days?: number | null }) {
  // map: 0d -> 100%, >=180d -> ~5%
  const cap = 180
  const filled = days == null ? 0 : Math.max(4, Math.min(100, ((cap - Math.max(0, days)) / cap) * 100))
  const tone = breachTone(days)
  const color = tone === 'breach' ? '#f87171' : tone === 'warning' ? '#fb923c' : tone === 'watch' ? '#fbbf24' : '#334155'
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
      <div className="h-full rounded-full transition-all" style={{ width: `${filled}%`, backgroundColor: color }} />
    </div>
  )
}

export default function ForecastsPage() {
  const [forecasts, setForecasts] = useState<Forecast[]>([])
  const [ranking, setRanking] = useState<Forecast[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [recomputing, setRecomputing] = useState(false)
  const [notice, setNotice] = useState('')

  const [search, setSearch] = useState('')
  const [rateFilter, setRateFilter] = useState('all')
  const [modelFilter, setModelFilter] = useState('all')
  const [onlyBreaching, setOnlyBreaching] = useState(false)

  // What-if state
  const [wiOriginator, setWiOriginator] = useState('')
  const [wiRateType, setWiRateType] = useState('overall')
  const [wiExtraReturns, setWiExtraReturns] = useState('5')
  const [wiExtraEntries, setWiExtraEntries] = useState('0')
  const [wiResult, setWiResult] = useState<WhatIfProjection | null>(null)
  const [wiLoading, setWiLoading] = useState(false)
  const [wiError, setWiError] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [f, d] = await Promise.all([api.getForecasts(), api.getDaysToBreach()])
      setForecasts(Array.isArray(f) ? f : [])
      setRanking(Array.isArray(d) ? d : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load forecasts')
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
      const res = await api.recomputeForecasts()
      const count =
        res && typeof res === 'object' && 'computed' in res ? (res as { computed: number }).computed : undefined
      setNotice(count != null ? `Recomputed ${count} forecast${count === 1 ? '' : 's'}.` : 'Forecasts recomputed.')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recompute failed')
    } finally {
      setRecomputing(false)
    }
  }

  // Distinct originators for the what-if select (from loaded forecasts).
  const originatorOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const f of forecasts) {
      if (f.originator_id && !map.has(f.originator_id)) map.set(f.originator_id, forecastOriginator(f))
    }
    return Array.from(map, ([id, name]) => ({ id, name }))
  }, [forecasts])

  const filtered = useMemo(() => {
    let list = forecasts.slice()
    const q = search.trim().toLowerCase()
    if (q) list = list.filter((f) => forecastOriginator(f).toLowerCase().includes(q))
    if (rateFilter !== 'all') list = list.filter((f) => f.rate_type === rateFilter)
    if (modelFilter !== 'all') list = list.filter((f) => f.model === modelFilter)
    if (onlyBreaching) list = list.filter((f) => f.days_to_breach != null)
    return list
  }, [forecasts, search, rateFilter, modelFilter, onlyBreaching])

  const stats = useMemo(() => {
    const breaching = forecasts.filter((f) => f.days_to_breach != null)
    const soonest = ranking.find((f) => f.days_to_breach != null)
    const within30 = breaching.filter((f) => (f.days_to_breach ?? Infinity) <= 30).length
    return {
      total: forecasts.length,
      projected: breaching.length,
      within30,
      soonest: soonest?.days_to_breach ?? null,
      soonestName: soonest ? forecastOriginator(soonest) : null,
    }
  }, [forecasts, ranking])

  async function runWhatIf(e: React.FormEvent) {
    e.preventDefault()
    setWiError('')
    if (!wiOriginator) {
      setWiError('Select an originator')
      return
    }
    const extraReturns = parseInt(wiExtraReturns, 10)
    const extraEntries = parseInt(wiExtraEntries, 10)
    if (Number.isNaN(extraReturns) || extraReturns < 0) {
      setWiError('Extra returns must be a non-negative number')
      return
    }
    if (Number.isNaN(extraEntries) || extraEntries < 0) {
      setWiError('Extra entries must be a non-negative number')
      return
    }
    setWiLoading(true)
    setWiResult(null)
    try {
      const res = await api.forecastWhatIf({
        originator_id: wiOriginator,
        rate_type: wiRateType,
        extra_returns: extraReturns,
        extra_entries: extraEntries,
      })
      const projection =
        res && typeof res === 'object' && 'projection' in res
          ? ((res as { projection: WhatIfProjection }).projection ?? {})
          : ((res as WhatIfProjection) ?? {})
      setWiResult(projection)
    } catch (err) {
      setWiError(err instanceof Error ? err.message : 'What-if projection failed')
    } finally {
      setWiLoading(false)
    }
  }

  if (loading) return <PageSpinner label="Loading forecasts..." />

  const wiCurrent = wiResult?.current_rate
  const wiProjected = wiResult?.projected_rate ?? wiResult?.rate

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Breach Forecasts</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Projected days-to-breach per originator using linear and EWMA velocity models.
          </p>
        </div>
        <Button onClick={recompute} disabled={recomputing}>
          {recomputing ? 'Recomputing...' : 'Recompute Forecasts'}
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-700/60 bg-red-900/30 p-3 text-sm text-red-300">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg border border-amber-700/60 bg-amber-900/20 p-3 text-sm text-amber-300">
          {notice}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Forecasts" value={stats.total} />
        <Stat label="Breach Projected" value={stats.projected} tone={stats.projected ? 'amber' : 'emerald'} />
        <Stat label="Within 30 Days" value={stats.within30} tone={stats.within30 ? 'red' : 'emerald'} />
        <Stat
          label="Soonest Breach"
          value={stats.soonest != null ? `${stats.soonest}d` : 'None'}
          tone={stats.soonest != null && stats.soonest <= 30 ? 'red' : 'default'}
          hint={stats.soonestName ?? undefined}
        />
      </div>

      {/* Days-to-breach ranking */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-white">Days-to-Breach Ranking</h2>
        </CardHeader>
        <CardBody className="p-0">
          {ranking.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No breach projections"
                description="No originator is currently trending toward a breach. Recompute after loading more data."
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH className="w-8">#</TH>
                  <TH>Originator</TH>
                  <TH>Rate Type</TH>
                  <TH className="text-right">Current</TH>
                  <TH className="text-right">Velocity/day</TH>
                  <TH className="min-w-[160px]">Urgency</TH>
                  <TH className="text-right">Days</TH>
                  <TH>Projected Date</TH>
                </TR>
              </THead>
              <TBody>
                {ranking.map((f, i) => (
                  <TR key={f.id ?? `${f.originator_id}-${f.rate_type}-${i}`}>
                    <TD className="text-zinc-500 tabular-nums">{i + 1}</TD>
                    <TD className="font-medium text-white">{forecastOriginator(f)}</TD>
                    <TD>
                      <span className="text-zinc-300">{RATE_LABELS[f.rate_type] ?? f.rate_type}</span>
                      <span className="ml-2 text-[10px] uppercase text-zinc-500">{f.model}</span>
                    </TD>
                    <TD className="text-right tabular-nums">{pct(f.current_rate)}</TD>
                    <TD className="text-right tabular-nums">
                      <span className={f.velocity_per_day > 0 ? 'text-amber-300' : 'text-amber-300'}>
                        {f.velocity_per_day > 0 ? '+' : ''}
                        {f.velocity_per_day.toFixed(4)}
                      </span>
                    </TD>
                    <TD>
                      <UrgencyBar days={f.days_to_breach} />
                    </TD>
                    <TD className="text-right">
                      <Badge tone={statusTone(breachTone(f.days_to_breach))}>{breachLabel(f.days_to_breach)}</Badge>
                    </TD>
                    <TD className="whitespace-nowrap text-zinc-400">{fmtDate(f.projected_breach_date)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {/* What-if tool */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-white">What-If Projection</h2>
        </CardHeader>
        <CardBody>
          <p className="mb-4 text-sm text-zinc-400">
            Project the effect of adding returns or entries to an originator without persisting anything.
          </p>
          <form onSubmit={runWhatIf} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium text-zinc-300">Originator</label>
              <select
                value={wiOriginator}
                onChange={(e) => setWiOriginator(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:border-amber-500 focus:outline-none"
              >
                <option value="">Select originator...</option>
                {originatorOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-300">Rate Type</label>
              <select
                value={wiRateType}
                onChange={(e) => setWiRateType(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:border-amber-500 focus:outline-none"
              >
                <option value="overall">Overall</option>
                <option value="unauthorized">Unauthorized</option>
                <option value="admin">Administrative</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-300">Extra Returns</label>
              <input
                type="number"
                min="0"
                value={wiExtraReturns}
                onChange={(e) => setWiExtraReturns(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:border-amber-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-300">Extra Entries</label>
              <input
                type="number"
                min="0"
                value={wiExtraEntries}
                onChange={(e) => setWiExtraEntries(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:border-amber-500 focus:outline-none"
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-5">
              <Button type="submit" disabled={wiLoading}>
                {wiLoading ? 'Projecting...' : 'Run Projection'}
              </Button>
            </div>
          </form>

          {wiError && (
            <div className="mt-4 rounded-lg border border-red-700/60 bg-red-900/30 p-3 text-sm text-red-300">
              {wiError}
            </div>
          )}

          {wiResult && (
            <div className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Current Rate" value={pct(wiCurrent)} />
                <Stat
                  label="Projected Rate"
                  value={pct(wiProjected)}
                  tone={
                    wiProjected != null && wiCurrent != null && wiProjected > wiCurrent ? 'amber' : 'emerald'
                  }
                  hint={
                    wiProjected != null && wiCurrent != null
                      ? `${wiProjected - wiCurrent >= 0 ? '+' : ''}${(wiProjected - wiCurrent).toFixed(3)} pts`
                      : undefined
                  }
                />
                <Stat
                  label="Days to Breach"
                  value={wiResult.days_to_breach != null ? `${wiResult.days_to_breach}d` : 'None'}
                  tone={
                    wiResult.days_to_breach != null && wiResult.days_to_breach <= 30 ? 'red' : 'default'
                  }
                />
                <Stat
                  label="Status"
                  value={
                    wiResult.status ? (
                      <Badge tone={statusTone(wiResult.status)}>{wiResult.status}</Badge>
                    ) : (
                      '—'
                    )
                  }
                />
              </div>
              {wiResult.projected_breach_date && (
                <p className="mt-3 text-xs text-zinc-500">
                  Projected breach date: {fmtDate(wiResult.projected_breach_date)}
                </p>
              )}
              {wiResult.message && <p className="mt-2 text-sm text-zinc-400">{wiResult.message}</p>}
            </div>
          )}
        </CardBody>
      </Card>

      {/* All forecasts with filters */}
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-white">All Forecasts ({filtered.length})</h2>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search originators..."
              className="min-w-[160px] rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-white placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
            />
            <select
              value={rateFilter}
              onChange={(e) => setRateFilter(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-white focus:border-amber-500 focus:outline-none"
            >
              <option value="all">All rates</option>
              <option value="unauthorized">Unauthorized</option>
              <option value="admin">Administrative</option>
              <option value="overall">Overall</option>
            </select>
            <select
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-white focus:border-amber-500 focus:outline-none"
            >
              <option value="all">All models</option>
              <option value="linear">Linear</option>
              <option value="ewma">EWMA</option>
            </select>
            <label className="flex items-center gap-2 text-sm text-zinc-400">
              <input
                type="checkbox"
                checked={onlyBreaching}
                onChange={(e) => setOnlyBreaching(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 accent-amber-500"
              />
              Breaching only
            </label>
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {filtered.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title={forecasts.length === 0 ? 'No forecasts yet' : 'No forecasts match your filters'}
                description={
                  forecasts.length === 0
                    ? 'Recompute forecasts after loading entries and returns.'
                    : 'Adjust the search, rate, or model filters.'
                }
                action={
                  forecasts.length === 0 ? (
                    <Button onClick={recompute} disabled={recomputing}>
                      {recomputing ? 'Recomputing...' : 'Recompute Forecasts'}
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
                  <TH>Rate Type</TH>
                  <TH>Model</TH>
                  <TH className="text-right">Current</TH>
                  <TH className="text-right">Velocity/day</TH>
                  <TH className="text-right">Confidence</TH>
                  <TH className="text-right">Days</TH>
                  <TH>Projected Date</TH>
                </TR>
              </THead>
              <TBody>
                {filtered.map((f, i) => (
                  <TR key={f.id ?? `${f.originator_id}-${f.rate_type}-${f.model}-${i}`}>
                    <TD className="font-medium text-white">{forecastOriginator(f)}</TD>
                    <TD className="text-zinc-300">{RATE_LABELS[f.rate_type] ?? f.rate_type}</TD>
                    <TD>
                      <Badge tone="info">{f.model}</Badge>
                    </TD>
                    <TD className="text-right tabular-nums">{pct(f.current_rate)}</TD>
                    <TD className="text-right tabular-nums">
                      <span className={f.velocity_per_day > 0 ? 'text-amber-300' : 'text-amber-300'}>
                        {f.velocity_per_day > 0 ? '+' : ''}
                        {f.velocity_per_day.toFixed(4)}
                      </span>
                    </TD>
                    <TD className="text-right tabular-nums text-zinc-400">
                      {Math.round((f.confidence ?? 0) * 100)}%
                    </TD>
                    <TD className="text-right">
                      <Badge tone={statusTone(breachTone(f.days_to_breach))}>{breachLabel(f.days_to_breach)}</Badge>
                    </TD>
                    <TD className="whitespace-nowrap text-zinc-400">{fmtDate(f.projected_breach_date)}</TD>
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
