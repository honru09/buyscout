// Tiny JSON-file store. The whole app state lives in one file so the demo
// is trivial to reset: delete the file and restart.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StoreData, AuditEntry } from "./types.ts";

let counter = 0;

export function newId(prefix: string): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}${counter}`;
}

export class Store {
  private file: string;
  data: StoreData;

  constructor(file: string) {
    this.file = file;
    if (existsSync(file)) {
      this.data = JSON.parse(readFileSync(file, "utf8")) as StoreData;
    } else {
      this.data = {
        missions: [],
        approvals: [],
        orders: [],
        audit: [],
        policy: { autoBuyCap: 100, currency: "USD" },
      };
      this.save();
    }
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  audit(missionId: string | null, event: string, details: string): AuditEntry {
    const entry: AuditEntry = {
      id: newId("aud"),
      ts: new Date().toISOString(),
      missionId,
      event,
      details,
    };
    this.data.audit.push(entry);
    this.save();
    return entry;
  }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
