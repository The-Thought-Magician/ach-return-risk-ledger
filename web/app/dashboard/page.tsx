'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import api from '@/lib/api'
import { Card, CardHeader, CardBody } from '@/components/ui/card'
import { Stat } from '@/components/ui/Stat'
import { Badge, statusTone } from '@/components/ui/Badge'
import { PageSpinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/button'

type RateBlock = {
  unauthorized_rate?: number
  admin_rate?: number
  overall_rate?: number
  unauthorized_status?: string
  admin_status?: string
  overall_status?: string
  debit_count?: number
  total_returns?: number
} | null

interface Summary {
  statusCounts?: Record<string, number>
  portfolioRates?: RateBlock
  exposure?: { openCount?: number; openCents?: number; expiringSoon?: number }
  feesPeriod?: { totalCents?: number; count?: number; recoveredCents?: number }
  atRisk?: Array<{
    id: string
    name: string
    overall_rate?: number
    overall_status?: string
    unauthorized_rate?: number
    unauthorized_status?: string
  }>
  recentAlerts?: Array<{
    id: string
    title: string
    severity?: string
    status?: string
    fired_at?: string
  }>
  sparklines?: Record<string, number[]>
}

interface Forecast {
  id: string
  originator_id: string
  originator_name?: string
  rate_type?: string
  current_rate?: number
  days_to_breach?: number | null
  projected_breach_date?: string | null
  velocity_per_day?: number
}

interface Alert {
  id: string
  title: string
  body?: string
  severity?: string
  status?: string
  fired_at?: string
  originator_id?: string
}

function pct(n?: number) {
  if (n == null || Number.isNaN(n)) return '0.00%'
  return `${n.toFixed(2)}%`
}

function money(cents?: number) {
  if (cents == null) return '$0'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
}

function fmtDate(s?: string | null) {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// NACHA reference limits for the gauge reference bands.
const LIMITS: Record<string, number> = { unauthorized: 0.5, admin: 3, overall: 15 }

function RateGauge({
  label,
  rate,
  status,
  limit,
}: {
  label: string
  rate?: number
  status?: string
  limit: number
}) {
  const value = rate ?? 0
  const fillPct = Math.min(100, (value / limit) * 100)
  const tone = statusTone(status)
  const barColor =
    tone === 'breach'
      ? 'bg-red-500'
      : tone === 'warning'
        ? 'bg-orange-500'
        : tone === 'watch'
          ? 'bg-amber-500'
          : 'bg-emerald-500'
  const headroom = Math.max(0, limit - value)
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
        <Badge tone={tone}>{status ?? 'n/a'}</Badge>
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-white">{pct(value)}</div>
      <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${fillPct}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-slate-500">
        <span>limit {pct(limit)}</span>
        <span>headroom {pct(headroom)}</span>
      </div>
    </div>
  )
}

function Sparkline({ data, tone = 'emerald' }: { data: number[]; tone?: string }) {
  if (!data || data.length === 0) {
    return <div className="h-10 w-full rounded bg-slate-800/40" />
  }
  const w = 120
  const h = 36
  const max = Math.max(...data, 0.0001)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const step = data.length > 1 ? w / (data.length - 1) : w
  const points = data
    .map((v, i) => {
      const x = i * step
      const y = h - ((v - min) / range) * h
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const stroke =
    tone === 'red' ? '#f87171' : tone === 'amber' ? '#fbbf24' : tone === 'sky' ? '#38bdf8' : '#34d399'
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-10 w-full" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function DashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [breach, setBreach] = useState<Forecast[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [s, b, a] = await Promise.all([
        api.getDashboardSummary(),
        api.getDaysToBreach(),
        api.getAlerts({ status: 'open' }),
      ])
      setSummary(s ?? {})
      setBreach(Array.isArray(b) ? b : [])
      setAlerts(Array.isArray(a) ? a : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load dashboard')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  if (loading) return <PageSpinner label="Loading portfolio overview..." />

  if (error) {
    return (
      <div className="mx-auto max-w-2xl">
        <EmptyState
          title="Could not load the dashboard"
          description={error}
          action={
            <Button variant="secondary" onClick={load}>
              Retry
            </Button>
          }
        />
      </div>
    )
  }

  const s = summary ?? {}
  const counts = s.statusCounts ?? {}
  const rates = s.portfolioRates ?? null
  const exposure = s.exposure ?? {}
  const fees = s.feesPeriod ?? {}
  const atRisk = s.atRisk ?? []
  const recentAlerts = alerts.length ? alerts : s.recentAlerts ?? []
  const sparklines = s.sparklines ?? {}

  const totalOriginators = Object.values(counts).reduce((acc, n) => acc + (n || 0), 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Portfolio Overview</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            NACHA return-rate posture across {totalOriginators} originator{totalOriginators === 1 ? '' : 's'}.
          </p>
        </div>
        <Button variant="secondary" onClick={load}>
          Refresh
        </Button>
      </div>

      {/* Status counts */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Originators" value={totalOriginators} />
        <Stat label="Clear" value={counts.clear ?? 0} tone="emerald" />
        <Stat label="Watch" value={counts.watch ?? 0} tone="amber" />
        <Stat label="Warning" value={counts.warning ?? 0} tone="amber" />
        <Stat label="Breach" value={counts.breach ?? 0} tone="red" />
      </div>

      {/* Portfolio rate gauges */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-white">Portfolio Return Rates</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Rolling-window rates vs NACHA thresholds. Denominator {rates?.debit_count ?? 0} debit entries,{' '}
            {rates?.total_returns ?? 0} returns.
          </p>
        </CardHeader>
        <CardBody>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <RateGauge
              label="Unauthorized"
              rate={rates?.unauthorized_rate}
              status={rates?.unauthorized_status}
              limit={LIMITS.unauthorized}
            />
            <RateGauge
              label="Administrative"
              rate={rates?.admin_rate}
              status={rates?.admin_status}
              limit={LIMITS.admin}
            />
            <RateGauge
              label="Overall"
              rate={rates?.overall_rate}
              status={rates?.overall_status}
              limit={LIMITS.overall}
            />
          </div>
        </CardBody>
      </Card>

      {/* Exposure + fees */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Open Dispute Exposure"
          value={money(exposure.openCents)}
          hint={`${exposure.openCount ?? 0} open windows`}
          tone="sky"
        />
        <Stat
          label="Windows Expiring Soon"
          value={exposure.expiringSoon ?? 0}
          hint="within dispute deadline"
          tone="amber"
        />
        <Stat
          label="Fees This Period"
          value={money(fees.totalCents)}
          hint={`${fees.count ?? 0} fee records`}
          tone="red"
        />
        <Stat
          label="Recovered This Period"
          value={money(fees.recoveredCents)}
          hint="via re-presentment"
          tone="emerald"
        />
      </div>

      {/* Sparklines */}
      {Object.keys(sparklines).length > 0 && (
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-white">Trend Sparklines</h2>
          </CardHeader>
          <CardBody>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {Object.entries(sparklines).map(([key, series]) => {
                const tone = key.includes('unauth') || key.includes('breach') ? 'red' : key.includes('admin') ? 'amber' : 'emerald'
                const values = (series ?? []).map((p: number | { value?: number }) =>
                  typeof p === 'number' ? p : Number(p?.value ?? 0),
                )
                const last = values.length ? values[values.length - 1] : 0
                return (
                  <div key={key} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                        {key.replace(/_/g, ' ')}
                      </span>
                      <span className="text-sm font-semibold tabular-nums text-slate-200">
                        {pct(last)}
                      </span>
                    </div>
                    <div className="mt-3">
                      <Sparkline data={values} tone={tone} />
                    </div>
                  </div>
                )
              })}
            </div>
          </CardBody>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* At-risk originators */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Top At-Risk Originators</h2>
            <Link href="/dashboard/forecasts" className="text-xs font-medium text-emerald-400 hover:text-emerald-300">
              View forecasts →
            </Link>
          </CardHeader>
          <CardBody className="space-y-2">
            {atRisk.length === 0 && breach.length === 0 ? (
              <EmptyState title="No at-risk originators" description="All originators are within thresholds." />
            ) : (
              (atRisk.length ? atRisk : breach).slice(0, 8).map((row: any) => {
                const id = row.id ?? row.originator_id
                const name = row.name ?? row.originator_name ?? 'Originator'
                const rate = row.overall_rate ?? row.current_rate
                const status = row.overall_status ?? row.unauthorized_status
                const dtb = row.days_to_breach
                return (
                  <Link
                    key={id}
                    href={`/dashboard/originators/${id}`}
                    className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2.5 transition-colors hover:border-slate-700 hover:bg-slate-800/40"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-200">{name}</div>
                      <div className="text-xs text-slate-500">
                        {rate != null ? pct(rate) : '—'}
                        {dtb != null && ` · breach in ${dtb}d`}
                      </div>
                    </div>
                    {status && <Badge tone={statusTone(status)}>{status}</Badge>}
                  </Link>
                )
              })
            )}
          </CardBody>
        </Card>

        {/* Recent alerts */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Recent Alerts</h2>
            <Link href="/dashboard/alerts" className="text-xs font-medium text-emerald-400 hover:text-emerald-300">
              View inbox →
            </Link>
          </CardHeader>
          <CardBody className="space-y-2">
            {recentAlerts.length === 0 ? (
              <EmptyState title="No open alerts" description="Nothing needs attention right now." />
            ) : (
              recentAlerts.slice(0, 8).map((alert: any) => (
                <div
                  key={alert.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-200">{alert.title}</div>
                    <div className="text-xs text-slate-500">{fmtDate(alert.fired_at)}</div>
                  </div>
                  <Badge tone={statusTone(alert.severity ?? alert.status)}>
                    {alert.severity ?? alert.status ?? 'info'}
                  </Badge>
                </div>
              ))
            )}
          </CardBody>
        </Card>
      </div>

      {/* Days-to-breach ranking */}
      {breach.length > 0 && (
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-white">Soonest Projected Breaches</h2>
          </CardHeader>
          <CardBody className="space-y-2">
            {breach.slice(0, 6).map((f) => (
              <Link
                key={f.id}
                href={`/dashboard/originators/${f.originator_id}`}
                className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2.5 hover:bg-slate-800/40"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-200">
                    {f.originator_name ?? f.originator_id}
                  </div>
                  <div className="text-xs text-slate-500">
                    {f.rate_type ?? 'overall'} · {pct(f.current_rate)} · {fmtDate(f.projected_breach_date)}
                  </div>
                </div>
                <Badge tone={f.days_to_breach != null && f.days_to_breach < 30 ? 'breach' : 'watch'}>
                  {f.days_to_breach != null ? `${f.days_to_breach}d` : 'stable'}
                </Badge>
              </Link>
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  )
}
