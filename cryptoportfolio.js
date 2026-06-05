const db = require('./db');

// coin sembolunu normalize et: buyuk harf, bosluksuz, sondaki USDT'yi at
function normSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/USDT$/, '');
}

// Guncel USD/TRY (fx_rates'ten)
async function currentRate() {
  const r = await db.query('SELECT rate FROM fx_rates ORDER BY date DESC LIMIT 1');
  return r.rows.length ? Number(r.rows[0].rate) : null;
}

// Guncel kripto fiyatlari (symbol -> USD)
async function priceMap() {
  const r = await db.query('SELECT symbol, price FROM crypto_prices');
  const m = {};
  r.rows.forEach((x) => (m[x.symbol] = Number(x.price)));
  return m;
}

// Bir tarihten ONCE (haric) o coin'in adedi ve ortalama maliyeti (USD)
async function holdingsBeforeDate(userId, symbol, date) {
  const s = normSymbol(symbol);
  const buy = await db.query(
    `SELECT COALESCE(SUM(quantity),0) qty, COALESCE(SUM(total),0) cost
       FROM crypto_purchases WHERE user_id=$1 AND symbol=$2 AND trade_date < $3`,
    [userId, s, date]
  );
  const qty = Number(buy.rows[0].qty);
  const cost = Number(buy.rows[0].cost);
  return { symbol: s, quantity: qty, costBasisUSD: cost, avgCostUSD: qty > 0 ? cost / qty : 0 };
}

async function holdings(userId) {
  const res = await db.query(
    `SELECT symbol, SUM(quantity) qty, SUM(total) cost
       FROM crypto_purchases
      WHERE user_id=$1
      GROUP BY symbol
      ORDER BY symbol`,
    [userId]
  );
  return res.rows
    .map((r) => {
      const qty = Number(r.qty);
      const cost = Number(r.cost);
      return { symbol: r.symbol, quantity: qty, costBasisUSD: cost, avgCostUSD: qty > 0 ? cost / qty : 0 };
    })
    .filter((h) => h.quantity > 0 || h.costBasisUSD !== 0);
}

async function summary(userId) {
  const list = await holdings(userId);
  const prices = await priceMap();
  const rate = await currentRate();

  list.forEach((h) => {
    const p = prices[h.symbol];
    h.currentPrice = p !== undefined && p > 0 ? p : null; // USD/coin
    h.currentPriceTRY = h.currentPrice !== null && rate !== null ? h.currentPrice * rate : null;
    h.currentValueUSD = h.currentPrice !== null ? h.currentPrice * h.quantity : null;
    h.currentValueTRY = h.currentValueUSD !== null && rate !== null ? h.currentValueUSD * rate : null;
    h.profitUSD = h.currentValueUSD !== null ? h.currentValueUSD - h.costBasisUSD : null;
    h.profitPctUSD =
      h.currentValueUSD !== null && h.costBasisUSD > 0
        ? ((h.currentValueUSD - h.costBasisUSD) / h.costBasisUSD) * 100
        : null;
    h.profitTRY = h.profitUSD !== null && rate !== null ? h.profitUSD * rate : null;
  });

  const hasPrice = list.some((h) => h.currentValueUSD !== null);
  const totalCostUSD = list.reduce((s, h) => s + h.costBasisUSD, 0);
  const totalValueUSD = list.reduce((s, h) => s + (h.currentValueUSD || 0), 0);

  return {
    rate,
    holdings: list,
    totalCostUSD,
    totalCostTRY: rate !== null ? totalCostUSD * rate : null,
    totalValueUSD: hasPrice ? totalValueUSD : null,
    totalValueTRY: hasPrice && rate !== null ? totalValueUSD * rate : null,
    totalProfitUSD: hasPrice ? totalValueUSD - totalCostUSD : null,
    totalProfitTRY: hasPrice && rate !== null ? (totalValueUSD - totalCostUSD) * rate : null,
  };
}

// Fiyat tablosu gosterimi: USD + guncel TL karsiligi
async function pricesList() {
  const r = await db.query('SELECT symbol, price, updated_at FROM crypto_prices ORDER BY symbol');
  const rate = await currentRate();
  return r.rows.map((row) => {
    const priceUSD = Number(row.price);
    return {
      symbol: row.symbol,
      priceUSD,
      priceTRY: rate !== null ? priceUSD * rate : null,
      updated_at: row.updated_at,
    };
  });
}

module.exports = { normSymbol, currentRate, priceMap, holdingsBeforeDate, holdings, summary, pricesList };
