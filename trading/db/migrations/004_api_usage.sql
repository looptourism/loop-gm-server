-- ===========================================================================
-- Trading Desk — migration 004: the Claude API usage ledger.
-- Runs inside one transaction, like every migration.
--
-- One row per Claude request made by a Trading Desk agent: what it was for,
-- which model answered, the tokens, and the cost estimated at list price.
-- The monthly budget in code is checked against the sum of this table, so
-- the table is append-only: a row can never be changed or removed.
-- ===========================================================================
create table trading.api_usage (
  id                  uuid primary key default gen_random_uuid(),
  occurred_at         timestamptz not null,
  purpose             text not null check (purpose in ('screen', 'stock', 'crypto', 'risk', 'portfolio_manager')),
  model               text not null,
  input_tokens        integer not null check (input_tokens >= 0),
  output_tokens       integer not null check (output_tokens >= 0),
  estimated_cost_usd  numeric(12,6) not null check (estimated_cost_usd >= 0),
  instrument_id       bigint references trading.instruments (instrument_id),
  created_at          timestamptz not null default now()
);
create index api_usage_by_time on trading.api_usage (occurred_at);
create trigger api_usage_append_only before update or delete on trading.api_usage
  for each row execute function trading.forbid_change();
create trigger api_usage_no_truncate before truncate on trading.api_usage
  for each statement execute function trading.forbid_change();

alter table trading.api_usage enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on trading.api_usage from %I', r);
    end if;
  end loop;
end $$;
