// ---- Yardimcilar ----
const $ = (id) => document.getElementById(id);
const tl = (n) =>
  new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(Number(n) || 0);
const num = (n) =>
  new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 4 }).format(Number(n) || 0);
// Nakit Gucu icin sembolsuz, 2 ondalikli sade sayi (orn: 550.743,50)
const ngfmt = (n) =>
  new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
const usd = (n) =>
  new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'USD' }).format(Number(n) || 0);
// Kripto birim fiyatlari icin 8 ondalik basamak
const usd8 = (n) =>
  new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'USD', minimumFractionDigits: 8, maximumFractionDigits: 8 }).format(Number(n) || 0);
const tl8 = (n) =>
  new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', minimumFractionDigits: 8, maximumFractionDigits: 8 }).format(Number(n) || 0);
// USDT tutari ve yuksek hassasiyetli adet (kripto/binance)
const usdt = (n) =>
  new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0) + ' USDT';
const num8 = (n) =>
  new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 8 }).format(Number(n) || 0);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401 && !path.endsWith('/login')) {
    showLogin();
    throw new Error('Oturum sona erdi');
  }
  const data = await res.json().catch(() => ({}));
  // Parola degisimi zorunluysa (sunucu kapisi) zorunlu modali ac
  if (res.status === 403 && data.mustChange && !path.endsWith('/change-password')) {
    openForcedChange();
    throw new Error(data.error || 'Parola degistirilmeli');
  }
  if (!res.ok) throw new Error(data.error || 'Hata');
  return data;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// HTML kacis (kullanici girdisi guvenligi)
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// Tarih alanini fokusla (gg.aa.yyyy formatinda ilk segment GUN olur).
function focusDate(id) {
  setTimeout(() => $(id).focus(), 30);
}

// ---- Gorunum gecisleri ----
function showLogin() {
  $('appView').classList.add('hidden');
  $('loginView').classList.remove('hidden');
}
let currentRole = 'normal';
function showApp(username, role, mustChange) {
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('userName').textContent = username || '';
  currentRole = role || 'normal';
  const badge = $('userRole');
  badge.textContent = currentRole === 'admin' ? 'admin' : 'normal';
  badge.className = `role-badge ${currentRole}`;
  badge.classList.remove('hidden');
  // Kullanicilar menusu yalnizca admin
  $('openUsers').classList.toggle('hidden', currentRole !== 'admin');

  if (mustChange) {
    openForcedChange(); // zorunlu parola degisimi; pano yuklenmez
    return;
  }
  refreshAll();
  switchDash('genel'); // ilk acilis: Genel sekmesi + dogru menu durumu
  connectEvents();
}

// Canli guncelleme: fiyat degisince (web UI / Windows servisi) ozet + fiyatlari yenile
let eventSource = null;
let priceRefreshTimer = null;
let historyRefreshTimer = null;
let usPriceRefreshTimer = null;
let metalPriceRefreshTimer = null;
let currencyPriceRefreshTimer = null;
let fundsPriceRefreshTimer = null;
let binanceRefreshTimer = null;
let cryptoPriceRefreshTimer = null;
function connectEvents() {
  if (eventSource) return; // zaten bagli
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('price_change', () => {
    // kisa bir debounce ile birden fazla degisikligi tek seferde topla
    clearTimeout(priceRefreshTimer);
    priceRefreshTimer = setTimeout(() => {
      loadSummary();
      loadPrices();
      maybeRefreshGenel();
    }, 250);
  });
  // price_history degisince (servis) portfoy degeri grafigini yenile
  eventSource.addEventListener('history_change', () => {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = setTimeout(() => loadPortfolioHistory(), 300);
  });
  // ABD fiyat / USD-TRY degisince ABD dashboard'u yenile
  // (USD/TRY doviz panosundaki Dolar kurunu da etkiler -> onu da yenile)
  eventSource.addEventListener('us_price_change', () => {
    clearTimeout(usPriceRefreshTimer);
    usPriceRefreshTimer = setTimeout(() => {
      usLoadSummary(); usLoadPrices();
      currencyLoadSummary(); currencyLoadPrices();
      cryptoLoadSummary(); cryptoLoadPrices(); // kripto TL degeri USD/TRY'ye bagli
      maybeRefreshGenel();
    }, 300);
  });
  // Kiymetli maden gram fiyati degisince maden panosunu yenile
  eventSource.addEventListener('metal_price_change', () => {
    clearTimeout(metalPriceRefreshTimer);
    metalPriceRefreshTimer = setTimeout(() => { metalLoadSummary(); metalLoadPrices(); maybeRefreshGenel(); }, 300);
  });
  // Doviz (EUR) kuru degisince doviz panosunu yenile
  eventSource.addEventListener('currency_price_change', () => {
    clearTimeout(currencyPriceRefreshTimer);
    currencyPriceRefreshTimer = setTimeout(() => { currencyLoadSummary(); currencyLoadPrices(); maybeRefreshGenel(); }, 300);
  });
  // Kripto fiyati degisince kripto panosunu yenile
  eventSource.addEventListener('crypto_price_change', () => {
    clearTimeout(cryptoPriceRefreshTimer);
    cryptoPriceRefreshTimer = setTimeout(() => { cryptoLoadSummary(); cryptoLoadPrices(); maybeRefreshGenel(); }, 300);
  });
  // TEFAS fon fiyati degisince fon panosunu yenile
  eventSource.addEventListener('fund_price_change', () => {
    clearTimeout(fundsPriceRefreshTimer);
    fundsPriceRefreshTimer = setTimeout(() => { fundsLoadSummary(); fundsLoadPrices(); maybeRefreshGenel(); }, 300);
  });
  // Binance toplami (5 dk'da bir sunucu yeniler) degisince Genel kartini + acik Binance sayfasini yenile
  eventSource.addEventListener('binance_change', () => {
    clearTimeout(binanceRefreshTimer);
    binanceRefreshTimer = setTimeout(() => {
      maybeRefreshGenel();
      if (!$('binanceDash').classList.contains('hidden')) binanceLoadPortfolio();
    }, 300);
  });
  // hata olursa EventSource kendiliginden yeniden baglanir
}
function disconnectEvents() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

// ---- Giris ----
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('loginError');
  err.classList.add('hidden');
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('loginUser').value, password: $('loginPass').value }),
    });
    showApp(data.username, data.role, data.mustChange);
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  disconnectEvents();
  showLogin();
});

// ---- Modal kontrol ----
const openModal = (id) => $(id).classList.remove('hidden');
const closeModal = (id) => $(id).classList.add('hidden');
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', (e) => {
    const modal = e.target.closest('.modal');
    if (modal.classList.contains('locked')) return; // zorunlu modal kapatilamaz
    modal.classList.add('hidden');
  })
);
document.querySelectorAll('.modal').forEach((m) =>
  m.addEventListener('click', (e) => {
    if (e.target === m && !m.classList.contains('locked')) m.classList.add('hidden');
  })
);

// ---- Alim Ekle / Duzenle ----
function openPurchaseModal(row) {
  $('purchaseForm').reset();
  $('pError').classList.add('hidden');
  if (row) {
    $('purchaseTitle').textContent = 'Alım Düzenle';
    $('pId').value = row.id;
    $('pDate').value = row.trade_date.slice(0, 10);
    $('pSymbol').value = row.symbol;
    $('pQty').value = row.quantity;
    $('pPrice').value = row.price;
    $('pSource').value = row.source;
    $('pUsd').value = row.usd_rate || '';
    $('pCommission').value = row.commission_rate != null ? Number(row.commission_rate) : '';
    $('pBsmv').value = row.bsmv_rate != null ? Number(row.bsmv_rate) : '';
    priceManual = true; // duzenlemede mevcut fiyatin/kurun uzerine yazma
    pUsdManual = true;
  } else {
    $('purchaseTitle').textContent = 'Alım Ekle';
    $('pId').value = '';
    $('pSource').value = 'normal';
    $('pDate').value = todayStr();
    $('pSymbol').value = lastUsedSymbol();
    // komisyon/bsmv son girilen degerleri hatirla
    $('pCommission').value = localStorage.getItem('lastCommission') || '';
    $('pBsmv').value = localStorage.getItem('lastBsmv') || '';
    priceManual = false; // tarih/hisseye gore otomatik doldurulabilir
    pUsdManual = false;
  }
  updatePurchaseCalc();
  updateBeforeInfo();
  maybeAutofillPrice();
  maybeAutofillFx();
  openModal('purchaseModal');
  focusDate('pDate');
}
$('openPurchase').addEventListener('click', () => openPurchaseModal(null));

// Dolar kuru: tarihe gore fx_rates_history'den getir (elle degistirilmediyse)
let pUsdManual = false;
async function maybeAutofillFx() {
  if (pUsdManual) return;
  const date = $('pDate').value;
  if (!date) return;
  try {
    const r = await api(`/api/fx-on?date=${date}`);
    if (pUsdManual) return;
    if (r && r.rate != null) {
      $('pUsd').value = r.rate;
      updatePurchaseCalc();
    }
  } catch (_) {}
}

// Son kullanilan hisse: oncelik localStorage, yoksa en son eklenen alimdan.
function lastUsedSymbol() {
  const saved = localStorage.getItem('lastSymbol');
  if (saved) return saved;
  if (purchaseCache.length) {
    const recent = purchaseCache.reduce((a, b) => (b.id > a.id ? b : a));
    return recent.symbol;
  }
  return '';
}

function updatePurchaseCalc() {
  const qty = Number($('pQty').value) || 0;
  const price = Number($('pPrice').value) || 0;
  const rate = Number($('pUsd').value) || 0;
  const comm = Number($('pCommission').value) || 0;
  const bsmv = Number($('pBsmv').value) || 0;
  const base = qty * price;
  const commission = (base * comm) / 100;
  const bsmvAmt = (commission * bsmv) / 100;
  const fees = commission + bsmvAmt;
  const total = base + fees;
  $('pSubtotal').textContent = tl(base);
  $('pFees').textContent = tl(fees);
  $('pTotal').textContent = tl(total);
  $('pUsdTotal').textContent = rate > 0 ? usd(total / rate) : '—';
}

function resetBeforeInfo() {
  const box = $('pBeforeInfo');
  box.classList.remove('has-data');
  box.innerHTML = 'Hisse ve tarih girin; bu tarihten önceki durum burada gösterilir.';
}

let beforeTimer = null;
async function updateBeforeInfo() {
  const symbol = $('pSymbol').value.trim();
  const date = $('pDate').value;
  const box = $('pBeforeInfo');
  if (!symbol || !date) return resetBeforeInfo();
  try {
    const h = await api(`/api/holdings-before?symbol=${encodeURIComponent(symbol)}&date=${date}`);
    if (h.quantity > 0) {
      box.classList.add('has-data');
      box.innerHTML =
        `<strong>${h.symbol}</strong> — ${date} tarihinden önce: ` +
        `<strong>${num(h.quantity)}</strong> adet, ` +
        `ort. maliyet <strong>${tl(h.avgCost)}</strong> ` +
        `(net maliyet ${tl(h.costBasis)}${h.dividendsApplied ? `, düşülen temettü ${tl(h.dividendsApplied)}` : ''})`;
    } else {
      box.classList.remove('has-data');
      box.innerHTML = `<strong>${h.symbol}</strong> — bu tarihten önce kayıtlı pozisyon yok (ilk alım).`;
    }
  } catch {
    resetBeforeInfo();
  }
}

// Tarih+hisseye gore o gunku fiyati Alis Fiyati alanina getir (elle degistirilmediyse)
let priceManual = false;
async function maybeAutofillPrice() {
  if (priceManual) return;
  const symbol = $('pSymbol').value.trim();
  const date = $('pDate').value;
  if (!symbol || !date) return;
  try {
    const r = await api(`/api/price-on?symbol=${encodeURIComponent(symbol)}&date=${date}`);
    if (priceManual) return; // istek sirasinda kullanici yazdiysa dokunma
    if (r && r.close != null) {
      $('pPrice').value = r.close;
      updatePurchaseCalc();
    }
  } catch (_) {}
}

['pQty', 'pCommission', 'pBsmv'].forEach((id) =>
  $(id).addEventListener('input', updatePurchaseCalc)
);
// Fiyat alanini kullanici elle degistirirse otomatik doldurmayi durdur
$('pPrice').addEventListener('input', () => {
  priceManual = true;
  updatePurchaseCalc();
});
// Dolar kurunu kullanici elle degistirirse otomatik doldurmayi durdur
$('pUsd').addEventListener('input', () => {
  pUsdManual = true;
  updatePurchaseCalc();
});
['pSymbol', 'pDate'].forEach((id) =>
  $(id).addEventListener('input', () => {
    clearTimeout(beforeTimer);
    beforeTimer = setTimeout(() => {
      updateBeforeInfo();
      maybeAutofillPrice();
      maybeAutofillFx();
    }, 350);
  })
);

$('purchaseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('pError');
  err.classList.add('hidden');
  const id = $('pId').value;
  const commission = $('pCommission').value || 0;
  const bsmv = $('pBsmv').value || 0;
  const body = JSON.stringify({
    trade_date: $('pDate').value,
    symbol: $('pSymbol').value,
    quantity: $('pQty').value,
    price: $('pPrice').value,
    source: $('pSource').value,
    usd_rate: $('pUsd').value || null,
    commission_rate: commission,
    bsmv_rate: bsmv,
  });
  try {
    await api(id ? `/api/purchases/${id}` : '/api/purchases', {
      method: id ? 'PUT' : 'POST',
      body,
    });
    const sym = $('pSymbol').value.trim().toUpperCase();
    if (sym) localStorage.setItem('lastSymbol', sym);
    // komisyon/bsmv degerlerini hatirla
    localStorage.setItem('lastCommission', $('pCommission').value || '');
    localStorage.setItem('lastBsmv', $('pBsmv').value || '');
    closeModal('purchaseModal');
    refreshAll();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

// ---- Bedelsiz Pay Ekle ----
function openBonusModal() {
  $('bonusForm').reset();
  $('bError').classList.add('hidden');
  $('bDate').value = todayStr();
  $('bSymbol').value = lastUsedSymbol();
  updateBonusInfo();
  openModal('bonusModal');
  focusDate('bDate');
}
$('openBonus').addEventListener('click', openBonusModal);

// Eklenecek bedelsiz adedini mevcut pozisyondan (purchaseCache) hesaplayip gosterir.
// Backend ile ayni taban: o hisseye ait tum alimlarin adet toplami.
function bonusBaseQty(sym) {
  return purchaseCache
    .filter((r) => r.symbol === sym)
    .reduce((s, r) => s + Number(r.quantity), 0);
}

function updateBonusInfo() {
  const box = $('bInfo');
  const sym = $('bSymbol').value.trim().toUpperCase();
  const ratio = Number($('bRatio').value);
  if (!sym || !(ratio > 0)) {
    box.classList.remove('has-data');
    box.innerHTML = 'Hisse ve oran girin; eklenecek adet burada gösterilir.';
    return;
  }
  const baseQty = bonusBaseQty(sym);
  if (!(baseQty > 0)) {
    box.classList.remove('has-data');
    box.innerHTML = `<strong>${sym}</strong> — bu hisseden pozisyon yok; bedelsiz eklenemez.`;
    return;
  }
  const newShares = Math.round(baseQty * (ratio / 100) * 10000) / 10000;
  box.classList.add('has-data');
  box.innerHTML =
    `<strong>${sym}</strong> — mevcut <strong>${num(baseQty)}</strong> adet, ` +
    `%${num(ratio)} bedelsiz → <strong>+${num(newShares)}</strong> adet ` +
    `(yeni toplam <strong>${num(baseQty + newShares)}</strong>). ` +
    `Ortalama maliyet adet oranında düşer; nakit ve toplam maliyet değişmez.`;
}
['bSymbol', 'bRatio'].forEach((id) => $(id).addEventListener('input', updateBonusInfo));

$('bonusForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('bError');
  err.classList.add('hidden');
  try {
    await api('/api/purchases/bonus', {
      method: 'POST',
      body: JSON.stringify({
        trade_date: $('bDate').value,
        symbol: $('bSymbol').value,
        ratio: $('bRatio').value,
      }),
    });
    const sym = $('bSymbol').value.trim().toUpperCase();
    if (sym) localStorage.setItem('lastSymbol', sym);
    closeModal('bonusModal');
    refreshAll();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

// ---- Bedelli Pay Ekle ----
function openRightsModal() {
  $('rightsForm').reset();
  $('rError').classList.add('hidden');
  $('rDate').value = todayStr();
  $('rSymbol').value = lastUsedSymbol();
  updateRightsInfo();
  openModal('rightsModal');
  focusDate('rDate');
}
$('openRights').addEventListener('click', openRightsModal);

function updateRightsInfo() {
  const box = $('rInfo');
  const sym = $('rSymbol').value.trim().toUpperCase();
  const ratio = Number($('rRatio').value);
  const price = Number($('rPrice').value);
  if (!sym || !(ratio > 0) || !(price > 0)) {
    box.classList.remove('has-data');
    box.innerHTML = 'Hisse, oran ve fiyat girin; eklenecek adet ve maliyet burada gösterilir.';
    return;
  }
  const baseQty = bonusBaseQty(sym);
  if (!(baseQty > 0)) {
    box.classList.remove('has-data');
    box.innerHTML = `<strong>${sym}</strong> — bu hisseden pozisyon yok; bedelli eklenemez.`;
    return;
  }
  const newShares = Math.round(baseQty * (ratio / 100) * 10000) / 10000;
  const cost = newShares * price;
  box.classList.add('has-data');
  box.innerHTML =
    `<strong>${sym}</strong> — mevcut <strong>${num(baseQty)}</strong> adet, ` +
    `%${num(ratio)} bedelli @ <strong>${tl(price)}</strong> → ` +
    `<strong>+${num(newShares)}</strong> adet (yeni toplam <strong>${num(baseQty + newShares)}</strong>). ` +
    `Maliyet <strong>${tl(cost)}</strong> nakitten düşülür.`;
}
['rSymbol', 'rRatio', 'rPrice'].forEach((id) => $(id).addEventListener('input', updateRightsInfo));

$('rightsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('rError');
  err.classList.add('hidden');
  try {
    await api('/api/purchases/rights', {
      method: 'POST',
      body: JSON.stringify({
        trade_date: $('rDate').value,
        symbol: $('rSymbol').value,
        ratio: $('rRatio').value,
        price: $('rPrice').value,
      }),
    });
    const sym = $('rSymbol').value.trim().toUpperCase();
    if (sym) localStorage.setItem('lastSymbol', sym);
    closeModal('rightsModal');
    refreshAll();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

// ---- Nakit / Temettu Ekle / Duzenle ----
function openCashModal(row) {
  $('cashForm').reset();
  $('cError').classList.add('hidden');
  if (row) {
    $('cashTitle').textContent = 'Nakit / Temettü Düzenle';
    $('cId').value = row.id;
    $('cDate').value = row.move_date.slice(0, 10);
    $('cAmount').value = row.amount;
    $('cSymbol').value = row.symbol || '';
    $('cNote').value = row.note || '';
  } else {
    $('cashTitle').textContent = 'Nakit / Temettü Ekle';
    $('cId').value = '';
    $('cDate').value = todayStr();
  }
  openModal('cashModal');
  focusDate('cDate');
}
$('openCash').addEventListener('click', () => openCashModal(null));

$('cashForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('cError');
  err.classList.add('hidden');
  const id = $('cId').value;
  const body = JSON.stringify({
    move_date: $('cDate').value,
    amount: $('cAmount').value,
    symbol: $('cSymbol').value || null,
    note: $('cNote').value || null,
  });
  try {
    await api(id ? `/api/cash/${id}` : '/api/cash', { method: id ? 'PUT' : 'POST', body });
    closeModal('cashModal');
    refreshAll();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

// ---- Fiyat ekle / guncelle ----
function openPriceModal(symbol, price) {
  $('priceForm').reset();
  $('prError').classList.add('hidden');
  $('prSymbol').value = symbol || '';
  $('prPrice').value = price !== undefined ? price : '';
  openModal('priceModal');
  setTimeout(() => $('prSymbol').focus(), 30);
}
$('openPrice').addEventListener('click', () => openPriceModal());
$('openPrice2').addEventListener('click', () => openPriceModal());

$('priceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('prError');
  err.classList.add('hidden');
  try {
    await api('/api/prices', {
      method: 'POST',
      body: JSON.stringify({ symbol: $('prSymbol').value, price: $('prPrice').value }),
    });
    closeModal('priceModal');
    refreshAll();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

// ---- Nakit duzeltme ----
$('openAdjust').addEventListener('click', () => {
  $('adjustForm').reset();
  $('aError').classList.add('hidden');
  $('aDate').value = todayStr();
  $('aCurrent').textContent = tl(currentCash);
  updateAdjustDiff();
  openModal('adjustModal');
  focusDate('aDate');
});

function updateAdjustDiff() {
  const raw = $('aTarget').value;
  const el = $('aDiff');
  if (raw === '') {
    el.textContent = '—';
    el.className = '';
    return;
  }
  const diff = Math.round((Number(raw) - currentCash) * 10000) / 10000;
  const sign = diff > 0 ? '+' : '';
  el.textContent = diff === 0 ? 'Gerek yok (eşit)' : `${sign}${tl(diff)}`;
  el.className = diff > 0 ? 'pos' : diff < 0 ? 'neg' : '';
}
$('aTarget').addEventListener('input', updateAdjustDiff);

$('adjustForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('aError');
  err.classList.add('hidden');
  try {
    await api('/api/cash/adjust', {
      method: 'POST',
      body: JSON.stringify({ move_date: $('aDate').value, target: $('aTarget').value }),
    });
    closeModal('adjustModal');
    refreshAll();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

// ---- Pasta grafigi (saf SVG) ----
const PIE_COLORS = ['#2f81f7', '#3fb950', '#d29922', '#db61a2', '#a371f7', '#f0883e', '#1f6feb', '#56d364', '#e3b341', '#ff7b72'];

function renderPie(holdings, cash) {
  const chart = $('pieChart');
  const legend = $('pieLegend');
  // deger varsa guncel deger, yoksa net maliyet uzerinden dagilim
  const items = holdings
    .map((h) => ({
      symbol: h.symbol,
      value: h.currentValue !== null ? h.currentValue : h.costBasis,
    }))
    .filter((i) => i.value > 0);

  // nakit bakiyeyi de dagilima ekle (pozitifse)
  if (cash > 0) items.push({ symbol: 'Nakit', value: cash });

  const total = items.reduce((s, i) => s + i.value, 0);
  if (!items.length || total <= 0) {
    chart.innerHTML = '<div class="chart-empty">Görüntülenecek veri yok</div>';
    legend.innerHTML = '';
    return;
  }

  const cx = 100, cy = 100, r = 95;
  let angle = -Math.PI / 2;
  let paths = '';
  items.forEach((it, idx) => {
    const slice = (it.value / total) * 2 * Math.PI;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    angle += slice;
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    const large = slice > Math.PI ? 1 : 0;
    const color = PIE_COLORS[idx % PIE_COLORS.length];
    // tek hisse varsa tam daire ciz
    if (items.length === 1) {
      paths += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" />`;
    } else {
      paths += `<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${color}" />`;
    }
  });
  // ic daire (donut gorunum)
  paths += `<circle cx="${cx}" cy="${cy}" r="55" fill="var(--bg-soft)" />`;
  chart.innerHTML = `<svg viewBox="0 0 200 200">${paths}</svg>`;

  legend.innerHTML = items
    .map((it, idx) => {
      const pct = ((it.value / total) * 100).toFixed(1);
      const color = PIE_COLORS[idx % PIE_COLORS.length];
      return `<div class="legend-item">
        <span class="legend-dot" style="background:${color}"></span>
        <span class="lg-name">${it.symbol}</span>
        <span class="lg-val">${tl(it.value)} · %${pct}</span>
      </div>`;
    })
    .join('');
}

// ---- Genel: varlik dagilimi donut grafigi (saf SVG, profesyonel) ----
// items: [{ name, value, color }]
function renderGenelPie(items, total) {
  const chart = $('genPie');
  const legend = $('genLegend');
  const data = items.filter((i) => i.value > 0);
  const sum = data.reduce((s, i) => s + i.value, 0);
  if (!data.length || sum <= 0) {
    chart.innerHTML = '<div class="chart-empty">Görüntülenecek varlık yok</div>';
    legend.innerHTML = '';
    return;
  }

  const cx = 100, cy = 100, rOut = 92, rIn = 58, rLbl = (rOut + rIn) / 2;
  let angle = -Math.PI / 2;
  let svg = '';
  data.forEach((it) => {
    const frac = it.value / sum;
    const slice = frac * 2 * Math.PI;
    const a1 = angle, a2 = angle + slice;
    angle = a2;
    if (data.length === 1) {
      // tek varlik: tam halka
      svg += `<circle cx="${cx}" cy="${cy}" r="${rOut}" fill="${it.color}" />`;
    } else {
      const x1 = cx + rOut * Math.cos(a1), y1 = cy + rOut * Math.sin(a1);
      const x2 = cx + rOut * Math.cos(a2), y2 = cy + rOut * Math.sin(a2);
      const large = slice > Math.PI ? 1 : 0;
      svg += `<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${rOut},${rOut} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${it.color}" stroke="var(--bg-soft)" stroke-width="2" />`;
    }
    // dilim icine yuzde etiketi (yeterince buyukse)
    const pct = frac * 100;
    if (pct >= 6) {
      const mid = (a1 + a2) / 2;
      const lx = cx + rLbl * Math.cos(mid), ly = cy + rLbl * Math.sin(mid);
      svg += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" dominant-baseline="central" class="pie-pct">%${pct.toFixed(0)}</text>`;
    }
  });
  // donut deligi + merkez toplam
  svg += `<circle cx="${cx}" cy="${cy}" r="${rIn}" fill="var(--bg-soft)" />`;
  svg += `<text x="${cx}" y="${cy - 8}" text-anchor="middle" class="pie-center-lbl">Toplam Bütçe</text>`;
  svg += `<text x="${cx}" y="${cy + 12}" text-anchor="middle" class="pie-center-val">${kfmt(total)} ₺</text>`;
  chart.innerHTML = `<svg viewBox="0 0 200 200">${svg}</svg>`;

  legend.innerHTML = data
    .map((it) => {
      const pct = ((it.value / sum) * 100).toFixed(1);
      return `<div class="legend-item">
        <span class="legend-dot" style="background:${it.color}"></span>
        <span class="lg-name">${esc(it.name)}</span>
        <span class="lg-val">${tl(it.value)} · <strong>%${pct}</strong></span>
      </div>`;
    })
    .join('');
}

// ---- Genel: Toplam Butce zaman grafigi (gunluk snapshot'lardan) ----
async function genelLoadChart(liveTotals) {
  let series = [];
  try {
    series = await api('/api/snapshots');
  } catch (_) {}
  renderBudgetChart(series);
  renderPortfolioChart(series);
  renderCardSparks(series, liveTotals);
  renderSnapIndicators(series, liveTotals);
  renderDailyPct(series);
}

// Kartlarin K/Z alt satirina gunluk degisimi parantez icinde ekler:
// son kayitli snapshot ile bir onceki snapshot arasindaki yuzde degisim.
// Yon oklu ve renkli, K/Z ile ayni fontta. Sadece secili 5 sinif icin.
const DAILY_PCT_DEFS = [
  { pctId: 'genBistPct', key: 'bist' },
  { pctId: 'genUsPct', key: 'us' },
  { pctId: 'genMetalPct', key: 'metal' },
  { pctId: 'genCurrencyPct', key: 'currency' },
  { pctId: 'genCryptoPct', key: 'crypto' },
];

function renderDailyPct(series) {
  const s = series || [];
  const last = s[s.length - 1];
  const prev = s[s.length - 2];
  DAILY_PCT_DEFS.forEach((d) => {
    const el = $(d.pctId);
    if (!el) return;
    const old = el.querySelector('.daily-pct');
    if (old) old.remove();
    if (!last || !prev) return;
    const p = Number(prev[d.key]);
    const c = Number(last[d.key]);
    if (!(p > 0) || !Number.isFinite(c)) return;
    const pct = ((c - p) / p) * 100;
    const up = c >= p;
    const span = document.createElement('span');
    span.className = 'daily-pct ' + (up ? 'pos' : 'neg');
    span.textContent = ` (${up ? '▲' : '▼'} %${Math.abs(pct).toFixed(2)})`;
    span.title = `Günlük: son snapshot ${tl(c)} vs önceki ${tl(p)}`;
    el.appendChild(span);
  });
}

// Kart degerinin yaninda son snapshot'a gore yon gostergesi:
// arttiysa yesil yukari ok, azaldiysa kirmizi asagi ok, ayni ise mavi yuvarlak.
function renderSnapIndicators(series, liveTotals) {
  if (!liveTotals) return;
  const last = (series || [])[series.length - 1];
  SPARK_DEFS.forEach((d) => {
    const el = $(d.valId);
    if (!el) return;
    const old = el.querySelector('.snap-ind');
    if (old) old.remove();
    const cur = liveTotals[d.key];
    if (cur == null || !last) return;
    const prev = Number(last[d.key]);
    if (!Number.isFinite(prev)) return;
    const diff = Number(cur) - prev;
    // Sabit 0.5 TL esik: kurus salinimlarini bastirir ama -100 gibi anlamli
    // farklari gosterir (yuzdesel esik buyuk toplamlarda farki yutuyordu).
    const eps = 0.5;
    let cls, sym;
    if (diff > eps) { cls = 'up'; sym = '▲'; }
    else if (diff < -eps) { cls = 'down'; sym = '▼'; }
    else { cls = 'flat'; sym = '●'; }
    // Fark metni: sembolsuz, ondaliksiz, isaretli (orn: +100 / -134). Ayni ise 0.
    const diffTxt =
      cls === 'flat'
        ? '0'
        : (diff >= 0 ? '+' : '-') +
          new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 }).format(Math.abs(diff));
    const span = document.createElement('span');
    span.className = 'snap-ind ' + cls;
    span.textContent = `${sym} ${diffTxt}`;
    span.title = `Son snapshot: ${tl(prev)}  (Δ ${diff >= 0 ? '+' : '-'}${tl(Math.abs(diff))})`;
    el.appendChild(span);
  });
}

// Her kartin altindaki kucuk gidisat grafigi (sparkline). Kaynak: gunluk snapshot serisi.
// key -> snapshot alani, color -> pasta grafigindeki renkle ayni.
const SPARK_DEFS = [
  { id: 'spkBist', key: 'bist', color: '#2f81f7', valId: 'genBist' },
  { id: 'spkUs', key: 'us', color: '#3fb950', valId: 'genUs' },
  { id: 'spkMetal', key: 'metal', color: '#d29922', valId: 'genMetal' },
  { id: 'spkCurrency', key: 'currency', color: '#a371f7', valId: 'genCurrency' },
  { id: 'spkCrypto', key: 'crypto', color: '#f0883e', valId: 'genCrypto' },
  { id: 'spkFunds', key: 'fund', color: '#db61a2', valId: 'genFunds' },
  { id: 'spkCash', key: 'cash', color: '#39c5cf', valId: 'genCash' },
  { id: 'spkBinance', key: 'binance', color: '#f3ba2f', valId: 'genBinance' },
  { id: 'spkTotal', key: 'total', color: '#2f81f7', valId: 'genTotal' },
];

function renderCardSparks(series, liveTotals) {
  SPARK_DEFS.forEach((d) =>
    renderSpark(d.id, series, d.key, d.color, liveTotals ? liveTotals[d.key] : null)
  );
}

function renderSpark(boxId, series, key, color, liveVal) {
  const box = $(boxId);
  if (!box) return;
  const pts = (series || []).map((s) => Number(s[key]) || 0);
  // Canli degeri her zaman son snapshot'in ARKASINA yeni nokta olarak ekle.
  // Boylece son snapshot grafikte kalir, anlik deger ona gore yukseliyor mu
  // dusuyor mu gorunur (snapshot'i degistirmiyoruz).
  if (liveVal != null && Number.isFinite(Number(liveVal))) {
    pts.push(Number(liveVal));
  }
  if (pts.length < 2) {
    box.innerHTML = '<div class="spark-empty">Veri birikiyor…</div>';
    return;
  }
  const W = 240, H = 36, pad = 3;
  let min = Math.min(...pts), max = Math.max(...pts);
  if (min === max) { min = min === 0 ? 0 : min * 0.999; max = max === 0 ? 1 : max * 1.001; }
  const X = (i) => pad + (i / (pts.length - 1)) * (W - pad * 2);
  const Y = (v) => pad + (H - pad * 2) - ((v - min) / (max - min)) * (H - pad * 2);
  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${X(pts.length - 1).toFixed(1)},${(H - pad).toFixed(1)} L${X(0).toFixed(1)},${(H - pad).toFixed(1)} Z`;
  const lx = X(pts.length - 1).toFixed(1), ly = Y(pts[pts.length - 1]).toFixed(1);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${area}" fill="${color}" fill-opacity="0.12"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <circle cx="${lx}" cy="${ly}" r="2.4" fill="${color}" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function renderBudgetChart(series) {
  renderTimeChart('genBudgetChart', series, (s) => Number(s.total), '#2f81f7', 'rgba(47,129,247,0.12)');
}

// Nakit haric portfoy: toplam butce - nakit. Nakit gunluk cok oynadigindan
// asil portfoy gidisatini ayri bir grafikte gosterir.
function renderPortfolioChart(series) {
  renderTimeChart(
    'genPortfolioChart',
    series,
    (s) => Number(s.total) - (Number(s.cash) || 0),
    '#3fb950',
    'rgba(63,185,80,0.12)'
  );
}

function renderTimeChart(boxId, series, valueFn, stroke, fill) {
  const box = $(boxId);
  if (!box) return;
  if (!series || series.length < 2) {
    box.innerHTML = '<div class="chart-empty">Yeterli veri yok — her gün otomatik birikir (en az 2 gün gerekir).</div>';
    return;
  }
  const W = 900, H = 260, pad = { l: 72, r: 16, t: 16, b: 28 };
  const innerW = W - pad.l - pad.r, innerH = H - pad.t - pad.b;
  const vals = series.map((s) => valueFn(s));
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min = min * 0.99; max = max * 1.01 || 1; }
  const X = (i) => pad.l + (i / (series.length - 1)) * innerW;
  const Y = (v) => pad.t + innerH - ((v - min) / (max - min)) * innerH;
  const dline = vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const area = `${dline} L${X(series.length - 1).toFixed(1)},${(pad.t + innerH).toFixed(1)} L${X(0).toFixed(1)},${(pad.t + innerH).toFixed(1)} Z`;
  let grid = '';
  for (let k = 0; k <= 4; k++) {
    const v = min + ((max - min) * k) / 4;
    const y = Y(v);
    grid += `<line class="grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}"/>` +
      `<text class="ytick" x="${pad.l - 6}" y="${(y + 4).toFixed(1)}">${kfmt(v)}</text>`;
  }
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    ${grid}
    <path d="${area}" fill="${fill}"/>
    <path d="${dline}" fill="none" stroke="${stroke}" stroke-width="2"/>
    <text class="xtick" x="${pad.l}" y="${H - 8}" style="text-anchor:start">${shortDate(series[0].date)}</text>
    <text class="xtick" x="${W - pad.r}" y="${H - 8}" style="text-anchor:end">${shortDate(series[series.length - 1].date)}</text>
  </svg>`;
}

// ---- Veri yenileme ----
async function refreshAll() {
  await Promise.all([
    loadSummary(),
    loadPurchases(),
    loadCash(),
    loadPrices(),
    loadDividendStats(),
    loadPortfolioHistory(),
  ]);
}

// ---- Portfoy degeri zaman serisi ----
// historyCache: price_history (close) bazli gecmis; liveValue: prices bazli ANLIK deger
let historyCache = [];
let liveValue = null;
let liveDeposits = null;

async function loadPortfolioHistory() {
  historyCache = await api('/api/portfolio-history');
  renderValueChartCombined();
}

// Gecmis seriye en sona "su an" (canli) noktasini ekleyip cizdir
function renderValueChartCombined() {
  const series = historyCache.slice();
  let liveIdx = -1;
  if (liveValue != null) {
    const today = todayStr();
    // canli noktada yatirilan = guncel net katki; yoksa son gecmis degeri tasi
    const dep =
      liveDeposits != null
        ? liveDeposits
        : series.length
        ? series[series.length - 1].deposits
        : 0;
    const point = { date: today, value: liveValue, deposits: dep };
    if (series.length && series[series.length - 1].date === today) {
      series[series.length - 1] = point;
    } else {
      series.push(point);
    }
    liveIdx = series.length - 1;
  }
  renderValueChart(series, liveIdx);
}

function shortDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y.slice(2)}`;
}
function kfmt(v) {
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 }).format(v);
}

function renderValueChart(series, liveIdx = -1) {
  const box = $('valueChart');
  if (!series || series.length < 2) {
    box.innerHTML = '<div class="chart-empty">Yeterli fiyat geçmişi yok</div>';
    return;
  }
  const W = 900, H = 280, pad = { l: 70, r: 16, t: 16, b: 30 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const hasDep = series.some((s) => s.deposits != null);
  // min/max her iki seriyi de kapsasin
  const allVals = series.flatMap((s) => (hasDep ? [s.value, s.deposits] : [s.value]));
  let min = Math.min(...allVals);
  let max = Math.max(...allVals);
  if (min === max) { min = min * 0.95; max = max * 1.05 || 1; }
  min = Math.max(0, min - (max - min) * 0.08); // alta pay
  const X = (i) => pad.l + innerW * (i / (series.length - 1));
  const Y = (v) => pad.t + innerH * (1 - (v - min) / (max - min));

  const valueLine = series.map((s, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(s.value).toFixed(1)}`).join(' ');
  const area = `${valueLine} L${X(series.length - 1).toFixed(1)},${(pad.t + innerH).toFixed(1)} L${X(0).toFixed(1)},${(pad.t + innerH).toFixed(1)} Z`;
  const depLine = hasDep
    ? series.map((s, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(s.deposits).toFixed(1)}`).join(' ')
    : '';

  // y ekseni
  let grid = '';
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = min + (max - min) * (i / yTicks);
    const y = Y(v);
    grid += `<line class="grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}"/>`;
    grid += `<text class="ytick" x="${pad.l - 8}" y="${(y + 4).toFixed(1)}">${kfmt(v)}</text>`;
  }
  // x ekseni
  let xlab = '';
  const xCount = Math.min(6, series.length);
  for (let i = 0; i < xCount; i++) {
    const idx = Math.round((series.length - 1) * (i / (xCount - 1)));
    xlab += `<text class="xtick" x="${X(idx).toFixed(1)}" y="${H - 10}">${shortDate(series[idx].date)}</text>`;
  }

  // "su an" (canli) noktasi
  let liveMarker = '';
  if (liveIdx >= 0) {
    const lx = X(liveIdx), ly = Y(series[liveIdx].value);
    const anchor = liveIdx === series.length - 1 ? 'end' : 'middle';
    liveMarker =
      `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4.5" fill="#3fb950" stroke="#0d1117" stroke-width="1.5"/>` +
      `<text class="livelbl" x="${lx.toFixed(1)}" y="${(ly - 10).toFixed(1)}" text-anchor="${anchor}">şu an</text>`;
  }

  const depPath = hasDep
    ? `<path d="${depLine}" fill="none" stroke="#d29922" stroke-width="2" stroke-dasharray="5 4"/>`
    : '';

  box.innerHTML =
    `<div class="chart-legend">
       <span class="cl-item"><span class="cl-line" style="background:#2f81f7"></span>Portföy Değeri</span>
       ${hasDep ? '<span class="cl-item"><span class="cl-line dash" style="background:#d29922"></span>Yatırılan Para</span>' : ''}
     </div>
     <svg viewBox="0 0 ${W} ${H}">
      <defs><linearGradient id="vgrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2f81f7" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#2f81f7" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}
      <path d="${area}" fill="url(#vgrad)"/>
      ${depPath}
      <path d="${valueLine}" fill="none" stroke="#2f81f7" stroke-width="2"/>
      ${xlab}
      ${liveMarker}
      <line id="vcVline" class="vline" style="display:none"/>
      <circle id="vcDotDep" r="4" fill="#d29922" stroke="#0d1117" stroke-width="1.5" style="display:none"/>
      <circle id="vcDot" r="4" fill="#2f81f7" stroke="#0d1117" stroke-width="1.5" style="display:none"/>
      <rect x="${pad.l}" y="${pad.t}" width="${innerW}" height="${innerH}" fill="transparent" id="vcHit"/>
    </svg>
    <div id="vcTip" class="vc-tip" style="display:none"></div>`;

  const svg = box.querySelector('svg');
  const dot = $('vcDot'), dotDep = $('vcDotDep'), vline = $('vcVline'), tip = $('vcTip');
  const onMove = (e) => {
    const rect = svg.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fStart = pad.l / W, fEnd = (W - pad.r) / W;
    let f = (fx - fStart) / (fEnd - fStart);
    f = Math.max(0, Math.min(1, f));
    const idx = Math.round(f * (series.length - 1));
    const s = series[idx];
    const px = X(idx), py = Y(s.value);
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.style.display = '';
    vline.setAttribute('x1', px); vline.setAttribute('x2', px);
    vline.setAttribute('y1', pad.t); vline.setAttribute('y2', pad.t + innerH); vline.style.display = '';
    let tipHtml = `<strong>${shortDate(s.date)}</strong>` +
      `<br><span style="color:#4493f8">Değer:</span> ${tl(s.value)}`;
    if (hasDep) {
      const pyd = Y(s.deposits);
      dotDep.setAttribute('cx', px); dotDep.setAttribute('cy', pyd); dotDep.style.display = '';
      const pl = s.value - s.deposits;
      const plColor = pl >= 0 ? '#3fb950' : '#f85149';
      tipHtml +=
        `<br><span style="color:#e3b341">Yatırılan:</span> ${tl(s.deposits)}` +
        `<br><span style="color:${plColor}">K/Z:</span> ${tl(pl)}`;
    }
    tip.innerHTML = tipHtml;
    tip.style.display = '';
    tip.style.left = `${(px / W) * rect.width}px`;
    tip.style.top = `${(Math.min(py, hasDep ? Y(s.deposits) : py) / H) * rect.height}px`;
  };
  svg.addEventListener('mousemove', onMove);
  svg.addEventListener('mouseleave', () => {
    dot.style.display = 'none'; dotDep.style.display = 'none';
    vline.style.display = 'none'; tip.style.display = 'none';
  });
}

const MONTHS_TR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];

async function loadDividendStats() {
  const years = await api('/api/dividend-stats');
  const box = $('dividendStats');
  if (!years.length) {
    box.innerHTML = '<div class="chart-empty">Temettü kaydı yok</div>';
    return;
  }
  box.innerHTML = years
    .map((y) => {
      const months = y.months
        .map(
          (v, i) => `<div class="div-month ${v > 0 ? '' : 'zero'}">
            <span class="m">${MONTHS_TR[i]}</span>
            <span class="v">${v > 0 ? tl(v) : '—'}</span>
          </div>`
        )
        .join('');
      // her zaman 12 aya bolunur
      const avg = y.total / 12;
      return `<div class="div-year">
        <div class="div-year-head">
          <span class="yr">${y.year}</span>
          <div class="yr-right">
            <span class="yr-total">${tl(y.total)}</span>
            <span class="yr-avg">Aylık ort. ${tl(avg)}</span>
          </div>
        </div>
        <div class="div-months">${months}</div>
      </div>`;
    })
    .join('');
}

let currentCash = 0;
async function loadSummary() {
  const s = await api('/api/summary');
  currentCash = s.cash;
  $('cardCash').textContent = tl(s.cash);
  $('cardCash').className = 'card-value' + (s.cash < 0 ? ' neg' : '');
  $('cardValue').textContent = s.totalCurrentValue !== null ? tl(s.totalCurrentValue) : '—';
  $('cardAssets').textContent = s.totalAssets !== null ? tl(s.totalAssets) : '—';
  $('cardCost').textContent = tl(s.totalCostBasis);
  $('cardDiv').textContent = tl(s.totalDividendIncome);
  $('cardCommission').textContent = tl(s.totalCommission || 0);

  if (s.totalProfit !== null) {
    const cls = s.totalProfit >= 0 ? 'pos' : 'neg';
    $('cardProfit').textContent = tl(s.totalProfit);
    $('cardProfit').className = 'card-value ' + cls;
    const pct = s.totalCostBasis > 0 ? ((s.totalProfit / s.totalCostBasis) * 100).toFixed(2) : '0';
    $('cardProfitPct').textContent = `%${pct}`;
    $('cardProfitPct').className = 'card-sub ' + cls;
  } else {
    $('cardProfit').textContent = '—';
    $('cardProfit').className = 'card-value';
    $('cardProfitPct').textContent = 'Fiyat girilmemiş';
    $('cardProfitPct').className = 'card-sub';
  }

  renderPie(s.holdings, s.cash);

  // canli portfoy degeri ve yatirilan parayi grafigin son noktasi olarak guncelle
  liveValue = s.totalCurrentValue;
  liveDeposits = s.netContributions != null ? s.netContributions : null;
  renderValueChartCombined();

  const tb = $('holdingsTable').querySelector('tbody');
  if (!s.holdings.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="6">Henüz hisse yok</td></tr>';
    return;
  }
  tb.innerHTML = s.holdings
    .map((h) => {
      const profitCell =
        h.profit !== null
          ? `<span class="${h.profit >= 0 ? 'pos' : 'neg'}">${tl(h.profit)} (%${h.profitPct !== null ? h.profitPct.toFixed(1) : '0'})</span>`
          : '<span class="muted">—</span>';
      return `<tr>
        <td><strong>${h.symbol}</strong></td>
        <td class="num">${num(h.quantity)}</td>
        <td class="num">${tl(h.avgCost)}</td>
        <td class="num">${h.currentPrice !== null ? tl(h.currentPrice) : '<span class="muted">—</span>'}</td>
        <td class="num">${h.currentValue !== null ? tl(h.currentValue) : '<span class="muted">—</span>'}</td>
        <td class="num">${profitCell}</td>
      </tr>`;
    })
    .join('');
}

// ---- Sayfalama ----
const PAGE_SIZE = 20;
let purchasePage = 1;
let cashPage = 1;

function renderPager(containerId, page, totalItems, onGo) {
  const el = $(containerId);
  const pages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  if (totalItems <= PAGE_SIZE) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML =
    `<button data-go="prev" ${page <= 1 ? 'disabled' : ''}>‹ Önceki</button>` +
    `<span>Sayfa ${page} / ${pages} · ${totalItems} kayıt</span>` +
    `<button data-go="next" ${page >= pages ? 'disabled' : ''}>Sonraki ›</button>`;
  el.querySelector('[data-go="prev"]').onclick = () => onGo(Math.max(1, page - 1));
  el.querySelector('[data-go="next"]').onclick = () => onGo(Math.min(pages, page + 1));
}

let purchaseCache = [];
async function loadPurchases() {
  purchaseCache = await api('/api/purchases');
  // Hisse filtresi seceneklerini guncelle (secimi koru)
  const sel = $('filterSymbol');
  const prev = sel.value;
  const symbols = [...new Set(purchaseCache.map((r) => r.symbol))].sort();
  sel.innerHTML =
    '<option value="">Tüm Hisseler</option>' +
    symbols.map((s) => `<option value="${s}">${s}</option>`).join('');
  sel.value = symbols.includes(prev) ? prev : '';
  renderPurchases();
}

// Alim kaynagi etiketi (Normal / Temettü / Bedelsiz / Bedelli)
function srcLabel(src) {
  return src === 'temettu' ? 'Temettü' : src === 'bedelsiz' ? 'Bedelsiz' : src === 'bedelli' ? 'Bedelli' : 'Normal';
}

function renderPurchases() {
  const fSym = $('filterSymbol').value;
  const fSrc = $('filterSource').value;
  const rows = purchaseCache.filter(
    (r) => (!fSym || r.symbol === fSym) && (!fSrc || r.source === fSrc)
  );
  const tb = $('purchasesTable').querySelector('tbody');
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="9">Kayıt yok</td></tr>';
    renderPager('purchasesPager', 1, 0, () => {});
    return;
  }
  // filtrelenmis toplam (tum sayfalar)
  const fee = (r) => Number(r.total) - Number(r.quantity) * Number(r.price);
  // 0,00'a yuvarlanan (veya kayan nokta artigi) degerleri cizgi goster
  const showFee = (v) => (v >= 0.005 ? tl(v) : '—');
  const totQty = rows.reduce((s, r) => s + Number(r.quantity), 0);
  const totAmt = rows.reduce((s, r) => s + Number(r.total), 0);
  const totFee = rows.reduce((s, r) => s + fee(r), 0);
  // gecerli sayfayi sinirla ve dilimle
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (purchasePage > pages) purchasePage = pages;
  const pageRows = rows.slice((purchasePage - 1) * PAGE_SIZE, purchasePage * PAGE_SIZE);
  tb.innerHTML =
    pageRows
      .map(
        (r) => `<tr>
        <td>${r.trade_date.slice(0, 10)}</td>
        <td><strong>${r.symbol}</strong></td>
        <td class="num">${num(r.quantity)}</td>
        <td class="num">${tl(r.price)}</td>
        <td class="num">${tl(r.total)}</td>
        <td class="num">${showFee(fee(r))}</td>
        <td><span class="tag ${r.source}">${srcLabel(r.source)}</span></td>
        <td class="num">${r.usd_rate ? num(r.usd_rate) : '—'}</td>
        <td><div class="row-actions">
          <button class="edit-btn" data-edit-p="${r.id}" title="Düzenle">✏️</button>
          <button class="del-btn" data-del-p="${r.id}" title="Sil">🗑</button>
        </div></td>
      </tr>`
      )
      .join('') +
    `<tr class="total-row">
        <td colspan="2"><strong>Toplam (${rows.length} kayıt)</strong></td>
        <td class="num"><strong>${num(totQty)}</strong></td>
        <td></td>
        <td class="num"><strong>${tl(totAmt)}</strong></td>
        <td class="num"><strong>${showFee(totFee)}</strong></td>
        <td colspan="3"></td>
      </tr>`;
  tb.querySelectorAll('[data-edit-p]').forEach((b) =>
    b.addEventListener('click', () => openPurchaseModal(purchaseCache.find((x) => x.id == b.dataset.editP)))
  );
  tb.querySelectorAll('[data-del-p]').forEach((b) =>
    b.addEventListener('click', () => del('purchases', b.dataset.delP))
  );
  renderPager('purchasesPager', purchasePage, rows.length, (p) => {
    purchasePage = p;
    renderPurchases();
  });
}

$('filterSymbol').addEventListener('change', () => { purchasePage = 1; renderPurchases(); });
$('filterSource').addEventListener('change', () => { purchasePage = 1; renderPurchases(); });

let cashCache = [];
async function loadCash() {
  cashCache = await api('/api/cash');
  renderCash();
}

function renderCash() {
  const rows = cashCache;
  const tb = $('cashTable').querySelector('tbody');
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="6">Kayıt yok</td></tr>';
    renderPager('cashPager', 1, 0, () => {});
    return;
  }
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (cashPage > pages) cashPage = pages;
  const pageRows = rows.slice((cashPage - 1) * PAGE_SIZE, cashPage * PAGE_SIZE);
  tb.innerHTML = pageRows
    .map(
      (r) => `<tr>
        <td>${r.move_date.slice(0, 10)}</td>
        <td><span class="tag ${r.kind}">${r.kind === 'dividend' ? 'Temettü' : 'Nakit'}</span></td>
        <td>${r.symbol || '—'}</td>
        <td class="num">${tl(r.amount)}</td>
        <td>${r.note || ''}</td>
        <td><div class="row-actions">
          <button class="edit-btn" data-edit-c="${r.id}" title="Düzenle">✏️</button>
          <button class="del-btn" data-del-c="${r.id}" title="Sil">🗑</button>
        </div></td>
      </tr>`
    )
    .join('');
  tb.querySelectorAll('[data-edit-c]').forEach((b) =>
    b.addEventListener('click', () => openCashModal(cashCache.find((x) => x.id == b.dataset.editC)))
  );
  tb.querySelectorAll('[data-del-c]').forEach((b) =>
    b.addEventListener('click', () => del('cash', b.dataset.delC))
  );
  renderPager('cashPager', cashPage, rows.length, (p) => {
    cashPage = p;
    renderCash();
  });
}

async function loadPrices() {
  const rows = await api('/api/prices');
  const tb = $('pricesTable').querySelector('tbody');
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="4">Fiyat girilmemiş</td></tr>';
    return;
  }
  tb.innerHTML = rows
    .map(
      (r) => `<tr>
        <td><strong>${r.symbol}</strong></td>
        <td class="num">${tl(r.price)}</td>
        <td class="muted">${new Date(r.updated_at).toLocaleString('tr-TR')}</td>
        <td><div class="row-actions">
          <button class="del-btn" data-del-pr="${r.id}" title="Sil">🗑</button>
        </div></td>
      </tr>`
    )
    .join('');
  tb.querySelectorAll('[data-del-pr]').forEach((b) =>
    b.addEventListener('click', () => del('prices', b.dataset.delPr))
  );
}

async function del(type, id) {
  if (!confirm('Bu kayıt silinsin mi?')) return;
  await api(`/api/${type}/${id}`, { method: 'DELETE' });
  refreshAll();
}

// ---- Parola degistir (kendi) + ilk giris zorunlu degisimi ----
let pwForced = false;

function openChangePw() {
  pwForced = false;
  $('pwForm').reset();
  $('pwError').classList.add('hidden');
  $('pwTitle').textContent = 'Parola Değiştir';
  $('pwForcedNote').classList.add('hidden');
  $('pwClose').classList.remove('hidden');
  $('pwCancel').classList.remove('hidden');
  $('pwModal').classList.remove('locked');
  openModal('pwModal');
}

function openForcedChange() {
  pwForced = true;
  $('pwForm').reset();
  $('pwError').classList.add('hidden');
  $('pwTitle').textContent = 'Parolanızı Belirleyin';
  $('pwForcedNote').classList.remove('hidden');
  // zorunlu: kapatma/iptal yok
  $('pwClose').classList.add('hidden');
  $('pwCancel').classList.add('hidden');
  $('pwModal').classList.add('locked');
  openModal('pwModal');
}

$('openChangePw').addEventListener('click', openChangePw);

$('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('pwError');
  err.classList.add('hidden');
  const cur = $('pwCurrent').value;
  const n1 = $('pwNew').value;
  const n2 = $('pwNew2').value;
  if (n1 !== n2) {
    err.textContent = 'Yeni parolalar eşleşmiyor';
    err.classList.remove('hidden');
    return;
  }
  try {
    await api('/api/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: cur, newPassword: n1 }),
    });
    $('pwModal').classList.remove('locked');
    closeModal('pwModal');
    if (pwForced) {
      // zorunlu degisim tamam: panoyu yukle
      pwForced = false;
      refreshAll();
      connectEvents();
    } else {
      alert('Parolanız değiştirildi.');
    }
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

// ---- Kullanici yonetimi (admin) ----
$('openUsers').addEventListener('click', () => {
  openModal('usersModal');
  loadUsers();
});

let usersCache = [];
async function loadUsers() {
  const errBox = $('usersError');
  errBox.classList.add('hidden');
  const tb = $('usersTable').querySelector('tbody');
  try {
    usersCache = await api('/api/users');
    tb.innerHTML = usersCache
      .map(
        (u) => `<tr>
          <td><strong>${esc(u.username)}</strong></td>
          <td><span class="role-badge ${u.role}">${u.role === 'admin' ? 'admin' : 'normal'}</span></td>
          <td>${u.must_change_password ? '<span class="muted">İlk giriş parolası bekliyor</span>' : 'Aktif'}</td>
          <td><div class="row-actions">
            <button class="edit-btn" data-edit-u="${u.id}" title="Düzenle">✏️</button>
            <button class="del-btn" data-del-u="${u.id}" title="Sil">🗑</button>
          </div></td>
        </tr>`
      )
      .join('');
    tb.querySelectorAll('[data-edit-u]').forEach((b) =>
      b.addEventListener('click', () => openUserForm(usersCache.find((x) => x.id == b.dataset.editU)))
    );
    tb.querySelectorAll('[data-del-u]').forEach((b) =>
      b.addEventListener('click', () => {
        const u = usersCache.find((x) => x.id == b.dataset.delU);
        deleteUser(u.id, u.username);
      })
    );
  } catch (e2) {
    errBox.textContent = e2.message;
    errBox.classList.remove('hidden');
  }
}

function openUserForm(user) {
  $('userForm').reset();
  $('userFormError').classList.add('hidden');
  if (user) {
    $('userFormTitle').textContent = 'Kullanıcı Düzenle';
    $('uId').value = user.id;
    $('uUsername').value = user.username;
    $('uRole').value = user.role;
    $('uPwHint').textContent = '(boş bırakılırsa değişmez)';
    $('uPassword').required = false;
  } else {
    $('userFormTitle').textContent = 'Yeni Kullanıcı';
    $('uId').value = '';
    $('uRole').value = 'normal';
    $('uPwHint').textContent = '(en az 6 karakter)';
    $('uPassword').required = true;
  }
  openModal('userFormModal');
}

$('newUserBtn').addEventListener('click', () => openUserForm(null));

$('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('userFormError');
  err.classList.add('hidden');
  const id = $('uId').value;
  const body = {
    username: $('uUsername').value,
    role: $('uRole').value,
  };
  const pw = $('uPassword').value;
  if (pw) body.password = pw;
  try {
    await api(id ? `/api/users/${id}` : '/api/users', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    });
    closeModal('userFormModal');
    loadUsers();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

async function deleteUser(id, name) {
  if (!confirm(`"${name}" kullanıcısı ve tüm portföy verileri silinsin mi? Bu işlem geri alınamaz.`)) return;
  const errBox = $('usersError');
  errBox.classList.add('hidden');
  try {
    await api(`/api/users/${id}`, { method: 'DELETE' });
    loadUsers();
  } catch (e2) {
    errBox.textContent = e2.message;
    errBox.classList.remove('hidden');
  }
}

// ---- Hesap makinesi (3 strateji: duzenli / dip / periyodik) ----
let calcSymbolsLoaded = false;

const CALC_INFO = {
  daily: 'Başlangıç tarihinden itibaren <strong>her işlem günü</strong>, kapanış fiyatından girdiğiniz tutarda (₺) alım yapılsaydı bugün ne olurdu?',
  dip: 'İlk gün belirtilen <strong>adet</strong> alınır. Sonra fiyat, o ana kadarki <strong>ortalama maliyetin</strong> belirttiğiniz yüzde altına her düştüğünde tekrar alım yapılır (aynı adet veya aynı ₺ değeri).',
  periodic: 'İlk gün belirtilen <strong>adet</strong> alınır. Sonra seçtiğiniz periyotta (<strong>her gün / her hafta</strong>) tekrar alım yapılır (aynı adet veya aynı ₺ değeri).',
};

function setCalcStrategy(strat) {
  $('calcInfo').innerHTML = CALC_INFO[strat] || '';
  document
    .querySelectorAll('#calcForm .calc-grp')
    .forEach((el) => el.classList.toggle('hidden', el.dataset.grp !== strat));
}
$('calcStrategy').addEventListener('change', () => setCalcStrategy($('calcStrategy').value));

function showCalcErr(msg) {
  const err = $('calcError');
  err.textContent = msg;
  err.classList.remove('hidden');
}

$('openCalc').addEventListener('click', async () => {
  $('calcError').classList.add('hidden');
  $('calcResult').classList.add('hidden');
  openModal('calcModal');
  setCalcStrategy($('calcStrategy').value);
  if (!calcSymbolsLoaded) {
    try {
      const syms = await api('/api/history-symbols');
      $('calcSymbol').innerHTML = syms.length
        ? syms.map((s) => `<option value="${s}">${s}</option>`).join('')
        : '<option value="">(geçmiş fiyat verisi yok)</option>';
      calcSymbolsLoaded = true;
    } catch (e) {
      $('calcError').textContent = e.message;
      $('calcError').classList.remove('hidden');
    }
  }
});

// Sonuc kutusunu stratejiye gore HTML olarak uretir (3 strateji ortak govde).
function renderCalcResult(strategy, r) {
  if (!r.days) return '<div class="cr-row"><span>Bu tarih aralığında fiyat verisi bulunamadı.</span></div>';
  const plClass = r.profit >= 0 ? 'pos' : 'neg';
  const modeLabel = r.mode === 'amount' ? 'aynı ₺ değeri' : 'aynı adet';
  let html = `<div class="cr-row"><span>${r.symbol} · ${shortDate(r.start)} → ${shortDate(r.lastDate)}</span><strong>${r.days} işlem günü</strong></div>`;
  if (strategy === 'daily') {
    html += `<div class="cr-row"><span>Günlük alım</span><strong>${tl(r.daily)}</strong></div>`;
  } else if (strategy === 'dip') {
    html +=
      `<div class="cr-row"><span>İlk alınan adet</span><strong>${num(r.qty)}</strong></div>` +
      `<div class="cr-row"><span>Düşüş eşiği · tekrar</span><strong>%${num(r.dropPct)} · ${modeLabel}</strong></div>` +
      `<div class="cr-row"><span>Toplam alım sayısı</span><strong>${r.buys} kez</strong></div>`;
  } else {
    const perLabel = r.period === 'week' ? 'her hafta' : 'her gün';
    html +=
      `<div class="cr-row"><span>İlk alınan adet</span><strong>${num(r.qty)}</strong></div>` +
      `<div class="cr-row"><span>Periyot · tekrar</span><strong>${perLabel} · ${modeLabel}</strong></div>` +
      `<div class="cr-row"><span>Toplam alım sayısı</span><strong>${r.buys} kez</strong></div>`;
  }
  html +=
    `<div class="cr-row"><span>Toplam yatırılan</span><strong>${tl(r.invested)}</strong></div>` +
    `<div class="cr-row"><span>Biriken hisse adedi</span><strong>${num(r.totalShares)}</strong></div>`;
  if (strategy !== 'daily') {
    html += `<div class="cr-row"><span>Ortalama maliyet</span><strong>${tl(r.avgCost)}</strong></div>`;
  }
  html += `<div class="cr-row"><span>Son kapanış (${shortDate(r.lastDate)})</span><strong>${tl(r.lastClose)}</strong></div>`;
  if (r.dividendCount > 0) {
    html += `<div class="cr-row"><span>Uygulanan temettü</span><strong>${r.dividendCount} kez${r.reinvest ? ' · hisseye dönüştürüldü' : ''}</strong></div>`;
  }
  html += `<div class="cr-row cr-big"><span>Bugünkü hisse değeri</span><strong>${tl(r.currentValue)}</strong></div>`;
  if (!r.reinvest && r.dividendCash > 0) {
    html +=
      `<div class="cr-row"><span>Biriken temettü (nakit)</span><strong>${tl(r.dividendCash)}</strong></div>` +
      `<div class="cr-row cr-big"><span>Toplam (hisse + nakit)</span><strong>${tl(r.total)}</strong></div>`;
  }
  html += `<div class="cr-row"><span>Kâr / Zarar</span><strong class="${plClass}">${tl(r.profit)} (%${r.profitPct.toFixed(1)})</strong></div>`;
  return html;
}

$('calcForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('calcError').classList.add('hidden');
  const strategy = $('calcStrategy').value;
  const symbol = $('calcSymbol').value;
  const start = $('calcStart').value;
  if (!symbol) return showCalcErr('Hisse seçin');
  const reinvest = $('calcReinvest').checked ? '1' : '0';
  const base = `symbol=${encodeURIComponent(symbol)}&start=${start}&reinvest=${reinvest}`;
  let url;
  if (strategy === 'daily') {
    const daily = $('calcDaily').value;
    if (!(Number(daily) > 0)) return showCalcErr('Günlük alım tutarı girin');
    url = `/api/dca?${base}&daily=${encodeURIComponent(daily)}`;
  } else if (strategy === 'dip') {
    const qty = $('calcQtyDip').value, drop = $('calcDrop').value, mode = $('calcModeDip').value;
    if (!(Number(qty) > 0)) return showCalcErr('İlk alınan adet girin');
    if (!(Number(drop) > 0)) return showCalcErr('Düşüş yüzdesi girin');
    url = `/api/calc/dip?${base}&qty=${encodeURIComponent(qty)}&dropPct=${encodeURIComponent(drop)}&mode=${mode}`;
  } else {
    const qty = $('calcQtyPer').value, period = $('calcPeriod').value, mode = $('calcModePer').value;
    if (!(Number(qty) > 0)) return showCalcErr('İlk alınan adet girin');
    url = `/api/calc/periodic?${base}&qty=${encodeURIComponent(qty)}&period=${period}&mode=${mode}`;
  }
  try {
    const r = await api(url);
    const box = $('calcResult');
    box.innerHTML = renderCalcResult(strategy, r);
    box.classList.remove('hidden');
  } catch (e2) {
    showCalcErr(e2.message);
  }
});

// ---- Temettu girisi (takvim) ----
$('openDividends').addEventListener('click', () => {
  $('dividendForm').reset();
  $('dvError').classList.add('hidden');
  $('dvDate').value = todayStr();
  openModal('dividendsModal');
  loadDividends();
});

// brut girilince net = brut*0.825 (kullanici net'i elle degistirmediyse)
let dvNetManual = false;
$('dvNet').addEventListener('input', () => { dvNetManual = true; });
$('dvGross').addEventListener('input', () => {
  if (!dvNetManual) {
    const g = Number($('dvGross').value);
    $('dvNet').value = g > 0 ? +(g * 0.85).toFixed(6) : '';
  }
});

async function loadDividends() {
  const tb = $('dividendsTable').querySelector('tbody');
  try {
    const rows = await api('/api/dividends');
    if (!rows.length) {
      tb.innerHTML = '<tr class="empty-row"><td colspan="5">Kayıt yok</td></tr>';
      return;
    }
    tb.innerHTML = rows
      .map(
        (r) => `<tr>
          <td>${r.pay_date.slice(0, 10)}</td>
          <td><strong>${esc(r.symbol)}</strong></td>
          <td class="num">${tl(r.gross)}</td>
          <td class="num">${tl(r.net)}</td>
          <td><button class="del-btn" data-del-dv="${r.id}" title="Sil">🗑</button></td>
        </tr>`
      )
      .join('');
    tb.querySelectorAll('[data-del-dv]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Bu temettü kaydı silinsin mi?')) return;
        await api(`/api/dividends/${b.dataset.delDv}`, { method: 'DELETE' });
        loadDividends();
      })
    );
  } catch (e) {
    tb.innerHTML = `<tr class="empty-row"><td colspan="5">${esc(e.message)}</td></tr>`;
  }
}

$('dividendForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('dvError');
  err.classList.add('hidden');
  try {
    await api('/api/dividends', {
      method: 'POST',
      body: JSON.stringify({
        pay_date: $('dvDate').value,
        symbol: $('dvSymbol').value,
        gross: $('dvGross').value,
        net: $('dvNet').value,
      }),
    });
    // formu sifirla ama tarihi koru, net-manual bayragini sifirla
    const keepDate = $('dvDate').value;
    $('dividendForm').reset();
    $('dvDate').value = keepDate;
    dvNetManual = false;
    loadDividends();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

// ===================== ABD (US) DASHBOARD =====================
function switchDash(which) {
  const isGenel = which === 'genel';
  const isBist = which === 'bist';
  const isFund = which === 'fund';
  const isUs = which === 'us';
  const isMetal = which === 'metal';
  const isCurrency = which === 'currency';
  const isCrypto = which === 'crypto';
  const isFunds = which === 'funds';
  const isBinance = which === 'binance';
  const isAchv = which === 'achv';
  $('genelDash').classList.toggle('hidden', !isGenel);
  $('bistDash').classList.toggle('hidden', !isBist);
  $('fundDash').classList.toggle('hidden', !isFund);
  $('usDash').classList.toggle('hidden', !isUs);
  $('metalDash').classList.toggle('hidden', !isMetal);
  $('currencyDash').classList.toggle('hidden', !isCurrency);
  $('cryptoDash').classList.toggle('hidden', !isCrypto);
  $('fundsDash').classList.toggle('hidden', !isFunds);
  $('binanceDash').classList.toggle('hidden', !isBinance);
  $('achvDash').classList.toggle('hidden', !isAchv);
  // Her sekme kendi menusunu gosterir; Genel'de Nakit Duzenleme menusu gosterilir.
  // Binance ve Basarimlar sekmesinde menu yoktur (yalnizca Kullanicilar + Parola Degistir).
  $('genelMenu').classList.toggle('hidden', !isGenel);
  $('bistMenu').classList.toggle('hidden', !isBist);
  $('fundMenu').classList.toggle('hidden', !isFund);
  $('usMenu').classList.toggle('hidden', !isUs);
  $('metalMenu').classList.toggle('hidden', !isMetal);
  $('currencyMenu').classList.toggle('hidden', !isCurrency);
  $('cryptoMenu').classList.toggle('hidden', !isCrypto);
  $('fundsMenu').classList.toggle('hidden', !isFunds);
  $('tabGenel').classList.toggle('active', isGenel);
  $('tabBist').classList.toggle('active', isBist);
  $('tabFund').classList.toggle('active', isFund);
  $('tabUs').classList.toggle('active', isUs);
  $('tabMetal').classList.toggle('active', isMetal);
  $('tabCurrency').classList.toggle('active', isCurrency);
  $('tabCrypto').classList.toggle('active', isCrypto);
  $('tabFunds').classList.toggle('active', isFunds);
  $('tabBinance').classList.toggle('active', isBinance);
  $('tabAchv').classList.toggle('active', isAchv);
  if (isFund) fundLoad();
  if (isUs) usRefreshAll();
  if (isMetal) metalRefreshAll();
  if (isCurrency) currencyRefreshAll();
  if (isCrypto) cryptoRefreshAll();
  if (isFunds) fundsRefreshAll();
  if (isBinance) binanceLoad();
  if (isAchv) achievementsLoad();
  if (isGenel) genelLoadSummary();
}
$('tabGenel').addEventListener('click', () => switchDash('genel'));
$('tabBist').addEventListener('click', () => switchDash('bist'));
$('tabFund').addEventListener('click', () => switchDash('fund'));
$('tabUs').addEventListener('click', () => switchDash('us'));
$('tabMetal').addEventListener('click', () => switchDash('metal'));
$('tabCurrency').addEventListener('click', () => switchDash('currency'));
$('tabCrypto').addEventListener('click', () => switchDash('crypto'));
$('tabFunds').addEventListener('click', () => switchDash('funds'));
$('tabBinance').addEventListener('click', () => switchDash('binance'));
$('tabAchv').addEventListener('click', () => switchDash('achv'));

// Genel kartlarina tiklayinca ilgili sekmeye gec
document.querySelectorAll('#genelDash .card[data-goto]').forEach((c) =>
  c.addEventListener('click', () => switchDash(c.dataset.goto))
);

// Genel sekmesi: BIST toplam varligi + ABD guncel TL degeri + kiymetli maden TL degeri => toplam butce
async function genelLoadSummary() {
  // Her istek bagimsiz: biri (ozellikle yavas/flaky binance) hata verirse digerleri
  // yine dolsun diye tek tek yakalayip {} dondur. Boylece "tum kartlar bos" olmaz;
  // sadece basarisiz olan kart '—' gosterir, sonraki refresh'te kendiliginden duzelir.
  const safe = (p) => p.catch(() => ({}));
  const [b, u, m, c, cy, fn, cash, bn] = await Promise.all([
    safe(api('/api/summary')),
    safe(api('/api/us/summary')),
    safe(api('/api/metal/summary')),
    safe(api('/api/currency/summary')),
    safe(api('/api/crypto/summary')),
    safe(api('/api/funds/summary')),
    safe(api('/api/cash-holdings/summary')),
    safe(api('/api/binance/total')),
  ]);
  const bistAssets = b.totalAssets != null ? b.totalAssets : null;
  const usValueTry = u.totalValueTRY != null ? u.totalValueTRY : null;
  const metalValue = m.totalValue != null ? m.totalValue : null;
  const currencyValue = c.totalValue != null ? c.totalValue : null;
  const cryptoValue = cy.totalValueTRY != null ? cy.totalValueTRY : null;
  const fundsValue = fn.totalValue != null ? fn.totalValue : null;
  const cashValue = cash.totalTRY != null ? cash.totalTRY : null;
  const binanceValue = bn.totalTRY != null ? bn.totalTRY : null;
  $('genBist').textContent = bistAssets != null ? tl(bistAssets) : '—';
  $('genUs').textContent = usValueTry != null ? tl(usValueTry) : '—';
  $('genMetal').textContent = metalValue != null ? tl(metalValue) : '—';
  $('genCurrency').textContent = currencyValue != null ? tl(currencyValue) : '—';
  $('genCrypto').textContent = cryptoValue != null ? tl(cryptoValue) : '—';
  $('genFunds').textContent = fundsValue != null ? tl(fundsValue) : '—';
  $('genCash').textContent = cashValue != null ? tl(cashValue) : '—';
  $('genBinance').textContent = binanceValue != null ? tl(binanceValue) : '—';
  $('genBinanceAt').textContent = bn.at ? `Son: ${new Date(bn.at).toLocaleTimeString('tr-TR')}` : (bn.hasKeys === false ? 'Anahtar yok' : '');

  // Kartlarin altinda K/Z yuzdesi (BIST TL, ABD/Kripto USD bazli, maden/doviz TL)
  pctSub('genBistPct', b.totalProfit, b.totalCostBasis);
  pctSub('genUsPct', u.totalProfitUSD, u.totalCostUSD);
  pctSub('genMetalPct', m.totalProfit, m.totalCost);
  pctSub('genCurrencyPct', c.totalProfit, c.totalCost);
  pctSub('genCryptoPct', cy.totalProfitUSD, cy.totalCostUSD);
  pctSub('genFundsPct', fn.totalProfit, fn.totalCost);
  // Toplam butce K/Z: maliyet+kar verisi olan siniflarin TL bazli toplami
  let aggProfit = 0, aggCost = 0;
  const addAgg = (p, cost) => { if (p != null && cost > 0) { aggProfit += p; aggCost += cost; } };
  addAgg(b.totalProfit, b.totalCostBasis);
  addAgg(u.totalProfitTRY, u.totalCostTRY);
  addAgg(m.totalProfit, m.totalCost);
  addAgg(c.totalProfit, c.totalCost);
  addAgg(cy.totalProfitTRY, cy.totalCostTRY);
  addAgg(fn.totalProfit, fn.totalCost);

  const total = (bistAssets || 0) + (usValueTry || 0) + (metalValue || 0) + (currencyValue || 0) + (cryptoValue || 0) + (fundsValue || 0) + (cashValue || 0) + (binanceValue || 0);
  // Toplam butce; dolar karsiligi alt satirda
  const usdRate = cash.usdRate || (cy.rate || null);
  $('genTotal').textContent = tl(total);
  const usdStr = usdRate ? `≈ ${usd(total / usdRate)}` : '';
  // Nakit Gucu (NG) = Toplam Butce - BIST Toplam Varlik (nakit+hisse); yalniz admin gorur
  let ngStr = '';
  if (currentRole === 'admin') {
    const ng = total - (bistAssets || 0);
    ngStr = `<span class="ng-val">NG: ₺${ngfmt(ng)}</span>`;
  }
  $('genTotalUsd').innerHTML = `<span>${usdStr}</span>${ngStr}`;
  pctSub('genTotalPct', aggCost > 0 ? aggProfit : null, aggCost);

  // Kart sparkline'lari icin canli kategori toplamlari (SPARK_DEFS key'leriyle ayni)
  const liveTotals = {
    bist: bistAssets,
    us: usValueTry,
    metal: metalValue,
    currency: currencyValue,
    crypto: cryptoValue,
    fund: fundsValue,
    cash: cashValue,
    binance: binanceValue,
    total,
  };

  renderGenelPie(
    [
      { name: 'BIST', value: bistAssets || 0, color: '#2f81f7' },
      { name: 'ABD', value: usValueTry || 0, color: '#3fb950' },
      { name: 'Kıymetli Maden', value: metalValue || 0, color: '#d29922' },
      { name: 'Döviz', value: currencyValue || 0, color: '#a371f7' },
      { name: 'Kripto', value: cryptoValue || 0, color: '#f0883e' },
      { name: 'Fon', value: fundsValue || 0, color: '#db61a2' },
      { name: 'Nakit', value: cashValue || 0, color: '#39c5cf' },
      { name: 'Binance', value: binanceValue || 0, color: '#f3ba2f' },
    ],
    total
  );

  genelLoadChart(liveTotals);
}
function maybeRefreshGenel() {
  if (!$('genelDash').classList.contains('hidden')) genelLoadSummary();
}

// Bir kartin altina K/Z yuzdesini renkli yaz (profit/cost). Veri yoksa bos birak.
function pctSub(elId, profit, cost) {
  const el = $(elId);
  if (profit == null || !(cost > 0)) {
    el.textContent = '';
    el.className = 'card-sub';
    return;
  }
  const pct = (profit / cost) * 100;
  const up = profit >= 0;
  el.textContent = `${up ? '▲' : '▼'} %${Math.abs(pct).toFixed(2)}`;
  el.className = 'card-sub ' + (up ? 'pos' : 'neg');
}

// ---- Nakit Duzenleme (elde tutulan TL/EUR/USD) ----
async function openCashHoldings() {
  $('cashHoldingsForm').reset();
  $('chError').classList.add('hidden');
  try {
    const h = await api('/api/cash-holdings'); // mevcut degerler otomatik dolsun
    $('chTry').value = h.try || '';
    $('chEur').value = h.eur || '';
    $('chUsd').value = h.usd || '';
  } catch (_) {}
  openModal('cashHoldingsModal');
}
$('openCashHoldings').addEventListener('click', openCashHoldings);
$('genCashCard').addEventListener('click', openCashHoldings);

$('cashHoldingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('chError');
  err.classList.add('hidden');
  const body = JSON.stringify({
    try: $('chTry').value || 0,
    eur: $('chEur').value || 0,
    usd: $('chUsd').value || 0,
  });
  try {
    await api('/api/cash-holdings', { method: 'PUT', body });
    closeModal('cashHoldingsModal');
    genelLoadSummary();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

async function usRefreshAll() {
  await Promise.all([usLoadSummary(), usLoadPrices(), usLoadPurchases(), usLoadCash()]);
}

async function usLoadSummary() {
  const s = await api('/api/us/summary');
  $('usCardRate').textContent = s.rate != null ? tl(s.rate) : '—';
  $('usCardCash').textContent = usd(s.cashUSD || 0);
  $('usCardCashTry').textContent = s.cashTRY != null ? tl(s.cashTRY) : '';
  const cashCls = (s.cashUSD || 0) < 0 ? 'neg' : '';
  $('usCardCash').className = 'card-value ' + cashCls;
  $('usCardCostUsd').textContent = usd(s.totalCostUSD);
  $('usCardCostTry').textContent = tl(s.totalCostTRY);
  $('usCardValueUsd').textContent = s.totalValueUSD != null ? usd(s.totalValueUSD) : '—';
  $('usCardValueTry').textContent = s.totalValueTRY != null ? tl(s.totalValueTRY) : '—';
  $('usCardDiv').textContent = usd(s.totalDividendsUSD);
  $('usCardCommission').textContent = usd(s.totalCommissionUSD || 0);
  if (s.totalProfitUSD != null) {
    const cls = s.totalProfitUSD >= 0 ? 'pos' : 'neg';
    $('usCardProfit').textContent = usd(s.totalProfitUSD);
    $('usCardProfit').className = 'card-value ' + cls;
    const pct = s.totalCostUSD > 0 ? ((s.totalProfitUSD / s.totalCostUSD) * 100).toFixed(2) : '0';
    $('usCardProfitPct').textContent = `%${pct}` + (s.totalProfitTRY != null ? ` · ${tl(s.totalProfitTRY)}` : '');
    $('usCardProfitPct').className = 'card-sub ' + cls;
  } else {
    $('usCardProfit').textContent = '—';
    $('usCardProfit').className = 'card-value';
    $('usCardProfitPct').textContent = 'Fiyat girilmemiş';
    $('usCardProfitPct').className = 'card-sub';
  }

  const tb = $('usHoldingsTable').querySelector('tbody');
  if (!s.holdings.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="9">Henüz ABD hissesi yok</td></tr>';
    return;
  }
  tb.innerHTML = s.holdings
    .map((h) => {
      const pl = h.profitUSD != null
        ? `<span class="${h.profitUSD >= 0 ? 'pos' : 'neg'}">${usd(h.profitUSD)}${h.profitPctUSD != null ? ` (%${h.profitPctUSD.toFixed(1)})` : ''}</span>`
        : '<span class="muted">—</span>';
      return `<tr>
        <td><strong>${esc(h.symbol)}</strong></td>
        <td class="num">${num(h.quantity)}</td>
        <td class="num">${usd(h.avgCostUSD)}</td>
        <td class="num">${h.currentPrice != null ? usd(h.currentPrice) : '<span class="muted">—</span>'}</td>
        <td class="num">${usd(h.costBasisUSD)}</td>
        <td class="num">${tl(h.costTRY)}</td>
        <td class="num">${h.currentValueUSD != null ? usd(h.currentValueUSD) : '<span class="muted">—</span>'}</td>
        <td class="num">${h.currentValueTRY != null ? tl(h.currentValueTRY) : '<span class="muted">—</span>'}</td>
        <td class="num">${pl}</td>
      </tr>`;
    })
    .join('');
}

async function usLoadPrices() {
  const rows = await api('/api/us/prices');
  const tb = $('usPricesTable').querySelector('tbody');
  tb.innerHTML = rows.length
    ? rows
        .map(
          (r) => `<tr>
        <td><strong>${esc(r.symbol)}</strong></td>
        <td class="num">${usd(r.price)}</td>
        <td class="muted">${new Date(r.updated_at).toLocaleString('tr-TR')}</td>
      </tr>`
        )
        .join('')
    : '<tr class="empty-row"><td colspan="3">Fiyat verisi yok</td></tr>';
}

let usPurchaseCache = [];
let usPurchasePage = 1;
async function usLoadPurchases() {
  usPurchaseCache = await api('/api/us/purchases');
  usRenderPurchases();
}
function usRenderPurchases() {
  const rows = usPurchaseCache;
  const tb = $('usPurchasesTable').querySelector('tbody');
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="9">Kayıt yok</td></tr>';
    renderPager('usPurchasesPager', 1, 0, () => {});
    return;
  }
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (usPurchasePage > pages) usPurchasePage = pages;
  const pageRows = rows.slice((usPurchasePage - 1) * PAGE_SIZE, usPurchasePage * PAGE_SIZE);
  tb.innerHTML = pageRows
    .map((r) => {
      const costTry = r.usdtry ? Number(r.total) * Number(r.usdtry) : null;
      return `<tr>
        <td>${r.trade_date.slice(0, 10)}</td>
        <td><strong>${esc(r.symbol)}</strong></td>
        <td class="num">${num(r.quantity)}</td>
        <td class="num">${usd(r.price)}</td>
        <td class="num">${usd(r.total)}</td>
        <td class="num">${r.usdtry ? num(r.usdtry) : '—'}</td>
        <td class="num">${costTry != null ? tl(costTry) : '—'}</td>
        <td><span class="tag ${r.source}">${r.source === 'temettu' ? 'Temettü' : 'Normal'}</span></td>
        <td><div class="row-actions">
          <button class="edit-btn" data-edit-up="${r.id}" title="Düzenle">✏️</button>
          <button class="del-btn" data-del-up="${r.id}" title="Sil">🗑</button>
        </div></td>
      </tr>`;
    })
    .join('');
  tb.querySelectorAll('[data-edit-up]').forEach((b) =>
    b.addEventListener('click', () => usOpenPurchaseModal(usPurchaseCache.find((x) => x.id == b.dataset.editUp)))
  );
  tb.querySelectorAll('[data-del-up]').forEach((b) =>
    b.addEventListener('click', () => usDel('purchases', b.dataset.delUp))
  );
  renderPager('usPurchasesPager', usPurchasePage, rows.length, (p) => { usPurchasePage = p; usRenderPurchases(); });
}

let usCashCache = [];
let usCashPage = 1;
async function usLoadCash() {
  usCashCache = await api('/api/us/cash');
  usRenderCash();
}
function usRenderCash() {
  const rows = usCashCache;
  const tb = $('usCashTable').querySelector('tbody');
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="6">Kayıt yok</td></tr>';
    renderPager('usCashPager', 1, 0, () => {});
    return;
  }
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (usCashPage > pages) usCashPage = pages;
  const pageRows = rows.slice((usCashPage - 1) * PAGE_SIZE, usCashPage * PAGE_SIZE);
  tb.innerHTML = pageRows
    .map(
      (r) => `<tr>
        <td>${r.move_date.slice(0, 10)}</td>
        <td><span class="tag ${r.kind}">${r.kind === 'dividend' ? 'Temettü' : 'Nakit'}</span></td>
        <td>${r.symbol ? esc(r.symbol) : '—'}</td>
        <td class="num">${usd(r.amount)}</td>
        <td>${esc(r.note || '')}</td>
        <td><div class="row-actions">
          <button class="edit-btn" data-edit-uc="${r.id}" title="Düzenle">✏️</button>
          <button class="del-btn" data-del-uc="${r.id}" title="Sil">🗑</button>
        </div></td>
      </tr>`
    )
    .join('');
  tb.querySelectorAll('[data-edit-uc]').forEach((b) =>
    b.addEventListener('click', () => usOpenCashModal(usCashCache.find((x) => x.id == b.dataset.editUc)))
  );
  tb.querySelectorAll('[data-del-uc]').forEach((b) =>
    b.addEventListener('click', () => usDel('cash', b.dataset.delUc))
  );
  renderPager('usCashPager', usCashPage, rows.length, (p) => { usCashPage = p; usRenderCash(); });
}

async function usDel(type, id) {
  if (!confirm('Bu kayıt silinsin mi?')) return;
  await api(`/api/us/${type}/${id}`, { method: 'DELETE' });
  usRefreshAll();
}

// ---- ABD Alım modalı ----
let usPriceManual = false;
let usFxManual = false;
let usBeforeTimer = null;

function usLastSymbol() {
  return localStorage.getItem('usLastSymbol') || '';
}
function usOpenPurchaseModal(row) {
  $('usPurchaseForm').reset();
  $('usPError').classList.add('hidden');
  if (row) {
    $('usPurchaseTitle').textContent = 'ABD Alım Düzenle';
    $('usPId').value = row.id;
    $('usPDate').value = row.trade_date.slice(0, 10);
    $('usPSymbol').value = row.symbol;
    $('usPQty').value = row.quantity;
    $('usPPrice').value = row.price;
    $('usPSource').value = row.source;
    $('usPUsdtry').value = row.usdtry || '';
    $('usPCommission').value = row.commission != null ? Number(row.commission) : '';
    usPriceManual = true;
    usFxManual = true;
  } else {
    $('usPurchaseTitle').textContent = 'ABD Alım Ekle';
    $('usPId').value = '';
    $('usPSource').value = 'normal';
    $('usPDate').value = todayStr();
    $('usPSymbol').value = usLastSymbol();
    // komisyon varsayilan 1.5$ (veya son kullanilan)
    $('usPCommission').value = localStorage.getItem('usLastCommission') || '1.5';
    usPriceManual = false;
    usFxManual = false;
  }
  usUpdateCalc();
  usUpdateBeforeInfo();
  usAutofill();
  openModal('usPurchaseModal');
  focusDate('usPDate');
}
$('usOpenPurchase').addEventListener('click', () => usOpenPurchaseModal(null));

function usUpdateCalc() {
  const qty = Number($('usPQty').value) || 0;
  const price = Number($('usPPrice').value) || 0;
  const fx = Number($('usPUsdtry').value) || 0;
  const comm = Number($('usPCommission').value) || 0; // SABIT USD
  const base = qty * price;
  const total = base + comm;
  $('usPSubtotal').textContent = usd(base);
  $('usPFees').textContent = usd(comm);
  $('usPTotal').textContent = usd(total);
  $('usPTotalTry').textContent = fx > 0 ? tl(total * fx) : '—';
}

function usResetBeforeInfo() {
  const box = $('usPBeforeInfo');
  box.classList.remove('has-data');
  box.innerHTML = 'Hisse ve tarih girin; bu tarihten önceki durum burada gösterilir.';
}
async function usUpdateBeforeInfo() {
  const symbol = $('usPSymbol').value.trim();
  const date = $('usPDate').value;
  const box = $('usPBeforeInfo');
  if (!symbol || !date) return usResetBeforeInfo();
  try {
    const h = await api(`/api/us/holdings-before?symbol=${encodeURIComponent(symbol)}&date=${date}`);
    if (h.quantity > 0) {
      box.classList.add('has-data');
      box.innerHTML = `<strong>${esc(h.symbol)}</strong> — ${date} öncesi: <strong>${num(h.quantity)}</strong> adet, ort. maliyet <strong>${usd(h.avgCost)}</strong>`;
    } else {
      box.classList.remove('has-data');
      box.innerHTML = `<strong>${esc(h.symbol)}</strong> — bu tarihten önce pozisyon yok (ilk alım).`;
    }
  } catch {
    usResetBeforeInfo();
  }
}

// fiyat (USD) ve USD/TRY kurunu tarihe gore otomatik getir
async function usAutofill() {
  const symbol = $('usPSymbol').value.trim();
  const date = $('usPDate').value;
  if (!date) return;
  if (!usFxManual) {
    try {
      const fx = await api(`/api/us/fx-on?date=${date}`);
      if (!usFxManual && fx && fx.rate != null) { $('usPUsdtry').value = fx.rate; usUpdateCalc(); }
    } catch (_) {}
  }
  if (symbol && !usPriceManual) {
    try {
      const pr = await api(`/api/us/price-on?symbol=${encodeURIComponent(symbol)}&date=${date}`);
      if (!usPriceManual && pr && pr.close != null) { $('usPPrice').value = pr.close; usUpdateCalc(); }
    } catch (_) {}
  }
}

['usPQty', 'usPCommission'].forEach((id) => $(id).addEventListener('input', usUpdateCalc));
$('usPPrice').addEventListener('input', () => { usPriceManual = true; usUpdateCalc(); });
$('usPUsdtry').addEventListener('input', () => { usFxManual = true; usUpdateCalc(); });
['usPSymbol', 'usPDate'].forEach((id) =>
  $(id).addEventListener('input', () => {
    clearTimeout(usBeforeTimer);
    usBeforeTimer = setTimeout(() => { usUpdateBeforeInfo(); usAutofill(); }, 350);
  })
);

$('usPurchaseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('usPError');
  err.classList.add('hidden');
  const id = $('usPId').value;
  const body = JSON.stringify({
    trade_date: $('usPDate').value,
    symbol: $('usPSymbol').value,
    quantity: $('usPQty').value,
    price: $('usPPrice').value,
    source: $('usPSource').value,
    usdtry: $('usPUsdtry').value || null,
    commission: $('usPCommission').value || 0,
  });
  try {
    await api(id ? `/api/us/purchases/${id}` : '/api/us/purchases', { method: id ? 'PUT' : 'POST', body });
    const sym = $('usPSymbol').value.trim().toUpperCase();
    if (sym) localStorage.setItem('usLastSymbol', sym);
    localStorage.setItem('usLastCommission', $('usPCommission').value || '');
    closeModal('usPurchaseModal');
    usRefreshAll();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

// ---- ABD Nakit/Temettü modalı ----
function usOpenCashModal(row) {
  $('usCashForm').reset();
  $('usCError').classList.add('hidden');
  if (row) {
    $('usCashTitle').textContent = 'ABD Nakit / Temettü Düzenle';
    $('usCId').value = row.id;
    $('usCDate').value = row.move_date.slice(0, 10);
    $('usCAmount').value = row.amount;
    $('usCSymbol').value = row.symbol || '';
    $('usCNote').value = row.note || '';
  } else {
    $('usCashTitle').textContent = 'ABD Nakit / Temettü Ekle';
    $('usCId').value = '';
    $('usCDate').value = todayStr();
  }
  openModal('usCashModal');
  focusDate('usCDate');
}
$('usOpenCash').addEventListener('click', () => usOpenCashModal(null));

$('usCashForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('usCError');
  err.classList.add('hidden');
  const id = $('usCId').value;
  const body = JSON.stringify({
    move_date: $('usCDate').value,
    amount: $('usCAmount').value,
    symbol: $('usCSymbol').value || null,
    note: $('usCNote').value || null,
  });
  try {
    await api(id ? `/api/us/cash/${id}` : '/api/us/cash', { method: id ? 'PUT' : 'POST', body });
    closeModal('usCashModal');
    usRefreshAll();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

// ===================== KIYMETLI MADEN DASHBOARD =====================
const METAL_LABELS = { gold: 'Altın', silver: 'Gümüş' };

async function metalRefreshAll() {
  await Promise.all([metalLoadSummary(), metalLoadPrices(), metalLoadPurchases()]);
}

async function metalLoadSummary() {
  const s = await api('/api/metal/summary');
  $('mCardCost').textContent = tl(s.totalCost);
  $('mCardValue').textContent = s.totalValue != null ? tl(s.totalValue) : '—';
  if (s.totalProfit != null) {
    const cls = s.totalProfit >= 0 ? 'pos' : 'neg';
    $('mCardProfit').textContent = tl(s.totalProfit);
    $('mCardProfit').className = 'card-value ' + cls;
    const pct = s.totalCost > 0 ? ((s.totalProfit / s.totalCost) * 100).toFixed(2) : '0';
    $('mCardProfitPct').textContent = `%${pct}`;
    $('mCardProfitPct').className = 'card-sub ' + cls;
  } else {
    $('mCardProfit').textContent = '—';
    $('mCardProfit').className = 'card-value';
    $('mCardProfitPct').textContent = 'Fiyat girilmemiş';
    $('mCardProfitPct').className = 'card-sub';
  }

  const tb = $('metalHoldingsTable').querySelector('tbody');
  if (!s.holdings.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="7">Henüz kıymetli maden yok</td></tr>';
    return;
  }
  tb.innerHTML = s.holdings
    .map((h) => {
      const pl = h.profit != null
        ? `<span class="${h.profit >= 0 ? 'pos' : 'neg'}">${tl(h.profit)}${h.profitPct != null ? ` (%${h.profitPct.toFixed(1)})` : ''}</span>`
        : '<span class="muted">—</span>';
      return `<tr>
        <td><strong>${esc(h.label)}</strong></td>
        <td class="num">${num(h.quantity)}</td>
        <td class="num">${tl(h.avgCost)}</td>
        <td class="num">${h.currentPrice != null ? tl(h.currentPrice) : '<span class="muted">—</span>'}</td>
        <td class="num">${tl(h.costBasis)}</td>
        <td class="num">${h.currentValue != null ? tl(h.currentValue) : '<span class="muted">—</span>'}</td>
        <td class="num">${pl}</td>
      </tr>`;
    })
    .join('');
}

async function metalLoadPrices() {
  const rows = await api('/api/metal/prices');
  const tb = $('metalPricesTable').querySelector('tbody');
  tb.innerHTML = rows.length
    ? rows
        .map(
          (r) => `<tr>
        <td><strong>${esc(METAL_LABELS[r.metal] || r.metal)}</strong></td>
        <td class="num">${tl(r.price)}</td>
        <td class="muted">${new Date(r.updated_at).toLocaleString('tr-TR')}</td>
      </tr>`
        )
        .join('')
    : '<tr class="empty-row"><td colspan="3">Fiyat verisi yok</td></tr>';
}

let metalPurchaseCache = [];
let metalPurchasePage = 1;
async function metalLoadPurchases() {
  metalPurchaseCache = await api('/api/metal/purchases');
  metalRenderPurchases();
}
function metalRenderPurchases() {
  const rows = metalPurchaseCache;
  const tb = $('metalPurchasesTable').querySelector('tbody');
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="6">Kayıt yok</td></tr>';
    renderPager('metalPurchasesPager', 1, 0, () => {});
    return;
  }
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (metalPurchasePage > pages) metalPurchasePage = pages;
  const pageRows = rows.slice((metalPurchasePage - 1) * PAGE_SIZE, metalPurchasePage * PAGE_SIZE);
  tb.innerHTML = pageRows
    .map(
      (r) => `<tr>
        <td>${r.trade_date.slice(0, 10)}</td>
        <td><strong>${esc(METAL_LABELS[r.metal] || r.metal)}</strong></td>
        <td class="num">${num(r.quantity)}</td>
        <td class="num">${tl(r.price)}</td>
        <td class="num">${tl(r.total)}</td>
        <td><div class="row-actions">
          <button class="edit-btn" data-edit-mp="${r.id}" title="Düzenle">✏️</button>
          <button class="del-btn" data-del-mp="${r.id}" title="Sil">🗑</button>
        </div></td>
      </tr>`
    )
    .join('');
  tb.querySelectorAll('[data-edit-mp]').forEach((b) =>
    b.addEventListener('click', () => metalOpenPurchaseModal(metalPurchaseCache.find((x) => x.id == b.dataset.editMp)))
  );
  tb.querySelectorAll('[data-del-mp]').forEach((b) =>
    b.addEventListener('click', () => metalDelPurchase(b.dataset.delMp))
  );
  renderPager('metalPurchasesPager', metalPurchasePage, rows.length, (p) => { metalPurchasePage = p; metalRenderPurchases(); });
}

async function metalDelPurchase(id) {
  if (!confirm('Bu kayıt silinsin mi?')) return;
  await api(`/api/metal/purchases/${id}`, { method: 'DELETE' });
  metalRefreshAll();
}

// ---- Kıymetli maden alım modalı ----
let metalBeforeTimer = null;

// Secilen madene gore son girilen gram fiyatini hatirla
function metalApplyRememberedPrice() {
  const metal = $('mPMetal').value;
  const saved = localStorage.getItem('metalLastPrice_' + metal);
  $('mPPrice').value = saved || '';
}

function metalOpenPurchaseModal(row) {
  $('metalPurchaseForm').reset();
  $('mPError').classList.add('hidden');
  if (row) {
    $('metalPurchaseTitle').textContent = 'Kıymetli Maden Alım Düzenle';
    $('mPId').value = row.id;
    $('mPDate').value = row.trade_date.slice(0, 10);
    $('mPMetal').value = row.metal;
    $('mPQty').value = row.quantity;
    $('mPPrice').value = row.price;
  } else {
    $('metalPurchaseTitle').textContent = 'Kıymetli Maden Alım Ekle';
    $('mPId').value = '';
    $('mPDate').value = todayStr();
    $('mPMetal').value = localStorage.getItem('metalLastMetal') || 'gold';
    metalApplyRememberedPrice();
  }
  metalUpdateCalc();
  metalUpdateBeforeInfo();
  openModal('metalPurchaseModal');
  focusDate('mPDate');
}
$('metalOpenPurchase').addEventListener('click', () => metalOpenPurchaseModal(null));

function metalUpdateCalc() {
  const qty = Number($('mPQty').value) || 0;
  const price = Number($('mPPrice').value) || 0;
  $('mPTotal').textContent = tl(qty * price);
}

function metalResetBeforeInfo() {
  const box = $('mPBeforeInfo');
  box.classList.remove('has-data');
  box.innerHTML = 'Maden ve tarih girin; bu tarihten önceki durum burada gösterilir.';
}
async function metalUpdateBeforeInfo() {
  const metal = $('mPMetal').value;
  const date = $('mPDate').value;
  const box = $('mPBeforeInfo');
  if (!metal || !date) return metalResetBeforeInfo();
  try {
    const h = await api(`/api/metal/holdings-before?metal=${encodeURIComponent(metal)}&date=${date}`);
    if (h.quantity > 0) {
      box.classList.add('has-data');
      box.innerHTML = `<strong>${esc(h.label)}</strong> — ${date} öncesi: <strong>${num(h.quantity)}</strong> gram, ort. maliyet <strong>${tl(h.avgCost)}</strong>/gr`;
    } else {
      box.classList.remove('has-data');
      box.innerHTML = `<strong>${esc(h.label)}</strong> — bu tarihten önce pozisyon yok (ilk alım).`;
    }
  } catch {
    metalResetBeforeInfo();
  }
}

['mPQty', 'mPPrice'].forEach((id) => $(id).addEventListener('input', metalUpdateCalc));
$('mPMetal').addEventListener('change', () => {
  // duzenleme degil yeni kayitsa, secilen madene gore hatirlanan fiyati uygula
  if (!$('mPId').value) metalApplyRememberedPrice();
  metalUpdateCalc();
  metalUpdateBeforeInfo();
});
$('mPDate').addEventListener('input', () => {
  clearTimeout(metalBeforeTimer);
  metalBeforeTimer = setTimeout(metalUpdateBeforeInfo, 350);
});

$('metalPurchaseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('mPError');
  err.classList.add('hidden');
  const id = $('mPId').value;
  const metal = $('mPMetal').value;
  const body = JSON.stringify({
    trade_date: $('mPDate').value,
    metal,
    quantity: $('mPQty').value,
    price: $('mPPrice').value,
  });
  try {
    await api(id ? `/api/metal/purchases/${id}` : '/api/metal/purchases', { method: id ? 'PUT' : 'POST', body });
    // son kullanilan maden ve o madenin gram fiyatini hatirla
    localStorage.setItem('metalLastMetal', metal);
    if ($('mPPrice').value) localStorage.setItem('metalLastPrice_' + metal, $('mPPrice').value);
    closeModal('metalPurchaseModal');
    metalRefreshAll();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

// ===================== DOVIZ DASHBOARD =====================
const CURRENCY_LABELS = { usd: 'Dolar', eur: 'Euro' };

async function currencyRefreshAll() {
  await Promise.all([currencyLoadSummary(), currencyLoadPrices(), currencyLoadPurchases()]);
}

async function currencyLoadSummary() {
  const s = await api('/api/currency/summary');
  $('cCardCost').textContent = tl(s.totalCost);
  $('cCardValue').textContent = s.totalValue != null ? tl(s.totalValue) : '—';
  if (s.totalProfit != null) {
    const cls = s.totalProfit >= 0 ? 'pos' : 'neg';
    $('cCardProfit').textContent = tl(s.totalProfit);
    $('cCardProfit').className = 'card-value ' + cls;
    const pct = s.totalCost > 0 ? ((s.totalProfit / s.totalCost) * 100).toFixed(2) : '0';
    $('cCardProfitPct').textContent = `%${pct}`;
    $('cCardProfitPct').className = 'card-sub ' + cls;
  } else {
    $('cCardProfit').textContent = '—';
    $('cCardProfit').className = 'card-value';
    $('cCardProfitPct').textContent = 'Kur girilmemiş';
    $('cCardProfitPct').className = 'card-sub';
  }

  const tb = $('currencyHoldingsTable').querySelector('tbody');
  if (!s.holdings.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="7">Henüz döviz yok</td></tr>';
    return;
  }
  tb.innerHTML = s.holdings
    .map((h) => {
      const pl = h.profit != null
        ? `<span class="${h.profit >= 0 ? 'pos' : 'neg'}">${tl(h.profit)}${h.profitPct != null ? ` (%${h.profitPct.toFixed(1)})` : ''}</span>`
        : '<span class="muted">—</span>';
      return `<tr>
        <td><strong>${esc(h.label)}</strong></td>
        <td class="num">${num(h.quantity)}</td>
        <td class="num">${tl(h.avgCost)}</td>
        <td class="num">${h.currentPrice != null ? tl(h.currentPrice) : '<span class="muted">—</span>'}</td>
        <td class="num">${tl(h.costBasis)}</td>
        <td class="num">${h.currentValue != null ? tl(h.currentValue) : '<span class="muted">—</span>'}</td>
        <td class="num">${pl}</td>
      </tr>`;
    })
    .join('');
}

async function currencyLoadPrices() {
  const rows = await api('/api/currency/prices');
  const tb = $('currencyPricesTable').querySelector('tbody');
  tb.innerHTML = rows.length
    ? rows
        .map(
          (r) => `<tr>
        <td><strong>${esc(CURRENCY_LABELS[r.currency] || r.currency)}</strong></td>
        <td class="num">${r.price > 0 ? tl(r.price) : '<span class="muted">—</span>'}</td>
        <td class="muted">${r.updated_at ? new Date(r.updated_at).toLocaleString('tr-TR') : '—'}</td>
      </tr>`
        )
        .join('')
    : '<tr class="empty-row"><td colspan="3">Kur verisi yok</td></tr>';
}

let currencyPurchaseCache = [];
let currencyPurchasePage = 1;
async function currencyLoadPurchases() {
  currencyPurchaseCache = await api('/api/currency/purchases');
  currencyRenderPurchases();
}
function currencyRenderPurchases() {
  const rows = currencyPurchaseCache;
  const tb = $('currencyPurchasesTable').querySelector('tbody');
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="6">Kayıt yok</td></tr>';
    renderPager('currencyPurchasesPager', 1, 0, () => {});
    return;
  }
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (currencyPurchasePage > pages) currencyPurchasePage = pages;
  const pageRows = rows.slice((currencyPurchasePage - 1) * PAGE_SIZE, currencyPurchasePage * PAGE_SIZE);
  tb.innerHTML = pageRows
    .map(
      (r) => `<tr>
        <td>${r.trade_date.slice(0, 10)}</td>
        <td><strong>${esc(CURRENCY_LABELS[r.currency] || r.currency)}</strong></td>
        <td class="num">${num(r.quantity)}</td>
        <td class="num">${tl(r.price)}</td>
        <td class="num">${tl(r.total)}</td>
        <td><div class="row-actions">
          <button class="edit-btn" data-edit-cp="${r.id}" title="Düzenle">✏️</button>
          <button class="del-btn" data-del-cp="${r.id}" title="Sil">🗑</button>
        </div></td>
      </tr>`
    )
    .join('');
  tb.querySelectorAll('[data-edit-cp]').forEach((b) =>
    b.addEventListener('click', () => currencyOpenPurchaseModal(currencyPurchaseCache.find((x) => x.id == b.dataset.editCp)))
  );
  tb.querySelectorAll('[data-del-cp]').forEach((b) =>
    b.addEventListener('click', () => currencyDelPurchase(b.dataset.delCp))
  );
  renderPager('currencyPurchasesPager', currencyPurchasePage, rows.length, (p) => { currencyPurchasePage = p; currencyRenderPurchases(); });
}

async function currencyDelPurchase(id) {
  if (!confirm('Bu kayıt silinsin mi?')) return;
  await api(`/api/currency/purchases/${id}`, { method: 'DELETE' });
  currencyRefreshAll();
}

// ---- Döviz alım modalı ----
let currencyBeforeTimer = null;

// Secilen dovize gore son girilen kuru hatirla
function currencyApplyRememberedPrice() {
  const cur = $('cPCurrency').value;
  const saved = localStorage.getItem('currencyLastPrice_' + cur);
  $('cPPrice').value = saved || '';
}

function currencyOpenPurchaseModal(row) {
  $('currencyPurchaseForm').reset();
  $('cPError').classList.add('hidden');
  if (row) {
    $('currencyPurchaseTitle').textContent = 'Döviz Alım Düzenle';
    $('cPId').value = row.id;
    $('cPDate').value = row.trade_date.slice(0, 10);
    $('cPCurrency').value = row.currency;
    $('cPQty').value = row.quantity;
    $('cPPrice').value = row.price;
  } else {
    $('currencyPurchaseTitle').textContent = 'Döviz Alım Ekle';
    $('cPId').value = '';
    $('cPDate').value = todayStr();
    $('cPCurrency').value = localStorage.getItem('currencyLastCurrency') || 'usd';
    currencyApplyRememberedPrice();
  }
  currencyUpdateCalc();
  currencyUpdateBeforeInfo();
  openModal('currencyPurchaseModal');
  focusDate('cPDate');
}
$('currencyOpenPurchase').addEventListener('click', () => currencyOpenPurchaseModal(null));

function currencyUpdateCalc() {
  const qty = Number($('cPQty').value) || 0;
  const price = Number($('cPPrice').value) || 0;
  $('cPTotal').textContent = tl(qty * price);
}

function currencyResetBeforeInfo() {
  const box = $('cPBeforeInfo');
  box.classList.remove('has-data');
  box.innerHTML = 'Döviz ve tarih girin; bu tarihten önceki durum burada gösterilir.';
}
async function currencyUpdateBeforeInfo() {
  const cur = $('cPCurrency').value;
  const date = $('cPDate').value;
  const box = $('cPBeforeInfo');
  if (!cur || !date) return currencyResetBeforeInfo();
  try {
    const h = await api(`/api/currency/holdings-before?currency=${encodeURIComponent(cur)}&date=${date}`);
    if (h.quantity > 0) {
      box.classList.add('has-data');
      box.innerHTML = `<strong>${esc(h.label)}</strong> — ${date} öncesi: <strong>${num(h.quantity)}</strong> adet, ort. maliyet <strong>${tl(h.avgCost)}</strong>`;
    } else {
      box.classList.remove('has-data');
      box.innerHTML = `<strong>${esc(h.label)}</strong> — bu tarihten önce pozisyon yok (ilk alım).`;
    }
  } catch {
    currencyResetBeforeInfo();
  }
}

['cPQty', 'cPPrice'].forEach((id) => $(id).addEventListener('input', currencyUpdateCalc));
$('cPCurrency').addEventListener('change', () => {
  if (!$('cPId').value) currencyApplyRememberedPrice();
  currencyUpdateCalc();
  currencyUpdateBeforeInfo();
});
$('cPDate').addEventListener('input', () => {
  clearTimeout(currencyBeforeTimer);
  currencyBeforeTimer = setTimeout(currencyUpdateBeforeInfo, 350);
});

$('currencyPurchaseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('cPError');
  err.classList.add('hidden');
  const id = $('cPId').value;
  const cur = $('cPCurrency').value;
  const body = JSON.stringify({
    trade_date: $('cPDate').value,
    currency: cur,
    quantity: $('cPQty').value,
    price: $('cPPrice').value,
  });
  try {
    await api(id ? `/api/currency/purchases/${id}` : '/api/currency/purchases', { method: id ? 'PUT' : 'POST', body });
    localStorage.setItem('currencyLastCurrency', cur);
    if ($('cPPrice').value) localStorage.setItem('currencyLastPrice_' + cur, $('cPPrice').value);
    closeModal('currencyPurchaseModal');
    currencyRefreshAll();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

// ===================== KRIPTO DASHBOARD =====================
async function cryptoRefreshAll() {
  await Promise.all([cryptoLoadSummary(), cryptoLoadPrices(), cryptoLoadPurchases()]);
}

async function cryptoLoadSummary() {
  const s = await api('/api/crypto/summary');
  $('cyCardRate').textContent = s.rate != null ? tl(s.rate) : '—';
  $('cyCardCostUsd').textContent = usd(s.totalCostUSD);
  $('cyCardValueUsd').textContent = s.totalValueUSD != null ? usd(s.totalValueUSD) : '—';
  $('cyCardValueTry').textContent = s.totalValueTRY != null ? tl(s.totalValueTRY) : '—';
  if (s.totalProfitUSD != null) {
    const cls = s.totalProfitUSD >= 0 ? 'pos' : 'neg';
    $('cyCardProfit').textContent = usd(s.totalProfitUSD);
    $('cyCardProfit').className = 'card-value ' + cls;
    const pct = s.totalCostUSD > 0 ? ((s.totalProfitUSD / s.totalCostUSD) * 100).toFixed(2) : '0';
    $('cyCardProfitPct').textContent = `%${pct}`;
    $('cyCardProfitPct').className = 'card-sub ' + cls;
    $('cyCardProfitTry').textContent = s.totalProfitTRY != null ? tl(s.totalProfitTRY) : '—';
    $('cyCardProfitTry').className = 'card-value ' + cls;
  } else {
    $('cyCardProfit').textContent = '—';
    $('cyCardProfit').className = 'card-value';
    $('cyCardProfitPct').textContent = 'Fiyat yok';
    $('cyCardProfitPct').className = 'card-sub';
    $('cyCardProfitTry').textContent = '—';
    $('cyCardProfitTry').className = 'card-value';
  }

  const tb = $('cryptoHoldingsTable').querySelector('tbody');
  if (!s.holdings.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="9">Henüz kripto yok</td></tr>';
    return;
  }
  tb.innerHTML = s.holdings
    .map((h) => {
      const plUsd = h.profitUSD != null
        ? `<span class="${h.profitUSD >= 0 ? 'pos' : 'neg'}">${usd(h.profitUSD)}${h.profitPctUSD != null ? ` (%${h.profitPctUSD.toFixed(1)})` : ''}</span>`
        : '<span class="muted">—</span>';
      const plTry = h.profitTRY != null
        ? `<span class="${h.profitTRY >= 0 ? 'pos' : 'neg'}">${tl(h.profitTRY)}</span>`
        : '<span class="muted">—</span>';
      return `<tr>
        <td><strong>${esc(h.symbol)}</strong></td>
        <td class="num">${num(h.quantity)}</td>
        <td class="num">${usd8(h.avgCostUSD)}</td>
        <td class="num">${h.currentPrice != null ? usd8(h.currentPrice) : '<span class="muted">—</span>'}</td>
        <td class="num">${h.currentPriceTRY != null ? tl8(h.currentPriceTRY) : '<span class="muted">—</span>'}</td>
        <td class="num">${h.currentValueUSD != null ? usd(h.currentValueUSD) : '<span class="muted">—</span>'}</td>
        <td class="num">${h.currentValueTRY != null ? tl(h.currentValueTRY) : '<span class="muted">—</span>'}</td>
        <td class="num">${plUsd}</td>
        <td class="num">${plTry}</td>
      </tr>`;
    })
    .join('');
}

async function cryptoLoadPrices() {
  const rows = await api('/api/crypto/prices');
  const tb = $('cryptoPricesTable').querySelector('tbody');
  tb.innerHTML = rows.length
    ? rows
        .map(
          (r) => `<tr>
        <td><strong>${esc(r.symbol)}</strong></td>
        <td class="num">${r.priceUSD > 0 ? usd8(r.priceUSD) : '<span class="muted">—</span>'}</td>
        <td class="num">${r.priceTRY != null && r.priceUSD > 0 ? tl8(r.priceTRY) : '<span class="muted">—</span>'}</td>
        <td class="muted">${r.updated_at ? new Date(r.updated_at).toLocaleString('tr-TR') : '—'}</td>
      </tr>`
        )
        .join('')
    : '<tr class="empty-row"><td colspan="4">Fiyat verisi yok</td></tr>';
}

let cryptoPurchaseCache = [];
let cryptoPurchasePage = 1;
async function cryptoLoadPurchases() {
  cryptoPurchaseCache = await api('/api/crypto/purchases');
  cryptoRenderPurchases();
}
function cryptoRenderPurchases() {
  const rows = cryptoPurchaseCache;
  const tb = $('cryptoPurchasesTable').querySelector('tbody');
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="6">Kayıt yok</td></tr>';
    renderPager('cryptoPurchasesPager', 1, 0, () => {});
    return;
  }
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (cryptoPurchasePage > pages) cryptoPurchasePage = pages;
  const pageRows = rows.slice((cryptoPurchasePage - 1) * PAGE_SIZE, cryptoPurchasePage * PAGE_SIZE);
  tb.innerHTML = pageRows
    .map(
      (r) => `<tr>
        <td>${r.trade_date.slice(0, 10)}</td>
        <td><strong>${esc(r.symbol)}</strong></td>
        <td class="num">${num(r.quantity)}</td>
        <td class="num">${usd8(r.price)}</td>
        <td class="num">${usd(r.total)}</td>
        <td><div class="row-actions">
          <button class="edit-btn" data-edit-cy="${r.id}" title="Düzenle">✏️</button>
          <button class="del-btn" data-del-cy="${r.id}" title="Sil">🗑</button>
        </div></td>
      </tr>`
    )
    .join('');
  tb.querySelectorAll('[data-edit-cy]').forEach((b) =>
    b.addEventListener('click', () => cryptoOpenPurchaseModal(cryptoPurchaseCache.find((x) => x.id == b.dataset.editCy)))
  );
  tb.querySelectorAll('[data-del-cy]').forEach((b) =>
    b.addEventListener('click', () => cryptoDelPurchase(b.dataset.delCy))
  );
  renderPager('cryptoPurchasesPager', cryptoPurchasePage, rows.length, (p) => { cryptoPurchasePage = p; cryptoRenderPurchases(); });
}

async function cryptoDelPurchase(id) {
  if (!confirm('Bu kayıt silinsin mi?')) return;
  await api(`/api/crypto/purchases/${id}`, { method: 'DELETE' });
  cryptoRefreshAll();
}

// ---- Kripto alım modalı ----
let cryptoBeforeTimer = null;

function cryptoOpenPurchaseModal(row) {
  $('cryptoPurchaseForm').reset();
  $('cyPError').classList.add('hidden');
  if (row) {
    $('cryptoPurchaseTitle').textContent = 'Kripto Alım Düzenle';
    $('cyPId').value = row.id;
    $('cyPDate').value = row.trade_date.slice(0, 10);
    $('cyPSymbol').value = row.symbol;
    $('cyPQty').value = row.quantity;
    $('cyPPrice').value = row.price;
  } else {
    $('cryptoPurchaseTitle').textContent = 'Kripto Alım Ekle';
    $('cyPId').value = '';
    $('cyPDate').value = todayStr();
    $('cyPSymbol').value = localStorage.getItem('cryptoLastSymbol') || '';
  }
  cryptoUpdateCalc();
  cryptoUpdateBeforeInfo();
  openModal('cryptoPurchaseModal');
  focusDate('cyPDate');
}
$('cryptoOpenPurchase').addEventListener('click', () => cryptoOpenPurchaseModal(null));

function cryptoUpdateCalc() {
  const qty = Number($('cyPQty').value) || 0;
  const price = Number($('cyPPrice').value) || 0;
  $('cyPTotal').textContent = usd(qty * price);
}

function cryptoResetBeforeInfo() {
  const box = $('cyPBeforeInfo');
  box.classList.remove('has-data');
  box.innerHTML = 'Coin ve tarih girin; bu tarihten önceki durum burada gösterilir. Kaydederken coin\'in Binance\'de olup olmadığı kontrol edilir.';
}
async function cryptoUpdateBeforeInfo() {
  const symbol = $('cyPSymbol').value.trim();
  const date = $('cyPDate').value;
  const box = $('cyPBeforeInfo');
  if (!symbol || !date) return cryptoResetBeforeInfo();
  try {
    const h = await api(`/api/crypto/holdings-before?symbol=${encodeURIComponent(symbol)}&date=${date}`);
    if (h.quantity > 0) {
      box.classList.add('has-data');
      box.innerHTML = `<strong>${esc(h.symbol)}</strong> — ${date} öncesi: <strong>${num(h.quantity)}</strong> adet, ort. maliyet <strong>${usd8(h.avgCostUSD)}</strong>`;
    } else {
      box.classList.remove('has-data');
      box.innerHTML = `<strong>${esc(h.symbol)}</strong> — bu tarihten önce pozisyon yok (ilk alım).`;
    }
  } catch {
    cryptoResetBeforeInfo();
  }
}

['cyPQty', 'cyPPrice'].forEach((id) => $(id).addEventListener('input', cryptoUpdateCalc));
$('cyPSymbol').addEventListener('input', () => {
  clearTimeout(cryptoBeforeTimer);
  cryptoBeforeTimer = setTimeout(cryptoUpdateBeforeInfo, 350);
});
$('cyPDate').addEventListener('input', () => {
  clearTimeout(cryptoBeforeTimer);
  cryptoBeforeTimer = setTimeout(cryptoUpdateBeforeInfo, 350);
});

$('cryptoPurchaseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('cyPError');
  err.classList.add('hidden');
  const id = $('cyPId').value;
  const body = JSON.stringify({
    trade_date: $('cyPDate').value,
    symbol: $('cyPSymbol').value,
    quantity: $('cyPQty').value,
    price: $('cyPPrice').value,
  });
  const submitBtn = $('cryptoPurchaseForm').querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  const oldLabel = submitBtn.textContent;
  submitBtn.textContent = 'Kontrol ediliyor…';
  try {
    await api(id ? `/api/crypto/purchases/${id}` : '/api/crypto/purchases', { method: id ? 'PUT' : 'POST', body });
    const sym = $('cyPSymbol').value.trim().toUpperCase().replace(/USDT$/, '');
    if (sym) localStorage.setItem('cryptoLastSymbol', sym);
    closeModal('cryptoPurchaseModal');
    cryptoRefreshAll();
  } catch (e2) {
    // Binance'de yoksa veya baska hata: form acik kalir, mesaj gosterilir
    err.textContent = e2.message;
    err.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = oldLabel;
  }
});

// ===================== BINANCE DASHBOARD =====================
let bnApiKeyMasked = '';
let bnApiSecretMasked = '';

async function binanceLoadKeys() {
  const k = await api('/api/binance/keys');
  bnApiKeyMasked = k.apiKeyMasked || '';
  bnApiSecretMasked = k.apiSecretMasked || '';
  $('bnApiKey').value = bnApiKeyMasked;
  $('bnApiSecret').value = bnApiSecretMasked;
  $('bnKeyStatus').textContent = k.hasKeys
    ? `Kayıtlı anahtar var${k.updatedAt ? ' · ' + new Date(k.updatedAt).toLocaleString('tr-TR') : ''}`
    : 'Anahtar girilmemiş';
  return k.hasKeys;
}

function binanceClearTotals() {
  $('bnTotalUsdt').textContent = '—';
  $('bnTotalTry').textContent = '—';
  $('bnTotalBtc').textContent = '—';
}

async function binanceLoadPortfolio() {
  const tb = $('binanceTable').querySelector('tbody');
  tb.innerHTML = '<tr class="empty-row"><td colspan="4">Yükleniyor…</td></tr>';
  try {
    const p = await api('/api/binance/portfolio');
    if (!p.hasKeys) {
      binanceClearTotals();
      tb.innerHTML = '<tr class="empty-row"><td colspan="4">API anahtarı girin</td></tr>';
      return;
    }
    $('bnTotalUsdt').textContent = p.totalUSDT != null ? usdt(p.totalUSDT) : '—';
    $('bnTotalTry').textContent = p.totalTRY != null ? tl(p.totalTRY) : '—';
    $('bnTotalBtc').textContent = `${num8(p.totalBTC)} BTC`;
    tb.innerHTML = p.assets.length
      ? p.assets
          .map(
            (a) => `<tr>
        <td><strong>${esc(a.asset)}</strong></td>
        <td class="num">${num8(a.amount)}</td>
        <td class="num">${a.usdt != null ? usdt(a.usdt) : '—'}</td>
        <td class="num">${a.try != null ? tl(a.try) : '—'}</td>
      </tr>`
          )
          .join('')
      : '<tr class="empty-row"><td colspan="4">Varlık yok</td></tr>';
  } catch (e) {
    binanceClearTotals();
    tb.innerHTML = `<tr class="empty-row"><td colspan="4">${esc(e.message)}</td></tr>`;
  }
}

async function binanceLoad() {
  const has = await binanceLoadKeys();
  if (has) binanceLoadPortfolio();
  else {
    binanceClearTotals();
    $('binanceTable').querySelector('tbody').innerHTML = '<tr class="empty-row"><td colspan="4">API anahtarı girin</td></tr>';
  }
}

$('binanceKeyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('bnKeyError');
  err.classList.add('hidden');
  const keyVal = $('bnApiKey').value.trim();
  const secVal = $('bnApiSecret').value.trim();
  // Maskeli (degismemis) deger geldiyse bos gonder => sunucu mevcut degeri korur
  const body = JSON.stringify({
    apiKey: keyVal === bnApiKeyMasked ? '' : keyVal,
    apiSecret: secVal === bnApiSecretMasked ? '' : secVal,
  });
  $('bnKeyStatus').textContent = 'Doğrulanıyor…';
  try {
    await api('/api/binance/keys', { method: 'PUT', body });
    await binanceLoadKeys();
    binanceLoadPortfolio();
    maybeRefreshGenel();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
    $('bnKeyStatus').textContent = '';
  }
});
$('bnRefresh').addEventListener('click', binanceLoadPortfolio);

// ===================== TEFAS FON (alim) =====================
// Fon birim fiyatlari 6 ondalik gosterilir
const fprice = (n) => '₺' + new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 6, maximumFractionDigits: 6 }).format(Number(n) || 0);

async function fundsRefreshAll() {
  await Promise.all([fundsLoadSummary(), fundsLoadPrices(), fundsLoadPurchases()]);
}

async function fundsLoadSummary() {
  const s = await api('/api/funds/summary');
  $('fnCardCost').textContent = tl(s.totalCost);
  $('fnCardValue').textContent = s.totalValue != null ? tl(s.totalValue) : '—';
  if (s.totalProfit != null) {
    const cls = s.totalProfit >= 0 ? 'pos' : 'neg';
    $('fnCardProfit').textContent = tl(s.totalProfit);
    $('fnCardProfit').className = 'card-value ' + cls;
    const pct = s.totalCost > 0 ? ((s.totalProfit / s.totalCost) * 100).toFixed(2) : '0';
    $('fnCardProfitPct').textContent = `%${pct}`;
    $('fnCardProfitPct').className = 'card-sub ' + cls;
  } else {
    $('fnCardProfit').textContent = '—';
    $('fnCardProfit').className = 'card-value';
    $('fnCardProfitPct').textContent = 'Fiyat girilmemiş';
    $('fnCardProfitPct').className = 'card-sub';
  }

  const tb = $('fundsHoldingsTable').querySelector('tbody');
  if (!s.holdings.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="8">Henüz fon yok</td></tr>';
    return;
  }
  tb.innerHTML = s.holdings
    .map((h) => {
      const pl = h.profit != null
        ? `<span class="${h.profit >= 0 ? 'pos' : 'neg'}">${tl(h.profit)}${h.profitPct != null ? ` (%${h.profitPct.toFixed(1)})` : ''}</span>`
        : '<span class="muted">—</span>';
      return `<tr>
        <td><strong>${esc(h.code)}</strong></td>
        <td class="muted">${esc(h.title || '')}</td>
        <td class="num">${num(h.quantity)}</td>
        <td class="num">${fprice(h.avgCost)}</td>
        <td class="num">${h.currentPrice != null ? fprice(h.currentPrice) : '<span class="muted">—</span>'}</td>
        <td class="num">${tl(h.costBasis)}</td>
        <td class="num">${h.currentValue != null ? tl(h.currentValue) : '<span class="muted">—</span>'}</td>
        <td class="num">${pl}</td>
      </tr>`;
    })
    .join('');
}

async function fundsLoadPrices() {
  const rows = await api('/api/funds/prices');
  const tb = $('fundsPricesTable').querySelector('tbody');
  tb.innerHTML = rows.length
    ? rows
        .map(
          (r) => `<tr>
        <td><strong>${esc(r.code)}</strong></td>
        <td class="muted">${esc(r.title || '')}</td>
        <td class="num">${r.price > 0 ? fprice(r.price) : '<span class="muted">—</span>'}</td>
        <td class="muted">${r.updated_at ? new Date(r.updated_at).toLocaleString('tr-TR') : '—'}</td>
      </tr>`
        )
        .join('')
    : '<tr class="empty-row"><td colspan="4">Fiyat verisi yok</td></tr>';
}

let fundsPurchaseCache = [];
let fundsPurchasePage = 1;
async function fundsLoadPurchases() {
  fundsPurchaseCache = await api('/api/funds/purchases');
  fundsRenderPurchases();
}
function fundsRenderPurchases() {
  const rows = fundsPurchaseCache;
  const tb = $('fundsPurchasesTable').querySelector('tbody');
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="6">Kayıt yok</td></tr>';
    renderPager('fundsPurchasesPager', 1, 0, () => {});
    return;
  }
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (fundsPurchasePage > pages) fundsPurchasePage = pages;
  const pageRows = rows.slice((fundsPurchasePage - 1) * PAGE_SIZE, fundsPurchasePage * PAGE_SIZE);
  tb.innerHTML = pageRows
    .map(
      (r) => `<tr>
        <td>${r.trade_date.slice(0, 10)}</td>
        <td><strong>${esc(r.code)}</strong></td>
        <td class="num">${num(r.quantity)}</td>
        <td class="num">${fprice(r.price)}</td>
        <td class="num">${tl(r.total)}</td>
        <td><div class="row-actions">
          <button class="edit-btn" data-edit-fn="${r.id}" title="Düzenle">✏️</button>
          <button class="del-btn" data-del-fn="${r.id}" title="Sil">🗑</button>
        </div></td>
      </tr>`
    )
    .join('');
  tb.querySelectorAll('[data-edit-fn]').forEach((b) =>
    b.addEventListener('click', () => fundsOpenPurchaseModal(fundsPurchaseCache.find((x) => x.id == b.dataset.editFn)))
  );
  tb.querySelectorAll('[data-del-fn]').forEach((b) =>
    b.addEventListener('click', () => fundsDelPurchase(b.dataset.delFn))
  );
  renderPager('fundsPurchasesPager', fundsPurchasePage, rows.length, (p) => { fundsPurchasePage = p; fundsRenderPurchases(); });
}

async function fundsDelPurchase(id) {
  if (!confirm('Bu kayıt silinsin mi?')) return;
  await api(`/api/funds/purchases/${id}`, { method: 'DELETE' });
  fundsRefreshAll();
}

// ---- Fon alım modalı ----
let fundsBeforeTimer = null;
function fundsOpenPurchaseModal(row) {
  $('fundsPurchaseForm').reset();
  $('fnPError').classList.add('hidden');
  if (row) {
    $('fundsPurchaseTitle').textContent = 'Fon Alım Düzenle';
    $('fnPId').value = row.id;
    $('fnPDate').value = row.trade_date.slice(0, 10);
    $('fnPCode').value = row.code;
    $('fnPTitle').value = '';
    $('fnPQty').value = row.quantity;
    $('fnPPrice').value = row.price;
  } else {
    $('fundsPurchaseTitle').textContent = 'Fon Alım Ekle';
    $('fnPId').value = '';
    $('fnPDate').value = todayStr();
    $('fnPCode').value = localStorage.getItem('fundsLastCode') || '';
  }
  fundsUpdateCalc();
  fundsUpdateBeforeInfo();
  openModal('fundsPurchaseModal');
  focusDate('fnPDate');
}
$('fundsOpenPurchase').addEventListener('click', () => fundsOpenPurchaseModal(null));

function fundsUpdateCalc() {
  const qty = Number($('fnPQty').value) || 0;
  const price = Number($('fnPPrice').value) || 0;
  $('fnPTotal').textContent = tl(qty * price);
}

function fundsResetBeforeInfo() {
  const box = $('fnPBeforeInfo');
  box.classList.remove('has-data');
  box.innerHTML = 'Fon ve tarih girin; bu tarihten önceki durum burada gösterilir. Yeni fon eklenince otomatik takibe alınır.';
}
async function fundsUpdateBeforeInfo() {
  const code = $('fnPCode').value.trim();
  const date = $('fnPDate').value;
  const box = $('fnPBeforeInfo');
  if (!code || !date) return fundsResetBeforeInfo();
  try {
    const h = await api(`/api/funds/holdings-before?code=${encodeURIComponent(code)}&date=${date}`);
    if (h.quantity > 0) {
      box.classList.add('has-data');
      box.innerHTML = `<strong>${esc(h.code)}</strong> — ${date} öncesi: <strong>${num(h.quantity)}</strong> pay, ort. maliyet <strong>${fprice(h.avgCost)}</strong>`;
    } else {
      box.classList.remove('has-data');
      box.innerHTML = `<strong>${esc(h.code)}</strong> — bu tarihten önce pozisyon yok (ilk alım).`;
    }
  } catch {
    fundsResetBeforeInfo();
  }
}

['fnPQty', 'fnPPrice'].forEach((id) => $(id).addEventListener('input', fundsUpdateCalc));
['fnPCode', 'fnPDate'].forEach((id) =>
  $(id).addEventListener('input', () => {
    clearTimeout(fundsBeforeTimer);
    fundsBeforeTimer = setTimeout(fundsUpdateBeforeInfo, 350);
  })
);

$('fundsPurchaseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('fnPError');
  err.classList.add('hidden');
  const id = $('fnPId').value;
  const code = $('fnPCode').value.trim().toUpperCase();
  const body = JSON.stringify({
    trade_date: $('fnPDate').value,
    code,
    title: $('fnPTitle').value || '',
    quantity: $('fnPQty').value,
    price: $('fnPPrice').value,
  });
  try {
    await api(id ? `/api/funds/purchases/${id}` : '/api/funds/purchases', { method: id ? 'PUT' : 'POST', body });
    if (code) localStorage.setItem('fundsLastCode', code);
    closeModal('fundsPurchaseModal');
    fundsRefreshAll();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

// ===================== TELEGRAM BILDIRIM AYARLARI =====================
async function openTelegram() {
  $('telegramForm').reset();
  $('tgError').classList.add('hidden');
  $('tgMsg').textContent = '';
  try {
    const t = await api('/api/telegram');
    $('tgChatId').value = t.chatId || '';
    $('tgWeeklyChatId').value = t.weeklyChatId || '';
    $('tgMonthlyChatId').value = t.monthlyChatId || '';
    $('tgBotWarn').classList.toggle('hidden', !!t.botConfigured);
  } catch (_) {}
  openModal('telegramModal');
}
$('openTelegram').addEventListener('click', openTelegram);

function tgShow(msg, ok) {
  const el = $('tgMsg');
  el.textContent = msg;
  el.className = 'card-sub ' + (ok ? 'pos' : 'neg');
}

$('telegramForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('tgError').classList.add('hidden');
  $('tgMsg').textContent = '';
  try {
    const chatId = $('tgChatId').value.trim();
    const weeklyChatId = $('tgWeeklyChatId').value.trim();
    const monthlyChatId = $('tgMonthlyChatId').value.trim();
    await api('/api/telegram', { method: 'PUT', body: JSON.stringify({ chatId, weeklyChatId, monthlyChatId }) });
    tgShow(chatId ? 'Kaydedildi. Her gün 21:00 özet gelecek.' : 'Bildirim kapatıldı.', true);
  } catch (e2) {
    $('tgError').textContent = e2.message;
    $('tgError').classList.remove('hidden');
  }
});

$('tgTest').addEventListener('click', async () => {
  $('tgError').classList.add('hidden');
  tgShow('Gönderiliyor…', true);
  try {
    await api('/api/telegram/test', { method: 'POST', body: JSON.stringify({ chatId: $('tgChatId').value.trim() }) });
    tgShow('Test mesajı gönderildi ✅', true);
  } catch (e2) {
    $('tgError').textContent = e2.message;
    $('tgError').classList.remove('hidden');
    $('tgMsg').textContent = '';
  }
});

$('tgSendNow').addEventListener('click', async () => {
  $('tgError').classList.add('hidden');
  tgShow('Günlük özet gönderiliyor…', true);
  try {
    await api('/api/telegram/send-now', { method: 'POST', body: JSON.stringify({ chatId: $('tgChatId').value.trim() }) });
    tgShow('Günlük özet gönderildi ✅', true);
  } catch (e2) {
    $('tgError').textContent = e2.message;
    $('tgError').classList.remove('hidden');
    $('tgMsg').textContent = '';
  }
});

$('tgSendWeekly').addEventListener('click', async () => {
  $('tgError').classList.add('hidden');
  tgShow('Haftalık özet gönderiliyor…', true);
  try {
    const weeklyTarget = $('tgWeeklyChatId').value.trim() || $('tgChatId').value.trim();
    await api('/api/telegram/send-weekly-now', { method: 'POST', body: JSON.stringify({ chatId: weeklyTarget }) });
    tgShow('Haftalık özet gönderildi ✅', true);
  } catch (e2) {
    $('tgError').textContent = e2.message;
    $('tgError').classList.remove('hidden');
    $('tgMsg').textContent = '';
  }
});

$('tgSendMonthly').addEventListener('click', async () => {
  $('tgError').classList.add('hidden');
  tgShow('Aylık özet gönderiliyor…', true);
  try {
    const monthlyTarget = $('tgMonthlyChatId').value.trim() || $('tgChatId').value.trim();
    await api('/api/telegram/send-monthly-now', { method: 'POST', body: JSON.stringify({ chatId: monthlyTarget }) });
    tgShow('Aylık özet gönderildi ✅', true);
  } catch (e2) {
    $('tgError').textContent = e2.message;
    $('tgError').classList.remove('hidden');
    $('tgMsg').textContent = '';
  }
});

// ===================== BAŞARIMLAR =====================
async function achievementsLoad() {
  let d;
  try {
    d = await api('/api/achievements');
  } catch (_) {
    return;
  }
  renderAchievements(d);
}

function renderAchievements(d) {
  const lvl = d.level;
  const span = lvl.nextMin != null ? lvl.nextMin - lvl.currentMin : 0;
  const inLvl = d.points - lvl.currentMin;
  const pct = lvl.nextMin != null && span > 0 ? Math.min(100, (inLvl / span) * 100) : 100;
  $('achvHeader').innerHTML = `
    <div class="achv-level">
      <div class="achv-level-badge">Lv.${lvl.level}</div>
      <div class="achv-level-info">
        <div class="achv-level-name">${esc(lvl.name)} <span class="achv-pts-total">${d.points} puan</span></div>
        <div class="achv-level-bar"><span style="width:${pct.toFixed(0)}%"></span></div>
        <div class="achv-level-sub">${
          lvl.nextMin != null
            ? `Sonraki seviye: <strong>${esc(lvl.nextName)}</strong> (${lvl.nextMin} puan)`
            : 'Maksimum seviye 🎉'
        } · ${d.unlockedCount}/${d.totalCount} başarım</div>
      </div>
    </div>`;

  const banner = $('achvBanner');
  const newlyItems = d.list.filter((x) => x.newly);
  if (newlyItems.length) {
    banner.innerHTML = '🎉 Yeni başarım: ' + newlyItems.map((x) => `<strong>${x.icon} ${esc(x.title)}</strong>`).join(', ');
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  const cats = {};
  d.list.forEach((a) => {
    (cats[a.cat] = cats[a.cat] || []).push(a);
  });
  $('achvBody').innerHTML = Object.entries(cats)
    .map(
      ([cat, items]) => `
      <section class="panel">
        <h3>${esc(cat)} <span class="muted" style="font-weight:400">(${items.filter((i) => i.unlocked).length}/${items.length})</span></h3>
        <div class="achv-grid">${items.map(renderAchvCard).join('')}</div>
      </section>`
    )
    .join('');
}

function renderAchvCard(a) {
  let bottom;
  if (a.unlocked) {
    bottom = `<div class="achv-date">✓ ${a.unlockedAt ? new Date(a.unlockedAt).toLocaleDateString('tr-TR') : 'Kazanıldı'}</div>`;
  } else if (a.progress) {
    const p = a.progress;
    const cur = p.usd ? usd(p.current) : tl(p.current);
    const tgt = p.usd ? usd(p.target) : tl(p.target);
    bottom = `<div class="achv-progress"><span style="width:${p.pct.toFixed(0)}%"></span></div>
      <div class="achv-prog-sub">${cur} / ${tgt} · %${p.pct.toFixed(0)}</div>`;
  } else {
    bottom = `<div class="achv-date locked">🔒 Kilitli</div>`;
  }
  const cls = a.unlocked ? `achv-card unlocked tier-${a.tier}` : 'achv-card locked';
  return `<div class="${cls}">
    <div class="achv-icon">${a.icon}</div>
    <div class="achv-main">
      <div class="achv-title">${esc(a.title)} <span class="achv-pts tier-${a.tier}">+${a.points}</span></div>
      <div class="achv-desc">${esc(a.desc)}</div>
      ${bottom}
    </div>
  </div>`;
}

// ===================== FON (birim pay) =====================
const fund4 = (n) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(Number(n) || 0);

async function fundLoad() {
  let d;
  try {
    d = await api('/api/fund');
  } catch (_) {
    return;
  }
  renderFund(d);
}

function renderFund(d) {
  if (!d.hasData) {
    $('fCardPrice').textContent = '—';
    ['fCardCost', 'fCardGain', 'fCardUnits', 'fCardContrib', 'fCardValue', 'fCardReal'].forEach((id) => ($(id).textContent = '—'));
    $('fundChart').innerHTML = '<div class="chart-empty">Henüz nakit girişi (katkı) yok. İlk parayı yatırınca fon başlar.</div>';
    $('fundMonthlyTable').querySelector('tbody').innerHTML = '<tr class="empty-row"><td colspan="5">Kayıt yok</td></tr>';
    $('fundLegend').innerHTML = '';
    return;
  }
  // ₺ birim fiyat 4 haneli; fon "1 TL"den basladigi icin fiyatlar ~1-x araliginda
  $('fCardPrice').textContent = `₺${fund4(d.currentPrice)}`;
  $('fCardPriceSub').textContent = `Başlangıç: ₺1,0000 · ${shortDate(d.startDate)}`;
  $('fCardCost').textContent = `₺${fund4(d.avgCost)}`;
  const gpos = d.gainAbs >= 0;
  $('fCardGain').textContent = tl(d.gainAbs);
  $('fCardGain').className = 'card-value ' + (gpos ? 'pos' : 'neg');
  $('fCardGainPct').textContent = `${gpos ? '▲' : '▼'} %${Math.abs(d.gainPct).toFixed(2)}`;
  $('fCardGainPct').className = 'card-sub ' + (gpos ? 'pos' : 'neg');
  $('fCardUnits').textContent = num(d.units);
  $('fCardContrib').textContent = tl(d.contributions);
  $('fCardValue').textContent = tl(d.currentValue);
  if (d.realReturnPct != null) {
    const rpos = d.realReturnPct >= 0;
    $('fCardReal').textContent = `${rpos ? '▲' : '▼'} %${Math.abs(d.realReturnPct).toFixed(2)}`;
    $('fCardReal').className = 'card-value ' + (rpos ? 'pos' : 'neg');
    $('fCardRealSub').textContent = `Enflasyon çarpanı: ${fund4(d.inflationFactor)}×`;
  } else {
    $('fCardReal').textContent = '—';
    $('fCardReal').className = 'card-value';
    $('fCardRealSub').textContent = d.hasTufe ? '' : 'TÜFE girilmemiş';
  }
  if (d.vsUsdPct != null) {
    const upos = d.vsUsdPct >= 0;
    $('fCardUsd').textContent = `${upos ? '▲' : '▼'} %${Math.abs(d.vsUsdPct).toFixed(2)}`;
    $('fCardUsd').className = 'card-value ' + (upos ? 'pos' : 'neg');
    $('fCardUsdSub').textContent = `USD çarpanı: ${fund4(d.usdFactor)}×`;
  } else {
    $('fCardUsd').textContent = '—';
    $('fCardUsd').className = 'card-value';
    $('fCardUsdSub').textContent = d.hasUsd ? '' : 'Kur geçmişi yok';
  }
  if (d.xirrPct != null) {
    const xpos = d.xirrPct >= 0;
    $('fCardXirr').textContent = `${xpos ? '▲' : '▼'} %${Math.abs(d.xirrPct).toFixed(2)}`;
    $('fCardXirr').className = 'card-value ' + (xpos ? 'pos' : 'neg');
  } else {
    $('fCardXirr').textContent = '—';
    $('fCardXirr').className = 'card-value';
  }
  $('fCardXirrSub').textContent =
    d.twrAnnualPct != null
      ? `TWR yıllık: %${d.twrAnnualPct.toFixed(2)} · ${d.daysHeld} gün`
      : '';
  renderFundChart(d.series);
  renderFundMonthly(d.series);
}

function renderFundChart(series) {
  const box = $('fundChart');
  const leg = $('fundLegend');
  if (!series || series.length < 2) {
    box.innerHTML = '<div class="chart-empty">Yeterli veri yok — fiyat geçmişi biriktikçe çizilir.</div>';
    leg.innerHTML = '';
    return;
  }
  const W = 900, H = 300, pad = { l: 64, r: 16, t: 12, b: 28 };
  const innerW = W - pad.l - pad.r, innerH = H - pad.t - pad.b;
  const hasInfl = series.some((s) => s.inflation != null);
  const hasUsd = series.some((s) => s.usd != null);
  const all = [];
  series.forEach((s) => {
    all.push(s.price, s.avgCost);
    if (s.inflation != null) all.push(s.inflation);
    if (s.usd != null) all.push(s.usd);
  });
  let min = Math.min(...all), max = Math.max(...all);
  if (min === max) { min *= 0.99; max = max * 1.01 || 1; }
  const pd = (max - min) * 0.05; min -= pd; max += pd;
  const X = (i) => pad.l + (i / (series.length - 1)) * innerW;
  const Y = (v) => pad.t + innerH - ((v - min) / (max - min)) * innerH;
  const linePath = (key) =>
    series
      .filter((s) => s[key] != null)
      .map((s, i, arr) => {
        const gi = series.indexOf(s);
        return `${i ? 'L' : 'M'}${X(gi).toFixed(1)},${Y(s[key]).toFixed(1)}`;
      })
      .join(' ');
  let grid = '';
  for (let k = 0; k <= 4; k++) {
    const v = min + ((max - min) * k) / 4;
    const y = Y(v);
    grid += `<line class="grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}"/>` +
      `<text class="ytick" x="${pad.l - 6}" y="${(y + 4).toFixed(1)}">₺${fund4(v)}</text>`;
  }
  let paths = `<path d="${linePath('price')}" fill="none" stroke="#2f81f7" stroke-width="2"/>`;
  paths += `<path d="${linePath('avgCost')}" fill="none" stroke="#8b949e" stroke-width="1.5" stroke-dasharray="5 4"/>`;
  if (hasInfl) paths += `<path d="${linePath('inflation')}" fill="none" stroke="#d29922" stroke-width="1.5"/>`;
  if (hasUsd) paths += `<path d="${linePath('usd')}" fill="none" stroke="#3fb950" stroke-width="1.5"/>`;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    ${grid}
    ${paths}
    <text class="xtick" x="${pad.l}" y="${H - 8}" style="text-anchor:start">${shortDate(series[0].date)}</text>
    <text class="xtick" x="${W - pad.r}" y="${H - 8}" style="text-anchor:end">${shortDate(series[series.length - 1].date)}</text>
  </svg>`;
  leg.innerHTML =
    '<span class="cl-item"><span class="cl-line" style="background:#2f81f7"></span>Birim Fiyat</span>' +
    '<span class="cl-item"><span class="cl-line" style="background:#8b949e"></span>Maliyet</span>' +
    (hasInfl ? '<span class="cl-item"><span class="cl-line" style="background:#d29922"></span>Enflasyon</span>' : '') +
    (hasUsd ? '<span class="cl-item"><span class="cl-line" style="background:#3fb950"></span>USD</span>' : '');
}

function renderFundMonthly(series) {
  // her ayin son noktasi
  const byMonth = {};
  series.forEach((s) => { byMonth[s.date.slice(0, 7)] = s; });
  const months = Object.keys(byMonth).sort();
  const tb = $('fundMonthlyTable').querySelector('tbody');
  if (!months.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="5">Kayıt yok</td></tr>';
    return;
  }
  let prevPrice = null;
  tb.innerHTML = months
    .map((m) => {
      const s = byMonth[m];
      const chg = prevPrice ? ((s.price - prevPrice) / prevPrice) * 100 : null;
      prevPrice = s.price;
      const chgTxt = chg == null ? '—' : `<span class="${chg >= 0 ? 'pos' : 'neg'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}</span>`;
      return `<tr>
        <td>${m}</td>
        <td class="num">₺${fund4(s.price)}</td>
        <td class="num">${chgTxt}</td>
        <td class="num">${tl(s.value)}</td>
        <td class="num">${num(s.units)}</td>
      </tr>`;
    })
    .join('');
}

// ---- TÜFE girişi ----
async function openTufe() {
  $('tufeForm').reset();
  $('tfError').classList.add('hidden');
  await tufeLoad();
  openModal('tufeModal');
}
$('openTufe').addEventListener('click', openTufe);

async function tufeLoad() {
  const rows = await api('/api/tufe'); // ym ascending
  const tb = $('tufeTable').querySelector('tbody');
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="4">Kayıt yok</td></tr>';
    return;
  }
  let cum = 1;
  // tabloyu yeniden eskiye gostermek icin once kumulatifi hesapla
  const withCum = rows.map((r) => {
    cum *= 1 + Number(r.rate) / 100;
    return { ...r, cum };
  });
  tb.innerHTML = withCum
    .slice()
    .reverse()
    .map(
      (r) => `<tr>
        <td>${r.ym}</td>
        <td class="num ${r.rate >= 0 ? 'pos' : 'neg'}">${r.rate >= 0 ? '+' : ''}${num(r.rate)}</td>
        <td class="num">${((r.cum - 1) * 100).toFixed(2)}%</td>
        <td><button class="del-btn" data-del-tf="${r.ym}" title="Sil">🗑</button></td>
      </tr>`
    )
    .join('');
  tb.querySelectorAll('[data-del-tf]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/api/tufe/${b.dataset.delTf}`, { method: 'DELETE' });
      tufeLoad();
    })
  );
}

$('tufeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('tfError');
  err.classList.add('hidden');
  try {
    await api('/api/tufe', { method: 'PUT', body: JSON.stringify({ ym: $('tfYm').value, rate: $('tfRate').value }) });
    $('tufeForm').reset();
    tufeLoad();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

// ---- Baslangic: oturum kontrolu ----
(async () => {
  try {
    const me = await api('/api/me');
    showApp(me.username, me.role, me.mustChange);
  } catch {
    showLogin();
  }
})();
