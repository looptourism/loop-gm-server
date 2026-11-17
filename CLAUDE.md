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
- **Trading style (2026-11-16):** short-term swing trades, held 1 to 14 days (`trading/policy.js`).
