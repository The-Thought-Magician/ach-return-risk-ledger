'use client'

import { useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Card, CardHeader, CardBody } from '@/components/ui/card'
import { Stat } from '@/components/ui/Stat'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Modal } from '@/components/ui/Modal'
import { PageSpinner, Spinner } from '@/components/ui/Spinner'

interface Alert {
  id: string
  workspace_id: string
  rule_id: string | null
  originator_id: string | null
  severity: string
  title: string
  body: string | null
  snapshot: Record<string, unknown> | null
  status: string
  snoozed_until: string | null
  fired_at: string | null
  created_at: string | null
}

const STATUS_FILTERS = ['all', 'open', 'unread', 'acknowledged', 'snoozed', 'read'] as const
const SEVERITY_FILTERS = ['all', 'breach', 'warning', 'watch'] as const

function severityTone(sev: string): 'watch' | 'warning' | 'breach' | 'neutral' {
  switch ((sev ?? '').toLowerCase()) {
    case 'watch':
      return 'watch'
    case 'warning':
      return 'warning'
    case 'breach':
      return 'breach'
    default:
      return 'neutral'
  }
}

function statusBadgeTone(status: string): 'clear' | 'watch' | 'warning' | 'neutral' {
  switch ((status ?? '').toLowerCase()) {
    case 'acknowledged':
      return 'clear'
    case 'snoozed':
      return 'watch'
    case 'open':
    case 'unread':
      return 'warning'
    default:
      return 'neutral'
  }
}

function fmtTime(d: string | null | undefined): string {
  if (!d) return '—'
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return '—'
  return dt.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

const SNOOZE_PRESETS = [
  { label: '1 hour', hours: 1 },
  { label: '4 hours', hours: 4 },
  { label: '1 day', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '1 week', hours: 168 },
] as const

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>('all')
  const [severityFilter, setSeverityFilter] = useState<(typeof SEVERITY_FILTERS)[number]>('all')
  const [evaluating, setEvaluating] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [detail, setDetail] = useState<Alert | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [snoozeFor, setSnoozeFor] = useState<Alert | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, unknown> = {}
      if (statusFilter !== 'all') params.status = statusFilter
      if (severityFilter !== 'all') params.severity = severityFilter
      const a = await api.getAlerts(Object.keys(params).length ? params : undefined)
      setAlerts(Array.isArray(a) ? a : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load alerts')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, severityFilter])

  async function onEvaluate() {
    setEvaluating(true)
    setNotice(null)
    setError(null)
    try {
      const res = await api.evaluateAlerts()
      const fired = res && typeof res.fired === 'number' ? res.fired : 0
      setNotice(
        fired > 0
          ? `Evaluation complete — ${fired} new alert${fired === 1 ? '' : 's'} fired.`
          : 'Evaluation complete — no thresholds tripped.',
      )
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Evaluation failed')
    } finally {
      setEvaluating(false)
    }
  }

  async function openDetail(a: Alert) {
    setDetail(a)
    setDetailLoading(true)
    try {
      const d = await api.getAlert(a.id)
      if (d && d.id) setDetail(d)
      // Auto-mark read on open if not already.
      if ((d?.status ?? a.status) !== 'read' && (d?.status ?? a.status) !== 'acknowledged') {
        await api.readAlert(a.id)
        await load()
      }
    } catch {
      /* keep row data */
    } finally {
      setDetailLoading(false)
    }
  }

  async function onAck(a: Alert) {
    setBusyId(a.id)
    setError(null)
    try {
      await api.acknowledgeAlert(a.id)
      setNotice(`Acknowledged "${a.title}".`)
      await load()
      if (detail?.id === a.id) setDetail({ ...detail, status: 'acknowledged' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Acknowledge failed')
    } finally {
      setBusyId(null)
    }
  }

  async function onRead(a: Alert) {
    setBusyId(a.id)
    setError(null)
    try {
      await api.readAlert(a.id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mark read failed')
    } finally {
      setBusyId(null)
    }
  }

  async function onSnooze(a: Alert, hours: number) {
    setBusyId(a.id)
    setError(null)
    try {
      const until = new Date(Date.now() + hours * 3_600_000).toISOString()
      await api.snoozeAlert(a.id, until)
      setNotice(`Snoozed "${a.title}".`)
      setSnoozeFor(null)
      await load()
      if (detail?.id === a.id) setDetail({ ...detail, status: 'snoozed', snoozed_until: until })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Snooze failed')
    } finally {
      setBusyId(null)
    }
  }

  const counts = useMemo(() => {
    const open = alerts.filter((a) =>
      ['open', 'unread'].includes((a.status ?? '').toLowerCase()),
    ).length
    const breach = alerts.filter((a) => (a.severity ?? '').toLowerCase() === 'breach').length
    const snoozed = alerts.filter((a) => (a.status ?? '').toLowerCase() === 'snoozed').length
    return { open, breach, snoozed }
  }, [alerts])

  if (loading) return <PageSpinner label="Loading alerts..." />

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Alert Inbox</h1>
          <p className="mt-1 text-sm text-slate-400">
            Compliance alerts fired by your rules. Acknowledge to record action, snooze to defer, or
            evaluate now to re-run all enabled rules against current data.
          </p>
        </div>
        <Button variant="primary" onClick={onEvaluate} disabled={evaluating}>
          {evaluating ? 'Evaluating…' : 'Evaluate now'}
        </Button>
      </header>

      {notice && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Open / unread" value={counts.open.toLocaleString()} tone="amber" />
        <Stat label="Breach severity" value={counts.breach.toLocaleString()} tone="red" />
        <Stat label="Snoozed" value={counts.snoozed.toLocaleString()} tone="sky" />
      </div>

      <Card>
        <CardHeader className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-slate-500">Status</span>
            <div className="flex gap-1">
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize ${
                    statusFilter === s
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-slate-500">Severity</span>
            <div className="flex gap-1">
              {SEVERITY_FILTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => setSeverityFilter(s)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize ${
                    severityFilter === s
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {alerts.length === 0 ? (
            <EmptyState
              title="Inbox is clear"
              description="No alerts match this filter. Run an evaluation to check your rules against current rates, forecasts, and dispute windows."
              action={
                <Button variant="primary" onClick={onEvaluate} disabled={evaluating}>
                  Evaluate now
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-slate-800">
              {alerts.map((a) => {
                const isUnread = ['open', 'unread'].includes((a.status ?? '').toLowerCase())
                return (
                  <li
                    key={a.id}
                    className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <button
                      onClick={() => openDetail(a)}
                      className="flex min-w-0 flex-1 items-start gap-3 text-left"
                    >
                      <span
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                          isUnread ? 'bg-emerald-400' : 'bg-slate-700'
                        }`}
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span
                            className={`truncate text-sm ${isUnread ? 'font-semibold text-white' : 'text-slate-300'}`}
                          >
                            {a.title}
                          </span>
                          <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>
                          <Badge tone={statusBadgeTone(a.status)}>{a.status}</Badge>
                        </span>
                        {a.body && (
                          <span className="mt-0.5 block truncate text-xs text-slate-500">{a.body}</span>
                        )}
                        <span className="mt-0.5 block text-[11px] text-slate-600">
                          Fired {fmtTime(a.fired_at ?? a.created_at)}
                          {a.status?.toLowerCase() === 'snoozed' && a.snoozed_until
                            ? ` · snoozed until ${fmtTime(a.snoozed_until)}`
                            : ''}
                        </span>
                      </span>
                    </button>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        variant="secondary"
                        className="px-2 py-1 text-xs"
                        onClick={() => onAck(a)}
                        disabled={busyId === a.id || a.status?.toLowerCase() === 'acknowledged'}
                      >
                        Ack
                      </Button>
                      <Button
                        variant="ghost"
                        className="px-2 py-1 text-xs"
                        onClick={() => setSnoozeFor(a)}
                        disabled={busyId === a.id}
                      >
                        Snooze
                      </Button>
                      {isUnread && (
                        <Button
                          variant="ghost"
                          className="px-2 py-1 text-xs"
                          onClick={() => onRead(a)}
                          disabled={busyId === a.id}
                        >
                          Mark read
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* Detail modal */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.title ?? 'Alert'}
        footer={
          detail && (
            <>
              <Button variant="ghost" onClick={() => setDetail(null)}>
                Close
              </Button>
              <Button
                variant="secondary"
                onClick={() => setSnoozeFor(detail)}
                disabled={busyId === detail.id}
              >
                Snooze
              </Button>
              <Button
                variant="primary"
                onClick={() => onAck(detail)}
                disabled={busyId === detail.id || detail.status?.toLowerCase() === 'acknowledged'}
              >
                Acknowledge
              </Button>
            </>
          )
        }
      >
        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={severityTone(detail.severity)}>{detail.severity}</Badge>
              <Badge tone={statusBadgeTone(detail.status)}>{detail.status}</Badge>
              <span className="text-xs text-slate-500">
                Fired {fmtTime(detail.fired_at ?? detail.created_at)}
              </span>
            </div>
            {detail.body && <p className="text-sm text-slate-300">{detail.body}</p>}
            <div className="grid grid-cols-2 gap-3 text-xs">
              <Meta label="Rule" value={detail.rule_id ? String(detail.rule_id).slice(0, 12) : '—'} />
              <Meta
                label="Originator"
                value={detail.originator_id ? String(detail.originator_id).slice(0, 12) : 'portfolio'}
              />
              {detail.snoozed_until && (
                <Meta label="Snoozed until" value={fmtTime(detail.snoozed_until)} />
              )}
            </div>
            {detailLoading && <Spinner label="Refreshing…" className="justify-start" />}
            {detail.snapshot && Object.keys(detail.snapshot).length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
                  Snapshot at fire time
                </div>
                <pre className="max-h-56 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-300">
                  {JSON.stringify(detail.snapshot, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Snooze picker modal */}
      <Modal
        open={!!snoozeFor}
        onClose={() => setSnoozeFor(null)}
        title="Snooze alert"
        footer={
          <Button variant="ghost" onClick={() => setSnoozeFor(null)}>
            Cancel
          </Button>
        }
      >
        {snoozeFor && (
          <div className="space-y-3">
            <p className="text-sm text-slate-400">
              Defer <span className="text-slate-200">{snoozeFor.title}</span>. It returns to the inbox
              when the snooze expires.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {SNOOZE_PRESETS.map((p) => (
                <Button
                  key={p.hours}
                  variant="secondary"
                  onClick={() => onSnooze(snoozeFor, p.hours)}
                  disabled={busyId === snoozeFor.id}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-0.5 font-mono text-slate-200">{value}</div>
    </div>
  )
}
