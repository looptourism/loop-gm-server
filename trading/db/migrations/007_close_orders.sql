-- ===========================================================================
-- Trading Desk — migration 007: closing positions (Stage 6).
-- Runs inside one transaction.
--
--   1. orders.order_kind — an order either opens or closes a position. eToro
--      numbers close orders separately from open orders, so eToro's order ID
--      is unique per kind, not across both.
--   2. account_alerts — one row per warning sent about the account as a
--      whole (a limit being approached or reached). The unique key makes a
--      warning fire once per limit, level and UTC day. Append-only.
-- ===========================================================================
alter table trading.orders add column order_kind text not null default 'open' check (order_kind in ('open', 'close'));
alter table trading.orders drop constraint orders_etoro_order_id_key;
alter table trading.orders add constraint orders_kind_etoro_order_id_key unique (order_kind, etoro_order_id);

create table trading.account_alerts (
  id          uuid primary key default gen_random_uuid(),
  alert_key   text not null unique,             -- e.g. total_exposure:80:2026-11-17
  kind        text not null,                    -- limit_warning / limit_reached
  message     text not null,
  facts       jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create trigger account_alerts_append_only before update or delete on trading.account_alerts
  for each row execute function trading.forbid_change();

alter table trading.account_alerts enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on trading.account_alerts from %I', r);
    end if;
  end loop;
end $$;
