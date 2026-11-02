# BuyScout — an agentic commerce copilot with a spending-trust layer

**PayPal AI Hackathon entry** (submission deadline: Nov 12, 2026, 12:00 pm PT)
Target: Best Use of Agentic Commerce ($5,000) + the main prizes. Rules notes: [RULES.md](RULES.md)

## Concept

Everyone is building AI agents that can shop. Almost nobody is answering the
question that makes people nervous about them: **how do you let an agent spend
your money without losing control of it?**

BuyScout is a shopping agent built around that trust problem:

1. You describe a **mission** in plain language — what to buy, your target
   price, how many. ("Buy Sony WH-1000XM5 headphones, target $120.")
2. The agent **watches listings** for the mission and tracks the best price.
3. When the price hits your target, the agent acts — but only inside an
   **autonomy policy you control**:
   - Total **at or under your auto-buy cap** → the agent checks out instantly
     via PayPal.
   - Total **above the cap** → the agent prepares the checkout and parks it
     in an **approvals queue**. No money moves until you click Approve.
4. **Every step is written to an audit log**: the price evidence, the policy
   decision, the PayPal order id and capture id, and any refund.

Budget caps, approval tiers, and a full audit trail — the controls that make
an autonomous purchasing agent safe to actually use.

## Architecture

```
app/
  src/
    server.ts   HTTP server (Node built-ins only) — API + serves the UI
    agent.ts    Watch loop + autonomy-policy decisions + audit trail
    parser.ts   Natural-language mission parser (optional LLM, rules fallback)
    catalog.ts  ListingSource interface + local demo catalog / price simulator
    paypal.ts   PayPalClient: sandbox REST client + mock client (same interface)
    store.ts    JSON-file store (missions, approvals, orders, audit, policy)
    types.ts    Shared data model
  public/
    index.html  Single-page UI (vanilla JS, no build step)
  test/
    smoke.ts    End-to-end smoke test against the mock PayPal client
```

Key design choices:

- **Zero runtime dependencies.** The app runs on Node's built-in HTTP server
  and native TypeScript support (Node ≥ 22.6). `npm start` is all it takes.
- **The mission parser never hard-depends on an LLM.** If `LLM_API_KEY` is set
  (any OpenAI-compatible endpoint), missions are parsed by the model; on any
  failure — or with no key at all — a deterministic rule-based parser handles
  prices, quantities, and item names. The demo works either way.
- **Listings sit behind an interface.** Today's source is a local catalog
  with a price simulator (so price drops can be triggered live on stage); a
  real marketplace feed can be plugged in without touching the agent.
- **PayPal sits behind an interface too.** `SandboxPayPalClient` performs real
  OAuth2 + Orders v2 create/capture + capture refunds against
  `api-m.sandbox.paypal.com`. `MockPayPalClient` simulates the same lifecycle
  with realistic ids and statuses when no credentials are present.
  (Prototype note: in sandbox/mock the server captures orders directly; a
  production version would collect buyer approval through PayPal's checkout
  flow or vaulted payment methods.)

## Run it

Requirements: Node.js ≥ 22.6. No `npm install` needed (no dependencies).

### Mock mode (no credentials, full flow works)

```bash
npm start
# open http://localhost:4317 — the header badge reads "PayPal: mock"
```

### Sandbox mode (real PayPal sandbox)

Create a REST app at https://developer.paypal.com (sandbox), then:

```bash
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... PAYPAL_ENV=sandbox npm start
```

If credentials are present the client talks to the real sandbox API;
`PAYPAL_MODE=mock` forces mock mode even then.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4317` | HTTP port |
| `PAYPAL_MODE` | auto | `mock` forces the mock client |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | — | Sandbox REST app credentials |
| `PAYPAL_ENV` | `sandbox` | `sandbox` or `live` |
| `LLM_API_KEY` / `LLM_API_BASE` / `LLM_MODEL` | — | Optional LLM mission parsing |
| `WATCH_INTERVAL_MS` | `5000` | Watch-loop interval (`0` = manual ticks only) |
| `BUYSCOUT_DATA` | `data/store.json` | State file location |

### Smoke test

```bash
npm run smoke
```

Boots the server in mock mode on a scratch port and verifies end-to-end:
price watch → over-cap approval → approve → capture → refund, plus the
under-cap auto-buy path. All checks must pass.

## Demo script (target: under 3 minutes)

1. **The problem (0:00–0:25).** "Agents can shop now. The question is whether
   you'd trust one with your wallet." Show the BuyScout home page and the
   spending-trust panel: auto-buy cap set to $100.
2. **Create a mission (0:25–0:55).** Type "Buy Sony WH-1000XM5 headphones,
   target $120". Show the parse preview (item, target, quantity), start
   watching. The catalog price is $149 — nothing happens, and the audit log
   shows the agent is just watching.
3. **Price drop, human tier (0:55–1:40).** Use the simulator to drop the
   price to $110. The agent detects the hit, and because $110 is over the
   $100 cap, the checkout lands in the **approvals queue** instead of buying.
   Click Approve → PayPal order created and captured; the mission flips to
   Purchased with the order id, and the audit log shows the full trail.
4. **Price drop, autonomous tier (1:40–2:20).** New mission: "Get a LEGO
   Icons Bonsai Tree set under $80". Its price ($59.99) is already under both
   target and cap, so the agent **buys it instantly** via PayPal — no human
   in the loop, exactly as the policy allows.
5. **Trust, closed loop (2:20–2:55).** Refund the first order from the
   missions table. The refund hits PayPal, the mission flips to Refunded,
   and the audit log shows the complete lifecycle: watch → hit → approve →
   capture → refund. Close on the line: "Autonomy with a paper trail."

## TODO — next phases

- [ ] Create the PayPal developer account + sandbox REST app; put real
      credentials in env and verify create/capture/refund against
      api-m.sandbox.paypal.com (code path exists, untested with real creds).
- [ ] Decide demo mode for judges: hosted demo URL (e.g. Render) vs.
      run-from-repo instructions; either way the app must stay available,
      free and unrestricted, until the judging period ends (Dec 15, 2026).
- [ ] Publish the code repo (public, with the MIT LICENSE file) on GitHub.
- [ ] Record the <3 min YouTube demo video following the script above;
      no third-party trademarks or copyrighted music.
- [ ] Draft the Devpost submission: text description, tools disclosure
      (which AI model/service is used for mission parsing), screenshots.
- [ ] Register on Devpost and submit before **Nov 12, 2026, 12:00 pm PT**.
- [ ] Stretch: plug a real listing source behind `ListingSource`
      (e.g. a public product API) instead of the demo catalog.
- [ ] Stretch: PayPal buyer-approval checkout link for the approvals queue
      instead of server-side capture, for a production-faithful flow.
