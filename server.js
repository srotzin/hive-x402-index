import express from 'express';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const MONROE_TREASURY  = process.env.MONROE_TREASURY  || '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const USDC_CONTRACT    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_URL         = process.env.RENDER_EXTERNAL_URL || 'https://hive-x402-index.onrender.com';
const HIVECOMPUTE_URL  = 'https://hivecompute-g2g7.onrender.com';
const SETTLEMENT_LOG   = process.env.SETTLEMENT_LOG || '/tmp/x402_index_settlements.jsonl';

// Pricing (USDC atomic, 6 decimals)
const PRICE_BASIC_ATOMIC = '5000';        // $0.005
const PRICE_INST_ATOMIC  = '500000';      // $0.50

const VALID_PERIODS = new Set(['1h', '24h', '7d', '30d']);

// ─── Seed data ───────────────────────────────────────────────────────────────

let seedData = { merchants: [], metadata: {} };
try {
  const seedPath = join(__dirname, 'data', 'seed.json');
  seedData = JSON.parse(readFileSync(seedPath, 'utf8'));
} catch (err) {
  console.error('[boot] failed to load seed.json:', err.message);
}

// ─── In-memory stats ─────────────────────────────────────────────────────────

let stats = {
  total_requests: 0,
  gated_requests: 0,
  payments_received: 0,
  payments_basic: 0,
  payments_inst: 0,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isBase64(str) {
  if (!str || typeof str !== 'string') return false;
  return /^[A-Za-z0-9+/]+=*$/.test(str.replace(/\s/g, '')) && str.length >= 8;
}

function logSettlement(entry) {
  try {
    appendFileSync(SETTLEMENT_LOG, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[settlement-log] write failed:', err.message);
  }
}

function buildChallenge(resource, tier) {
  const amount = tier === 'inst' ? PRICE_INST_ATOMIC : PRICE_BASIC_ATOMIC;
  const priceUsdc = tier === 'inst' ? 0.50 : 0.005;
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'base',
        asset: 'USDC',
        maxAmountRequired: amount,
        resource,
        description: `Hive x402 Index data access — ${tier === 'inst' ? 'institutional' : 'basic'} tier ($${priceUsdc} USDC)`,
        payTo: MONROE_TREASURY,
        asset_address: USDC_CONTRACT,
        maxTimeoutSeconds: 60,
        extra: { name: 'USDC', version: '2', chain_id: 8453 }
      }
    ]
  };
}

// Score normalization: decay by period window
function periodDecayFactor(period) {
  switch (period) {
    case '1h':  return 0.04;
    case '24h': return 1.0;
    case '7d':  return 7.0;
    case '30d': return 30.0;
    default:    return 1.0;
  }
}

// Build leaderboard from seed + optional first-party data
async function buildLeaderboard(period) {
  const decay = periodDecayFactor(period);

  // Start from seed
  let entries = seedData.merchants.map(m => ({
    did:          m.did,
    name:         m.name,
    description:  m.description,
    category:     m.category,
    domain:       m.domain,
    verified:     m.verified,
    tx_count:     Math.round(m.seed_tx_count * decay / 1),
    volume_usdc:  parseFloat((m.seed_volume_usdc * decay).toFixed(4)),
    first_seen:   m.first_seen,
    data_source:  'seed',
  }));

  // Attempt to enrich from hivecompute first-party usage
  try {
    const resp = await fetch(
      `${HIVECOMPUTE_URL}/v1/compute/usage/did:web:hive-x402-index.onrender.com`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (resp.ok) {
      const usage = await resp.json();
      // Merge hivecompute data into the hivemorph entry if present
      const hivemorphEntry = entries.find(e => e.name === 'hivemorph');
      if (hivemorphEntry && usage && usage.tx_count) {
        hivemorphEntry.tx_count   = Math.max(hivemorphEntry.tx_count, usage.tx_count);
        hivemorphEntry.data_source = 'live+seed';
      }
    }
  } catch (_) {
    // Upstream unavailable — seed data stands
  }

  // Sort descending by tx_count
  entries.sort((a, b) => b.tx_count - a.tx_count);

  // Assign ranks
  entries = entries.map((e, i) => ({ rank: i + 1, ...e }));

  return {
    period,
    generated_at: new Date().toISOString(),
    network: 'base',
    chain_id: 8453,
    settlement_asset: 'USDC',
    treasury: MONROE_TREASURY,
    count: entries.length,
    leaderboard: entries,
  };
}

function getMerchantCard(did) {
  const merchant = seedData.merchants.find(m => m.did === did);
  if (!merchant) return null;
  return {
    did:          merchant.did,
    name:         merchant.name,
    description:  merchant.description,
    category:     merchant.category,
    domain:       merchant.domain,
    verified:     merchant.verified,
    seed_tx_count:    merchant.seed_tx_count,
    seed_volume_usdc: merchant.seed_volume_usdc,
    first_seen:   merchant.first_seen,
    rank_24h:     null, // computed on demand if needed
    data_source:  'seed',
    generated_at: new Date().toISOString(),
  };
}

// ─── BOGO redemption middleware (X-Hive-BOGO-Token) ─────────────────────────
// Phase 1: calls hive-gamification /v1/bogo/redeem; bypasses 402 on consumed:true.
// Phase 2 (planned): zero-trust redemption with token-bound HMAC.

function bogoRedeemMiddleware(mechanicId) {
  return async function _bogoRedeem(req, res, next) {
    const token = req.headers['x-hive-bogo-token'];
    if (!token) return next();
    try {
      const r = await fetch('https://hive-gamification.onrender.com/v1/bogo/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, mechanic_id: mechanicId }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const j = await r.json();
        if (j.consumed === true) {
          req._bogo_redeemed = true;
          import('fs').then(({ appendFileSync }) => {
            try { appendFileSync('/tmp/x402_index_bogo_redemptions.jsonl', JSON.stringify({ token: token.slice(0, 12), mechanic_id: mechanicId, ts: Date.now() }) + '\n'); } catch (_) {}
          });
          return next();
        }
      }
    } catch (_) {}
    return next();
  };
}

// ─── 402 middleware factory ───────────────────────────────────────────────────

function x402Gate(resourceFn) {
  return (req, res, next) => {
    stats.total_requests++;
    const tier = req.query.tier === 'inst' ? 'inst' : 'basic';
    const paymentHeader = req.headers['x-payment'];

    // BOGO token was consumed upstream — bypass 402 for this call
    if (req._bogo_redeemed) {
      res.locals.tier = tier;
      return next();
    }

    if (!paymentHeader) {
      stats.gated_requests++;
      const resource = `${BASE_URL}${req.originalUrl}`;
      return res.status(402).json(buildChallenge(resource, tier));
    }

    // Validate header is present and base64-shaped (Phase 1 receipt-logged)
    if (!isBase64(paymentHeader)) {
      return res.status(402).json({
        error: 'X-PAYMENT header must be base64-encoded payment payload',
        x402Version: 1
      });
    }

    // Log settlement receipt
    let parsed = null;
    try { parsed = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8')); } catch (_) {}
    const priceAtomic = tier === 'inst' ? PRICE_INST_ATOMIC : PRICE_BASIC_ATOMIC;
    const settlement = {
      ts:          new Date().toISOString(),
      tier,
      resource:    req.originalUrl,
      price_atomic: priceAtomic,
      currency:    'USDC',
      network:     'base',
      treasury:    MONROE_TREASURY,
      header_raw:  paymentHeader.slice(0, 64),
      parsed,
      phase:       'phase1-receipt-logged',
    };
    logSettlement(settlement);

    stats.payments_received++;
    if (tier === 'inst') stats.payments_inst++;
    else stats.payments_basic++;

    // Attach receipt header
    const receipt = Buffer.from(JSON.stringify({
      settled: true,
      price_atomic: priceAtomic,
      currency: 'USDC',
      network: 'base',
      treasury: MONROE_TREASURY,
      ts: new Date().toISOString(),
      phase: 'phase1-receipt-logged',
      note: 'Phase 2 on-chain verification via x402 facilitator is planned for next iteration.',
    })).toString('base64');
    res.setHeader('X-PAYMENT-RESPONSE', receipt);

    // Stash tier for handler
    res.locals.tier = tier;
    next();
  };
}

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// 1. Health
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'hive-x402-index',
    version: '1.0.0',
    ts: new Date().toISOString(),
  });
});

// 2. Banner
app.get('/', (req, res) => {
  res.json({
    service: 'hive-x402-index',
    version: '1.0.0',
    description: 'Third-party paid leaderboard of agentic x402 traffic on Base. Real rails. Monroe treasury.',
    network: 'base',
    chain_id: 8453,
    settlement_asset: 'USDC',
    treasury: MONROE_TREASURY,
    pricing: {
      basic:       { usdc: 0.005, atomic: PRICE_BASIC_ATOMIC, description: 'Standard leaderboard query' },
      institutional: { usdc: 0.50,  atomic: PRICE_INST_ATOMIC,  description: 'Institutional tier — pass ?tier=inst' },
    },
    endpoints: {
      health:         'GET /health',
      agent_card:     'GET /.well-known/agent.json',
      mcp:            'POST /mcp',
      leaderboard:    'GET /v1/x402-index/:period  — period in {1h, 24h, 7d, 30d}',
      merchant_card:  'GET /v1/x402-index/merchant/:did',
    },
    x402: {
      supported: true,
      scheme: 'exact',
      phase: 'phase1-receipt-logged',
    },
    brand: { color: '#C08D23', name: 'Hive Gold' },
  });
});

// 3. A2A discovery card
app.get('/.well-known/agent.json', (req, res) => {
  res.json({
    schema_version: '1.0',
    name: 'hive-x402-index',
    did: 'did:web:hive-x402-index.onrender.com',
    description: 'Third-party paid leaderboard of agentic x402 traffic on Base. Settles to Monroe treasury. Real USDC rails.',
    color: '#C08D23',
    endpoints: {
      base:          BASE_URL,
      leaderboard:   '/v1/x402-index/:period',
      merchant_card: '/v1/x402-index/merchant/:did',
      mcp:           '/mcp',
    },
    payment: {
      x402: true,
      x402_version: 1,
      scheme: 'exact',
      network: 'base',
      chain_id: 8453,
      asset: 'USDC',
      asset_contract: USDC_CONTRACT,
      treasury: {
        address: MONROE_TREASURY,
        chain: 'base',
        chain_id: 8453,
        asset: 'USDC',
      },
      pricing: {
        basic:         { usdc: 0.005, atomic: PRICE_BASIC_ATOMIC },
        institutional: { usdc: 0.50,  atomic: PRICE_INST_ATOMIC, query_param: 'tier=inst' },
      },
      settlement_phase: 'phase1-receipt-logged',
    },
    capabilities: ['leaderboard', 'merchant-rank', 'x402-analytics'],
    registry: 'https://hive-discovery.onrender.com',
    mcp_endpoint: `${BASE_URL}/mcp`,
    mcp_protocol: '2024-11-05',
  });
});

// 4. MCP endpoint — JSON-RPC 2.0
app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};

  if (jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } });
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'get_index',
            description: 'Retrieve the x402 merchant leaderboard for a given time period. Returns ranked list of agents/merchants by transaction count and USDC volume on Base. Requires x402 payment ($0.005 basic, $0.50 institutional).',
            inputSchema: {
              type: 'object',
              properties: {
                period: {
                  type: 'string',
                  enum: ['1h', '24h', '7d', '30d'],
                  description: 'Leaderboard window. One of: 1h, 24h, 7d, 30d.',
                },
                tier: {
                  type: 'string',
                  enum: ['basic', 'inst'],
                  description: 'Pricing tier. basic=$0.005, inst=$0.50. Default: basic.',
                },
              },
              required: ['period'],
            },
          },
          {
            name: 'get_merchant_rank',
            description: 'Retrieve the rank card for a specific x402 merchant by DID. Returns transaction count, volume, category, and verification status on Base. Requires x402 payment ($0.005 basic).',
            inputSchema: {
              type: 'object',
              properties: {
                did: {
                  type: 'string',
                  description: 'W3C DID of the merchant (e.g. did:web:example.com).',
                },
                tier: {
                  type: 'string',
                  enum: ['basic', 'inst'],
                  description: 'Pricing tier. Default: basic.',
                },
              },
              required: ['did'],
            },
          },
        ],
      },
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    if (toolName === 'get_index') {
      const period = toolArgs.period;
      if (!VALID_PERIODS.has(period)) {
        return res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: `period must be one of: ${[...VALID_PERIODS].join(', ')}` } });
      }
      const data = await buildLeaderboard(period);
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
    }

    if (toolName === 'get_merchant_rank') {
      const did = toolArgs.did;
      if (!did) {
        return res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'did is required' } });
      }
      const card = getMerchantCard(did);
      if (!card) {
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'merchant not found', did }) }] } });
      }
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(card) }] } });
    }

    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
  }

  if (method === 'initialize' || method === 'ping') {
    return res.json({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'hive-x402-index', version: '1.0.0' } } });
  }

  return res.json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } });
});

// 5. Leaderboard — BOGO-aware, then 402-gated
app.get('/v1/x402-index/:period', bogoRedeemMiddleware('x402-index-query'), x402Gate(), async (req, res) => {
  const { period } = req.params;

  if (!VALID_PERIODS.has(period)) {
    return res.status(400).json({ error: `period must be one of: ${[...VALID_PERIODS].join(', ')}` });
  }

  try {
    const data = await buildLeaderboard(period);
    return res.json(data);
  } catch (err) {
    console.error('[leaderboard] error:', err.message);
    return res.status(500).json({ error: 'internal error building leaderboard' });
  }
});

// 6. Merchant card — 402-gated
app.get('/v1/x402-index/merchant/:did', x402Gate(), (req, res) => {
  const did = decodeURIComponent(req.params.did);
  const card = getMerchantCard(did);
  if (!card) {
    return res.status(404).json({ error: 'merchant not found', did });
  }
  return res.json(card);
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[hive-x402-index] listening on port ${PORT}`);
  console.log(`[hive-x402-index] treasury: ${MONROE_TREASURY}`);
  console.log(`[hive-x402-index] base url: ${BASE_URL}`);
  console.log(`[hive-x402-index] seed merchants: ${seedData.merchants?.length ?? 0}`);
});
