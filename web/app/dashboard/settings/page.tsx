'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { authClient } from '@/lib/auth/client'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge, statusTone } from '@/components/ui/Badge'
import { Stat } from '@/components/ui/Stat'
import { PageSpinner } from '@/components/ui/Spinner'

interface Plan {
  id: string
  name: string
  price_cents: number
}

interface Subscription {
  id?: string
  user_id?: string
  plan_id?: string
  stripe_customer_id?: string | null
  stripe_subscription_id?: string | null
  status?: string | null
  current_period_end?: string | null
  created_at?: string
  updated_at?: string
}

interface BillingPlan {
  subscription?: Subscription | null
  plan?: Plan | null
  stripeEnabled?: boolean
}

interface SessionUser {
  id?: string
  email?: string | null
  name?: string | null
}

function fmtPrice(cents?: number) {
  if (cents == null) return '—'
  if (cents === 0) return 'Free'
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}/mo`
}

function fmtDate(d?: string | null) {
  if (!d) return '—'
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return d
  return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

const PLAN_FEATURES: Record<string, string[]> = {
  free: [
    'Up to 10 originators',
    'Daily rate recomputation',
    'NACHA threshold monitoring',
    'Single workspace',
  ],
  pro: [
    'Unlimited originators',
    'Real-time breach forecasting',
    'Re-presentment & recovery tracking',
    'Scheduled compliance reports',
    'Priority alert evaluation',
  ],
}

export default function SettingsPage() {
  const [billing, setBilling] = useState<BillingPlan | null>(null)
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [actionPending, setActionPending] = useState<null | 'checkout' | 'portal'>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [plan, session] = await Promise.all([
        api.getBillingPlan(),
        authClient.getSession().catch(() => null),
      ])
      setBilling(plan && typeof plan === 'object' ? plan : {})
      const u =
        (session && (session as { user?: SessionUser; data?: { user?: SessionUser } }).user) ||
        (session && (session as { data?: { user?: SessionUser } }).data?.user) ||
        null
      setUser(u)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load workspace settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const planId = billing?.plan?.id ?? billing?.subscription?.plan_id ?? 'free'
  const isPro = planId === 'pro'
  const stripeEnabled = billing?.stripeEnabled ?? false
  const sub = billing?.subscription ?? null

  const subStatusTone = useMemo(() => statusTone(sub?.status ?? 'active'), [sub?.status])

  async function startCheckout() {
    setActionPending('checkout')
    setActionError(null)
    setNotice(null)
    try {
      const res = await api.createCheckout()
      const url = res && (res as { url?: string }).url
      if (url) {
        window.location.href = url
      } else {
        setActionError('Checkout session did not return a URL.')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Checkout failed'
      setActionError(
        /503|not configured|unconfigured|stripe/i.test(msg)
          ? 'Billing is not configured for this deployment. Set Stripe keys on the backend to enable upgrades.'
          : msg,
      )
    } finally {
      setActionPending(null)
    }
  }

  async function openPortal() {
    setActionPending('portal')
    setActionError(null)
    setNotice(null)
    try {
      const res = await api.createPortal()
      const url = res && (res as { url?: string }).url
      if (url) {
        window.location.href = url
      } else {
        setActionError('Billing portal did not return a URL.')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not open billing portal'
      setActionError(
        /503|not configured|unconfigured|stripe/i.test(msg)
          ? 'Billing is not configured for this deployment.'
          : msg,
      )
    } finally {
      setActionPending(null)
    }
  }

  async function signOut() {
    try {
      await authClient.signOut()
    } catch {
      /* ignore */
    } finally {
      window.location.href = '/auth/sign-in'
    }
  }

  if (loading) return <PageSpinner label="Loading settings…" />

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-xl font-semibold text-white">Settings</h1>
        <Card>
          <CardBody className="text-center text-sm text-red-300">
            {error}
            <div className="mt-3">
              <Button variant="secondary" onClick={load}>
                Retry
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white">Workspace Settings</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Manage your workspace identity, subscription plan and billing.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Stat label="Current plan" value={billing?.plan?.name ?? (isPro ? 'Pro' : 'Free')} tone={isPro ? 'emerald' : 'default'} />
        <Stat label="Monthly price" value={fmtPrice(billing?.plan?.price_cents ?? (isPro ? undefined : 0))} />
        <Stat
          label="Billing status"
          value={sub?.status ?? (isPro ? 'active' : 'no subscription')}
          tone={stripeEnabled ? 'sky' : 'default'}
        />
      </div>

      {/* Workspace identity */}
      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold text-white">Workspace</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Account email">
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-sm text-zinc-200">
                {user?.email ?? '—'}
              </div>
            </Field>
            <Field label="Display name">
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-sm text-zinc-200">
                {user?.name ?? '—'}
              </div>
            </Field>
            <Field label="Workspace ID">
              <div className="truncate rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 font-mono text-xs text-zinc-400">
                {user?.id ?? sub?.user_id ?? '—'}
              </div>
            </Field>
            <Field label="Session">
              <div className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-sm text-zinc-200">
                <span>Signed in</span>
                <button onClick={signOut} className="text-xs text-red-400 hover:text-red-300">
                  Sign out
                </button>
              </div>
            </Field>
          </div>
        </CardBody>
      </Card>

      {/* Billing */}
      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Billing &amp; subscription</h2>
          {!stripeEnabled && <Badge tone="neutral">Stripe not configured</Badge>}
        </CardHeader>
        <CardBody className="space-y-6">
          {actionError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {actionError}
            </div>
          )}
          {notice && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
              {notice}
            </div>
          )}

          {sub && (sub.status || sub.current_period_end || sub.stripe_subscription_id) && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 sm:grid-cols-4">
              <Detail
                label="Status"
                value={<Badge tone={subStatusTone}>{sub.status ?? 'unknown'}</Badge>}
              />
              <Detail label="Renews / ends" value={fmtDate(sub.current_period_end)} />
              <Detail label="Started" value={fmtDate(sub.created_at)} />
              <Detail
                label="Stripe sub"
                value={
                  sub.stripe_subscription_id ? (
                    <span className="font-mono text-xs">{sub.stripe_subscription_id}</span>
                  ) : (
                    '—'
                  )
                }
              />
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <PlanCard
              name="Free"
              price="$0/mo"
              features={PLAN_FEATURES.free}
              current={!isPro}
            />
            <PlanCard
              name="Pro"
              price={fmtPrice(billing?.plan?.price_cents && isPro ? billing.plan.price_cents : 4900)}
              features={PLAN_FEATURES.pro}
              current={isPro}
              highlight
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-4">
            {!isPro ? (
              <Button onClick={startCheckout} disabled={actionPending !== null}>
                {actionPending === 'checkout' ? 'Redirecting…' : 'Upgrade to Pro'}
              </Button>
            ) : (
              <Button variant="secondary" onClick={openPortal} disabled={actionPending !== null}>
                {actionPending === 'portal' ? 'Opening…' : 'Manage subscription'}
              </Button>
            )}
            {isPro && (
              <span className="text-xs text-zinc-500">
                Update payment method, view invoices or cancel from the Stripe billing portal.
              </span>
            )}
            {!stripeEnabled && (
              <span className="text-xs text-zinc-500">
                Billing actions are disabled until Stripe is configured on the backend.
              </span>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

function PlanCard({
  name,
  price,
  features,
  current,
  highlight,
}: {
  name: string
  price: string
  features: string[]
  current: boolean
  highlight?: boolean
}) {
  return (
    <div
      className={`rounded-xl border p-5 ${
        highlight ? 'border-amber-500/40 bg-amber-500/5' : 'border-zinc-800 bg-zinc-950/40'
      }`}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">{name}</h3>
        {current && <Badge tone="clear">Current plan</Badge>}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-white">{price}</div>
      <ul className="mt-4 space-y-2">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-sm text-zinc-300">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className="mt-0.5 shrink-0 text-amber-400"
              aria-hidden
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
            <span>{f}</span>
          </li>
        ))}
      </ul>
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

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-0.5 text-zinc-200">{value}</div>
    </div>
  )
}
