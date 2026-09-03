import { describe, it, expect } from "vitest";
import {
  generateSigningKeypair,
  signMandate,
  verifyMandate,
  signOffer,
  verifyOffer,
  sha256Base64Url,
  hashToken,
  type SigningKeypair,
} from "../src/crypto.js";
import type { MandatePayload, OfferPayload } from "../src/schemas.js";

function demoMandate(agentJwk: Record<string, unknown>): MandatePayload {
  const rawText = "wireless earbuds under ₹2000, one unit";
  return {
    iss: "user_demo",
    sub: "agent_kuwo_buyer",
    jti: "mandate_001",
    cnf: { jwk: agentJwk },
    bounds: {
      budget_paise: 500000,
      per_txn_cap_paise: 250000,
      max_txns: 3,
      max_txns_per_minute: 2,
    },
    intent: {
      raw_text: rawText,
      raw_text_sha256: sha256Base64Url(rawText),
      category: "electronics",
      keywords: ["wireless", "earbuds"],
      max_price_paise: 200000,
      max_quantity: 1,
    },
  };
}

function demoOffer(): OfferPayload {
  return {
    iss: "merchant_a",
    jti: "offer_001",
    product_id: "prod_airdopes_141",
    name: "boAt Airdopes 141",
    category: "electronics",
    price_paise: 179900,
    currency: "INR",
    quantity_available: 12,
  };
}

describe("mandate signing", () => {
  let user: SigningKeypair;
  let agent: SigningKeypair;

  it("round-trips: sign then verify preserves bounds and intent", async () => {
    user = await generateSigningKeypair();
    agent = await generateSigningKeypair();

    const token = await signMandate(demoMandate(agent.publicJwk as Record<string, unknown>), user.privateJwk, "24h");
    const verified = await verifyMandate(token, user.publicJwk);

    expect(verified.bounds.budget_paise).toBe(500000);
    expect(verified.bounds.per_txn_cap_paise).toBe(250000);
    expect(verified.intent.max_price_paise).toBe(200000);
    expect(verified.intent.keywords).toEqual(["wireless", "earbuds"]);
    expect(verified.cnf.jwk).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(verified["exp"]).toBeTypeOf("number");
  });

  it("rejects a tampered token", async () => {
    const token = await signMandate(demoMandate(agent.publicJwk as Record<string, unknown>), user.privateJwk, "24h");
    const [header, payload, sig] = token.split(".") as [string, string, string];
    const raised = JSON.parse(Buffer.from(payload, "base64url").toString());
    raised.bounds.budget_paise = 99999900; // attacker raises their own budget
    const tampered = [header, Buffer.from(JSON.stringify(raised)).toString("base64url"), sig].join(".");

    await expect(verifyMandate(tampered, user.publicJwk)).rejects.toThrow();
  });

  it("rejects a token signed by the wrong key", async () => {
    const impostor = await generateSigningKeypair();
    const token = await signMandate(demoMandate(agent.publicJwk as Record<string, unknown>), impostor.privateJwk, "24h");

    await expect(verifyMandate(token, user.publicJwk)).rejects.toThrow();
  });

  it("rejects an expired mandate", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const token = await signMandate(demoMandate(agent.publicJwk as Record<string, unknown>), user.privateJwk, past);

    await expect(verifyMandate(token, user.publicJwk)).rejects.toThrow(/exp|expired/i);
  });

  it("rejects an offer token presented as a mandate (credential-type confusion)", async () => {
    const merchant = await generateSigningKeypair();
    const offerToken = await signOffer(demoOffer(), merchant.privateJwk, "1h");

    await expect(verifyMandate(offerToken, merchant.publicJwk)).rejects.toThrow(/credential type mismatch/);
  });
});

describe("offer signing", () => {
  it("round-trips and binds quote to charge", async () => {
    const merchant = await generateSigningKeypair();
    const token = await signOffer(demoOffer(), merchant.privateJwk, "1h");
    const verified = await verifyOffer(token, merchant.publicJwk);

    expect(verified.price_paise).toBe(179900);
    expect(verified.iss).toBe("merchant_a");
  });

  it("rejects an offer with a swapped price", async () => {
    const merchant = await generateSigningKeypair();
    const token = await signOffer(demoOffer(), merchant.privateJwk, "1h");
    const [header, payload, sig] = token.split(".") as [string, string, string];
    const lowered = JSON.parse(Buffer.from(payload, "base64url").toString());
    lowered.price_paise = 100; // buyer-side tampering: pay ₹1 for ₹1,799 earbuds
    const tampered = [header, Buffer.from(JSON.stringify(lowered)).toString("base64url"), sig].join(".");

    await expect(verifyOffer(tampered, merchant.publicJwk)).rejects.toThrow();
  });

  it("rejects an offer signed by a different merchant's key", async () => {
    const merchantA = await generateSigningKeypair();
    const merchantB = await generateSigningKeypair();
    const token = await signOffer(demoOffer(), merchantA.privateJwk, "1h");

    await expect(verifyOffer(token, merchantB.publicJwk)).rejects.toThrow();
  });
});

describe("hashing", () => {
  it("is deterministic and tamper-sensitive", () => {
    expect(sha256Base64Url("kuwo")).toBe(sha256Base64Url("kuwo"));
    expect(sha256Base64Url("kuwo")).not.toBe(sha256Base64Url("kuw0"));
    expect(hashToken).toBe(sha256Base64Url);
  });
});
