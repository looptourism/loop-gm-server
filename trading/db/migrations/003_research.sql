-- ===========================================================================
-- Trading Desk — migration 003: research data (news, fundamentals, earnings,
-- filings) from the providers chosen as Option A. Runs in one transaction.
--
-- Same rules as market_snapshots: every row says which provider and which
-- call it came from (provider, source), when we asked (fetched_at), and keeps
-- the provider's answer (raw). Agents will read only from these tables.
-- ===========================================================================

-- 1. One row per DIFFERENT answer. If a provider returns exactly what is
--    already stored, no new row is written; last_confirmed_at moves forward
--    instead. So a row reads: "this was the answer from fetched_at until at
--    least last_confirmed_at".
create table trading.research_snapshots (
  id                 uuid primary key default gen_random_uuid(),
  instrument_id      bigint not null references trading.instruments (instrument_id),
  capability         text   not null check (capability in ('profile', 'fundamentals', 'earnings', 'filings')),
  provider           text   not null,
  data               jsonb  not null,                 -- the normalized figures (null fields = not provided)
  data_hash          text   not null check (data_hash ~ '^[0-9a-f]{64}$'),
  raw                jsonb  not null,
  source             text   not null,
  fetched_at         timestamptz not null,
  last_confirmed_at  timestamptz not null,
  created_at         timestamptz not null default now(),
  check (last_confirmed_at >= fetched_at)
);
create index research_snapshots_latest on trading.research_snapshots (instrument_id, capability, provider, fetched_at desc);

-- 2. News. instrument_id is null for general headlines of an asset class
--    (crypto market news is not per coin). One row per article per instrument.
create table trading.news_items (
  id             uuid primary key default gen_random_uuid(),
  asset_class    text   not null check (asset_class in ('stock', 'crypto')),
  instrument_id  bigint references trading.instruments (instrument_id),
  provider       text   not null,
  external_id    text   not null,                     -- the provider's article ID, or the URL
  headline       text   not null,
  summary        text,
  url            text,
  publisher      text,
  published_at   timestamptz not null,
  raw            jsonb  not null,
  source         text   not null,
  fetched_at     timestamptz not null,
  created_at     timestamptz not null default now()
);
create unique index news_items_once on trading.news_items (provider, asset_class, coalesce(instrument_id, 0), external_id);
create index news_items_by_instrument on trading.news_items (instrument_id, published_at desc);
create index news_items_by_class on trading.news_items (asset_class, published_at desc) where instrument_id is null;

-- 3. The run log also records research runs.
alter table trading.monitor_runs drop constraint monitor_runs_kind_check;
alter table trading.monitor_runs add constraint monitor_runs_kind_check check (kind in ('rates', 'candles', 'research', 'news'));

alter table trading.research_snapshots enable row level security;
alter table trading.news_items enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on trading.research_snapshots from %I', r);
      execute format('revoke all on trading.news_items from %I', r);
    end if;
  end loop;
end $$;
