// TEFAS fonlari icin alim/portfoy mantigi (maden/kripto deseni; TL bazli, komisyonsuz).
// Guncel fiyat fund_prices'tan (servis doldurur) gelir.
const db = require('./db');

function normCode(code) {
  return String(code || '').trim().toUpperCase();
}

// Fiyat okumasi: fund_prices'a uygulamanin kendi son-gecerli-fiyat onbellegi eklenir.
// price_old servisin kolonu; nullable ve bazen 0/NULL geldigi icin tek basina
// yeterli degil -> son care olarak fund_price_last_good kullanilir.
const PRICE_SELECT = `
  SELECT fp.code, fp.title, fp.price,
         COALESCE(fp.price_old, 0) AS price_old,
         COALESCE(lg.price, 0)     AS last_good,
         fp.updated_at
    FROM fund_prices fp
    LEFT JOIN fund_price_last_good lg ON lg.code = fp.code`;

// Guncel fiyat 0 ise sirasiyla servisin price_old'una, o da yoksa uygulamanin
// kendi tuttugu son gecerli fiyata dusulur. Fiyat guncel degilse isOld=true
// (arayuzde yanina "!" konur).
function effectivePrice(row) {
  const price = Number(row.price);
  if (price > 0) return { price, isOld: false };
  const priceOld = Number(row.price_old);
  if (priceOld > 0) return { price: priceOld, isOld: true };
  const lastGood = Number(row.last_good);
  if (lastGood > 0) return { price: lastGood, isOld: true };
  return { price: 0, isOld: false }; // hic fiyat gorulmemis
}

// Gecerli fiyatlari uygulamanin kendi onbellegine yaz. Servis price_old'u
// sifirlasa/bosaltsa bile fiyat 0 iken gosterilecek bir deger kalir.
async function rememberGoodPrices() {
  await db.query(
    `INSERT INTO fund_price_last_good (code, price, seen_at)
     SELECT code, price, now() FROM fund_prices WHERE price > 0
     ON CONFLICT (code) DO UPDATE SET price = EXCLUDED.price, seen_at = now()`
  );
}

// code -> { price, title, isOld }
async function priceMap() {
  const r = await db.query(PRICE_SELECT);
  const m = {};
  r.rows.forEach((x) => {
    const { price, isOld } = effectivePrice(x);
    m[x.code] = { price, isOld, title: x.title || '' };
  });
  return m;
}

async function holdingsBeforeDate(userId, code, date) {
  const c = normCode(code);
  const buy = await db.query(
    `SELECT COALESCE(SUM(quantity),0) qty, COALESCE(SUM(total),0) cost
       FROM fund_purchases WHERE user_id=$1 AND code=$2 AND trade_date < $3`,
    [userId, c, date]
  );
  const qty = Number(buy.rows[0].qty);
  const cost = Number(buy.rows[0].cost);
  return { code: c, quantity: qty, costBasis: cost, avgCost: qty > 0 ? cost / qty : 0 };
}

async function holdings(userId) {
  const res = await db.query(
    `SELECT code, SUM(quantity) qty, SUM(total) cost
       FROM fund_purchases WHERE user_id=$1
      GROUP BY code ORDER BY code`,
    [userId]
  );
  return res.rows
    .map((r) => {
      const qty = Number(r.qty);
      const cost = Number(r.cost);
      return { code: r.code, quantity: qty, costBasis: cost, avgCost: qty > 0 ? cost / qty : 0 };
    })
    .filter((h) => h.quantity > 0 || h.costBasis !== 0);
}

async function summary(userId) {
  const list = await holdings(userId);
  const prices = await priceMap();

  list.forEach((h) => {
    const p = prices[h.code];
    h.title = p ? p.title : '';
    h.currentPrice = p && p.price > 0 ? p.price : null;
    h.priceIsOld = !!(h.currentPrice !== null && p.isOld);
    h.currentValue = h.currentPrice !== null ? h.currentPrice * h.quantity : null;
    h.profit = h.currentValue !== null ? h.currentValue - h.costBasis : null;
    h.profitPct = h.currentValue !== null && h.costBasis > 0 ? ((h.currentValue - h.costBasis) / h.costBasis) * 100 : null;
  });

  const hasPrice = list.some((h) => h.currentValue !== null);
  const totalCost = list.reduce((s, h) => s + h.costBasis, 0);
  const totalValue = list.reduce((s, h) => s + (h.currentValue || 0), 0);

  return {
    holdings: list,
    totalCost,
    totalValue: hasPrice ? totalValue : null,
    totalProfit: hasPrice ? totalValue - totalCost : null,
  };
}

async function pricesList() {
  const r = await db.query(`${PRICE_SELECT} ORDER BY fp.code`);
  return r.rows.map((x) => {
    const { price, isOld } = effectivePrice(x);
    return { code: x.code, title: x.title || '', price, priceIsOld: isOld, updated_at: x.updated_at };
  });
}

module.exports = { normCode, priceMap, rememberGoodPrices, holdingsBeforeDate, holdings, summary, pricesList };
