# ACH Return Risk Ledger

ACH Return Risk Ledger is a continuous NACHA-compliance monitoring platform that tracks ACH return rates and unauthorized-debit rates for every originator against NACHA's regulatory suspension thresholds, and forecasts which originators will breach.

NACHA enforces three hard return-rate thresholds: 0.5% for unauthorized-debit returns, 3.0% for administrative returns, and 15.0% overall returns. A breach triggers a NACHA inquiry, fines, and ultimately suspension of an originator's ability to send ACH debits. This platform computes the rates continuously over rolling 60-day windows, surfaces velocity-based forecasts of when a threshold will be crossed, and gives compliance teams a defensible audit trail.

See [`docs/idea.md`](docs/idea.md) for the full product specification.

## Features

- **NACHA Threshold Monitor** — per-originator unauthorized (0.5%), administrative (3.0%), and overall (15.0%) return rates over rolling windows, with headroom, status classification, portfolio roll-up, and snapshot history.
- **Return-Reason Classifier** — full NACHA return-code dictionary (R01-R85), automatic bucketing into unauthorized/administrative/other, per-code trends, reclassification overrides with audit, and drilldown.
- **Breach-Forecast Engine** — linear and exponentially-weighted velocity models, projected breach dates with confidence bands, days-to-breach ranking, what-if projections, and backtests.
- **Return-Fee and Re-Presentment Economics Ledger** — per-return fee accrual, re-presentment tracking, recovery rates, net economics per originator, and a cost-of-returns dashboard.
- **Originator Scorecard** — composite ACH risk score, letter grades (A-F), and a sortable, filterable scorecard table.

## Stack

- **Backend:** Node.js + TypeScript (tsx/ESM runtime), HTTP API. Runs on port 3001 locally, 10000 in production.
- **Frontend:** Next.js 15+, React 19+, TypeScript (strict), Tailwind 4, App Router. Located at `web/`.
- **Database:** PostgreSQL via `DATABASE_URL`.
- **Package manager:** pnpm everywhere.

## Local Development

Prerequisites: Node.js 22.x, pnpm, and a PostgreSQL database.

### Backend

```bash
cd backend
pnpm install
# create backend/.env with DATABASE_URL and PORT (see Environment Variables)
node --import tsx/esm src/index.ts
```

The backend listens on `http://localhost:3001`.

### Frontend

```bash
cd web
pnpm install
# create web/.env.local with NEXT_PUBLIC_API_URL=http://localhost:3001
pnpm dev
```

The web app runs on `http://localhost:3000`.

### Docker Compose

To bring backend and web up together:

```bash
docker compose up --build
```

## Environment Variables

### Backend (`backend/.env`)

| Variable       | Description                                  | Example                       |
| -------------- | -------------------------------------------- | ----------------------------- |
| `DATABASE_URL` | PostgreSQL connection string                 | `postgres://user:pass@host/db`|
| `PORT`         | Port the backend listens on                  | `3001` (local), `10000` (prod)|
| `NODE_ENV`     | Environment mode                             | `production`                  |
| `FRONTEND_URL` | Allowed frontend origin for CORS             | `https://your-app.vercel.app` |

### Frontend (`web/.env.local`)

| Variable              | Description                | Example                 |
| --------------------- | -------------------------- | ----------------------- |
| `NEXT_PUBLIC_API_URL` | Base URL of the backend API| `http://localhost:3001` |

## Access

All features are free for signed-in users. There are no paid tiers or feature gates; signing in unlocks the entire platform.
