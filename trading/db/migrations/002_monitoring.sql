-- ===========================================================================
-- Trading Desk — migration 002: Market Monitoring (Stage 3).
-- Runs inside one transaction, like every migration.
--
--   1. One row per real observation. The job asks eToro again and again; a
--      rate eToro has not changed (same instrument, same eToro timestamp) or
--      a candle that is already stored must not be stored twice.
--   2. revised_at — set when eToro later changed a finished candle and the
--      stored row was corrected (the old values go to the audit log).
--   3. monitor_runs — one row per collection run: what was asked, what was
--      stored, what went wrong. This is how "when was the market last
--      checked" is answered even when no price changed.
-- ===========================================================================

create unique index market_snapshots_one_rate
  on trading.market_snapshots (instrument_id, as_of) where kind = 'rate';
create unique index market_snapshots_one_candle
  on trading.market_snapshots (instrument_id, candle_interval, as_of) where kind = 'candle';

alter table trading.market_snapshots add column revised_at timestamptz;

create table trading.monitor_runs (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('rates', 'candles')),
  candle_interval  text,
  trigger          text not null check (trigger in ('schedule', 'manual')),
  status           text not null check (status in ('ok', 'partial', 'failed')),
  started_at       timestamptz not null,
  finished_at      timestamptz not null,
  instruments      integer not null,                  -- how many allowlisted instruments were due
  requests         integer not null,                  -- calls sent to eToro in this run
  rows_inserted    integer not null default 0,
  rows_unchanged   integer not null default 0,        -- already stored (eToro had nothing newer)
  rows_revised     integer not null default 0,
  problems         jsonb   not null default '[]',     -- [{ symbol, instrumentId, problem }]
  created_at       timestamptz not null default now(),
  check ((kind = 'candles') = (candle_interval is not null)),
  check (finished_at >= started_at)
);
create index monitor_runs_latest on trading.monitor_runs (kind, candle_interval, started_at desc);

alter table trading.monitor_runs enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on trading.monitor_runs from %I', r);
    end if;
  end loop;
end $$;
