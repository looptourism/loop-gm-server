// ---------------------------------------------------------------------------
// Trading Desk — what Stage 2 writes to the database: the audit log and the
// two allowlists. Later stages add their own functions here.
// ---------------------------------------------------------------------------

// Adds one row to the permanent audit log. `tx` is either the db itself or
// the transaction handle from db.withTransaction — pass the handle so the
// audit row commits or rolls back together with the change it describes.
async function appendAudit(tx, { eventType, entityType = null, entityId = null, proposalId = null, actor, data = {} }) {
  if (!eventType || !actor) throw new Error("audit entry needs eventType and actor");
  const r = await tx.query(
    `insert into trading.audit_log (event_type, entity_type, entity_id, proposal_id, actor, data)
     values ($1, $2, $3, $4, $5, $6) returning id, seq, created_at`,
    [eventType, entityType, entityId === null ? null : String(entityId), proposalId, actor, JSON.stringify(data)]
  );
  return r.rows[0];
}

const TABLE = { stock: "stock_allowlist", crypto: "crypto_allowlist" };

// Writes the result of verifyAllowlist() in ONE transaction:
//   * verified symbol   → instrument stored (from eToro's answer) and the
//                         allowlist row linked to it;
//   * unverified symbol → listed but NOT linked, so it cannot be traded. A
//                         row that was verified earlier is left as it was —
//                         one failed search does not erase a real result;
//   * a row in the database that is no longer in the seed → set inactive.
// One audit entry records the whole run.
async function syncAllowlist(db, verification, { actor }) {
  return db.withTransaction(async (tx) => {
    const summary = { linked: [], listedUnverified: [], keptEarlierVerification: [], deactivated: [] };
    for (const r of verification.results) {
      const table = TABLE[r.assetClass];
      if (!table) throw new Error(`unknown asset class for ${r.symbol}`);
      const flagCol = r.assetClass === "stock" ? ", crypto_correlated" : "";
      const flagVal = r.assetClass === "stock" ? ", $4" : "";
      const flagSet = r.assetClass === "stock" ? ", crypto_correlated = excluded.crypto_correlated" : "";
      const flagArg = r.assetClass === "stock" ? [r.cryptoCorrelated === true] : [];
      if (r.status === "verified") {
        await tx.query(
          `insert into trading.instruments (instrument_id, symbol, display_name, asset_class, exchange, raw, source, fetched_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (instrument_id) do update set symbol = excluded.symbol, display_name = excluded.display_name,
             exchange = excluded.exchange, raw = excluded.raw, source = excluded.source, fetched_at = excluded.fetched_at`,
          [r.match.instrumentId, r.symbol, r.match.displayName, r.assetClass, r.match.exchange, JSON.stringify(r.raw), r.source, r.fetchedAt]
        );
        await tx.query(
          `insert into trading.${table} (symbol, instrument_id, verified_at${flagCol}) values ($1, $2, $3${flagVal})
           on conflict (symbol) do update set instrument_id = excluded.instrument_id, verified_at = excluded.verified_at, active = true${flagSet}`,
          [r.symbol, r.match.instrumentId, r.fetchedAt, ...flagArg]
        );
        summary.linked.push(r.symbol);
      } else {
        const params = r.assetClass === "stock" ? [r.symbol, null, null, ...flagArg] : [r.symbol];
        const row = await tx.query(
          r.assetClass === "stock"
            ? `insert into trading.${table} (symbol, instrument_id, verified_at, crypto_correlated) values ($1, $2, $3, $4)
               on conflict (symbol) do update set active = true, crypto_correlated = excluded.crypto_correlated returning instrument_id`
            : `insert into trading.${table} (symbol) values ($1)
               on conflict (symbol) do update set active = true returning instrument_id`,
          params
        );
        (row.rows[0].instrument_id === null ? summary.listedUnverified : summary.keptEarlierVerification).push(`${r.symbol} (${r.status})`);
      }
    }
    for (const assetClass of Object.keys(TABLE)) {
      const keep = verification.results.filter((r) => r.assetClass === assetClass).map((r) => r.symbol);
      const off = await tx.query(
        `update trading.${TABLE[assetClass]} set active = false where active and not (symbol = any($1::text[])) returning symbol`,
        [keep]
      );
      summary.deactivated.push(...off.rows.map((x) => x.symbol));
    }
    const audit = await appendAudit(tx, {
      eventType: "allowlist.synced", entityType: "allowlist", actor,
      data: { ...summary, results: verification.results.map(({ raw, candidates, ...rest }) => rest) },
    });
    return { ...summary, auditSeq: Number(audit.seq) };
  });
}

async function readAllowlists(db) {
  const stocks = await db.query(
    `select a.symbol, a.instrument_id, a.crypto_correlated, a.active, a.verified_at, i.display_name, i.exchange
     from trading.stock_allowlist a left join trading.instruments i on i.instrument_id = a.instrument_id order by a.symbol`
  );
  const crypto = await db.query(
    `select a.symbol, a.instrument_id, a.active, a.verified_at, i.display_name, i.exchange
     from trading.crypto_allowlist a left join trading.instruments i on i.instrument_id = a.instrument_id order by a.symbol`
  );
  const shape = (r) => ({ ...r, instrument_id: r.instrument_id === null ? null : Number(r.instrument_id), tradable: r.active && r.instrument_id !== null });
  return { stocks: stocks.rows.map(shape), crypto: crypto.rows.map(shape) };
}

// --- Editing the allowlists from the Trading Desk page (admin only) ---------
// The database is the source of truth for both lists once the page edits
// them; allowlist.js is only the first seed. Every change and every refused
// add is written to the audit log in the same transaction as the change.

class AllowlistError extends Error {
  constructor(message, code) { super(message); this.name = "AllowlistError"; this.code = code; }
}

const IN_FLIGHT = ["pending_approval", "approved", "executing"];

// `found` is a verified result from verify-allowlist's classify(), plus the
// source and fetchedAt of the eToro search that produced it.
async function addAllowlistSymbol(db, { assetClass, symbol, cryptoCorrelated = false, found, actor }) {
  const table = TABLE[assetClass];
  if (!table) throw new AllowlistError(`unknown asset class: ${assetClass}`, "BadInput");
  if (!found || found.status !== "verified" || !found.match || !found.source || !found.fetchedAt) throw new AllowlistError("only an eToro-verified symbol can be added", "NotVerified");
  const isStock = assetClass === "stock";
  return db.withTransaction(async (tx) => {
    const prev = (await tx.query(`select active, instrument_id from trading.${table} where symbol = $1 for update`, [symbol])).rows[0] || null;
    if (prev && prev.active && prev.instrument_id !== null) throw new AllowlistError(`${symbol} is already on the ${assetClass} allowlist`, "AlreadyListed");
    const other = (await tx.query(`select symbol from trading.${table} where instrument_id = $1 and symbol <> $2`, [found.match.instrumentId, symbol])).rows[0];
    if (other) throw new AllowlistError(`eToro instrument ${found.match.instrumentId} is already on the list as ${other.symbol}`, "SameInstrument");
    await tx.query(
      `insert into trading.instruments (instrument_id, symbol, display_name, asset_class, exchange, raw, source, fetched_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (instrument_id) do update set symbol = excluded.symbol, display_name = excluded.display_name,
         exchange = excluded.exchange, raw = excluded.raw, source = excluded.source, fetched_at = excluded.fetched_at`,
      [found.match.instrumentId, symbol, found.match.displayName, assetClass, found.match.exchange, JSON.stringify(found.raw || {}), found.source, found.fetchedAt]
    );
    await tx.query(
      isStock
        ? `insert into trading.${table} (symbol, instrument_id, verified_at, crypto_correlated, active) values ($1, $2, $3, $4, true)
           on conflict (symbol) do update set instrument_id = excluded.instrument_id, verified_at = excluded.verified_at, crypto_correlated = excluded.crypto_correlated, active = true`
        : `insert into trading.${table} (symbol, instrument_id, verified_at, active) values ($1, $2, $3, true)
           on conflict (symbol) do update set instrument_id = excluded.instrument_id, verified_at = excluded.verified_at, active = true`,
      isStock ? [symbol, found.match.instrumentId, found.fetchedAt, cryptoCorrelated === true] : [symbol, found.match.instrumentId, found.fetchedAt]
    );
    const previously = !prev ? "new" : prev.active ? "listed_unverified" : "removed_earlier";
    const audit = await appendAudit(tx, {
      eventType: "allowlist.symbol_added", entityType: table, entityId: symbol, actor,
      data: { symbol, assetClass, instrumentId: found.match.instrumentId, displayName: found.match.displayName, exchange: found.match.exchange,
        etoroAssetClass: found.match.etoroAssetClass, ...(isStock ? { cryptoCorrelated: cryptoCorrelated === true } : {}), previously, source: found.source, fetchedAt: found.fetchedAt },
    });
    return { symbol, assetClass, instrumentId: found.match.instrumentId, displayName: found.match.displayName, previously, auditSeq: Number(audit.seq) };
  });
}

// An add that eToro's search did not confirm. Nothing changes but the log.
async function recordAllowlistRejection(db, { assetClass, symbol, status, reason, candidates = [], source = null, fetchedAt = null, actor }) {
  const audit = await appendAudit(db, {
    eventType: "allowlist.add_rejected", entityType: TABLE[assetClass] || "allowlist", entityId: symbol, actor,
    data: { symbol, assetClass, status, reason, candidates: candidates.slice(0, 5), source, fetchedAt },
  });
  return Number(audit.seq);
}

// Switches a symbol off (the row and its eToro link stay, for the record).
// New buys are refused at once by the risk engine's "allowlisted" check,
// including ones already waiting; closing a held position does not need the
// allowlist, so nothing is trapped.
async function removeAllowlistSymbol(db, { assetClass, symbol, actor }) {
  const table = TABLE[assetClass];
  if (!table) throw new AllowlistError(`unknown asset class: ${assetClass}`, "BadInput");
  return db.withTransaction(async (tx) => {
    const row = (await tx.query(`select active, instrument_id from trading.${table} where symbol = $1 for update`, [symbol])).rows[0];
    if (!row || !row.active) throw new AllowlistError(`${symbol} is not on the ${assetClass} allowlist`, "NotListed");
    await tx.query(`update trading.${table} set active = false where symbol = $1`, [symbol]);
    let openPositions = 0, inFlightProposals = 0;
    if (row.instrument_id !== null) {
      openPositions = Number((await tx.query(`select count(*)::int as n from trading.positions where instrument_id = $1 and status = 'open'`, [row.instrument_id])).rows[0].n);
      inFlightProposals = Number((await tx.query(`select count(*)::int as n from trading.proposals where instrument_id = $1 and action = 'open' and status = any($2::text[])`, [row.instrument_id, IN_FLIGHT])).rows[0].n);
    }
    const instrumentId = row.instrument_id === null ? null : Number(row.instrument_id);
    const audit = await appendAudit(tx, {
      eventType: "allowlist.symbol_removed", entityType: table, entityId: symbol, actor,
      data: { symbol, assetClass, instrumentId, openPositions, inFlightProposals },
    });
    return { symbol, assetClass, instrumentId, openPositions, inFlightProposals, auditSeq: Number(audit.seq) };
  });
}

// The entries to verify/sync: the database's active rows; the seed only
// while the database has no allowlist rows at all.
async function currentAllowlistEntries(db, seed) {
  const lists = await readAllowlists(db);
  if (!lists.stocks.length && !lists.crypto.length) return seed();
  return [
    ...lists.stocks.filter((s) => s.active).map((s) => ({ symbol: s.symbol, assetClass: "stock", cryptoCorrelated: s.crypto_correlated === true })),
    ...lists.crypto.filter((c) => c.active).map((c) => ({ symbol: c.symbol, assetClass: "crypto", cryptoCorrelated: false })),
  ];
}

module.exports = { appendAudit, syncAllowlist, readAllowlists, addAllowlistSymbol, removeAllowlistSymbol, recordAllowlistRejection, currentAllowlistEntries, AllowlistError };
