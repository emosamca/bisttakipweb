const db = require('./db');

// Desteklenen dovizler ve TR etiketleri
const CURRENCIES = { usd: 'Dolar', eur: 'Euro' };

function normCurrency(currency) {
  return String(currency || '').trim().toLowerCase();
}

// Guncel TL kurlari (currency -> TL/birim).
// USD/TRY zaten fx_rates'te tutuluyor; oradan okunur. EUR'yu servis currency_prices'a yazar.
async function priceMap() {
  const r = await db.query('SELECT currency, price FROM currency_prices');
  const m = {};
  r.rows.forEach((x) => (m[x.currency] = Number(x.price)));
  const fx = await db.query('SELECT rate FROM fx_rates ORDER BY date DESC LIMIT 1');
  if (fx.rows.length) m.usd = Number(fx.rows[0].rate); // USD daima guncel kurdan
  return m;
}

// Bir tarihten ONCE (haric) o dovizin adedi ve ortalama maliyeti (TL/birim)
async function holdingsBeforeDate(userId, currency, date) {
  const c = normCurrency(currency);
  const buy = await db.query(
    `SELECT COALESCE(SUM(quantity),0) qty, COALESCE(SUM(total),0) cost
       FROM currency_purchases WHERE user_id=$1 AND currency=$2 AND trade_date < $3`,
    [userId, c, date]
  );
  const qty = Number(buy.rows[0].qty);
  const cost = Number(buy.rows[0].cost);
  return {
    currency: c,
    label: CURRENCIES[c] || c,
    quantity: qty,
    costBasis: cost,
    avgCost: qty > 0 ? cost / qty : 0,
  };
}

async function holdings(userId) {
  const res = await db.query(
    `SELECT currency, SUM(quantity) qty, SUM(total) cost
       FROM currency_purchases
      WHERE user_id=$1
      GROUP BY currency
      ORDER BY currency`,
    [userId]
  );
  return res.rows
    .map((r) => {
      const qty = Number(r.qty);
      const cost = Number(r.cost);
      return {
        currency: r.currency,
        label: CURRENCIES[r.currency] || r.currency,
        quantity: qty,
        costBasis: cost,
        avgCost: qty > 0 ? cost / qty : 0,
      };
    })
    .filter((h) => h.quantity > 0 || h.costBasis !== 0);
}

async function summary(userId) {
  const list = await holdings(userId);
  const prices = await priceMap();

  list.forEach((h) => {
    const p = prices[h.currency];
    h.currentPrice = p ? p : null; // 0 / undefined => fiyat yok say
    h.currentValue = h.currentPrice !== null ? h.currentPrice * h.quantity : null;
    h.profit = h.currentValue !== null ? h.currentValue - h.costBasis : null;
    h.profitPct =
      h.currentValue !== null && h.costBasis > 0
        ? ((h.currentValue - h.costBasis) / h.costBasis) * 100
        : null;
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

// Fiyat tablosu gosterimi: USD fx_rates'ten (guncel), EUR currency_prices'tan
async function pricesList() {
  const r = await db.query('SELECT currency, price, updated_at FROM currency_prices ORDER BY currency');
  const fx = await db.query('SELECT rate, updated_at FROM fx_rates ORDER BY date DESC LIMIT 1');
  return r.rows.map((row) => {
    let price = Number(row.price);
    let updated_at = row.updated_at;
    if (row.currency === 'usd' && fx.rows.length) {
      price = Number(fx.rows[0].rate);
      updated_at = fx.rows[0].updated_at;
    }
    return { currency: row.currency, label: CURRENCIES[row.currency] || row.currency, price, updated_at };
  });
}

module.exports = { priceMap, holdingsBeforeDate, holdings, summary, pricesList };
