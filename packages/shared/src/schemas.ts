import { z } from "zod";

/**
 * Every money value in Kuwo is an integer amount in paise.
 * Floats never touch the money path.
 */
export const Paise = z.number().int().nonnegative();

export const ProductSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  category: z.string().min(1),
  price_paise: Paise,
  currency: z.literal("INR"),
  quantity_available: z.number().int().nonnegative(),
  merchant_id: z.string().min(1),
});
export type Product = z.infer<typeof ProductSchema>;

/**
 * The human's stated goal, compiled at mandate-issue time into constraints
 * the gate can check. `raw_text_sha256` pins the constraints to the exact
 * sentence the human typed.
 */
export const IntentConstraintsSchema = z.object({
  raw_text: z.string().min(1),
  raw_text_sha256: z.string().min(1),
  category: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
  max_price_paise: Paise,
  max_quantity: z.number().int().positive(),
});
export type IntentConstraints = z.infer<typeof IntentConstraintsSchema>;

export const MandateBoundsSchema = z.object({
  budget_paise: Paise,
  per_txn_cap_paise: Paise,
  max_txns: z.number().int().positive(),
  max_txns_per_minute: z.number().int().positive(),
});
export type MandateBounds = z.infer<typeof MandateBoundsSchema>;

/**
 * AP2-shaped mandate payload: issued by the human (`iss`) to one agent
 * (`sub`), with the agent's public key bound via `cnf.jwk`. Standard JWT
 * claims (`iat`, `exp`) ride alongside — hence the catchall.
 */
export const MandatePayloadSchema = z
  .object({
    iss: z.string().min(1),
    sub: z.string().min(1),
    jti: z.string().min(1),
    cnf: z.object({ jwk: z.record(z.string(), z.unknown()) }),
    bounds: MandateBoundsSchema,
    intent: IntentConstraintsSchema,
  })
  .catchall(z.unknown());
export type MandatePayload = z.infer<typeof MandatePayloadSchema>;

/**
 * A merchant's signed quote. What the agent sees is what gets charged:
 * the gateway only executes payments whose amount matches a verified offer.
 */
export const OfferPayloadSchema = z
  .object({
    iss: z.string().min(1), // merchant id
    jti: z.string().min(1), // offer id
    product_id: z.string().min(1),
    name: z.string().min(1),
    category: z.string().min(1),
    price_paise: Paise,
    currency: z.literal("INR"),
    quantity_available: z.number().int().nonnegative(),
  })
  .catchall(z.unknown());
export type OfferPayload = z.infer<typeof OfferPayloadSchema>;

export const GateCheckSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});
export type GateCheck = z.infer<typeof GateCheckSchema>;

export const GateDecisionSchema = z.object({
  allowed: z.boolean(),
  stage: z.enum(["policy", "intent"]),
  checks: z.array(GateCheckSchema),
  reason: z.string().optional(),
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;

/** Audit event taxonomy — every step that matters gets exactly one name. */
export const AUDIT_EVENT_TYPES = [
  "MANDATE_CREATED",
  "MANDATE_REVOKED",
  "INTENT_PLANNED",
  "CATALOG_SEARCHED",
  "OFFER_VERIFIED",
  "OFFER_COMPARISON",
  "ORDER_REQUESTED",
  "POLICY_CHECK_PASSED",
  "POLICY_CHECK_FAILED",
  "INTENT_CHECK_PASSED",
  "INTENT_CHECK_FAILED",
  "BUDGET_RESERVED",
  "BUDGET_COMMITTED",
  "BUDGET_RELEASED",
  "RZP_ORDER_CREATED",
  "PAYMENT_ATTEMPTED",
  "PAYMENT_AUTHORIZED",
  "PAYMENT_CAPTURED",
  "PAYMENT_FAILED",
  "ORDER_CONFIRMED",
  "MERCHANT_FLAGGED",
  "ATTACK_BLOCKED",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
