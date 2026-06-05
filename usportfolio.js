const db = require('./db');

// Guncel USD/TRY kuru (en son tarih)
async function currentRate() {
  const r = await db.query('SELECT rate FROM fx_rates ORDER BY date DESC LIMIT 1');
  return r.rows.length ? Number(r.rows[0].rate) : null;
}

// Belirli tarihin USD/TRY kuru. Sirasiyla:
// 1) fx_rates_history'de TAM o tarih
// 2) fx_rates'te TAM o tarih (bugunun/guncel kuru burada olur)
// 3) fx_rates_history'de o tarihten onceki en yakin (eski/hafta sonu tarihleri icin)
async function rateExact(table, date) {
  try {
    const r = await db.query(
      `SELECT date, rate FROM ${table} WHERE date = $1 LIMIT 1`,
      [date]
    );
    if (!r.rows.length) return null;
    return { date: r.rows[0].date, rate: Number(r.rows[0].rate) };
  } catch (err) {
    if (err.code === '42P01') return null; // tablo yok
    throw err;
  }
}

async function rateBefore(table, date) {
  try {
    const r = await db.query(
      `SELECT date, rate FROM ${table} WHERE date <= $1 ORDER BY date DESC LIMIT 1`,
      [date]
    );
    if (!r.rows.length) return null;
    return { date: r.rows[0].date, rate: Number(r.rows[0].rate) };
  } catch (err) {
    if (err.code === '42P01') return null; // tablo yok
    throw err;
  }
}

async function rateOnDate(date) {
  return (
    (await rateExact('fx_rates_history', date)) ||
    (await rateExact('fx_rates', date)) ||
    (await rateBefore('fx_rates_history', date)) ||
    { date: null, rate: null }
  );
}

// ABD hissesinin belirli tarihteki kapanisi (USD)
async function priceOnDate(symbol, date) {
  const sym = symbol.trim().toUpperCase();
  const r = await db.query(
    'SELECT date, close FROM us_price_history WHERE symbol = $1 AND date <= $2 ORDER BY date DESC LIMIT 1',
    [sym, date]
  );
  if (!r.rows.length) return { symbol: sym, date: null, close: null };
  return { symbol: sym, date: r.rows[0].date, close: Number(r.rows[0].close) };
}

async function priceMap() {
  const r = await db.query('SELECT symbol, price FROM us_prices');
  const m = {};
  r.rows.forEach((x) => (m[x.symbol] = Number(x.price)));
  return m;
}

// Bir tarihten ONCE (haric) o hissenin adedi ve ortalama maliyeti (USD)
async function holdingsBeforeDate(userId, symbol, date) {
  const sym = symbol.trim().toUpperCase();
  const buy = await db.query(
    `SELECT COALESCE(SUM(quantity),0) qty, COALESCE(SUM(total),0) cost
       FROM us_purchases WHERE user_id=$1 AND symbol=$2 AND trade_date < $3`,
    [userId, sym, date]
  );
  const div = await db.query(
    `SELECT COALESCE(SUM(amount),0) v FROM us_cash_movements
      WHERE user_id=$1 AND symbol=$2 AND kind='dividend' AND move_date < $3`,
    [userId, sym, date]
  );
  const qty = Number(buy.rows[0].qty);
  const cost = Number(buy.rows[0].cost);
  const dividends = Number(div.rows[0].v);
  const costBasis = cost - dividends;
  return { symbol: sym, quantity: qty, costBasis, avgCost: qty > 0 ? costBasis / qty : 0, dividendsApplied: dividends };
}

async function holdings(userId) {
  const res = await db.query(
    `SELECT p.symbol,
            SUM(p.quantity) qty,
            SUM(p.total) gross_usd,
            SUM(p.total * COALESCE(p.usdtry,0)) gross_try,
            COALESCE((SELECT SUM(c.amount) FROM us_cash_movements c
                       WHERE c.user_id=p.user_id AND c.symbol=p.symbol AND c.kind='dividend'),0) dividends
       FROM us_purchases p
      WHERE p.user_id=$1
      GROUP BY p.symbol, p.user_id
      ORDER BY p.symbol`,
    [userId]
  );
  return res.rows
    .map((r) => {
      const qty = Number(r.qty);
      const grossUSD = Number(r.gross_usd);
      const grossTRY = Number(r.gross_try);
      const dividends = Number(r.dividends);
      const costBasisUSD = grossUSD - dividends;
      return {
        symbol: r.symbol,
        quantity: qty,
        grossUSD,
        costTRY: grossTRY,
        dividends,
        costBasisUSD,
        avgCostUSD: qty > 0 ? costBasisUSD / qty : 0,
      };
    })
    .filter((h) => h.quantity > 0 || h.costBasisUSD !== 0);
}

async function summary(userId) {
  const list = await holdings(userId);
  const prices = await priceMap();
  const rate = await currentRate();

  list.forEach((h) => {
    const p = prices[h.symbol];
    h.currentPrice = p !== undefined ? p : null;
    h.currentValueUSD = p !== undefined ? p * h.quantity : null;
    h.currentValueTRY = h.currentValueUSD !== null && rate !== null ? h.currentValueUSD * rate : null;
    h.profitUSD = h.currentValueUSD !== null ? h.currentValueUSD - h.costBasisUSD : null;
    h.profitPctUSD = h.currentValueUSD !== null && h.costBasisUSD > 0
      ? ((h.currentValueUSD - h.costBasisUSD) / h.costBasisUSD) * 100 : null;
    h.profitTRY = h.currentValueTRY !== null ? h.currentValueTRY - h.costTRY : null;
  });

  const hasPrice = list.some((h) => h.currentValueUSD !== null);
  const totalCostUSD = list.reduce((s, h) => s + h.costBasisUSD, 0);
  const totalCostTRY = list.reduce((s, h) => s + h.costTRY, 0);
  const totalValueUSD = list.reduce((s, h) => s + (h.currentValueUSD || 0), 0);

  const divRes = await db.query(
    `SELECT COALESCE(SUM(amount),0) v FROM us_cash_movements WHERE user_id=$1 AND kind='dividend'`,
    [userId]
  );
  const commRes = await db.query(
    `SELECT COALESCE(SUM(commission),0) v FROM us_purchases WHERE user_id=$1`,
    [userId]
  );

  return {
    rate,
    holdings: list,
    totalCostUSD,
    totalCostTRY,
    totalValueUSD: hasPrice ? totalValueUSD : null,
    totalValueTRY: hasPrice && rate !== null ? totalValueUSD * rate : null,
    totalProfitUSD: hasPrice ? totalValueUSD - totalCostUSD : null,
    totalProfitTRY: hasPrice && rate !== null ? totalValueUSD * rate - totalCostTRY : null,
    totalDividendsUSD: Number(divRes.rows[0].v),
    totalCommissionUSD: Number(commRes.rows[0].v),
  };
}

module.exports = {
  currentRate,
  rateOnDate,
  priceOnDate,
  priceMap,
  holdingsBeforeDate,
  holdings,
  summary,
};
