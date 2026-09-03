# Kuwo

**Intent-bound agentic commerce gateway on Razorpay.** AI buyers will buy the wrong thing. Spending caps block the ₹45,000 mistake — not the ₹2,499 *wrong* purchase. Kuwo binds every purchase to provable human intent, gates every rupee through a deterministic policy engine, and produces dispute-grade evidence of who authorized what.

> The AI that judges is not the AI that shops. The LLM can be fooled; the money answers to signatures, bounds, and provable intent.

Built for the **Razorpay AI Buildathon 2026 — Track 01: AI Growth & Agentic Commerce**.

## Where the bar is (positioning honesty)

Razorpay has shipped consent-based agentic payments (UPI Reserve Pay spending limits), and mandates + caps + audit logs already exist in public buildathon entries. Kuwo treats all of that as the **baseline**. What we add on top:

1. **Intent-bound mandates** — the mandate carries not just caps, but the human's stated goal, compiled into signed constraints. The agent can only spend on what it can justify against that intent.
2. **A two-stage gate** — a deterministic policy engine (zero AI), then an *isolated* intent-verifier LLM that never sees merchant free-text, so injection can't reach the judge.
3. **An honest attack ladder** — including the sub-cap attack that caps-only systems approve. We name our own failure mode on camera.
4. **Dispute-grade evidence packs** — the audit trail made load-bearing: cryptographic proof of who authorized what, ready for a chargeback response.
5. **Concurrency-safe money code** — reserve→commit budget transactions, idempotency keys on payment retries.

## Status

🚧 Layer 0 — validating the Razorpay test-mode payment leg (`pnpm probe:f0`). Findings land in the "What broke" table below.

## Quickstart

```bash
pnpm install
cp .env.example .env   # add Razorpay TEST keys + Anthropic key
pnpm probe:f0          # verify the payment leg works on your account
```

## What broke (Failure Recovery log)

Honest, running list of what failed during the build and how we handled it. Started empty on purpose; entries get added as they happen.

| # | What broke | How we handled it |
|---|---|---|
| — | *(nothing yet)* | |
