import { describe, it, expect } from "vitest";
import { evaluatePolicy, type PolicyInput } from "../src/policy.js";
import type { MandatePayload, OfferPayload } from "@kuwo/shared";

const NOW = 1_760_000_000_000;

function baseMandate(): MandatePayload {
  return {
    iss: "user_demo",
    sub: "agent_buyer",
    jti: "mandate_001",
    cnf: { jwk: { kty: "EC" } },
    bounds: {
      budget_paise: 500000, // ₹5,000
      per_txn_cap_paise: 250000, // ₹2,500
      max_txns: 3,
      max_txns_per_minute: 2,
    },
    intent: {
      raw_text: "wireless earbuds under ₹2000, one unit",
      raw_text_sha256: "x",
      category: "electronics",
      keywords: ["wireless", "earbuds"],
      max_price_paise: 200000, // ₹2,000
      max_quantity: 1,
    },
  };
}

function baseOffer(): OfferPayload {
  return {
    iss: "merchant_a",
    jti: "offer_001",
    product_id: "prod_airdopes",
    name: "boAt Airdopes 141",
    category: "electronics",
    price_paise: 179900, // ₹1,799
    currency: "INR",
    quantity_available: 10,
  };
}

function baseInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    mandate: baseMandate(),
    mandateStatus: "active",
    offer: baseOffer(),
    quantity: 1,
    merchant: { registered: true, flagged: false },
    ledger: { spentPaise: 0, heldPaise: 0, committedTxnCount: 0, recentTxnEpochMs: [] },
    nowEpochMs: NOW,
    ...overrides,
  };
}

describe("policy engine — happy path", () => {
  it("allows a compliant purchase and reports every check", () => {
    const d = evaluatePolicy(baseInput());
    expect(d.allowed).toBe(true);
    expect(d.stage).toBe("policy");
    expect(d.checks.length).toBe(11);
    expect(d.checks.every((c) => c.passed)).toBe(true);
    expect(d.reason).toBeUndefined();
  });
});

describe("policy engine — each tripwire", () => {
  it("denies a revoked mandate even with a valid signature", () => {
    const d = evaluatePolicy(baseInput({ mandateStatus: "revoked" }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("mandate_active");
  });

  it("denies an unregistered merchant (Attack 3: merchant redirect)", () => {
    const d = evaluatePolicy(baseInput({ merchant: { registered: false, flagged: false } }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("merchant_registered");
  });

  it("denies a flagged merchant", () => {
    const d = evaluatePolicy(baseInput({ merchant: { registered: true, flagged: true } }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("merchant_not_flagged");
  });

  it("denies a category outside the intent", () => {
    const offer = { ...baseOffer(), category: "fashion" };
    const d = evaluatePolicy(baseInput({ offer }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("category_matches_intent");
  });

  it("denies quantity above the intent limit (Attack 1: 50-unit bulk injection)", () => {
    const d = evaluatePolicy(baseInput({ quantity: 50 }));
    expect(d.allowed).toBe(false);
    const failed = d.checks.filter((c) => !c.passed).map((c) => c.name);
    expect(failed).toContain("quantity_within_intent");
    expect(failed).toContain("per_txn_cap"); // 50 × ₹1,799 also blows the cap
  });

  it("denies a unit price above the intent ceiling", () => {
    const offer = { ...baseOffer(), price_paise: 220000 }; // ₹2,200 > ₹2,000 intent
    const d = evaluatePolicy(baseInput({ offer }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("unit_price_within_intent");
  });

  it("denies when the txn total exceeds the per-txn cap", () => {
    const mandate = baseMandate();
    mandate.intent.max_price_paise = 400000;
    mandate.intent.max_quantity = 2;
    const offer = { ...baseOffer(), price_paise: 130000 };
    const d = evaluatePolicy(baseInput({ mandate, offer, quantity: 2 })); // ₹2,600 > ₹2,500 cap
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("per_txn_cap");
  });

  it("denies when spent + held + this txn exceeds the budget", () => {
    const d = evaluatePolicy(
      baseInput({ ledger: { spentPaise: 200000, heldPaise: 150000, committedTxnCount: 2, recentTxnEpochMs: [] } }),
    ); // 2000 + 1500 + 1799 > 5000
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("budget_available");
  });

  it("counts held (not yet committed) money against the budget — no double-spend window", () => {
    const d = evaluatePolicy(
      baseInput({ ledger: { spentPaise: 0, heldPaise: 350000, committedTxnCount: 0, recentTxnEpochMs: [] } }),
    ); // 0 spent, but ₹3,500 held + ₹1,799 > ₹5,000
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("budget_available");
  });

  it("denies past the max transaction count", () => {
    const mandate = baseMandate();
    mandate.bounds.budget_paise = 2000000;
    const d = evaluatePolicy(
      baseInput({ mandate, ledger: { spentPaise: 0, heldPaise: 0, committedTxnCount: 3, recentTxnEpochMs: [] } }),
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("txn_count_within_max");
  });

  it("denies on velocity: too many txns in the last minute", () => {
    const d = evaluatePolicy(
      baseInput({
        ledger: {
          spentPaise: 0,
          heldPaise: 0,
          committedTxnCount: 2,
          recentTxnEpochMs: [NOW - 10_000, NOW - 20_000],
        },
      }),
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("velocity_within_limit");
  });

  it("ignores txns older than the 60s velocity window", () => {
    const d = evaluatePolicy(
      baseInput({
        ledger: {
          spentPaise: 0,
          heldPaise: 0,
          committedTxnCount: 2,
          recentTxnEpochMs: [NOW - 61_000, NOW - 90_000],
        },
      }),
    );
    expect(d.allowed).toBe(true);
  });

  it("denies zero and negative quantities", () => {
    expect(evaluatePolicy(baseInput({ quantity: 0 })).allowed).toBe(false);
    expect(evaluatePolicy(baseInput({ quantity: -1 })).allowed).toBe(false);
  });

  it("runs ALL checks even after one fails — the audit sees the full picture", () => {
    const d = evaluatePolicy(baseInput({ mandateStatus: "revoked", quantity: 50 }));
    expect(d.checks.length).toBe(11);
    expect(d.checks.filter((c) => !c.passed).length).toBeGreaterThan(1);
  });
});
