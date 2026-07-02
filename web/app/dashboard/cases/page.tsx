'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge, statusTone } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Stat } from '@/components/ui/Stat'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageSpinner, Spinner } from '@/components/ui/Spinner'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'

interface Originator {
  id: string
  name: string
}

interface NoteEntry {
  text?: string
  at?: string
  [k: string]: unknown
}

interface RemediationCase {
  id: string
  originator_id: string
  letter_id?: string | null
  title: string
  description?: string | null
  status: string
  priority: string
  notes?: NoteEntry[] | null
  created_at?: string
  updated_at?: string
}

interface CaseAction {
  id: string
  case_id: string
  title: string
  done: boolean
  due_date?: string | null
  assigned_to?: string | null
  created_at?: string
}

const STATUSES = ['open', 'in-progress', 'blocked', 'resolved', 'closed']
const PRIORITIES = ['low', 'medium', 'high', 'critical']

const priorityTone: Record<string, 'neutral' | 'info' | 'watch' | 'warning' | 'breach'> = {
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'breach',
}

const emptyForm = {
  originator_id: '',
  title: '',
  description: '',
  status: 'open',
  priority: 'medium',
}

function fmtDate(d?: string | null) {
  if (!d) return '—'
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return d
  return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function CasesPage() {
  const [cases, setCases] = useState<RemediationCase[]>([])
  const [originators, setOriginators] = useState<Originator[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [statusFilter, setStatusFilter] = useState('')
  const [originatorFilter, setOriginatorFilter] = useState('')
  const [search, setSearch] = useState('')

  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // Detail drawer
  const [activeId, setActiveId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RemediationCase | null>(null)
  const [actions, setActions] = useState<CaseAction[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const [noteText, setNoteText] = useState('')
  const [newAction, setNewAction] = useState({ title: '', due_date: '', assigned_to: '' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, unknown> = {}
      if (statusFilter) params.status = statusFilter
      if (originatorFilter) params.originator_id = originatorFilter
      const [cs, orgs] = await Promise.all([api.getCases(params), api.getOriginators()])
      setCases(Array.isArray(cs) ? cs : [])
      setOriginators(Array.isArray(orgs) ? orgs : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load cases')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, originatorFilter])

  useEffect(() => {
    load()
  }, [load])

  const orgName = useCallback(
    (id: string) => originators.find((o) => o.id === id)?.name ?? 'Unknown originator',
    [originators],
  )

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true)
    setDetailError(null)
    try {
      const res = await api.getCase(id)
      // backend returns { case, actions }
      const c = (res?.case ?? res) as RemediationCase
      const acts = (res?.actions ?? []) as CaseAction[]
      setDetail(c)
      setActions(Array.isArray(acts) ? acts : [])
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : 'Failed to load case')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  function openDetail(id: string) {
    setActiveId(id)
    setDetail(null)
    setActions([])
    setNoteText('')
    setNewAction({ title: '', due_date: '', assigned_to: '' })
    loadDetail(id)
  }

  function closeDetail() {
    setActiveId(null)
    setDetail(null)
    setActions([])
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return cases
    return cases.filter(
      (c) =>
        c.title?.toLowerCase().includes(q) ||
        c.description?.toLowerCase().includes(q) ||
        orgName(c.originator_id).toLowerCase().includes(q),
    )
  }, [cases, search, orgName])

  const stats = useMemo(() => {
    const open = cases.filter((c) => !['resolved', 'closed'].includes(c.status)).length
    const critical = cases.filter(
      (c) => c.priority === 'critical' && !['resolved', 'closed'].includes(c.status),
    ).length
    const blocked = cases.filter((c) => c.status === 'blocked').length
    return { total: cases.length, open, critical, blocked }
  }, [cases])

  function openCreate() {
    setForm({ ...emptyForm, originator_id: originators[0]?.id ?? '' })
    setFormError(null)
    setCreateOpen(true)
  }

  async function createCase() {
    if (!form.originator_id) {
      setFormError('Select an originator')
      return
    }
    if (!form.title.trim()) {
      setFormError('Title is required')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      await api.createCase({
        originator_id: form.originator_id,
        title: form.title.trim(),
        description: form.description.trim() || null,
        status: form.status,
        priority: form.priority,
      })
      setCreateOpen(false)
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Create failed')
    } finally {
      setSaving(false)
    }
  }

  async function patchCase(patch: Record<string, unknown>) {
    if (!detail) return
    setBusy(true)
    try {
      const updated = await api.updateCase(detail.id, patch)
      const c = (updated?.case ?? updated) as RemediationCase
      if (c && c.id) setDetail(c)
      else await loadDetail(detail.id)
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setBusy(false)
    }
  }

  async function appendNote() {
    if (!detail || !noteText.trim()) return
    setBusy(true)
    try {
      await api.updateCase(detail.id, { note: noteText.trim() })
      setNoteText('')
      await loadDetail(detail.id)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to add note')
    } finally {
      setBusy(false)
    }
  }

  async function addAction() {
    if (!detail || !newAction.title.trim()) return
    setBusy(true)
    try {
      await api.addCaseAction(detail.id, {
        title: newAction.title.trim(),
        due_date: newAction.due_date || null,
        assigned_to: newAction.assigned_to.trim() || null,
      })
      setNewAction({ title: '', due_date: '', assigned_to: '' })
      await loadDetail(detail.id)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to add action')
    } finally {
      setBusy(false)
    }
  }

  async function toggleAction(a: CaseAction) {
    if (!detail) return
    setActions((prev) => prev.map((x) => (x.id === a.id ? { ...x, done: !x.done } : x)))
    try {
      await api.updateCaseAction(detail.id, a.id, { done: !a.done })
    } catch (e) {
      // revert on failure
      setActions((prev) => prev.map((x) => (x.id === a.id ? { ...x, done: a.done } : x)))
      alert(e instanceof Error ? e.message : 'Failed to update action')
    }
  }

  const notes = (detail?.notes ?? []).filter(Boolean) as NoteEntry[]
  const doneCount = actions.filter((a) => a.done).length

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Remediation Cases</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Manage corrective-action cases tied to originators and warning letters, with action checklists and notes.
          </p>
        </div>
        <Button onClick={openCreate} disabled={originators.length === 0}>
          Open case
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Total cases" value={stats.total} />
        <Stat label="Open" value={stats.open} tone="amber" />
        <Stat label="Critical open" value={stats.critical} tone={stats.critical ? 'red' : 'default'} />
        <Stat label="Blocked" value={stats.blocked} tone={stats.blocked ? 'red' : 'default'} />
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200"
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              value={originatorFilter}
              onChange={(e) => setOriginatorFilter(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200"
            >
              <option value="">All originators</option>
              {originators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, description, originator…"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 sm:w-72"
          />
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <PageSpinner label="Loading cases…" />
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
              title={cases.length === 0 ? 'No remediation cases yet' : 'No cases match your filters'}
              description={
                cases.length === 0
                  ? 'Open a case to coordinate corrective actions for an at-risk originator.'
                  : 'Try clearing filters or the search box.'
              }
              action={
                cases.length === 0 ? (
                  <Button onClick={openCreate} disabled={originators.length === 0}>
                    Open case
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Case</TH>
                  <TH>Originator</TH>
                  <TH>Priority</TH>
                  <TH>Status</TH>
                  <TH>Updated</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {filtered.map((c) => (
                  <TR key={c.id}>
                    <TD>
                      <button
                        onClick={() => openDetail(c.id)}
                        className="text-left font-medium text-white hover:text-amber-300"
                      >
                        {c.title}
                      </button>
                      {c.description && (
                        <div className="mt-0.5 line-clamp-1 max-w-md text-xs text-zinc-500">{c.description}</div>
                      )}
                    </TD>
                    <TD className="text-zinc-300">{orgName(c.originator_id)}</TD>
                    <TD>
                      <Badge tone={priorityTone[c.priority] ?? 'neutral'}>{c.priority}</Badge>
                    </TD>
                    <TD>
                      <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                    </TD>
                    <TD className="text-zinc-400">{fmtDate(c.updated_at ?? c.created_at)}</TD>
                    <TD className="text-right">
                      <button
                        onClick={() => openDetail(c.id)}
                        className="text-xs text-sky-400 hover:text-sky-300"
                      >
                        Open
                      </button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {/* Create modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Open remediation case"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={createCase} disabled={saving}>
              {saving ? 'Opening…' : 'Open case'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {formError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {formError}
            </div>
          )}
          <Field label="Originator">
            <select
              value={form.originator_id}
              onChange={(e) => setForm({ ...form, originator_id: e.target.value })}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
            >
              <option value="">Select originator…</option>
              {originators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title">
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="e.g. Reduce unauthorized returns below 0.5%"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Priority">
              <select
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value })}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Description">
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={4}
              placeholder="Context, root cause, plan of action…"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600"
            />
          </Field>
        </div>
      </Modal>

      {/* Detail modal */}
      <Modal
        open={activeId !== null}
        onClose={closeDetail}
        title={detail?.title ?? 'Case'}
        className="max-w-2xl"
        footer={<Button onClick={closeDetail}>Close</Button>}
      >
        {detailLoading ? (
          <Spinner label="Loading case…" className="py-8" />
        ) : detailError ? (
          <div className="py-6 text-center text-sm text-red-300">
            {detailError}
            <div className="mt-3">
              <Button variant="secondary" onClick={() => activeId && loadDetail(activeId)}>
                Retry
              </Button>
            </div>
          </div>
        ) : detail ? (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={priorityTone[detail.priority] ?? 'neutral'}>{detail.priority}</Badge>
              <Badge tone={statusTone(detail.status)}>{detail.status}</Badge>
              <span className="text-xs text-zinc-500">{orgName(detail.originator_id)}</span>
            </div>

            {detail.description && (
              <p className="whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-zinc-200">
                {detail.description}
              </p>
            )}

            {/* Status + priority controls */}
            <div className="grid grid-cols-2 gap-4">
              <Field label="Status">
                <select
                  value={detail.status}
                  disabled={busy}
                  onChange={(e) => patchCase({ status: e.target.value })}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Priority">
                <select
                  value={detail.priority}
                  disabled={busy}
                  onChange={(e) => patchCase({ priority: e.target.value })}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {/* Action items */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Action items {actions.length > 0 && `(${doneCount}/${actions.length})`}
                </h3>
              </div>
              {actions.length > 0 && (
                <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-amber-500 transition-all"
                    style={{ width: `${actions.length ? (doneCount / actions.length) * 100 : 0}%` }}
                  />
                </div>
              )}
              <ul className="space-y-1.5">
                {actions.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/30 px-3 py-2"
                  >
                    <input
                      type="checkbox"
                      checked={a.done}
                      onChange={() => toggleAction(a)}
                      className="h-4 w-4 accent-amber-500"
                    />
                    <span className={`flex-1 ${a.done ? 'text-zinc-500 line-through' : 'text-zinc-200'}`}>
                      {a.title}
                    </span>
                    {a.assigned_to && <span className="text-xs text-zinc-500">{a.assigned_to}</span>}
                    {a.due_date && <span className="text-xs text-amber-400">{fmtDate(a.due_date)}</span>}
                  </li>
                ))}
                {actions.length === 0 && (
                  <li className="rounded-lg border border-dashed border-zinc-800 px-3 py-3 text-center text-xs text-zinc-500">
                    No action items yet.
                  </li>
                )}
              </ul>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_140px_140px_auto]">
                <input
                  value={newAction.title}
                  onChange={(e) => setNewAction({ ...newAction, title: e.target.value })}
                  placeholder="New action item…"
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600"
                />
                <input
                  type="date"
                  value={newAction.due_date}
                  onChange={(e) => setNewAction({ ...newAction, due_date: e.target.value })}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-200"
                />
                <input
                  value={newAction.assigned_to}
                  onChange={(e) => setNewAction({ ...newAction, assigned_to: e.target.value })}
                  placeholder="Assignee"
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600"
                />
                <Button onClick={addAction} disabled={busy || !newAction.title.trim()}>
                  Add
                </Button>
              </div>
            </div>

            {/* Notes */}
            <div>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Notes</h3>
              <ul className="space-y-1.5">
                {notes.map((n, i) => (
                  <li key={i} className="rounded-lg border border-zinc-800 bg-zinc-950/30 px-3 py-2">
                    <p className="whitespace-pre-wrap text-zinc-200">{n.text ?? String(n)}</p>
                    {n.at && <p className="mt-1 text-xs text-zinc-500">{fmtDate(n.at)}</p>}
                  </li>
                ))}
                {notes.length === 0 && (
                  <li className="rounded-lg border border-dashed border-zinc-800 px-3 py-3 text-center text-xs text-zinc-500">
                    No notes yet.
                  </li>
                )}
              </ul>
              <div className="mt-2 flex gap-2">
                <input
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') appendNote()
                  }}
                  placeholder="Add a note…"
                  className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600"
                />
                <Button onClick={appendNote} disabled={busy || !noteText.trim()}>
                  Add note
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </label>
  )
}
