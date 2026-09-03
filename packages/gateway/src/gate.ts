import type { GateDecision, OfferPayload } from "@kuwo/shared";
import { evaluatePolicy } from "./policy.js";
import type { KuwoStore } from "./store.js";

/**
 * Stage-1 gate wrapper: runs the pure policy engine INSIDE a SQLite
 * transaction with freshly-read ledger numbers, and writes the budget hold
 * in the same transaction when allowed. Two concurrent orders therefore
 * serialize: the second one re-reads a ledger that already contains the
 * first one's hold, and fails `budget_available` honestly.
 *
 * `reservationId` doubles as the idempotency key: replaying the same request
 * returns the recorded decision instead of double-reserving.
 */

export interface GateRequest {
  mandateJti: string;
  offer: OfferPayload;
  quantity: number;
  reservationId: string;
  orderRef?: string;
}

export interface GateResult {
  decision: GateDecision;
  reserved: boolean;
  replayed: boolean;
}

export class Gate {
  constructor(private readonly store: KuwoStore) {}

  evaluateAndReserve(req: GateRequest): GateResult {
    const run = this.store.db.transaction((): GateResult => {
      const priorDecision = this.store.db
        .prepare(`SELECT decision_json FROM gate_decisions WHERE reservation_id = ?`)
        .get(req.reservationId) as { decision_json: string } | undefined;
      if (priorDecision) {
        return {
          decision: JSON.parse(priorDecision.decision_json) as GateDecision,
          reserved: false,
          replayed: true,
        };
      }

      const mandate = this.store.getMandate(req.mandateJti);
      if (!mandate) {
        return {
          decision: {
            allowed: false,
            stage: "policy",
            checks: [{ name: "mandate_known", passed: false, detail: `no mandate "${req.mandateJti}" in store` }],
            reason: "mandate_known",
          },
          reserved: false,
          replayed: false,
        };
      }

      const merchantRow = this.store.getMerchant(req.offer.iss);
      const decision = evaluatePolicy({
        mandate: mandate.payload,
        mandateStatus: mandate.status,
        offer: req.offer,
        quantity: req.quantity,
        merchant: {
          registered: merchantRow !== undefined,
          flagged: merchantRow?.status === "flagged",
        },
        ledger: this.store.ledgerSummary(req.mandateJti),
        nowEpochMs: Date.now(),
      });

      if (decision.allowed) {
        this.store.insertReservation(
          req.reservationId,
          req.mandateJti,
          req.offer.price_paise * req.quantity,
          req.orderRef,
        );
      }
      this.store.db
        .prepare(`INSERT INTO gate_decisions (reservation_id, decision_json, created_at) VALUES (?, ?, ?)`)
        .run(req.reservationId, JSON.stringify(decision), new Date().toISOString());

      return { decision, reserved: decision.allowed, replayed: false };
    });
    return run();
  }
}

/** Idempotency needs decisions to outlive the request — table lives with the rest of the schema. */
export function ensureGateTables(store: KuwoStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS gate_decisions (
      reservation_id TEXT PRIMARY KEY,
      decision_json  TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );
  `);
}
