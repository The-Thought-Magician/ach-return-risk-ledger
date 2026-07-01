import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  imports,
  originators,
  originated_entries,
  return_entries,
  return_codes,
  fee_records,
  dispute_windows,
  audit_logs,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'
import { recomputeSnapshots } from './rates.js'

const router = new Hono()

const UNAUTHORIZED = new Set(['R05', 'R07', 'R10', 'R11', 'R29', 'R51'])
const ADMINISTRATIVE = new Set(['R02', 'R03', 'R04'])

function categoryFor(code: string): string {
  if (UNAUTHORIZED.has(code)) return 'unauthorized'
  if (ADMINISTRATIVE.has(code)) return 'administrative'
  return 'other'
}

const DAY_MS = 86_400_000

function parseDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

function toCents(v: unknown): number {
  if (typeof v === 'number') return Math.round(v)
  const n = Number(String(v).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? Math.round(n) : 0
}

async function logAudit(
  workspaceId: string,
  actor: string,
  action: string,
  entityType: string,
  entityId: string | null,
  detail: Record<string, unknown>,
) {
  await db.insert(audit_logs).values({
    workspace_id: workspaceId,
    actor,
    action,
    entity_type: entityType,
    entity_id: entityId,
    detail,
  } as any)
}

// ---------------------------------------------------------------------------
// GET / — import history (public read, scoped to a workspace via query)
// ---------------------------------------------------------------------------
router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id') ?? getUserId(c)
  const conds = [] as any[]
  if (workspaceId) conds.push(eq(imports.workspace_id, workspaceId))
  const rows = await db
    .select()
    .from(imports)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(imports.created_at))
  return c.json(rows)
})

// ---------------------------------------------------------------------------
// POST /csv — import CSV rows. body: { kind, rows[], filename? }
//   kind = originators | originated | returns
// ---------------------------------------------------------------------------
const csvSchema = z.object({
  kind: z.enum(['originators', 'originated', 'returns']),
  filename: z.string().optional(),
  rows: z.array(z.record(z.any())).min(1),
})

router.post('/csv', authMiddleware, zValidator('json', csvSchema), async (c) => {
  const userId = getUserId(c)
  const { kind, rows, filename } = c.req.valid('json')

  const errors: Array<{ row: number; message: string }> = []
  let inserted = 0

  // Cache originators for this workspace for FK resolution by company_id / id / name.
  const wsOriginators = await db
    .select()
    .from(originators)
    .where(eq(originators.workspace_id, userId))

  function resolveOriginator(row: Record<string, any>): string | null {
    const candidate =
      row.originator_id ?? row.originatorId ?? row.company_id ?? row.companyId ?? row.originator ?? row.name
    if (!candidate) return null
    const key = String(candidate).trim().toLowerCase()
    const found = wsOriginators.find(
      (o) =>
        o.id.toLowerCase() === key ||
        (o.company_id ?? '').toLowerCase() === key ||
        o.name.toLowerCase() === key,
    )
    return found ? found.id : null
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    try {
      if (kind === 'originators') {
        if (!row.name || !String(row.name).trim()) {
          errors.push({ row: i, message: 'Missing name' })
          continue
        }
        const [created] = await db
          .insert(originators)
          .values({
            workspace_id: userId,
            name: String(row.name).trim(),
            company_id: row.company_id ?? row.companyId ?? null,
            odfi_name: row.odfi_name ?? row.odfiName ?? null,
            routing_number: row.routing_number ?? row.routingNumber ?? null,
            mcc: row.mcc ?? null,
            expected_monthly_volume: row.expected_monthly_volume
              ? Number(row.expected_monthly_volume)
              : 0,
            status: row.status ?? 'active',
            created_by: userId,
          } as any)
          .returning()
        wsOriginators.push(created)
        inserted++
      } else if (kind === 'originated') {
        const originatorId = resolveOriginator(row)
        if (!originatorId) {
          errors.push({ row: i, message: 'Could not resolve originator' })
          continue
        }
        const entryDate = parseDate(row.entry_date ?? row.entryDate)
        if (!entryDate) {
          errors.push({ row: i, message: 'Invalid or missing entry_date' })
          continue
        }
        const settlementDate = parseDate(row.settlement_date ?? row.settlementDate)
        const direction = (row.direction ?? 'debit').toString().toLowerCase()
        const [entry] = await db
          .insert(originated_entries)
          .values({
            workspace_id: userId,
            originator_id: originatorId,
            entry_date: entryDate,
            settlement_date: settlementDate,
            direction: direction === 'credit' ? 'credit' : 'debit',
            sec_code: (row.sec_code ?? row.secCode ?? 'PPD').toString().toUpperCase(),
            amount_cents: toCents(row.amount_cents ?? row.amountCents ?? row.amount),
            trace_number: row.trace_number ?? row.traceNumber ?? null,
            external_ref: row.external_ref ?? row.externalRef ?? null,
            created_by: userId,
          } as any)
          .returning()
        inserted++

        // Upsert a 60-day dispute window for debit entries.
        if (entry.direction === 'debit' && settlementDate) {
          const expiry = new Date(settlementDate.getTime() + 60 * DAY_MS)
          await db
            .insert(dispute_windows)
            .values({
              workspace_id: userId,
              originator_id: originatorId,
              originated_entry_id: entry.id,
              settlement_date: settlementDate,
              window_expiry: expiry,
              amount_cents: entry.amount_cents,
              status: expiry.getTime() < Date.now() ? 'expired' : 'open',
            } as any)
            .onConflictDoNothing({ target: dispute_windows.originated_entry_id })
        }
      } else if (kind === 'returns') {
        const originatorId = resolveOriginator(row)
        if (!originatorId) {
          errors.push({ row: i, message: 'Could not resolve originator' })
          continue
        }
        const code = (row.return_code ?? row.returnCode ?? row.code ?? '').toString().toUpperCase()
        if (!code) {
          errors.push({ row: i, message: 'Missing return_code' })
          continue
        }
        const returnDate = parseDate(row.return_date ?? row.returnDate)
        if (!returnDate) {
          errors.push({ row: i, message: 'Invalid or missing return_date' })
          continue
        }
        await db
          .insert(return_entries)
          .values({
            workspace_id: userId,
            originator_id: originatorId,
            originated_entry_id: row.originated_entry_id ?? row.originatedEntryId ?? null,
            return_code: code,
            category: categoryFor(code),
            return_date: returnDate,
            amount_cents: toCents(row.amount_cents ?? row.amountCents ?? row.amount),
            is_late: row.is_late === true || row.is_late === 'true',
            matched: !!(row.originated_entry_id ?? row.originatedEntryId),
            external_ref: row.external_ref ?? row.externalRef ?? null,
            created_by: userId,
          } as any)
        inserted++
      }
    } catch (e) {
      errors.push({ row: i, message: e instanceof Error ? e.message : 'Insert failed' })
    }
  }

  const status = errors.length === 0 ? 'completed' : inserted > 0 ? 'partial' : 'failed'
  const [record] = await db
    .insert(imports)
    .values({
      workspace_id: userId,
      kind,
      filename: filename ?? null,
      row_count: rows.length,
      inserted_count: inserted,
      error_count: errors.length,
      errors,
      status,
      created_by: userId,
    } as any)
    .returning()

  await logAudit(userId, userId, 'import.csv', 'import', record.id, {
    kind,
    inserted,
    errors: errors.length,
  })

  return c.json(record, 201)
})

// ---------------------------------------------------------------------------
// POST /nacha — parse a NACHA return file (text). body: { content, filename? }
// Parses Entry Detail (type 6) + Addenda (type 7) records to extract return
// codes and amounts, then logs them as return_entries against best-effort
// originator matches by company id embedded in the batch header (type 5).
// ---------------------------------------------------------------------------
const nachaSchema = z.object({
  content: z.string().min(1),
  filename: z.string().optional(),
})

router.post('/nacha', authMiddleware, zValidator('json', nachaSchema), async (c) => {
  const userId = getUserId(c)
  const { content, filename } = c.req.valid('json')

  const wsOriginators = await db
    .select()
    .from(originators)
    .where(eq(originators.workspace_id, userId))

  // NACHA files are fixed-width 94-char records. Split on newlines OR on every
  // 94 chars when the file is delivered as one long line.
  let lines: string[] = content.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length === 1 && lines[0].length > 94) {
    const blob = lines[0]
    lines = []
    for (let i = 0; i < blob.length; i += 94) lines.push(blob.slice(i, i + 94))
  }

  const errors: Array<{ row: number; message: string }> = []
  let inserted = 0

  // Track the originator resolved for the current batch (type 5 record).
  let batchOriginatorId: string | null = null
  // Buffer of the most recent detail entry to attach a return code from its addenda.
  let lastEntry: { amountCents: number; traceNumber: string } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].padEnd(94, ' ')
    const recordType = line[0]
    try {
      if (recordType === '5') {
        // Company/Batch Header: company name 4-19, company id 41-50.
        const companyName = line.slice(4, 20).trim()
        const companyId = line.slice(40, 50).trim()
        const key = (companyId || companyName).toLowerCase()
        const found = wsOriginators.find(
          (o) =>
            (o.company_id ?? '').toLowerCase() === key ||
            o.name.toLowerCase() === companyName.toLowerCase(),
        )
        batchOriginatorId = found ? found.id : null
      } else if (recordType === '6') {
        // Entry Detail: amount 29-39 (in cents), trace 79-94.
        const amountCents = parseInt(line.slice(29, 39).trim() || '0', 10) || 0
        const traceNumber = line.slice(79, 94).trim()
        lastEntry = { amountCents, traceNumber }
      } else if (recordType === '7') {
        // Addenda (return) record: return reason code at 3-6 (e.g. "R01").
        const codeMatch = line.slice(3, 6).trim().toUpperCase()
        const code = /^R\d{2}$/.test(codeMatch) ? codeMatch : ''
        if (!code) {
          errors.push({ row: i, message: 'Addenda without recognizable return code' })
          continue
        }
        if (!batchOriginatorId) {
          errors.push({ row: i, message: 'No matching originator for batch' })
          continue
        }
        await db
          .insert(return_entries)
          .values({
            workspace_id: userId,
            originator_id: batchOriginatorId,
            originated_entry_id: null,
            return_code: code,
            category: categoryFor(code),
            return_date: new Date(),
            amount_cents: lastEntry?.amountCents ?? 0,
            is_late: false,
            matched: false,
            external_ref: lastEntry?.traceNumber ?? null,
            created_by: userId,
          } as any)
        inserted++
        lastEntry = null
      }
      // record types 1 (file header), 8 (batch control), 9 (file control) are ignored
    } catch (e) {
      errors.push({ row: i, message: e instanceof Error ? e.message : 'Parse failed' })
    }
  }

  const status = inserted === 0 && errors.length > 0 ? 'failed' : errors.length > 0 ? 'partial' : 'completed'
  const [record] = await db
    .insert(imports)
    .values({
      workspace_id: userId,
      kind: 'nacha',
      filename: filename ?? null,
      row_count: lines.length,
      inserted_count: inserted,
      error_count: errors.length,
      errors,
      status,
      created_by: userId,
    } as any)
    .returning()

  await logAudit(userId, userId, 'import.nacha', 'import', record.id, {
    inserted,
    errors: errors.length,
  })

  return c.json(record, 201)
})

// ---------------------------------------------------------------------------
// POST /sample — seed sample originators/entries/returns/fees for this workspace
// ---------------------------------------------------------------------------
router.post('/sample', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const now = Date.now()
  const day = DAY_MS

  const existingSample = await db
    .select()
    .from(originators)
    .where(and(eq(originators.workspace_id, userId), eq(originators.company_id, 'SAMP001')))
  if (existingSample.length > 0) {
    return c.json({ error: 'Sample data already seeded for this workspace' }, 409)
  }

  const sampleOriginators = [
    {
      name: 'Sample Subscriptions Co',
      company_id: 'SAMP001',
      odfi_name: 'First National',
      routing_number: '021000021',
      mcc: '5968',
      expected_monthly_volume: 10000,
      status: 'active',
    },
    {
      name: 'Sample Utilities LLC',
      company_id: 'SAMP002',
      odfi_name: 'Metro Bank',
      routing_number: '011401533',
      mcc: '4900',
      expected_monthly_volume: 6000,
      status: 'active',
    },
    {
      name: 'Sample Lending Inc',
      company_id: 'SAMP003',
      odfi_name: 'Coastal Trust',
      routing_number: '121000358',
      mcc: '6012',
      expected_monthly_volume: 2500,
      status: 'onboarding',
    },
  ]

  let originatorsInserted = 0
  let entriesInserted = 0
  let returnsInserted = 0
  let feesInserted = 0
  let windowsInserted = 0

  const insertedOriginators: Array<{ id: string }> = []
  for (const o of sampleOriginators) {
    const [row] = await db
      .insert(originators)
      .values({ ...o, workspace_id: userId, created_by: userId } as any)
      .returning()
    insertedOriginators.push(row)
    originatorsInserted++
  }

  for (let oi = 0; oi < insertedOriginators.length; oi++) {
    const orig = insertedOriginators[oi]
    const count = oi === 2 ? 8 : 25
    for (let i = 0; i < count; i++) {
      const entryDate = new Date(now - (i + 1) * day)
      const settlement = new Date(entryDate.getTime() + 2 * day)
      const [entry] = await db
        .insert(originated_entries)
        .values({
          workspace_id: userId,
          originator_id: orig.id,
          entry_date: entryDate,
          settlement_date: settlement,
          direction: 'debit',
          sec_code: oi === 0 ? 'WEB' : oi === 1 ? 'PPD' : 'TEL',
          amount_cents: 4000 + i * 150,
          trace_number: `SAMP${oi}${String(i).padStart(3, '0')}`,
          created_by: userId,
        } as any)
        .returning()
      entriesInserted++

      const expiry = new Date(settlement.getTime() + 60 * day)
      await db
        .insert(dispute_windows)
        .values({
          workspace_id: userId,
          originator_id: orig.id,
          originated_entry_id: entry.id,
          settlement_date: settlement,
          window_expiry: expiry,
          amount_cents: entry.amount_cents,
          status: expiry.getTime() < now ? 'expired' : 'open',
        } as any)
        .onConflictDoNothing({ target: dispute_windows.originated_entry_id })
      windowsInserted++

      // Originator 0 carries a heavier unauthorized mix to make rates interesting.
      const divisor = oi === 0 ? 5 : oi === 1 ? 10 : 4
      if (i % divisor === 0) {
        const code = oi === 0 ? (i % 2 === 0 ? 'R10' : 'R01') : oi === 1 ? 'R02' : 'R05'
        const [ret] = await db
          .insert(return_entries)
          .values({
            workspace_id: userId,
            originator_id: orig.id,
            originated_entry_id: entry.id,
            return_code: code,
            category: categoryFor(code),
            return_date: new Date(settlement.getTime() + day),
            amount_cents: entry.amount_cents,
            is_late: i % 11 === 0,
            matched: true,
            created_by: userId,
          } as any)
          .returning()
        returnsInserted++

        await db.insert(fee_records).values({
          workspace_id: userId,
          originator_id: orig.id,
          return_entry_id: ret.id,
          fee_type: 'return',
          amount_cents: 500,
          incurred_at: new Date(settlement.getTime() + day),
          created_by: userId,
        } as any)
        feesInserted++
      }
    }
  }

  const summary = {
    originators: originatorsInserted,
    entries: entriesInserted,
    returns: returnsInserted,
    fees: feesInserted,
    dispute_windows: windowsInserted,
  }

  const [record] = await db
    .insert(imports)
    .values({
      workspace_id: userId,
      kind: 'sample',
      filename: 'sample-seed',
      row_count: originatorsInserted + entriesInserted + returnsInserted + feesInserted,
      inserted_count: originatorsInserted + entriesInserted + returnsInserted + feesInserted,
      error_count: 0,
      errors: [],
      status: 'completed',
      created_by: userId,
    } as any)
    .returning()

  await logAudit(userId, userId, 'import.sample', 'import', record.id, summary)

  await recomputeSnapshots(userId)

  return c.json({ import: record, summary }, 201)
})

export default router
