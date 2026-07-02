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

interface Originator {
  id: string
  name: string
  status?: string
}

// Trends: a flexible point series. Each point may carry overall/unauthorized/admin rates.
interface TrendPoint {
  date?: string
  period?: string
  bucket?: string
  overall_rate?: number
  unauthorized_rate?: number
  admin_rate?: number
  rate?: number
  [k: string]: unknown
}

interface TrendsResp {
  series?: TrendPoint[] | { name?: string; points?: TrendPoint[] }[]
}

interface CodeBucket {
  code?: string
  return_code?: string
  category?: string
  count?: number
  period?: string
  bucket?: string
  [k: string]: unknown
}

interface Cohort {
  cohort?: string
  label?: string
  name?: string
  count?: number
  originator_count?: number
  avg_rate?: number
  avg_overall_rate?: number
  members?: unknown[]
  [k: string]: unknown
}

interface VolumePoint {
  originator_id?: string
  originator_name?: string
  name?: string
  volume?: number
  expected_monthly_volume?: number
  monthly_volume?: number
  return_rate?: number
  overall_rate?: number
  rate?: number
  [k: string]: unknown
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function fmtPct(v: unknown): string {
  return `${num(v).toFixed(2)}%`
}

function rateTone(rate: number): string {
  if (rate >= 0.5) return 'text-red-300'
  if (rate >= 0.3) return 'text-orange-300'
  if (rate >= 0.15) return 'text-amber-300'
  return 'text-amber-300'
}

function pointDate(p: TrendPoint): string {
  return String(p.date || p.period || p.bucket || '')
}

function pointRate(p: TrendPoint): number {
  return num(p.overall_rate ?? p.rate ?? p.unauthorized_rate ?? 0)
}

// Normalize the trends response into a single labeled series of points.
function normalizeTrends(resp: TrendsResp | null): TrendPoint[] {
  if (!resp || !resp.series) return []
  const s = resp.series
  if (!Array.isArray(s)) return []
  if (s.length === 0) return []
  const first = s[0] as Record<string, unknown>
  // If series is a list of { points } groups, flatten the first (portfolio) group.
  if (first && Array.isArray((first as { points?: unknown }).points)) {
    return ((first as { points?: TrendPoint[] }).points || []) as TrendPoint[]
  }
  return s as TrendPoint[]
}

// Multi-line SVG chart for overall/unauthorized/admin rate series.
function TrendChart({ points }: { points: TrendPoint[] }) {
  const W = 720
  const H = 240
  const pad = { t: 16, r: 16, b: 28, l: 44 }
  const innerW = W - pad.l - pad.r
  const innerH = H - pad.t - pad.b

  const lines = useMemo(() => {
    const keys: { key: keyof TrendPoint; color: string; label: string }[] = [
      { key: 'overall_rate', color: '#38bdf8', label: 'Overall' },
      { key: 'unauthorized_rate', color: '#f87171', label: 'Unauthorized' },
      { key: 'admin_rate', color: '#fbbf24', label: 'Administrative' },
    ]
    return keys.filter((k) => points.some((p) => p[k.key] != null))
  }, [points])

  const maxVal = useMemo(() => {
    let m = 0.5
    for (const p of points) {
      for (const l of lines) m = Math.max(m, num(p[l.key]))
      m = Math.max(m, pointRate(p))
    }
    return m * 1.15
  }, [points, lines])

  if (points.length === 0) {
    return <EmptyState title="No trend data" description="Recompute rates to populate the trend series." />
  }

  const n = points.length
  const x = (i: number) => pad.l + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const y = (v: number) => pad.t + innerH - (v / maxVal) * innerH

  const effectiveLines = lines.length
    ? lines
    : [{ key: 'rate' as keyof TrendPoint, color: '#34d399', label: 'Rate' }]

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxVal)

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-3">
        {effectiveLines.map((l) => (
          <span key={String(l.key)} className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
            {l.label}
          </span>
        ))}
      </div>
      <div className="w-full overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-60 w-full min-w-[520px]" preserveAspectRatio="none">
          {gridLines.map((g, i) => (
            <g key={i}>
              <line x1={pad.l} x2={W - pad.r} y1={y(g)} y2={y(g)} stroke="#1e293b" strokeWidth={1} />
              <text x={pad.l - 6} y={y(g) + 3} textAnchor="end" fontSize={10} fill="#64748b">
                {g.toFixed(2)}%
              </text>
            </g>
          ))}
          {effectiveLines.map((l) => {
            const d = points
              .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(num(p[l.key])).toFixed(1)}`)
              .join(' ')
            return (
              <g key={String(l.key)}>
                <path d={d} fill="none" stroke={l.color} strokeWidth={2} strokeLinejoin="round" />
                {points.map((p, i) => (
                  <circle key={i} cx={x(i)} cy={y(num(p[l.key]))} r={2.5} fill={l.color} />
                ))}
              </g>
            )
          })}
          {points.map((p, i) => {
            if (n > 8 && i % Math.ceil(n / 8) !== 0 && i !== n - 1) return null
            const label = pointDate(p)
            return (
              <text key={`x-${i}`} x={x(i)} y={H - 8} textAnchor="middle" fontSize={10} fill="#64748b">
                {label.length > 10 ? label.slice(5, 10) : label}
              </text>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

// Horizontal bar list for return-code distribution.
function CodeDistribution({ buckets }: { buckets: CodeBucket[] }) {
  const totals = useMemo(() => {
    const map = new Map<string, { code: string; category?: string; count: number }>()
    for (const b of buckets) {
      const code = String(b.code || b.return_code || '?')
      const prev = map.get(code)
      const cnt = num(b.count)
      if (prev) prev.count += cnt
      else map.set(code, { code, category: b.category as string | undefined, count: cnt })
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count)
  }, [buckets])

  const max = totals.reduce((m, t) => Math.max(m, t.count), 0) || 1
  const grand = totals.reduce((s, t) => s + t.count, 0)

  if (totals.length === 0) {
    return <EmptyState title="No return codes" description="No returns recorded for this period." />
  }

  const catTone = (cat?: string): 'breach' | 'warning' | 'neutral' => {
    if (cat === 'unauthorized') return 'breach'
    if (cat === 'admin' || cat === 'administrative') return 'warning'
    return 'neutral'
  }

  return (
    <div className="space-y-2.5">
      {totals.slice(0, 14).map((t) => (
        <div key={t.code} className="flex items-center gap-3">
          <div className="w-28 shrink-0">
            <Badge tone={catTone(t.category)}>{t.code}</Badge>
          </div>
          <div className="h-5 flex-1 overflow-hidden rounded bg-zinc-800">
            <div
              className="flex h-full items-center justify-end rounded bg-sky-500/70 px-2 text-[10px] font-medium text-zinc-950"
              style={{ width: `${Math.max(6, (t.count / max) * 100)}%` }}
            >
              {t.count}
            </div>
          </div>
          <div className="w-12 shrink-0 text-right text-xs tabular-nums text-zinc-500">
            {grand ? `${((t.count / grand) * 100).toFixed(0)}%` : '0%'}
          </div>
        </div>
      ))}
    </div>
  )
}

// Scatter of expected volume vs return rate.
function VolumeScatter({ points }: { points: VolumePoint[] }) {
  const W = 720
  const H = 280
  const pad = { t: 16, r: 16, b: 36, l: 48 }
  const innerW = W - pad.l - pad.r
  const innerH = H - pad.t - pad.b

  const data = useMemo(
    () =>
      points.map((p) => ({
        name: p.originator_name || p.name || p.originator_id || '—',
        volume: num(p.volume ?? p.expected_monthly_volume ?? p.monthly_volume),
        rate: num(p.return_rate ?? p.overall_rate ?? p.rate),
      })),
    [points],
  )

  const maxVol = data.reduce((m, d) => Math.max(m, d.volume), 0) || 1
  const maxRate = Math.max(0.5, data.reduce((m, d) => Math.max(m, d.rate), 0)) * 1.15

  if (data.length === 0) {
    return <EmptyState title="No volume data" description="Add originators with expected volume and returns." />
  }

  const x = (v: number) => pad.l + (v / maxVol) * innerW
  const y = (v: number) => pad.t + innerH - (v / maxRate) * innerH

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-72 w-full min-w-[520px]">
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(f * maxRate)} y2={y(f * maxRate)} stroke="#1e293b" />
            <text x={pad.l - 6} y={y(f * maxRate) + 3} textAnchor="end" fontSize={10} fill="#64748b">
              {(f * maxRate).toFixed(2)}%
            </text>
          </g>
        ))}
        {/* 0.5% NACHA unauthorized reference band */}
        {0.5 <= maxRate && (
          <line
            x1={pad.l}
            x2={W - pad.r}
            y1={y(0.5)}
            y2={y(0.5)}
            stroke="#f87171"
            strokeDasharray="4 4"
            strokeWidth={1.5}
          />
        )}
        {data.map((d, i) => {
          const tone = d.rate >= 0.5 ? '#f87171' : d.rate >= 0.3 ? '#fb923c' : d.rate >= 0.15 ? '#fbbf24' : '#34d399'
          return (
            <g key={i}>
              <circle cx={x(d.volume)} cy={y(d.rate)} r={5} fill={tone} fillOpacity={0.75} stroke={tone} />
              <title>{`${d.name}\nVolume: ${d.volume.toLocaleString()}\nRate: ${d.rate.toFixed(2)}%`}</title>
            </g>
          )
        })}
        <text x={pad.l + innerW / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="#94a3b8">
          Expected monthly volume →
        </text>
      </svg>
    </div>
  )
}

export default function AnalyticsPage() {
  const [originators, setOriginators] = useState<Originator[]>([])
  const [trends, setTrends] = useState<TrendPoint[]>([])
  const [codeBuckets, setCodeBuckets] = useState<CodeBucket[]>([])
  const [cohorts, setCohorts] = useState<Cohort[]>([])
  const [volume, setVolume] = useState<VolumePoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [originatorId, setOriginatorId] = useState('')
  const [trendsLoading, setTrendsLoading] = useState(false)

  const loadTrends = useCallback(async (id: string) => {
    setTrendsLoading(true)
    try {
      const t = (await api.getTrends(id || undefined)) as TrendsResp
      setTrends(normalizeTrends(t))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load trends')
    } finally {
      setTrendsLoading(false)
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [orgs, t, cd, co, vc] = await Promise.all([
        api.getOriginators().catch(() => []),
        api.getTrends().catch(() => ({ series: [] })),
        api.getCodeDistribution().catch(() => ({ buckets: [] })),
        api.getCohorts().catch(() => ({ cohorts: [] })),
        api.getVolumeCorrelation().catch(() => ({ points: [] })),
      ])
      setOriginators(Array.isArray(orgs) ? orgs : [])
      setTrends(normalizeTrends(t as TrendsResp))
      const cdResp = cd as { buckets?: CodeBucket[] }
      setCodeBuckets(Array.isArray(cdResp.buckets) ? cdResp.buckets : [])
      const coResp = co as { cohorts?: Cohort[] }
      setCohorts(Array.isArray(coResp.cohorts) ? coResp.cohorts : [])
      const vcResp = vc as { points?: VolumePoint[] }
      setVolume(Array.isArray(vcResp.points) ? vcResp.points : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analytics')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const onOriginatorChange = (id: string) => {
    setOriginatorId(id)
    void loadTrends(id)
  }

  const latestRate = useMemo(() => {
    if (trends.length === 0) return 0
    return pointRate(trends[trends.length - 1])
  }, [trends])

  const rateDelta = useMemo(() => {
    if (trends.length < 2) return 0
    return pointRate(trends[trends.length - 1]) - pointRate(trends[0])
  }, [trends])

  const topCode = useMemo(() => {
    const map = new Map<string, number>()
    for (const b of codeBuckets) {
      const code = String(b.code || b.return_code || '?')
      map.set(code, (map.get(code) || 0) + num(b.count))
    }
    let top = '—'
    let max = 0
    for (const [k, v] of map) if (v > max) (max = v), (top = k)
    return { code: top, count: max }
  }, [codeBuckets])

  const cohortLabel = (c: Cohort) => String(c.cohort || c.label || c.name || '—')
  const cohortCount = (c: Cohort) =>
    num(c.count ?? c.originator_count ?? (Array.isArray(c.members) ? c.members.length : 0))
  const cohortRate = (c: Cohort) => num(c.avg_rate ?? c.avg_overall_rate)

  if (loading) return <PageSpinner label="Loading analytics..." />

  const totalReturns = codeBuckets.reduce((s, b) => s + num(b.count), 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Return Analytics</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Rate trends, return-code distribution, onboarding cohorts, and the volume-to-return-rate
            relationship across the portfolio.
          </p>
        </div>
        <Button variant="secondary" onClick={load}>
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Latest overall rate"
          value={fmtPct(latestRate)}
          tone={latestRate >= 0.5 ? 'red' : latestRate >= 0.3 ? 'amber' : 'emerald'}
        />
        <Stat
          label="Trend Δ (period)"
          value={`${rateDelta >= 0 ? '+' : ''}${rateDelta.toFixed(2)}%`}
          tone={rateDelta > 0 ? 'red' : rateDelta < 0 ? 'emerald' : 'default'}
          hint="First vs latest point"
        />
        <Stat label="Returns in window" value={totalReturns.toLocaleString()} />
        <Stat label="Top return code" value={topCode.code} hint={topCode.count ? `${topCode.count} returns` : undefined} />
      </div>

      {/* Trends */}
      <Card>
        <CardHeader className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-white">Rate trend</span>
          <select
            value={originatorId}
            onChange={(e) => onOriginatorChange(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-200 focus:border-amber-500/50 focus:outline-none"
          >
            <option value="">Portfolio-wide</option>
            {originators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          {trendsLoading && <span className="text-xs text-zinc-500">Updating...</span>}
          <span className="ml-auto text-xs text-zinc-500">{trends.length} points</span>
        </CardHeader>
        <CardBody>
          <TrendChart points={trends} />
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* Code distribution */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <span className="text-sm font-semibold text-white">Return-code distribution</span>
            <span className="text-xs text-zinc-500">{totalReturns.toLocaleString()} returns</span>
          </CardHeader>
          <CardBody>
            <CodeDistribution buckets={codeBuckets} />
          </CardBody>
        </Card>

        {/* Cohorts */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <span className="text-sm font-semibold text-white">Onboarding cohorts</span>
            <span className="text-xs text-zinc-500">{cohorts.length} cohorts</span>
          </CardHeader>
          <CardBody className="p-0">
            {cohorts.length === 0 ? (
              <EmptyState
                title="No cohorts"
                description="Cohorts appear once originators are grouped by onboarding period."
              />
            ) : (
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Cohort</TH>
                    <TH className="text-right">Originators</TH>
                    <TH className="text-right">Avg overall rate</TH>
                  </TR>
                </THead>
                <TBody>
                  {cohorts.map((c, i) => (
                    <TR key={i}>
                      <TD className="font-medium text-white">{cohortLabel(c)}</TD>
                      <TD className="text-right tabular-nums text-zinc-300">{cohortCount(c)}</TD>
                      <TD className={`text-right font-semibold tabular-nums ${rateTone(cohortRate(c))}`}>
                        {fmtPct(cohortRate(c))}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Volume correlation */}
      <Card>
        <CardHeader className="flex items-center justify-between">
          <span className="text-sm font-semibold text-white">Volume vs return rate</span>
          <span className="text-xs text-zinc-500">
            {volume.length} originators · dashed line = 0.50% NACHA unauthorized ceiling
          </span>
        </CardHeader>
        <CardBody>
          <VolumeScatter points={volume} />
        </CardBody>
      </Card>
    </div>
  )
}
