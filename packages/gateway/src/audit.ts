import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { sha256Base64Url, type AuditEventType } from "@kuwo/shared";

/**
 * Append-only, hash-chained audit log (JSONL).
 *
 * Each entry's hash covers its content AND the previous entry's hash, so
 * editing or deleting any line breaks every hash after it. This makes the
 * log tamper-EVIDENT — stronger than "append-only by convention", and the
 * property the evidence pack leans on. Verification is a pure walk over
 * the file; no trusted state needed beyond the file itself.
 */

export interface AuditEntry {
  seq: number;
  ts: string;
  type: AuditEventType;
  data: Record<string, unknown>;
  prev: string;
  hash: string;
}

const GENESIS = "genesis";

function entryHash(seq: number, ts: string, type: string, data: Record<string, unknown>, prev: string): string {
  return sha256Base64Url(JSON.stringify([seq, ts, type, data, prev]));
}

export class AuditChain {
  private lastSeq = 0;
  private lastHash = GENESIS;

  constructor(readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) {
      const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        const last = JSON.parse(lastLine) as AuditEntry;
        this.lastSeq = last.seq;
        this.lastHash = last.hash;
      }
    }
  }

  append(type: AuditEventType, data: Record<string, unknown>): AuditEntry {
    const entry: AuditEntry = {
      seq: this.lastSeq + 1,
      ts: new Date().toISOString(),
      type,
      data,
      prev: this.lastHash,
      hash: "",
    };
    entry.hash = entryHash(entry.seq, entry.ts, entry.type, entry.data, entry.prev);
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    this.lastSeq = entry.seq;
    this.lastHash = entry.hash;
    return entry;
  }

  static readAll(filePath: string): AuditEntry[] {
    if (!existsSync(filePath)) return [];
    return readFileSync(filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEntry);
  }

  /** Walk the chain from genesis; report the first broken link, if any. */
  static verifyFile(filePath: string): { valid: boolean; count: number; brokenAtSeq?: number } {
    const entries = AuditChain.readAll(filePath);
    let prev = GENESIS;
    for (const e of entries) {
      const expected = entryHash(e.seq, e.ts, e.type, e.data, e.prev);
      if (e.prev !== prev || e.hash !== expected) {
        return { valid: false, count: entries.length, brokenAtSeq: e.seq };
      }
      prev = e.hash;
    }
    return { valid: true, count: entries.length };
  }
}
