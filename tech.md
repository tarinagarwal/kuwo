# Kuwo — Tech Stack (short)

| Piece | Tech | Why (one line — this is our panel answer) |
|---|---|---|
| Language | **TypeScript (Node.js 20+)** | One language across agent, gateway, storefront; types = trust in the money path |
| Monorepo | **pnpm workspaces** | `packages/gateway`, `packages/storefront`, `packages/buyer-agent`, `packages/shared` |
| Merchant storefront | **MCP server** (`@modelcontextprotocol/sdk`) + **Fastify** REST | MCP = the standard way agents discover tools; REST kept for the x402-style flow |
| Buyer agent LLM | **Claude API** (`@anthropic-ai/sdk`) | Tool-use loop for discovery + selection ONLY — never in the payment path |
| Intent verifier LLM | **Claude API**, separate isolated call | Judges product-vs-intent match; sees ONLY structured fields + signed intent, never merchant free-text; conservative (low confidence = deny) |
| Payments | **Razorpay Node SDK** (test mode) | Orders, payments, refunds; **idempotency keys on every attempt** — track requirement, validated headless on day one (F0) |
| Policy engine | **Pure TypeScript + Zod** | Deterministic, unit-tested, zero AI — the core defensibility claim |
| Signing (offers, mandates, intent) | **Ed25519** (`tweetnacl` / Node `crypto`) | Signed offers (quote=charge), signed intent-bound mandates; honest about what each proves |
| Trust registry | Tiny Fastify service + SQLite table | Simulated NPCI/UAP trust layer: registered merchant pubkeys; unregistered = denied |
| Database | **SQLite** (`better-sqlite3`) | Zero-setup for judges; orders, mandates, spend counters with **transactional reserve→commit** (no parallel double-spend) |
| Audit log | **Hash-chained JSONL** (own ~100 lines of code) | Tamper-evident; feeds `explain` and the **evidence pack** (`evidence <order_id>` → JSON + printable markdown chargeback-grade proof) |
| CLI | **commander** + **chalk** | `kuwo init / mandate / buy / explain / evidence / refund` |
| Dashboard (Layer 3) | **Next.js** (read-only) | Only for the pitch video; not load-bearing |
| Testing | **Vitest** | Policy engine gets exhaustive unit tests — that's where the trust lives |
| Config/secrets | **dotenv** | Razorpay test keys, Anthropic key |

## Rules we follow (mini-principles)
1. **No LLM in the payment path.** The shopping LLM proposes; the deterministic policy engine + an isolated verifier dispose. The AI that judges is not the AI that shops.
2. **Everything that moves money is signed, checked, reserved, and logged** — in that order.
3. **Money code is concurrency-safe**: transactional reserve→commit budgets, idempotency keys on retries.
4. **SQLite + JSONL over cloud infra** — judges must be able to `git clone && pnpm i && pnpm demo` and see money move in under 5 minutes.
5. **Every external call (Razorpay, Claude) has a timeout, a retry cap, and a logged failure path.**
6. **Name our own limitations before the panel does** — simulated registry, probabilistic verifier, whatever the test-mode payment leg required.
