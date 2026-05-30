require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const db = require('./db');
const portfolio = require('./portfolio');

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
  const { trade_date, symbol, quantity, price, source, usd_rate } = req.body || {};
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
  const total = qty * prc;
  const sym = symbol.trim().toUpperCase();
  try {
    const r = await db.query(
      `INSERT INTO purchases (user_id, trade_date, symbol, quantity, price, source, usd_rate, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.session.userId, trade_date, sym, qty, prc, src, usd, total]
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
  const { trade_date, symbol, quantity, price, source, usd_rate } = req.body || {};
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
  const total = qty * prc;
  try {
    const r = await db.query(
      `UPDATE purchases
          SET trade_date=$1, symbol=$2, quantity=$3, price=$4, source=$5, usd_rate=$6, total=$7
        WHERE id=$8 AND user_id=$9 RETURNING *`,
      [trade_date, symbol.trim().toUpperCase(), qty, prc, src, usd, total, req.params.id, req.session.userId]
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

// ---- Statik dosyalar ----
app.use(express.static(path.join(__dirname, 'public')));

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
    app.listen(PORT, () => console.log(`Sunucu calisiyor: http://localhost:${PORT}`));
  } catch (err) {
    console.error('Baslangic hatasi:', err);
    process.exit(1);
  }
})();
