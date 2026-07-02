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

interface Originator {
  id: string
  name: string
  status?: string
}

interface FeeRecord {
  id: string
  originator_id: string
  originator_name?: string
  return_entry_id?: string | null
  fee_type: string
  amount_cents: number
  incurred_at?: string
  created_at?: string
}

interface FeeSummaryRow {
  originator_id: string
  originator_name?: string
  name?: string
  fee_count?: number
  fees_cents?: number
  total_fees_cents?: number
  recovered_cents?: number
  recovered_amount_cents?: number
  net_cents?: number
}

const FEE_TYPES = ['return_fee', 'nsf_fee', 'representment_fee', 'chargeback_fee', 'admin_fee', 'other']

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function dollars(cents: unknown): string {
  return (num(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function feesOf(r: FeeSummaryRow): number {
  return num(r.fees_cents ?? r.total_fees_cents)
}

function recoveredOf(r: FeeSummaryRow): number {
  return num(r.recovered_cents ?? r.recovered_amount_cents)
}

function netOf(r: FeeSummaryRow): number {
  if (r.net_cents != null) return num(r.net_cents)
  return feesOf(r) - recoveredOf(r)
}

function summaryName(r: FeeSummaryRow): string {
  return r.originator_name || r.name || r.originator_id
}

function fmtDate(v?: string): string {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function FeesPage() {
  const [fees, setFees] = useState<FeeRecord[]>([])
  const [summary, setSummary] = useState<FeeSummaryRow[]>([])
  const [originators, setOriginators] = useState<Originator[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [originatorFilter, setOriginatorFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')

  const [createOpen, setCreateOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({ originator_id: '', fee_type: 'return_fee', amount: '', incurred_at: '' })
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, unknown> = {}
      if (originatorFilter) params.originator_id = originatorFilter
      if (typeFilter) params.fee_type = typeFilter
      const [feeRows, sum, orig] = await Promise.all([
        api.getFees(Object.keys(params).length ? params : undefined),
        api.getFeeSummary(),
        api.getOriginators(),
      ])
      setFees(Array.isArray(feeRows) ? feeRows : [])
      setSummary(Array.isArray(sum) ? sum : [])
      setOriginators(Array.isArray(orig) ? orig : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load fee data')
    } finally {
      setLoading(false)
    }
  }, [originatorFilter, typeFilter])

  useEffect(() => {
    load()
  }, [load])

  const orgName = useCallback(
    (id: string) => originators.find((o) => o.id === id)?.name || id,
    [originators],
  )

  const openCreate = () => {
    setForm({
      originator_id: originatorFilter || originators[0]?.id || '',
      fee_type: 'return_fee',
      amount: '',
      incurred_at: new Date().toISOString().slice(0, 10),
    })
    setError(null)
    setCreateOpen(true)
  }

  const submit = async () => {
    if (!form.originator_id || !form.amount) {
      setError('Originator and amount are required')
      return
    }
    const amountCents = Math.round(parseFloat(form.amount) * 100)
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setError('Enter a valid amount')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await api.createFee({
        originator_id: form.originator_id,
        fee_type: form.fee_type,
        amount_cents: amountCents,
        incurred_at: form.incurred_at || undefined,
      })
      setCreateOpen(false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create fee')
    } finally {
      setSubmitting(false)
    }
  }

  const remove = async (id: string) => {
    setDeletingId(id)
    setError(null)
    try {
      await api.deleteFee(id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete fee')
    } finally {
      setDeletingId(null)
    }
  }

  const totals = useMemo(() => {
    const totalFees = fees.reduce((acc, f) => acc + num(f.amount_cents), 0)
    const recovered = summary.reduce((acc, r) => acc + recoveredOf(r), 0)
    const summaryFees = summary.reduce((acc, r) => acc + feesOf(r), 0)
    const net = summaryFees - recovered
    return { totalFees, recovered, net, count: fees.length }
  }, [fees, summary])

  const maxNet = useMemo(
    () => summary.reduce((m, r) => Math.max(m, Math.abs(netOf(r))), 0) || 1,
    [summary],
  )

  if (loading) return <PageSpinner label="Loading fee economics..." />

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Fee Economics Ledger</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Track return-related fees against recovered amounts to surface the true cost of ACH returns.
          </p>
        </div>
        <Button onClick={openCreate} disabled={originators.length === 0}>
          Log fee
        </Button>
      </div>

      {error && !createOpen && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Fee records" value={totals.count} />
        <Stat label="Fees incurred" value={dollars(totals.totalFees)} tone="red" />
        <Stat label="Recovered" value={dollars(totals.recovered)} tone="emerald" />
        <Stat
          label="Net cost"
          value={dollars(totals.net)}
          tone={totals.net > 0 ? 'red' : 'emerald'}
          hint="Fees minus recovered"
        />
      </div>

      <Card>
        <CardHeader>
          <span className="text-sm font-semibold text-white">Economics roll-up by originator</span>
        </CardHeader>
        <CardBody className="p-0">
          {summary.length === 0 ? (
            <EmptyState title="No roll-up yet" description="Fee summary appears once fees and recoveries exist." />
          ) : (
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Originator</TH>
                  <TH className="text-right">Fees</TH>
                  <TH className="text-right">Recovered</TH>
                  <TH className="text-right">Net</TH>
                  <TH className="w-40">Net exposure</TH>
                </TR>
              </THead>
              <TBody>
                {summary.map((r) => {
                  const net = netOf(r)
                  const pct = Math.min(100, (Math.abs(net) / maxNet) * 100)
                  return (
                    <TR key={r.originator_id}>
                      <TD className="font-medium text-white">{summaryName(r)}</TD>
                      <TD className="text-right tabular-nums text-zinc-300">{dollars(feesOf(r))}</TD>
                      <TD className="text-right tabular-nums text-amber-300">{dollars(recoveredOf(r))}</TD>
                      <TD className={`text-right font-semibold tabular-nums ${net > 0 ? 'text-red-300' : 'text-amber-300'}`}>
                        {dollars(net)}
                      </TD>
                      <TD>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                          <div
                            className={`h-full rounded-full ${net > 0 ? 'bg-red-500' : 'bg-amber-500'}`}
                            style={{ width: `${pct}%` }}
                          />
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

      <Card>
        <CardHeader className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-white">Fee ledger</span>
          <select
            value={originatorFilter}
            onChange={(e) => setOriginatorFilter(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-200 focus:border-amber-500/50 focus:outline-none"
          >
            <option value="">All originators</option>
            {originators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-200 focus:border-amber-500/50 focus:outline-none"
          >
            <option value="">All fee types</option>
            {FEE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <span className="ml-auto text-xs text-zinc-500">{fees.length} records</span>
        </CardHeader>
        <CardBody className="p-0">
          {fees.length === 0 ? (
            <EmptyState
              title="No fee records"
              description={
                originatorFilter || typeFilter
                  ? 'No fees match the current filters.'
                  : 'Log a fee to start building the economics ledger.'
              }
              action={
                !originatorFilter && !typeFilter ? (
                  <Button onClick={openCreate} disabled={originators.length === 0}>
                    Log fee
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Originator</TH>
                  <TH>Fee type</TH>
                  <TH>Incurred</TH>
                  <TH className="text-right">Amount</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {fees.map((f) => (
                  <TR key={f.id}>
                    <TD className="font-medium text-white">{f.originator_name || orgName(f.originator_id)}</TD>
                    <TD>
                      <Badge tone="info">{(f.fee_type || 'other').replace(/_/g, ' ')}</Badge>
                    </TD>
                    <TD className="text-zinc-400">{fmtDate(f.incurred_at || f.created_at)}</TD>
                    <TD className="text-right font-semibold tabular-nums text-red-300">{dollars(f.amount_cents)}</TD>
                    <TD className="text-right">
                      <Button
                        variant="danger"
                        className="px-2 py-1 text-xs"
                        onClick={() => remove(f.id)}
                        disabled={deletingId === f.id}
                      >
                        {deletingId === f.id ? 'Deleting...' : 'Delete'}
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Log fee record"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting ? 'Saving...' : 'Save fee'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && createOpen && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">Originator</label>
            <select
              value={form.originator_id}
              onChange={(e) => setForm((f) => ({ ...f, originator_id: e.target.value }))}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-200 focus:border-amber-500/50 focus:outline-none"
            >
              <option value="">Select originator</option>
              {originators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">Fee type</label>
            <select
              value={form.fee_type}
              onChange={(e) => setForm((f) => ({ ...f, fee_type: e.target.value }))}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-200 focus:border-amber-500/50 focus:outline-none"
            >
              {FEE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">Amount (USD)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                placeholder="0.00"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-amber-500/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">Incurred</label>
              <input
                type="date"
                value={form.incurred_at}
                onChange={(e) => setForm((f) => ({ ...f, incurred_at: e.target.value }))}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-200 focus:border-amber-500/50 focus:outline-none"
              />
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
