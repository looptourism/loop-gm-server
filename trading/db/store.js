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

module.exports = { appendAudit, syncAllowlist, readAllowlists };
