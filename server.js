require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const db       = require('./db');
const keeta    = require('./keeta');
const { encryptSeed, decryptSeed, isEncrypted } = require('./crypto-utils');

// ── Login rate limiter (in-memory: 5 attempts per IP per 15 min) ──────────────
const loginAttempts = new Map();
function checkRateLimit(ip) {
  const now    = Date.now();
  const window = 15 * 60 * 1000;
  const max    = 5;
  const entry  = loginAttempts.get(ip) || { count: 0, since: now };
  if (now - entry.since > window) { entry.count = 0; entry.since = now; }
  entry.count++;
  loginAttempts.set(ip, entry);
  return entry.count > max;
}
function clearRateLimit(ip) { loginAttempts.delete(ip); }

const app = express();
app.set('trust proxy', 1); // Render / Cloudflare sit in front
app.use(express.json({ limit: '10mb' })); // artwork data URLs can be large

// ── Sessions ──────────────────────────────────────────────────────────────────
app.use(session({
  secret:            process.env.SESSION_SECRET || 'keeta-dev-secret',
  resave:            false,
  saveUninitialized: false,
  proxy:             true,
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   7 * 24 * 60 * 60 * 1000,
  },
}));

function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Config (safe for frontend) ────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const pk = process.env.STRIPE_PUBLISHABLE_KEY || '';
  res.json({
    stripePublishableKey: pk.startsWith('pk_placeholder') ? null : pk,
    themePriceUsd:        parseFloat(process.env.THEME_PRICE_USD || '4'),
    user: req.session.userId
      ? { id: req.session.userId, name: req.session.userName, isArtist: !!req.session.isArtist }
      : null,
  });
});

// ── Auth: register ────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name)
    return res.status(400).json({ error: 'Name, email and password are all required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'That email is already registered' });

  const passwordHash    = await bcrypt.hash(password, 10);
  const walletAddress   = 'wallet-' + Date.now();
  const keetaSeed       = await keeta.generateSeed();
  const _rawAddr0       = await keeta.addressFromSeed(keetaSeed);
  const keetaAddress    = _rawAddr0 ? String(_rawAddr0) : '';
  const encryptedSeed   = encryptSeed(keetaSeed);

  const result = db.prepare(`
    INSERT INTO users (wallet_address, email, password_hash, name, keeta_seed, keeta_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(walletAddress, email, passwordHash, name, encryptedSeed, keetaAddress);

  const userId = result.lastInsertRowid;
  const ip     = db.prepare(`INSERT OR IGNORE INTO purchases (user_id, theme_key, amount_pence) VALUES (?, ?, 0)`);
  for (const key of ['genesis', 'obsidian', 'neon']) ip.run(userId, key);

  req.session.userId   = userId;
  req.session.userName = name;
  req.session.isArtist = 0;
  res.json({ success: true, name });
});

// ── Auth: login ───────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  // Rate limit: 5 attempts per IP per 15 minutes
  const ip = req.ip;
  if (checkRateLimit(ip))
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Invalid email or password' });

  clearRateLimit(ip); // reset on successful login

  // Backfill seed for old users, or migrate plaintext seed to encrypted
  if (!user.keeta_seed) {
    const keetaSeed    = await keeta.generateSeed();
    const rawAddr      = await keeta.addressFromSeed(keetaSeed);
    const keetaAddress = rawAddr ? String(rawAddr) : '';
    db.prepare('UPDATE users SET keeta_seed = ?, keeta_address = ? WHERE id = ?')
      .run(encryptSeed(keetaSeed), keetaAddress, user.id);
  } else if (!isEncrypted(user.keeta_seed)) {
    // Migrate plaintext seed to encrypted
    db.prepare('UPDATE users SET keeta_seed = ? WHERE id = ?')
      .run(encryptSeed(user.keeta_seed), user.id);
  }

  req.session.userId   = user.id;
  req.session.userName = user.name;
  req.session.isArtist = user.is_artist;
  res.json({ success: true, name: user.name });
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = db.prepare('SELECT id, name, email, is_artist, keeta_address FROM users WHERE id = ?').get(req.session.userId);
  res.json({ user });
});

// ── Themes ────────────────────────────────────────────────────────────────────
app.get('/api/themes', (req, res) => {
  const userId = req.session.userId || 0;
  const themes = db.prepare(`
    SELECT t.key, t.name, t.css_class, t.description, t.price_pence, t.owners_count, t.artist,
           CASE WHEN p.id IS NOT NULL THEN 1 ELSE 0 END AS owned
    FROM themes t
    LEFT JOIN purchases p ON p.theme_key = t.key AND p.user_id = ?
    WHERE t.active = 1
    ORDER BY t.owners_count DESC
  `).all(userId);
  res.json(themes);
});

app.get('/api/my-themes', requireAuth, (req, res) => {
  const owned = db.prepare(`
    SELECT t.key, t.name, t.css_class, t.description, t.price_pence, t.owners_count, t.artist
    FROM themes t JOIN purchases p ON p.theme_key = t.key AND p.user_id = ?
    WHERE t.active = 1
  `).all(req.session.userId);
  res.json(owned);
});

// ── Publish fee info ──────────────────────────────────────────────────────────
app.get('/api/publish/fee', async (req, res) => {
  try {
    const rate       = await keeta.getKtaUsdRate();
    const feeUsd     = parseFloat(process.env.PUBLISH_FEE_USD || '3');
    const feeKta     = feeUsd / rate;
    res.json({ feeUsd, feeKta, usdPerKta: rate });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch rate' });
  }
});

// ── KTA rate ──────────────────────────────────────────────────────────────────
app.get('/api/kta/rate', async (req, res) => {
  try {
    const rate          = await keeta.getKtaUsdRate();
    const priceUsd      = parseFloat(process.env.THEME_PRICE_USD || '4');
    const ktaForTheme   = priceUsd / rate;
    res.json({
      usdPerKta:    rate,
      ktaPerUsd:    1 / rate,
      themePriceUsd: priceUsd,
      themePriceKta: ktaForTheme,
    });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch KTA rate' });
  }
});

// ── Wallet balances ───────────────────────────────────────────────────────────
app.get('/api/wallet/balances', requireAuth, async (req, res) => {
  const user     = db.prepare('SELECT keeta_seed FROM users WHERE id = ?').get(req.session.userId);
  const balances = await keeta.getBalances(decryptSeed(user?.keeta_seed));
  const ktaRate  = await keeta.getKtaUsdRate();
  const totalUsd = balances.reduce((sum, b) => sum + parseFloat(b.usdValue), 0);
  res.json({ balances, totalUsd: totalUsd.toFixed(2), ktaUsdRate: ktaRate });
});

// ── Anchors ───────────────────────────────────────────────────────────────────
app.get('/api/anchors', (req, res) => {
  res.json(keeta.getAnchors());
});

app.post('/api/anchors/deposit', requireAuth, async (req, res) => {
  const { symbol, amount } = req.body;
  if (!symbol || !amount) return res.status(400).json({ error: 'symbol and amount required' });
  const user   = db.prepare('SELECT keeta_seed FROM users WHERE id = ?').get(req.session.userId);
  const result = await keeta.initiateDeposit(decryptSeed(user?.keeta_seed), symbol, amount);
  res.json(result);
});

app.post('/api/anchors/withdraw', requireAuth, async (req, res) => {
  const { symbol, amount, destinationAddress } = req.body;
  if (!symbol || !amount || !destinationAddress)
    return res.status(400).json({ error: 'symbol, amount, and destinationAddress required' });
  const user   = db.prepare('SELECT keeta_seed FROM users WHERE id = ?').get(req.session.userId);
  const result = await keeta.initiateWithdraw(decryptSeed(user?.keeta_seed), symbol, amount, destinationAddress);
  res.json(result);
});

// ── Purchase: Stripe intent ───────────────────────────────────────────────────
app.post('/api/purchase/intent', requireAuth, async (req, res) => {
  const { themeKey } = req.body;
  if (!themeKey) return res.status(400).json({ error: 'themeKey is required' });
  const theme = db.prepare('SELECT * FROM themes WHERE key = ?').get(themeKey);
  if (!theme)                     return res.status(404).json({ error: 'Theme not found' });
  if (theme.price_pence === null) return res.status(400).json({ error: 'This theme is free' });
  if (db.prepare('SELECT id FROM purchases WHERE user_id = ? AND theme_key = ?').get(req.session.userId, themeKey))
    return res.status(409).json({ error: 'Already owned' });

  const sk = process.env.STRIPE_SECRET_KEY || '';
  if (sk && !sk.startsWith('sk_placeholder')) {
    try {
      const stripe = require('stripe')(sk);
      const intent = await stripe.paymentIntents.create({
        amount: theme.price_pence, currency: 'gbp',
        metadata: { theme_key: themeKey, user_id: String(req.session.userId) },
      });
      return res.json({ clientSecret: intent.client_secret, intentId: intent.id });
    } catch (err) {
      return res.status(502).json({ error: 'Payment provider error', detail: err.message });
    }
  }
  res.json({ clientSecret: null, stub: true });
});

// ── Purchase: Stripe confirm ──────────────────────────────────────────────────
app.post('/api/purchase/confirm', requireAuth, async (req, res) => {
  const { themeKey, paymentIntentId, stub } = req.body;
  if (!themeKey) return res.status(400).json({ error: 'themeKey is required' });
  const theme = db.prepare('SELECT * FROM themes WHERE key = ?').get(themeKey);
  if (!theme) return res.status(404).json({ error: 'Theme not found' });
  if (db.prepare('SELECT id FROM purchases WHERE user_id = ? AND theme_key = ?').get(req.session.userId, themeKey))
    return res.status(409).json({ error: 'Already owned' });

  if (paymentIntentId && !stub) {
    const sk = process.env.STRIPE_SECRET_KEY || '';
    if (sk && !sk.startsWith('sk_placeholder')) {
      try {
        const stripe = require('stripe')(sk);
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (intent.status !== 'succeeded') return res.status(402).json({ error: 'Payment not completed' });
        if (intent.metadata.theme_key !== themeKey) return res.status(400).json({ error: 'Payment / theme mismatch' });
      } catch (err) {
        return res.status(502).json({ error: 'Could not verify payment', detail: err.message });
      }
    }
  }

  db.prepare(`
    INSERT INTO purchases (user_id, theme_key, stripe_payment_intent_id, keeta_tx_id, amount_pence)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.session.userId, themeKey, paymentIntentId || null, null, theme.price_pence || 0);
  db.prepare('UPDATE themes SET owners_count = owners_count + 1 WHERE key = ?').run(themeKey);
  res.json({ success: true, themeKey });
});

// ── Purchase: KTA payment ─────────────────────────────────────────────────────
app.post('/api/purchase/kta', requireAuth, async (req, res) => {
  const { themeKey } = req.body;
  if (!themeKey) return res.status(400).json({ error: 'themeKey is required' });

  const theme = db.prepare('SELECT * FROM themes WHERE key = ?').get(themeKey);
  if (!theme)                     return res.status(404).json({ error: 'Theme not found' });
  if (theme.price_pence === null) return res.status(400).json({ error: 'This theme is free' });
  if (db.prepare('SELECT id FROM purchases WHERE user_id = ? AND theme_key = ?').get(req.session.userId, themeKey))
    return res.status(409).json({ error: 'Already owned' });

  // Calculate KTA amount at live rate ($4 USD)
  const priceUsd = parseFloat(process.env.THEME_PRICE_USD || '4');
  const ktaRate  = await keeta.getKtaUsdRate();
  const ktaAmount = priceUsd / ktaRate;

  const user = db.prepare('SELECT keeta_seed FROM users WHERE id = ?').get(req.session.userId);

  let txResult;
  try {
    txResult = await keeta.payForThemeKta(decryptSeed(user?.keeta_seed), ktaAmount);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  db.prepare(`
    INSERT INTO purchases (user_id, theme_key, keeta_tx_id, amount_pence)
    VALUES (?, ?, ?, ?)
  `).run(req.session.userId, themeKey, txResult.txId, theme.price_pence || 0);
  db.prepare('UPDATE themes SET owners_count = owners_count + 1 WHERE key = ?').run(themeKey);

  console.log(`KTA purchase: user=${req.session.userId} theme=${themeKey} kta=${ktaAmount.toFixed(6)} tx=${txResult.txId}`);
  res.json({ success: true, themeKey, ktaAmount, ktaRate, txId: txResult.txId });
});

// ── Stripe webhook ────────────────────────────────────────────────────────────
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig           = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  let event;
  try {
    if (webhookSecret && !webhookSecret.startsWith('whsec_placeholder')) {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  if (event.type === 'payment_intent.succeeded') {
    const intent   = event.data.object;
    const themeKey = intent.metadata?.theme_key;
    const userId   = parseInt(intent.metadata?.user_id);
    if (themeKey && userId) {
      try {
        db.prepare(`
          INSERT OR IGNORE INTO purchases (user_id, theme_key, stripe_payment_intent_id, amount_pence)
          VALUES (?, ?, ?, ?)
        `).run(userId, themeKey, intent.id, intent.amount);
        db.prepare('UPDATE themes SET owners_count = owners_count + 1 WHERE key = ?').run(themeKey);
      } catch (e) { console.error('Webhook DB error:', e.message); }
    }
  }
  res.json({ received: true });
});

// ── Artist stats ──────────────────────────────────────────────────────────────
app.get('/api/artist/stats', requireAuth, (req, res) => {
  const user   = db.prepare('SELECT wallet_address FROM users WHERE id = ?').get(req.session.userId);
  const themes = db.prepare(`
    SELECT t.key, t.name, t.owners_count, t.price_pence,
           COUNT(p.id) AS sales, COALESCE(SUM(p.amount_pence),0) AS gross_pence
    FROM themes t LEFT JOIN purchases p ON p.theme_key = t.key
    WHERE t.artist = ? AND t.active = 1
    GROUP BY t.key
  `).all(user.wallet_address);
  const gross       = themes.reduce((s, t) => s + t.gross_pence, 0);
  res.json({ themes, gross_pence: gross, artist_share_pence: Math.round(gross * 0.8) });
});

app.post('/api/artist/publish', requireAuth, async (req, res) => {
  const { key, name, description, price_pence, css_class, theme_vars, artwork_data } = req.body;
  if (!key || !name || !css_class) return res.status(400).json({ error: 'key, name, and css_class are required' });

  // Check key not already taken
  if (db.prepare('SELECT key FROM themes WHERE key = ?').get(key))
    return res.status(409).json({ error: 'Theme key already exists' });

  // Charge $3 publish fee in KTA
  const feeUsd  = parseFloat(process.env.PUBLISH_FEE_USD || '3');
  const ktaRate = await keeta.getKtaUsdRate();
  const feeKta  = feeUsd / ktaRate;

  const user = db.prepare('SELECT wallet_address, keeta_seed FROM users WHERE id = ?').get(req.session.userId);

  let txResult;
  try {
    txResult = await keeta.payForThemeKta(decryptSeed(user.keeta_seed), feeKta);
  } catch (err) {
    return res.status(402).json({ error: 'Publish fee payment failed: ' + err.message });
  }

  const themeVarsStr = theme_vars   ? JSON.stringify(theme_vars) : null;
  const artworkStr   = artwork_data || null;

  try {
    db.prepare(`
      INSERT INTO themes (key, name, css_class, description, price_pence, artist, active, theme_vars, artwork_data)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(key, name, css_class, description || '', price_pence || null, user.wallet_address, themeVarsStr, artworkStr);
    console.log(`Theme published: key=${key} fee=${feeKta.toFixed(4)} KTA tx=${txResult.txId}`);
    res.json({ success: true, key, feeKta, txId: txResult.txId });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Theme key already exists' });
    throw err;
  }
});

// ── Theme vars + artwork (for applying custom themes) ─────────────────────────
app.get('/api/themes/:key/vars', (req, res) => {
  const theme = db.prepare('SELECT theme_vars, artwork_data FROM themes WHERE key = ?').get(req.params.key);
  if (!theme) return res.status(404).json({ error: 'Not found' });
  const vars = theme.theme_vars ? JSON.parse(theme.theme_vars) : null;
  res.json({ theme_vars: vars, artwork_data: theme.artwork_data || null });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`KeetaTheme → http://localhost:${PORT}`));
