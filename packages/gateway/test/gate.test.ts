import { describe, it, expect, beforeEach } from "vitest";
import { KuwoStore } from "../src/store.js";
import { Gate, ensureGateTables } from "../src/gate.js";
import type { MandatePayload, OfferPayload } from "@kuwo/shared";

function mandatePayload(): MandatePayload {
  return {
    iss: "user_demo",
    sub: "agent_buyer",
    jti: "mandate_001",
    cnf: { jwk: { kty: "EC" } },
    bounds: {
      budget_paise: 400000, // ₹4,000
      per_txn_cap_paise: 250000,
      max_txns: 5,
      max_txns_per_minute: 5,
    },
    intent: {
      raw_text: "wireless earbuds under ₹2000",
      raw_text_sha256: "x",
      category: "electronics",
      keywords: ["earbuds"],
      max_price_paise: 200000,
      max_quantity: 2,
    },
  };
}

function offer(pricePaise = 179900): OfferPayload {
  return {
    iss: "merchant_a",
    jti: "offer_001",
    product_id: "prod_airdopes",
    name: "boAt Airdopes 141",
    category: "electronics",
    price_paise: pricePaise,
    currency: "INR",
    quantity_available: 10,
  };
}

describe("gate: reserve → commit/release ledger", () => {
  let store: KuwoStore;
  let gate: Gate;

  beforeEach(() => {
    store = new KuwoStore(":memory:");
    ensureGateTables(store);
    store.putMandate(mandatePayload(), "token");
    store.registerMerchant("merchant_a", "Merchant A", { kty: "EC" });
    gate = new Gate(store);
  });

  it("allows, reserves, and commits a compliant purchase", () => {
    const r = gate.evaluateAndReserve({ mandateJti: "mandate_001", offer: offer(), quantity: 1, reservationId: "res_1" });
    expect(r.decision.allowed).toBe(true);
    expect(r.reserved).toBe(true);

    store.commitReservation("res_1");
    const summary = store.ledgerSummary("mandate_001");
    expect(summary.spentPaise).toBe(179900);
    expect(summary.heldPaise).toBe(0);
    expect(summary.committedTxnCount).toBe(1);
  });

  it("two sequential holds cannot both fit a budget that only fits one (the race defense)", () => {
    // budget ₹4,000; each txn ₹1,799 ⇒ two fit (₹3,598), three do not.
    const r1 = gate.evaluateAndReserve({ mandateJti: "mandate_001", offer: offer(), quantity: 1, reservationId: "res_1" });
    const r2 = gate.evaluateAndReserve({ mandateJti: "mandate_001", offer: offer(), quantity: 1, reservationId: "res_2" });
    const r3 = gate.evaluateAndReserve({ mandateJti: "mandate_001", offer: offer(), quantity: 1, reservationId: "res_3" });

    expect(r1.decision.allowed).toBe(true);
    expect(r2.decision.allowed).toBe(true);
    expect(r3.decision.allowed).toBe(false); // held money already counts
    expect(r3.decision.reason).toBe("budget_available");
  });

  it("releasing a hold frees the budget again", () => {
    gate.evaluateAndReserve({ mandateJti: "mandate_001", offer: offer(), quantity: 1, reservationId: "res_1" });
    gate.evaluateAndReserve({ mandateJti: "mandate_001", offer: offer(), quantity: 1, reservationId: "res_2" });
    expect(
      gate.evaluateAndReserve({ mandateJti: "mandate_001", offer: offer(), quantity: 1, reservationId: "res_3" }).decision
        .allowed,
    ).toBe(false);

    store.releaseReservation("res_2"); // payment failed → hold released
    const retry = gate.evaluateAndReserve({ mandateJti: "mandate_001", offer: offer(), quantity: 1, reservationId: "res_4" });
    expect(retry.decision.allowed).toBe(true);
  });

  it("is idempotent: replaying a reservation id returns the recorded decision, no double hold", () => {
    const first = gate.evaluateAndReserve({ mandateJti: "mandate_001", offer: offer(), quantity: 1, reservationId: "res_1" });
    const replay = gate.evaluateAndReserve({ mandateJti: "mandate_001", offer: offer(), quantity: 1, reservationId: "res_1" });

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.reserved).toBe(false);
    expect(replay.decision.allowed).toBe(true);
    expect(store.ledgerSummary("mandate_001").heldPaise).toBe(179900); // exactly one hold
  });

  it("replaying a DENIED request returns the denial without re-evaluating", () => {
    const tooDear = offer(220000); // over intent ceiling
    const first = gate.evaluateAndReserve({ mandateJti: "mandate_001", offer: tooDear, quantity: 1, reservationId: "res_d" });
    const replay = gate.evaluateAndReserve({ mandateJti: "mandate_001", offer: tooDear, quantity: 1, reservationId: "res_d" });

    expect(first.decision.allowed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.decision.allowed).toBe(false);
    expect(replay.decision.reason).toBe("unit_price_within_intent");
  });

  it("denies an unknown mandate", () => {
    const r = gate.evaluateAndReserve({ mandateJti: "nope", offer: offer(), quantity: 1, reservationId: "res_x" });
    expect(r.decision.allowed).toBe(false);
    expect(r.decision.reason).toBe("mandate_known");
  });

  it("revocation takes effect immediately", () => {
    store.revokeMandate("mandate_001");
    const r = gate.evaluateAndReserve({ mandateJti: "mandate_001", offer: offer(), quantity: 1, reservationId: "res_1" });
    expect(r.decision.allowed).toBe(false);
    expect(r.decision.reason).toBe("mandate_active");
  });

  it("commit is one-way: committed cannot be released, released cannot be committed", () => {
    gate.evaluateAndReserve({ mandateJti: "mandate_001", offer: offer(), quantity: 1, reservationId: "res_1" });
    store.commitReservation("res_1");
    expect(() => store.releaseReservation("res_1")).toThrow(/committed/);

    gate.evaluateAndReserve({ mandateJti: "mandate_001", offer: offer(), quantity: 1, reservationId: "res_2" });
    store.releaseReservation("res_2");
    expect(() => store.commitReservation("res_2")).toThrow(/released/);
  });
});
