// ---- Yardimcilar ----
const $ = (id) => document.getElementById(id);
const tl = (n) =>
  new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(Number(n) || 0);
const num = (n) =>
  new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 4 }).format(Number(n) || 0);
const usd = (n) =>
  new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'USD' }).format(Number(n) || 0);

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
  if (!res.ok) throw new Error(data.error || 'Hata');
  return data;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
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
function showApp(username) {
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('userName').textContent = username || '';
  refreshAll();
  connectEvents();
}

// Canli guncelleme: fiyat degisince (web UI / Windows servisi) ozet + fiyatlari yenile
let eventSource = null;
let priceRefreshTimer = null;
let historyRefreshTimer = null;
function connectEvents() {
  if (eventSource) return; // zaten bagli
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('price_change', () => {
    // kisa bir debounce ile birden fazla degisikligi tek seferde topla
    clearTimeout(priceRefreshTimer);
    priceRefreshTimer = setTimeout(() => {
      loadSummary();
      loadPrices();
    }, 250);
  });
  // price_history degisince (servis) portfoy degeri grafigini yenile
  eventSource.addEventListener('history_change', () => {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = setTimeout(() => loadPortfolioHistory(), 300);
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
    showApp(data.username);
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
  b.addEventListener('click', (e) => e.target.closest('.modal').classList.add('hidden'))
);
document.querySelectorAll('.modal').forEach((m) =>
  m.addEventListener('click', (e) => {
    if (e.target === m) m.classList.add('hidden');
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
    priceManual = true; // duzenlemede mevcut fiyatin uzerine yazma
  } else {
    $('purchaseTitle').textContent = 'Alım Ekle';
    $('pId').value = '';
    $('pSource').value = 'normal';
    $('pDate').value = todayStr();
    $('pSymbol').value = lastUsedSymbol();
    priceManual = false; // tarih/hisseye gore otomatik doldurulabilir
  }
  updatePurchaseCalc();
  updateBeforeInfo();
  maybeAutofillPrice();
  openModal('purchaseModal');
  focusDate('pDate');
}
$('openPurchase').addEventListener('click', () => openPurchaseModal(null));

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
  const total = qty * price;
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

['pQty', 'pUsd'].forEach((id) => $(id).addEventListener('input', updatePurchaseCalc));
// Fiyat alanini kullanici elle degistirirse otomatik doldurmayi durdur
$('pPrice').addEventListener('input', () => {
  priceManual = true;
  updatePurchaseCalc();
});
['pSymbol', 'pDate'].forEach((id) =>
  $(id).addEventListener('input', () => {
    clearTimeout(beforeTimer);
    beforeTimer = setTimeout(() => {
      updateBeforeInfo();
      maybeAutofillPrice();
    }, 350);
  })
);

$('purchaseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('pError');
  err.classList.add('hidden');
  const id = $('pId').value;
  const body = JSON.stringify({
    trade_date: $('pDate').value,
    symbol: $('pSymbol').value,
    quantity: $('pQty').value,
    price: $('pPrice').value,
    source: $('pSource').value,
    usd_rate: $('pUsd').value || null,
  });
  try {
    await api(id ? `/api/purchases/${id}` : '/api/purchases', {
      method: id ? 'PUT' : 'POST',
      body,
    });
    const sym = $('pSymbol').value.trim().toUpperCase();
    if (sym) localStorage.setItem('lastSymbol', sym);
    closeModal('purchaseModal');
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
    if (series.length && series[series.length - 1].date === today) {
      series[series.length - 1] = { date: today, value: liveValue };
    } else {
      series.push({ date: today, value: liveValue });
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
  const vals = series.map((s) => s.value);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) { min = min * 0.95; max = max * 1.05 || 1; }
  // alt sinirin biraz altina pay birak
  min = Math.max(0, min - (max - min) * 0.08);
  const X = (i) => pad.l + innerW * (i / (series.length - 1));
  const Y = (v) => pad.t + innerH * (1 - (v - min) / (max - min));

  const line = series.map((s, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(s.value).toFixed(1)}`).join(' ');
  const area = `${line} L${X(series.length - 1).toFixed(1)},${(pad.t + innerH).toFixed(1)} L${X(0).toFixed(1)},${(pad.t + innerH).toFixed(1)} Z`;

  // y ekseni cizgileri + etiketleri
  let grid = '';
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = min + (max - min) * (i / yTicks);
    const y = Y(v);
    grid += `<line class="grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}"/>`;
    grid += `<text class="ytick" x="${pad.l - 8}" y="${(y + 4).toFixed(1)}">${kfmt(v)}</text>`;
  }
  // x ekseni etiketleri
  let xlab = '';
  const xCount = Math.min(6, series.length);
  for (let i = 0; i < xCount; i++) {
    const idx = Math.round((series.length - 1) * (i / (xCount - 1)));
    xlab += `<text class="xtick" x="${X(idx).toFixed(1)}" y="${H - 10}">${shortDate(series[idx].date)}</text>`;
  }

  // "su an" (canli) noktasi: kalici yesil isaret + etiket
  let liveMarker = '';
  if (liveIdx >= 0) {
    const lx = X(liveIdx), ly = Y(series[liveIdx].value);
    const anchor = liveIdx === series.length - 1 ? 'end' : 'middle';
    liveMarker =
      `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4.5" fill="#3fb950" stroke="#0d1117" stroke-width="1.5"/>` +
      `<text class="livelbl" x="${lx.toFixed(1)}" y="${(ly - 10).toFixed(1)}" text-anchor="${anchor}">şu an</text>`;
  }

  box.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}">
      <defs><linearGradient id="vgrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2f81f7" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#2f81f7" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}
      <path d="${area}" fill="url(#vgrad)"/>
      <path d="${line}" fill="none" stroke="#2f81f7" stroke-width="2"/>
      ${xlab}
      ${liveMarker}
      <line id="vcVline" class="vline" style="display:none"/>
      <circle id="vcDot" r="4" fill="#2f81f7" stroke="#0d1117" stroke-width="1.5" style="display:none"/>
      <rect x="${pad.l}" y="${pad.t}" width="${innerW}" height="${innerH}" fill="transparent" id="vcHit"/>
    </svg>
    <div id="vcTip" class="vc-tip" style="display:none"></div>`;

  const svg = box.querySelector('svg');
  const dot = $('vcDot'), vline = $('vcVline'), tip = $('vcTip');
  const onMove = (e) => {
    const rect = svg.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width; // 0..1 svg geneli
    const fStart = pad.l / W, fEnd = (W - pad.r) / W;
    let f = (fx - fStart) / (fEnd - fStart);
    f = Math.max(0, Math.min(1, f));
    const idx = Math.round(f * (series.length - 1));
    const px = X(idx), py = Y(series[idx].value);
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.style.display = '';
    vline.setAttribute('x1', px); vline.setAttribute('x2', px);
    vline.setAttribute('y1', pad.t); vline.setAttribute('y2', pad.t + innerH); vline.style.display = '';
    tip.innerHTML = `<strong>${shortDate(series[idx].date)}</strong><br>${tl(series[idx].value)}`;
    tip.style.display = '';
    tip.style.left = `${(px / W) * rect.width}px`;
    tip.style.top = `${(py / H) * rect.height}px`;
  };
  svg.addEventListener('mousemove', onMove);
  svg.addEventListener('mouseleave', () => {
    dot.style.display = 'none'; vline.style.display = 'none'; tip.style.display = 'none';
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

  // canli portfoy degerini grafigin son noktasi olarak guncelle
  liveValue = s.totalCurrentValue;
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

function renderPurchases() {
  const fSym = $('filterSymbol').value;
  const fSrc = $('filterSource').value;
  const rows = purchaseCache.filter(
    (r) => (!fSym || r.symbol === fSym) && (!fSrc || r.source === fSrc)
  );
  const tb = $('purchasesTable').querySelector('tbody');
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="8">Kayıt yok</td></tr>';
    renderPager('purchasesPager', 1, 0, () => {});
    return;
  }
  // filtrelenmis toplam (tum sayfalar)
  const totQty = rows.reduce((s, r) => s + Number(r.quantity), 0);
  const totAmt = rows.reduce((s, r) => s + Number(r.total), 0);
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
        <td><span class="tag ${r.source}">${r.source === 'temettu' ? 'Temettü' : 'Normal'}</span></td>
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
          <button class="edit-btn" data-edit-pr="${r.symbol}" data-price="${r.price}" title="Güncelle">✏️</button>
          <button class="del-btn" data-del-pr="${r.id}" title="Sil">🗑</button>
        </div></td>
      </tr>`
    )
    .join('');
  tb.querySelectorAll('[data-edit-pr]').forEach((b) =>
    b.addEventListener('click', () => openPriceModal(b.dataset.editPr, b.dataset.price))
  );
  tb.querySelectorAll('[data-del-pr]').forEach((b) =>
    b.addEventListener('click', () => del('prices', b.dataset.delPr))
  );
}

async function del(type, id) {
  if (!confirm('Bu kayıt silinsin mi?')) return;
  await api(`/api/${type}/${id}`, { method: 'DELETE' });
  refreshAll();
}

// ---- Baslangic: oturum kontrolu ----
(async () => {
  try {
    const me = await api('/api/me');
    showApp(me.username);
  } catch {
    showLogin();
  }
})();
