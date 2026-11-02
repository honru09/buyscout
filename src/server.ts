// BuyScout server: JSON API + single-page UI, zero external dependencies.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Store, newId, round2 } from "./store.ts";
import { LocalCatalog } from "./catalog.ts";
import { createPayPalClient } from "./paypal.ts";
import { parseMission } from "./parser.ts";
import { Agent } from "./agent.ts";
import type { Mission } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const dataFile = process.env.BUYSCOUT_DATA || join(appRoot, "data", "store.json");
const indexHtml = readFileSync(join(appRoot, "public", "index.html"), "utf8");

const store = new Store(dataFile);
const catalog = new LocalCatalog();
const paypal = createPayPalClient();
const agent = new Agent(store, catalog, paypal);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;
  const method = req.method || "GET";

  if (method === "GET" && path === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(indexHtml);
    return;
  }

  if (method === "GET" && path === "/api/state") {
    sendJson(res, 200, {
      paypalMode: paypal.mode,
      policy: store.data.policy,
      missions: store.data.missions,
      approvals: store.data.approvals,
      orders: store.data.orders,
      audit: [...store.data.audit].reverse(),
      listings: catalog.list(),
    });
    return;
  }

  if (method === "POST" && path === "/api/parse") {
    const body = await readBody(req);
    const text = String(body.text || "");
    if (!text.trim()) return sendJson(res, 400, { error: "text is required" });
    const parsed = await parseMission(text);
    sendJson(res, 200, { parsed });
    return;
  }

  if (method === "POST" && path === "/api/missions") {
    const body = await readBody(req);
    const text = String(body.text || "");
    if (!text.trim()) return sendJson(res, 400, { error: "text is required" });
    const parsed = await parseMission(text);
    if (parsed.targetPrice === null) {
      return sendJson(res, 400, {
        error: "No price found. Mention a target price, e.g. \"under $120\".",
        parsed,
      });
    }
    const now = new Date().toISOString();
    const mission: Mission = {
      id: newId("msn"),
      rawText: text,
      itemQuery: parsed.itemQuery,
      keywords: parsed.keywords,
      targetPrice: parsed.targetPrice,
      maxPrice: parsed.maxPrice ?? parsed.targetPrice,
      quantity: parsed.quantity,
      currency: parsed.currency,
      status: "watching",
      parseSource: parsed.source,
      listingId: null,
      lastPrice: null,
      orderId: null,
      paidTotal: null,
      createdAt: now,
      updatedAt: now,
    };
    store.data.missions.push(mission);
    store.audit(mission.id, "mission_created", `Mission created: "${mission.itemQuery}" target ${mission.currency} ${mission.targetPrice.toFixed(2)} x${mission.quantity} (parsed by ${parsed.source})`);
    store.save();
    await agent.tick();
    sendJson(res, 201, { mission });
    return;
  }

  const missionDelete = path.match(/^\/api\/missions\/([^/]+)$/);
  if (method === "DELETE" && missionDelete) {
    const id = missionDelete[1];
    const idx = store.data.missions.findIndex((m) => m.id === id);
    if (idx === -1) return sendJson(res, 404, { error: "mission not found" });
    store.data.missions.splice(idx, 1);
    store.audit(id, "mission_cancelled", "Mission removed by user");
    store.save();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "PUT" && path === "/api/policy") {
    const body = await readBody(req);
    const cap = Number(body.autoBuyCap);
    if (!Number.isFinite(cap) || cap < 0) return sendJson(res, 400, { error: "autoBuyCap must be a number >= 0" });
    store.data.policy.autoBuyCap = round2(cap);
    store.audit(null, "policy_updated", `Auto-buy cap set to ${store.data.policy.currency} ${store.data.policy.autoBuyCap.toFixed(2)}`);
    store.save();
    sendJson(res, 200, { policy: store.data.policy });
    return;
  }

  if (method === "POST" && path === "/api/tick") {
    await agent.tick();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && path === "/api/simulate/price") {
    const body = await readBody(req);
    const listingId = String(body.listingId || "");
    const price = Number(body.price);
    if (!listingId || !Number.isFinite(price) || price < 0) {
      return sendJson(res, 400, { error: "listingId and a non-negative price are required" });
    }
    const listing = catalog.setPrice(listingId, price);
    if (!listing) return sendJson(res, 404, { error: "listing not found" });
    store.audit(null, "price_simulated", `Catalog price of "${listing.title}" set to ${listing.currency} ${listing.price.toFixed(2)} (demo simulator)`);
    await agent.tick();
    sendJson(res, 200, { listing });
    return;
  }

  const approvalAction = path.match(/^\/api\/approvals\/([^/]+)\/(approve|reject)$/);
  if (method === "POST" && approvalAction) {
    try {
      const approval =
        approvalAction[2] === "approve"
          ? await agent.approve(approvalAction[1])
          : agent.reject(approvalAction[1]);
      sendJson(res, 200, { approval });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  const orderRefund = path.match(/^\/api\/orders\/([^/]+)\/refund$/);
  if (method === "POST" && orderRefund) {
    try {
      const record = await agent.refund(orderRefund[1]);
      sendJson(res, 200, { order: record });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

const port = Number(process.env.PORT || 4317);
const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  });
});

server.listen(port, () => {
  console.log(`BuyScout running at http://localhost:${port} (PayPal mode: ${paypal.mode})`);
});

// Background watcher. Set WATCH_INTERVAL_MS=0 to disable (tests drive ticks manually).
const intervalMs = Number(process.env.WATCH_INTERVAL_MS ?? 5000);
if (intervalMs > 0) {
  setInterval(() => {
    agent.tick().catch((err) => console.error("watch tick failed:", err));
  }, intervalMs);
}
