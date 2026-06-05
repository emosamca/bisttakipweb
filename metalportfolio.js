const db = require('./db');

// Desteklenen madenler ve TR etiketleri
const METALS = { gold: 'Altın', silver: 'Gümüş' };

function normMetal(metal) {
  return String(metal || '').trim().toLowerCase();
}

// Guncel gram TL fiyatlari (metal -> fiyat)
async function priceMap() {
  const r = await db.query('SELECT metal, price FROM metal_prices');
  const m = {};
  r.rows.forEach((x) => (m[x.metal] = Number(x.price)));
  return m;
}

// Bir tarihten ONCE (haric) o madenin gram adedi ve ortalama maliyeti (TL/gram)
async function holdingsBeforeDate(userId, metal, date) {
  const m = normMetal(metal);
  const buy = await db.query(
    `SELECT COALESCE(SUM(quantity),0) qty, COALESCE(SUM(total),0) cost
       FROM metal_purchases WHERE user_id=$1 AND metal=$2 AND trade_date < $3`,
    [userId, m, date]
  );
  const qty = Number(buy.rows[0].qty);
  const cost = Number(buy.rows[0].cost);
  return {
    metal: m,
    label: METALS[m] || m,
    quantity: qty,
    costBasis: cost,
    avgCost: qty > 0 ? cost / qty : 0,
  };
}

async function holdings(userId) {
  const res = await db.query(
    `SELECT metal, SUM(quantity) qty, SUM(total) cost
       FROM metal_purchases
      WHERE user_id=$1
      GROUP BY metal
      ORDER BY metal`,
    [userId]
  );
  return res.rows
    .map((r) => {
      const qty = Number(r.qty);
      const cost = Number(r.cost);
      return {
        metal: r.metal,
        label: METALS[r.metal] || r.metal,
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
    const p = prices[h.metal];
    h.currentPrice = p !== undefined ? p : null;
    h.currentValue = p !== undefined ? p * h.quantity : null;
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

module.exports = { priceMap, holdingsBeforeDate, holdings, summary };
