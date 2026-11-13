# Trading Desk — database (Stage 2)

A **separate Supabase project used only by the Trading Desk**. The rest of the server keeps
its own storage (Upstash) and never sees this database: the connection string is read only in
`trading/config.js`, from `TRADING_DATABASE_URL`.

**Status (2026-11-13):** schema written and tested against a local Postgres 16 (28 tests pass).
Connection from Render to the Supabase project confirmed by a real call at 07:17 UTC: session
pooler, TLS verified against the bundled root CA, Postgres 17.11.
**Migrated:** `001_initial` applied on Supabase at 07:35 UTC by the owner; all 12 tables exist.

## The schema

One file: `trading/db/migrations/001_initial.sql`. Everything is in a Postgres schema named
`trading` (not `public`, which is the only schema Supabase's Data API exposes), with Row Level
Security on and access revoked from Supabase's `anon` / `authenticated` roles.

| Table | What it holds | Rules the database itself enforces |
|---|---|---|
| `instruments` | What eToro returned for an instrument (ID, symbol, name, asset class, exchange, raw answer, source, time) | asset class is `stock` or `crypto` only |
| `stock_allowlist` | The owner's stock list; `crypto_correlated` flag (set for MSTR) | can only link to a `stock` instrument; unverified rows have no instrument |
| `crypto_allowlist` | The owner's coin list | can only link to a `crypto` instrument |
| `market_snapshots` | Timestamped rates and candles (Stage 3) | a rate needs bid+ask, a candle needs O/H/L/C; source + fetched time required |
| `analyses` | Each agent's structured JSON (Stage 4) | append-only |
| `proposals` | Suggested trades, open and close | buy only, leverage 1, amount > 0, parameters frozen after insert, one live proposal per instrument / per position, unique idempotency key |
| `risk_assessments` | The code engine's verdict with every check (Stage 5) | append-only |
| `approvals` | One request per proposal, bound to the parameter hash | at most 15 minutes, decided once, no decision after expiry, used once |
| `orders` | What was sent to eToro DEMO and what came back | `environment = 'demo'` only; needs an approved, unexpired, consumed approval with the same hash; one order per approval and per proposal; request cannot be edited |
| `positions` | Demo positions synced from eToro | demo, buy, leverage 1 |
| `audit_log` | Permanent record of every event | insert only — UPDATE, DELETE and TRUNCATE raise an error |
| `schema_migrations` | Which migration files were applied | — |

Every table has a UUID `id` and UTC timestamps. Multi-row changes go through
`db.withTransaction` (all or nothing); a migration file is applied in one transaction.

Not in the schema on purpose: the policy limits ($500 per trade, $5,000 exposure, …). Those
belong to the Stage 5 config file; each risk assessment stores the limits it used.

## Setup — Supabase (phone-friendly)

1. Open **supabase.com** → sign in → **New project**.
2. Name: `loop-trading-desk`. Do not reuse an existing project.
3. **Database password**: tap *Generate a password*, then copy it into your password manager.
   If you type your own, use only letters and digits (symbols must be percent-encoded in the URL).
4. Region: the one closest to the Render service's region (Render → `loop-gm-server-1` → Settings → Region).
5. Create the project and wait until it is ready.
6. Tap **Connect** at the top of the project page → choose **Session pooler** → copy the URI. It looks like
   `postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-<n>-<region>.pooler.supabase.com:5432/postgres`.
   (Not "Direct connection": that one is IPv6-only and Render cannot reach it.)
7. Replace `[YOUR-PASSWORD]` with the password from step 3.
8. Do **not** add `trading` under Settings → API → "Exposed schemas". Nothing else to configure:
   no tables are created by hand, and no Supabase API key is used by the server.

## Setup — Render

1. Render dashboard → **loop-gm-server-1** → **Environment** → **Add Environment Variable**.
2. Key: `TRADING_DATABASE_URL` — Value: the full string from step 7 above.
3. **Save, rebuild, and deploy**. Leave `TRADING_ENABLED` as it is (`false`).

## Migrating (only after the schema is approved)

Log in to the console, then open in the same browser:

1. `/api/trading/admin/db-status` — expect `"connected": true` and `"pending": ["001_initial"]`. Nothing is created by this.
2. `/api/trading/admin/migrate?confirm=001_initial` — creates the tables. Without the exact name it refuses.
3. `/api/trading/admin/db-status` again — expect 12 tables and `"pending": []`.

Then the allowlists:

4. `/api/trading/test/verify-allowlist` — searches eToro for all 31 symbols; saves nothing.
5. `/api/trading/admin/sync-allowlist?confirm=yes` — repeats the search and stores the result.
   Only symbols with exactly one exact match of the right asset class become tradable.
6. `/api/trading/admin/allowlist` — the lists as stored.

To change the lists later: edit `trading/allowlist.js`, deploy, run step 5 again (a symbol removed
from the file is switched to inactive, never deleted).

## Proposal — knowing whether a market is open (for Stage 5, not implemented)

Problem: eToro's search does not return `isOpen`, and a rate marked `realtime` was served with
the US market closed. So "is the market open" needs its own answer. Proposed: two independent
checks that must BOTH pass before a stock order is sent.

1. **Official calendar (plain code).** A data file per exchange, keyed by the exchange eToro
   reports for the instrument (`instruments.exchange`):
   - regular session only — for NYSE and Nasdaq 09:30–16:00 `America/New_York`, Monday–Friday,
     computed with the IANA time zone so daylight saving is handled;
   - that year's full-day holidays and early closes (13:00), copied from the exchange's own
     published calendar, with the source URL and the date it was copied;
   - no pre-market, after-hours or eToro's extended-hours trading.
2. **Live cross-check.** The rate's own `date` (parsed as UTC) must be no older than a set
   number of seconds, and `quoteType` must be `realtime`. This catches what no calendar can:
   trading halts and unscheduled closures.

Fail closed: unknown exchange, no calendar for the current year, or the two checks disagreeing
→ no order. From 1 December a Telegram reminder is sent if next year's calendar is missing.
Crypto has no calendar (24/7), so only check 2 applies to it.

Open points: holiday dates will be copied from the official exchange pages in Stage 5 (they
were not reachable from this session, and none are written from memory). The real answer of
`/api/v2/market-data/instruments` (2026-11-13) carries no trading-hours fields, so eToro offers
no third check; the two above are the whole design.

## Allowlists as stored (synced 2026-11-13 07:38 UTC, from real eToro searches)

Instrument IDs and names are eToro's. 21 stocks and 9 coins are tradable; OPTT is listed but
has no eToro match, so it is not tradable. Every stock is on Nasdaq or NYSE, so the
market-hours calendar needs only those two exchanges.

| Symbol | eToro ID | eToro name | Exchange |
|---|---|---|---|
| ADBE | 1126 | Adobe Systems Inc | Nasdaq |
| AMPX | 10722 | Amprius Technologies Inc | NYSE |
| BABA | 1155 | Alibaba-ADR | NYSE |
| ENPH | 5634 | Enphase Energy Inc. | Nasdaq |
| GRAB | 9250 | Grab Holdings Ltd | Nasdaq |
| GRRR | 14379 | Gorilla Technology Group Inc | Nasdaq |
| HIMS | 9518 | Hims & Hers Health Inc | NYSE |
| INOD | 9840 | Innodata Inc | Nasdaq |
| INTU | 1914 | Intuit Inc | Nasdaq |
| MRAM | 11043 | Everspin Technologies Inc | Nasdaq |
| MSTR (crypto_correlated) | 6473 | Strategy Inc | Nasdaq |
| NEM | 1757 | Newmont Mining Corp | NYSE |
| NKE | 1042 | NIKE | NYSE |
| NVO | 6844 | Novo-Nordisk A/S SPONS ADR | NYSE |
| OPTT | — | no exact match on eToro | — |
| ORCL | 1135 | Oracle Corporation | NYSE |
| PLAB | 9642 | Photronics Inc | Nasdaq |
| SE | 5960 | Sea Ltd-ADR | NYSE |
| TMDX | 9456 | TransMedics Group Inc | Nasdaq |
| TTD | 4399 | Trade Desk Inc | Nasdaq |
| VISN | 4206 | Vistance Networks Inc | Nasdaq |
| WYFI | 14382 | WhiteFiber Inc | Nasdaq |

Crypto (exchange "Digital Currency"): ADA 100017, ATOM 100047, BTC 100000, DOGE 100043,
ETH 100001, FET 100079, SOL 100063, SUI 100340, XRP 100003.
