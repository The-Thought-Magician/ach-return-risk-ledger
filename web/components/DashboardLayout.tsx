'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth/client'

type NavItem = { label: string; href: string }
type NavSection = { title: string; items: NavItem[] }

const NAV: NavSection[] = [
  {
    title: 'Overview',
    items: [{ label: 'Dashboard', href: '/dashboard' }],
  },
  {
    title: 'Monitoring',
    items: [
      { label: 'Threshold Monitor', href: '/dashboard/rates' },
      { label: 'Breach Forecasts', href: '/dashboard/forecasts' },
      { label: 'Scorecards', href: '/dashboard/scorecards' },
      { label: 'Dispute Windows', href: '/dashboard/dispute-windows' },
    ],
  },
  {
    title: 'Ledgers',
    items: [
      { label: 'Originators', href: '/dashboard/originators' },
      { label: 'Originated Entries', href: '/dashboard/entries' },
      { label: 'Returns', href: '/dashboard/returns' },
      { label: 'Return Codes', href: '/dashboard/return-codes' },
    ],
  },
  {
    title: 'Economics',
    items: [
      { label: 'Fees', href: '/dashboard/fees' },
      { label: 'Re-presentments', href: '/dashboard/representments' },
    ],
  },
  {
    title: 'Compliance Workflow',
    items: [
      { label: 'Alerts', href: '/dashboard/alerts' },
      { label: 'Alert Rules', href: '/dashboard/alert-rules' },
      { label: 'Warning Letters', href: '/dashboard/letters' },
      { label: 'Remediation Cases', href: '/dashboard/cases' },
    ],
  },
  {
    title: 'Insights',
    items: [
      { label: 'Analytics', href: '/dashboard/analytics' },
      { label: 'Benchmarks', href: '/dashboard/benchmarks' },
      { label: 'Reports', href: '/dashboard/reports' },
    ],
  },
  {
    title: 'Admin',
    items: [
      { label: 'Thresholds', href: '/dashboard/thresholds' },
      { label: 'Imports', href: '/dashboard/imports' },
      { label: 'Audit Log', href: '/dashboard/audit' },
      { label: 'Settings', href: '/dashboard/settings' },
    ],
  },
]

function isActive(pathname: string, href: string) {
  if (href === '/dashboard') return pathname === '/dashboard'
  return pathname === href || pathname.startsWith(href + '/')
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(true)
  const [workspace, setWorkspace] = useState<string>('Workspace')

  useEffect(() => {
    let mounted = true
    authClient.getSession().then((s: any) => {
      if (!mounted) return
      const user = s?.data?.user ?? s?.user
      if (!user) {
        router.push('/auth/sign-in')
        return
      }
      setWorkspace(user.name || user.email || 'Workspace')
      setChecking(false)
    })
    return () => {
      mounted = false
    }
  }, [router])

  // Close mobile drawer on navigation.
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  const signOut = async () => {
    await authClient.signOut()
    router.push('/')
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950">
        <div className="flex items-center gap-3 text-slate-400">
          <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-emerald-400" />
          <span className="text-sm">Loading workspace...</span>
        </div>
      </div>
    )
  }

  const sidebar = (
    <nav className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-5 py-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-300">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3v18h18" />
            <path d="m7 14 4-4 3 3 5-6" />
          </svg>
        </span>
        <span className="text-sm font-bold tracking-tight text-white">AchReturnRiskLedger</span>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-3 pb-6">
        {NAV.map((section) => (
          <div key={section.title}>
            <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
              {section.title}
            </div>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const active = isActive(pathname, item.href)
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`block rounded-lg px-3 py-2 text-sm transition-colors ${
                      active
                        ? 'bg-emerald-500/10 font-medium text-emerald-300'
                        : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100'
                    }`}
                  >
                    {item.label}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </nav>
  )

  return (
    <div className="flex min-h-screen bg-slate-950">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-slate-800 bg-slate-900/40 lg:block">
        <div className="sticky top-0 h-screen">{sidebar}</div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-950/70" onClick={() => setOpen(false)} aria-hidden />
          <aside className="absolute left-0 top-0 h-full w-64 border-r border-slate-800 bg-slate-900">
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-800 bg-slate-950/80 px-4 py-3 backdrop-blur lg:px-6">
          <div className="flex items-center gap-3">
            <button
              className="rounded-md p-2 text-slate-400 hover:bg-slate-800 hover:text-white lg:hidden"
              onClick={() => setOpen(true)}
              aria-label="Open navigation"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <span className="text-sm font-medium text-slate-300">Compliance Workspace</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden max-w-[180px] truncate text-sm text-slate-400 sm:block">{workspace}</span>
            <button
              onClick={signOut}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700"
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="min-w-0 flex-1 px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  )
}
