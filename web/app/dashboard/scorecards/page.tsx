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

interface Scorecard {
  id: string
  originator_id: string
  originator_name?: string
  name?: string
  composite_score: number
  grade: string
  headroom_score: number
  velocity_score: number
  volume_score: number
  representment_score: number
  percentile: number
  computed_at?: string
}

interface SavedView {
  id: string
  name: string
  scope: string
  filters: Record<string, unknown>
  created_at?: string
}

type SortKey =
  | 'originator_name'
  | 'composite_score'
  | 'grade'
  | 'headroom_score'
  | 'velocity_score'
  | 'volume_score'
  | 'representment_score'
  | 'percentile'

type SortDir = 'asc' | 'desc'

const VIEW_SCOPE = 'scorecards'

function gradeTone(grade?: string): 'clear' | 'watch' | 'warning' | 'breach' | 'neutral' {
  switch ((grade ?? '').toUpperCase().charAt(0)) {
    case 'A':
      return 'clear'
    case 'B':
      return 'watch'
    case 'C':
      return 'warning'
    case 'D':
    case 'F':
      return 'breach'
    default:
      return 'neutral'
  }
}

function scoreTone(score: number): string {
  if (score >= 80) return 'text-amber-300'
  if (score >= 60) return 'text-amber-300'
  if (score >= 40) return 'text-orange-300'
  return 'text-red-300'
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function originatorLabel(s: Scorecard): string {
  return s.originator_name || s.name || s.originator_id
}

function ScoreBar({ score, label }: { score: number; label: string }) {
  const pct = Math.max(0, Math.min(100, num(score)))
  const color =
    pct >= 80 ? 'bg-amber-500' : pct >= 60 ? 'bg-amber-500' : pct >= 40 ? 'bg-orange-500' : 'bg-red-500'
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-zinc-400">
        <span>{label}</span>
        <span className="tabular-nums text-zinc-300">{pct.toFixed(0)}</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function ScorecardsPage() {
  const [scorecards, setScorecards] = useState<Scorecard[]>([])
  const [views, setViews] = useState<SavedView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [recomputing, setRecomputing] = useState(false)
  const [actionMsg, setActionMsg] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [gradeFilter, setGradeFilter] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('composite_score')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [activeView, setActiveView] = useState<string>('')

  const [saveOpen, setSaveOpen] = useState(false)
  const [viewName, setViewName] = useState('')
  const [savingView, setSavingView] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [cards, vws] = await Promise.all([
        api.getScorecards(),
        api.getViews(VIEW_SCOPE).catch(() => []),
      ])
      setScorecards(Array.isArray(cards) ? cards : [])
      setViews(Array.isArray(vws) ? vws : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load scorecards')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const recompute = async () => {
    setRecomputing(true)
    setActionMsg(null)
    setError(null)
    try {
      const res = await api.recomputeScorecards()
      const computed = res && typeof res === 'object' && 'computed' in res ? (res as { computed: number }).computed : undefined
      setActionMsg(computed != null ? `Recomputed ${computed} scorecards` : 'Scorecards recomputed')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recompute failed')
    } finally {
      setRecomputing(false)
    }
  }

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'originator_name' || key === 'grade' ? 'asc' : 'desc')
    }
    setActiveView('')
  }

  const applyView = (v: SavedView) => {
    setActiveView(v.id)
    const f = v.filters || {}
    setSearch(typeof f.search === 'string' ? f.search : '')
    setGradeFilter(typeof f.grade === 'string' ? f.grade : '')
    if (typeof f.sortKey === 'string') setSortKey(f.sortKey as SortKey)
    if (typeof f.sortDir === 'string') setSortDir(f.sortDir as SortDir)
  }

  const saveView = async () => {
    if (!viewName.trim()) return
    setSavingView(true)
    setError(null)
    try {
      const created = await api.createView({
        name: viewName.trim(),
        scope: VIEW_SCOPE,
        filters: { search, grade: gradeFilter, sortKey, sortDir },
      })
      setViews((prev) => [created as SavedView, ...prev])
      setActiveView((created as SavedView).id)
      setSaveOpen(false)
      setViewName('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save view')
    } finally {
      setSavingView(false)
    }
  }

  const removeView = async (id: string) => {
    try {
      await api.deleteView(id)
      setViews((prev) => prev.filter((v) => v.id !== id))
      if (activeView === id) setActiveView('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete view')
    }
  }

  const grades = useMemo(() => {
    const set = new Set<string>()
    scorecards.forEach((s) => s.grade && set.add(s.grade))
    return Array.from(set).sort()
  }, [scorecards])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = scorecards.filter((s) => {
      if (q && !originatorLabel(s).toLowerCase().includes(q)) return false
      if (gradeFilter && s.grade !== gradeFilter) return false
      return true
    })
    const dir = sortDir === 'asc' ? 1 : -1
    rows.sort((a, b) => {
      let av: number | string
      let bv: number | string
      if (sortKey === 'originator_name') {
        av = originatorLabel(a).toLowerCase()
        bv = originatorLabel(b).toLowerCase()
      } else if (sortKey === 'grade') {
        av = (a.grade ?? '').toUpperCase()
        bv = (b.grade ?? '').toUpperCase()
      } else {
        av = num(a[sortKey])
        bv = num(b[sortKey])
      }
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return 0
    })
    return rows
  }, [scorecards, search, gradeFilter, sortKey, sortDir])

  const avgComposite = useMemo(() => {
    if (!scorecards.length) return 0
    return scorecards.reduce((acc, s) => acc + num(s.composite_score), 0) / scorecards.length
  }, [scorecards])

  const atRiskCount = useMemo(
    () => scorecards.filter((s) => gradeTone(s.grade) === 'breach' || gradeTone(s.grade) === 'warning').length,
    [scorecards],
  )

  const topPerformer = useMemo(() => {
    return scorecards.reduce<Scorecard | null>((best, s) => {
      if (!best || num(s.composite_score) > num(best.composite_score)) return s
      return best
    }, null)
  }, [scorecards])

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return <span className="ml-1 text-zinc-600">↕</span>
    return <span className="ml-1 text-amber-400">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  if (loading) return <PageSpinner label="Loading scorecards..." />

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Originator Scorecards</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Composite risk grades blending headroom, velocity, volume, and re-presentment performance.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setSaveOpen(true)} disabled={!scorecards.length}>
            Save current view
          </Button>
          <Button onClick={recompute} disabled={recomputing}>
            {recomputing ? 'Recomputing...' : 'Recompute scores'}
          </Button>
        </div>
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Originators scored" value={scorecards.length} />
        <Stat
          label="Avg composite"
          value={avgComposite.toFixed(1)}
          tone={avgComposite >= 70 ? 'emerald' : avgComposite >= 50 ? 'amber' : 'red'}
        />
        <Stat label="At-risk grades" value={atRiskCount} tone={atRiskCount > 0 ? 'amber' : 'emerald'} hint="Grade C or below" />
        <Stat
          label="Top performer"
          value={topPerformer ? originatorLabel(topPerformer) : '—'}
          hint={topPerformer ? `Grade ${topPerformer.grade} · ${num(topPerformer.composite_score).toFixed(0)}` : undefined}
        />
      </div>

      {views.length > 0 && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <span className="text-sm font-semibold text-white">Saved views</span>
            <span className="text-xs text-zinc-500">{views.length} saved</span>
          </CardHeader>
          <CardBody className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setActiveView('')
                setSearch('')
                setGradeFilter('')
              }}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                activeView === ''
                  ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                  : 'border-zinc-700 bg-zinc-800/50 text-zinc-300 hover:bg-zinc-700'
              }`}
            >
              All originators
            </button>
            {views.map((v) => (
              <span
                key={v.id}
                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeView === v.id
                    ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                    : 'border-zinc-700 bg-zinc-800/50 text-zinc-300'
                }`}
              >
                <button onClick={() => applyView(v)} className="hover:text-white">
                  {v.name}
                </button>
                <button
                  onClick={() => removeView(v.id)}
                  className="text-zinc-500 hover:text-red-300"
                  aria-label={`Delete view ${v.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setActiveView('')
            }}
            placeholder="Search originators..."
            className="w-56 rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-amber-500/50 focus:outline-none"
          />
          <select
            value={gradeFilter}
            onChange={(e) => {
              setGradeFilter(e.target.value)
              setActiveView('')
            }}
            className="rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-200 focus:border-amber-500/50 focus:outline-none"
          >
            <option value="">All grades</option>
            {grades.map((g) => (
              <option key={g} value={g}>
                Grade {g}
              </option>
            ))}
          </select>
          <span className="ml-auto text-xs text-zinc-500">
            {filtered.length} of {scorecards.length}
          </span>
        </CardHeader>
        <CardBody className="p-0">
          {filtered.length === 0 ? (
            <EmptyState
              title={scorecards.length === 0 ? 'No scorecards yet' : 'No matches'}
              description={
                scorecards.length === 0
                  ? 'Recompute scores once originators and returns are loaded.'
                  : 'Adjust your search or grade filter.'
              }
              action={
                scorecards.length === 0 ? (
                  <Button onClick={recompute} disabled={recomputing}>
                    {recomputing ? 'Recomputing...' : 'Recompute scores'}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH className="cursor-pointer select-none" onClick={() => toggleSort('originator_name')}>
                    Originator{sortIndicator('originator_name')}
                  </TH>
                  <TH className="cursor-pointer select-none" onClick={() => toggleSort('grade')}>
                    Grade{sortIndicator('grade')}
                  </TH>
                  <TH className="cursor-pointer select-none text-right" onClick={() => toggleSort('composite_score')}>
                    Composite{sortIndicator('composite_score')}
                  </TH>
                  <TH className="cursor-pointer select-none text-right" onClick={() => toggleSort('headroom_score')}>
                    Headroom{sortIndicator('headroom_score')}
                  </TH>
                  <TH className="cursor-pointer select-none text-right" onClick={() => toggleSort('velocity_score')}>
                    Velocity{sortIndicator('velocity_score')}
                  </TH>
                  <TH className="cursor-pointer select-none text-right" onClick={() => toggleSort('volume_score')}>
                    Volume{sortIndicator('volume_score')}
                  </TH>
                  <TH className="cursor-pointer select-none text-right" onClick={() => toggleSort('representment_score')}>
                    Re-present{sortIndicator('representment_score')}
                  </TH>
                  <TH className="cursor-pointer select-none text-right" onClick={() => toggleSort('percentile')}>
                    Percentile{sortIndicator('percentile')}
                  </TH>
                </TR>
              </THead>
              <TBody>
                {filtered.map((s) => (
                  <TR key={s.id}>
                    <TD className="font-medium text-white">{originatorLabel(s)}</TD>
                    <TD>
                      <Badge tone={gradeTone(s.grade)}>{s.grade || '—'}</Badge>
                    </TD>
                    <TD className={`text-right font-semibold tabular-nums ${scoreTone(num(s.composite_score))}`}>
                      {num(s.composite_score).toFixed(1)}
                    </TD>
                    <TD className="text-right tabular-nums text-zinc-300">{num(s.headroom_score).toFixed(0)}</TD>
                    <TD className="text-right tabular-nums text-zinc-300">{num(s.velocity_score).toFixed(0)}</TD>
                    <TD className="text-right tabular-nums text-zinc-300">{num(s.volume_score).toFixed(0)}</TD>
                    <TD className="text-right tabular-nums text-zinc-300">{num(s.representment_score).toFixed(0)}</TD>
                    <TD className="text-right tabular-nums text-zinc-300">
                      {num(s.percentile).toFixed(0)}
                      <span className="text-zinc-600">th</span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {filtered.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.slice(0, 6).map((s) => (
            <Card key={`bd-${s.id}`}>
              <CardHeader className="flex items-center justify-between">
                <span className="truncate text-sm font-semibold text-white">{originatorLabel(s)}</span>
                <Badge tone={gradeTone(s.grade)}>{s.grade || '—'}</Badge>
              </CardHeader>
              <CardBody className="space-y-3">
                <ScoreBar label="Headroom" score={num(s.headroom_score)} />
                <ScoreBar label="Velocity" score={num(s.velocity_score)} />
                <ScoreBar label="Volume" score={num(s.volume_score)} />
                <ScoreBar label="Re-presentment" score={num(s.representment_score)} />
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save current view"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveView} disabled={savingView || !viewName.trim()}>
              {savingView ? 'Saving...' : 'Save view'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">View name</label>
            <input
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              placeholder="e.g. At-risk originators"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-amber-500/50 focus:outline-none"
            />
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400">
            Captures: search {search ? `"${search}"` : '(none)'}, grade {gradeFilter || 'all'}, sorted by {sortKey} {sortDir}.
          </div>
        </div>
      </Modal>
    </div>
  )
}
