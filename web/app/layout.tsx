import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'AchReturnRiskLedger',
  description: 'Continuous NACHA return-rate monitoring, breach forecasting, and compliance audit trail for ACH originators.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100 min-h-screen antialiased">{children}</body>
    </html>
  )
}
