-- ===========================================================================
-- Trading Desk — migration 006: what the risk engine and the execution
-- gateway need (Stage 5). Runs inside one transaction.
--
--   1. account_snapshots — the demo account's figures at each 15-minute
--      position check. The daily loss limit is measured against the first
--      snapshot of the day; without one the limit cannot be checked and no
--      order is sent. Append-only.
--   2. desk_state — small switches that must survive a restart. Today: the
--      runtime stop (/trade_stop). It can only ever make the desk stricter:
--      trading needs TRADING_ENABLED = "true" AND not stopped here.
-- ===========================================================================
create table trading.account_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  taken_at            timestamptz not null,           -- when eToro was asked
  credit_usd          numeric(14,2) not null,
  invested_usd        numeric(14,2) not null,
  pending_orders_usd  numeric(14,2) not null,
  unrealized_pnl_usd  numeric(14,2) not null,
  equity_usd          numeric(14,2) not null,         -- eToro's formula: available cash + total invested + unrealized P/L
  open_positions      integer not null,
  source              text not null,
  created_at          timestamptz not null default now()
);
create index account_snapshots_by_time on trading.account_snapshots (taken_at desc);
create trigger account_snapshots_append_only before update or delete on trading.account_snapshots
  for each row execute function trading.forbid_change();

create table trading.desk_state (
  key         text primary key,
  value       jsonb not null,
  updated_by  text not null,
  updated_at  timestamptz not null default now()
);

alter table trading.account_snapshots enable row level security;
alter table trading.desk_state enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on trading.account_snapshots from %I', r);
      execute format('revoke all on trading.desk_state from %I', r);
    end if;
  end loop;
end $$;
