-- ===========================================================================
-- Trading Desk — migration 001: the data model (Stage 2).
--
-- Runs inside ONE transaction (the runner in trading/db/index.js wraps it):
-- either every table below exists afterwards, or nothing changed.
--
-- Conventions
--   * Everything lives in its own schema, "trading". Supabase's Data API only
--     exposes "public", so these tables are not reachable with the project's
--     API keys. Row Level Security is switched on as a second lock.
--   * Every row has a UUID id (eToro's own numeric IDs are kept beside it),
--     and created_at / updated_at in UTC (timestamptz).
--   * Money is numeric(14,2) in USD. Never floating point.
--   * The hard rules that can be expressed as constraints ARE constraints:
--     demo only, buy only, leverage 1, stocks and crypto only, approval
--     window of at most 15 minutes, one order per approval, an order cannot
--     exist without an approved approval carrying the same parameter hash.
--     Code checks all of this first (Stage 5); the database is the last line.
-- ===========================================================================

create schema if not exists trading;  -- the migration runner creates it first, for its own bookkeeping table

-- --------------------------------------------------------------------------
-- Helper functions
-- --------------------------------------------------------------------------
create function trading.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- For tables that are a permanent record: rows can be added, never changed
-- or removed.
create function trading.forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception 'trading.% is append-only: % is not allowed', tg_table_name, tg_op;
end $$;

-- --------------------------------------------------------------------------
-- 1. instruments — what eToro told us about an instrument. Filled only from
--    a real Market Data call; source + fetched_at say which one.
-- --------------------------------------------------------------------------
create table trading.instruments (
  id             uuid primary key default gen_random_uuid(),
  instrument_id  bigint not null unique,              -- eToro's instrumentId
  symbol         text   not null unique,              -- eToro's internalSymbolFull
  display_name   text,
  asset_class    text   not null check (asset_class in ('stock', 'crypto')),  -- no ETFs, nothing else
  exchange       text,                                -- eToro's internalExchangeName
  raw            jsonb  not null,                     -- the search item exactly as returned
  source         text   not null,
  fetched_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (instrument_id, asset_class)                 -- lets the allowlists pin the asset class
);

-- --------------------------------------------------------------------------
-- 2. stock_allowlist — the owner's Sharia-screened list. The server never
--    judges a stock; it only records what the owner listed.
--    A row is usable for trading only when it is active AND verified
--    (instrument_id filled from a real eToro search).
-- --------------------------------------------------------------------------
create table trading.stock_allowlist (
  id                uuid primary key default gen_random_uuid(),
  symbol            text not null unique,
  instrument_id     bigint,
  asset_class       text not null default 'stock' check (asset_class = 'stock'),
  crypto_correlated boolean not null default false,   -- e.g. MSTR; Stage 5 decides whether it counts toward the crypto cap
  active            boolean not null default true,
  verified_at       timestamptz,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (instrument_id, asset_class) references trading.instruments (instrument_id, asset_class),
  check ((instrument_id is null) = (verified_at is null))
);
create unique index stock_allowlist_instrument on trading.stock_allowlist (instrument_id) where instrument_id is not null;

-- --------------------------------------------------------------------------
-- 3. crypto_allowlist — coins the owner approved.
-- --------------------------------------------------------------------------
create table trading.crypto_allowlist (
  id             uuid primary key default gen_random_uuid(),
  symbol         text not null unique,
  instrument_id  bigint,
  asset_class    text not null default 'crypto' check (asset_class = 'crypto'),
  active         boolean not null default true,
  verified_at    timestamptz,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (instrument_id, asset_class) references trading.instruments (instrument_id, asset_class),
  check ((instrument_id is null) = (verified_at is null))
);
create unique index crypto_allowlist_instrument on trading.crypto_allowlist (instrument_id) where instrument_id is not null;

-- --------------------------------------------------------------------------
-- 4. market_snapshots — timestamped prices and candles collected by the
--    Stage 3 job. Agents read ONLY from here. as_of is eToro's own timestamp
--    for the figure; fetched_at is when we asked.
-- --------------------------------------------------------------------------
create table trading.market_snapshots (
  id             uuid primary key default gen_random_uuid(),
  instrument_id  bigint not null references trading.instruments (instrument_id),
  kind           text   not null check (kind in ('rate', 'candle')),
  as_of          timestamptz not null,
  bid            numeric(24,10),
  ask            numeric(24,10),
  quote_type     text,                                -- eToro: realtime / delayed
  candle_interval text,                               -- OneMinute … OneWeek
  open           numeric(24,10),
  high           numeric(24,10),
  low            numeric(24,10),
  close          numeric(24,10),
  volume         numeric(28,4),                       -- unreliable on eToro (see API notes); stored, not trusted
  raw            jsonb not null,
  source         text  not null,
  fetched_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  check (kind <> 'rate'   or (bid is not null and ask is not null)),
  check (kind <> 'candle' or (candle_interval is not null and open is not null and high is not null and low is not null and close is not null))
);
create index market_snapshots_lookup on trading.market_snapshots (instrument_id, kind, candle_interval, as_of desc);

-- --------------------------------------------------------------------------
-- 5. analyses — one structured JSON result from one agent run (Stage 4).
--    Permanent: never edited after it is written.
-- --------------------------------------------------------------------------
create table trading.analyses (
  id                  uuid primary key default gen_random_uuid(),
  agent               text not null check (agent in ('stock', 'crypto', 'risk', 'portfolio_manager')),
  instrument_id       bigint references trading.instruments (instrument_id),
  subject_analysis_id uuid references trading.analyses (id),   -- the analysis a risk critique is about
  recommendation      text,
  confidence          numeric(4,3) check (confidence between 0 and 1),  -- analytical confidence, NOT a win probability
  output              jsonb not null,                  -- the agent's full structured answer
  snapshot_ids        uuid[] not null default '{}',    -- the market_snapshots rows it was given
  model               text,
  created_at          timestamptz not null default now()
);
create index analyses_instrument on trading.analyses (instrument_id, created_at desc);
create trigger analyses_append_only before update or delete on trading.analyses
  for each row execute function trading.forbid_change();

-- --------------------------------------------------------------------------
-- 7. positions — our record of demo positions, synced from eToro.
--    (Created before proposals because a close proposal points at one.)
-- --------------------------------------------------------------------------
create table trading.positions (
  id                 uuid primary key default gen_random_uuid(),
  environment        text not null default 'demo' check (environment = 'demo'),
  etoro_position_id  bigint not null unique,
  instrument_id      bigint not null references trading.instruments (instrument_id),
  direction          text not null check (direction = 'buy'),
  leverage           integer not null check (leverage = 1),
  amount_usd         numeric(14,2) not null check (amount_usd > 0),
  units              numeric(28,10),
  open_rate          numeric(24,10),
  opened_at          timestamptz,
  status             text not null default 'open' check (status in ('open', 'closed')),
  close_rate         numeric(24,10),
  closed_at          timestamptz,
  realized_pnl_usd   numeric(14,2),
  exit_conditions    jsonb,                            -- from the approved proposal; watched in Stage 6
  source             text not null,
  last_synced_at     timestamptz not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check ((status = 'closed') = (closed_at is not null))
);
create index positions_open on trading.positions (instrument_id) where status = 'open';

-- --------------------------------------------------------------------------
-- 6. proposals — a trade the Portfolio Manager suggests. Opening and closing
--    are both proposals and both need approval.
--    The trade parameters are frozen at insert: changing any of them is
--    impossible, so "any parameter change = new proposal = new approval".
-- --------------------------------------------------------------------------
create table trading.proposals (
  id               uuid primary key default gen_random_uuid(),
  action           text not null check (action in ('open', 'close')),
  instrument_id    bigint not null references trading.instruments (instrument_id),
  asset_class      text   not null check (asset_class in ('stock', 'crypto')),
  direction        text   not null check (direction = 'buy'),          -- long only; a close closes a long
  leverage         integer not null default 1 check (leverage = 1),
  order_type       text   not null check (order_type in ('market', 'limit')),
  limit_rate       numeric(24,10),
  amount_usd       numeric(14,2) not null check (amount_usd > 0),
  position_id      uuid references trading.positions (id),             -- the position to close
  expires_at       timestamptz not null,
  params_hash      text not null check (params_hash ~ '^[0-9a-f]{64}$'), -- SHA-256 of the exact parameters above
  idempotency_key  uuid not null unique default gen_random_uuid(),     -- sent to eToro with the order
  status           text not null default 'draft' check (status in (
                     'draft', 'risk_rejected', 'pending_approval', 'approved', 'rejected',
                     'expired', 'executing', 'executed', 'failed', 'cancelled')),
  status_reason    text,
  analysis_id      uuid references trading.analyses (id),
  details          jsonb not null default '{}',                        -- thesis, entry/exit conditions, holding period, risks
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, params_hash),
  foreign key (instrument_id, asset_class) references trading.instruments (instrument_id, asset_class),
  check ((action = 'close') = (position_id is not null)),
  check ((order_type = 'limit') = (limit_rate is not null)),
  check (expires_at > created_at)
);
create index proposals_status on trading.proposals (status, created_at desc);
-- Duplicate guard: at most one live proposal to open a given instrument, and
-- at most one live proposal to close a given position.
create unique index proposals_one_live_open  on trading.proposals (instrument_id)
  where action = 'open'  and status in ('pending_approval', 'approved', 'executing');
create unique index proposals_one_live_close on trading.proposals (position_id)
  where action = 'close' and status in ('pending_approval', 'approved', 'executing');

create function trading.proposals_freeze_params() returns trigger
language plpgsql as $$
begin
  if (new.id, new.action, new.instrument_id, new.asset_class, new.direction, new.leverage,
      new.order_type, new.limit_rate, new.amount_usd, new.position_id, new.expires_at,
      new.params_hash, new.idempotency_key, new.created_at)
     is distinct from
     (old.id, old.action, old.instrument_id, old.asset_class, old.direction, old.leverage,
      old.order_type, old.limit_rate, old.amount_usd, old.position_id, old.expires_at,
      old.params_hash, old.idempotency_key, old.created_at)
  then
    raise exception 'a proposal''s trade parameters cannot be changed; create a new proposal';
  end if;
  return new;
end $$;
create trigger proposals_freeze before update on trading.proposals
  for each row execute function trading.proposals_freeze_params();

-- --------------------------------------------------------------------------
-- 8. risk_assessments — the deterministic engine's verdict (Stage 5), with
--    every individual check and the policy values it used. Permanent.
-- --------------------------------------------------------------------------
create table trading.risk_assessments (
  id              uuid primary key default gen_random_uuid(),
  proposal_id     uuid not null references trading.proposals (id),
  phase           text not null check (phase in ('pre_approval', 'pre_execution')),
  passed          boolean not null,
  checks          jsonb not null,      -- [{ name, passed, limit, actual, message }]
  policy          jsonb not null,      -- the limits in force at that moment
  inputs          jsonb not null,      -- account + price figures used, each with source and fetchedAt
  engine_version  text not null,
  created_at      timestamptz not null default now()
);
create index risk_assessments_proposal on trading.risk_assessments (proposal_id, created_at);
create trigger risk_assessments_append_only before update or delete on trading.risk_assessments
  for each row execute function trading.forbid_change();

-- --------------------------------------------------------------------------
-- 9. approvals — one approval request per proposal, bound to the proposal's
--    parameter hash. Valid for at most 15 minutes, decided once, used once.
-- --------------------------------------------------------------------------
create table trading.approvals (
  id                   uuid primary key default gen_random_uuid(),
  proposal_id          uuid not null unique,
  params_hash          text not null,
  requested_at         timestamptz not null default now(),
  expires_at           timestamptz not null,
  decision             text check (decision in ('approved', 'rejected')),
  decided_at           timestamptz,
  channel              text check (channel in ('telegram', 'dashboard')),
  actor                text,                           -- Telegram chat id or "console"
  telegram_message_id  bigint,
  consumed_at          timestamptz,                    -- set when the order is created: single use
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (id, params_hash),
  foreign key (proposal_id, params_hash) references trading.proposals (id, params_hash),
  check (expires_at > requested_at and expires_at <= requested_at + interval '15 minutes'),
  check ((decision is null) = (decided_at is null)),
  check ((decision is null) = (channel is null)),
  check (decision is null or decided_at <= expires_at),      -- a late click cannot approve
  check (consumed_at is null or (decision = 'approved' and consumed_at <= expires_at))
);

create function trading.approvals_guard() returns trigger
language plpgsql as $$
begin
  if (new.id, new.proposal_id, new.params_hash, new.requested_at, new.expires_at)
     is distinct from (old.id, old.proposal_id, old.params_hash, old.requested_at, old.expires_at) then
    raise exception 'an approval cannot be re-pointed or extended';
  end if;
  if old.decision is not null and
     (new.decision, new.decided_at, new.channel, new.actor)
     is distinct from (old.decision, old.decided_at, old.channel, old.actor) then
    raise exception 'an approval decision is final';
  end if;
  if old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at then
    raise exception 'an approval can be used only once';
  end if;
  return new;
end $$;
create trigger approvals_guard before update on trading.approvals
  for each row execute function trading.approvals_guard();

-- --------------------------------------------------------------------------
-- 10. orders — what was sent to eToro DEMO and what came back.
--     One order per proposal, one order per approval, same parameter hash
--     on all three. environment can only ever be 'demo'.
-- --------------------------------------------------------------------------
create table trading.orders (
  id               uuid primary key default gen_random_uuid(),
  environment      text not null default 'demo' check (environment = 'demo'),
  proposal_id      uuid not null unique,
  approval_id      uuid not null unique,
  params_hash      text not null,
  idempotency_key  uuid not null unique,
  etoro_order_id   bigint unique,
  status           text not null default 'submitting' check (status in (
                     'submitting', 'submitted', 'filled', 'rejected', 'failed', 'unknown')),
  request          jsonb not null,                     -- the exact body sent
  response         jsonb,                              -- eToro's answer to the submit call
  verification     jsonb,                              -- the follow-up order lookup
  error            text,
  submitted_at     timestamptz,
  verified_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (proposal_id, params_hash) references trading.proposals (id, params_hash),
  foreign key (approval_id, params_hash) references trading.approvals (id, params_hash)
);

-- An order row can only be created from an approval that is approved, not
-- expired, for this proposal, and already marked as consumed in the same
-- transaction.
create function trading.orders_require_approval() returns trigger
language plpgsql as $$
declare a trading.approvals%rowtype;
begin
  select * into a from trading.approvals where id = new.approval_id for update;
  if not found
     or a.proposal_id <> new.proposal_id
     or a.decision is distinct from 'approved'
     or a.consumed_at is null
     or a.expires_at < now() then
    raise exception 'order refused: no valid, unexpired, consumed approval for this proposal';
  end if;
  return new;
end $$;
create trigger orders_require_approval before insert on trading.orders
  for each row execute function trading.orders_require_approval();

create function trading.orders_freeze() returns trigger
language plpgsql as $$
begin
  if (new.id, new.environment, new.proposal_id, new.approval_id, new.params_hash, new.idempotency_key, new.request, new.created_at)
     is distinct from
     (old.id, old.environment, old.proposal_id, old.approval_id, old.params_hash, old.idempotency_key, old.request, old.created_at) then
    raise exception 'an order''s identity and request cannot be changed';
  end if;
  return new;
end $$;
create trigger orders_freeze before update on trading.orders
  for each row execute function trading.orders_freeze();

alter table trading.positions
  add column opened_by_order_id uuid references trading.orders (id),
  add column closed_by_order_id uuid references trading.orders (id);

-- --------------------------------------------------------------------------
-- 11. audit_log — the permanent record of everything that happened:
--     proposals, risk results, approvals, rejections, orders, execution
--     results, allowlist changes. Insert only; UPDATE, DELETE and TRUNCATE
--     all raise an error.
-- --------------------------------------------------------------------------
create table trading.audit_log (
  id           uuid primary key default gen_random_uuid(),
  seq          bigint generated always as identity unique,   -- strict order of events
  event_type   text not null,                                -- e.g. proposal.created, risk.rejected, order.submitted
  entity_type  text,
  entity_id    text,
  proposal_id  uuid references trading.proposals (id),
  actor        text not null,                                -- system / owner:telegram / owner:console / agent:<name>
  data         jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index audit_log_proposal on trading.audit_log (proposal_id, seq);
create index audit_log_event    on trading.audit_log (event_type, seq desc);
create trigger audit_log_append_only before update or delete on trading.audit_log
  for each row execute function trading.forbid_change();
create trigger audit_log_no_truncate before truncate on trading.audit_log
  for each statement execute function trading.forbid_change();

-- --------------------------------------------------------------------------
-- updated_at maintenance
-- --------------------------------------------------------------------------
create trigger instruments_touch      before update on trading.instruments      for each row execute function trading.set_updated_at();
create trigger stock_allowlist_touch  before update on trading.stock_allowlist  for each row execute function trading.set_updated_at();
create trigger crypto_allowlist_touch before update on trading.crypto_allowlist for each row execute function trading.set_updated_at();
create trigger positions_touch        before update on trading.positions        for each row execute function trading.set_updated_at();
create trigger proposals_touch        before update on trading.proposals        for each row execute function trading.set_updated_at();
create trigger approvals_touch        before update on trading.approvals        for each row execute function trading.set_updated_at();
create trigger orders_touch           before update on trading.orders           for each row execute function trading.set_updated_at();

-- --------------------------------------------------------------------------
-- Lock the schema away from Supabase's public API roles. The server connects
-- as the database owner, which is not affected by any of this.
-- --------------------------------------------------------------------------
do $$
declare t record; r text;
begin
  for t in select tablename from pg_tables where schemaname = 'trading' loop
    execute format('alter table trading.%I enable row level security', t.tablename);
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema trading from %I', r);
      execute format('revoke all on all tables in schema trading from %I', r);
      execute format('revoke all on all sequences in schema trading from %I', r);
      execute format('revoke all on all functions in schema trading from %I', r);
    end if;
  end loop;
end $$;
