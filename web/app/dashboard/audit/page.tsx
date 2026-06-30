'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge, statusTone } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Stat } from '@/components/ui/Stat'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageSpinner } from '@/components/ui/Spinner'

interface AuditLog {
  id: string
  workspace_id?: string
  actor?: string | null
  action: string
  entity_type?: string | null
  entity_id?: string | null
  detail?: unknown
  created_at?: string
}

function fmtDateTime(d?: string | null) {
  if (!d) return '—'
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return d
  return dt.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function fmtTime(d?: string | null) {
  if (!d) return ''
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return ''
  return dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function dayKey(d?: string | null) {
  if (!d) return 'Unknown date'
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return 'Unknown date'
  return dt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

// Maps an action verb to a tone for the timeline dot + badge.
function actionTone(action: string): 'clear' | 'watch' | 'warning' | 'breach' | 'neutral' | 'info' {
  const a = action.toLowerCase()
  if (a.includes('delete') || a.includes('remove') || a.includes('breach') || a.includes('terminate')) return 'breach'
  if (a.includes('create') || a.includes('add') || a.includes('insert') || a.includes('generate') || a.includes('seed')) return 'clear'
  if (a.includes('update') || a.includes('edit') || a.includes('reclassify') || a.includes('recompute') || a.includes('rebuild')) return 'info'
  if (a.includes('snooze') || a.includes('acknowledge') || a.includes('match')) return 'watch'
  if (a.includes('warning') || a.includes('alert') || a.includes('escalate')) return 'warning'
  return 'neutral'
}

function detailString(detail: unknown): string {
  if (detail == null) return ''
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [entityTypeFilter, setEntityTypeFilter] = useState('')
  const [entityIdFilter, setEntityIdFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [actorFilter, setActorFilter] = useState('')
  const [search, setSearch] = useState('')

  const [detail, setDetail] = useState<AuditLog | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, unknown> = {}
      if (entityTypeFilter) params.entity_type = entityTypeFilter
      if (entityIdFilter.trim()) params.entity_id = entityIdFilter.trim()
      const rows = await api.getAudit(Object.keys(params).length ? params : undefined)
      setLogs(Array.isArray(rows) ? rows : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load audit log')
    } finally {
      setLoading(false)
    }
  }, [entityTypeFilter, entityIdFilter])

  useEffect(() => {
    load()
  }, [load])

  // Distinct values for filter dropdowns, derived from the loaded set.
  const entityTypes = useMemo(() => {
    const s = new Set<string>()
    for (const l of logs) if (l.entity_type) s.add(l.entity_type)
    return Array.from(s).sort()
  }, [logs])

  const actions = useMemo(() => {
    const s = new Set<string>()
    for (const l of logs) if (l.action) s.add(l.action)
    return Array.from(s).sort()
  }, [logs])

  const actors = useMemo(() => {
    const s = new Set<string>()
    for (const l of logs) if (l.actor) s.add(l.actor)
    return Array.from(s).sort()
  }, [logs])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return logs.filter((l) => {
      if (actionFilter && l.action !== actionFilter) return false
      if (actorFilter && l.actor !== actorFilter) return false
      if (!q) return true
      return (
        l.action?.toLowerCase().includes(q) ||
        (l.entity_type ?? '').toLowerCase().includes(q) ||
        (l.entity_id ?? '').toLowerCase().includes(q) ||
        (l.actor ?? '').toLowerCase().includes(q) ||
        detailString(l.detail).toLowerCase().includes(q)
      )
    })
  }, [logs, actionFilter, actorFilter, search])

  // Sort newest-first then group consecutive entries by calendar day.
  const groups = useMemo(() => {
    const sorted = [...filtered].sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0
      return tb - ta
    })
    const out: { day: string; items: AuditLog[] }[] = []
    for (const l of sorted) {
      const k = dayKey(l.created_at)
      const last = out[out.length - 1]
      if (last && last.day === k) last.items.push(l)
      else out.push({ day: k, items: [l] })
    }
    return out
  }, [filtered])

  const stats = useMemo(() => {
    const writes = logs.filter((l) => {
      const a = l.action.toLowerCase()
      return a.includes('create') || a.includes('update') || a.includes('add') || a.includes('generate')
    }).length
    const deletes = logs.filter((l) => l.action.toLowerCase().includes('delete')).length
    const last24 = logs.filter((l) => {
      if (!l.created_at) return false
      const t = new Date(l.created_at).getTime()
      return !isNaN(t) && Date.now() - t <= 86_400_000
    }).length
    return { total: logs.length, writes, deletes, last24 }
  }, [logs])

  const hasActiveFilters =
    !!entityTypeFilter || !!entityIdFilter.trim() || !!actionFilter || !!actorFilter || !!search.trim()

  function clearFilters() {
    setEntityTypeFilter('')
    setEntityIdFilter('')
    setActionFilter('')
    setActorFilter('')
    setSearch('')
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Audit Log</h1>
          <p className="mt-1 text-sm text-slate-400">
            Immutable record of every write to the ledger. Filter by entity, action or actor for compliance review.
          </p>
        </div>
        <Button variant="secondary" onClick={load}>
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Total events" value={stats.total} />
        <Stat label="Last 24h" value={stats.last24} tone="sky" />
        <Stat label="Writes" value={stats.writes} tone="emerald" />
        <Stat label="Deletes" value={stats.deletes} tone={stats.deletes ? 'red' : 'default'} />
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={entityTypeFilter}
              onChange={(e) => setEntityTypeFilter(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200"
            >
              <option value="">All entity types</option>
              {entityTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200"
            >
              <option value="">All actions</option>
              {actions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <select
              value={actorFilter}
              onChange={(e) => setActorFilter(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200"
            >
              <option value="">All actors</option>
              {actors.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <input
              value={entityIdFilter}
              onChange={(e) => setEntityIdFilter(e.target.value)}
              placeholder="Filter by entity ID…"
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600"
            />
            {hasActiveFilters && (
              <button onClick={clearFilters} className="text-xs text-slate-400 hover:text-white">
                Clear filters
              </button>
            )}
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search action, entity, actor, detail…"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600"
          />
        </CardHeader>
        <CardBody>
          {loading ? (
            <PageSpinner label="Loading audit log…" />
          ) : error ? (
            <div className="px-5 py-10 text-center text-sm text-red-300">
              {error}
              <div className="mt-3">
                <Button variant="secondary" onClick={load}>
                  Retry
                </Button>
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              title={logs.length === 0 ? 'No audit events yet' : 'No events match your filters'}
              description={
                logs.length === 0
                  ? 'Every create, update and delete across the workspace will appear here as it happens.'
                  : 'Try clearing filters or the search box.'
              }
              action={
                hasActiveFilters && logs.length > 0 ? (
                  <Button variant="secondary" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="space-y-8">
              {groups.map((g) => (
                <div key={g.day}>
                  <div className="sticky top-0 z-10 -mx-5 mb-3 bg-slate-900/80 px-5 py-1.5 backdrop-blur">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">{g.day}</span>
                    <span className="ml-2 text-xs text-slate-600">{g.items.length} events</span>
                  </div>
                  <ol className="relative ml-3 space-y-4 border-l border-slate-800 pl-6">
                    {g.items.map((l) => {
                      const tone = actionTone(l.action)
                      const ds = detailString(l.detail)
                      return (
                        <li key={l.id} className="relative">
                          <span
                            className={`absolute -left-[1.65rem] top-1.5 h-2.5 w-2.5 rounded-full border ${dotClass(tone)}`}
                            aria-hidden
                          />
                          <button
                            onClick={() => setDetail(l)}
                            className="block w-full rounded-lg border border-slate-800 bg-slate-950/40 px-4 py-3 text-left transition-colors hover:border-slate-700 hover:bg-slate-900/60"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge tone={tone}>{l.action}</Badge>
                              {l.entity_type && (
                                <span className="text-sm font-medium text-white">{l.entity_type}</span>
                              )}
                              {l.entity_id && (
                                <span className="font-mono text-xs text-slate-500">{l.entity_id}</span>
                              )}
                              <span className="ml-auto text-xs tabular-nums text-slate-500">
                                {fmtTime(l.created_at)}
                              </span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                              {l.actor && (
                                <span>
                                  by <span className="text-slate-300">{l.actor}</span>
                                </span>
                              )}
                              {ds && <span className="truncate font-mono text-slate-600">{ds}</span>}
                            </div>
                          </button>
                        </li>
                      )
                    })}
                  </ol>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        title="Audit event"
        footer={<Button onClick={() => setDetail(null)}>Close</Button>}
      >
        {detail && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={actionTone(detail.action)}>{detail.action}</Badge>
              {detail.entity_type && <Badge tone={statusTone(detail.entity_type)}>{detail.entity_type}</Badge>}
            </div>
            <div className="grid grid-cols-2 gap-3 text-slate-300">
              <Detail label="Actor" value={detail.actor ?? 'system'} />
              <Detail label="When" value={fmtDateTime(detail.created_at)} />
              <Detail label="Entity type" value={detail.entity_type ?? '—'} />
              <Detail
                label="Entity ID"
                value={detail.entity_id ? <span className="font-mono text-xs">{detail.entity_id}</span> : '—'}
              />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Detail</div>
              {detail.detail == null ? (
                <p className="text-slate-500">No additional detail recorded.</p>
              ) : (
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950/60 p-3 font-mono text-xs text-slate-200">
                  {typeof detail.detail === 'string'
                    ? detail.detail
                    : JSON.stringify(detail.detail, null, 2)}
                </pre>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

function dotClass(tone: string) {
  switch (tone) {
    case 'clear':
      return 'border-emerald-400 bg-emerald-500'
    case 'info':
      return 'border-sky-400 bg-sky-500'
    case 'watch':
      return 'border-amber-400 bg-amber-500'
    case 'warning':
      return 'border-orange-400 bg-orange-500'
    case 'breach':
      return 'border-red-400 bg-red-500'
    default:
      return 'border-slate-600 bg-slate-700'
  }
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-0.5 break-words text-slate-200">{value}</div>
    </div>
  )
}
