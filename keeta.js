/**
 * keeta.js — Keeta Network SDK wrapper
 *
 * All functions gracefully stub when KEETA_PLATFORM_SEED is not set,
 * so the app works in dev without credentials.
 * Swap in real credentials in .env to go live.
 */

const NETWORK            = process.env.KEETA_NETWORK          || 'test';
const PLATFORM_SEED      = process.env.KEETA_PLATFORM_SEED    || '';
const PLATFORM_ADDRESS   = process.env.KEETA_PLATFORM_ADDRESS || '';
const isReal             = PLATFORM_SEED && !PLATFORM_SEED.startsWith('keeta_platform_seed');

// KTA-Oracle — free public API, no key needed
const RATE_API    = 'https://kta-oracle.vercel.app';

// The live Base Anchor supports these assets both inbound and outbound
const ANCHOR_ASSETS = [
  { symbol: 'KTA',    name: 'Keeta',           decimals: 8,  logoColor: '#7c3aed' },
  { symbol: 'USDC',   name: 'USD Coin',         decimals: 6,  logoColor: '#2775ca' },
  { symbol: 'EURC',   name: 'Euro Coin',         decimals: 6,  logoColor: '#003087' },
  { symbol: 'CBBTC',  name: 'Coinbase BTC',      decimals: 8,  logoColor: '#f7931a' },
];

// ── Rate fetching ─────────────────────────────────────────────────────────────

let _rateCache    = null;
let _rateCachedAt = 0;
const RATE_TTL_MS = 60_000; // cache for 60 seconds

async function getKtaUsdRate() {
  const now = Date.now();
  if (_rateCache && now - _rateCachedAt < RATE_TTL_MS) return _rateCache;

  try {
    const res  = await fetch(`${RATE_API}/rate?currency=USD`);
    const data = await res.json();
    // data.rate = "1 KTA = 0.1722 USD"  — extract the USD number
    const match = String(data.rate).match(/=\s*([\d.]+)\s*USD/i);
    _rateCache    = match ? parseFloat(match[1]) : parseFloat(data.rate);
    _rateCachedAt = now;
    return _rateCache;
  } catch (err) {
    console.warn('[keeta] Rate fetch failed, using fallback:', err.message);
    return _rateCache || 0.26; // fallback if API unreachable
  }
}

/** Convert a USD amount to KTA quantity at the live rate */
async function usdToKta(usdAmount) {
  const rate = await getKtaUsdRate();
  return usdAmount / rate; // e.g. $4 / 0.2641 ≈ 15.14 KTA
}

// ── SDK helpers ───────────────────────────────────────────────────────────────

let KeetaNet = null;

async function loadSdk() {
  if (KeetaNet) return KeetaNet;
  try {
    KeetaNet = await import('@keetanetwork/keetanet-client');
    return KeetaNet;
  } catch (err) {
    console.warn('[keeta] SDK not available:', err.message);
    return null;
  }
}

/** Generate a new random seed string for a user account */
async function generateSeed() {
  const sdk = await loadSdk();
  if (sdk) {
    return sdk.lib.Account.generateRandomSeed({ asString: true });
  }
  // Fallback: crypto random hex if SDK unavailable
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Derive a Keeta public address from a seed */
async function addressFromSeed(seed) {
  const sdk = await loadSdk();
  if (!sdk) return null;
  try {
    const account = sdk.lib.Account.fromSeed(seed, 0);
    return account.publicKey;
  } catch (err) {
    console.warn('[keeta] addressFromSeed error:', err.message);
    return null;
  }
}

/** Get a UserClient for a given seed */
async function clientFromSeed(seed) {
  const sdk = await loadSdk();
  if (!sdk) return null;
  try {
    const signer = sdk.lib.Account.fromSeed(seed, 0);
    return sdk.UserClient.fromNetwork(NETWORK, signer);
  } catch (err) {
    console.warn('[keeta] clientFromSeed error:', err.message);
    return null;
  }
}

// ── Balances ──────────────────────────────────────────────────────────────────

/**
 * Get all token balances for a user seed.
 * Returns array of { symbol, name, balance, balanceRaw, usdValue, logoColor }
 */
async function getBalances(seed) {
  if (!seed || !isReal) {
    // Stub: realistic-looking demo balances
    const ktaRate = await getKtaUsdRate();
    return [
      { symbol: 'KTA',   name: 'Keeta',        balance: 125.50,  usdValue: (125.50  * ktaRate).toFixed(2), logoColor: '#7c3aed' },
      { symbol: 'USDC',  name: 'USD Coin',      balance: 45.00,   usdValue: '45.00',                        logoColor: '#2775ca' },
      { symbol: 'EURC',  name: 'Euro Coin',     balance: 0,       usdValue: '0.00',                         logoColor: '#003087' },
      { symbol: 'CBBTC', name: 'Coinbase BTC',  balance: 0,       usdValue: '0.00',                         logoColor: '#f7931a' },
    ];
  }

  const client = await clientFromSeed(seed);
  if (!client) return [];

  try {
    const raw      = await client.allBalances();
    const ktaRate  = await getKtaUsdRate();
    client.destroy();

    return ANCHOR_ASSETS.map(asset => {
      const entry = raw.find(b => b.token?.symbol === asset.symbol || b.symbol === asset.symbol);
      const balance = entry ? parseFloat(entry.balance || entry.amount || 0) : 0;
      const usdValue = asset.symbol === 'KTA'
        ? (balance * ktaRate).toFixed(2)
        : balance.toFixed(2);
      return { ...asset, balance, usdValue };
    });
  } catch (err) {
    console.warn('[keeta] getBalances error:', err.message);
    return [];
  }
}

// ── KTA payment for theme purchase ────────────────────────────────────────────

/**
 * Transfer KTA from a user's wallet to the platform wallet for a theme purchase.
 * Returns { success, txId, ktaAmount } or throws.
 */
async function payForThemeKta(userSeed, ktaAmount) {
  if (!userSeed || !isReal) {
    // Stub
    console.log(`[keeta stub] Transfer ${ktaAmount.toFixed(6)} KTA to platform`);
    return { success: true, txId: `kta_stub_${Date.now()}`, ktaAmount };
  }

  const sdk = await loadSdk();
  if (!sdk) throw new Error('Keeta SDK unavailable');

  const client = await clientFromSeed(userSeed);
  if (!client) throw new Error('Could not connect to Keeta');

  try {
    const platformAddress  = PLATFORM_ADDRESS;

    // KTA amounts are integers (8 decimal places)
    const rawAmount = BigInt(Math.round(ktaAmount * 1e8));

    const builder  = client.initBuilder();
    builder.send(platformAddress, rawAmount, client.baseToken);
    await builder.publish();

    const blocks = await client.chain({ limit: 1 });
    const txId   = blocks?.[0]?.hash || `kta_${Date.now()}`;
    client.destroy();

    return { success: true, txId, ktaAmount };
  } catch (err) {
    client.destroy();
    throw new Error('KTA transfer failed: ' + err.message);
  }
}

// ── Anchors ───────────────────────────────────────────────────────────────────

/**
 * Returns the list of available anchors with their supported assets and direction.
 * Currently the live production anchor is the "Outbound Base Anchor" which is
 * bidirectional for KTA, USDC, EURC, and CBBTC.
 */
function getAnchors() {
  return [
    {
      id:          'base-anchor',
      name:        'Base Anchor',
      provider:    'Keeta Network',
      description: 'Move assets between Base chain and Keeta. ~2 min settlement.',
      fee:         '~$0.01',
      settlement:  '~2 minutes',
      inbound:     true,
      outbound:    true,
      assets:      ANCHOR_ASSETS,
      status:      'live',
    },
  ];
}

/**
 * Initiate an inbound deposit (Base chain → Keeta).
 * Returns a deposit address/instructions for the user.
 * Stubbed until full anchor SDK integration.
 */
async function initiateDeposit(userSeed, symbol, amount) {
  console.log(`[keeta] Deposit request: ${amount} ${symbol} for user`);
  // In production: call anchor's deposit endpoint to get a Base chain address
  // that the user sends to. Anchor detects receipt and credits Keeta wallet.
  return {
    stub:           true,
    instructions:   `Send ${amount} ${symbol} to the Base chain deposit address below.`,
    depositAddress: '0xBase_Anchor_Deposit_Address_Placeholder',
    memo:           'KEETA-' + Date.now(),
    estimatedTime:  '~2 minutes',
  };
}

/**
 * Initiate an outbound withdrawal (Keeta → Base chain).
 * Stubbed until full anchor SDK integration.
 */
async function initiateWithdraw(userSeed, symbol, amount, destinationAddress) {
  console.log(`[keeta] Withdraw request: ${amount} ${symbol} to ${destinationAddress}`);
  return {
    stub:          true,
    message:       `Withdrawal of ${amount} ${symbol} to ${destinationAddress} queued.`,
    txId:          `withdraw_stub_${Date.now()}`,
    estimatedTime: '~2 minutes',
  };
}

module.exports = {
  getKtaUsdRate,
  usdToKta,
  generateSeed,
  addressFromSeed,
  getBalances,
  payForThemeKta,
  getAnchors,
  initiateDeposit,
  initiateWithdraw,
  ANCHOR_ASSETS,
};
