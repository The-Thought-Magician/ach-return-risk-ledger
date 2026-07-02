'use client'
import { useState, useEffect, useRef } from 'react'
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

function sectionActive(pathname: string, section: NavSection) {
  return section.items.some((item) => isActive(pathname, item.href))
}

function NavDropdown({ section, pathname }: { section: NavSection; pathname: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = sectionActive(pathname, section)

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  if (section.items.length === 1) {
    const item = section.items[0]
    const itemActive = isActive(pathname, item.href)
    return (
      <Link
        href={item.href}
        className={`whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors ${
          itemActive ? 'bg-amber-500/10 text-amber-300' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100'
        }`}
      >
        {section.title}
      </Link>
    )
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors ${
          active ? 'bg-amber-500/10 text-amber-300' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100'
        }`}
      >
        {section.title}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-56 rounded-lg border border-zinc-800 bg-zinc-900 p-1.5 shadow-xl">
          {section.items.map((item) => {
            const itemActive = isActive(pathname, item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                  itemActive
                    ? 'bg-amber-500/10 font-medium text-amber-300'
                    : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100'
                }`}
              >
                {item.label}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
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

  // Close mobile nav on navigation.
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  const signOut = async () => {
    await authClient.signOut()
    router.push('/')
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950">
        <div className="flex items-center gap-3 text-zinc-400">
          <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-amber-400" />
          <span className="text-sm">Loading workspace...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen w-full flex-col bg-zinc-950">
      <header className="sticky top-0 z-30 w-full border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
        <div className="flex items-center justify-between gap-4 px-4 py-3 lg:px-8">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 3v18h18" />
                <path d="m7 14 4-4 3 3 5-6" />
              </svg>
            </span>
            <span className="font-black tracking-tight text-white">AchReturnRiskLedger</span>
          </div>

          <nav className="hidden flex-1 items-center gap-1 overflow-x-auto px-4 lg:flex">
            {NAV.map((section) => (
              <NavDropdown key={section.title} section={section} pathname={pathname} />
            ))}
          </nav>

          <div className="flex items-center gap-3">
            <span className="hidden max-w-[160px] truncate text-sm text-zinc-400 sm:block">{workspace}</span>
            <button
              onClick={signOut}
              className="hidden rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700 lg:block"
            >
              Sign out
            </button>
            <button
              className="rounded-md p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white lg:hidden"
              onClick={() => setMobileOpen((o) => !o)}
              aria-label="Toggle navigation"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile nav */}
        {mobileOpen && (
          <div className="border-t border-zinc-800 px-4 py-3 lg:hidden">
            <div className="space-y-4">
              {NAV.map((section) => (
                <div key={section.title}>
                  <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
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
                              ? 'bg-amber-500/10 font-medium text-amber-300'
                              : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100'
                          }`}
                        >
                          {item.label}
                        </Link>
                      )
                    })}
                  </div>
                </div>
              ))}
              <button
                onClick={signOut}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
              >
                Sign out
              </button>
            </div>
          </div>
        )}
      </header>

      <main className="w-full flex-1 px-4 py-6 lg:px-8">{children}</main>
    </div>
  )
}
