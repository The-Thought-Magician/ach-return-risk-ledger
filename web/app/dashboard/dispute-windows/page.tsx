'use client'

import { useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Card, CardHeader, CardBody } from '@/components/ui/card'
import { Stat } from '@/components/ui/Stat'
import { Badge, statusTone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/button'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageSpinner } from '@/components/ui/Spinner'

interface DisputeWindow {
  id: string
  workspace_id: string
  originator_id: string | null
  originated_entry_id: string | null
  settlement_date: string | null
  window_expiry: string | null
  amount_cents: number | null
  status: string | null
  created_at: string | null
}

interface Exposure {
  openCount: number
  openCents: number
  expiringSoon: number
}

const STATUS_FILTERS = ['all', 'open', 'expiring', 'expired', 'resolved'] as const
const EXPIRING_PRESETS = [7, 14, 30] as const

function fmtCents(cents: number | null | undefined): string {
  const n = typeof cents === 'number' ? cents : 0
  return (n / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return '—'
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function daysUntil(d: string | null | undefined): number | null {
  if (!d) return null
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return null
  const ms = dt.getTime() - Date.now()
  return Math.ceil(ms / 86_400_000)
}

export default function DisputeWindowsPage() {
  const [windows, setWindows] = useState<DisputeWindow[]>([])
  const [exposure, setExposure] = useState<Exposure | null>(null)
  const [expiring, setExpiring] = useState<DisputeWindow[]>([])
  const [expiringDays, setExpiringDays] = useState<number>(14)
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  async function loadAll() {
    setLoading(true)
    setError(null)
    try {
      const statusParam = statusFilter === 'all' ? undefined : statusFilter
      const [w, ex, exp] = await Promise.all([
        api.getDisputeWindows(statusParam),
        api.getDisputeExposure(),
        api.getExpiringWindows(expiringDays),
      ])
      setWindows(Array.isArray(w) ? w : [])
      setExposure(ex ?? null)
      setExpiring(Array.isArray(exp) ? exp : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load dispute windows')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, expiringDays])

  async function loadExpiring(days: number) {
    try {
      const exp = await api.getExpiringWindows(days)
      setExpiring(Array.isArray(exp) ? exp : [])
    } catch {
      /* surfaced via main error path */
    }
  }

  async function onRebuild() {
    setRebuilding(true)
    setNotice(null)
    setError(null)
    try {
      const res = await api.rebuildDisputeWindows()
      const built = res && typeof res.built === 'number' ? res.built : 0
      setNotice(`Rebuilt dispute windows from debit entries (${built} window${built === 1 ? '' : 's'}).`)
      await loadAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rebuild failed')
    } finally {
      setRebuilding(false)
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return windows
    return windows.filter((w) =>
      [w.originated_entry_id, w.originator_id, w.status]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    )
  }, [windows, search])

  // Build a simple SVG horizon of upcoming expiries across the next 60 days.
  const horizon = useMemo(() => {
    const buckets = Array.from({ length: 12 }, () => 0) // 12 x 5-day buckets = 60 days
    for (const w of windows) {
      if ((w.status ?? '').toLowerCase() === 'resolved') continue
      const d = daysUntil(w.window_expiry)
      if (d == null || d < 0 || d > 60) continue
      const idx = Math.min(11, Math.floor(d / 5))
      buckets[idx] += 1
    }
    const max = Math.max(1, ...buckets)
    return { buckets, max }
  }, [windows])

  if (loading) return <PageSpinner label="Loading dispute windows..." />

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Dispute Windows</h1>
          <p className="mt-1 text-sm text-zinc-400">
            60-day consumer dispute tracker. Each debit settlement opens a window that closes 60 days
            after settlement; open exposure is the dollar amount still re-disputable.
          </p>
        </div>
        <Button variant="primary" onClick={onRebuild} disabled={rebuilding}>
          {rebuilding ? 'Rebuilding…' : 'Rebuild from entries'}
        </Button>
      </header>

      {notice && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Open windows"
          value={exposure ? exposure.openCount.toLocaleString() : '0'}
          hint="Still within the 60-day dispute period"
          tone="sky"
        />
        <Stat
          label="Open exposure"
          value={fmtCents(exposure?.openCents)}
          hint="Dollar amount still re-disputable"
          tone="amber"
        />
        <Stat
          label="Expiring soon"
          value={exposure ? exposure.expiringSoon.toLocaleString() : '0'}
          hint="Windows nearing their expiry cutoff"
          tone="red"
        />
      </div>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">60-day expiry horizon</h2>
          <span className="text-xs text-zinc-500">Non-resolved windows by days to expiry</span>
        </CardHeader>
        <CardBody>
          {horizon.buckets.every((b) => b === 0) ? (
            <p className="text-sm text-zinc-500">No open windows expiring in the next 60 days.</p>
          ) : (
            <div className="flex items-end gap-2" style={{ height: 140 }}>
              {horizon.buckets.map((count, i) => {
                const h = (count / horizon.max) * 110
                const near = i < 2
                return (
                  <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1">
                    <span className="text-[10px] tabular-nums text-zinc-400">{count || ''}</span>
                    <div
                      className={`w-full rounded-t ${near ? 'bg-red-500/70' : 'bg-amber-500/60'}`}
                      style={{ height: Math.max(count ? 4 : 0, h) }}
                      title={`${i * 5}-${i * 5 + 5} days: ${count}`}
                    />
                    <span className="text-[10px] text-zinc-600">{i * 5}</span>
                  </div>
                )
              })}
            </div>
          )}
          <p className="mt-2 text-[11px] text-zinc-600">Days to expiry (bucketed in 5-day steps)</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Expiring within {expiringDays} days</h2>
          <div className="flex gap-1">
            {EXPIRING_PRESETS.map((d) => (
              <button
                key={d}
                onClick={() => {
                  setExpiringDays(d)
                  loadExpiring(d)
                }}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  expiringDays === d
                    ? 'bg-amber-600 text-white'
                    : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </CardHeader>
        <CardBody>
          {expiring.length === 0 ? (
            <p className="text-sm text-zinc-500">No windows expiring in this period. Good standing.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Entry</TH>
                  <TH>Settlement</TH>
                  <TH>Expiry</TH>
                  <TH className="text-right">Days left</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {expiring.map((w) => {
                  const dleft = daysUntil(w.window_expiry)
                  return (
                    <TR key={w.id}>
                      <TD className="font-mono text-xs text-zinc-300">
                        {w.originated_entry_id ? String(w.originated_entry_id).slice(0, 8) : '—'}
                      </TD>
                      <TD className="text-zinc-400">{fmtDate(w.settlement_date)}</TD>
                      <TD className="text-zinc-400">{fmtDate(w.window_expiry)}</TD>
                      <TD className="text-right tabular-nums">
                        <span className={dleft != null && dleft <= 7 ? 'text-red-300' : 'text-amber-300'}>
                          {dleft != null ? dleft : '—'}
                        </span>
                      </TD>
                      <TD className="text-right tabular-nums">{fmtCents(w.amount_cents)}</TD>
                      <TD>
                        <Badge tone={statusTone(w.status ?? undefined)}>{w.status ?? 'open'}</Badge>
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
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-white">All dispute windows</h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1">
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize ${
                    statusFilter === s
                      ? 'bg-amber-600 text-white'
                      : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search entry / originator…"
              className="w-56 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-amber-500/50 focus:outline-none"
            />
          </div>
        </CardHeader>
        <CardBody>
          {filtered.length === 0 ? (
            <EmptyState
              title="No dispute windows"
              description="Dispute windows are created automatically when debit entries settle. Rebuild from entries to backfill, or post originated debit entries."
              action={
                <Button variant="secondary" onClick={onRebuild} disabled={rebuilding}>
                  Rebuild from entries
                </Button>
              }
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Entry</TH>
                  <TH>Originator</TH>
                  <TH>Settlement</TH>
                  <TH>Window expiry</TH>
                  <TH className="text-right">Days left</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {filtered.map((w) => {
                  const dleft = daysUntil(w.window_expiry)
                  return (
                    <TR key={w.id}>
                      <TD className="font-mono text-xs text-zinc-300">
                        {w.originated_entry_id ? String(w.originated_entry_id).slice(0, 8) : '—'}
                      </TD>
                      <TD className="font-mono text-xs text-zinc-400">
                        {w.originator_id ? String(w.originator_id).slice(0, 8) : '—'}
                      </TD>
                      <TD className="text-zinc-400">{fmtDate(w.settlement_date)}</TD>
                      <TD className="text-zinc-400">{fmtDate(w.window_expiry)}</TD>
                      <TD className="text-right tabular-nums">
                        {dleft == null ? (
                          '—'
                        ) : dleft < 0 ? (
                          <span className="text-zinc-600">closed</span>
                        ) : (
                          <span className={dleft <= 7 ? 'text-red-300' : 'text-zinc-300'}>{dleft}</span>
                        )}
                      </TD>
                      <TD className="text-right tabular-nums">{fmtCents(w.amount_cents)}</TD>
                      <TD>
                        <Badge tone={statusTone(w.status ?? undefined)}>{w.status ?? 'open'}</Badge>
                      </TD>
                    </TR>
                  )
                })}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
