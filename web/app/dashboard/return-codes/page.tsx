'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Stat } from '@/components/ui/Stat'
import { PageSpinner, Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'

interface ReturnCode {
  id: string
  code: string
  description: string
  category: string
  consumer: boolean | null
  workspace_override: string | null
  override_category: string | null
  effective_category: string
  is_overridden: boolean
  created_at: string
}

interface ReturnEntry {
  id: string
  originator_id: string
  return_code: string
  category: string
  return_date: string
  amount_cents: number
  matched: boolean | null
  external_ref: string | null
}

interface CodeDetail {
  code: ReturnCode
  entries: ReturnEntry[]
}

const CATEGORIES = ['unauthorized', 'administrative', 'other']

function categoryTone(cat: string): 'breach' | 'warning' | 'neutral' {
  if (cat === 'unauthorized') return 'breach'
  if (cat === 'administrative') return 'warning'
  return 'neutral'
}

function fmtUSD(cents: number) {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return '—'
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function ReturnCodesPage() {
  const [codes, setCodes] = useState<ReturnCode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [onlyOverridden, setOnlyOverridden] = useState(false)

  // Drilldown
  const [detail, setDetail] = useState<CodeDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailCode, setDetailCode] = useState<string | null>(null)

  // Reclassify
  const [reclassCode, setReclassCode] = useState<ReturnCode | null>(null)
  const [reclassCategory, setReclassCategory] = useState('other')
  const [reclassSaving, setReclassSaving] = useState(false)
  const [reclassError, setReclassError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await api.getReturnCodes()
      setCodes(Array.isArray(rows) ? rows : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load return codes')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const visible = useMemo(() => {
    let rows = codes
    const q = search.trim().toLowerCase()
    if (q) {
      rows = rows.filter(
        (c) => c.code.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
      )
    }
    if (filterCategory) rows = rows.filter((c) => c.effective_category === filterCategory)
    if (onlyOverridden) rows = rows.filter((c) => c.is_overridden)
    return rows
  }, [codes, search, filterCategory, onlyOverridden])

  const stats = useMemo(() => {
    const byCat = (cat: string) => codes.filter((c) => c.effective_category === cat).length
    return {
      total: codes.length,
      unauthorized: byCat('unauthorized'),
      administrative: byCat('administrative'),
      overridden: codes.filter((c) => c.is_overridden).length,
    }
  }, [codes])

  async function openDetail(code: string) {
    setDetailCode(code)
    setDetail(null)
    setDetailLoading(true)
    try {
      const d = await api.getReturnCode(code)
      setDetail(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load code detail')
      setDetailCode(null)
    } finally {
      setDetailLoading(false)
    }
  }

  function openReclassify(c: ReturnCode) {
    setReclassCode(c)
    setReclassCategory(c.effective_category)
    setReclassError(null)
  }

  async function submitReclassify() {
    if (!reclassCode) return
    setReclassSaving(true)
    setReclassError(null)
    try {
      await api.reclassifyReturnCode(reclassCode.code, reclassCategory)
      setReclassCode(null)
      await load()
      // Refresh drilldown if it is open for this code.
      if (detailCode === reclassCode.code) await openDetail(reclassCode.code)
    } catch (e) {
      setReclassError(e instanceof Error ? e.message : 'Reclassify failed')
    } finally {
      setReclassSaving(false)
    }
  }

  const detailTotals = useMemo(() => {
    if (!detail) return { count: 0, cents: 0 }
    return {
      count: detail.entries.length,
      cents: detail.entries.reduce((s, e) => s + (e.amount_cents || 0), 0),
    }
  }, [detail])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white">NACHA Return Codes</h1>
        <p className="mt-1 text-sm text-slate-400">
          The R01–R85 return-code dictionary. Reclassify a code to override how it counts toward your
          unauthorized and administrative rates. Overrides are workspace-scoped and audited.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Codes" value={stats.total.toLocaleString()} />
        <Stat label="Unauthorized" value={stats.unauthorized.toLocaleString()} tone="red" hint="0.5% NACHA limit" />
        <Stat label="Administrative" value={stats.administrative.toLocaleString()} tone="amber" hint="3% NACHA limit" />
        <Stat label="Workspace Overrides" value={stats.overridden.toLocaleString()} tone={stats.overridden > 0 ? 'sky' : 'default'} />
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-200">Filters</h2>
        </CardHeader>
        <CardBody className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Search
            <input
              type="text"
              placeholder="code or description"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Category
            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            >
              <option value="">All</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 self-end text-sm text-slate-300">
            <input
              type="checkbox"
              checked={onlyOverridden}
              onChange={(e) => setOnlyOverridden(e.target.checked)}
              className="accent-emerald-500"
            />
            Overridden only
          </label>
        </CardBody>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-200">Code Dictionary</h2>
          <span className="text-xs text-slate-500">{visible.length} codes</span>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <PageSpinner label="Loading return codes..." />
          ) : visible.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No matching codes"
                description="Adjust the filters above to see the NACHA return-code dictionary."
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Code</TH>
                  <TH>Description</TH>
                  <TH>Category</TH>
                  <TH>Consumer</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {visible.map((c) => (
                  <TR key={c.id}>
                    <TD className="font-mono font-medium text-white">{c.code}</TD>
                    <TD className="text-slate-300">{c.description}</TD>
                    <TD>
                      <div className="flex items-center gap-2">
                        <Badge tone={categoryTone(c.effective_category)}>{c.effective_category}</Badge>
                        {c.is_overridden && (
                          <span className="text-xs text-sky-400" title={`Default: ${c.category}`}>
                            override
                          </span>
                        )}
                      </div>
                    </TD>
                    <TD>
                      {c.consumer ? <Badge tone="info">consumer</Badge> : <span className="text-xs text-slate-600">corporate</span>}
                    </TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="secondary"
                          className="px-2 py-1 text-xs"
                          onClick={() => openDetail(c.code)}
                        >
                          Drilldown
                        </Button>
                        <Button
                          variant="secondary"
                          className="px-2 py-1 text-xs"
                          onClick={() => openReclassify(c)}
                        >
                          Reclassify
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

      {/* Drilldown modal */}
      <Modal
        open={!!detailCode}
        onClose={() => {
          setDetailCode(null)
          setDetail(null)
        }}
        title={detailCode ? `Return Code ${detailCode}` : 'Return Code'}
        className="max-w-2xl"
      >
        {detailLoading ? (
          <div className="py-8">
            <Spinner label="Loading entries..." />
          </div>
        ) : detail ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-slate-800 bg-slate-950 px-4 py-3">
              <p className="text-sm text-slate-300">{detail.code.description}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone={categoryTone(detail.code.effective_category)}>
                  {detail.code.effective_category}
                </Badge>
                {detail.code.is_overridden && (
                  <span className="text-xs text-sky-400">
                    overrides default &ldquo;{detail.code.category}&rdquo;
                  </span>
                )}
                {detail.code.consumer ? (
                  <Badge tone="info">consumer</Badge>
                ) : (
                  <Badge tone="neutral">corporate</Badge>
                )}
                <Button
                  variant="secondary"
                  className="ml-auto px-2 py-1 text-xs"
                  onClick={() => openReclassify(detail.code)}
                >
                  Reclassify
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Stat label="Entries Using This Code" value={detailTotals.count.toLocaleString()} />
              <Stat label="Total Returned" value={fmtUSD(detailTotals.cents)} />
            </div>

            {detail.entries.length === 0 ? (
              <EmptyState
                title="No return entries"
                description="No returns in this workspace currently use this code."
              />
            ) : (
              <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-800">
                <Table>
                  <THead>
                    <TR>
                      <TH>Return Date</TH>
                      <TH className="text-right">Amount</TH>
                      <TH>Matched</TH>
                      <TH>Ref</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {detail.entries.map((e) => (
                      <TR key={e.id}>
                        <TD>{fmtDate(e.return_date)}</TD>
                        <TD className="text-right tabular-nums">{fmtUSD(e.amount_cents)}</TD>
                        <TD>
                          {e.matched ? (
                            <Badge tone="clear">matched</Badge>
                          ) : (
                            <Badge tone="warning">unmatched</Badge>
                          )}
                        </TD>
                        <TD className="text-xs text-slate-400">{e.external_ref || '—'}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </div>
        ) : null}
      </Modal>

      {/* Reclassify modal */}
      <Modal
        open={!!reclassCode}
        onClose={() => setReclassCode(null)}
        title={reclassCode ? `Reclassify ${reclassCode.code}` : 'Reclassify'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReclassCode(null)} disabled={reclassSaving}>
              Cancel
            </Button>
            <Button onClick={submitReclassify} disabled={reclassSaving}>
              {reclassSaving ? 'Saving...' : 'Apply Override'}
            </Button>
          </>
        }
      >
        {reclassCode && (
          <div className="space-y-4">
            {reclassError && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {reclassError}
              </div>
            )}
            <p className="text-sm text-slate-400">{reclassCode.description}</p>
            <div className="text-sm text-slate-400">
              Default category:{' '}
              <Badge tone={categoryTone(reclassCode.category)}>{reclassCode.category}</Badge>
            </div>
            <label className="block text-sm">
              <span className="mb-1 block text-slate-300">Workspace category</span>
              <select
                value={reclassCategory}
                onChange={(e) => setReclassCategory(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-slate-500">
              This override applies only to your workspace and is recorded in the audit log. It changes
              how returns with this code count toward your NACHA rate thresholds.
            </p>
          </div>
        )}
      </Modal>
    </div>
  )
}
