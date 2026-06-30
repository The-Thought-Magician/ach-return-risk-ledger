import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { db } from './db/index.js'
import { migrate } from './db/migrate.js'
import {
  plans,
  return_codes,
  originators,
  originated_entries,
  return_entries,
  fee_records,
  thresholds,
} from './db/schema.js'

import originatorsRoutes from './routes/originators.js'
import entriesRoutes from './routes/entries.js'
import returnsRoutes from './routes/returns.js'
import returnCodesRoutes from './routes/returnCodes.js'
import ratesRoutes from './routes/rates.js'
import thresholdsRoutes from './routes/thresholds.js'
import forecastsRoutes from './routes/forecasts.js'
import scorecardsRoutes from './routes/scorecards.js'
import feesRoutes from './routes/fees.js'
import representmentsRoutes from './routes/representments.js'
import disputeWindowsRoutes from './routes/disputeWindows.js'
import alertRulesRoutes from './routes/alertRules.js'
import alertsRoutes from './routes/alerts.js'
import lettersRoutes from './routes/letters.js'
import casesRoutes from './routes/cases.js'
import importsRoutes from './routes/imports.js'
import reportsRoutes from './routes/reports.js'
import benchmarksRoutes from './routes/benchmarks.js'
import analyticsRoutes from './routes/analytics.js'
import viewsRoutes from './routes/views.js'
import auditRoutes from './routes/audit.js'
import dashboardRoutes from './routes/dashboard.js'
import billingRoutes from './routes/billing.js'

const app = new Hono()

const allowedOrigins = [
  process.env.FRONTEND_URL ?? 'http://localhost:3000',
  'https://ach-return-risk-ledger.vercel.app',
]

app.use(
  '*',
  cors({
    origin: (origin) => (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]),
    credentials: true,
  }),
)

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const seedPlans = [
  { id: 'free', name: 'Free', price_cents: 0 },
  { id: 'pro', name: 'Pro', price_cents: 4900 },
]

// NACHA return code dictionary (R01-R85). category buckets per build-plan:
// unauthorized: R05, R07, R10, R11, R29, R51 ; admin: R02, R03, R04 ; else other.
const UNAUTHORIZED = new Set(['R05', 'R07', 'R10', 'R11', 'R29', 'R51'])
const ADMINISTRATIVE = new Set(['R02', 'R03', 'R04'])

const RETURN_CODE_DEFS: Array<{ code: string; description: string; consumer: boolean }> = [
  { code: 'R01', description: 'Insufficient Funds', consumer: false },
  { code: 'R02', description: 'Account Closed', consumer: false },
  { code: 'R03', description: 'No Account / Unable to Locate Account', consumer: false },
  { code: 'R04', description: 'Invalid Account Number Structure', consumer: false },
  { code: 'R05', description: 'Unauthorized Debit to Consumer Account Using Corporate SEC Code', consumer: true },
  { code: 'R06', description: 'Returned per ODFI Request', consumer: false },
  { code: 'R07', description: 'Authorization Revoked by Customer', consumer: true },
  { code: 'R08', description: 'Payment Stopped', consumer: false },
  { code: 'R09', description: 'Uncollected Funds', consumer: false },
  { code: 'R10', description: 'Customer Advises Originator is Not Known / Not Authorized', consumer: true },
  { code: 'R11', description: 'Customer Advises Entry Not in Accordance with Terms', consumer: true },
  { code: 'R12', description: 'Branch Sold to Another DFI', consumer: false },
  { code: 'R13', description: 'Invalid ACH Routing Number', consumer: false },
  { code: 'R14', description: 'Representative Payee Deceased or Unable to Continue', consumer: false },
  { code: 'R15', description: 'Beneficiary or Account Holder Deceased', consumer: false },
  { code: 'R16', description: 'Account Frozen / Entry Returned per OFAC', consumer: false },
  { code: 'R17', description: 'File Record Edit Criteria / Questionable Entry', consumer: false },
  { code: 'R18', description: 'Improper Effective Entry Date', consumer: false },
  { code: 'R19', description: 'Amount Field Error', consumer: false },
  { code: 'R20', description: 'Non-Transaction Account', consumer: false },
  { code: 'R21', description: 'Invalid Company Identification', consumer: false },
  { code: 'R22', description: 'Invalid Individual ID Number', consumer: false },
  { code: 'R23', description: 'Credit Entry Refused by Receiver', consumer: false },
  { code: 'R24', description: 'Duplicate Entry', consumer: false },
  { code: 'R25', description: 'Addenda Error', consumer: false },
  { code: 'R26', description: 'Mandatory Field Error', consumer: false },
  { code: 'R27', description: 'Trace Number Error', consumer: false },
  { code: 'R28', description: 'Routing Number Check Digit Error', consumer: false },
  { code: 'R29', description: 'Corporate Customer Advises Not Authorized', consumer: false },
  { code: 'R30', description: 'RDFI Not Participant in Check Truncation Program', consumer: false },
  { code: 'R31', description: 'Permissible Return Entry (CCD/CTX)', consumer: false },
  { code: 'R32', description: 'RDFI Non-Settlement', consumer: false },
  { code: 'R33', description: 'Return of XCK Entry', consumer: false },
  { code: 'R34', description: 'Limited Participation DFI', consumer: false },
  { code: 'R35', description: 'Return of Improper Debit Entry', consumer: false },
  { code: 'R36', description: 'Return of Improper Credit Entry', consumer: false },
  { code: 'R37', description: 'Source Document Presented for Payment', consumer: true },
  { code: 'R38', description: 'Stop Payment on Source Document', consumer: true },
  { code: 'R39', description: 'Improper Source Document / Source Document Presented for Payment', consumer: false },
  { code: 'R40', description: 'Return of ENR Entry by Federal Government Agency', consumer: false },
  { code: 'R41', description: 'Invalid Transaction Code (ENR)', consumer: false },
  { code: 'R42', description: 'Routing Number / Check Digit Error (ENR)', consumer: false },
  { code: 'R43', description: 'Invalid DFI Account Number (ENR)', consumer: false },
  { code: 'R44', description: 'Invalid Individual ID Number (ENR)', consumer: false },
  { code: 'R45', description: 'Invalid Individual Name / Company Name (ENR)', consumer: false },
  { code: 'R46', description: 'Invalid Representative Payee Indicator (ENR)', consumer: false },
  { code: 'R47', description: 'Duplicate Enrollment (ENR)', consumer: false },
  { code: 'R50', description: 'State Law Affecting RCK Acceptance', consumer: false },
  { code: 'R51', description: 'Item Related to RCK Entry is Ineligible / RCK Entry Improper', consumer: true },
  { code: 'R52', description: 'Stop Payment on Item Related to RCK Entry', consumer: false },
  { code: 'R53', description: 'Item and RCK Entry Presented for Payment', consumer: false },
  { code: 'R61', description: 'Misrouted Return', consumer: false },
  { code: 'R62', description: 'Return of Erroneous or Reversing Debit', consumer: false },
  { code: 'R67', description: 'Duplicate Return', consumer: false },
  { code: 'R68', description: 'Untimely Return', consumer: false },
  { code: 'R69', description: 'Field Errors', consumer: false },
  { code: 'R70', description: 'Permissible Return Entry Not Accepted / Return Not Requested by ODFI', consumer: false },
  { code: 'R71', description: 'Misrouted Dishonored Return', consumer: false },
  { code: 'R72', description: 'Untimely Dishonored Return', consumer: false },
  { code: 'R73', description: 'Timely Original Return', consumer: false },
  { code: 'R74', description: 'Corrected Return', consumer: false },
  { code: 'R75', description: 'Return Not a Duplicate', consumer: false },
  { code: 'R76', description: 'No Errors Found', consumer: false },
  { code: 'R77', description: 'Non-Acceptance of R62 Dishonored Return', consumer: false },
  { code: 'R80', description: 'IAT Entry Coding Error', consumer: false },
  { code: 'R81', description: 'Non-Participant in IAT Program', consumer: false },
  { code: 'R82', description: 'Invalid Foreign RDFI Identification (IAT)', consumer: false },
  { code: 'R83', description: 'Foreign RDFI Unable to Settle (IAT)', consumer: false },
  { code: 'R84', description: 'Entry Not Processed by Gateway (IAT)', consumer: false },
  { code: 'R85', description: 'Incorrectly Coded Outbound International Payment (IAT)', consumer: false },
]

function categoryFor(code: string): string {
  if (UNAUTHORIZED.has(code)) return 'unauthorized'
  if (ADMINISTRATIVE.has(code)) return 'administrative'
  return 'other'
}

const DEMO_WORKSPACE = 'demo-workspace'

async function seedIfEmpty() {
  // Plans
  try {
    const existing = await db.select().from(plans).limit(1)
    if (existing.length === 0) {
      for (const p of seedPlans) await db.insert(plans).values(p as any)
      console.log('Seeded plans')
    }
  } catch (e) {
    console.error('Seed plans error:', e)
  }

  // Return codes dictionary
  try {
    const existing = await db.select().from(return_codes).limit(1)
    if (existing.length === 0) {
      for (const def of RETURN_CODE_DEFS) {
        await db.insert(return_codes).values({
          code: def.code,
          description: def.description,
          category: categoryFor(def.code),
          consumer: def.consumer,
        } as any)
      }
      console.log('Seeded return codes')
    }
  } catch (e) {
    console.error('Seed return codes error:', e)
  }

  // Demo originators + a few entries/returns/fees for the demo workspace
  try {
    const existing = await db.select().from(originators).limit(1)
    if (existing.length === 0) {
      const now = Date.now()
      const day = 86_400_000
      const demoOriginators = [
        { name: 'Acme Subscriptions', company_id: 'ACME001', odfi_name: 'First National', routing_number: '021000021', mcc: '5968', expected_monthly_volume: 12000, status: 'active' },
        { name: 'Lumen Utilities', company_id: 'LUMEN02', odfi_name: 'Metro Bank', routing_number: '011401533', mcc: '4900', expected_monthly_volume: 8000, status: 'active' },
        { name: 'Pioneer Lending', company_id: 'PION003', odfi_name: 'Coastal Trust', routing_number: '121000358', mcc: '6012', expected_monthly_volume: 3000, status: 'onboarding' },
      ]
      const insertedOriginators: Array<{ id: string }> = []
      for (const o of demoOriginators) {
        const [row] = await db
          .insert(originators)
          .values({ ...o, workspace_id: DEMO_WORKSPACE, created_by: DEMO_WORKSPACE } as any)
          .returning()
        insertedOriginators.push(row)
      }

      // Originated debit entries + returns for the first two originators.
      for (let oi = 0; oi < 2; oi++) {
        const orig = insertedOriginators[oi]
        for (let i = 0; i < 20; i++) {
          const entryDate = new Date(now - (i + 1) * day)
          const settlement = new Date(entryDate.getTime() + 2 * day)
          const [entry] = await db
            .insert(originated_entries)
            .values({
              workspace_id: DEMO_WORKSPACE,
              originator_id: orig.id,
              entry_date: entryDate,
              settlement_date: settlement,
              direction: 'debit',
              sec_code: oi === 0 ? 'WEB' : 'PPD',
              amount_cents: 5000 + i * 100,
              trace_number: `TRACE${oi}${i}`,
              created_by: DEMO_WORKSPACE,
            } as any)
            .returning()

          // Sprinkle returns: originator 0 has a higher unauthorized rate.
          if (i % (oi === 0 ? 6 : 12) === 0) {
            const code = oi === 0 ? (i % 2 === 0 ? 'R10' : 'R01') : 'R02'
            const [ret] = await db
              .insert(return_entries)
              .values({
                workspace_id: DEMO_WORKSPACE,
                originator_id: orig.id,
                originated_entry_id: entry.id,
                return_code: code,
                category: categoryFor(code),
                return_date: new Date(settlement.getTime() + day),
                amount_cents: entry.amount_cents,
                is_late: false,
                matched: true,
                created_by: DEMO_WORKSPACE,
              } as any)
              .returning()

            await db.insert(fee_records).values({
              workspace_id: DEMO_WORKSPACE,
              originator_id: orig.id,
              return_entry_id: ret.id,
              fee_type: 'return',
              amount_cents: 500,
              incurred_at: new Date(settlement.getTime() + day),
              created_by: DEMO_WORKSPACE,
            } as any)
          }
        }
      }
      console.log('Seeded demo originators/entries/returns/fees')
    }
  } catch (e) {
    console.error('Seed demo data error:', e)
  }

  // Default thresholds row for the demo workspace.
  try {
    const existing = await db.select().from(thresholds).limit(1)
    if (existing.length === 0) {
      await db.insert(thresholds).values({
        workspace_id: DEMO_WORKSPACE,
        created_by: DEMO_WORKSPACE,
      } as any)
      console.log('Seeded default thresholds')
    }
  } catch (e) {
    console.error('Seed thresholds error:', e)
  }
}

// ---------------------------------------------------------------------------
// Route mounting
// ---------------------------------------------------------------------------

const api = new Hono()
api.route('/originators', originatorsRoutes)
api.route('/entries', entriesRoutes)
api.route('/returns', returnsRoutes)
api.route('/return-codes', returnCodesRoutes)
api.route('/rates', ratesRoutes)
api.route('/thresholds', thresholdsRoutes)
api.route('/forecasts', forecastsRoutes)
api.route('/scorecards', scorecardsRoutes)
api.route('/fees', feesRoutes)
api.route('/representments', representmentsRoutes)
api.route('/dispute-windows', disputeWindowsRoutes)
api.route('/alert-rules', alertRulesRoutes)
api.route('/alerts', alertsRoutes)
api.route('/letters', lettersRoutes)
api.route('/cases', casesRoutes)
api.route('/imports', importsRoutes)
api.route('/reports', reportsRoutes)
api.route('/benchmarks', benchmarksRoutes)
api.route('/analytics', analyticsRoutes)
api.route('/views', viewsRoutes)
api.route('/audit', auditRoutes)
api.route('/dashboard', dashboardRoutes)
api.route('/billing', billingRoutes)

app.route('/api/v1', api)
app.get('/health', (c) => c.json({ ok: true }))

// ---------------------------------------------------------------------------
// Boot — bind the port FIRST so platform health checks see a live service,
// THEN run migrate() and seedIfEmpty() (each idempotent, each in its own
// try/catch). NEVER await migrate()/seed before serve() — a cold DB would
// block the port binding and trip a deploy timeout.
// ---------------------------------------------------------------------------

const port = parseInt(process.env.PORT ?? '3001')
serve({ fetch: app.fetch, port }, () => console.log(`Server running on port ${port}`))

;(async () => {
  try {
    await migrate()
  } catch (e) {
    console.error('Migration error:', e)
  }
  try {
    await seedIfEmpty()
  } catch (e) {
    console.error('Seed error:', e)
  }
})()

export default app
