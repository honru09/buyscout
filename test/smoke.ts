// Smoke test: boots the server in mock PayPal mode and drives the whole
// BuyScout flow over HTTP:
//
//   1. mission above market price          -> keeps watching, nothing happens
//   2. price drops below target, over cap   -> checkout parked in approvals
//   3. human approves                       -> PayPal order created + captured
//   4. refund                               -> money reversed, audit trail complete
//   5. second mission priced under the cap  -> auto-buy, no approval needed
//
// Run: npm run smoke

import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 4399;
const BASE = `http://localhost:${PORT}`;
const dataFile = join(tmpdir(), `buyscout-smoke-${Date.now()}.json`);
const appDir = join(fileURLToPath(import.meta.url), "..", "..");

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${extra !== undefined ? ` — got: ${JSON.stringify(extra)}` : ""}`);
  }
}

async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function waitForServer(proc: ChildProcess): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited early with code ${proc.exitCode}`);
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not come up in time");
}

async function main(): Promise<void> {
  rmSync(dataFile, { force: true });
  const proc = spawn("node", ["src/server.ts"], {
    cwd: appDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      BUYSCOUT_DATA: dataFile,
      PAYPAL_MODE: "mock",
      WATCH_INTERVAL_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForServer(proc);

    let state = await api("/api/state");
    check("server runs in mock PayPal mode", state.paypalMode === "mock", state.paypalMode);

    await api("/api/policy", "PUT", { autoBuyCap: 100 });

    console.log("\nMission A: over-cap approval path");
    const { mission: a } = await api("/api/missions", "POST", {
      text: "Buy Sony WH-1000XM5 headphones, target $120",
    });
    check("A parsed with target 120", a.targetPrice === 120, a.targetPrice);
    check("A parsed quantity 1", a.quantity === 1, a.quantity);
    check("A is watching (market price 149 > target)", a.status === "watching", a.status);

    await api("/api/tick", "POST");
    state = await api("/api/state");
    check("A still watching after tick", state.missions.find((m: any) => m.id === a.id)?.status === "watching");
    check("no orders yet", state.orders.length === 0, state.orders.length);
    check("no approvals yet", state.approvals.length === 0, state.approvals.length);

    // Seller drops the price to 110: under target (120) but total 110 > cap 100.
    await api("/api/simulate/price", "POST", { listingId: "lst_xm5", price: 110 });
    state = await api("/api/state");
    const missionA = state.missions.find((m: any) => m.id === a.id);
    const pendingA = state.approvals.find((x: any) => x.missionId === a.id && x.status === "pending");
    check("A parked in approval_pending", missionA?.status === "approval_pending", missionA?.status);
    check("approval created for A with total 110", !!pendingA && pendingA.total === 110, pendingA);
    check("still no orders before approval", state.orders.length === 0, state.orders.length);

    await api(`/api/approvals/${pendingA.id}/approve`, "POST");
    state = await api("/api/state");
    const missionA2 = state.missions.find((m: any) => m.id === a.id);
    const orderA = state.orders.find((o: any) => o.missionId === a.id);
    check("A purchased after approval", missionA2?.status === "purchased", missionA2?.status);
    check("order captured (COMPLETED)", orderA?.status === "COMPLETED", orderA?.status);
    check("order has a capture id", !!orderA?.captureId, orderA?.captureId);
    check("audit has price_hit for A", state.audit.some((e: any) => e.missionId === a.id && e.event === "price_hit"));
    check("audit has approval_requested for A", state.audit.some((e: any) => e.missionId === a.id && e.event === "approval_requested"));
    check("audit has order_captured for A", state.audit.some((e: any) => e.missionId === a.id && e.event === "order_captured"));

    await api(`/api/orders/${orderA.id}/refund`, "POST");
    state = await api("/api/state");
    const missionA3 = state.missions.find((m: any) => m.id === a.id);
    const orderA2 = state.orders.find((o: any) => o.missionId === a.id);
    check("A refunded", missionA3?.status === "refunded", missionA3?.status);
    check("order marked REFUNDED with refund id", orderA2?.status === "REFUNDED" && !!orderA2?.refundId, orderA2);
    check("audit has refund_issued for A", state.audit.some((e: any) => e.missionId === a.id && e.event === "refund_issued"));

    console.log("\nMission B: under-cap auto-buy path");
    const { mission: b } = await api("/api/missions", "POST", {
      text: "Get a LEGO Icons Bonsai Tree set under $80",
    });
    state = await api("/api/state");
    const missionB = state.missions.find((m: any) => m.id === b.id);
    const orderB = state.orders.find((o: any) => o.missionId === b.id);
    check("B auto-purchased (59.99 <= cap 100)", missionB?.status === "purchased", missionB?.status);
    check("B order captured via auto path", orderB?.status === "COMPLETED" && orderB?.via === "auto", orderB);
    check("no approval was created for B", !state.approvals.some((x: any) => x.missionId === b.id));
    check("audit has auto_buy for B", state.audit.some((e: any) => e.missionId === b.id && e.event === "auto_buy"));

    console.log(failures === 0 ? "\nSMOKE TEST: ALL CHECKS PASSED" : `\nSMOKE TEST: ${failures} CHECK(S) FAILED`);
  } finally {
    proc.kill("SIGTERM");
    rmSync(dataFile, { force: true });
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("SMOKE TEST ERROR:", err);
  process.exit(1);
});
