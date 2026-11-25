# Loop GM server

## Trading Desk

For any Trading Desk work, read docs/trading-desk-plan.md first and follow its HARD RULES.

## Working agreement (owner's instructions, 2026-11-15)

The owner works only from a phone. Keep their manual steps to a minimum.

- **Pull requests.** Open a PR for finished work and merge it yourself once the full test suite
  passes (`npm test`, including the database tests with `TEST_TRADING_DATABASE_URL` set to a
  local Postgres). **Exception — ask the owner before merging** any change that touches order
  execution, approvals, or the kill switch (`TRADING_ENABLED`).
- **Database migrations** run automatically at server startup (`db.migrateAll`). Never ask the
  owner to open a migrate URL. Add a new numbered file under `trading/db/migrations/`; never
  edit one that has been applied.
- **Only ask the owner for things that need their accounts:** API keys, billing, spend limits,
  hosting settings.
- **Telegram** is the owner's interface for the Trading Desk: a summary after every agent run,
  `/trade_run` and `/trade_status`, and position alerts. Messages are built by plain code,
  never by a Claude call. Keep the status pages for details.
- **Stage 5–6 code** (`trading/risk/`, `trading/approvals.js`, `trading/execution/`, and the
  close proposals in `trading/positions.js`) is the
  order-execution, approval and kill-switch code the exception above is about.
- **Console (Stage 7):** the Trading Desk tab shows `/trading-desk` (`trading/desk/`); its Approve /
  Reject goes through `approvals.decideFromDashboard`, so it counts as approvals code. See
  docs/trading-desk-console.md.
- **Stage 8 (end-to-end run):** `/trade_e2e` checklist (`trading/e2e.js`, read-only), runbook
  docs/trading-desk-e2e.md, operator README trading/README.md. Quiet hours can be set from
  Telegram (`/trade_quiet`, desk_state `quiet_hours`) and are approvals code.
- **Revisit watches (2026-11-17):** an analyst's `revisit` trigger becomes a row in `trading.watches`;
  `trading/watches.js` (plain code, no trading imports) checks it and starts a re-analysis within the
  schedule switch, budget and 3/day cap. See docs/trading-desk-agents.md.
- **Trading style (2026-11-16):** short-term swing trades, held 1 to 14 days (`trading/policy.js`).
- **Allowlist editing (2026-11-25):** the desk's Settings can add/remove allowlist symbols in an admin session
  (`TRADING_ADMIN_PASSWORD`, `trading/admin.js`); each add is verified on eToro first; every change is audited.
  The database is the allowlists' source of truth — `trading/allowlist.js` only seeds an empty database. The
  lists feed the risk engine's `allowlisted` check, so ask the owner before merging changes to this code.
  See docs/trading-desk-console.md.
