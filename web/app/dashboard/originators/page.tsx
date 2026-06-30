'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import api from '@/lib/api'
import { Card, CardHeader, CardBody } from '@/components/ui/card'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'
import { Badge, statusTone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/Modal'
import { Spinner, PageSpinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Stat } from '@/components/ui/Stat'

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

const STATUS_OPTIONS = ['onboarding', 'active', 'monitoring', 'suspended']

const EMPTY_FORM = {
  name: '',
  company_id: '',
  odfi_name: '',
  routing_number: '',
  mcc: '',
  expected_monthly_volume: '',
  status: 'active',
}

type FormState = typeof EMPTY_FORM

const labelCls = 'block text-xs font-medium text-slate-400 mb-1'
const inputCls =
  'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/50'

function formFromOriginator(o: Originator): FormState {
  return {
    name: o.name ?? '',
    company_id: o.company_id ?? '',
    odfi_name: o.odfi_name ?? '',
    routing_number: o.routing_number ?? '',
    mcc: o.mcc ?? '',
    expected_monthly_volume: o.expected_monthly_volume != null ? String(o.expected_monthly_volume) : '',
    status: o.status ?? 'active',
  }
}

function formToBody(f: FormState) {
  return {
    name: f.name.trim(),
    company_id: f.company_id.trim() || undefined,
    odfi_name: f.odfi_name.trim() || undefined,
    routing_number: f.routing_number.trim() || undefined,
    mcc: f.mcc.trim() || undefined,
    expected_monthly_volume: f.expected_monthly_volume ? Number(f.expected_monthly_volume) : undefined,
    status: f.status,
  }
}

function money(n?: number) {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function OriginatorForm({ form, setForm }: { form: FormState; setForm: (f: FormState) => void }) {
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value })
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label className={labelCls}>Name *</label>
        <input className={inputCls} value={form.name} onChange={set('name')} placeholder="Acme Payments LLC" />
      </div>
      <div>
        <label className={labelCls}>Company ID</label>
        <input className={inputCls} value={form.company_id} onChange={set('company_id')} placeholder="1234567890" />
      </div>
      <div>
        <label className={labelCls}>ODFI Name</label>
        <input className={inputCls} value={form.odfi_name} onChange={set('odfi_name')} placeholder="First National Bank" />
      </div>
      <div>
        <label className={labelCls}>Routing Number</label>
        <input className={inputCls} value={form.routing_number} onChange={set('routing_number')} placeholder="021000021" />
      </div>
      <div>
        <label className={labelCls}>MCC</label>
        <input className={inputCls} value={form.mcc} onChange={set('mcc')} placeholder="5734" />
      </div>
      <div>
        <label className={labelCls}>Expected Monthly Volume ($)</label>
        <input
          className={inputCls}
          type="number"
          value={form.expected_monthly_volume}
          onChange={set('expected_monthly_volume')}
          placeholder="500000"
        />
      </div>
      <div>
        <label className={labelCls}>Status</label>
        <select className={inputCls} value={form.status} onChange={set('status')}>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

export default function OriginatorsPage() {
  const [originators, setOriginators] = useState<Originator[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<Originator | null>(null)
  const [deleting, setDeleting] = useState<Originator | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)

  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [bulkText, setBulkText] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await api.getOriginators(statusFilter || undefined)
      setOriginators(Array.isArray(data) ? data : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load originators')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return originators
    return originators.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        (o.company_id ?? '').toLowerCase().includes(q) ||
        (o.odfi_name ?? '').toLowerCase().includes(q) ||
        (o.routing_number ?? '').includes(q),
    )
  }, [originators, search])

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const o of originators) c[o.status ?? 'unknown'] = (c[o.status ?? 'unknown'] ?? 0) + 1
    return c
  }, [originators])

  function openCreate() {
    setForm(EMPTY_FORM)
    setFormError(null)
    setCreateOpen(true)
  }

  function openEdit(o: Originator) {
    setForm(formFromOriginator(o))
    setFormError(null)
    setEditing(o)
  }

  async function submitCreate() {
    if (!form.name.trim()) {
      setFormError('Name is required')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      await api.createOriginator(formToBody(form))
      setCreateOpen(false)
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Failed to create')
    } finally {
      setSaving(false)
    }
  }

  async function submitEdit() {
    if (!editing) return
    if (!form.name.trim()) {
      setFormError('Name is required')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      await api.updateOriginator(editing.id, formToBody(form))
      setEditing(null)
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Failed to update')
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    setSaving(true)
    try {
      await api.deleteOriginator(deleting.id)
      setDeleting(null)
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Failed to delete')
    } finally {
      setSaving(false)
    }
  }

  // Bulk import: parse CSV-ish lines into originator rows.
  // Columns: name,company_id,odfi_name,routing_number,mcc,expected_monthly_volume,status
  function parseBulk(): Array<Record<string, unknown>> {
    const lines = bulkText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    const rows: Array<Record<string, unknown>> = []
    for (const line of lines) {
      const lower = line.toLowerCase()
      if (lower.startsWith('name,') || lower === 'name') continue // skip header
      const cols = line.split(',').map((c) => c.trim())
      if (!cols[0]) continue
      rows.push({
        name: cols[0],
        company_id: cols[1] || undefined,
        odfi_name: cols[2] || undefined,
        routing_number: cols[3] || undefined,
        mcc: cols[4] || undefined,
        expected_monthly_volume: cols[5] ? Number(cols[5]) : undefined,
        status: cols[6] || 'active',
      })
    }
    return rows
  }

  async function submitBulk() {
    const rows = parseBulk()
    if (rows.length === 0) {
      setFormError('No valid rows parsed. One originator per line.')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      await api.bulkCreateOriginators(rows)
      setBulkOpen(false)
      setBulkText('')
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Bulk import failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Originator Registry</h1>
          <p className="mt-0.5 text-sm text-slate-500">Onboarded originators scoped to your workspace.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => { setBulkText(''); setFormError(null); setBulkOpen(true) }}>
            Bulk Import
          </Button>
          <Button onClick={openCreate}>Add Originator</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Total" value={originators.length} />
        <Stat label="Active" value={statusCounts.active ?? 0} tone="emerald" />
        <Stat label="Monitoring" value={statusCounts.monitoring ?? 0} tone="amber" />
        <Stat label="Suspended" value={statusCounts.suspended ?? 0} tone="red" />
      </div>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${inputCls} w-56`}
              placeholder="Search name, company, ODFI..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className={`${inputCls} w-40`}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <span className="text-xs text-slate-500">{filtered.length} shown</span>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <div className="py-16">
              <PageSpinner label="Loading originators..." />
            </div>
          ) : error ? (
            <div className="p-6">
              <EmptyState
                title="Could not load originators"
                description={error}
                action={
                  <Button variant="secondary" onClick={load}>
                    Retry
                  </Button>
                }
              />
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title={originators.length === 0 ? 'No originators yet' : 'No matches'}
                description={
                  originators.length === 0
                    ? 'Add your first originator or bulk import a roster.'
                    : 'Adjust your search or status filter.'
                }
                action={
                  originators.length === 0 ? <Button onClick={openCreate}>Add Originator</Button> : undefined
                }
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Company ID</TH>
                  <TH>ODFI</TH>
                  <TH>Routing</TH>
                  <TH>MCC</TH>
                  <TH className="text-right">Exp. Volume</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {filtered.map((o) => (
                  <TR key={o.id}>
                    <TD>
                      <Link
                        href={`/dashboard/originators/${o.id}`}
                        className="font-medium text-emerald-300 hover:text-emerald-200"
                      >
                        {o.name}
                      </Link>
                    </TD>
                    <TD className="text-slate-400">{o.company_id || '—'}</TD>
                    <TD className="text-slate-400">{o.odfi_name || '—'}</TD>
                    <TD className="tabular-nums text-slate-400">{o.routing_number || '—'}</TD>
                    <TD className="text-slate-400">{o.mcc || '—'}</TD>
                    <TD className="text-right tabular-nums">{money(o.expected_monthly_volume)}</TD>
                    <TD>
                      <Badge tone={statusTone(o.status)}>{o.status ?? 'unknown'}</Badge>
                    </TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button variant="ghost" className="px-2 py-1" onClick={() => openEdit(o)}>
                          Edit
                        </Button>
                        <Button variant="ghost" className="px-2 py-1 text-red-400 hover:text-red-300" onClick={() => setDeleting(o)}>
                          Delete
                        </Button>
                      </div>
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
        title="Add Originator"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submitCreate} disabled={saving}>
              {saving ? <Spinner /> : 'Create'}
            </Button>
          </>
        }
      >
        {formError && <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{formError}</div>}
        <OriginatorForm form={form} setForm={setForm} />
      </Modal>

      {/* Edit modal */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Edit Originator"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submitEdit} disabled={saving}>
              {saving ? <Spinner /> : 'Save'}
            </Button>
          </>
        }
      >
        {formError && <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{formError}</div>}
        <OriginatorForm form={form} setForm={setForm} />
      </Modal>

      {/* Delete confirm */}
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete Originator"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleting(null)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete} disabled={saving}>
              {saving ? <Spinner /> : 'Delete'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-300">
          Delete <span className="font-semibold text-white">{deleting?.name}</span>? This removes the originator and is
          not reversible.
        </p>
      </Modal>

      {/* Bulk import modal */}
      <Modal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title="Bulk Import Originators"
        footer={
          <>
            <Button variant="secondary" onClick={() => setBulkOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submitBulk} disabled={saving}>
              {saving ? <Spinner /> : 'Import'}
            </Button>
          </>
        }
      >
        {formError && <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{formError}</div>}
        <p className="mb-2 text-sm text-slate-400">
          One originator per line, comma-separated. An optional header row is skipped.
        </p>
        <p className="mb-3 text-xs text-slate-500">
          name, company_id, odfi_name, routing_number, mcc, expected_monthly_volume, status
        </p>
        <textarea
          className={`${inputCls} h-40 font-mono`}
          placeholder={'Acme Payments,1234567890,First National,021000021,5734,500000,active\nBeta Merchant,9876543210,Second Bank,011000015,5812,250000,onboarding'}
          value={bulkText}
          onChange={(e) => setBulkText(e.target.value)}
        />
        <p className="mt-2 text-xs text-slate-500">{parseBulk().length} row(s) parsed.</p>
      </Modal>
    </div>
  )
}
