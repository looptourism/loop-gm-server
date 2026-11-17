-- ===========================================================================
-- Trading Desk — migration 008: revisit watches.
-- Runs inside one transaction.
--
-- When an analyst does not recommend buying now but names one checkable
-- trigger for looking again ("a close back above 40.41", "after the 20th"),
-- the desk keeps it here. Plain code checks it every 15 minutes against the
-- stored prices; when it is met, the agents are asked to analyse that
-- instrument again. Nothing here can place an order: a new analysis can only
-- lead to a draft proposal, which goes to the risk engine and to the owner.
--
-- One open watch per instrument: a newer analysis replaces the older watch.
-- ===========================================================================
create table trading.watches (
  id              uuid primary key default gen_random_uuid(),
  instrument_id   bigint not null references trading.instruments (instrument_id),
  analysis_id     uuid not null references trading.analyses (id),
  condition       jsonb not null,              -- { type: price_above | price_below | date_after, value, date, description }
  price_at_start  numeric(24,10),              -- the stored bid when the watch was set, for the message
  status          text not null default 'open' check (status in ('open', 'triggered', 'done', 'expired', 'replaced', 'skipped')),
  status_reason   text,
  expires_at      timestamptz not null,
  triggered_at    timestamptz,
  triggered_price numeric(24,10),
  run_started_at  timestamptz,                 -- when the new analysis was started
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index watches_one_open on trading.watches (instrument_id) where status in ('open', 'triggered');
create index watches_recent on trading.watches (created_at desc);

alter table trading.watches enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on trading.watches from %I', r);
    end if;
  end loop;
end $$;
