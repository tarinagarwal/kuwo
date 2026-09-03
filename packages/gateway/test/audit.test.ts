import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditChain } from "../src/audit.js";

function tmpLog(): string {
  return join(mkdtempSync(join(tmpdir(), "kuwo-audit-")), "audit.jsonl");
}

describe("hash-chained audit log", () => {
  it("appends entries linked by hash and verifies clean", () => {
    const path = tmpLog();
    const chain = new AuditChain(path);
    chain.append("MANDATE_CREATED", { jti: "mandate_001", budget_paise: 500000 });
    chain.append("ORDER_REQUESTED", { offer: "offer_001", amount_paise: 179900 });
    chain.append("PAYMENT_CAPTURED", { payment_id: "pay_123" });

    const result = AuditChain.verifyFile(path);
    expect(result).toEqual({ valid: true, count: 3 });

    const entries = AuditChain.readAll(path);
    expect(entries[0]!.prev).toBe("genesis");
    expect(entries[1]!.prev).toBe(entries[0]!.hash);
    expect(entries[2]!.prev).toBe(entries[1]!.hash);
  });

  it("detects a tampered entry (amount quietly edited)", () => {
    const path = tmpLog();
    const chain = new AuditChain(path);
    chain.append("MANDATE_CREATED", { jti: "mandate_001" });
    chain.append("ORDER_REQUESTED", { amount_paise: 179900 });
    chain.append("PAYMENT_CAPTURED", { payment_id: "pay_123" });

    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const doctored = JSON.parse(lines[1]!);
    doctored.data.amount_paise = 100; // rewrite history: claim ₹1 was authorized
    lines[1] = JSON.stringify(doctored);
    writeFileSync(path, lines.join("\n") + "\n");

    const result = AuditChain.verifyFile(path);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(2);
  });

  it("detects a deleted entry", () => {
    const path = tmpLog();
    const chain = new AuditChain(path);
    chain.append("MANDATE_CREATED", { jti: "m1" });
    chain.append("POLICY_CHECK_FAILED", { reason: "budget_available" }); // the entry an attacker wants gone
    chain.append("PAYMENT_CAPTURED", { payment_id: "pay_123" });

    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    writeFileSync(path, [lines[0], lines[2]].join("\n") + "\n");

    expect(AuditChain.verifyFile(path).valid).toBe(false);
  });

  it("resumes the chain across restarts without breaking it", () => {
    const path = tmpLog();
    const first = new AuditChain(path);
    first.append("MANDATE_CREATED", { jti: "m1" });

    const second = new AuditChain(path); // process restart
    second.append("ORDER_CONFIRMED", { order: "o1" });

    expect(AuditChain.verifyFile(path)).toEqual({ valid: true, count: 2 });
  });
});
