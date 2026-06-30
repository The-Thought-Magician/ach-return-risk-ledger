import Link from 'next/link'

const FEATURES = [
  {
    title: 'NACHA Threshold Monitor',
    body: 'Continuously computes the three regulated rates per originator over a rolling 60-day window with clear / watch / warning / breach status and basis-point headroom to each limit.',
  },
  {
    title: 'Breach-Forecast Engine',
    body: 'Linear and exponentially-weighted velocity models project the date each originator will cross a threshold, ranked portfolio-wide by days to breach with a confidence band.',
  },
  {
    title: 'Return-Reason Classifier',
    body: 'Full NACHA R01-R85 dictionary, automatic bucketing into unauthorized, administrative, and overall, per-code trends, and workspace reclassification overrides.',
  },
  {
    title: 'Fee & Re-Presentment Economics',
    body: 'Track ODFI return and NSF fees, re-presentment attempts under the Reinitiated Entry rules, recovery rates, and net fees-versus-recovered economics per originator.',
  },
  {
    title: 'Originator Scorecards',
    body: 'Composite risk score from headroom, velocity, volume, and re-presentment behavior, A-F letter grades, and percentile comparison against the portfolio.',
  },
  {
    title: '60-Day Dispute-Window Tracker',
    body: 'Computes the consumer unauthorized-return window expiry per debit, surfaces open-window dollar exposure, expiring-soon calendars, and late-return detection.',
  },
  {
    title: 'Alerts, Letters & Remediation',
    body: 'Configurable trigger rules, an alert inbox with acknowledge and snooze, an ODFI warning-letter tracker, and remediation cases with action items tying it all together.',
  },
  {
    title: 'Imports, Reports & Audit Trail',
    body: 'CSV and NACHA-file import with row validation, a sample-data seeder, compliance report generation, benchmarks, and an append-only audit log of every write.',
  },
]

const THRESHOLDS = [
  { label: 'Unauthorized returns', limit: '0.5%', codes: 'R05, R07, R10, R11, R29, R51' },
  { label: 'Administrative returns', limit: '3.0%', codes: 'R02, R03, R04' },
  { label: 'Overall returns', limit: '15.0%', codes: 'all reason codes' },
]

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <nav className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
        <span className="text-lg font-black tracking-tight text-emerald-400">AchReturnRiskLedger</span>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/pricing" className="text-slate-300 hover:text-white">
            Pricing
          </Link>
          <Link href="/auth/sign-in" className="text-slate-300 hover:text-white">
            Sign In
          </Link>
          <Link
            href="/auth/sign-up"
            className="rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500"
          >
            Get Started
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-6 py-24 text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
          NACHA Risk Management &amp; Enforcement
        </span>
        <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-black leading-tight tracking-tight text-white sm:text-5xl">
          Know which originators will breach a NACHA return threshold, before they do.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-400">
          AchReturnRiskLedger turns month-end spreadsheet math into an always-on ledger. It computes unauthorized,
          administrative, and overall return rates over rolling windows, forecasts breaches from return velocity, and
          gives compliance teams a defensible audit trail.
        </p>
        <div className="mt-9 flex items-center justify-center gap-4">
          <Link
            href="/auth/sign-up"
            className="rounded-lg bg-emerald-600 px-6 py-3 font-semibold text-white hover:bg-emerald-500"
          >
            Start monitoring free
          </Link>
          <Link
            href="/auth/sign-in"
            className="rounded-lg border border-slate-700 bg-slate-900 px-6 py-3 font-semibold text-slate-200 hover:bg-slate-800"
          >
            Sign in
          </Link>
        </div>
      </section>

      {/* Problem */}
      <section className="border-t border-slate-800 bg-slate-900/30">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <div className="grid gap-10 lg:grid-cols-2">
            <div>
              <h2 className="text-2xl font-bold text-white">Monitoring is manual and lagging</h2>
              <p className="mt-4 text-slate-400">
                Most risk and ops teams pull return reports, paste them into Excel, and compute ratios at month-end. By
                the time a 0.5% unauthorized rate is visible, the breach has already happened. A breach triggers a NACHA
                inquiry, fines that can reach roughly $500,000 per month, and ultimately suspension of an originator's
                ability to send ACH debits.
              </p>
              <p className="mt-4 text-slate-400">
                The denominators are subtle: the unauthorized rate uses a 60-day rolling count of debit entries and
                counts only specific return codes. Get the window or the code buckets wrong and you get false comfort or
                false alarms. There is no early-warning velocity signal and no system of record tying a letter, an
                inquiry, a remediation plan, and the underlying return data together.
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-6">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                The three regulated thresholds
              </h3>
              <div className="mt-4 space-y-3">
                {THRESHOLDS.map((t) => (
                  <div key={t.label} className="flex items-start justify-between gap-4 border-b border-slate-800 pb-3 last:border-0 last:pb-0">
                    <div>
                      <div className="font-medium text-slate-200">{t.label}</div>
                      <div className="text-xs text-slate-500">{t.codes}</div>
                    </div>
                    <div className="shrink-0 text-2xl font-bold tabular-nums text-emerald-300">{t.limit}</div>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs text-slate-600">
                Computed continuously over rolling windows, not at month-end.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-white">Everything a NACHA compliance desk needs</h2>
          <p className="mx-auto mt-3 max-w-2xl text-slate-400">
            From rate computation to remediation, in one ledger built for the Risk Management and Enforcement framework.
          </p>
        </div>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
              <h3 className="text-sm font-semibold text-emerald-300">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-slate-800 bg-slate-900/30">
        <div className="mx-auto max-w-4xl px-6 py-20 text-center">
          <h2 className="text-3xl font-bold text-white">A single avoided suspension dwarfs the cost.</h2>
          <p className="mx-auto mt-4 max-w-xl text-slate-400">
            Built for risk and compliance managers at payfacs, ACH operations leads at ODFIs and sponsor banks, and
            compliance leads at high-volume billers. Every feature is free.
          </p>
          <div className="mt-8 flex items-center justify-center gap-4">
            <Link
              href="/auth/sign-up"
              className="rounded-lg bg-emerald-600 px-6 py-3 font-semibold text-white hover:bg-emerald-500"
            >
              Create your workspace
            </Link>
            <Link
              href="/pricing"
              className="rounded-lg border border-slate-700 bg-slate-950 px-6 py-3 font-semibold text-slate-200 hover:bg-slate-800"
            >
              See pricing
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-800 py-10 text-center text-sm text-slate-600">
        <p className="font-semibold text-slate-500">AchReturnRiskLedger</p>
        <p className="mt-1">Continuous NACHA return-rate monitoring and breach forecasting.</p>
      </footer>
    </main>
  )
}
