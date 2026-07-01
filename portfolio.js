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
  // su ana kadar odenen toplam komisyon+bsmv = total - (adet*fiyat)
  const commRes = await db.query(
    `SELECT COALESCE(SUM(total - quantity * price),0) AS v FROM purchases WHERE user_id = $1`,
    [userId]
  );
  // net yatirilan para: nakit girisleri (temettu ve Nakit duzeltme haric)
  const contribRes = await db.query(
    `SELECT COALESCE(SUM(amount),0) AS v FROM cash_movements
      WHERE user_id = $1 AND kind = 'cash' AND COALESCE(note,'') <> 'Nakit düzeltme'`,
    [userId]
  );

  return {
    cash,
    holdings,
    totalCostBasis,
    totalDividends,
    totalDeposits: Number(cashInRes.rows[0].v),
    totalDividendIncome: Number(allDivRes.rows[0].v),
    totalCommission: Number(commRes.rows[0].v),
    netContributions: Number(contribRes.rows[0].v),
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
              )) AS value,
              (SELECT COALESCE(SUM(c.amount), 0) FROM cash_movements c
                 WHERE c.user_id = $1 AND c.kind = 'cash'
                   AND COALESCE(c.note, '') <> 'Nakit düzeltme'
                   AND c.move_date <= ph.date) AS deposits
         FROM price_history ph
        WHERE ph.symbol IN (SELECT DISTINCT symbol FROM purchases WHERE user_id = $1)
          AND ph.date >= GREATEST($2::date,
                (SELECT MIN(trade_date) FROM purchases WHERE user_id = $1))
        GROUP BY ph.date
        ORDER BY ph.date`,
      [userId, fromDate]
    );
    return res.rows.map((r) => ({
      date: r.date,
      value: Number(r.value),
      deposits: Number(r.deposits),
    }));
  } catch (err) {
    if (err.code === '42P01') return []; // price_history tablosu yoksa
    throw err;
  }
}

// Gecmis fiyati olan hisse kodlari (hesap makinesi dropdown'u icin)
async function historySymbols() {
  try {
    const r = await db.query('SELECT DISTINCT symbol FROM price_history ORDER BY symbol');
    return r.rows.map((x) => x.symbol);
  } catch (err) {
    if (err.code === '42P01') return [];
    throw err;
  }
}

// Temettu takvimini listele (opsiyonel sembol filtresi)
async function listDividends(symbol) {
  if (symbol) {
    const r = await db.query(
      'SELECT * FROM dividends WHERE symbol = $1 ORDER BY pay_date DESC, id DESC',
      [symbol.trim().toUpperCase()]
    );
    return r.rows;
  }
  const r = await db.query('SELECT * FROM dividends ORDER BY pay_date DESC, id DESC');
  return r.rows;
}

// Duzenli alim (DCA) hesabi: start tarihinden itibaren her islem gununde
// 'daily' TL'lik alim yapilsaydi bugun ne kadar olurdu.
// reinvest=true ise temettu (net) ile o gunku fiyattan hisse alinir;
// degilse temettu nakit olarak biriktirilir.
async function dca(symbol, start, daily, reinvest = false) {
  const sym = symbol.trim().toUpperCase();
  const startDate = start < '2025-08-01' ? '2025-08-01' : start;
  const empty = {
    symbol: sym, start: startDate, daily, days: 0, invested: 0, totalShares: 0,
    lastDate: null, lastClose: 0, currentValue: 0, dividendCash: 0, dividendCount: 0,
    reinvest, total: 0, profit: 0, profitPct: 0,
  };
  try {
    const r = await db.query(
      `SELECT date, close FROM price_history
        WHERE symbol = $1 AND date >= $2 AND close > 0
        ORDER BY date`,
      [sym, startDate]
    );
    const rows = r.rows;
    const days = rows.length;
    if (!days) return empty;
    const lastDate = rows[days - 1].date;

    // bu sembolun, donem icindeki temettuleri (net, hisse basina)
    const divRes = await db.query(
      `SELECT pay_date, net FROM dividends
        WHERE symbol = $1 AND pay_date >= $2 AND pay_date <= $3
        ORDER BY pay_date`,
      [sym, startDate, lastDate]
    );
    const divs = divRes.rows;

    let shares = 0;
    let invested = 0;
    let dividendCash = 0;
    let dividendCount = 0;
    let lastClose = 0;
    let di = 0;
    for (const row of rows) {
      const close = Number(row.close);
      // bugune (<=) gelen temettuleri, gunluk alimdan ONCE isle (elde tutulan adet uzerinden)
      while (di < divs.length && divs[di].pay_date <= row.date) {
        const netPer = Number(divs[di].net);
        const cash = shares * netPer;
        if (cash > 0) {
          if (reinvest) {
            const p = divs[di].pay_date === row.date ? close : lastClose || close;
            if (p > 0) shares += cash / p;
          } else {
            dividendCash += cash;
          }
          dividendCount++;
        }
        di++;
      }
      shares += daily / close;
      invested += daily;
      lastClose = close;
    }
    const currentValue = shares * lastClose;
    const total = currentValue + dividendCash;
    return {
      symbol: sym, start: startDate, daily, days, invested,
      totalShares: shares, lastDate, lastClose, currentValue,
      dividendCash, dividendCount, reinvest, total,
      profit: total - invested,
      profitPct: invested > 0 ? ((total - invested) / invested) * 100 : 0,
    };
  } catch (err) {
    if (err.code === '42P01') return empty;
    throw err;
  }
}

// Ortak: bir sembolun startDate'ten itibaren (gun, kapanis) serisi + donem temettuleri.
// dca/simulate fonksiyonlari ayni veriyi kullanir.
async function _priceAndDivs(sym, startDate) {
  const r = await db.query(
    `SELECT date, close FROM price_history
      WHERE symbol = $1 AND date >= $2 AND close > 0
      ORDER BY date`,
    [sym, startDate]
  );
  const rows = r.rows;
  if (!rows.length) return { rows: [], divs: [] };
  const lastDate = rows[rows.length - 1].date;
  const divRes = await db.query(
    `SELECT pay_date, net FROM dividends
      WHERE symbol = $1 AND pay_date >= $2 AND pay_date <= $3
      ORDER BY pay_date`,
    [sym, startDate, lastDate]
  );
  return { rows, divs: divRes.rows };
}

// Strateji 1: Maliyet dususunde alim.
// Ilk gun 'qty' adet alinir. Sonraki her gun, kapanis ortalama maliyetin
// 'dropPct' yuzde altina inerse yeniden alim yapilir:
//   mode='qty'    -> yine 'qty' adet
//   mode='amount' -> ilk alimin TL degeri kadar (qty * ilk kapanis)
// reinvest=true ise gelen temettu o gunku fiyattan hisseye donusur (avg maliyeti dusurur).
async function simulateDip(symbol, start, qty, dropPct, mode, reinvest = false) {
  const sym = symbol.trim().toUpperCase();
  const startDate = start < '2025-08-01' ? '2025-08-01' : start;
  const m = mode === 'amount' ? 'amount' : 'qty';
  const empty = {
    symbol: sym, start: startDate, qty, dropPct, mode: m, reinvest,
    days: 0, buys: 0, invested: 0, totalShares: 0, lastDate: null, lastClose: 0,
    avgCost: 0, currentValue: 0, dividendCash: 0, dividendCount: 0, total: 0,
    profit: 0, profitPct: 0,
  };
  try {
    const { rows, divs } = await _priceAndDivs(sym, startDate);
    if (!rows.length) return empty;
    const lastDate = rows[rows.length - 1].date;
    const firstClose = Number(rows[0].close);
    const fixedAmount = qty * firstClose; // mode='amount' icin sabit TL
    let shares = 0, costBasis = 0, invested = 0;
    let dividendCash = 0, dividendCount = 0, buys = 0, lastClose = 0, di = 0;
    for (let i = 0; i < rows.length; i++) {
      const close = Number(rows[i].close);
      // once temettuleri isle (elde tutulan adet uzerinden)
      while (di < divs.length && divs[di].pay_date <= rows[i].date) {
        const cash = shares * Number(divs[di].net);
        if (cash > 0) {
          if (reinvest) { if (close > 0) shares += cash / close; }
          else dividendCash += cash;
          dividendCount++;
        }
        di++;
      }
      if (i === 0) {
        shares += qty; costBasis += qty * close; invested += qty * close; buys++;
      } else {
        const avg = shares > 0 ? costBasis / shares : 0;
        if (avg > 0 && close <= avg * (1 - dropPct / 100)) {
          if (m === 'amount') { shares += fixedAmount / close; costBasis += fixedAmount; invested += fixedAmount; }
          else { shares += qty; costBasis += qty * close; invested += qty * close; }
          buys++;
        }
      }
      lastClose = close;
    }
    const avgCost = shares > 0 ? costBasis / shares : 0;
    const currentValue = shares * lastClose;
    const total = currentValue + dividendCash;
    return {
      symbol: sym, start: startDate, qty, dropPct, mode: m, reinvest,
      days: rows.length, buys, invested, totalShares: shares, lastDate, lastClose,
      avgCost, currentValue, dividendCash, dividendCount, total,
      profit: total - invested, profitPct: invested > 0 ? ((total - invested) / invested) * 100 : 0,
    };
  } catch (err) {
    if (err.code === '42P01') return empty;
    throw err;
  }
}

// Strateji 2: Periyodik alim.
// Ilk gun 'qty' adet alinir; sonra her 'period' (day|week) bir tekrar alim:
//   mode='qty'    -> yine 'qty' adet
//   mode='amount' -> ilk alimin TL degeri kadar
// reinvest=true ise temettu o gunku fiyattan hisseye donusur.
async function simulatePeriodic(symbol, start, qty, period, mode, reinvest = false) {
  const sym = symbol.trim().toUpperCase();
  const startDate = start < '2025-08-01' ? '2025-08-01' : start;
  const m = mode === 'amount' ? 'amount' : 'qty';
  const per = period === 'week' ? 'week' : 'day';
  const empty = {
    symbol: sym, start: startDate, qty, period: per, mode: m, reinvest,
    days: 0, buys: 0, invested: 0, totalShares: 0, lastDate: null, lastClose: 0,
    avgCost: 0, currentValue: 0, dividendCash: 0, dividendCount: 0, total: 0,
    profit: 0, profitPct: 0,
  };
  try {
    const { rows, divs } = await _priceAndDivs(sym, startDate);
    if (!rows.length) return empty;
    const lastDate = rows[rows.length - 1].date;
    const firstClose = Number(rows[0].close);
    const fixedAmount = qty * firstClose;
    const WEEK = 7 * 86400000;
    let shares = 0, costBasis = 0, invested = 0;
    let dividendCash = 0, dividendCount = 0, buys = 0, lastClose = 0, di = 0, lastBuyTime = null;
    for (let i = 0; i < rows.length; i++) {
      const close = Number(rows[i].close);
      while (di < divs.length && divs[di].pay_date <= rows[i].date) {
        const cash = shares * Number(divs[di].net);
        if (cash > 0) {
          if (reinvest) { if (close > 0) shares += cash / close; }
          else dividendCash += cash;
          dividendCount++;
        }
        di++;
      }
      const t = new Date(rows[i].date).getTime();
      let doBuy = i === 0;
      if (i > 0) doBuy = per === 'week' ? t - lastBuyTime >= WEEK : true;
      if (doBuy) {
        if (m === 'amount') { shares += fixedAmount / close; costBasis += fixedAmount; invested += fixedAmount; }
        else { shares += qty; costBasis += qty * close; invested += qty * close; }
        buys++; lastBuyTime = t;
      }
      lastClose = close;
    }
    const avgCost = shares > 0 ? costBasis / shares : 0;
    const currentValue = shares * lastClose;
    const total = currentValue + dividendCash;
    return {
      symbol: sym, start: startDate, qty, period: per, mode: m, reinvest,
      days: rows.length, buys, invested, totalShares: shares, lastDate, lastClose,
      avgCost, currentValue, dividendCash, dividendCount, total,
      profit: total - invested, profitPct: invested > 0 ? ((total - invested) / invested) * 100 : 0,
    };
  } catch (err) {
    if (err.code === '42P01') return empty;
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
  historySymbols,
  dca,
  simulateDip,
  simulatePeriodic,
  listDividends,
};
