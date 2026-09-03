/**
 * F0 — Day-one payment-leg validation (Flow 0 in flow.md).
 *
 * Answers ONE question before any feature code is written:
 * can this Razorpay TEST-MODE account take a payment all the way to
 * `captured` with no human clicking a checkout page?
 *
 * Probes, in order:
 *   1. AUTH        GET  /v1/payments?count=1        — are the keys valid?
 *   2. ORDER       POST /v1/orders                  — can we create orders?
 *   3. S2S JSON    POST /v1/payments/create/json    — headless card payment
 *                                                     (needs an account feature flag)
 *   4. PAY LINK    POST /v1/payment_links           — universal fallback
 *                                                     (works, but needs a click →
 *                                                      would require scripted checkout)
 *
 * Exit code 0 = a viable payment leg exists (green or yellow verdict).
 * Exit code 1 = keys invalid / nothing viable (red verdict).
 */
import "dotenv/config";

const BASE = "https://api.razorpay.com/v1";
const TIMEOUT_MS = 15_000;

const keyId = process.env.RAZORPAY_KEY_ID ?? "";
const keySecret = process.env.RAZORPAY_KEY_SECRET ?? "";

// Safety rail: this project must never touch live mode.
if (!keyId || !keySecret) {
  console.error("Missing RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET. Copy .env.example to .env and fill in TEST keys.");
  process.exit(1);
}
if (!keyId.startsWith("rzp_test_")) {
  console.error(`Refusing to run: key "${keyId.slice(0, 12)}..." is not a test-mode key (rzp_test_...).`);
  process.exit(1);
}

const auth = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");

interface ProbeResult {
  status: number;
  body: unknown;
}

async function rzp(method: "GET" | "POST", path: string, payload?: unknown): Promise<ProbeResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: payload === undefined ? null : JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = await res.text().catch(() => "<unreadable body>");
  }
  return { status: res.status, body };
}

function errorDescription(body: unknown): string {
  const err = (body as { error?: { code?: string; description?: string } })?.error;
  return err ? `${err.code ?? "?"}: ${err.description ?? "?"}` : JSON.stringify(body).slice(0, 200);
}

type Outcome = "PASS" | "FAIL" | "NOT_ENABLED";
const results: { probe: string; outcome: Outcome; detail: string }[] = [];

function record(probe: string, outcome: Outcome, detail: string) {
  results.push({ probe, outcome, detail });
  const icon = outcome === "PASS" ? "✅" : outcome === "NOT_ENABLED" ? "🟡" : "❌";
  console.log(`${icon} ${probe}: ${outcome} — ${detail}`);
}

async function main() {
  console.log(`Kuwo F0 payment-leg probe — test key ${keyId.slice(0, 12)}...\n`);

  // Probe 1: auth
  const authRes = await rzp("GET", "/payments?count=1");
  if (authRes.status === 200) {
    record("1 AUTH", "PASS", "keys valid, API reachable");
  } else {
    record("1 AUTH", "FAIL", `HTTP ${authRes.status} — ${errorDescription(authRes.body)}`);
    finish();
    return;
  }

  // Probe 2: order creation
  const orderRes = await rzp("POST", "/orders", {
    amount: 179900, // ₹1,799 in paise — mirrors the demo purchase
    currency: "INR",
    receipt: `kuwo-f0-${Date.now()}`,
    notes: { purpose: "kuwo F0 payment-leg probe" },
  });
  const orderId = (orderRes.body as { id?: string })?.id;
  if (orderRes.status === 200 && orderId) {
    record("2 ORDER", "PASS", `created ${orderId}`);
  } else {
    record("2 ORDER", "FAIL", `HTTP ${orderRes.status} — ${errorDescription(orderRes.body)}`);
    finish();
    return;
  }

  // Probe 3: S2S JSON card payment (the fully-headless path; gated by account feature)
  const s2sRes = await rzp("POST", "/payments/create/json", {
    amount: 179900,
    currency: "INR",
    order_id: orderId,
    email: "f0-probe@kuwo.test",
    contact: "+919999999999",
    method: "card",
    card: {
      number: "4111111111111111", // Razorpay test card
      name: "Kuwo Probe",
      expiry_month: "12",
      expiry_year: "29",
      cvv: "123",
    },
  });
  if (s2sRes.status === 200) {
    const s2sBody = s2sRes.body as { razorpay_payment_id?: string; next?: unknown };
    record(
      "3 S2S JSON",
      "PASS",
      `payment created${s2sBody.razorpay_payment_id ? ` (${s2sBody.razorpay_payment_id})` : ""}` +
        (s2sBody.next ? `; next steps: ${JSON.stringify(s2sBody.next).slice(0, 150)}` : "; no further steps"),
    );
  } else {
    const desc = errorDescription(s2sRes.body);
    const featureGated = /not enabled|not allowed|s2s|feature|access denied/i.test(desc);
    record("3 S2S JSON", featureGated ? "NOT_ENABLED" : "FAIL", `HTTP ${s2sRes.status} — ${desc}`);
  }

  // Probe 4: payment link (universal fallback; completing it needs a click)
  const linkRes = await rzp("POST", "/payment_links", {
    amount: 179900,
    currency: "INR",
    description: "Kuwo F0 probe link",
    notes: { purpose: "kuwo F0 payment-leg probe" },
  });
  const linkBody = linkRes.body as { id?: string; short_url?: string };
  if (linkRes.status === 200 && linkBody.id) {
    record("4 PAY LINK", "PASS", `created ${linkBody.id} → ${linkBody.short_url ?? "?"}`);
  } else {
    record("4 PAY LINK", "FAIL", `HTTP ${linkRes.status} — ${errorDescription(linkRes.body)}`);
  }

  finish();
}

function finish() {
  const get = (probe: string) => results.find((r) => r.probe.startsWith(probe))?.outcome;
  console.log("\n— VERDICT —");

  if (get("1") !== "PASS") {
    console.log("🔴 RED: keys invalid or API unreachable. Fix .env before anything else.");
    process.exit(1);
  }
  if (get("3") === "PASS") {
    console.log("🟢 GREEN: S2S is enabled — fully headless payments possible. Payment executor uses S2S JSON flow.");
  } else if (get("2") === "PASS" && get("4") === "PASS") {
    console.log(
      "🟡 YELLOW: orders + payment links work, but S2S is not enabled.\n" +
        "   Payment executor options: (a) request S2S test access from Razorpay,\n" +
        "   (b) scripted standard-checkout with test card (Playwright) to reach `captured`,\n" +
        "   (c) payment links + webhook confirmation.\n" +
        "   Document the chosen path in docs/f0-findings.md — this is Failure Recovery material.",
    );
  } else {
    console.log("🔴 RED: no viable payment leg found. Investigate account state before writing feature code.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Probe crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
