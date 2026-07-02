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

interface Benchmark {
  id: string
  metric: string
  p25: number
  p50: number
  p75: number
  p90: number
  computed_at?: string
  created_at?: string
}

// NACHA regulatory reference thresholds per rate metric (percent).
const NACHA_BANDS: Record<string, { limit: number; label: string }> = {
  unauthorized_rate: { limit: 0.5, label: 'Unauthorized ceiling' },
  unauthorized: { limit: 0.5, label: 'Unauthorized ceiling' },
  admin_rate: { limit: 3, label: 'Administrative ceiling' },
  admin: { limit: 3, label: 'Administrative ceiling' },
  administrative_rate: { limit: 3, label: 'Administrative ceiling' },
  overall_rate: { limit: 15, label: 'Overall ceiling' },
  overall: { limit: 15, label: 'Overall ceiling' },
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function fmtPct(v: unknown): string {
  return `${num(v).toFixed(3)}%`
}

function fmtMetric(m: string): string {
  return m
    .replace(/_/g, ' ')
    .replace(/\brate\b/i, 'rate')
    .replace(/^\w/, (c) => c.toUpperCase())
}

function fmtDateTime(v?: string): string {
  if (!v) return 'never'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function nachaBand(metric: string): { limit: number; label: string } | null {
  return NACHA_BANDS[metric] ?? null
}

// Horizontal percentile distribution bar: p25 → p50 → p75 → p90, with optional NACHA ceiling marker.
function PercentileBar({ b }: { b: Benchmark }) {
  const band = nachaBand(b.metric)
  const scaleMax = useMemo(() => {
    const vals = [num(b.p25), num(b.p50), num(b.p75), num(b.p90)]
    const ceiling = band ? band.limit : 0
    return Math.max(0.1, Math.max(...vals, ceiling) * 1.15)
  }, [b, band])

  const pct = (v: number) => Math.max(0, Math.min(100, (num(v) / scaleMax) * 100))

  const ticks = [
    { key: 'p25', value: num(b.p25), color: 'bg-amber-400', label: 'P25' },
    { key: 'p50', value: num(b.p50), color: 'bg-sky-400', label: 'P50' },
    { key: 'p75', value: num(b.p75), color: 'bg-amber-400', label: 'P75' },
    { key: 'p90', value: num(b.p90), color: 'bg-orange-400', label: 'P90' },
  ]

  return (
    <div>
      <div className="relative h-9 w-full rounded-lg bg-zinc-800/60">
        {/* gradient fill from p25 to p90 */}
        <div
          className="absolute top-0 h-full rounded-lg bg-gradient-to-r from-amber-500/30 via-amber-500/25 to-orange-500/30"
          style={{ left: `${pct(b.p25)}%`, width: `${Math.max(0, pct(b.p90) - pct(b.p25))}%` }}
        />
        {ticks.map((t) => (
          <div
            key={t.key}
            className={`absolute top-0 h-full w-0.5 ${t.color}`}
            style={{ left: `${pct(t.value)}%` }}
            title={`${t.label}: ${fmtPct(t.value)}`}
          />
        ))}
        {band && band.limit <= scaleMax && (
          <div
            className="absolute top-0 h-full w-0.5 bg-red-500"
            style={{ left: `${pct(band.limit)}%` }}
            title={`NACHA ${band.label}: ${band.limit.toFixed(2)}%`}
          >
            <span className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-red-300">
              NACHA {band.limit.toFixed(2)}%
            </span>
          </div>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-3 text-[11px] text-zinc-400">
        {ticks.map((t) => (
          <span key={t.key} className="inline-flex items-center gap-1">
            <span className={`inline-block h-2 w-2 rounded-full ${t.color}`} />
            {t.label} {fmtPct(t.value)}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function BenchmarksPage() {
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [recomputing, setRecomputing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.getBenchmarks()
      setBenchmarks(Array.isArray(res) ? res : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load benchmarks')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const recompute = async () => {
    setRecomputing(true)
    setError(null)
    setActionMsg(null)
    try {
      const res = await api.recomputeBenchmarks()
      const computed =
        res && typeof res === 'object' && 'computed' in res
          ? (res as { computed: number }).computed
          : undefined
      setActionMsg(computed != null ? `Recomputed ${computed} benchmark metrics` : 'Benchmarks recomputed')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recompute failed')
    } finally {
      setRecomputing(false)
    }
  }

  const lastComputed = useMemo(() => {
    let latest = ''
    for (const b of benchmarks) {
      const ts = b.computed_at || b.created_at || ''
      if (ts > latest) latest = ts
    }
    return latest
  }, [benchmarks])

  // Count metrics where the median (P50) already exceeds the NACHA ceiling.
  const breachingMedian = useMemo(
    () =>
      benchmarks.filter((b) => {
        const band = nachaBand(b.metric)
        return band ? num(b.p50) >= band.limit : false
      }).length,
    [benchmarks],
  )

  if (loading) return <PageSpinner label="Loading benchmarks..." />

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Portfolio Benchmarks</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Percentile distribution (P25–P90) of return-rate metrics across your originator portfolio,
            overlaid against NACHA regulatory reference ceilings.
          </p>
        </div>
        <Button onClick={recompute} disabled={recomputing}>
          {recomputing ? 'Recomputing...' : 'Recompute benchmarks'}
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {actionMsg && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          {actionMsg}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Metrics tracked" value={benchmarks.length} />
        <Stat
          label="Median above NACHA"
          value={breachingMedian}
          tone={breachingMedian > 0 ? 'red' : 'emerald'}
          hint="Metrics whose P50 ≥ ceiling"
        />
        <Stat label="Last computed" value={fmtDateTime(lastComputed)} />
      </div>

      {benchmarks.length === 0 ? (
        <EmptyState
          title="No benchmarks yet"
          description="Recompute benchmarks once you have originators with rate snapshots to derive portfolio percentiles."
          action={
            <Button onClick={recompute} disabled={recomputing}>
              {recomputing ? 'Recomputing...' : 'Recompute benchmarks'}
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {benchmarks.map((b) => {
              const band = nachaBand(b.metric)
              const medianOver = band ? num(b.p50) >= band.limit : false
              const p90Over = band ? num(b.p90) >= band.limit : false
              return (
                <Card key={b.id}>
                  <CardHeader className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-white">{fmtMetric(b.metric)}</span>
                    {band ? (
                      medianOver ? (
                        <Badge tone="breach">Median over ceiling</Badge>
                      ) : p90Over ? (
                        <Badge tone="warning">P90 over ceiling</Badge>
                      ) : (
                        <Badge tone="clear">Within NACHA band</Badge>
                      )
                    ) : (
                      <Badge tone="neutral">No NACHA band</Badge>
                    )}
                  </CardHeader>
                  <CardBody className="space-y-4 pt-6">
                    <PercentileBar b={b} />
                    <div className="grid grid-cols-4 gap-2 text-center">
                      {(['p25', 'p50', 'p75', 'p90'] as const).map((k) => (
                        <div key={k} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-2 py-2">
                          <div className="text-[11px] uppercase tracking-wide text-zinc-500">{k}</div>
                          <div className="mt-0.5 text-sm font-semibold tabular-nums text-zinc-200">
                            {fmtPct(b[k])}
                          </div>
                        </div>
                      ))}
                    </div>
                    {band && (
                      <div className="text-xs text-zinc-500">
                        NACHA {band.label}: <span className="text-red-300">{band.limit.toFixed(2)}%</span>
                      </div>
                    )}
                  </CardBody>
                </Card>
              )
            })}
          </div>

          <Card>
            <CardHeader>
              <span className="text-sm font-semibold text-white">All benchmark metrics</span>
            </CardHeader>
            <CardBody className="p-0">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Metric</TH>
                    <TH className="text-right">P25</TH>
                    <TH className="text-right">P50</TH>
                    <TH className="text-right">P75</TH>
                    <TH className="text-right">P90</TH>
                    <TH className="text-right">NACHA ceiling</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {benchmarks.map((b) => {
                    const band = nachaBand(b.metric)
                    const medianOver = band ? num(b.p50) >= band.limit : false
                    const p90Over = band ? num(b.p90) >= band.limit : false
                    return (
                      <TR key={`row-${b.id}`}>
                        <TD className="font-medium text-white">{fmtMetric(b.metric)}</TD>
                        <TD className="text-right tabular-nums text-zinc-300">{fmtPct(b.p25)}</TD>
                        <TD className="text-right tabular-nums text-zinc-300">{fmtPct(b.p50)}</TD>
                        <TD className="text-right tabular-nums text-zinc-300">{fmtPct(b.p75)}</TD>
                        <TD className="text-right tabular-nums text-zinc-300">{fmtPct(b.p90)}</TD>
                        <TD className="text-right tabular-nums text-zinc-400">
                          {band ? `${band.limit.toFixed(2)}%` : '—'}
                        </TD>
                        <TD>
                          {!band ? (
                            <span className="text-zinc-500">—</span>
                          ) : medianOver ? (
                            <Badge tone="breach">Median over</Badge>
                          ) : p90Over ? (
                            <Badge tone="warning">P90 over</Badge>
                          ) : (
                            <Badge tone="clear">Within band</Badge>
                          )}
                        </TD>
                      </TR>
                    )
                  })}
                </TBody>
              </Table>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <span className="text-sm font-semibold text-white">NACHA reference bands</span>
            </CardHeader>
            <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-zinc-500">Unauthorized</div>
                <div className="mt-1 text-xl font-semibold tabular-nums text-red-300">0.50%</div>
                <div className="mt-1 text-xs text-zinc-500">R05, R07, R10, R11, R29, R51</div>
              </div>
              <div className="rounded-lg border border-orange-500/20 bg-orange-500/5 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-zinc-500">Administrative</div>
                <div className="mt-1 text-xl font-semibold tabular-nums text-orange-300">3.00%</div>
                <div className="mt-1 text-xs text-zinc-500">R02, R03, R04</div>
              </div>
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-zinc-500">Overall</div>
                <div className="mt-1 text-xl font-semibold tabular-nums text-amber-300">15.00%</div>
                <div className="mt-1 text-xs text-zinc-500">All return codes</div>
              </div>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  )
}
