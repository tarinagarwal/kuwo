# Kuwo — Features (v2)

> **Thesis:** Spending caps don't make AI buyers safe. A cap blocks the ₹45,000 mistake, but not the ₹2,499 *wrong* purchase — the sub-cap error, the redirected merchant, the SKU the user never wanted. Kuwo binds every purchase to **provable human intent**, and when something still goes wrong, produces a **dispute-grade evidence pack** proving exactly who authorized what. Caps are table stakes; intent + accountability is the product.

**Positioning honesty (goes in the README):** Razorpay has shipped consent-based agentic payments (UPI Reserve Pay spending limits) and other buildathon entries implement mandates + caps + audit logs. We treat all of that as the *baseline* and build on top of it: intent-bound mandates, an honest sub-cap attack demo, concurrency-safe money code, and chargeback-grade evidence.

Features are grouped in **layers**. Each layer is a complete, demoable checkpoint — stop after any layer and we still have a submittable project.

---

## Layer 0 — Day-one validation (before any feature code)

### F0. Prove the payment leg on Razorpay test mode
- Verify we can complete an order → payment → captured state **headlessly** (no human clicking a checkout page). Options to test, in order: S2S APIs, test-card automation, payment links + scripted confirmation.
- Whatever works becomes the payment executor; whatever doesn't gets documented honestly in the README ("what broke" — judges score Failure Recovery).
- **If this is mocked, nothing else matters. Validate first.**

---

## Layer 1 — The Core

### F1. Agent-readable merchant storefront
- Merchant provides a product catalog (JSON/CSV).
- Served as an **MCP server**: `search_products`, `get_offer`, `create_order`, `get_order_status`.
- Offers are signed by the merchant. **Honest claim:** the signature binds quote-to-charge (the price the agent saw is the price charged). It does *not* prove the merchant is honest — that's what the trust registry (F7) is for. We say this out loud.

### F2. Intent-bound mandates (the differentiator — not just caps)
- A human issues a mandate that carries **both**:
  - **Bounds** (baseline): total budget, per-transaction cap, expiry, max transactions, velocity limit.
  - **Intent** (our addition): the user's stated goal ("wireless earbuds under ₹2000, one unit"), compiled at issue-time into signed structured constraints — category, keyword set, quantity limit, price ceiling — plus a hash of the original sentence.
- The agent can only spend money on things it can justify **against the signed intent**, not merely under the cap.
- CLI: `kuwo mandate create "wireless earbuds under ₹2000"` → prints signed mandate. Revocable.

### F3. Two-stage gate: deterministic policy engine + isolated intent verifier
- **Stage 1 — policy engine (pure TypeScript, zero AI):** mandate signature/revocation/expiry, per-txn cap, budget (see F4), category, quantity, velocity, merchant-in-registry. `ALLOW / DENY(reason)`.
- **Stage 2 — intent verifier (isolated LLM, only for the fuzzy part):** does this product actually match the signed intent? Runs in a **separate context** that never sees merchant free-text (injection can't reach it — it gets only structured product fields + the signed intent). Conservative: low confidence = DENY. Verdict + reasoning logged.
- Panel answer baked in: deterministic where possible, AI only where matching is genuinely fuzzy, and the AI that judges is not the AI that shops.

### F4. Concurrency-safe money code
- Budget counter uses **transactional reserve → commit/release** (SQLite transaction): two parallel orders can't both pass the budget check.
- Payment retries carry **idempotency keys** — a timeout that actually succeeded can't double-charge.
- These two details are cheap to build and exactly what a payments panel probes for.

### F5. Payment execution on Razorpay test mode
- Whatever F0 proved: order → payment → captured, with state machine (created/authorized/captured/failed).
- On failure: bounded retry (max 2, idempotent), then clean abort with reason.

### F6. Audit trail → evidence pack ("who eats the loss?")
- Append-only, hash-chained log of every step: intent → discovery → offer → both gate stages → payment attempts → result.
- `kuwo explain <order_id>` — the human-readable story of any transaction.
- **`kuwo evidence <order_id>`** — exports a **dispute-grade evidence pack** (JSON + printable markdown): the signed mandate, the signed intent, the signed offer, every check that passed, the hash-chain proof of integrity. This is the artifact a merchant would attach to a chargeback response — the audit trail made *load-bearing*, not ornamental. (UAP's open liability question is our "why now".)

### F7. Trust registry (simulated, and labeled as such)
- A small registry service where merchant pubkeys are registered out-of-band; the policy engine rejects orders to unregistered merchants.
- Modeled on NPCI/UAP's trust-layer direction; README states plainly it's a simulation of that role.

### F8. Buyer agent (demo driver)
- CLI: `kuwo buy` (shops under an existing mandate). LLM handles discovery + selection only; it cannot reach the payment path except through both gates.
- Narrates every step; everything it does lands in the audit trail.

---

## Layer 2 — The Attack Ladder (the demo that names its own failure mode)

### F9. Attack 1 — crude over-cap injection → **cap blocks it**
- Malicious listing tells the agent to buy 50 units (₹45,000). Per-txn cap denies. Baseline works; we call it the *easy* case on camera.

### F10. Attack 2 — sub-cap wrong purchase → **caps do NOT block it; intent binding does**
- Malicious listing manipulates the agent into a ₹2,499 purchase of the wrong product (under every cap).
- We say out loud: *"every caps-only system approves this."* Then the intent verifier denies it: product doesn't match the signed intent. This honest beat is the heart of the pitch.

### F11. Attack 3 — merchant redirect → **trust registry blocks it**
- Injected listing steers the agent toward the attacker's own unregistered storefront with a matching product. Policy engine: merchant not in registry → DENY, merchant flagged, attempt logged.

### F12. Multi-merchant comparison shopping
- Agent compares signed offers across registered merchants, buys the best; comparison reasoning logged.

### F13. Merchant onboarding CLI
- `kuwo init --catalog products.json` → keys, signed catalog, registry entry, storefront up. Any merchant becomes agent-transactable in one command.

---

## Layer 3 — Wow Layer (only after Layers 0–2 are bulletproof)

### F14. Agent-to-agent negotiation (bounded haggling)
- Merchant selling agent with deterministic pricing policy (floor, inventory pressure) vs. buyer agent with its mandate. LLMs propose; policy engines enforce floor and cap. Full transcript in the audit trail; converge or clean walk-away.

### F15. Web dashboard (read-only, for the video)
- Live orders, mandate spend remaining, gate decisions, flagged merchants, hash-chain status.

### F16. Refund / dispute flow
- `refund <order_id>` through the same gated pipeline, on Razorpay test-mode refund API — and the evidence pack (F6) is what makes the dispute decidable.

---

## Explicitly OUT of scope (README section — scoping is taste)
- Real money / live-mode keys — test mode only.
- Production key management (local Ed25519 keypairs; stated).
- A real NPCI/UAP integration — our registry simulates that role and says so.
- Shipping/logistics — captured payment + confirmation ends our loop.
- Multi-tenant SaaS/auth — single demo human, keys in config.

## Known limitations we state before the panel asks (this is a feature)
- Intent verification is probabilistic — it narrows the sub-cap attack surface, doesn't eliminate it. We show the residual risk instead of hiding it.
- Offer signatures bind quote-to-charge only; merchant honesty comes from the registry, which is simulated.
- The payment leg uses whatever F0 proved possible in test mode; any workaround is documented, not disguised.
