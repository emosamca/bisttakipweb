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
  const src = source === 'temettu' ? 'temettu' : 'normal';
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
  const src = source === 'temettu' ? 'temettu' : 'normal';
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
    // Binance toplamlarini 5 dakikada bir yenile (sunucu tarafi; secret burada kalir)
    setTimeout(refreshAllBinance, 10000); // baslangictan 10 sn sonra ilk cekim
    setInterval(refreshAllBinance, 5 * 60 * 1000);
    app.listen(PORT, () => console.log(`Sunucu calisiyor: http://localhost:${PORT}`));
  } catch (err) {
    console.error('Baslangic hatasi:', err);
    process.exit(1);
  }
})();
