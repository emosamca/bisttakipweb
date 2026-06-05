const crypto = require('crypto');
const db = require('./db');

const BASE = 'https://api.binance.com';

// --- Sifreleme: secret'i veritabaninda duz tutmamak icin AES-256-GCM ---
const ENC_KEY = crypto
  .createHash('sha256')
  .update(String(process.env.SESSION_SECRET || 'binance-default-key'))
  .digest(); // 32 byte

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(b64) {
  const raw = Buffer.from(b64, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ilk 5 + son 5 disini sansurle
function mask(s) {
  if (!s) return '';
  if (s.length <= 10) return '•'.repeat(s.length);
  return s.slice(0, 5) + '••••••' + s.slice(-5);
}

function sign(query, secret) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

async function signedRequest(method, path, apiKey, apiSecret, params = {}) {
  const q = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 10000 }).toString();
  const url = `${BASE}${path}?${q}&signature=${sign(q, apiSecret)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { method, headers: { 'X-MBX-APIKEY': apiKey }, signal: ctrl.signal });
    const txt = await r.text();
    let body;
    try { body = JSON.parse(txt); } catch { body = txt; }
    return { status: r.status, body };
  } finally {
    clearTimeout(t);
  }
}

async function tickerPrice(symbol) {
  try {
    const r = await fetch(`${BASE}/api/v3/ticker/price?symbol=${symbol}`);
    if (!r.ok) return null;
    const j = await r.json();
    const p = Number(j.price);
    return p > 0 ? p : null;
  } catch (_) {
    return null;
  }
}

// --- DB anahtar yardimcilari ---
async function getKeys(userId) {
  const r = await db.query('SELECT api_key, api_secret, updated_at FROM binance_keys WHERE user_id=$1', [userId]);
  if (!r.rows.length) return null;
  try {
    return {
      apiKey: decrypt(r.rows[0].api_key),
      apiSecret: decrypt(r.rows[0].api_secret),
      updatedAt: r.rows[0].updated_at,
    };
  } catch (_) {
    return null; // sifre cozulemezse (SESSION_SECRET degismis olabilir)
  }
}

async function saveKeys(userId, apiKey, apiSecret) {
  await db.query(
    `INSERT INTO binance_keys (user_id, api_key, api_secret, updated_at)
     VALUES ($1,$2,$3, now())
     ON CONFLICT (user_id)
     DO UPDATE SET api_key=EXCLUDED.api_key, api_secret=EXCLUDED.api_secret, updated_at=now()`,
    [userId, encrypt(apiKey), encrypt(apiSecret)]
  );
}

function binanceError(resp) {
  const msg = resp.body && resp.body.msg ? resp.body.msg : `Binance hatası (HTTP ${resp.status})`;
  const err = new Error(msg);
  err.binance = true;
  return err;
}

// Tum cuzdanlarin (Spot/Earn/Futures/Funding...) BTC toplami + USDT/TL
async function getTotals(apiKey, apiSecret) {
  const wb = await signedRequest('GET', '/sapi/v1/asset/wallet/balance', apiKey, apiSecret);
  if (wb.status !== 200 || !Array.isArray(wb.body)) throw binanceError(wb);
  const totalBTC = wb.body.reduce((s, w) => s + Number(w.balance || 0), 0);
  const btcusdt = await tickerPrice('BTCUSDT');
  const usdttry = await tickerPrice('USDTTRY');
  const totalUSDT = btcusdt ? totalBTC * btcusdt : null;
  const totalTRY = totalUSDT != null && usdttry ? totalUSDT * usdttry : null;
  return { totalBTC, btcusdt, usdttry, totalUSDT, totalTRY, wallets: wb.body };
}

// Spot varlik dagilimi (getUserAsset + btcValuation) + tum cuzdan toplami
async function getPortfolio(apiKey, apiSecret) {
  const totals = await getTotals(apiKey, apiSecret);
  const ua = await signedRequest('POST', '/sapi/v3/asset/getUserAsset', apiKey, apiSecret, {
    needBtcValuation: 'true',
  });
  let assets = [];
  if (Array.isArray(ua.body)) {
    const { btcusdt, usdttry } = totals;
    assets = ua.body
      .map((a) => {
        const amount = Number(a.free) + Number(a.locked);
        const btcVal = Number(a.btcValuation || 0);
        const usdt = btcusdt ? btcVal * btcusdt : null;
        const tryv = usdt != null && usdttry ? usdt * usdttry : null;
        return { asset: a.asset, amount, usdt, try: tryv };
      })
      .filter((a) => a.amount > 0)
      .sort((x, y) => (y.usdt || 0) - (x.usdt || 0));
  }
  return { ...totals, assets };
}

module.exports = { encrypt, decrypt, mask, getKeys, saveKeys, getTotals, getPortfolio };
