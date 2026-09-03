import type { GateCheck, GateDecision, MandatePayload, OfferPayload } from "@kuwo/shared";

/**
 * Stage-1 gate: the deterministic policy engine.
 *
 * Pure function — no I/O, no clock reads, no AI. Everything it needs arrives
 * as input; everything it decides leaves as a GateDecision. Atomicity against
 * concurrent orders is the Gate wrapper's job (it runs this inside a SQLite
 * transaction with fresh ledger numbers).
 *
 * All checks run even after one fails: the audit trail should show the full
 * picture of an attempt, not just the first tripwire.
 */

export const VELOCITY_WINDOW_MS = 60_000;

export interface PolicyInput {
  /** Signature-verified mandate payload (verification happens before this gate). */
  mandate: MandatePayload;
  /** Live status from the store — a revoked mandate still carries a valid signature. */
  mandateStatus: "active" | "revoked";
  /** Signature-verified merchant offer. */
  offer: OfferPayload;
  quantity: number;
  merchant: { registered: boolean; flagged: boolean };
  ledger: {
    spentPaise: number;
    heldPaise: number;
    committedTxnCount: number;
    recentTxnEpochMs: number[];
  };
  nowEpochMs: number;
}

export function evaluatePolicy(input: PolicyInput): GateDecision {
  const { mandate, offer, quantity, merchant, ledger } = input;
  const { bounds, intent } = mandate;
  const totalPaise = offer.price_paise * quantity;
  const checks: GateCheck[] = [];

  const check = (name: string, passed: boolean, detail: string) => {
    checks.push({ name, passed, detail });
  };

  check(
    "mandate_active",
    input.mandateStatus === "active",
    input.mandateStatus === "active" ? "mandate is active" : "mandate has been revoked by the holder",
  );

  check(
    "quantity_valid",
    Number.isInteger(quantity) && quantity > 0,
    `requested quantity ${quantity}`,
  );

  check(
    "merchant_registered",
    merchant.registered,
    merchant.registered
      ? `merchant "${offer.iss}" is in the trust registry`
      : `merchant "${offer.iss}" is NOT in the trust registry`,
  );

  check(
    "merchant_not_flagged",
    !merchant.flagged,
    merchant.flagged ? `merchant "${offer.iss}" is flagged for prior abuse` : "merchant has no flags",
  );

  check(
    "category_matches_intent",
    offer.category === intent.category,
    `offer category "${offer.category}" vs intent category "${intent.category}"`,
  );

  check(
    "quantity_within_intent",
    quantity <= intent.max_quantity,
    `quantity ${quantity} vs intent max ${intent.max_quantity}`,
  );

  check(
    "unit_price_within_intent",
    offer.price_paise <= intent.max_price_paise,
    `unit price ${offer.price_paise}p vs intent ceiling ${intent.max_price_paise}p`,
  );

  check(
    "per_txn_cap",
    totalPaise <= bounds.per_txn_cap_paise,
    `txn total ${totalPaise}p vs per-txn cap ${bounds.per_txn_cap_paise}p`,
  );

  const alreadyCommittedOrHeld = ledger.spentPaise + ledger.heldPaise;
  check(
    "budget_available",
    alreadyCommittedOrHeld + totalPaise <= bounds.budget_paise,
    `spent ${ledger.spentPaise}p + held ${ledger.heldPaise}p + this ${totalPaise}p vs budget ${bounds.budget_paise}p`,
  );

  check(
    "txn_count_within_max",
    ledger.committedTxnCount < bounds.max_txns,
    `${ledger.committedTxnCount} committed txns vs max ${bounds.max_txns}`,
  );

  const cutoff = input.nowEpochMs - VELOCITY_WINDOW_MS;
  const recentCount = ledger.recentTxnEpochMs.filter((t) => t > cutoff).length;
  check(
    "velocity_within_limit",
    recentCount < bounds.max_txns_per_minute,
    `${recentCount} txns in last 60s vs limit ${bounds.max_txns_per_minute}/min`,
  );

  const firstFailure = checks.find((c) => !c.passed);
  const decision: GateDecision = {
    allowed: firstFailure === undefined,
    stage: "policy",
    checks,
  };
  if (firstFailure) decision.reason = firstFailure.name;
  return decision;
}
