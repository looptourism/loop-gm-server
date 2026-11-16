-- ===========================================================================
-- Trading Desk — migration 005: position monitoring.
-- Runs inside one transaction, like every migration.
--
--   1. position_alerts — one row per alert sent about a demo position. The
--      unique rule makes an alert fire ONCE per position and condition, no
--      matter how many 15-minute checks see the condition as true. Keyed by
--      eToro's position ID, because a position that breaks the desk's rules
--      (leverage, direction, an instrument that is not allowlisted) is
--      alerted on without ever being stored in trading.positions.
--      Append-only: an alert that was sent stays on record.
--   2. The run log also records position checks.
-- ===========================================================================
create table trading.position_alerts (
  id                 uuid primary key default gen_random_uuid(),
  etoro_position_id  bigint not null,
  condition_key      text   not null,           -- e.g. price_below:95 · date_after:2026-11-30 · no_exit_conditions
  kind               text   not null,           -- exit_condition / time_limit / outside_rules / no_exit_conditions / closed_elsewhere
  symbol             text,
  message            text   not null,           -- what was sent
  facts              jsonb  not null default '{}',  -- the price, its timestamp and source, the position figures used
  delivered          boolean not null,          -- whether Telegram accepted it
  created_at         timestamptz not null default now(),
  unique (etoro_position_id, condition_key)
);
create index position_alerts_recent on trading.position_alerts (created_at desc);
create trigger position_alerts_append_only before update or delete on trading.position_alerts
  for each row execute function trading.forbid_change();

alter table trading.monitor_runs drop constraint monitor_runs_kind_check;
alter table trading.monitor_runs add constraint monitor_runs_kind_check check (kind in ('rates', 'candles', 'research', 'news', 'positions'));

alter table trading.position_alerts enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on trading.position_alerts from %I', r);
    end if;
  end loop;
end $$;
