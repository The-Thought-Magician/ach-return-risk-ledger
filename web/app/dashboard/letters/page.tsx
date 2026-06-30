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
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'

interface Originator {
  id: string
  name: string
  odfi_name?: string | null
}

interface WarningLetter {
  id: string
  originator_id: string
  letter_type: string
  subject: string
  body?: string | null
  received_date?: string | null
  response_due_date?: string | null
  related_rate_type?: string | null
  status: string
  created_at?: string
}

const LETTER_TYPES = ['warning', 'inquiry', 'corrective-action', 'termination', 'cure-notice']
const STATUSES = ['open', 'in-progress', 'responded', 'resolved', 'escalated']
const RATE_TYPES = ['unauthorized', 'administrative', 'overall']

const emptyForm = {
  originator_id: '',
  letter_type: 'warning',
  subject: '',
  body: '',
  received_date: '',
  response_due_date: '',
  related_rate_type: 'unauthorized',
  status: 'open',
}

function fmtDate(d?: string | null) {
  if (!d) return '—'
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return d
  return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function daysUntil(d?: string | null): number | null {
  if (!d) return null
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return null
  return Math.ceil((dt.getTime() - Date.now()) / 86_400_000)
}

export default function LettersPage() {
  const [letters, setLetters] = useState<WarningLetter[]>([])
  const [originators, setOriginators] = useState<Originator[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [statusFilter, setStatusFilter] = useState('')
  const [originatorFilter, setOriginatorFilter] = useState('')
  const [search, setSearch] = useState('')

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<WarningLetter | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [detail, setDetail] = useState<WarningLetter | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, unknown> = {}
      if (statusFilter) params.status = statusFilter
      if (originatorFilter) params.originator_id = originatorFilter
      const [lts, orgs] = await Promise.all([
        api.getLetters(params),
        api.getOriginators(),
      ])
      setLetters(Array.isArray(lts) ? lts : [])
      setOriginators(Array.isArray(orgs) ? orgs : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load warning letters')
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return letters
    return letters.filter(
      (l) =>
        l.subject?.toLowerCase().includes(q) ||
        l.letter_type?.toLowerCase().includes(q) ||
        orgName(l.originator_id).toLowerCase().includes(q),
    )
  }, [letters, search, orgName])

  const stats = useMemo(() => {
    const open = letters.filter((l) => !['resolved', 'responded'].includes(l.status)).length
    const overdue = letters.filter((l) => {
      const du = daysUntil(l.response_due_date)
      return du !== null && du < 0 && !['resolved', 'responded'].includes(l.status)
    }).length
    const dueSoon = letters.filter((l) => {
      const du = daysUntil(l.response_due_date)
      return du !== null && du >= 0 && du <= 7 && !['resolved', 'responded'].includes(l.status)
    }).length
    return { total: letters.length, open, overdue, dueSoon }
  }, [letters])

  function openCreate() {
    setEditing(null)
    setForm({ ...emptyForm, originator_id: originators[0]?.id ?? '' })
    setFormError(null)
    setModalOpen(true)
  }

  function openEdit(l: WarningLetter) {
    setEditing(l)
    setForm({
      originator_id: l.originator_id,
      letter_type: l.letter_type ?? 'warning',
      subject: l.subject ?? '',
      body: l.body ?? '',
      received_date: l.received_date ? l.received_date.slice(0, 10) : '',
      response_due_date: l.response_due_date ? l.response_due_date.slice(0, 10) : '',
      related_rate_type: l.related_rate_type ?? 'unauthorized',
      status: l.status ?? 'open',
    })
    setFormError(null)
    setModalOpen(true)
  }

  async function save() {
    if (!form.originator_id) {
      setFormError('Select an originator')
      return
    }
    if (!form.subject.trim()) {
      setFormError('Subject is required')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const payload = {
        originator_id: form.originator_id,
        letter_type: form.letter_type,
        subject: form.subject.trim(),
        body: form.body.trim() || null,
        received_date: form.received_date || null,
        response_due_date: form.response_due_date || null,
        related_rate_type: form.related_rate_type || null,
        status: form.status,
      }
      if (editing) {
        await api.updateLetter(editing.id, payload)
      } else {
        await api.createLetter(payload)
      }
      setModalOpen(false)
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function remove(l: WarningLetter) {
    if (!confirm(`Delete letter "${l.subject}"? This cannot be undone.`)) return
    try {
      await api.deleteLetter(l.id)
      if (detail?.id === l.id) setDetail(null)
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  async function openDetail(l: WarningLetter) {
    setDetail(l)
    setDetailLoading(true)
    try {
      const full = await api.getLetter(l.id)
      if (full && typeof full === 'object') setDetail(full)
    } catch {
      /* keep summary row as fallback */
    } finally {
      setDetailLoading(false)
    }
  }

  async function quickStatus(l: WarningLetter, status: string) {
    try {
      await api.updateLetter(l.id, { status })
      await load()
      if (detail?.id === l.id) setDetail({ ...detail, status })
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Update failed')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Warning Letters</h1>
          <p className="mt-1 text-sm text-slate-400">
            Track ODFI warning letters, inquiries and corrective-action notices with response deadlines.
          </p>
        </div>
        <Button onClick={openCreate} disabled={originators.length === 0}>
          Log letter
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Total letters" value={stats.total} />
        <Stat label="Open" value={stats.open} tone="amber" />
        <Stat label="Due within 7d" value={stats.dueSoon} tone="sky" />
        <Stat label="Overdue" value={stats.overdue} tone={stats.overdue ? 'red' : 'default'} />
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200"
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
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200"
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
            placeholder="Search subject, type, originator…"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 sm:w-72"
          />
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <PageSpinner label="Loading letters…" />
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
              title={letters.length === 0 ? 'No warning letters yet' : 'No letters match your filters'}
              description={
                letters.length === 0
                  ? 'Log a letter when an ODFI sends a warning, inquiry or corrective-action notice.'
                  : 'Try clearing filters or the search box.'
              }
              action={
                letters.length === 0 ? (
                  <Button onClick={openCreate} disabled={originators.length === 0}>
                    Log letter
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Subject</TH>
                  <TH>Originator</TH>
                  <TH>Type</TH>
                  <TH>Rate</TH>
                  <TH>Received</TH>
                  <TH>Response due</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {filtered.map((l) => {
                  const du = daysUntil(l.response_due_date)
                  const settled = ['resolved', 'responded'].includes(l.status)
                  return (
                    <TR key={l.id}>
                      <TD>
                        <button
                          onClick={() => openDetail(l)}
                          className="text-left font-medium text-white hover:text-emerald-300"
                        >
                          {l.subject}
                        </button>
                      </TD>
                      <TD className="text-slate-300">{orgName(l.originator_id)}</TD>
                      <TD>
                        <Badge tone="neutral">{l.letter_type}</Badge>
                      </TD>
                      <TD className="text-slate-400">{l.related_rate_type ?? '—'}</TD>
                      <TD className="text-slate-400">{fmtDate(l.received_date)}</TD>
                      <TD>
                        <span className="text-slate-300">{fmtDate(l.response_due_date)}</span>
                        {du !== null && !settled && (
                          <span
                            className={`ml-2 text-xs ${
                              du < 0 ? 'text-red-400' : du <= 7 ? 'text-amber-400' : 'text-slate-500'
                            }`}
                          >
                            {du < 0 ? `${Math.abs(du)}d overdue` : `${du}d left`}
                          </span>
                        )}
                      </TD>
                      <TD>
                        <Badge tone={statusTone(l.status)}>{l.status}</Badge>
                      </TD>
                      <TD>
                        <div className="flex items-center justify-end gap-2">
                          {!settled && (
                            <button
                              onClick={() => quickStatus(l, 'resolved')}
                              className="text-xs text-emerald-400 hover:text-emerald-300"
                            >
                              Resolve
                            </button>
                          )}
                          <button
                            onClick={() => openEdit(l)}
                            className="text-xs text-sky-400 hover:text-sky-300"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => remove(l)}
                            className="text-xs text-red-400 hover:text-red-300"
                          >
                            Delete
                          </button>
                        </div>
                      </TD>
                    </TR>
                  )
                })}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Edit warning letter' : 'Log warning letter'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Log letter'}
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
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
            >
              <option value="">Select originator…</option>
              {originators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.odfi_name ? ` — ${o.odfi_name}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Subject">
            <input
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              placeholder="e.g. Unauthorized return rate exceeded 0.5%"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Letter type">
              <select
                value={form.letter_type}
                onChange={(e) => setForm({ ...form, letter_type: e.target.value })}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
              >
                {LETTER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Related rate">
              <select
                value={form.related_rate_type}
                onChange={(e) => setForm({ ...form, related_rate_type: e.target.value })}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
              >
                {RATE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Received date">
              <input
                type="date"
                value={form.received_date}
                onChange={(e) => setForm({ ...form, received_date: e.target.value })}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
              />
            </Field>
            <Field label="Response due">
              <input
                type="date"
                value={form.response_due_date}
                onChange={(e) => setForm({ ...form, response_due_date: e.target.value })}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
              />
            </Field>
          </div>
          <Field label="Status">
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Body / notes">
            <textarea
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              rows={4}
              placeholder="Letter text, required actions, internal notes…"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail?.subject ?? 'Letter'}
        footer={
          detail && (
            <>
              <Button variant="secondary" onClick={() => detail && openEdit(detail)}>
                Edit
              </Button>
              <Button onClick={() => setDetail(null)}>Close</Button>
            </>
          )
        }
      >
        {detail && (
          <div className="space-y-4 text-sm">
            {detailLoading && <p className="text-xs text-slate-500">Loading full detail…</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{detail.letter_type}</Badge>
              <Badge tone={statusTone(detail.status)}>{detail.status}</Badge>
              {detail.related_rate_type && <Badge tone="info">{detail.related_rate_type} rate</Badge>}
            </div>
            <div className="grid grid-cols-2 gap-3 text-slate-300">
              <Detail label="Originator" value={orgName(detail.originator_id)} />
              <Detail label="Received" value={fmtDate(detail.received_date)} />
              <Detail label="Response due" value={fmtDate(detail.response_due_date)} />
              <Detail label="Logged" value={fmtDate(detail.created_at)} />
            </div>
            {detail.body && (
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Body</div>
                <p className="whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-slate-200">
                  {detail.body}
                </p>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  onClick={() => quickStatus(detail, s)}
                  disabled={detail.status === s}
                  className={`rounded-md border px-2.5 py-1 text-xs ${
                    detail.status === s
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                      : 'border-slate-700 text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
      {children}
    </label>
  )
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-0.5 text-slate-200">{value}</div>
    </div>
  )
}
