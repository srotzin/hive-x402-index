# v1.0.0 — Hive x402 Index

Initial scaffold. Third-party paid leaderboard of agentic x402 traffic on Base mainnet.

## Tools

| Tool | Description |
|---|---|
| `get_index` | Leaderboard for a time period (`1h`, `24h`, `7d`, `30d`). Ranked by x402 tx count and USDC volume on Base. |
| `get_merchant_rank` | Individual merchant rank card by W3C DID. Tx count, volume, category, verification status. |

## Endpoints

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | None |
| GET | `/` | None |
| GET | `/.well-known/agent.json` | None |
| POST | `/mcp` | None |
| GET | `/v1/x402-index/:period` | x402 required |
| GET | `/v1/x402-index/merchant/:did` | x402 required |

## Backend

- Network: Base (chain 8453)
- Settlement asset: USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- Treasury: Monroe (`0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`)
- Pricing: $0.005 basic / $0.50 institutional

## Settlement

Phase 1: Receipt-logged. X-PAYMENT header validated, settlement appended to JSONL log, X-PAYMENT-RESPONSE returned. Phase 2 (on-chain verification via x402 facilitator) is the next iteration.

## Council Provenance

Ad-hoc. Aggarwal-response juggernaut. Real rails only. No mock. No simulated. No testnet.

## Brand

Hive Gold: `#C08D23` (Pantone 1245 C)
