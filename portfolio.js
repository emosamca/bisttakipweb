const db = require('./db');

// Belirli bir tarihten ONCE (o tarih haric) bir hissenin durumu.
// Adet = o tarihten onceki alimlarin toplam adedi
// Maliyet tabani = alim toplamlari - o hisseye ait temettuler
// Ortalama maliyet = maliyet tabani / adet
async function holdingsBeforeDate(userId, symbol, date) {
  const sym = symbol.trim().toUpperCase();
  const buyRes = await db.query(
    `SELECT COALESCE(SUM(quantity),0) AS qty, COALESCE(SUM(total),0) AS cost
       FROM purchases
      WHERE user_id = $1 AND symbol = $2 AND trade_date < $3`,
    [userId, sym, date]
  );
  const divRes = await db.query(
    `SELECT COALESCE(SUM(amount),0) AS div
       FROM cash_movements
      WHERE user_id = $1 AND symbol = $2 AND kind = 'dividend' AND move_date < $3`,
    [userId, sym, date]
  );

  const qty = Number(buyRes.rows[0].qty);
  const cost = Number(buyRes.rows[0].cost);
  const div = Number(divRes.rows[0].div);
  const costBasis = cost - div;
  const avgCost = qty > 0 ? costBasis / qty : 0;

  return { symbol: sym, quantity: qty, costBasis, avgCost, dividendsApplied: div };
}

// Tum portfoyun guncel ozeti (her hisse icin adet + ortalama maliyet)
async function currentPortfolio(userId) {
  const res = await db.query(
    `SELECT p.symbol,
            SUM(p.quantity) AS qty,
            SUM(p.total)    AS cost,
            COALESCE((SELECT SUM(c.amount) FROM cash_movements c
                       WHERE c.user_id = p.user_id AND c.symbol = p.symbol
                         AND c.kind = 'dividend'), 0) AS dividends
       FROM purchases p
      WHERE p.user_id = $1
      GROUP BY p.symbol, p.user_id
      ORDER BY p.symbol`,
    [userId]
  );

  return res.rows
    .map((r) => {
      const qty = Number(r.qty);
      const cost = Number(r.cost);
      const dividends = Number(r.dividends);
      const costBasis = cost - dividends;
      return {
        symbol: r.symbol,
        quantity: qty,
        grossCost: cost,
        dividends,
        costBasis,
        avgCost: qty > 0 ? costBasis / qty : 0,
      };
    })
    .filter((h) => h.quantity > 0 || h.costBasis !== 0);
}

// Nakit bakiye = tum nakit/temettu girisleri - tum alim toplamlari
async function cashBalance(userId) {
  const inRes = await db.query(
    `SELECT COALESCE(SUM(amount),0) AS v FROM cash_movements WHERE user_id = $1`,
    [userId]
  );
  const outRes = await db.query(
    `SELECT COALESCE(SUM(total),0) AS v FROM purchases WHERE user_id = $1`,
    [userId]
  );
  return Number(inRes.rows[0].v) - Number(outRes.rows[0].v);
}

// Ortak fiyat tablosunu sembol -> fiyat seklinde dondur (tum kullanicilar ayni)
async function priceMap() {
  const res = await db.query('SELECT symbol, price FROM prices');
  const map = {};
  res.rows.forEach((r) => {
    map[r.symbol] = Number(r.price);
  });
  return map;
}

// Dashboard ozeti
async function summary(userId) {
  const holdings = await currentPortfolio(userId);
  const cash = await cashBalance(userId);
  const prices = await priceMap();

  // Her hisseye guncel fiyat / deger / kar-zarar ekle
  holdings.forEach((h) => {
    const price = prices[h.symbol];
    h.currentPrice = price !== undefined ? price : null;
    h.currentValue = price !== undefined ? price * h.quantity : null;
    h.profit = h.currentValue !== null ? h.currentValue - h.costBasis : null;
    h.profitPct = h.currentValue !== null && h.costBasis > 0
      ? ((h.currentValue - h.costBasis) / h.costBasis) * 100
      : null;
  });

  const totalCurrentValue = holdings.reduce(
    (s, h) => s + (h.currentValue !== null ? h.currentValue : 0),
    0
  );
  const hasAnyPrice = holdings.some((h) => h.currentValue !== null);
  const totalProfit = holdings.reduce((s, h) => s + (h.profit !== null ? h.profit : 0), 0);

  const totalCostBasis = holdings.reduce((s, h) => s + h.costBasis, 0);
  const totalDividends = holdings.reduce((s, h) => s + h.dividends, 0);

  // toplam nakit girisi (sadece kind='cash')
  const cashInRes = await db.query(
    `SELECT COALESCE(SUM(amount),0) AS v FROM cash_movements WHERE user_id = $1 AND kind = 'cash'`,
    [userId]
  );
  const allDivRes = await db.query(
    `SELECT COALESCE(SUM(amount),0) AS v FROM cash_movements WHERE user_id = $1 AND kind = 'dividend'`,
    [userId]
  );

  return {
    cash,
    holdings,
    totalCostBasis,
    totalDividends,
    totalDeposits: Number(cashInRes.rows[0].v),
    totalDividendIncome: Number(allDivRes.rows[0].v),
    portfolioValueAtCost: totalCostBasis,
    totalCurrentValue: hasAnyPrice ? totalCurrentValue : null,
    totalProfit: hasAnyPrice ? totalProfit : null,
    totalAssets: hasAnyPrice ? totalCurrentValue + cash : null,
  };
}

// Yil yil ve ay ay temettu istatistikleri
async function dividendStats(userId) {
  const res = await db.query(
    `SELECT EXTRACT(YEAR FROM move_date)::int  AS yr,
            EXTRACT(MONTH FROM move_date)::int AS mo,
            SUM(amount) AS total
       FROM cash_movements
      WHERE user_id = $1 AND kind = 'dividend'
      GROUP BY yr, mo
      ORDER BY yr DESC, mo`,
    [userId]
  );

  const byYear = {};
  res.rows.forEach((r) => {
    const yr = r.yr;
    if (!byYear[yr]) byYear[yr] = { year: yr, total: 0, months: Array(12).fill(0) };
    byYear[yr].months[r.mo - 1] = Number(r.total);
    byYear[yr].total += Number(r.total);
  });

  return Object.values(byYear).sort((a, b) => b.year - a.year);
}

// Portfoyun zaman icindeki piyasa degeri (price_history.close ile).
// Her tarihte: o tarihe kadar (<=) alinan adet * o gunku close, hisseler toplami.
async function portfolioHistory(userId, fromDate = '2025-08-01') {
  try {
    const res = await db.query(
      `SELECT ph.date AS date,
              SUM(ph.close * (
                SELECT COALESCE(SUM(p.quantity), 0) FROM purchases p
                 WHERE p.user_id = $1 AND p.symbol = ph.symbol AND p.trade_date <= ph.date
              )) AS value
         FROM price_history ph
        WHERE ph.symbol IN (SELECT DISTINCT symbol FROM purchases WHERE user_id = $1)
          AND ph.date >= GREATEST($2::date,
                (SELECT MIN(trade_date) FROM purchases WHERE user_id = $1))
        GROUP BY ph.date
        ORDER BY ph.date`,
      [userId, fromDate]
    );
    return res.rows.map((r) => ({ date: r.date, value: Number(r.value) }));
  } catch (err) {
    if (err.code === '42P01') return []; // price_history tablosu yoksa
    throw err;
  }
}

// Belirli bir tarihteki kapanis fiyati (yoksa o tarihten onceki en yakin gun)
async function priceOnDate(symbol, date) {
  const sym = symbol.trim().toUpperCase();
  try {
    const r = await db.query(
      `SELECT date, close FROM price_history
        WHERE symbol = $1 AND date <= $2
        ORDER BY date DESC LIMIT 1`,
      [sym, date]
    );
    if (!r.rows.length) return { symbol: sym, date: null, close: null };
    return { symbol: sym, date: r.rows[0].date, close: Number(r.rows[0].close) };
  } catch (err) {
    if (err.code === '42P01') return { symbol: sym, date: null, close: null };
    throw err;
  }
}

module.exports = {
  holdingsBeforeDate,
  currentPortfolio,
  cashBalance,
  summary,
  dividendStats,
  portfolioHistory,
  priceOnDate,
};
