// All calls are same-origin relative fetches to /api/proxy/<path>, mapping 1:1
// to the backend /api/v1/<path>. The proxy route injects X-User-Id.

async function j(res: Response) {
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `Request failed (${res.status})`
    throw new Error(msg)
  }
  return data
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

function get(path: string) {
  return fetch(`/api/proxy/${path}`).then(j)
}
function post(path: string, body?: unknown) {
  return fetch(`/api/proxy/${path}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(j)
}
function put(path: string, body?: unknown) {
  return fetch(`/api/proxy/${path}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(j)
}
function del(path: string) {
  return fetch(`/api/proxy/${path}`, { method: 'DELETE' }).then(j)
}

function qs(params?: Record<string, unknown>) {
  if (!params) return ''
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

const api = {
  // Originators
  getOriginators: (status?: string) => get(`originators${qs({ status })}`),
  getOriginator: (id: string) => get(`originators/${id}`),
  getOriginatorProfile: (id: string) => get(`originators/${id}/profile`),
  createOriginator: (body: unknown) => post('originators', body),
  updateOriginator: (id: string, body: unknown) => put(`originators/${id}`, body),
  deleteOriginator: (id: string) => del(`originators/${id}`),
  bulkCreateOriginators: (rows: unknown) => post('originators/bulk', { rows }),

  // Originated entries
  getEntries: (params?: Record<string, unknown>) => get(`entries${qs(params)}`),
  getEntry: (id: string) => get(`entries/${id}`),
  createEntry: (body: unknown) => post('entries', body),
  updateEntry: (id: string, body: unknown) => put(`entries/${id}`, body),
  deleteEntry: (id: string) => del(`entries/${id}`),

  // Returns
  getReturns: (params?: Record<string, unknown>) => get(`returns${qs(params)}`),
  getUnmatchedReturns: () => get('returns/unmatched'),
  getReturn: (id: string) => get(`returns/${id}`),
  createReturn: (body: unknown) => post('returns', body),
  updateReturn: (id: string, body: unknown) => put(`returns/${id}`, body),
  matchReturn: (id: string, entryId: string) =>
    post(`returns/${id}/match`, { originated_entry_id: entryId }),
  deleteReturn: (id: string) => del(`returns/${id}`),

  // Return codes
  getReturnCodes: () => get('return-codes'),
  getReturnCode: (code: string) => get(`return-codes/${code}`),
  reclassifyReturnCode: (code: string, category: string) =>
    put(`return-codes/${code}/reclassify`, { category }),

  // Rates
  getRates: () => get('rates'),
  getPortfolioRate: () => get('rates/portfolio'),
  getOriginatorRates: (id: string) => get(`rates/originator/${id}`),
  recomputeRates: () => post('rates/recompute'),

  // Thresholds
  getThresholds: () => get('thresholds'),
  getThresholdHistory: () => get('thresholds/history'),
  updateThresholds: (body: unknown) => put('thresholds', body),

  // Forecasts
  getForecasts: () => get('forecasts'),
  getDaysToBreach: () => get('forecasts/days-to-breach'),
  recomputeForecasts: () => post('forecasts/recompute'),
  forecastWhatIf: (body: unknown) => post('forecasts/what-if', body),

  // Scorecards
  getScorecards: () => get('scorecards'),
  getScorecard: (originatorId: string) => get(`scorecards/${originatorId}`),
  recomputeScorecards: () => post('scorecards/recompute'),

  // Fees
  getFees: (params?: Record<string, unknown>) => get(`fees${qs(params)}`),
  getFeeSummary: () => get('fees/summary'),
  createFee: (body: unknown) => post('fees', body),
  deleteFee: (id: string) => del(`fees/${id}`),

  // Representments
  getRepresentments: (params?: Record<string, unknown>) => get(`representments${qs(params)}`),
  getRecovery: () => get('representments/recovery'),
  createRepresentment: (body: unknown) => post('representments', body),
  updateRepresentment: (id: string, body: unknown) => put(`representments/${id}`, body),

  // Dispute windows
  getDisputeWindows: (status?: string) => get(`dispute-windows${qs({ status })}`),
  getDisputeExposure: () => get('dispute-windows/exposure'),
  getExpiringWindows: (days: number) => get(`dispute-windows/expiring${qs({ days })}`),
  rebuildDisputeWindows: () => post('dispute-windows/rebuild'),

  // Alert rules
  getAlertRules: () => get('alert-rules'),
  getAlertRule: (id: string) => get(`alert-rules/${id}`),
  createAlertRule: (body: unknown) => post('alert-rules', body),
  updateAlertRule: (id: string, body: unknown) => put(`alert-rules/${id}`, body),
  deleteAlertRule: (id: string) => del(`alert-rules/${id}`),

  // Alerts
  getAlerts: (params?: Record<string, unknown>) => get(`alerts${qs(params)}`),
  getAlert: (id: string) => get(`alerts/${id}`),
  evaluateAlerts: () => post('alerts/evaluate'),
  acknowledgeAlert: (id: string) => post(`alerts/${id}/acknowledge`),
  snoozeAlert: (id: string, until: string) => post(`alerts/${id}/snooze`, { until }),
  readAlert: (id: string) => post(`alerts/${id}/read`),

  // Letters
  getLetters: (params?: Record<string, unknown>) => get(`letters${qs(params)}`),
  getLetter: (id: string) => get(`letters/${id}`),
  createLetter: (body: unknown) => post('letters', body),
  updateLetter: (id: string, body: unknown) => put(`letters/${id}`, body),
  deleteLetter: (id: string) => del(`letters/${id}`),

  // Cases
  getCases: (params?: Record<string, unknown>) => get(`cases${qs(params)}`),
  getCase: (id: string) => get(`cases/${id}`),
  createCase: (body: unknown) => post('cases', body),
  updateCase: (id: string, body: unknown) => put(`cases/${id}`, body),
  addCaseAction: (id: string, body: unknown) => post(`cases/${id}/actions`, body),
  updateCaseAction: (id: string, actionId: string, body: unknown) =>
    put(`cases/${id}/actions/${actionId}`, body),

  // Imports
  getImports: () => get('imports'),
  importCsv: (body: unknown) => post('imports/csv', body),
  importNacha: (body: unknown) => post('imports/nacha', body),
  seedSample: () => post('imports/sample'),

  // Reports
  getReports: () => get('reports'),
  getReport: (id: string) => get(`reports/${id}`),
  generateReport: (body: unknown) => post('reports/generate', body),
  deleteReport: (id: string) => del(`reports/${id}`),

  // Benchmarks
  getBenchmarks: () => get('benchmarks'),
  recomputeBenchmarks: () => post('benchmarks/recompute'),

  // Analytics
  getTrends: (originatorId?: string) =>
    get(`analytics/trends${qs({ originator_id: originatorId })}`),
  getCodeDistribution: () => get('analytics/code-distribution'),
  getCohorts: () => get('analytics/cohorts'),
  getVolumeCorrelation: () => get('analytics/volume-correlation'),

  // Views
  getViews: (scope?: string) => get(`views${qs({ scope })}`),
  createView: (body: unknown) => post('views', body),
  deleteView: (id: string) => del(`views/${id}`),

  // Audit
  getAudit: (params?: Record<string, unknown>) => get(`audit${qs(params)}`),

  // Dashboard
  getDashboardSummary: () => get('dashboard/summary'),

  // Billing
  getBillingPlan: () => get('billing/plan'),
  createCheckout: () => post('billing/checkout'),
  createPortal: () => post('billing/portal'),
}

export default api
