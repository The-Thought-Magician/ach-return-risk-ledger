'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import api from '@/lib/api'

const ALL_FEATURES = [
  'NACHA threshold monitor (unauthorized / admin / overall)',
  'Rolling 60-day window rate computation + snapshot history',
  'Breach-forecast engine with days-to-breach ranking',
  'Return-reason classifier (full R01-R85 dictionary)',
  'Fee & re-presentment economics ledger',
  'Originator scorecards with A-F grades and percentiles',
  '60-day consumer dispute-window tracker',
  'Alert rules, alert inbox, and warning-letter tracker',
  'Remediation case management with action items',
  'CSV / NACHA-file import + sample data seeder',
  'Compliance reporting, benchmarks, and analytics',
  'Append-only audit trail',
]

export default function Pricing() {
  const [stripeEnabled, setStripeEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let mounted = true
    api
      .getBillingPlan()
      .then((r: any) => {
        if (mounted) setStripeEnabled(!!r?.stripeEnabled)
      })
      .catch(() => {
        if (mounted) setStripeEnabled(false)
      })
    return () => {
      mounted = false
    }
  }, [])

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <nav className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
        <Link href="/" className="text-lg font-black tracking-tight text-amber-400">
          AchReturnRiskLedger
        </Link>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/auth/sign-in" className="text-zinc-300 hover:text-white">
            Sign In
          </Link>
          <Link
            href="/auth/sign-up"
            className="rounded-lg bg-amber-600 px-4 py-2 font-medium text-white hover:bg-amber-500"
          >
            Get Started
          </Link>
        </div>
      </nav>

      <section className="mx-auto max-w-4xl px-6 py-20 text-center">
        <h1 className="text-4xl font-black tracking-tight text-white">Simple pricing</h1>
        <p className="mx-auto mt-4 max-w-xl text-zinc-400">
          Every feature is free while AchReturnRiskLedger is in early access. A single avoided origination suspension is
          worth far more than any plan.
        </p>

        <div className="mx-auto mt-12 grid max-w-3xl gap-6 sm:grid-cols-2">
          {/* Free plan */}
          <div className="rounded-2xl border border-amber-500/40 bg-zinc-900/60 p-8 text-left">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">Free</h2>
              <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-300">
                Current
              </span>
            </div>
            <div className="mt-4 text-4xl font-black text-white">
              $0<span className="text-base font-medium text-zinc-500">/mo</span>
            </div>
            <p className="mt-2 text-sm text-zinc-400">All features, unlimited originators.</p>
            <ul className="mt-6 space-y-2 text-sm">
              {ALL_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2 text-zinc-300">
                  <svg
                    className="mt-0.5 h-4 w-4 shrink-0 text-amber-400"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <path d="m5 13 4 4L19 7" />
                  </svg>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <Link
              href="/auth/sign-up"
              className="mt-8 block rounded-lg bg-amber-600 py-3 text-center font-semibold text-white hover:bg-amber-500"
            >
              Start free
            </Link>
          </div>

          {/* Pro plan */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8 text-left">
            <h2 className="text-lg font-bold text-white">Pro</h2>
            <div className="mt-4 text-4xl font-black text-zinc-300">Coming soon</div>
            <p className="mt-2 text-sm text-zinc-400">
              Team seats, scheduled report delivery, and priority support. Billing is optional and not yet enabled.
            </p>
            <ul className="mt-6 space-y-2 text-sm text-zinc-400">
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-600" />
                Everything in Free
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-600" />
                Multi-seat workspaces
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-600" />
                Recurring compliance report delivery
              </li>
            </ul>
            <button
              disabled
              className="mt-8 block w-full cursor-not-allowed rounded-lg border border-zinc-700 bg-zinc-800 py-3 text-center font-semibold text-zinc-500"
            >
              {stripeEnabled === null
                ? 'Checking availability...'
                : stripeEnabled
                  ? 'Upgrade from Settings'
                  : 'Not yet available'}
            </button>
          </div>
        </div>

        <p className="mt-10 text-xs text-zinc-600">
          {stripeEnabled === false
            ? 'Billing is not configured in this environment, so all features remain free.'
            : 'Manage your plan from workspace Settings once signed in.'}
        </p>
      </section>

      <footer className="border-t border-zinc-800 py-10 text-center text-sm text-zinc-600">
        <p className="font-semibold text-zinc-500">AchReturnRiskLedger</p>
      </footer>
    </main>
  )
}
