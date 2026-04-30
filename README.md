# hive-x402-index

Third-party paid leaderboard of agentic x402 traffic on Base mainnet. Ranks merchants and AI agents by x402 transaction count and USDC volume. Settlement flows to Monroe treasury on Base USDC (chain 8453).

Part of the Hive Civilization agent network. Aggarwal-response juggernaut infrastructure.

---

## Pricing

| Tier | Cost | Query Param |
|---|---|---|
| Basic | $0.005 USDC per query | (default) |
| Institutional | $0.50 USDC per query | `?tier=inst` |

All payments settle to Monroe treasury: `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e` on Base (chain 8453, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`).

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check. Returns `{ok:true}`. |
| GET | `/` | JSON banner with pricing, endpoint map, and x402 config. |
| GET | `/.well-known/agent.json` | A2A discovery card. Monroe treasury. x402 supported. |
| POST | `/mcp` | JSON-RPC 2.0 MCP server. |
| GET | `/v1/x402-index/:period` | Leaderboard. period in `{1h, 24h, 7d, 30d}`. 402-gated. |
| GET | `/v1/x402-index/merchant/:did` | Individual merchant rank card. 402-gated. |

---

## Tools

| Tool | Description | Required Inputs |
|---|---|---|
| `get_index` | Leaderboard for a time period. Returns merchants ranked by x402 tx count and USDC volume on Base. | `period` (`1h` / `24h` / `7d` / `30d`) |
| `get_merchant_rank` | Rank card for a specific merchant by DID. Returns tx count, volume, category, verification status. | `did` (W3C DID) |

Both tools require x402 payment. Basic tier: $0.005. Institutional tier: $0.50 (pass `?tier=inst`).

---

## x402 Protocol

This service implements the x402 payment protocol over HTTP on Base mainnet.

### Challenge (402 Response)

Ungated request returns:

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "base",
      "asset": "USDC",
      "maxAmountRequired": "5000",
      "resource": "https://hive-x402-index.onrender.com/v1/x402-index/24h",
      "description": "Hive x402 Index data access — basic tier ($0.005 USDC)",
      "payTo": "0x15184bf50b3d3f52b60434f8942b7d52f2eb436e",
      "asset_address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "maxTimeoutSeconds": 60,
      "extra": { "name": "USDC", "version": "2", "chain_id": 8453 }
    }
  ]
}
```

`maxAmountRequired` is in atomic USDC units (6 decimals). 5000 = $0.005. 500000 = $0.50.

### Payment

Retry with `X-PAYMENT: <base64-encoded-payment-payload>` header. On valid payment, server returns `200` with `X-PAYMENT-RESPONSE` header containing a base64-encoded receipt.

### Settlement Phases

**Phase 1 (current):** Receipt-logged. Payment header validated as non-empty base64. Settlement record appended to `/tmp/x402_index_settlements.jsonl`. `X-PAYMENT-RESPONSE` returned immediately.

**Phase 2 (planned):** On-chain verification via x402 facilitator (`x402.coinbase.com`). EIP-3009 `transferWithAuthorization` verification before 200 is returned. Monroe sweep cron reconciles settled transactions.

---

## Merchant Seed Data

Known x402 merchants are maintained in `/data/seed.json`. Current seed list:

- `hivemorph` — Hive backend orchestration
- `hive-meter` — DID-attested trust score lookup
- `coinbase-x402-facilitator` — Coinbase reference implementation
- `brave-x402` — Brave browser micropayment integration
- `fewsats` — L402/x402 gateway
- `hive-escrow` — Hive P2P agent escrow
- `kagi-x402` — Kagi search API
- `comput3-x402` — Decentralized GPU compute

Seed data is updated by the Hive operator team. Transaction counts are estimated from public signals and first-party telemetry. Live on-chain enrichment is added in future iterations.

---

## MCP

Connect at `https://hive-x402-index.onrender.com/mcp` using JSON-RPC 2.0, protocol `2024-11-05`.

```bash
curl -s -X POST https://hive-x402-index.onrender.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## Connect

**Smithery:** `https://smithery.ai/server/hive-x402-index`

**Glama:** Auto-indexed from GitHub. Claim at `https://glama.ai/mcp/servers/srotzin/hive-x402-index`.

**MCP.so:** Auto-indexed from GitHub.

---

## Network

- Chain: Base (8453)
- Settlement asset: USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- Treasury: Monroe (`0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`)
- x402 scheme: `exact`
- Brand: `#C08D23`

---

## License

MIT License. Copyright (c) 2026 Steve Rotzin.


---

## Hive Civilization

Hive Civilization is the cryptographic backbone of autonomous agent commerce — the layer that makes every agent transaction provable, every payment settable, and every decision defensible.

This repository is part of the **SETTABLE** pillar.

- thehiveryiq.com
- hiveagentiq.com
- agent-card: https://hivetrust.onrender.com/.well-known/agent-card.json
