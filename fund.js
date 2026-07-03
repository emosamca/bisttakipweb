// BIST portfoyunu "birim pay (fon)" mantigiyla degerler (unitization).
// - Ilk katki birim fiyati 1,00 TL kabul edilir; o kadar adet pay alinir.
// - Sonraki her katkida birim fiyat = (o anki portfoy degeri / mevcut pay), yeni
//   para bu fiyattan pay alir. Piyasa hareketi/temettu pay sayisini degistirmez,
//   birim fiyati degistirir. Fon degeri = nakit + hisse (Toplam Varlik).
const db = require('./db');
const portfolio = require('./portfolio');

// Ayni gun icinde olay onceligi: temettu/duzeltme -> katki -> alim
const TP = { dividend: 0, adjust: 1, deposit: 2, buy: 3 };

// Para-agirlikli yillik getiri (XIRR). flows: [{date:'YYYY-MM-DD', amount}]
// Yatirimci bakisi: katkilar negatif (cepten cikar), guncel deger pozitif.
// NPV(r) = SUM(amount / (1+r)^yil) = 0 denklemini bisection ile cozer.
function xirr(flows) {
  if (!flows || flows.length < 2) return null;
  const t0 = new Date(flows[0].date).getTime();
  const yrs = flows.map((f) => (new Date(f.date).getTime() - t0) / (365.25 * 86400000));
  const npv = (r) => flows.reduce((s, f, i) => s + f.amount / Math.pow(1 + r, yrs[i]), 0);
  let lo = -0.9999, hi = 10; // %-99,99 ile %1000 arasi
  let flo = npv(lo), fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null; // kok yok
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (!Number.isFinite(fm)) return null;
    if (Math.abs(fm) < 1e-7) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

async function computeFund(userId) {
  const purchases = (
    await db.query('SELECT trade_date, symbol, quantity, total FROM purchases WHERE user_id=$1 ORDER BY trade_date, id', [userId])
  ).rows.map((r) => ({ date: r.trade_date, symbol: r.symbol, qty: Number(r.quantity), total: Number(r.total) }));

  const moves = (
    await db.query("SELECT move_date, amount, kind, COALESCE(note,'') note FROM cash_movements WHERE user_id=$1 ORDER BY move_date, id", [userId])
  ).rows.map((r) => ({ date: r.move_date, amount: Number(r.amount), kind: r.kind, note: r.note }));

  // Gercek nakit girisleri (katki) = kind cash, "Nakit duzeltme" haric, pozitif
  const deposits = moves.filter((m) => m.kind === 'cash' && m.note !== 'Nakit düzeltme' && m.amount > 0);
  if (!deposits.length) return { hasData: false };
  const startDate = deposits[0].date;

  // price_history (kullanicinin sembolleri)
  let ph = [];
  try {
    ph = (
      await db.query(
        `SELECT symbol, date, close FROM price_history
          WHERE symbol IN (SELECT DISTINCT symbol FROM purchases WHERE user_id=$1) AND date >= $2
          ORDER BY symbol, date`,
        [userId, startDate]
      )
    ).rows;
  } catch (e) {
    if (e.code !== '42P01') throw e;
  }
  const phMap = {};
  for (const r of ph) (phMap[r.symbol] = phMap[r.symbol] || []).push({ date: r.date, close: Number(r.close) });
  const closeOnOrBefore = (sym, date) => {
    const arr = phMap[sym];
    if (!arr || !arr.length) return null;
    let res = null;
    for (const x of arr) {
      if (x.date <= date) res = x.close;
      else break;
    }
    return res === null ? arr[0].close : res; // erken donem: ilk kapanisi ileri tasi
  };

  // ---- Pass 1: olaylari kronolojik isle, her katkida birikimli pay ----
  const events = [];
  for (const p of purchases) events.push({ date: p.date, t: 'buy', p });
  for (const m of moves) {
    if (m.kind === 'dividend') events.push({ date: m.date, t: 'dividend', m });
    else if (m.kind === 'cash' && m.note === 'Nakit düzeltme') events.push({ date: m.date, t: 'adjust', m });
    else if (m.kind === 'cash') events.push({ date: m.date, t: 'deposit', m });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : TP[a.t] - TP[b.t]));

  let units = 0, cash = 0, contributions = 0;
  const holdings = {};
  const depPoints = []; // {date, cumUnits, cumContrib}
  for (const ev of events) {
    if (ev.t === 'buy') {
      cash -= ev.p.total;
      holdings[ev.p.symbol] = (holdings[ev.p.symbol] || 0) + ev.p.qty;
    } else if (ev.t === 'dividend' || ev.t === 'adjust') {
      cash += ev.m.amount;
    } else if (ev.t === 'deposit') {
      let stockVal = 0;
      for (const sym in holdings) {
        const c = closeOnOrBefore(sym, ev.date);
        if (c) stockVal += holdings[sym] * c;
      }
      const vBefore = stockVal + cash;
      const price = units > 0 ? vBefore / units : 1; // ilk katki -> 1,00
      const newUnits = price > 0 ? ev.m.amount / price : 0;
      units += newUnits;
      cash += ev.m.amount;
      contributions += ev.m.amount;
      depPoints.push({ date: ev.date, cumUnits: units, cumContrib: contributions });
    }
  }

  // ---- TUFE (aylik oran %) -> kumulatif endeks ----
  const tufeRows = (await db.query('SELECT ym, rate FROM tufe ORDER BY ym')).rows.map((r) => ({ ym: r.ym, rate: Number(r.rate) }));
  // her girilen ay icin (1+rate/100) carpimiyla kumulatif endeks
  const cumByYm = [];
  let cum = 1;
  for (const t of tufeRows) { cum *= 1 + t.rate / 100; cumByYm.push({ ym: t.ym, cum }); }
  const cumAt = (ym) => {
    let v = 1;
    for (const c of cumByYm) { if (c.ym <= ym) v = c.cum; else break; }
    return v;
  };
  // Baz: baslangic ayindan ONCEKI aylarin kumulatifi (fon ay basinda basladigi icin
  // baslangic ayinin enflasyonu da kiyasa dahil olur).
  const sm = startDate.slice(0, 7);
  let startCum = 1;
  for (const c of cumByYm) { if (c.ym < sm) startCum = c.cum; else break; }
  // baslangictan o tarihe enflasyon carpani (1'den baslar); TUFE yoksa null
  const tufeAt = (date) => (tufeRows.length ? cumAt(date.slice(0, 7)) / startCum : null);
  const tufeStart = tufeRows.length ? 1 : null;

  // ---- USD/TRY gecmisi -> dolar benchmark carpani (TUFE ile ayni mantik) ----
  // Baz = baslangic tarihindeki (veya oncesindeki en yakin) kur; carpan 1'den baslar.
  let fxRows = [];
  try {
    fxRows = (await db.query('SELECT date, rate FROM fx_rates_history ORDER BY date')).rows
      .map((r) => ({ date: r.date, rate: Number(r.rate) }));
  } catch (e) {
    if (e.code !== '42P01') throw e;
  }
  const usdOnOrBefore = (date) => {
    let v = null;
    for (const r of fxRows) { if (r.date <= date) v = r.rate; else break; }
    return v !== null ? v : fxRows.length ? fxRows[0].rate : null; // erken donem: ilk kuru ileri tasi
  };
  const usdBase = usdOnOrBefore(startDate);
  const usdAt = (date) => {
    const v = usdOnOrBefore(date);
    return usdBase && v ? v / usdBase : null;
  };

  // ---- Gunluk seri ----
  const unitsAt = (date) => {
    let u = 0;
    for (const d of depPoints) { if (d.date <= date) u = d.cumUnits; else break; }
    return u;
  };
  const contribAt = (date) => {
    let c = 0;
    for (const d of depPoints) { if (d.date <= date) c = d.cumContrib; else break; }
    return c;
  };

  const gridSet = new Set();
  for (const r of ph) if (r.date >= startDate) gridSet.add(r.date);
  gridSet.add(startDate);
  for (const d of depPoints) gridSet.add(d.date);
  const gridDates = [...gridSet].sort();

  const series = [];
  for (const date of gridDates) {
    const h = {};
    let csh = 0;
    for (const p of purchases) if (p.date <= date) { h[p.symbol] = (h[p.symbol] || 0) + p.qty; csh -= p.total; }
    for (const m of moves) if (m.date <= date) csh += m.amount;
    let stockVal = 0;
    for (const sym in h) { const c = closeOnOrBefore(sym, date); if (c) stockVal += h[sym] * c; }
    const u = unitsAt(date);
    if (u <= 0) continue;
    const value = stockVal + csh;
    const contrib = contribAt(date);
    const ts = tufeAt(date);
    series.push({
      date,
      price: value / u,
      avgCost: contrib / u,
      value,
      units: u,
      contributed: contrib,
      inflation: tufeStart && ts ? ts / tufeStart : null,
      usd: usdAt(date),
    });
  }

  // ---- Canli guncel nokta ----
  const sum = await portfolio.summary(userId);
  const liveValue = sum.totalAssets != null ? sum.totalAssets : series.length ? series[series.length - 1].value : 0;
  const currentPrice = units > 0 ? liveValue / units : 1;
  const avgCost = units > 0 ? contributions / units : 1;
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const inflNow = tufeStart && tufeAt(today) ? tufeAt(today) / tufeStart : series.length ? series[series.length - 1].inflation : null;
  // Guncel kur: fx_rates'teki en son kayit; yoksa gecmisteki son deger
  let usdNow = null;
  if (usdBase) {
    try {
      const r = await db.query('SELECT rate FROM fx_rates ORDER BY date DESC LIMIT 1');
      if (r.rows.length && Number(r.rows[0].rate) > 0) usdNow = Number(r.rows[0].rate) / usdBase;
    } catch (e) {
      if (e.code !== '42P01') throw e;
    }
    if (usdNow === null) usdNow = usdAt(today);
  }
  if (series.length && series[series.length - 1].date === today) {
    const last = series[series.length - 1];
    last.price = currentPrice; last.value = liveValue; last.avgCost = avgCost;
    if (usdNow != null) last.usd = usdNow;
  } else {
    series.push({ date: today, price: currentPrice, avgCost, value: liveValue, units, contributed: contributions, inflation: inflNow, usd: usdNow });
  }

  const gainPct = avgCost > 0 ? (currentPrice / avgCost - 1) * 100 : 0;
  const realReturnPct = inflNow && currentPrice ? (currentPrice / inflNow - 1) * 100 : null;
  // Dolara karsi getiri: birim fiyat USD carpaninin ne kadar ustunde/altinda
  const vsUsdPct = usdNow && currentPrice ? (currentPrice / usdNow - 1) * 100 : null;

  // ---- Getiri metrikleri ----
  // TWR: birim fiyat 1'den basladigi icin kumulatif zaman-agirlikli getiri = fiyat-1.
  // Yillik TWR = fiyat^(365/gun) - 1 (donem 1 yildan kisaysa yillige cevrilmis tahmindir).
  const daysHeld = Math.max(1, Math.round((new Date(today) - new Date(startDate)) / 86400000));
  const twrCumPct = (currentPrice - 1) * 100;
  const twrAnnualPct = currentPrice > 0 ? (Math.pow(currentPrice, 365 / daysHeld) - 1) * 100 : null;
  // XIRR: her katki cepten cikis (negatif), bugunku toplam deger giris (pozitif)
  const flows = deposits.map((d) => ({ date: d.date, amount: -d.amount }));
  flows.push({ date: today, amount: liveValue });
  const xr = liveValue > 0 ? xirr(flows) : null;
  const xirrPct = xr != null ? xr * 100 : null;

  return {
    hasData: true,
    startDate,
    units,
    contributions,
    currentValue: liveValue,
    currentPrice,
    avgCost,
    gainPct,
    gainAbs: liveValue - contributions,
    inflationFactor: inflNow,                                   // baslangictan bugune TUFE carpani (1->X)
    inflationValue: inflNow != null ? contributions * inflNow : null, // kaba: katki * carpan
    realReturnPct,
    hasTufe: tufeRows.length > 0,
    usdFactor: usdNow,                                          // baslangictan bugune USD carpani (1->X)
    vsUsdPct,
    hasUsd: usdBase != null,
    daysHeld,
    twrCumPct,
    twrAnnualPct,
    xirrPct,
    series,
  };
}

module.exports = { computeFund };
