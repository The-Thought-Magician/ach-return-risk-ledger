'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import api from '@/lib/api'
import { Card, CardHeader, CardBody } from '@/components/ui/card'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'
import { Badge, statusTone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/button'
import { Stat } from '@/components/ui/Stat'
import { PageSpinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'

interface Originator {
  id: string
  name: string
  company_id?: string
  odfi_name?: string
  routing_number?: string
  mcc?: string
  expected_monthly_volume?: number
  status?: string
  created_at?: string
}

interface RateBlock {
  unauthorized_rate?: number
  admin_rate?: number
  overall_rate?: number
  unauthorized_status?: string
  admin_status?: string
  overall_status?: string
  debit_count?: number
  total_returns?: number
  as_of?: string
}

interface Scorecard {
  composite_score?: number
  grade?: string
  headroom_score?: number
  velocity_score?: number
  volume_score?: number
  representment_score?: number
  percentile?: number
  computed_at?: string
}

interface Forecast {
  rate_type?: string
  model?: string
  current_rate?: number
  velocity_per_day?: number
  projected_breach_date?: string | null
  days_to_breach?: number | null
  confidence?: number
}

interface Letter {
  id: string
  letter_type?: string
  subject?: string
  status?: string
  received_date?: string
  response_due_date?: string
}

interface CaseRow {
  id: string
  title?: string
  status?: string
  priority?: string
  created_at?: string
}

interface Profile {
  originator?: Originator
  rates?: RateBlock | null
  scorecard?: Scorecard | null
  forecast?: Forecast[] | Forecast | null
  feeTotals?: { totalCents?: number; recoveredCents?: number; count?: number } | null
  letters?: Letter[]
  cases?: CaseRow[]
}

interface RateSnapshot {
  id: string
  as_of?: string
  window_days?: number
  unauthorized_rate?: number
  admin_rate?: number
  overall_rate?: number
  overall_status?: string
}

function pct(n?: number) {
  if (n == null || Number.isNaN(n)) return '—'
  return `${(n * 100).toFixed(3)}%`
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

const LIMITS: Record<string, number> = { unauthorized: 0.005, admin: 0.03, overall: 0.15 }

function gradeTone(grade?: string) {
  switch ((grade ?? '').toUpperCase()) {
    case 'A':
    case 'A+':
      return 'clear'
    case 'B':
      return 'watch'
    case 'C':
    case 'D':
      return 'warning'
    case 'F':
      return 'breach'
    default:
      return 'neutral'
  }
}

function RateBar({ label, rate, status, limit }: { label: string; rate?: number; status?: string; limit: number }) {
  const value = rate ?? 0
  const fill = Math.min(100, (value / limit) * 100)
  const tone = statusTone(status)
  const color =
    tone === 'breach' ? 'bg-red-500' : tone === 'warning' ? 'bg-orange-500' : tone === 'watch' ? 'bg-amber-500' : 'bg-amber-500'
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
        <Badge tone={tone}>{status ?? 'n/a'}</Badge>
      </div>
      <div className="mt-2 text-xl font-semibold tabular-nums text-white">{pct(rate)}</div>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${fill}%` }} />
      </div>
      <div className="mt-1 text-[11px] text-zinc-500">limit {pct(limit)}</div>
    </div>
  )
}

// Multi-line trend chart for rate snapshot timeline.
function RateTimeline({ snapshots }: { snapshots: RateSnapshot[] }) {
  if (snapshots.length < 2) {
    return <p className="text-sm text-zinc-500">Not enough snapshots to chart a trend yet.</p>
  }
  const ordered = [...snapshots].sort(
    (a, b) => new Date(a.as_of ?? 0).getTime() - new Date(b.as_of ?? 0).getTime(),
  )
  const w = 600
  const h = 160
  const pad = 8
  const series: Array<{ key: keyof RateSnapshot; color: string; label: string }> = [
    { key: 'unauthorized_rate', color: '#f87171', label: 'Unauthorized' },
    { key: 'admin_rate', color: '#fbbf24', label: 'Admin' },
    { key: 'overall_rate', color: '#34d399', label: 'Overall' },
  ]
  const all = ordered.flatMap((s) => series.map((ser) => (s[ser.key] as number) ?? 0))
  const max = Math.max(...all, 0.0001)
  const step = ordered.length > 1 ? (w - pad * 2) / (ordered.length - 1) : 0
  return (
    <div>
      <div className="w-full overflow-x-auto">
        <svg viewBox={`0 0 ${w} ${h}`} className="h-44 w-full min-w-[480px]">
          {series.map((ser) => {
            const points = ordered
              .map((s, i) => {
                const x = pad + i * step
                const v = (s[ser.key] as number) ?? 0
                const y = h - pad - (v / max) * (h - pad * 2)
                return `${x.toFixed(1)},${y.toFixed(1)}`
              })
              .join(' ')
            return <polyline key={String(ser.key)} points={points} fill="none" stroke={ser.color} strokeWidth="2" />
          })}
        </svg>
      </div>
      <div className="mt-2 flex flex-wrap gap-4">
        {series.map((ser) => (
          <span key={String(ser.key)} className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: ser.color }} />
            {ser.label}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function OriginatorProfilePage() {
  const params = useParams()
  const router = useRouter()
  const id = String(params.id)

  const [profile, setProfile] = useState<Profile | null>(null)
  const [snapshots, setSnapshots] = useState<RateSnapshot[]>([])
  const [scorecard, setScorecard] = useState<Scorecard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [p, rates, sc] = await Promise.all([
        api.getOriginatorProfile(id),
        api.getOriginatorRates(id).catch(() => []),
        api.getScorecard(id).catch(() => null),
      ])
      setProfile(p ?? null)
      setSnapshots(Array.isArray(rates) ? rates : [])
      setScorecard(sc ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load originator profile')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  if (loading) return <PageSpinner label="Loading originator profile..." />

  if (error || !profile) {
    return (
      <div className="mx-auto max-w-2xl">
        <EmptyState
          title="Could not load this originator"
          description={error ?? 'Not found.'}
          action={
            <div className="flex gap-2">
              <Button variant="secondary" onClick={load}>
                Retry
              </Button>
              <Link href="/dashboard/originators">
                <Button>Back to registry</Button>
              </Link>
            </div>
          }
        />
      </div>
    )
  }

  const o = profile.originator
  const rates = profile.rates ?? null
  const sc = scorecard ?? profile.scorecard ?? null
  const forecasts = Array.isArray(profile.forecast)
    ? profile.forecast
    : profile.forecast
      ? [profile.forecast]
      : []
  const feeTotals = profile.feeTotals ?? {}
  const letters = profile.letters ?? []
  const cases = profile.cases ?? []

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/originators" className="text-xs text-zinc-500 hover:text-zinc-300">
          ← Originator Registry
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-white">{o?.name ?? 'Originator'}</h1>
            <Badge tone={statusTone(o?.status)}>{o?.status ?? 'unknown'}</Badge>
          </div>
          <div className="flex items-center gap-2">
            {sc?.grade && <Badge tone={gradeTone(sc.grade)}>Grade {sc.grade}</Badge>}
          </div>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          {o?.odfi_name ? `ODFI ${o.odfi_name}` : 'No ODFI'} · Company {o?.company_id || '—'} · Routing{' '}
          {o?.routing_number || '—'} · MCC {o?.mcc || '—'}
        </p>
      </div>

      {/* Rate gauges */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-white">Current Return Rates</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            As of {fmtDate(rates?.as_of)} · {rates?.debit_count ?? 0} debit entries · {rates?.total_returns ?? 0} returns
          </p>
        </CardHeader>
        <CardBody>
          {rates ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <RateBar label="Unauthorized" rate={rates.unauthorized_rate} status={rates.unauthorized_status} limit={LIMITS.unauthorized} />
              <RateBar label="Administrative" rate={rates.admin_rate} status={rates.admin_status} limit={LIMITS.admin} />
              <RateBar label="Overall" rate={rates.overall_rate} status={rates.overall_status} limit={LIMITS.overall} />
            </div>
          ) : (
            <EmptyState title="No rate snapshot" description="Recompute rates to populate this originator." />
          )}
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Scorecard */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <h2 className="text-sm font-semibold text-white">Risk Scorecard</h2>
          </CardHeader>
          <CardBody>
            {sc ? (
              <div className="space-y-4">
                <div className="flex items-end justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-zinc-500">Composite</div>
                    <div className="text-3xl font-semibold tabular-nums text-white">
                      {sc.composite_score != null ? sc.composite_score.toFixed(0) : '—'}
                    </div>
                  </div>
                  <Badge tone={gradeTone(sc.grade)}>{sc.grade ?? 'n/a'}</Badge>
                </div>
                {sc.percentile != null && (
                  <div className="text-xs text-zinc-500">Portfolio percentile: {(sc.percentile * 100).toFixed(0)}%</div>
                )}
                <div className="space-y-2">
                  {[
                    ['Headroom', sc.headroom_score],
                    ['Velocity', sc.velocity_score],
                    ['Volume', sc.volume_score],
                    ['Re-presentment', sc.representment_score],
                  ].map(([label, val]) => (
                    <div key={label as string}>
                      <div className="flex justify-between text-xs text-zinc-400">
                        <span>{label as string}</span>
                        <span className="tabular-nums">{val != null ? Number(val).toFixed(0) : '—'}</span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className="h-full rounded-full bg-amber-500"
                          style={{ width: `${Math.min(100, Math.max(0, Number(val ?? 0)))}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <EmptyState title="No scorecard" description="Recompute scorecards from the Scorecards page." />
            )}
          </CardBody>
        </Card>

        {/* Forecast */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <h2 className="text-sm font-semibold text-white">Breach Forecast</h2>
          </CardHeader>
          <CardBody className="p-0">
            {forecasts.length === 0 ? (
              <div className="p-5">
                <EmptyState title="No forecast" description="Recompute forecasts to project breach timing." />
              </div>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Rate Type</TH>
                    <TH>Model</TH>
                    <TH className="text-right">Current</TH>
                    <TH className="text-right">Velocity/day</TH>
                    <TH>Projected Breach</TH>
                    <TH className="text-right">Days</TH>
                  </TR>
                </THead>
                <TBody>
                  {forecasts.map((f, i) => (
                    <TR key={i}>
                      <TD className="capitalize">{f.rate_type ?? 'overall'}</TD>
                      <TD className="text-zinc-400">{f.model ?? '—'}</TD>
                      <TD className="text-right tabular-nums">{pct(f.current_rate)}</TD>
                      <TD className="text-right tabular-nums text-zinc-400">
                        {f.velocity_per_day != null ? (f.velocity_per_day * 100).toFixed(4) + '%' : '—'}
                      </TD>
                      <TD>{fmtDate(f.projected_breach_date)}</TD>
                      <TD className="text-right">
                        <Badge tone={f.days_to_breach != null && f.days_to_breach < 30 ? 'breach' : f.days_to_breach != null ? 'watch' : 'clear'}>
                          {f.days_to_breach != null ? `${f.days_to_breach}d` : 'stable'}
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Rate timeline */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-white">Rate Snapshot Timeline</h2>
          <p className="mt-0.5 text-xs text-zinc-500">{snapshots.length} snapshot(s)</p>
        </CardHeader>
        <CardBody>
          {snapshots.length === 0 ? (
            <EmptyState title="No snapshots" description="Rate history will appear here once computed." />
          ) : (
            <RateTimeline snapshots={snapshots} />
          )}
        </CardBody>
      </Card>

      {/* Fee totals */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Total Fees" value={money(feeTotals.totalCents)} hint={`${feeTotals.count ?? 0} records`} tone="red" />
        <Stat label="Recovered" value={money(feeTotals.recoveredCents)} hint="via re-presentment" tone="emerald" />
        <Stat
          label="Net Cost"
          value={money((feeTotals.totalCents ?? 0) - (feeTotals.recoveredCents ?? 0))}
          tone="amber"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Warning letters */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Warning Letters</h2>
            <Link href="/dashboard/letters" className="text-xs font-medium text-amber-400 hover:text-amber-300">
              All letters →
            </Link>
          </CardHeader>
          <CardBody className="p-0">
            {letters.length === 0 ? (
              <div className="p-5">
                <EmptyState title="No warning letters" description="No ODFI letters logged for this originator." />
              </div>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Type</TH>
                    <TH>Subject</TH>
                    <TH>Due</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {letters.map((l) => (
                    <TR key={l.id}>
                      <TD className="capitalize">{l.letter_type ?? '—'}</TD>
                      <TD className="max-w-[200px] truncate text-zinc-300">{l.subject ?? '—'}</TD>
                      <TD className="text-zinc-400">{fmtDate(l.response_due_date)}</TD>
                      <TD>
                        <Badge tone={statusTone(l.status)}>{l.status ?? 'open'}</Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>

        {/* Remediation cases */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Remediation Cases</h2>
            <Link href="/dashboard/cases" className="text-xs font-medium text-amber-400 hover:text-amber-300">
              All cases →
            </Link>
          </CardHeader>
          <CardBody className="p-0">
            {cases.length === 0 ? (
              <div className="p-5">
                <EmptyState title="No open cases" description="No remediation cases for this originator." />
              </div>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Title</TH>
                    <TH>Priority</TH>
                    <TH>Opened</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {cases.map((c) => (
                    <TR key={c.id}>
                      <TD className="max-w-[200px] truncate text-zinc-300">{c.title ?? '—'}</TD>
                      <TD className="capitalize text-zinc-400">{c.priority ?? '—'}</TD>
                      <TD className="text-zinc-400">{fmtDate(c.created_at)}</TD>
                      <TD>
                        <Badge tone={statusTone(c.status)}>{c.status ?? 'open'}</Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
