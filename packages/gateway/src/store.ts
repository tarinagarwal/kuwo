import Database from "better-sqlite3";
import type { JWK, MandatePayload } from "@kuwo/shared";

/**
 * Kuwo's persistence: mandates, the budget ledger, the trust registry.
 *
 * better-sqlite3 is synchronous, so a db.transaction() block is genuinely
 * atomic — the ledger's reserve step re-reads balances inside the same
 * transaction that writes the hold, which is what makes two parallel orders
 * unable to both pass the budget check.
 */

export interface MandateRow {
  jti: string;
  token: string;
  payload: MandatePayload;
  status: "active" | "revoked";
}

export interface MerchantRow {
  id: string;
  name: string;
  publicJwk: JWK;
  status: "active" | "flagged";
}

export interface ReservationRow {
  id: string;
  mandateJti: string;
  amountPaise: number;
  status: "held" | "committed" | "released";
  orderRef: string | null;
}

export interface LedgerSummary {
  spentPaise: number;
  heldPaise: number;
  committedTxnCount: number;
  recentTxnEpochMs: number[];
}

export class KuwoStore {
  readonly db: Database.Database;

  constructor(dbPath = ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mandates (
        jti          TEXT PRIMARY KEY,
        token        TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'active',
        created_at   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reservations (
        id           TEXT PRIMARY KEY,
        mandate_jti  TEXT NOT NULL REFERENCES mandates(jti),
        amount_paise INTEGER NOT NULL,
        status       TEXT NOT NULL DEFAULT 'held',
        order_ref    TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS txn_events (
        mandate_jti TEXT NOT NULL REFERENCES mandates(jti),
        at_epoch_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS merchants (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        public_jwk    TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'active',
        registered_at TEXT NOT NULL
      );
    `);
  }

  // ---- mandates ----

  putMandate(payload: MandatePayload, token: string): void {
    this.db
      .prepare(
        `INSERT INTO mandates (jti, token, payload_json, status, created_at)
         VALUES (?, ?, ?, 'active', ?)
         ON CONFLICT(jti) DO NOTHING`,
      )
      .run(payload.jti, token, JSON.stringify(payload), new Date().toISOString());
  }

  getMandate(jti: string): MandateRow | undefined {
    const row = this.db.prepare(`SELECT * FROM mandates WHERE jti = ?`).get(jti) as
      | { jti: string; token: string; payload_json: string; status: "active" | "revoked" }
      | undefined;
    if (!row) return undefined;
    return {
      jti: row.jti,
      token: row.token,
      payload: JSON.parse(row.payload_json) as MandatePayload,
      status: row.status,
    };
  }

  revokeMandate(jti: string): void {
    this.db.prepare(`UPDATE mandates SET status = 'revoked' WHERE jti = ?`).run(jti);
  }

  // ---- trust registry ----

  registerMerchant(id: string, name: string, publicJwk: JWK): void {
    this.db
      .prepare(
        `INSERT INTO merchants (id, name, public_jwk, status, registered_at)
         VALUES (?, ?, ?, 'active', ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, public_jwk = excluded.public_jwk`,
      )
      .run(id, name, JSON.stringify(publicJwk), new Date().toISOString());
  }

  getMerchant(id: string): MerchantRow | undefined {
    const row = this.db.prepare(`SELECT * FROM merchants WHERE id = ?`).get(id) as
      | { id: string; name: string; public_jwk: string; status: "active" | "flagged" }
      | undefined;
    if (!row) return undefined;
    return { id: row.id, name: row.name, publicJwk: JSON.parse(row.public_jwk) as JWK, status: row.status };
  }

  listMerchants(): MerchantRow[] {
    const rows = this.db.prepare(`SELECT id FROM merchants ORDER BY id`).all() as { id: string }[];
    return rows.map((r) => this.getMerchant(r.id)!) ;
  }

  flagMerchant(id: string): void {
    this.db.prepare(`UPDATE merchants SET status = 'flagged' WHERE id = ?`).run(id);
  }

  // ---- budget ledger ----

  ledgerSummary(mandateJti: string): LedgerSummary {
    const spent = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_paise), 0) AS total, COUNT(*) AS n
         FROM reservations WHERE mandate_jti = ? AND status = 'committed'`,
      )
      .get(mandateJti) as { total: number; n: number };
    const held = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_paise), 0) AS total
         FROM reservations WHERE mandate_jti = ? AND status = 'held'`,
      )
      .get(mandateJti) as { total: number };
    const recent = this.db
      .prepare(`SELECT at_epoch_ms FROM txn_events WHERE mandate_jti = ? ORDER BY at_epoch_ms DESC LIMIT 100`)
      .all(mandateJti) as { at_epoch_ms: number }[];
    return {
      spentPaise: spent.total,
      heldPaise: held.total,
      committedTxnCount: spent.n,
      recentTxnEpochMs: recent.map((r) => r.at_epoch_ms),
    };
  }

  getReservation(id: string): ReservationRow | undefined {
    const row = this.db.prepare(`SELECT * FROM reservations WHERE id = ?`).get(id) as
      | { id: string; mandate_jti: string; amount_paise: number; status: ReservationRow["status"]; order_ref: string | null }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      mandateJti: row.mandate_jti,
      amountPaise: row.amount_paise,
      status: row.status,
      orderRef: row.order_ref,
    };
  }

  /** Insert a hold. Callers run this inside a Gate transaction, never directly. */
  insertReservation(id: string, mandateJti: string, amountPaise: number, orderRef?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO reservations (id, mandate_jti, amount_paise, status, order_ref, created_at, updated_at)
         VALUES (?, ?, ?, 'held', ?, ?, ?)`,
      )
      .run(id, mandateJti, amountPaise, orderRef ?? null, now, now);
  }

  /** held → committed: the money is spent; the txn counts toward velocity. */
  commitReservation(id: string): void {
    const tx = this.db.transaction(() => {
      const res = this.getReservation(id);
      if (!res) throw new Error(`reservation ${id} not found`);
      if (res.status !== "held") throw new Error(`reservation ${id} is ${res.status}, expected held`);
      this.db
        .prepare(`UPDATE reservations SET status = 'committed', updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), id);
      this.db.prepare(`INSERT INTO txn_events (mandate_jti, at_epoch_ms) VALUES (?, ?)`).run(res.mandateJti, Date.now());
    });
    tx();
  }

  /** held → released: nothing was charged; the budget frees up. */
  releaseReservation(id: string): void {
    const res = this.getReservation(id);
    if (!res) throw new Error(`reservation ${id} not found`);
    if (res.status !== "held") throw new Error(`reservation ${id} is ${res.status}, expected held`);
    this.db
      .prepare(`UPDATE reservations SET status = 'released', updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  close(): void {
    this.db.close();
  }
}
