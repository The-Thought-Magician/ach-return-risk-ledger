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

interface ImportRecord {
  id: string
  kind: string
  filename?: string | null
  row_count: number
  inserted_count: number
  error_count: number
  errors?: unknown
  status: string
  created_at?: string
}

type CsvKind = 'originators' | 'entries' | 'returns' | 'fees'

const CSV_KINDS: { value: CsvKind; label: string; columns: string[] }[] = [
  {
    value: 'originators',
    label: 'Originators',
    columns: ['name', 'company_id', 'odfi_name', 'routing_number', 'mcc', 'expected_monthly_volume', 'status'],
  },
  {
    value: 'entries',
    label: 'Originated entries',
    columns: ['originator_id', 'entry_date', 'settlement_date', 'direction', 'sec_code', 'amount_cents', 'trace_number'],
  },
  {
    value: 'returns',
    label: 'Return entries',
    columns: ['originator_id', 'return_code', 'return_date', 'amount_cents', 'trace_number'],
  },
  {
    value: 'fees',
    label: 'Fee records',
    columns: ['originator_id', 'fee_type', 'amount_cents', 'incurred_at'],
  },
]

function fmtDateTime(d?: string | null) {
  if (!d) return '—'
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return d
  return dt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

// Minimal CSV parser: header row + comma-delimited values, quoted fields supported.
function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return { headers: [], rows: [] }

  const splitLine = (line: string): string[] => {
    const out: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"'
          i++
        } else if (ch === '"') {
          inQ = false
        } else {
          cur += ch
        }
      } else if (ch === '"') {
        inQ = true
      } else if (ch === ',') {
        out.push(cur)
        cur = ''
      } else {
        cur += ch
      }
    }
    out.push(cur)
    return out.map((s) => s.trim())
  }

  const headers = splitLine(lines[0])
  const rows = lines.slice(1).map((line) => {
    const cells = splitLine(line)
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => {
      obj[h] = cells[i] ?? ''
    })
    return obj
  })
  return { headers, rows }
}

export default function ImportsPage() {
  const [imports, setImports] = useState<ImportRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  // CSV import modal
  const [csvOpen, setCsvOpen] = useState(false)
  const [csvKind, setCsvKind] = useState<CsvKind>('originators')
  const [csvFilename, setCsvFilename] = useState('upload.csv')
  const [csvText, setCsvText] = useState('')
  const [csvBusy, setCsvBusy] = useState(false)
  const [csvError, setCsvError] = useState<string | null>(null)

  // NACHA import modal
  const [nachaOpen, setNachaOpen] = useState(false)
  const [nachaFilename, setNachaFilename] = useState('return-file.ach')
  const [nachaText, setNachaText] = useState('')
  const [nachaBusy, setNachaBusy] = useState(false)
  const [nachaError, setNachaError] = useState<string | null>(null)

  const [seeding, setSeeding] = useState(false)

  // Errors detail modal
  const [errDetail, setErrDetail] = useState<ImportRecord | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.getImports()
      setImports(Array.isArray(res) ? res : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load import history')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const stats = useMemo(() => {
    const totalRows = imports.reduce((s, i) => s + (i.row_count || 0), 0)
    const inserted = imports.reduce((s, i) => s + (i.inserted_count || 0), 0)
    const errs = imports.reduce((s, i) => s + (i.error_count || 0), 0)
    return { runs: imports.length, totalRows, inserted, errs }
  }, [imports])

  const csvPreview = useMemo(() => (csvText.trim() ? parseCsv(csvText) : null), [csvText])
  const selectedKind = CSV_KINDS.find((k) => k.value === csvKind)!

  function onCsvFile(file: File) {
    setCsvFilename(file.name)
    const reader = new FileReader()
    reader.onload = () => setCsvText(String(reader.result ?? ''))
    reader.readAsText(file)
  }

  function fillCsvTemplate() {
    setCsvText(selectedKind.columns.join(',') + '\n')
  }

  async function runCsvImport() {
    const parsed = csvPreview
    if (!parsed || parsed.rows.length === 0) {
      setCsvError('Paste or upload CSV with a header row and at least one data row.')
      return
    }
    setCsvBusy(true)
    setCsvError(null)
    try {
      const result: ImportRecord = await api.importCsv({
        kind: csvKind,
        filename: csvFilename,
        rows: parsed.rows,
      })
      setCsvOpen(false)
      setCsvText('')
      setBanner({
        tone: result.error_count > 0 ? 'err' : 'ok',
        text: `CSV import (${csvKind}): ${result.inserted_count} inserted, ${result.error_count} errors of ${result.row_count} rows.`,
      })
      await load()
    } catch (e) {
      setCsvError(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setCsvBusy(false)
    }
  }

  function onNachaFile(file: File) {
    setNachaFilename(file.name)
    const reader = new FileReader()
    reader.onload = () => setNachaText(String(reader.result ?? ''))
    reader.readAsText(file)
  }

  async function runNachaImport() {
    if (!nachaText.trim()) {
      setNachaError('Paste or upload a NACHA return file.')
      return
    }
    setNachaBusy(true)
    setNachaError(null)
    try {
      const result: ImportRecord = await api.importNacha({
        filename: nachaFilename,
        content: nachaText,
      })
      setNachaOpen(false)
      setNachaText('')
      setBanner({
        tone: result.error_count > 0 ? 'err' : 'ok',
        text: `NACHA import: ${result.inserted_count} returns parsed, ${result.error_count} errors of ${result.row_count} records.`,
      })
      await load()
    } catch (e) {
      setNachaError(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setNachaBusy(false)
    }
  }

  async function runSeed() {
    if (!confirm('Seed sample originators, entries, returns and fees into this workspace?')) return
    setSeeding(true)
    setBanner(null)
    try {
      const res = await api.seedSample()
      const summary = res?.summary
      const parts = summary
        ? Object.entries(summary)
            .map(([k, v]) => `${v} ${k}`)
            .join(', ')
        : 'seed complete'
      setBanner({ tone: 'ok', text: `Sample data seeded: ${parts}.` })
      await load()
    } catch (e) {
      setBanner({ tone: 'err', text: e instanceof Error ? e.message : 'Seeding failed' })
    } finally {
      setSeeding(false)
    }
  }

  function errorList(rec: ImportRecord): string[] {
    const e = rec.errors
    if (!e) return []
    if (Array.isArray(e)) return e.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
    if (typeof e === 'string') return [e]
    return [JSON.stringify(e)]
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Imports</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Bulk-load originators, entries, returns and fees from CSV, parse NACHA return files, or seed sample data.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={runSeed} disabled={seeding}>
            {seeding ? 'Seeding…' : 'Seed sample data'}
          </Button>
          <Button variant="secondary" onClick={() => setNachaOpen(true)}>
            Import NACHA
          </Button>
          <Button onClick={() => setCsvOpen(true)}>Import CSV</Button>
        </div>
      </div>

      {banner && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            banner.tone === 'ok'
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
              : 'border-red-500/30 bg-red-500/10 text-red-300'
          }`}
        >
          {banner.text}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Import runs" value={stats.runs} />
        <Stat label="Rows processed" value={stats.totalRows.toLocaleString()} />
        <Stat label="Records inserted" value={stats.inserted.toLocaleString()} tone="emerald" />
        <Stat label="Row errors" value={stats.errs.toLocaleString()} tone={stats.errs ? 'red' : 'default'} />
      </div>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Import history</h2>
          <Button variant="ghost" onClick={load}>
            Refresh
          </Button>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <PageSpinner label="Loading imports…" />
          ) : error ? (
            <div className="px-5 py-10 text-center text-sm text-red-300">
              {error}
              <div className="mt-3">
                <Button variant="secondary" onClick={load}>
                  Retry
                </Button>
              </div>
            </div>
          ) : imports.length === 0 ? (
            <EmptyState
              title="No imports yet"
              description="Import a CSV or NACHA file, or seed sample data to get started."
              action={<Button onClick={runSeed}>Seed sample data</Button>}
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Kind</TH>
                  <TH>File</TH>
                  <TH className="text-right">Rows</TH>
                  <TH className="text-right">Inserted</TH>
                  <TH className="text-right">Errors</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {imports.map((rec) => (
                  <TR key={rec.id}>
                    <TD className="text-zinc-400">{fmtDateTime(rec.created_at)}</TD>
                    <TD>
                      <Badge tone="info">{rec.kind}</Badge>
                    </TD>
                    <TD className="text-zinc-300">{rec.filename ?? '—'}</TD>
                    <TD className="text-right tabular-nums text-zinc-300">{rec.row_count ?? 0}</TD>
                    <TD className="text-right tabular-nums text-amber-300">{rec.inserted_count ?? 0}</TD>
                    <TD className="text-right tabular-nums">
                      {rec.error_count > 0 ? (
                        <button
                          onClick={() => setErrDetail(rec)}
                          className="text-red-400 underline-offset-2 hover:underline"
                        >
                          {rec.error_count}
                        </button>
                      ) : (
                        <span className="text-zinc-500">0</span>
                      )}
                    </TD>
                    <TD>
                      <Badge tone={statusTone(rec.status)}>{rec.status}</Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {/* CSV import modal */}
      <Modal
        open={csvOpen}
        onClose={() => setCsvOpen(false)}
        title="Import CSV"
        className="max-w-2xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCsvOpen(false)} disabled={csvBusy}>
              Cancel
            </Button>
            <Button onClick={runCsvImport} disabled={csvBusy || !csvPreview || csvPreview.rows.length === 0}>
              {csvBusy ? 'Importing…' : `Import ${csvPreview?.rows.length ?? 0} rows`}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {csvError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {csvError}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Dataset">
              <select
                value={csvKind}
                onChange={(e) => setCsvKind(e.target.value as CsvKind)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
              >
                {CSV_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Filename">
              <input
                value={csvFilename}
                onChange={(e) => setCsvFilename(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
              />
            </Field>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400">
            Expected columns:{' '}
            <span className="font-mono text-zinc-300">{selectedKind.columns.join(', ')}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700">
              Choose file
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) onCsvFile(f)
                }}
              />
            </label>
            <Button variant="ghost" onClick={fillCsvTemplate}>
              Insert header template
            </Button>
          </div>

          <Field label="CSV content">
            <textarea
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              rows={8}
              placeholder={`${selectedKind.columns.join(',')}\n…`}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-600"
            />
          </Field>

          {csvPreview && csvPreview.rows.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
                Preview — {csvPreview.rows.length} rows
              </div>
              <div className="max-h-48 overflow-auto rounded-lg border border-zinc-800">
                <table className="w-full text-xs">
                  <thead className="bg-zinc-900 text-left text-zinc-500">
                    <tr>
                      {csvPreview.headers.map((h) => (
                        <th key={h} className="px-2 py-1.5 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800">
                    {csvPreview.rows.slice(0, 8).map((r, i) => (
                      <tr key={i}>
                        {csvPreview.headers.map((h) => (
                          <td key={h} className="px-2 py-1.5 text-zinc-300">
                            {r[h]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </Modal>

      {/* NACHA import modal */}
      <Modal
        open={nachaOpen}
        onClose={() => setNachaOpen(false)}
        title="Import NACHA return file"
        className="max-w-2xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setNachaOpen(false)} disabled={nachaBusy}>
              Cancel
            </Button>
            <Button onClick={runNachaImport} disabled={nachaBusy || !nachaText.trim()}>
              {nachaBusy ? 'Parsing…' : 'Parse & import'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {nachaError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {nachaError}
            </div>
          )}
          <p className="text-xs text-zinc-400">
            Paste the raw text of a NACHA return file (94-char records). Addenda return records (entry type 7 with
            return reason codes) are parsed into return entries.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700">
              Choose file
              <input
                type="file"
                accept=".ach,.nacha,.txt,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) onNachaFile(f)
                }}
              />
            </label>
            <Field label="Filename">
              <input
                value={nachaFilename}
                onChange={(e) => setNachaFilename(e.target.value)}
                className="w-56 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
              />
            </Field>
          </div>
          <Field label="File content">
            <textarea
              value={nachaText}
              onChange={(e) => setNachaText(e.target.value)}
              rows={10}
              placeholder="101 0210000890 …"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-600"
            />
          </Field>
        </div>
      </Modal>

      {/* Errors detail modal */}
      <Modal
        open={errDetail !== null}
        onClose={() => setErrDetail(null)}
        title="Import errors"
        footer={<Button onClick={() => setErrDetail(null)}>Close</Button>}
      >
        {errDetail && (
          <div className="space-y-3 text-sm">
            <div className="text-zinc-400">
              {errDetail.filename ?? errDetail.kind} — {errDetail.error_count} of {errDetail.row_count} rows failed.
            </div>
            <ul className="space-y-1.5">
              {errorList(errDetail).map((msg, i) => (
                <li
                  key={i}
                  className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 font-mono text-xs text-red-200"
                >
                  {msg}
                </li>
              ))}
              {errorList(errDetail).length === 0 && (
                <li className="text-xs text-zinc-500">No detailed error messages were recorded.</li>
              )}
            </ul>
          </div>
        )}
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
