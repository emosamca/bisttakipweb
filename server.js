require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const db = require('./db');
const portfolio = require('./portfolio');
const usportfolio = require('./usportfolio');
const metalportfolio = require('./metalportfolio');
const currencyportfolio = require('./currencyportfolio');
const cryptoportfolio = require('./cryptoportfolio');
const binance = require('./binance');
const telegram = require('./telegram');
const achievements = require('./achievements');
const fund = require('./fund');
const fundsportfolio = require('./fundsportfolio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'degistirin-bu-anahtari',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 gun
  })
);

// ---- Yardimcilar ----
// Parola degisimi zorunluyken yalnizca bu yollara izin var
const ALLOW_DURING_CHANGE = new Set(['/api/change-password', '/api/logout', '/api/me']);

function requireAuth(req, res, next) {
  if (!(req.session && req.session.userId)) {
    return res.status(401).json({ error: 'Giris yapilmamis' });
  }
  if (req.session.mustChange && !ALLOW_DURING_CHANGE.has(req.path)) {
    return res.status(403).json({ error: 'Once parolanizi degistirmelisiniz', mustChange: true });
  }
  next();
}

async function requireAdmin(req, res, next) {
  if (!(req.session && req.session.userId)) {
    return res.status(401).json({ error: 'Giris yapilmamis' });
  }
  try {
    const r = await db.query('SELECT role, must_change_password FROM users WHERE id = $1', [
      req.session.userId,
    ]);
    if (!r.rows.length) return res.status(401).json({ error: 'Kullanici bulunamadi' });
    if (r.rows[0].must_change_password) {
      return res.status(403).json({ error: 'Once parolanizi degistirmelisiniz', mustChange: true });
    }
    if (r.rows[0].role !== 'admin') return res.status(403).json({ error: 'Yetkiniz yok' });
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatasi' });
  }
}

// Yeni parolanin son N parola ile ayni olup olmadigini kontrol et
async function isInRecentPasswords(userId, newPlain, n = 3) {
  const r = await db.query(
    'SELECT password FROM password_history WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    [userId, n]
  );
  for (const row of r.rows) {
    if (await bcrypt.compare(newPlain, row.password)) return true;
  }
  return false;
}

// Toplam maliyet = ara toplam + komisyon, sonra komisyon uzerine bsmv
function computeTotal(qty, price, commissionRate, bsmvRate) {
  const base = qty * price;
  const commission = (base * (commissionRate || 0)) / 100;
  const bsmv = (commission * (bsmvRate || 0)) / 100;
  return Math.round((base + commission + bsmv) * 10000) / 10000;
}

// ---- Kimlik dogrulama ----
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Kullanici adi ve sifre gerekli' });
  }
  try {
    const r = await db.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
    if (r.rows.length === 0) {
      return res.status(401).json({ error: 'Kullanici adi veya sifre hatali' });
    }
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ error: 'Kullanici adi veya sifre hatali' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.mustChange = user.must_change_password;
    res.json({
      ok: true,
      username: user.username,
      role: user.role,
      mustChange: user.must_change_password,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatasi' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', async (req, res) => {
  if (!(req.session && req.session.userId)) {
    return res.status(401).json({ error: 'Giris yapilmamis' });
  }
  try {
    const r = await db.query(
      'SELECT username, role, must_change_password FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Kullanici bulunamadi' });
    req.session.role = r.rows[0].role;
    req.session.mustChange = r.rows[0].must_change_password;
    res.json({
      username: r.rows[0].username,
      role: r.rows[0].role,
      mustChange: r.rows[0].must_change_password,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatasi' });
  }
});

// ---- Kendi parolasini degistir (ilk giris zorunlu degisimi de buradan) ----
app.post('/api/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Mevcut ve yeni parola gerekli' });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: 'Yeni parola en az 6 karakter olmali' });
  }
  try {
    const r = await db.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
      return res.status(400).json({ error: 'Mevcut parola hatali' });
    }
    if (await isInRecentPasswords(user.id, newPassword, 3)) {
      return res.status(400).json({ error: 'Son 3 parolanizdan birini tekrar kullanamazsiniz' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password = $1, must_change_password = false WHERE id = $2', [
      hash,
      user.id,
    ]);
    await db.query('INSERT INTO password_history (user_id, password) VALUES ($1, $2)', [
      user.id,
      hash,
    ]);
    req.session.mustChange = false;
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Parola degistirilemedi' });
  }
});

// ---- Kullanici yonetimi (yalnizca admin) ----
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, username, role, must_change_password, created_at
         FROM users ORDER BY username`
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Kullanici adi ve parola gerekli' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Parola en az 6 karakter olmali' });
  }
  const rl = role === 'admin' ? 'admin' : 'normal';
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await db.query(
      `INSERT INTO users (username, password, role, must_change_password)
       VALUES ($1, $2, $3, true)
       RETURNING id, username, role, must_change_password, created_at`,
      [username.trim(), hash, rl]
    );
    await db.query('INSERT INTO password_history (user_id, password) VALUES ($1, $2)', [
      r.rows[0].id,
      hash,
    ]);
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Bu kullanici adi zaten var' });
    console.error(err);
    res.status(500).json({ error: 'Kullanici eklenemedi' });
  }
});

app.put('/api/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { username, role, password } = req.body || {};
  try {
    const t = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    if (!t.rows.length) return res.status(404).json({ error: 'Kullanici bulunamadi' });
    const target = t.rows[0];
    const newRole = role ? (role === 'admin' ? 'admin' : 'normal') : target.role;
    const newUsername = username ? username.trim() : target.username;

    // Son admin'in yetkisini dusurmeyi engelle
    if (target.role === 'admin' && newRole !== 'admin') {
      const c = await db.query("SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin'");
      if (c.rows[0].c <= 1) {
        return res.status(400).json({ error: 'Son admin yetkisi kaldirilamaz' });
      }
    }

    if (password) {
      if (String(password).length < 6) {
        return res.status(400).json({ error: 'Parola en az 6 karakter olmali' });
      }
      const hash = await bcrypt.hash(password, 10);
      await db.query(
        'UPDATE users SET username = $1, role = $2, password = $3, must_change_password = true WHERE id = $4',
        [newUsername, newRole, hash, id]
      );
      await db.query('INSERT INTO password_history (user_id, password) VALUES ($1, $2)', [id, hash]);
    } else {
      await db.query('UPDATE users SET username = $1, role = $2 WHERE id = $3', [
        newUsername,
        newRole,
        id,
      ]);
    }
    if (id === req.session.userId) req.session.role = newRole;
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Bu kullanici adi zaten var' });
    console.error(err);
    res.status(500).json({ error: 'Guncellenemedi' });
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.userId) {
    return res.status(400).json({ error: 'Kendi hesabinizi silemezsiniz' });
  }
  try {
    const t = await db.query('SELECT role FROM users WHERE id = $1', [id]);
    if (!t.rows.length) return res.status(404).json({ error: 'Kullanici bulunamadi' });
    if (t.rows[0].role === 'admin') {
      const c = await db.query("SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin'");
      if (c.rows[0].c <= 1) return res.status(400).json({ error: 'Son admin silinemez' });
    }
    await db.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Silinemedi' });
  }
});

// ---- Dashboard ozeti ----
app.get('/api/summary', requireAuth, async (req, res) => {
  try {
    const data = await portfolio.summary(req.session.userId);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ozet alinamadi' });
  }
});

// ---- Belirli tarihteki USD/TRY kuru (fx_rates_history) - BIST/ABD ortak ----
app.get('/api/fx-on', requireAuth, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date gerekli' });
  try {
    res.json(await usportfolio.rateOnDate(date));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Kur alinamadi' });
  }
});

// ---- Belirli tarihteki fiyat (Alim Ekle formu otomatik doldurur) ----
app.get('/api/price-on', requireAuth, async (req, res) => {
  const { symbol, date } = req.query;
  if (!symbol || !date) {
    return res.status(400).json({ error: 'symbol ve date gerekli' });
  }
  try {
    const r = await portfolio.priceOnDate(symbol, date);
    res.json(r);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fiyat alinamadi' });
  }
});

// ---- Hesap makinesi: gecmis fiyati olan hisseler ----
app.get('/api/history-symbols', requireAuth, async (req, res) => {
  try {
    res.json(await portfolio.historySymbols());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

// ---- Hesap makinesi: duzenli alim (DCA) hesabi ----
app.get('/api/dca', requireAuth, async (req, res) => {
  const { symbol, start, daily, reinvest } = req.query;
  if (!symbol || !start || daily === undefined) {
    return res.status(400).json({ error: 'symbol, start ve daily gerekli' });
  }
  const d = Number(daily);
  if (!(d > 0)) return res.status(400).json({ error: 'Gunluk alim degeri pozitif olmali' });
  const reinv = reinvest === '1' || reinvest === 'true';
  try {
    res.json(await portfolio.dca(symbol, start, d, reinv));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Hesaplanamadi' });
  }
});

// Hesap makinesi · Strateji 1: maliyet dususunde alim
app.get('/api/calc/dip', requireAuth, async (req, res) => {
  const { symbol, start, qty, dropPct, mode, reinvest } = req.query;
  if (!symbol || !start || qty === undefined || dropPct === undefined) {
    return res.status(400).json({ error: 'symbol, start, qty ve dropPct gerekli' });
  }
  const q = Number(qty);
  const dp = Number(dropPct);
  if (!(q > 0)) return res.status(400).json({ error: 'Adet pozitif olmali' });
  if (!(dp > 0)) return res.status(400).json({ error: 'Düşüş yüzdesi pozitif olmali' });
  const reinv = reinvest === '1' || reinvest === 'true';
  try {
    res.json(await portfolio.simulateDip(symbol, start, q, dp, mode, reinv));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Hesaplanamadi' });
  }
});

// Hesap makinesi · Strateji 2: periyodik alim (gun/hafta)
app.get('/api/calc/periodic', requireAuth, async (req, res) => {
  const { symbol, start, qty, period, mode, reinvest } = req.query;
  if (!symbol || !start || qty === undefined) {
    return res.status(400).json({ error: 'symbol, start ve qty gerekli' });
  }
  const q = Number(qty);
  if (!(q > 0)) return res.status(400).json({ error: 'Adet pozitif olmali' });
  const reinv = reinvest === '1' || reinvest === 'true';
  try {
    res.json(await portfolio.simulatePeriodic(symbol, start, q, period, mode, reinv));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Hesaplanamadi' });
  }
});

// ---- Temettu takvimi (ORTAK referans veri) ----
app.get('/api/dividends', requireAuth, async (req, res) => {
  try {
    res.json(await portfolio.listDividends(req.query.symbol));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

app.post('/api/dividends', requireAuth, async (req, res) => {
  const { symbol, pay_date, gross, net } = req.body || {};
  if (!symbol || !pay_date || gross === undefined || gross === null) {
    return res.status(400).json({ error: 'Hisse, tarih ve brut tutar gerekli' });
  }
  const g = Number(gross);
  if (!(g >= 0)) return res.status(400).json({ error: 'Gecerli brut tutar girin' });
  // net verilmezse brut*0.85
  const n = net !== undefined && net !== null && net !== '' ? Number(net) : g * 0.85;
  if (!(n >= 0)) return res.status(400).json({ error: 'Gecerli net tutar girin' });
  try {
    const r = await db.query(
      `INSERT INTO dividends (symbol, pay_date, gross, net) VALUES ($1,$2,$3,$4) RETURNING *`,
      [symbol.trim().toUpperCase(), pay_date, g, n]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Kaydedilemedi' });
  }
});

app.delete('/api/dividends/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM dividends WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Silinemedi' });
  }
});

// ---- Portfoy degeri zaman serisi (price_history.close) ----
app.get('/api/portfolio-history', requireAuth, async (req, res) => {
  try {
    const data = await portfolio.portfolioHistory(req.session.userId);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gecmis alinamadi' });
  }
});

// ---- Temettu istatistikleri (yil/ay) ----
app.get('/api/dividend-stats', requireAuth, async (req, res) => {
  try {
    const data = await portfolio.dividendStats(req.session.userId);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Istatistik alinamadi' });
  }
});

// ---- Alim oncesi durum (Alim Ekle formunda gosterilir) ----
app.get('/api/holdings-before', requireAuth, async (req, res) => {
  const { symbol, date } = req.query;
  if (!symbol || !date) {
    return res.status(400).json({ error: 'symbol ve date gerekli' });
  }
  try {
    const h = await portfolio.holdingsBeforeDate(req.session.userId, symbol, date);
    res.json(h);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Hesaplanamadi' });
  }
});

// ---- Alim ekle ----
app.post('/api/purchases', requireAuth, async (req, res) => {
  const { trade_date, symbol, quantity, price, source, usd_rate, commission_rate, bsmv_rate } =
    req.body || {};
  if (!trade_date || !symbol || !quantity || price === undefined || price === null) {
    return res.status(400).json({ error: 'Tarih, hisse, adet ve fiyat gerekli' });
  }
  const qty = Number(quantity);
  const prc = Number(price);
  if (!(qty > 0) || !(prc >= 0)) {
    return res.status(400).json({ error: 'Adet ve fiyat gecerli olmali' });
  }
  const src = ['temettu', 'bedelsiz', 'bedelli'].includes(source) ? source : 'normal';
  const usd = usd_rate ? Number(usd_rate) : null;
  const comm = commission_rate ? Number(commission_rate) : 0;
  const bsmv = bsmv_rate ? Number(bsmv_rate) : 0;
  const total = computeTotal(qty, prc, comm, bsmv);
  const sym = symbol.trim().toUpperCase();
  try {
    const r = await db.query(
      `INSERT INTO purchases (user_id, trade_date, symbol, quantity, price, source, usd_rate, commission_rate, bsmv_rate, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.session.userId, trade_date, sym, qty, prc, src, usd, comm, bsmv, total]
    );
    // Daha once girilmemis bir hisse ise ortak fiyat tablosuna 0 ile ekle
    // (mevcutsa dokunma). Windows servisi sonradan fiyati gunceller.
    await db.query(
      `INSERT INTO prices (symbol, price) VALUES ($1, 0) ON CONFLICT (symbol) DO NOTHING`,
      [sym]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Alim kaydedilemedi' });
  }
});

// ---- Bedelsiz pay (bonus issue) ----
// Adet, mevcut pozisyonun 'ratio' yuzdesi kadar artar; fiyat=0/total=0 oldugu icin
// toplam maliyet ve nakit DEGISMEZ -> ortalama maliyet adet oraninda duser.
// source='bedelsiz' olarak isaretlenir. Mevcut tum hesaplar (currentPortfolio,
// cashBalance, komisyon, snapshot) bu satiri dogal olarak dogru isler.
app.post('/api/purchases/bonus', requireAuth, async (req, res) => {
  const { trade_date, symbol, ratio } = req.body || {};
  if (!trade_date || !symbol || ratio === undefined || ratio === null) {
    return res.status(400).json({ error: 'Tarih, hisse ve oran gerekli' });
  }
  const rt = Number(ratio);
  if (!(rt > 0)) return res.status(400).json({ error: 'Oran pozitif olmali' });
  const sym = symbol.trim().toUpperCase();
  try {
    const cur = await db.query(
      `SELECT COALESCE(SUM(quantity),0) AS qty FROM purchases WHERE user_id=$1 AND symbol=$2`,
      [req.session.userId, sym]
    );
    const baseQty = Number(cur.rows[0].qty);
    if (!(baseQty > 0)) {
      return res.status(400).json({ error: 'Bu hisseden pozisyon yok; bedelsiz eklenemez' });
    }
    const newShares = Math.round(baseQty * (rt / 100) * 10000) / 10000;
    if (!(newShares > 0)) {
      return res.status(400).json({ error: 'Hesaplanan bedelsiz adedi 0 cikti' });
    }
    const r = await db.query(
      `INSERT INTO purchases (user_id, trade_date, symbol, quantity, price, source, usd_rate, commission_rate, bsmv_rate, total)
       VALUES ($1,$2,$3,$4,0,'bedelsiz',NULL,0,0,0) RETURNING *`,
      [req.session.userId, trade_date, sym, newShares]
    );
    res.json({ ...r.rows[0], baseQty, newShares, ratio: rt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bedelsiz kaydedilemedi' });
  }
});

// ---- Bedelli pay (rights issue) ----
// Rucan fiyatindan yeni pay alinir: adet 'ratio' yuzdesi kadar artar, her pay
// 'price' TL'den. total=adet*fiyat oldugu icin maliyet artar ve nakit dusulur
// (cashBalance total'i otomatik dususte gorur). source='bedelli'.
app.post('/api/purchases/rights', requireAuth, async (req, res) => {
  const { trade_date, symbol, ratio, price } = req.body || {};
  if (!trade_date || !symbol || ratio === undefined || ratio === null || price === undefined || price === null) {
    return res.status(400).json({ error: 'Tarih, hisse, oran ve fiyat gerekli' });
  }
  const rt = Number(ratio);
  const prc = Number(price);
  if (!(rt > 0)) return res.status(400).json({ error: 'Oran pozitif olmali' });
  if (!(prc > 0)) return res.status(400).json({ error: 'Rüçhan fiyatı pozitif olmali' });
  const sym = symbol.trim().toUpperCase();
  try {
    const cur = await db.query(
      `SELECT COALESCE(SUM(quantity),0) AS qty FROM purchases WHERE user_id=$1 AND symbol=$2`,
      [req.session.userId, sym]
    );
    const baseQty = Number(cur.rows[0].qty);
    if (!(baseQty > 0)) {
      return res.status(400).json({ error: 'Bu hisseden pozisyon yok; bedelli eklenemez' });
    }
    const newShares = Math.round(baseQty * (rt / 100) * 10000) / 10000;
    if (!(newShares > 0)) {
      return res.status(400).json({ error: 'Hesaplanan bedelli adedi 0 cikti' });
    }
    const total = computeTotal(newShares, prc, 0, 0);
    const r = await db.query(
      `INSERT INTO purchases (user_id, trade_date, symbol, quantity, price, source, usd_rate, commission_rate, bsmv_rate, total)
       VALUES ($1,$2,$3,$4,$5,'bedelli',NULL,0,0,$6) RETURNING *`,
      [req.session.userId, trade_date, sym, newShares, prc, total]
    );
    res.json({ ...r.rows[0], baseQty, newShares, ratio: rt, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bedelli kaydedilemedi' });
  }
});

// ---- Nakit / Temettu ekle ----
app.post('/api/cash', requireAuth, async (req, res) => {
  const { move_date, amount, symbol, note } = req.body || {};
  if (!move_date || amount === undefined || amount === null) {
    return res.status(400).json({ error: 'Tarih ve miktar gerekli' });
  }
  const amt = Number(amount);
  if (!(amt !== 0) || Number.isNaN(amt)) {
    return res.status(400).json({ error: 'Gecerli bir miktar girin' });
  }
  const sym = symbol && symbol.trim() ? symbol.trim().toUpperCase() : null;
  const kind = sym ? 'dividend' : 'cash';
  try {
    const r = await db.query(
      `INSERT INTO cash_movements (user_id, move_date, amount, kind, symbol, note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.session.userId, move_date, amt, kind, sym, note || null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Kayit eklenemedi' });
  }
});

// ---- Nakit duzeltme (hedef bakiyeye gore otomatik fark girisi) ----
app.post('/api/cash/adjust', requireAuth, async (req, res) => {
  const { move_date, target } = req.body || {};
  if (!move_date || target === undefined || target === null) {
    return res.status(400).json({ error: 'Tarih ve hedef bakiye gerekli' });
  }
  const tgt = Number(target);
  if (Number.isNaN(tgt)) return res.status(400).json({ error: 'Gecerli bir bakiye girin' });
  try {
    const current = await portfolio.cashBalance(req.session.userId);
    const diff = Math.round((tgt - current) * 10000) / 10000;
    if (diff === 0) {
      return res.json({ ok: true, adjusted: 0, current, message: 'Bakiye zaten hedefle eşit' });
    }
    const r = await db.query(
      `INSERT INTO cash_movements (user_id, move_date, amount, kind, symbol, note)
       VALUES ($1,$2,$3,'cash',NULL,'Nakit düzeltme') RETURNING *`,
      [req.session.userId, move_date, diff]
    );
    res.json({ ok: true, adjusted: diff, current, target: tgt, row: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Duzeltme yapilamadi' });
  }
});

// ---- Islem listeleri ----
app.get('/api/purchases', requireAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT * FROM purchases WHERE user_id = $1 ORDER BY trade_date DESC, id DESC`,
      [req.session.userId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

app.get('/api/cash', requireAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT * FROM cash_movements WHERE user_id = $1 ORDER BY move_date DESC, id DESC`,
      [req.session.userId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

app.delete('/api/purchases/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM purchases WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.session.userId,
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Silinemedi' });
  }
});

app.delete('/api/cash/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM cash_movements WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.session.userId,
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Silinemedi' });
  }
});

// ---- Alim duzenle ----
app.put('/api/purchases/:id', requireAuth, async (req, res) => {
  const { trade_date, symbol, quantity, price, source, usd_rate, commission_rate, bsmv_rate } =
    req.body || {};
  if (!trade_date || !symbol || !quantity || price === undefined || price === null) {
    return res.status(400).json({ error: 'Tarih, hisse, adet ve fiyat gerekli' });
  }
  const qty = Number(quantity);
  const prc = Number(price);
  if (!(qty > 0) || !(prc >= 0)) {
    return res.status(400).json({ error: 'Adet ve fiyat gecerli olmali' });
  }
  const src = ['temettu', 'bedelsiz', 'bedelli'].includes(source) ? source : 'normal';
  const usd = usd_rate ? Number(usd_rate) : null;
  const comm = commission_rate ? Number(commission_rate) : 0;
  const bsmv = bsmv_rate ? Number(bsmv_rate) : 0;
  const total = computeTotal(qty, prc, comm, bsmv);
  try {
    const r = await db.query(
      `UPDATE purchases
          SET trade_date=$1, symbol=$2, quantity=$3, price=$4, source=$5, usd_rate=$6,
              commission_rate=$7, bsmv_rate=$8, total=$9
        WHERE id=$10 AND user_id=$11 RETURNING *`,
      [trade_date, symbol.trim().toUpperCase(), qty, prc, src, usd, comm, bsmv, total, req.params.id, req.session.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Kayit bulunamadi' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Guncellenemedi' });
  }
});

// ---- Nakit / Temettu duzenle ----
app.put('/api/cash/:id', requireAuth, async (req, res) => {
  const { move_date, amount, symbol, note } = req.body || {};
  if (!move_date || amount === undefined || amount === null) {
    return res.status(400).json({ error: 'Tarih ve miktar gerekli' });
  }
  const amt = Number(amount);
  if (Number.isNaN(amt) || amt === 0) {
    return res.status(400).json({ error: 'Gecerli bir miktar girin' });
  }
  const sym = symbol && symbol.trim() ? symbol.trim().toUpperCase() : null;
  const kind = sym ? 'dividend' : 'cash';
  try {
    const r = await db.query(
      `UPDATE cash_movements
          SET move_date=$1, amount=$2, kind=$3, symbol=$4, note=$5
        WHERE id=$6 AND user_id=$7 RETURNING *`,
      [move_date, amt, kind, sym, note || null, req.params.id, req.session.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Kayit bulunamadi' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Guncellenemedi' });
  }
});

// ---- Fiyat tablosu (TUM kullanicilar icin ORTAK) ----
app.get('/api/prices', requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM prices ORDER BY symbol');
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

// Ekle veya guncelle (upsert) - sembol bazli
app.post('/api/prices', requireAuth, async (req, res) => {
  const { symbol, price } = req.body || {};
  if (!symbol || price === undefined || price === null) {
    return res.status(400).json({ error: 'Hisse ve fiyat gerekli' });
  }
  const prc = Number(price);
  if (!(prc >= 0)) return res.status(400).json({ error: 'Gecerli fiyat girin' });
  try {
    const r = await db.query(
      `INSERT INTO prices (symbol, price, updated_at)
       VALUES ($1,$2, now())
       ON CONFLICT (symbol)
       DO UPDATE SET price = EXCLUDED.price, updated_at = now()
       RETURNING *`,
      [symbol.trim().toUpperCase(), prc]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Kaydedilemedi' });
  }
});

app.delete('/api/prices/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM prices WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Silinemedi' });
  }
});

// ---- Canli guncelleme (SSE) - fiyat degisince istemcilere bildir ----
const sseClients = new Set();
app.get('/api/events', requireAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  // baglantiyi canli tut
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

// ===================== ABD (US) route'lari =====================
app.get('/api/us/summary', requireAuth, async (req, res) => {
  try {
    res.json(await usportfolio.summary(req.session.userId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ozet alinamadi' });
  }
});

app.get('/api/us/holdings-before', requireAuth, async (req, res) => {
  const { symbol, date } = req.query;
  if (!symbol || !date) return res.status(400).json({ error: 'symbol ve date gerekli' });
  try {
    res.json(await usportfolio.holdingsBeforeDate(req.session.userId, symbol, date));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Hesaplanamadi' });
  }
});

// ABD hissesinin tarihteki kapanisi (alim fiyati otomatik doldurmak icin)
app.get('/api/us/price-on', requireAuth, async (req, res) => {
  const { symbol, date } = req.query;
  if (!symbol || !date) return res.status(400).json({ error: 'symbol ve date gerekli' });
  try {
    res.json(await usportfolio.priceOnDate(symbol, date));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fiyat alinamadi' });
  }
});

// Tarihteki USD/TRY (alimda kur otomatik doldurmak icin)
app.get('/api/us/fx-on', requireAuth, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date gerekli' });
  try {
    res.json(await usportfolio.rateOnDate(date));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Kur alinamadi' });
  }
});

app.get('/api/us/prices', requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM us_prices ORDER BY symbol');
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

// ---- ABD alimlar ----
app.get('/api/us/purchases', requireAuth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT * FROM us_purchases WHERE user_id=$1 ORDER BY trade_date DESC, id DESC',
      [req.session.userId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

function readUsPurchase(body) {
  const { trade_date, symbol, quantity, price, source, usdtry, commission } = body || {};
  if (!trade_date || !symbol || !quantity || price === undefined || price === null) return null;
  const qty = Number(quantity);
  const prc = Number(price);
  if (!(qty > 0) || !(prc >= 0)) return { error: 'Adet ve fiyat gecerli olmali' };
  const comm = commission ? Number(commission) : 0; // SABIT USD
  if (!(comm >= 0)) return { error: 'Komisyon gecerli olmali' };
  const total = Math.round((qty * prc + comm) * 1000000) / 1000000;
  return {
    trade_date,
    symbol: symbol.trim().toUpperCase(),
    qty,
    prc,
    src: source === 'temettu' ? 'temettu' : 'normal',
    fx: usdtry ? Number(usdtry) : null,
    comm,
    total,
  };
}

app.post('/api/us/purchases', requireAuth, async (req, res) => {
  const p = readUsPurchase(req.body);
  if (!p) return res.status(400).json({ error: 'Tarih, hisse, adet ve fiyat gerekli' });
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const r = await db.query(
      `INSERT INTO us_purchases (user_id, trade_date, symbol, quantity, price, source, usdtry, commission, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.session.userId, p.trade_date, p.symbol, p.qty, p.prc, p.src, p.fx, p.comm, p.total]
    );
    await db.query('INSERT INTO us_prices (symbol, price) VALUES ($1, 0) ON CONFLICT (symbol) DO NOTHING', [p.symbol]);
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Alim kaydedilemedi' });
  }
});

app.put('/api/us/purchases/:id', requireAuth, async (req, res) => {
  const p = readUsPurchase(req.body);
  if (!p) return res.status(400).json({ error: 'Tarih, hisse, adet ve fiyat gerekli' });
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const r = await db.query(
      `UPDATE us_purchases SET trade_date=$1, symbol=$2, quantity=$3, price=$4, source=$5,
              usdtry=$6, commission=$7, total=$8
        WHERE id=$9 AND user_id=$10 RETURNING *`,
      [p.trade_date, p.symbol, p.qty, p.prc, p.src, p.fx, p.comm, p.total, req.params.id, req.session.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Kayit bulunamadi' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Guncellenemedi' });
  }
});

app.delete('/api/us/purchases/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM us_purchases WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Silinemedi' });
  }
});

// ---- ABD nakit/temettu ----
app.get('/api/us/cash', requireAuth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT * FROM us_cash_movements WHERE user_id=$1 ORDER BY move_date DESC, id DESC',
      [req.session.userId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

app.post('/api/us/cash', requireAuth, async (req, res) => {
  const { move_date, amount, symbol, note } = req.body || {};
  if (!move_date || amount === undefined || amount === null) {
    return res.status(400).json({ error: 'Tarih ve miktar gerekli' });
  }
  const amt = Number(amount);
  if (Number.isNaN(amt) || amt === 0) return res.status(400).json({ error: 'Gecerli bir miktar girin' });
  const sym = symbol && symbol.trim() ? symbol.trim().toUpperCase() : null;
  const kind = sym ? 'dividend' : 'cash';
  try {
    const r = await db.query(
      `INSERT INTO us_cash_movements (user_id, move_date, amount, kind, symbol, note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.session.userId, move_date, amt, kind, sym, note || null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Kayit eklenemedi' });
  }
});

app.put('/api/us/cash/:id', requireAuth, async (req, res) => {
  const { move_date, amount, symbol, note } = req.body || {};
  if (!move_date || amount === undefined || amount === null) {
    return res.status(400).json({ error: 'Tarih ve miktar gerekli' });
  }
  const amt = Number(amount);
  if (Number.isNaN(amt) || amt === 0) return res.status(400).json({ error: 'Gecerli bir miktar girin' });
  const sym = symbol && symbol.trim() ? symbol.trim().toUpperCase() : null;
  const kind = sym ? 'dividend' : 'cash';
  try {
    const r = await db.query(
      `UPDATE us_cash_movements SET move_date=$1, amount=$2, kind=$3, symbol=$4, note=$5
        WHERE id=$6 AND user_id=$7 RETURNING *`,
      [move_date, amt, kind, sym, note || null, req.params.id, req.session.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Kayit bulunamadi' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Guncellenemedi' });
  }
});

app.delete('/api/us/cash/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM us_cash_movements WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Silinemedi' });
  }
});

// ===================== KIYMETLI MADEN route'lari =====================
app.get('/api/metal/summary', requireAuth, async (req, res) => {
  try {
    res.json(await metalportfolio.summary(req.session.userId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ozet alinamadi' });
  }
});

app.get('/api/metal/holdings-before', requireAuth, async (req, res) => {
  const { metal, date } = req.query;
  if (!metal || !date) return res.status(400).json({ error: 'metal ve date gerekli' });
  try {
    res.json(await metalportfolio.holdingsBeforeDate(req.session.userId, metal, date));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Hesaplanamadi' });
  }
});

app.get('/api/metal/prices', requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM metal_prices ORDER BY metal');
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

app.get('/api/metal/purchases', requireAuth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT * FROM metal_purchases WHERE user_id=$1 ORDER BY trade_date DESC, id DESC',
      [req.session.userId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

function readMetalPurchase(body) {
  const { trade_date, metal, quantity, price } = body || {};
  if (!trade_date || !metal || !quantity || price === undefined || price === null) return null;
  const m = String(metal).trim().toLowerCase();
  if (m !== 'gold' && m !== 'silver') return { error: 'Maden altin veya gumus olmali' };
  const qty = Number(quantity);
  const prc = Number(price);
  if (!(qty > 0) || !(prc >= 0)) return { error: 'Gram ve fiyat gecerli olmali' };
  const total = Math.round(qty * prc * 10000) / 10000;
  return { trade_date, metal: m, qty, prc, total };
}

app.post('/api/metal/purchases', requireAuth, async (req, res) => {
  const p = readMetalPurchase(req.body);
  if (!p) return res.status(400).json({ error: 'Tarih, maden, gram ve fiyat gerekli' });
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const r = await db.query(
      `INSERT INTO metal_purchases (user_id, trade_date, metal, quantity, price, total)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.session.userId, p.trade_date, p.metal, p.qty, p.prc, p.total]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Alim kaydedilemedi' });
  }
});

app.put('/api/metal/purchases/:id', requireAuth, async (req, res) => {
  const p = readMetalPurchase(req.body);
  if (!p) return res.status(400).json({ error: 'Tarih, maden, gram ve fiyat gerekli' });
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const r = await db.query(
      `UPDATE metal_purchases SET trade_date=$1, metal=$2, quantity=$3, price=$4, total=$5
        WHERE id=$6 AND user_id=$7 RETURNING *`,
      [p.trade_date, p.metal, p.qty, p.prc, p.total, req.params.id, req.session.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Kayit bulunamadi' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Guncellenemedi' });
  }
});

app.delete('/api/metal/purchases/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM metal_purchases WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Silinemedi' });
  }
});

// ===================== DOVIZ route'lari =====================
app.get('/api/currency/summary', requireAuth, async (req, res) => {
  try {
    res.json(await currencyportfolio.summary(req.session.userId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ozet alinamadi' });
  }
});

app.get('/api/currency/holdings-before', requireAuth, async (req, res) => {
  const { currency, date } = req.query;
  if (!currency || !date) return res.status(400).json({ error: 'currency ve date gerekli' });
  try {
    res.json(await currencyportfolio.holdingsBeforeDate(req.session.userId, currency, date));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Hesaplanamadi' });
  }
});

app.get('/api/currency/prices', requireAuth, async (req, res) => {
  try {
    res.json(await currencyportfolio.pricesList());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

app.get('/api/currency/purchases', requireAuth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT * FROM currency_purchases WHERE user_id=$1 ORDER BY trade_date DESC, id DESC',
      [req.session.userId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

function readCurrencyPurchase(body) {
  const { trade_date, currency, quantity, price } = body || {};
  if (!trade_date || !currency || !quantity || price === undefined || price === null) return null;
  const c = String(currency).trim().toLowerCase();
  if (c !== 'usd' && c !== 'eur') return { error: 'Doviz dolar veya euro olmali' };
  const qty = Number(quantity);
  const prc = Number(price);
  if (!(qty > 0) || !(prc >= 0)) return { error: 'Adet ve fiyat gecerli olmali' };
  const total = Math.round(qty * prc * 10000) / 10000;
  return { trade_date, currency: c, qty, prc, total };
}

app.post('/api/currency/purchases', requireAuth, async (req, res) => {
  const p = readCurrencyPurchase(req.body);
  if (!p) return res.status(400).json({ error: 'Tarih, doviz, adet ve fiyat gerekli' });
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const r = await db.query(
      `INSERT INTO currency_purchases (user_id, trade_date, currency, quantity, price, total)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.session.userId, p.trade_date, p.currency, p.qty, p.prc, p.total]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Alim kaydedilemedi' });
  }
});

app.put('/api/currency/purchases/:id', requireAuth, async (req, res) => {
  const p = readCurrencyPurchase(req.body);
  if (!p) return res.status(400).json({ error: 'Tarih, doviz, adet ve fiyat gerekli' });
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const r = await db.query(
      `UPDATE currency_purchases SET trade_date=$1, currency=$2, quantity=$3, price=$4, total=$5
        WHERE id=$6 AND user_id=$7 RETURNING *`,
      [p.trade_date, p.currency, p.qty, p.prc, p.total, req.params.id, req.session.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Kayit bulunamadi' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Guncellenemedi' });
  }
});

app.delete('/api/currency/purchases/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM currency_purchases WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Silinemedi' });
  }
});

// ===================== KRIPTO route'lari =====================
// Binance'de coin var mi? Varsa guncel USD fiyatini dondur, yoksa null.
async function binancePrice(coin) {
  const sym = cryptoportfolio.normSymbol(coin) + 'USDT';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`, { signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    const p = Number(j.price);
    return p > 0 ? p : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Alimi olmayan (yetim) coin'leri fiyat tablosundan temizle
async function cleanupCryptoPrices() {
  await db.query(
    `DELETE FROM crypto_prices cp
      WHERE NOT EXISTS (SELECT 1 FROM crypto_purchases p WHERE p.symbol = cp.symbol)`
  );
}

app.get('/api/crypto/summary', requireAuth, async (req, res) => {
  try {
    res.json(await cryptoportfolio.summary(req.session.userId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ozet alinamadi' });
  }
});

app.get('/api/crypto/holdings-before', requireAuth, async (req, res) => {
  const { symbol, date } = req.query;
  if (!symbol || !date) return res.status(400).json({ error: 'symbol ve date gerekli' });
  try {
    res.json(await cryptoportfolio.holdingsBeforeDate(req.session.userId, symbol, date));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Hesaplanamadi' });
  }
});

app.get('/api/crypto/prices', requireAuth, async (req, res) => {
  try {
    res.json(await cryptoportfolio.pricesList());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

app.get('/api/crypto/purchases', requireAuth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT * FROM crypto_purchases WHERE user_id=$1 ORDER BY trade_date DESC, id DESC',
      [req.session.userId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

function readCryptoPurchase(body) {
  const { trade_date, symbol, quantity, price } = body || {};
  if (!trade_date || !symbol || !quantity || price === undefined || price === null) return null;
  const sym = cryptoportfolio.normSymbol(symbol);
  if (!sym) return { error: 'Coin adi gerekli' };
  const qty = Number(quantity);
  const prc = Number(price);
  if (!(qty > 0) || !(prc >= 0)) return { error: 'Adet ve fiyat gecerli olmali' };
  const total = Math.round(qty * prc * 1e8) / 1e8;
  return { trade_date, symbol: sym, qty, prc, total };
}

app.post('/api/crypto/purchases', requireAuth, async (req, res) => {
  const p = readCryptoPurchase(req.body);
  if (!p) return res.status(400).json({ error: 'Tarih, coin, adet ve fiyat gerekli' });
  if (p.error) return res.status(400).json({ error: p.error });
  // Binance kontrolu: coin yoksa kaydetme (form acik kalir)
  const livePrice = await binancePrice(p.symbol);
  if (livePrice === null) {
    return res.status(400).json({ error: `Bu coin Binance'de bulunamadı: ${p.symbol}USDT` });
  }
  try {
    const r = await db.query(
      `INSERT INTO crypto_purchases (user_id, trade_date, symbol, quantity, price, total)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.session.userId, p.trade_date, p.symbol, p.qty, p.prc, p.total]
    );
    // coin'i fiyat tablosuna ekle + anlik fiyati hemen yaz (servis sonra gunceller)
    await db.query(
      `INSERT INTO crypto_prices (symbol, price, updated_at) VALUES ($1,$2, now())
       ON CONFLICT (symbol) DO UPDATE SET price = EXCLUDED.price, updated_at = now()`,
      [p.symbol, livePrice]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Alim kaydedilemedi' });
  }
});

app.put('/api/crypto/purchases/:id', requireAuth, async (req, res) => {
  const p = readCryptoPurchase(req.body);
  if (!p) return res.status(400).json({ error: 'Tarih, coin, adet ve fiyat gerekli' });
  if (p.error) return res.status(400).json({ error: p.error });
  const livePrice = await binancePrice(p.symbol);
  if (livePrice === null) {
    return res.status(400).json({ error: `Bu coin Binance'de bulunamadı: ${p.symbol}USDT` });
  }
  try {
    const r = await db.query(
      `UPDATE crypto_purchases SET trade_date=$1, symbol=$2, quantity=$3, price=$4, total=$5
        WHERE id=$6 AND user_id=$7 RETURNING *`,
      [p.trade_date, p.symbol, p.qty, p.prc, p.total, req.params.id, req.session.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Kayit bulunamadi' });
    await db.query(
      `INSERT INTO crypto_prices (symbol, price, updated_at) VALUES ($1,$2, now())
       ON CONFLICT (symbol) DO UPDATE SET price = EXCLUDED.price, updated_at = now()`,
      [p.symbol, livePrice]
    );
    await cleanupCryptoPrices(); // sembol degistiyse eski yetim coin'i temizle
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Guncellenemedi' });
  }
});

app.delete('/api/crypto/purchases/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM crypto_purchases WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
    await cleanupCryptoPrices(); // alimi kalmayan coin fiyat tablosundan cikar
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Silinemedi' });
  }
});

// ===================== NAKIT (elde tutulan TL/EUR/USD) =====================
app.get('/api/cash-holdings', requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT try_amount, eur_amount, usd_amount FROM cash_holdings WHERE user_id=$1', [req.session.userId]);
    const row = r.rows[0] || { try_amount: 0, eur_amount: 0, usd_amount: 0 };
    res.json({ try: Number(row.try_amount), eur: Number(row.eur_amount), usd: Number(row.usd_amount) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Alinamadi' });
  }
});

app.put('/api/cash-holdings', requireAuth, async (req, res) => {
  const { try: tryAmt, eur, usd } = req.body || {};
  const t = Number(tryAmt) || 0, e = Number(eur) || 0, u = Number(usd) || 0;
  if (t < 0 || e < 0 || u < 0) return res.status(400).json({ error: 'Negatif deger girilemez' });
  try {
    await db.query(
      `INSERT INTO cash_holdings (user_id, try_amount, eur_amount, usd_amount, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (user_id)
       DO UPDATE SET try_amount=EXCLUDED.try_amount, eur_amount=EXCLUDED.eur_amount,
                     usd_amount=EXCLUDED.usd_amount, updated_at=now()`,
      [req.session.userId, t, e, u]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Kaydedilemedi' });
  }
});

// Nakit ozeti: TL karsiligi (USD fx_rates'ten, EUR currency_prices'tan)
app.get('/api/cash-holdings/summary', requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT try_amount, eur_amount, usd_amount FROM cash_holdings WHERE user_id=$1', [req.session.userId]);
    const row = r.rows[0] || { try_amount: 0, eur_amount: 0, usd_amount: 0 };
    const tryAmt = Number(row.try_amount), eurAmt = Number(row.eur_amount), usdAmt = Number(row.usd_amount);
    const prices = await currencyportfolio.priceMap(); // { usd, eur }
    const usdRate = prices.usd > 0 ? prices.usd : null;
    const eurRate = prices.eur > 0 ? prices.eur : null;
    const totalTRY = tryAmt + eurAmt * (eurRate || 0) + usdAmt * (usdRate || 0);
    res.json({ try: tryAmt, eur: eurAmt, usd: usdAmt, usdRate, eurRate, totalTRY });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ozet alinamadi' });
  }
});

// ===================== BINANCE route'lari =====================
// 5 dakikada bir yenilenen toplam onbellegi (userId -> { totalTRY, totalUSDT, at })
const binanceCache = new Map();

// Kayitli anahtarlari maskeli dondur (ilk5 + son5)
app.get('/api/binance/keys', requireAuth, async (req, res) => {
  try {
    const k = await binance.getKeys(req.session.userId);
    if (!k) return res.json({ hasKeys: false, apiKeyMasked: '', apiSecretMasked: '' });
    res.json({
      hasKeys: true,
      apiKeyMasked: binance.mask(k.apiKey),
      apiSecretMasked: binance.mask(k.apiSecret),
      updatedAt: k.updatedAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Alinamadi' });
  }
});

// Anahtar kaydet: bos/null gelen alan mevcut degeri korur (maskeli gosterimi tekrar yazmamak icin)
app.put('/api/binance/keys', requireAuth, async (req, res) => {
  let { apiKey, apiSecret } = req.body || {};
  apiKey = (apiKey || '').trim();
  apiSecret = (apiSecret || '').trim();
  try {
    const existing = await binance.getKeys(req.session.userId);
    const finalKey = apiKey || (existing && existing.apiKey) || '';
    const finalSecret = apiSecret || (existing && existing.apiSecret) || '';
    if (!finalKey || !finalSecret) {
      return res.status(400).json({ error: 'API key ve secret gerekli' });
    }
    // Anahtarlari dogrula (gecersizse kaydetme)
    try {
      await binance.getTotals(finalKey, finalSecret);
    } catch (e) {
      return res.status(400).json({ error: `Anahtar doğrulanamadı: ${e.message}` });
    }
    await binance.saveKeys(req.session.userId, finalKey, finalSecret);
    binanceCache.delete(req.session.userId); // taze cekilsin
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Kaydedilemedi' });
  }
});

// Canli portfoy (spot varlik dagilimi + tum cuzdan toplami)
app.get('/api/binance/portfolio', requireAuth, async (req, res) => {
  try {
    const k = await binance.getKeys(req.session.userId);
    if (!k) return res.json({ hasKeys: false });
    const p = await binance.getPortfolio(k.apiKey, k.apiSecret);
    binanceCache.set(req.session.userId, { totalTRY: p.totalTRY, totalUSDT: p.totalUSDT, at: Date.now() });
    res.json({ hasKeys: true, ...p });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Portfoy alinamadi' });
  }
});

// Genel panodaki kart icin: onbellekten (yoksa canli) toplam
app.get('/api/binance/total', requireAuth, async (req, res) => {
  const cached = binanceCache.get(req.session.userId);
  if (cached) return res.json({ hasKeys: true, ...cached });
  try {
    const k = await binance.getKeys(req.session.userId);
    if (!k) return res.json({ hasKeys: false, totalTRY: null, totalUSDT: null, at: null });
    const t = await binance.getTotals(k.apiKey, k.apiSecret);
    const val = { totalTRY: t.totalTRY, totalUSDT: t.totalUSDT, at: Date.now() };
    binanceCache.set(req.session.userId, val);
    res.json({ hasKeys: true, ...val });
  } catch (err) {
    res.json({ hasKeys: true, totalTRY: null, totalUSDT: null, at: null, error: err.message });
  }
});

// 5 dakikada bir tum kullanicilarin toplamini yenile + istemcilere bildir
async function refreshAllBinance() {
  let rows;
  try {
    rows = (await db.query('SELECT user_id FROM binance_keys')).rows;
  } catch (_) {
    return;
  }
  for (const row of rows) {
    try {
      const k = await binance.getKeys(row.user_id);
      if (!k) continue;
      const t = await binance.getTotals(k.apiKey, k.apiSecret);
      binanceCache.set(row.user_id, { totalTRY: t.totalTRY, totalUSDT: t.totalUSDT, at: Date.now() });
    } catch (_) {
      /* bir kullanicida hata olursa digerlerini etkilemesin */
    }
  }
  if (rows.length) broadcast('binance_change', { at: Date.now() });
}

// ===================== TELEGRAM bildirim =====================
const tlFmt = (n) => new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(Number(n) || 0);
const usdFmt = (n) => new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'USD' }).format(Number(n) || 0);
function pctStr(profit, cost) {
  if (profit == null || !(cost > 0)) return '';
  const p = (profit / cost) * 100;
  const up = p >= 0;
  // Telegram font rengini desteklemez; renkli emoji ile yesil/kirmizi gosterilir
  return ` ${up ? '🟢' : '🔴'} ${up ? '+' : '-'}%${Math.abs(p).toFixed(2)}`;
}

// Genel pano toplamlarini sunucu tarafinda hesapla (Telegram ozeti icin)
async function computeGenelTotals(userId) {
  const [b, u, m, c, cy, fnd] = await Promise.all([
    portfolio.summary(userId),
    usportfolio.summary(userId),
    metalportfolio.summary(userId),
    currencyportfolio.summary(userId),
    cryptoportfolio.summary(userId),
    fundsportfolio.summary(userId),
  ]);
  const cashRow =
    (await db.query('SELECT try_amount, eur_amount, usd_amount FROM cash_holdings WHERE user_id=$1', [userId])).rows[0] ||
    { try_amount: 0, eur_amount: 0, usd_amount: 0 };
  const prices = await currencyportfolio.priceMap();
  const usdRate = prices.usd > 0 ? prices.usd : null;
  const eurRate = prices.eur > 0 ? prices.eur : null;
  const cashTRY = Number(cashRow.try_amount) + Number(cashRow.eur_amount) * (eurRate || 0) + Number(cashRow.usd_amount) * (usdRate || 0);
  const bnCached = binanceCache.get(userId);
  const binance = bnCached && bnCached.totalTRY != null ? bnCached.totalTRY : 0;

  const bist = b.totalAssets != null ? b.totalAssets : 0;
  const us = u.totalValueTRY != null ? u.totalValueTRY : 0;
  const metal = m.totalValue != null ? m.totalValue : 0;
  const curr = c.totalValue != null ? c.totalValue : 0;
  const crypto = cy.totalValueTRY != null ? cy.totalValueTRY : 0;
  const fundVal = fnd.totalValue != null ? fnd.totalValue : 0;
  const total = bist + us + metal + curr + crypto + cashTRY + binance + fundVal;
  return { b, u, m, c, cy, fnd, bist, us, metal, curr, crypto, cashTRY, binance, fund: fundVal, total, usdRate };
}

async function buildDailySummaryText(userId) {
  const g = await computeGenelTotals(userId);
  const d = new Date().toLocaleDateString('tr-TR');
  const usdStr = g.usdRate ? ` (≈ ${usdFmt(g.total / g.usdRate)})` : '';
  return [
    `📊 <b>Portföy Özeti</b> — ${d}`,
    '',
    `🏦 BIST: <b>${tlFmt(g.bist)}</b>${pctStr(g.b.totalProfit, g.b.totalCostBasis)}`,
    `🇺🇸 ABD: <b>${tlFmt(g.us)}</b>${pctStr(g.u.totalProfitUSD, g.u.totalCostUSD)}`,
    `🥇 Maden: <b>${tlFmt(g.metal)}</b>${pctStr(g.m.totalProfit, g.m.totalCost)}`,
    `💱 Döviz: <b>${tlFmt(g.curr)}</b>${pctStr(g.c.totalProfit, g.c.totalCost)}`,
    `🪙 Kripto: <b>${tlFmt(g.crypto)}</b>${pctStr(g.cy.totalProfitUSD, g.cy.totalCostUSD)}`,
    `🟣 Fon: <b>${g.fund ? tlFmt(g.fund) : '—'}</b>${pctStr(g.fnd.totalProfit, g.fnd.totalCost)}`,
    `💵 Nakit: <b>${tlFmt(g.cashTRY)}</b>`,
    `🟡 Binance: <b>${g.binance ? tlFmt(g.binance) : '—'}</b>`,
    '━━━━━━━━━━',
    `💰 <b>Toplam Bütçe: ${tlFmt(g.total)}</b>${usdStr}`,
  ].join('\n');
}

// Yerel tarih (YYYY-MM-DD) — sunucu yerel saatine gore
function localDateStr(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// Gunluk snapshot: TUM kullanicilar icin bugunku toplamlari kaydet (gunde 1 satir, upsert)
async function writeDailySnapshots() {
  let users;
  try {
    users = (await db.query('SELECT id FROM users')).rows;
  } catch (_) {
    return;
  }
  const today = localDateStr();
  for (const u of users) {
    try {
      const g = await computeGenelTotals(u.id);
      await db.query(
        `INSERT INTO portfolio_snapshots
           (user_id, snap_date, total_try, bist, us, metal, currency, crypto, cash, binance, fund, usd_rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (user_id, snap_date) DO UPDATE SET
           total_try=EXCLUDED.total_try, bist=EXCLUDED.bist, us=EXCLUDED.us, metal=EXCLUDED.metal,
           currency=EXCLUDED.currency, crypto=EXCLUDED.crypto, cash=EXCLUDED.cash,
           binance=EXCLUDED.binance, fund=EXCLUDED.fund, usd_rate=EXCLUDED.usd_rate`,
        [u.id, today, g.total, g.bist, g.us, g.metal, g.curr, g.crypto, g.cashTRY, g.binance, g.fund, g.usdRate]
      );
    } catch (e) {
      console.error('snapshot hata (user ' + u.id + '):', e.message);
    }
  }
}

// Haftalik kiyas referansi: 7 gun oncesi/oncesindeki en yakin; yoksa en eski snapshot
async function getWeeklyBaseline(userId) {
  const today = localDateStr();
  let r = await db.query(
    `SELECT * FROM portfolio_snapshots
      WHERE user_id=$1 AND snap_date <= ($2::date - INTERVAL '7 days')
      ORDER BY snap_date DESC LIMIT 1`,
    [userId, today]
  );
  if (r.rows.length) return r.rows[0];
  r = await db.query('SELECT * FROM portfolio_snapshots WHERE user_id=$1 ORDER BY snap_date ASC LIMIT 1', [userId]);
  return r.rows[0] || null;
}

function deltaStr(cur, prev) {
  const d = cur - Number(prev);
  const pct = Number(prev) > 0 ? (d / Number(prev)) * 100 : null;
  if (pct == null) return '';
  const up = d >= 0;
  return ` ${up ? '🟢' : '🔴'} ${up ? '+' : '-'}%${Math.abs(pct).toFixed(2)}`;
}

// Haftalik ozet metni. Yeterli gecmis yoksa null doner.
async function buildWeeklySummaryText(userId) {
  const base = await getWeeklyBaseline(userId);
  if (!base) return null;
  const today = localDateStr();
  const days = Math.round((new Date(today) - new Date(base.snap_date)) / 86400000);
  if (days < 1) return null; // bugunden baska veri yok
  const g = await computeGenelTotals(userId);
  const periodLabel = days >= 7 ? 'Bu hafta' : `Son ${days} gün`;
  const totalDelta = g.total - Number(base.total_try);
  const totalSign = totalDelta >= 0 ? '+' : '-';
  return [
    `📅 <b>Haftalık Özet</b> — ${new Date(today).toLocaleDateString('tr-TR')}`,
    `<i>${periodLabel} (${new Date(base.snap_date).toLocaleDateString('tr-TR')} → bugün)</i>`,
    '',
    `🏦 BIST: <b>${tlFmt(g.bist)}</b>${deltaStr(g.bist, base.bist)}`,
    `🇺🇸 ABD: <b>${tlFmt(g.us)}</b>${deltaStr(g.us, base.us)}`,
    `🥇 Maden: <b>${tlFmt(g.metal)}</b>${deltaStr(g.metal, base.metal)}`,
    `💱 Döviz: <b>${tlFmt(g.curr)}</b>${deltaStr(g.curr, base.currency)}`,
    `🪙 Kripto: <b>${tlFmt(g.crypto)}</b>${deltaStr(g.crypto, base.crypto)}`,
    `🟣 Fon: <b>${g.fund ? tlFmt(g.fund) : '—'}</b>${g.fund ? deltaStr(g.fund, base.fund || 0) : ''}`,
    `💵 Nakit: <b>${tlFmt(g.cashTRY)}</b>${deltaStr(g.cashTRY, base.cash)}`,
    `🟡 Binance: <b>${g.binance ? tlFmt(g.binance) : '—'}</b>${g.binance ? deltaStr(g.binance, base.binance) : ''}`,
    '━━━━━━━━━━',
    `💰 <b>Toplam Bütçe: ${tlFmt(g.total)}</b>${deltaStr(g.total, base.total_try)}`,
    `   Δ ${totalSign}${tlFmt(Math.abs(totalDelta))}`,
  ].join('\n');
}

// Aylik kiyas referansi: icinde bulunulan aydan ONCEKI son snapshot;
// yoksa (ilk ay) en eski snapshot.
async function getMonthlyBaseline(userId) {
  const today = localDateStr();
  let r = await db.query(
    `SELECT * FROM portfolio_snapshots
      WHERE user_id=$1 AND snap_date < date_trunc('month', $2::date)
      ORDER BY snap_date DESC LIMIT 1`,
    [userId, today]
  );
  if (r.rows.length) return r.rows[0];
  r = await db.query('SELECT * FROM portfolio_snapshots WHERE user_id=$1 ORDER BY snap_date ASC LIMIT 1', [userId]);
  return r.rows[0] || null;
}

// Aylik ozet metni. Yeterli gecmis yoksa null doner.
async function buildMonthlySummaryText(userId) {
  const base = await getMonthlyBaseline(userId);
  if (!base) return null;
  const today = localDateStr();
  if (base.snap_date >= today) return null; // kiyaslanacak gecmis yok
  const g = await computeGenelTotals(userId);
  const monthLabel = new Date(today).toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });

  // En iyi / en kotu varlik: ay basindan bugune yuzdesel degisim (baz > 0 olan siniflar)
  const classes = [
    { name: 'BIST', emoji: '🏦', cur: g.bist, prev: Number(base.bist) },
    { name: 'ABD', emoji: '🇺🇸', cur: g.us, prev: Number(base.us) },
    { name: 'Maden', emoji: '🥇', cur: g.metal, prev: Number(base.metal) },
    { name: 'Döviz', emoji: '💱', cur: g.curr, prev: Number(base.currency) },
    { name: 'Kripto', emoji: '🪙', cur: g.crypto, prev: Number(base.crypto) },
    { name: 'Fon', emoji: '🟣', cur: g.fund, prev: Number(base.fund) },
    { name: 'Binance', emoji: '🟡', cur: g.binance, prev: Number(base.binance) },
  ]
    .filter((c) => c.prev > 0)
    .map((c) => ({ ...c, pct: ((c.cur - c.prev) / c.prev) * 100 }));
  classes.sort((a, b) => b.pct - a.pct);
  const best = classes[0];
  const worst = classes.length > 1 ? classes[classes.length - 1] : null;
  const pctTxt = (p) => `${p >= 0 ? '+' : '-'}%${Math.abs(p).toFixed(2)}`;

  // Bu ayin temettuleri: BIST (TL) + ABD (USD)
  const divTl = Number(
    (
      await db.query(
        `SELECT COALESCE(SUM(amount),0) v FROM cash_movements
          WHERE user_id=$1 AND kind='dividend'
            AND move_date >= date_trunc('month', $2::date) AND move_date <= $2`,
        [userId, today]
      )
    ).rows[0].v
  );
  const divUsd = Number(
    (
      await db.query(
        `SELECT COALESCE(SUM(amount),0) v FROM us_cash_movements
          WHERE user_id=$1 AND kind='dividend'
            AND move_date >= date_trunc('month', $2::date) AND move_date <= $2`,
        [userId, today]
      )
    ).rows[0].v
  );
  const divParts = [];
  if (divTl > 0) divParts.push(tlFmt(divTl));
  if (divUsd > 0) divParts.push(`$${divUsd.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}`);
  const divTxt = divParts.length ? divParts.join(' + ') : 'yok';

  const totalDelta = g.total - Number(base.total_try);
  const totalSign = totalDelta >= 0 ? '+' : '-';
  return [
    `🗓 <b>Aylık Özet — ${monthLabel}</b>`,
    `<i>${new Date(base.snap_date).toLocaleDateString('tr-TR')} → ${new Date(today).toLocaleDateString('tr-TR')}</i>`,
    '',
    `🏦 BIST: <b>${tlFmt(g.bist)}</b>${deltaStr(g.bist, base.bist)}`,
    `🇺🇸 ABD: <b>${tlFmt(g.us)}</b>${deltaStr(g.us, base.us)}`,
    `🥇 Maden: <b>${tlFmt(g.metal)}</b>${deltaStr(g.metal, base.metal)}`,
    `💱 Döviz: <b>${tlFmt(g.curr)}</b>${deltaStr(g.curr, base.currency)}`,
    `🪙 Kripto: <b>${tlFmt(g.crypto)}</b>${deltaStr(g.crypto, base.crypto)}`,
    `🟣 Fon: <b>${g.fund ? tlFmt(g.fund) : '—'}</b>${g.fund ? deltaStr(g.fund, base.fund || 0) : ''}`,
    `💵 Nakit: <b>${tlFmt(g.cashTRY)}</b>${deltaStr(g.cashTRY, base.cash)}`,
    `🟡 Binance: <b>${g.binance ? tlFmt(g.binance) : '—'}</b>${g.binance ? deltaStr(g.binance, base.binance) : ''}`,
    '━━━━━━━━━━',
    `💰 <b>Toplam Bütçe: ${tlFmt(g.total)}</b>${deltaStr(g.total, base.total_try)}`,
    `   Δ ${totalSign}${tlFmt(Math.abs(totalDelta))}`,
    '',
    best ? `🏆 En iyi: <b>${best.emoji} ${best.name}</b> (${pctTxt(best.pct)})` : null,
    worst ? `🐢 En kötü: <b>${worst.emoji} ${worst.name}</b> (${pctTxt(worst.pct)})` : null,
    `💰 Bu ay temettü: <b>${divTxt}</b>`,
  ]
    .filter((x) => x !== null)
    .join('\n');
}

// Genel zaman grafigi icin snapshot serisi
app.get('/api/snapshots', requireAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT snap_date, total_try, bist, us, metal, currency, crypto, cash, binance, fund
         FROM portfolio_snapshots WHERE user_id=$1 ORDER BY snap_date ASC`,
      [req.session.userId]
    );
    res.json(
      r.rows.map((x) => ({
        date: x.snap_date,
        total: Number(x.total_try),
        bist: Number(x.bist),
        us: Number(x.us),
        metal: Number(x.metal),
        currency: Number(x.currency),
        crypto: Number(x.crypto),
        cash: Number(x.cash),
        binance: Number(x.binance),
        fund: Number(x.fund),
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Alinamadi' });
  }
});

// ---- Genel% : varlik sinifi bazinda K/Z yuzdesi zaman serisi ----
// Snapshot'lar yalniz DEGER tutar; maliyet o gune kadarki alimlardan turetilir.
// Boylece "ayin 1'inde para ekleyince grafik sicriyor" sorunu ortadan kalkar:
// meblag yerine portfoyun toplam getiri yuzdesi izlenir.
// Yuzdeler Genel sekmesindeki kart yuzdeleriyle ayni bazda hesaplanir
// (ABD/Kripto USD bazli, digerleri TL; Toplam ise TL bazinda agregasyon).
function cumWalker(rows) {
  // rows: [{d, v}] tarihe gore ARTAN. Donen fonksiyon ARTAN tarihlerle cagrilmali.
  const list = rows.map((r) => ({ date: String(r.d).slice(0, 10), v: Number(r.v) || 0 }));
  let i = 0, acc = 0;
  return (date) => {
    while (i < list.length && list[i].date <= date) acc += list[i++].v;
    return acc;
  };
}

app.get('/api/snapshots/pct', requireAuth, async (req, res) => {
  const uid = req.session.userId;
  const byDate = (sql) => db.query(sql, [uid]).then((r) => r.rows);
  try {
    const [snaps, bistBuy, bistDiv, bistIn, usUsd, usTry, metalBuy, currBuy, cryptoUsd, fundBuy] = await Promise.all([
      db.query(
        `SELECT snap_date, bist, us, metal, currency, crypto, fund, usd_rate
           FROM portfolio_snapshots WHERE user_id=$1 ORDER BY snap_date ASC`,
        [uid]
      ).then((r) => r.rows),
      byDate(`SELECT trade_date d, SUM(total) v FROM purchases WHERE user_id=$1 GROUP BY trade_date ORDER BY trade_date`),
      // temettu (hisse bazli) maliyeti dusurur — portfolio.currentPortfolio ile ayni mantik
      byDate(`SELECT move_date d, SUM(amount) v FROM cash_movements
               WHERE user_id=$1 AND kind='dividend' AND symbol IS NOT NULL GROUP BY move_date ORDER BY move_date`),
      byDate(`SELECT move_date d, SUM(amount) v FROM cash_movements WHERE user_id=$1 GROUP BY move_date ORDER BY move_date`),
      byDate(`SELECT trade_date d, SUM(total) v FROM us_purchases WHERE user_id=$1 GROUP BY trade_date ORDER BY trade_date`),
      byDate(`SELECT trade_date d, SUM(total * COALESCE(usdtry,0)) v FROM us_purchases WHERE user_id=$1 GROUP BY trade_date ORDER BY trade_date`),
      byDate(`SELECT trade_date d, SUM(total) v FROM metal_purchases WHERE user_id=$1 GROUP BY trade_date ORDER BY trade_date`),
      byDate(`SELECT trade_date d, SUM(total) v FROM currency_purchases WHERE user_id=$1 GROUP BY trade_date ORDER BY trade_date`),
      byDate(`SELECT trade_date d, SUM(total) v FROM crypto_purchases WHERE user_id=$1 GROUP BY trade_date ORDER BY trade_date`),
      byDate(`SELECT trade_date d, SUM(total) v FROM fund_purchases WHERE user_id=$1 GROUP BY trade_date ORDER BY trade_date`),
    ]);

    const wBistBuy = cumWalker(bistBuy), wBistDiv = cumWalker(bistDiv), wBistIn = cumWalker(bistIn);
    const wUsUsd = cumWalker(usUsd), wUsTry = cumWalker(usTry);
    const wMetal = cumWalker(metalBuy), wCurr = cumWalker(currBuy);
    const wCrypto = cumWalker(cryptoUsd), wFund = cumWalker(fundBuy);

    // Deger 0 ise "o gun bu sinif kayitli degil" demektir; -%100 gostermemek icin atlanir
    const pct = (value, cost) => (cost > 0 && value > 0 ? ((value - cost) / cost) * 100 : null);

    const out = snaps.map((s) => {
      const date = String(s.snap_date).slice(0, 10);
      const rate = Number(s.usd_rate) > 0 ? Number(s.usd_rate) : null;

      // BIST snapshot'i nakit DAHIL tutar; yuzde icin nakit cikarilir
      const bistBought = wBistBuy(date);
      const bistCash = wBistIn(date) - bistBought;
      const bistVal = Number(s.bist) - bistCash;
      const bistCost = bistBought - wBistDiv(date);

      const usCostUsd = wUsUsd(date), usCostTry = wUsTry(date);
      const usVal = Number(s.us);
      const usValUsd = rate ? usVal / rate : 0;

      const metalVal = Number(s.metal), metalCost = wMetal(date);
      const currVal = Number(s.currency), currCost = wCurr(date);
      const cryptoVal = Number(s.crypto), cryptoCostUsd = wCrypto(date);
      const cryptoValUsd = rate ? cryptoVal / rate : 0;
      const cryptoCostTry = rate ? cryptoCostUsd * rate : 0;
      const fundVal = Number(s.fund), fundCost = wFund(date);

      // Toplam: TL bazinda agregasyon (Genel sekmesindeki addAgg ile ayni)
      let aggProfit = 0, aggCost = 0, aggValue = 0;
      const addAgg = (v, c) => { if (v > 0 && c > 0) { aggProfit += v - c; aggCost += c; aggValue += v; } };
      addAgg(bistVal, bistCost);
      addAgg(usVal, usCostTry);
      addAgg(metalVal, metalCost);
      addAgg(currVal, currCost);
      addAgg(cryptoVal, cryptoCostTry);
      addAgg(fundVal, fundCost);

      return {
        date,
        bist: pct(bistVal, bistCost),
        us: pct(usValUsd, usCostUsd),
        metal: pct(metalVal, metalCost),
        currency: pct(currVal, currCost),
        crypto: pct(cryptoValUsd, cryptoCostUsd),
        fund: pct(fundVal, fundCost),
        total: aggCost > 0 ? (aggProfit / aggCost) * 100 : null,
        totalValue: aggCost > 0 ? aggValue : null,
      };
    });
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Alinamadi' });
  }
});

// ===================== CSV DISA AKTARMA =====================
// UTF-8 BOM + ';' ayirici + ondalik NOKTA + GG.AA.YYYY tarih.
// (Kullanicinin Excel'i: ondalik nokta, kolon ayirici ';'.)
function csvDate(d) {
  // DATE kolonlari type parser sayesinde 'YYYY-MM-DD' string gelir
  const s = String(d).slice(0, 10);
  const [y, m, day] = s.split('-');
  return `${day}.${m}.${y}`;
}
function csvNum(v) {
  if (v === null || v === undefined || v === '') return '';
  return String(Number(v));
}
function csvSend(res, filename, header, rows) {
  const esc = (x) => {
    const s = x === null || x === undefined ? '' : String(x);
    return /[,;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [header.join(';')].concat(rows.map((r) => r.map(esc).join(';')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + lines.join('\r\n')); // BOM: Excel'in UTF-8'i tanimasi icin
}

const METAL_TR = { gold: 'Altın', silver: 'Gümüş' };

app.get('/api/export/:kind.csv', requireAuth, async (req, res) => {
  const uid = req.session.userId;
  const kind = req.params.kind;
  try {
    if (kind === 'bist') {
      const r = await db.query(
        `SELECT trade_date, symbol, quantity, price, commission_rate, bsmv_rate, total, source, usd_rate
           FROM purchases WHERE user_id=$1 ORDER BY trade_date, id`, [uid]);
      return csvSend(res, 'bist-alimlar.csv',
        ['Tarih', 'Hisse', 'Adet', 'Fiyat (TL)', 'Komisyon %', 'BSMV %', 'Toplam (TL)', 'Kaynak', 'USD Kuru'],
        r.rows.map((x) => [csvDate(x.trade_date), x.symbol, csvNum(x.quantity), csvNum(x.price),
          csvNum(x.commission_rate), csvNum(x.bsmv_rate), csvNum(x.total), x.source, csvNum(x.usd_rate)]));
    }
    if (kind === 'us') {
      const r = await db.query(
        `SELECT trade_date, symbol, quantity, price, commission, total, usdtry, source
           FROM us_purchases WHERE user_id=$1 ORDER BY trade_date, id`, [uid]);
      return csvSend(res, 'abd-alimlar.csv',
        ['Tarih', 'Hisse', 'Adet', 'Fiyat ($)', 'Komisyon ($)', 'Toplam ($)', 'USD/TRY', 'Kaynak'],
        r.rows.map((x) => [csvDate(x.trade_date), x.symbol, csvNum(x.quantity), csvNum(x.price),
          csvNum(x.commission), csvNum(x.total), csvNum(x.usdtry), x.source]));
    }
    if (kind === 'metal') {
      const r = await db.query(
        `SELECT trade_date, metal, quantity, price, total FROM metal_purchases
          WHERE user_id=$1 ORDER BY trade_date, id`, [uid]);
      return csvSend(res, 'maden-alimlar.csv',
        ['Tarih', 'Maden', 'Gram', 'Fiyat (TL/gr)', 'Toplam (TL)'],
        r.rows.map((x) => [csvDate(x.trade_date), METAL_TR[x.metal] || x.metal, csvNum(x.quantity), csvNum(x.price), csvNum(x.total)]));
    }
    if (kind === 'currency') {
      const r = await db.query(
        `SELECT trade_date, currency, quantity, price, total FROM currency_purchases
          WHERE user_id=$1 ORDER BY trade_date, id`, [uid]);
      return csvSend(res, 'doviz-alimlar.csv',
        ['Tarih', 'Döviz', 'Adet', 'Kur (TL)', 'Toplam (TL)'],
        r.rows.map((x) => [csvDate(x.trade_date), String(x.currency).toUpperCase(), csvNum(x.quantity), csvNum(x.price), csvNum(x.total)]));
    }
    if (kind === 'crypto') {
      const r = await db.query(
        `SELECT trade_date, symbol, quantity, price, total FROM crypto_purchases
          WHERE user_id=$1 ORDER BY trade_date, id`, [uid]);
      return csvSend(res, 'kripto-alimlar.csv',
        ['Tarih', 'Coin', 'Adet', 'Fiyat ($)', 'Toplam ($)'],
        r.rows.map((x) => [csvDate(x.trade_date), x.symbol, csvNum(x.quantity), csvNum(x.price), csvNum(x.total)]));
    }
    if (kind === 'funds') {
      const r = await db.query(
        `SELECT trade_date, code, quantity, price, total FROM fund_purchases
          WHERE user_id=$1 ORDER BY trade_date, id`, [uid]);
      return csvSend(res, 'fon-alimlar.csv',
        ['Tarih', 'Fon', 'Pay', 'Fiyat (TL)', 'Toplam (TL)'],
        r.rows.map((x) => [csvDate(x.trade_date), x.code, csvNum(x.quantity), csvNum(x.price), csvNum(x.total)]));
    }
    if (kind === 'snapshots') {
      const r = await db.query(
        `SELECT snap_date, total_try, bist, us, metal, currency, crypto, cash, binance, fund, usd_rate
           FROM portfolio_snapshots WHERE user_id=$1 ORDER BY snap_date`, [uid]);
      return csvSend(res, 'snapshot-serisi.csv',
        ['Tarih', 'Toplam (TL)', 'BIST', 'ABD', 'Maden', 'Döviz', 'Kripto', 'Nakit', 'Binance', 'Fon', 'USD Kuru'],
        r.rows.map((x) => [csvDate(x.snap_date), csvNum(x.total_try), csvNum(x.bist), csvNum(x.us),
          csvNum(x.metal), csvNum(x.currency), csvNum(x.crypto), csvNum(x.cash), csvNum(x.binance),
          csvNum(x.fund), csvNum(x.usd_rate)]));
    }
    res.status(404).json({ error: 'Bilinmeyen dışa aktarma türü' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Dışa aktarılamadı' });
  }
});

// ===================== FON (birim pay) + TÜFE =====================
app.get('/api/fund', requireAuth, async (req, res) => {
  try {
    res.json(await fund.computeFund(req.session.userId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fon hesaplanamadı' });
  }
});

app.get('/api/tufe', requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT ym, rate FROM tufe ORDER BY ym');
    res.json(r.rows.map((x) => ({ ym: x.ym, rate: Number(x.rate) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alınamadı' });
  }
});

app.put('/api/tufe', requireAuth, async (req, res) => {
  const { ym, rate } = req.body || {};
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: 'Ay YYYY-MM biçiminde olmalı' });
  const v = Number(rate);
  if (!Number.isFinite(v) || v <= -100) return res.status(400).json({ error: 'Geçerli bir aylık enflasyon oranı (%) girin' });
  try {
    await db.query(
      `INSERT INTO tufe (ym, rate, updated_at) VALUES ($1,$2, now())
       ON CONFLICT (ym) DO UPDATE SET rate=EXCLUDED.rate, updated_at=now()`,
      [ym, v]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Kaydedilemedi' });
  }
});

app.delete('/api/tufe/:ym', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM tufe WHERE ym=$1', [req.params.ym]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Silinemedi' });
  }
});

// ===================== BAŞARIMLAR (achievements) =====================
async function buildAchvContext(userId) {
  const g = await computeGenelTotals(userId);
  const cr = (
    await db.query(
      `SELECT
         (SELECT COUNT(*) FROM purchases WHERE user_id=$1) bist,
         (SELECT COUNT(*) FROM us_purchases WHERE user_id=$1) us,
         (SELECT COUNT(*) FROM metal_purchases WHERE user_id=$1) metal,
         (SELECT COUNT(*) FROM currency_purchases WHERE user_id=$1) currency,
         (SELECT COUNT(*) FROM crypto_purchases WHERE user_id=$1) crypto,
         (SELECT COUNT(*) FROM cash_movements WHERE user_id=$1 AND kind='dividend') bist_div,
         (SELECT COUNT(*) FROM us_cash_movements WHERE user_id=$1 AND kind='dividend') us_div,
         (SELECT COUNT(*) FROM binance_keys WHERE user_id=$1) binance,
         (SELECT COUNT(*) FROM telegram_settings WHERE user_id=$1) telegram`,
      [userId]
    )
  ).rows[0];
  const yest = await db.query(
    'SELECT total_try FROM portfolio_snapshots WHERE user_id=$1 AND snap_date < $2 ORDER BY snap_date DESC LIMIT 1',
    [userId, localDateStr()]
  );
  const prev = yest.rows.length ? Number(yest.rows[0].total_try) : null;
  const dailyChangePct = prev && prev > 0 ? ((g.total - prev) / prev) * 100 : null;
  return {
    totalTRY: g.total,
    totalUSD: g.usdRate ? g.total / g.usdRate : null,
    bistCount: Number(cr.bist),
    usCount: Number(cr.us),
    metalCount: Number(cr.metal),
    currencyCount: Number(cr.currency),
    cryptoCount: Number(cr.crypto),
    purchaseCount: Number(cr.bist) + Number(cr.us) + Number(cr.metal) + Number(cr.currency) + Number(cr.crypto),
    hasDividend: Number(cr.bist_div) + Number(cr.us_div) > 0,
    hasBinance: Number(cr.binance) > 0,
    hasTelegram: Number(cr.telegram) > 0,
    dailyChangePct,
  };
}

async function getAchievements(userId) {
  const ctx = await buildAchvContext(userId);
  const unlockedRows = (await db.query('SELECT achievement_key, unlocked_at FROM user_achievements WHERE user_id=$1', [userId])).rows;
  const unlockedMap = new Map(unlockedRows.map((r) => [r.achievement_key, r.unlocked_at]));
  const newly = [];
  for (const def of achievements.DEFS) {
    if (def.check(ctx) && !unlockedMap.has(def.key)) {
      await db.query('INSERT INTO user_achievements (user_id, achievement_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, def.key]);
      unlockedMap.set(def.key, new Date().toISOString());
      newly.push(def.key);
    }
  }
  let points = 0;
  const list = achievements.DEFS.map((def) => {
    const unlocked = unlockedMap.has(def.key);
    if (unlocked) points += def.points;
    let progress = null;
    if (def.progress) {
      const p = def.progress(ctx);
      progress = { current: p.current, target: p.target, usd: !!p.usd, pct: Math.max(0, Math.min(100, p.target > 0 ? (p.current / p.target) * 100 : 0)) };
    }
    return {
      key: def.key, cat: def.cat, title: def.title, desc: def.desc, icon: def.icon,
      tier: def.tier, points: def.points, unlocked,
      unlockedAt: unlocked ? unlockedMap.get(def.key) : null,
      progress, newly: newly.includes(def.key),
    };
  });
  return {
    list,
    points,
    totalPointsPossible: achievements.TOTAL_POINTS,
    unlockedCount: list.filter((x) => x.unlocked).length,
    totalCount: achievements.DEFS.length,
    level: achievements.levelFor(points),
  };
}

app.get('/api/achievements', requireAuth, async (req, res) => {
  try {
    res.json(await getAchievements(req.session.userId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Alinamadi' });
  }
});

app.get('/api/telegram', requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT chat_id, weekly_chat_id, monthly_chat_id FROM telegram_settings WHERE user_id=$1', [req.session.userId]);
    res.json({
      chatId: (r.rows[0] && r.rows[0].chat_id) || '',
      weeklyChatId: (r.rows[0] && r.rows[0].weekly_chat_id) || '',
      monthlyChatId: (r.rows[0] && r.rows[0].monthly_chat_id) || '',
      botConfigured: telegram.configured(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Alinamadi' });
  }
});

app.put('/api/telegram', requireAuth, async (req, res) => {
  const chatId = ((req.body && req.body.chatId) || '').trim();
  const weeklyChatId = ((req.body && req.body.weeklyChatId) || '').trim();
  const monthlyChatId = ((req.body && req.body.monthlyChatId) || '').trim();
  try {
    if (!chatId) {
      await db.query('DELETE FROM telegram_settings WHERE user_id=$1', [req.session.userId]);
      return res.json({ ok: true, removed: true });
    }
    await db.query(
      `INSERT INTO telegram_settings (user_id, chat_id, weekly_chat_id, monthly_chat_id, updated_at) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (user_id) DO UPDATE SET chat_id=EXCLUDED.chat_id, weekly_chat_id=EXCLUDED.weekly_chat_id,
         monthly_chat_id=EXCLUDED.monthly_chat_id, updated_at=now()`,
      [req.session.userId, chatId, weeklyChatId || null, monthlyChatId || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Kaydedilemedi' });
  }
});

app.post('/api/telegram/test', requireAuth, async (req, res) => {
  const chatId = ((req.body && req.body.chatId) || '').trim();
  if (!chatId) return res.status(400).json({ error: 'chat_id gerekli' });
  if (!telegram.configured()) return res.status(400).json({ error: 'Sunucuda BOT_TOKEN tanımlı değil' });
  const r = await telegram.send(chatId, '✅ <b>Test mesajı</b>\nPortföy Takip bildirimleri çalışıyor. Her gün 21:00 özet gelecek.');
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true });
});

// Kullanici isterse o anda portfoy ozetini gonder
app.post('/api/telegram/send-now', requireAuth, async (req, res) => {
  if (!telegram.configured()) return res.status(400).json({ error: 'Sunucuda BOT_TOKEN tanımlı değil' });
  // istekte chat_id verilmemisse kayitliyi kullan
  let chatId = ((req.body && req.body.chatId) || '').trim();
  if (!chatId) {
    const row = (await db.query('SELECT chat_id FROM telegram_settings WHERE user_id=$1', [req.session.userId])).rows[0];
    chatId = row && row.chat_id ? row.chat_id : '';
  }
  if (!chatId) return res.status(400).json({ error: 'Önce chat_id girin' });
  try {
    const text = await buildDailySummaryText(req.session.userId);
    const r = await telegram.send(chatId, text);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Özet gönderilemedi' });
  }
});

// Kullanici isterse o anda haftalik ozeti gonder (yeterli gecmis yoksa uyarir)
app.post('/api/telegram/send-weekly-now', requireAuth, async (req, res) => {
  if (!telegram.configured()) return res.status(400).json({ error: 'Sunucuda BOT_TOKEN tanımlı değil' });
  let chatId = ((req.body && req.body.chatId) || '').trim();
  if (!chatId) {
    const row = (await db.query('SELECT chat_id, weekly_chat_id FROM telegram_settings WHERE user_id=$1', [req.session.userId])).rows[0];
    chatId = row ? (row.weekly_chat_id || row.chat_id || '') : '';
  }
  if (!chatId) return res.status(400).json({ error: 'Önce chat_id girin' });
  try {
    const text = await buildWeeklySummaryText(req.session.userId);
    if (!text) return res.status(400).json({ error: 'Haftalık kıyas için yeterli geçmiş yok (en az 1 günlük snapshot gerekir; her gün birikir).' });
    const r = await telegram.send(chatId, text);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Özet gönderilemedi' });
  }
});

// Kullanici isterse o anda aylik ozeti gonder (yeterli gecmis yoksa uyarir)
app.post('/api/telegram/send-monthly-now', requireAuth, async (req, res) => {
  if (!telegram.configured()) return res.status(400).json({ error: 'Sunucuda BOT_TOKEN tanımlı değil' });
  let chatId = ((req.body && req.body.chatId) || '').trim();
  if (!chatId) {
    const row = (await db.query('SELECT chat_id, monthly_chat_id FROM telegram_settings WHERE user_id=$1', [req.session.userId])).rows[0];
    chatId = row ? (row.monthly_chat_id || row.chat_id || '') : '';
  }
  if (!chatId) return res.status(400).json({ error: 'Önce chat_id girin' });
  try {
    const text = await buildMonthlySummaryText(req.session.userId);
    if (!text) return res.status(400).json({ error: 'Aylık kıyas için yeterli geçmiş yok (en az 1 günlük snapshot gerekir; her gün birikir).' });
    const r = await telegram.send(chatId, text);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Özet gönderilemedi' });
  }
});

// ---- Fon fiyati aciklaninca Telegram bildirimi ----
// Servis TEFAS fiyatini fund_prices'a yazdiginda (price > 0) gunluk raporun
// gittigi kanala fiyat + degisim duser. Fiyat gelmediyse (price = 0) mesaj
// atilmaz; servis fiyat gelene kadar tekrar denedigi icin geldigi an tetiklenir.
// Ayni fon icin gunde bir kez gonderilir (app_state'te kalici bayrak).
const fundPriceFmt = (n) =>
  new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 6, maximumFractionDigits: 6 }).format(Number(n) || 0);

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Onceki fiyat kaynagi: en son DUYURULAN fiyat (app_state'te 'gun|fiyat').
// price_old'a guvenilmiyor — servis onu guncel fiyatin kopyasi olarak da
// yazabiliyor; yalnizca elde kayit yokken ve price'tan FARKLIYSA kullanilir.
const FUND_PREV_KEY = (code) => `fund_prev_price:${code}`;

async function fundPrevPrice(row, today) {
  const raw = await getAppState(FUND_PREV_KEY(row.code));
  if (raw) {
    const [day, val] = String(raw).split('|');
    const v = Number(val);
    if (day && day < today && v > 0) return v; // onceki gunun duyurulan fiyati
    if (day === today) return null; // bugun zaten kaydedildi -> kiyas yapma
  }
  const old = Number(row.price_old);
  return old > 0 && old !== Number(row.price) ? old : null;
}

// rows: [{code, title, price, prev}] — prev null ise degisim satiri yazilmaz
function buildFundPriceText(rows, dateStr) {
  const [y, m, d] = dateStr.split('-');
  const lines = [`🧺 <b>Fon Fiyatları Açıklandı</b> — ${d}.${m}.${y}`, ''];
  rows.forEach((r) => {
    const price = Number(r.price);
    const prev = Number(r.prev);
    lines.push(`🟣 <b>${escHtml(r.code)}</b>${r.title ? ' — ' + escHtml(r.title) : ''}`);
    if (prev > 0) {
      const diff = price - prev;
      const pct = (diff / prev) * 100;
      const up = diff >= 0;
      lines.push(
        `   <b>₺${fundPriceFmt(price)}</b> ${up ? '🟢' : '🔴'} ${up ? '+' : '-'}%${Math.abs(pct).toFixed(2)}` +
          ` (önceki ₺${fundPriceFmt(prev)})`
      );
    } else {
      lines.push(`   <b>₺${fundPriceFmt(price)}</b>`);
    }
  });
  return lines.join('\n');
}

// Kullanicinin sahip oldugu fonlardan BUGUN fiyati aciklananlar (price > 0).
// updated_at kontrolu: hafta sonu duran eski fiyat yeniden duyurulmasin.
async function todaysFundPrices(userId, today) {
  const r = await db.query(
    `SELECT fp.code, fp.title, fp.price, fp.price_old, fp.updated_at
       FROM fund_prices fp
      WHERE fp.price > 0
        AND EXISTS (SELECT 1 FROM fund_purchases p WHERE p.user_id=$1 AND p.code=fp.code)
      ORDER BY fp.code`,
    [userId]
  );
  return r.rows.filter((x) => localDateStr(new Date(x.updated_at)) === today);
}

async function announceFundPrices() {
  if (!telegram.configured()) return;
  const today = localDateStr();
  let rows;
  try {
    rows = (await db.query('SELECT user_id, chat_id FROM telegram_settings')).rows;
  } catch (_) {
    return;
  }
  // Fiyat tum kullanicilar icin ortak: onceki fiyat bir kez cozulur, bugunku
  // fiyat da tur sonunda bir kez kaydedilir (ikinci kullanicinin mesaji da
  // dogru kiyasi gorsun diye tur ortasinda uzerine yazilmaz).
  const prevCache = new Map();
  const toStore = new Map();
  for (const row of rows) {
    if (!row.chat_id) continue;
    try {
      const priced = await todaysFundPrices(row.user_id, today);
      const fresh = [];
      for (const p of priced) {
        const key = `fund_msg:${row.user_id}:${p.code}`;
        if ((await getAppState(key)) === today) continue; // bu fon bugun gonderildi
        if (!prevCache.has(p.code)) prevCache.set(p.code, await fundPrevPrice(p, today));
        fresh.push({ p: { ...p, prev: prevCache.get(p.code) }, key });
      }
      if (!fresh.length) continue;
      const sent = await telegram.send(row.chat_id, buildFundPriceText(fresh.map((f) => f.p), today));
      if (!sent.ok) {
        console.error('Telegram fon fiyat mesaji hatasi:', sent.error);
        continue; // bayragi isaretleme; sonraki tetikte tekrar denenir
      }
      for (const f of fresh) {
        await setAppState(f.key, today);
        toStore.set(f.p.code, Number(f.p.price));
      }
      console.log(`Fon fiyat bildirimi gonderildi (user ${row.user_id}): ${fresh.map((f) => f.p.code).join(', ')}`);
    } catch (e) {
      console.error('Fon fiyat bildirimi hatasi (user ' + row.user_id + '):', e.message);
    }
  }
  // Duyurulan fiyatlari "onceki fiyat" olarak sakla (yarinki kiyasin tabani)
  for (const [code, price] of toStore) {
    await setAppState(FUND_PREV_KEY(code), `${today}|${price}`);
  }
}

// Servis fiyatlari toplu yazabildiginden bildirimi kisa sure biriktirip
// tek mesajda gonder (her fon icin ayri mesaj atilmasin).
let fundAnnounceTimer = null;
function scheduleFundPriceAnnounce() {
  clearTimeout(fundAnnounceTimer);
  fundAnnounceTimer = setTimeout(() => {
    announceFundPrices().catch((e) => console.error('Fon fiyat bildirimi hatasi:', e.message));
  }, 10000);
}

// Kullanici isterse o anda bugunku fon fiyatlarini gonder (gunluk bayragi degistirmez)
app.post('/api/telegram/send-fund-now', requireAuth, async (req, res) => {
  if (!telegram.configured()) return res.status(400).json({ error: 'Sunucuda BOT_TOKEN tanımlı değil' });
  let chatId = ((req.body && req.body.chatId) || '').trim();
  if (!chatId) {
    const row = (await db.query('SELECT chat_id FROM telegram_settings WHERE user_id=$1', [req.session.userId])).rows[0];
    chatId = row && row.chat_id ? row.chat_id : '';
  }
  if (!chatId) return res.status(400).json({ error: 'Önce chat_id girin' });
  try {
    const today = localDateStr();
    const priced = await todaysFundPrices(req.session.userId, today);
    if (!priced.length) return res.status(400).json({ error: 'Bugün fiyatı açıklanan fonunuz yok (fiyat gelince otomatik gönderilir).' });
    // Onizleme/test: gunluk bayraklari ve "onceki fiyat" kaydini degistirmez
    const withPrev = [];
    for (const p of priced) withPrev.push({ ...p, prev: await fundPrevPrice(p, today) });
    const r = await telegram.send(chatId, buildFundPriceText(withPrev, today));
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true, count: priced.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fon fiyatları gönderilemedi' });
  }
});

// Gunluk ozet zamanlayicisi (DAILY_SUMMARY_HOUR; varsayilan 21:00 sunucu yerel saati)
const SUMMARY_HOUR = Number(process.env.DAILY_SUMMARY_HOUR || 21);
// Haftalik ozet gunu (0=Pazar ... 6=Cumartesi); varsayilan 1 = Pazartesi
const WEEKLY_DAY = Number(process.env.WEEKLY_SUMMARY_DAY || 1);

async function sendDailySummaries() {
  if (!telegram.configured()) return;
  let rows;
  try {
    rows = (await db.query('SELECT user_id, chat_id FROM telegram_settings')).rows;
  } catch (_) {
    return;
  }
  for (const row of rows) {
    if (!row.chat_id) continue; // chat_id yoksa gonderme
    try {
      const text = await buildDailySummaryText(row.user_id);
      await telegram.send(row.chat_id, text);
    } catch (e) {
      console.error('Telegram gunluk ozet hatasi:', e.message);
    }
  }
}

async function sendWeeklySummaries() {
  if (!telegram.configured()) return;
  let rows;
  try {
    rows = (await db.query('SELECT user_id, chat_id, weekly_chat_id FROM telegram_settings')).rows;
  } catch (_) {
    return;
  }
  for (const row of rows) {
    // Haftalik rapor: ayri chat id varsa oraya, yoksa ana chat_id'ye
    const target = row.weekly_chat_id || row.chat_id;
    if (!target) continue;
    try {
      const text = await buildWeeklySummaryText(row.user_id);
      if (text) await telegram.send(target, text);
    } catch (e) {
      console.error('Telegram haftalik ozet hatasi:', e.message);
    }
  }
}

async function sendMonthlySummaries() {
  if (!telegram.configured()) return;
  let rows;
  try {
    rows = (await db.query('SELECT user_id, chat_id, monthly_chat_id FROM telegram_settings')).rows;
  } catch (_) {
    return;
  }
  for (const row of rows) {
    // Aylik rapor: ayri chat id varsa oraya, yoksa ana chat_id'ye
    const target = row.monthly_chat_id || row.chat_id;
    if (!target) continue;
    try {
      const text = await buildMonthlySummaryText(row.user_id);
      if (text) await telegram.send(target, text);
    } catch (e) {
      console.error('Telegram aylik ozet hatasi:', e.message);
    }
  }
}

// Kalici durum okuma/yazma (app_state key/value tablosu). Restart sonrasi
// "bugun zaten gonderildi" bilgisi bellekte degil DB'de tutulur.
async function getAppState(key) {
  try {
    const r = await db.query('SELECT value FROM app_state WHERE key=$1', [key]);
    return r.rows[0] ? r.rows[0].value : null;
  } catch (_) {
    return null;
  }
}
async function setAppState(key, value) {
  await db.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1,$2, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [key, value]
  );
}

async function dailyTick() {
  const now = new Date();
  if (now.getHours() !== SUMMARY_HOUR) return;
  const today = localDateStr(now);

  // Gunluk ozet: DB'de tutulan son gonderim gunu bugun ise tekrar gonderme.
  // Boylece saat 21:xx iken sunucu restart olsa bile ikinci kez gitmez.
  if ((await getAppState('last_daily_sent')) !== today) {
    await setAppState('last_daily_sent', today); // once isaretle (yeniden tetiklenmeyi engelle)
    await writeDailySnapshots(); // once tum kullanicilarin snapshot'i (gunluk birikim)
    await sendDailySummaries(); // chat_id'si olanlara gunluk ozet
  }

  // Haftalik ozet: ayri kalici bayrakla, bugun gonderildiyse tekrar etme.
  if (now.getDay() === WEEKLY_DAY && (await getAppState('last_weekly_sent')) !== today) {
    await setAppState('last_weekly_sent', today);
    await sendWeeklySummaries(); // haftalik ozet gunu
  }

  // Aylik ozet: ayin SON gunu, ayda bir kez (kalici bayrak ay bazli 'YYYY-MM').
  const isLastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() === now.getDate();
  const ym = today.slice(0, 7);
  if (isLastDayOfMonth && (await getAppState('last_monthly_sent')) !== ym) {
    await setAppState('last_monthly_sent', ym);
    await sendMonthlySummaries();
  }
}

// ===================== TEFAS FON ALIM route'lari =====================
app.get('/api/funds/summary', requireAuth, async (req, res) => {
  try {
    res.json(await fundsportfolio.summary(req.session.userId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ozet alinamadi' });
  }
});

app.get('/api/funds/holdings-before', requireAuth, async (req, res) => {
  const { code, date } = req.query;
  if (!code || !date) return res.status(400).json({ error: 'code ve date gerekli' });
  try {
    res.json(await fundsportfolio.holdingsBeforeDate(req.session.userId, code, date));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Hesaplanamadi' });
  }
});

app.get('/api/funds/prices', requireAuth, async (req, res) => {
  try {
    res.json(await fundsportfolio.pricesList());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

app.get('/api/funds/purchases', requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM fund_purchases WHERE user_id=$1 ORDER BY trade_date DESC, id DESC', [req.session.userId]);
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Liste alinamadi' });
  }
});

function readFundPurchase(body) {
  const { trade_date, code, quantity, price } = body || {};
  if (!trade_date || !code || !quantity || price === undefined || price === null) return null;
  const c = fundsportfolio.normCode(code);
  if (!c) return { error: 'Fon kodu gerekli' };
  const qty = Number(quantity);
  const prc = Number(price);
  if (!(qty > 0) || !(prc >= 0)) return { error: 'Adet ve fiyat gecerli olmali' };
  const total = Math.round(qty * prc * 10000) / 10000;
  const title = (body.title || '').trim();
  return { trade_date, code: c, qty, prc, total, title };
}

// Yeni fon eklenince fund_prices'a tohumla (servis guncellemeye baslasin)
async function seedFundPrice(code, title) {
  await db.query(
    `INSERT INTO fund_prices (code, title, price, updated_at) VALUES ($1,$2,0, now())
     ON CONFLICT (code) DO UPDATE SET title = COALESCE(NULLIF(EXCLUDED.title,''), fund_prices.title)`,
    [code, title || null]
  );
}

// Hicbir kullanicida alimi kalmayan (yetim) fonlari fiyat tablosundan cikar
// -> servis bosuna fiyat cekmesin
async function cleanupFundPrices() {
  await db.query(
    `DELETE FROM fund_prices fp
      WHERE NOT EXISTS (SELECT 1 FROM fund_purchases p WHERE p.code = fp.code)`
  );
}

app.post('/api/funds/purchases', requireAuth, async (req, res) => {
  const p = readFundPurchase(req.body);
  if (!p) return res.status(400).json({ error: 'Tarih, fon kodu, adet ve fiyat gerekli' });
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const r = await db.query(
      `INSERT INTO fund_purchases (user_id, trade_date, code, quantity, price, total)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.session.userId, p.trade_date, p.code, p.qty, p.prc, p.total]
    );
    await seedFundPrice(p.code, p.title); // servis bu fonu cekmeye baslar
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Alim kaydedilemedi' });
  }
});

app.put('/api/funds/purchases/:id', requireAuth, async (req, res) => {
  const p = readFundPurchase(req.body);
  if (!p) return res.status(400).json({ error: 'Tarih, fon kodu, adet ve fiyat gerekli' });
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const r = await db.query(
      `UPDATE fund_purchases SET trade_date=$1, code=$2, quantity=$3, price=$4, total=$5
        WHERE id=$6 AND user_id=$7 RETURNING *`,
      [p.trade_date, p.code, p.qty, p.prc, p.total, req.params.id, req.session.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Kayit bulunamadi' });
    await seedFundPrice(p.code, p.title);
    await cleanupFundPrices(); // kod degistiyse eski yetim fonu temizle
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Guncellenemedi' });
  }
});

app.delete('/api/funds/purchases/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM fund_purchases WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
    await cleanupFundPrices(); // alimi kalmayan fon fiyat tablosundan cikar
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Silinemedi' });
  }
});

// ---- Statik dosyalar ----
// no-cache: tarayici her seferinde dogrulasin (eski app.js/styles.css takilmasin)
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  })
);

// ---- Baslangic ----
async function ensureDefaultUser() {
  const u = (process.env.DEFAULT_USER || 'admin').trim();
  const p = process.env.DEFAULT_PASSWORD || 'admin123';
  const existing = await db.query('SELECT id, role FROM users WHERE username = $1', [u]);
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash(p, 10);
    const r = await db.query(
      "INSERT INTO users (username, password, role, must_change_password) VALUES ($1,$2,'admin',false) RETURNING id",
      [u, hash]
    );
    await db.query('INSERT INTO password_history (user_id, password) VALUES ($1,$2)', [
      r.rows[0].id,
      hash,
    ]);
    console.log(`Varsayilan admin kullanici olusturuldu: ${u} / ${p}`);
  } else if (existing.rows[0].role !== 'admin') {
    // Mevcut varsayilan kullaniciyi admin yap
    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [existing.rows[0].id]);
    console.log(`Mevcut '${u}' kullanicisi admin yapildi.`);
  }
}

(async () => {
  try {
    await db.init();
    await ensureDefaultUser();
    // Fiyat tablosu degisince (web UI veya Windows servisi) istemcilere bildir
    await db.listen('price_change', (symbol) => {
      broadcast('price_change', { symbol: symbol || null, at: Date.now() });
    });
    // price_history degisince (Windows servisi) portfoy degeri grafigini guncelle
    await db.listen('history_change', () => {
      broadcast('history_change', { at: Date.now() });
    });
    // ABD fiyat veya USD/TRY degisince ABD dashboard'u guncelle
    await db.listen('us_price_change', () => {
      broadcast('us_price_change', { at: Date.now() });
    });
    // Kiymetli maden gram TL fiyati degisince kiymetli maden panosunu guncelle
    await db.listen('metal_price_change', () => {
      broadcast('metal_price_change', { at: Date.now() });
    });
    // Doviz (EUR) kuru degisince doviz panosunu guncelle
    await db.listen('currency_price_change', () => {
      broadcast('currency_price_change', { at: Date.now() });
    });
    // Kripto fiyati degisince kripto panosunu guncelle
    await db.listen('crypto_price_change', () => {
      broadcast('crypto_price_change', { at: Date.now() });
    });
    // TEFAS fon fiyati degisince fon panosunu guncelle + Telegram bildirimi
    await db.listen('fund_price_change', () => {
      broadcast('fund_price_change', { at: Date.now() });
      scheduleFundPriceAnnounce();
    });
    // Sunucu fiyat yazildigi sirada kapaliysa acilista bir kez telafi et
    setTimeout(() => {
      announceFundPrices().catch((e) => console.error('Fon fiyat bildirimi hatasi:', e.message));
    }, 15000);
    // Kacirilan bildirimleri gun icinde telafi et: LISTEN baglantisi koparsa
    // (yeniden baglanana kadar gelen bildirim kaybolur) veya sunucu fiyat
    // yazilirken kapaliysa mesaj yine de gitsin. Gunluk bayrak tekrari onler.
    setInterval(() => {
      announceFundPrices().catch((e) => console.error('Fon fiyat bildirimi hatasi:', e.message));
    }, 5 * 60 * 1000);
    // Binance toplamlarini 5 dakikada bir yenile (sunucu tarafi; secret burada kalir)
    setTimeout(refreshAllBinance, 10000); // baslangictan 10 sn sonra ilk cekim
    setInterval(refreshAllBinance, 5 * 60 * 1000);
    // Gunluk Telegram ozeti + snapshot: her dakika kontrol, saat gelince gunde bir kez
    // (snapshot yalnizca zamani gelince alinir; baslangic snapshot'i alinmaz)
    setInterval(dailyTick, 60 * 1000);
    const gunler = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
    console.log(`Telegram bot ${telegram.configured() ? 'aktif' : 'KAPALI (BOT_TOKEN yok)'}; gunluk ozet ${SUMMARY_HOUR}:00, haftalik ozet ${gunler[WEEKLY_DAY]} ${SUMMARY_HOUR}:00`);
    app.listen(PORT, () => console.log(`Sunucu calisiyor: http://localhost:${PORT}`));
  } catch (err) {
    console.error('Baslangic hatasi:', err);
    process.exit(1);
  }
})();
