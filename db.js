const { Pool, types } = require('pg');

// DATE (OID 1082) sutunlarini saat dilimi kaymasi olmadan duz 'YYYY-MM-DD' string dondur.
types.setTypeParser(1082, (val) => val);

const connectionString = process.env.DATABASE_URL;

// SSL Mode=Prefer => once SSL ile dene, olmazsa SSL'siz baglan.
// Trust Server Certificate=true => sertifika dogrulamasi yapma.
function buildPool(useSsl) {
  return new Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

let pool = buildPool(true);

// Baslangicta calisan baglanti testi; SSL basarisiz olursa SSL'siz dener.
async function init() {
  try {
    const client = await pool.connect();
    client.release();
    console.log('Veritabanina SSL ile baglanildi.');
  } catch (err) {
    console.warn('SSL ile baglanti basarisiz, SSL\'siz deneniyor:', err.message);
    await pool.end().catch(() => {});
    pool = buildPool(false);
    const client = await pool.connect();
    client.release();
    console.log('Veritabanina SSL\'siz baglanildi.');
  }
  await migrate();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                    SERIAL PRIMARY KEY,
  username              TEXT NOT NULL UNIQUE,
  password              TEXT NOT NULL,
  role                  TEXT NOT NULL DEFAULT 'normal',  -- 'admin' | 'normal'
  must_change_password  BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Temettu takvimi (hisse basina brut/net temettu; ORTAK referans veri)
CREATE TABLE IF NOT EXISTS dividends (
  id          SERIAL PRIMARY KEY,
  symbol      TEXT NOT NULL,
  pay_date    DATE NOT NULL,
  gross       NUMERIC(18,6) NOT NULL,   -- hisse basina brut
  net         NUMERIC(18,6) NOT NULL,   -- hisse basina net (varsayilan brut*0.825)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dividends_symbol ON dividends(symbol, pay_date);

-- Parola gecmisi (son 3 parolayi tekrar engellemek icin)
CREATE TABLE IF NOT EXISTS password_history (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pwhist_user ON password_history(user_id);

-- Hisse alimlari
CREATE TABLE IF NOT EXISTS purchases (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_date  DATE NOT NULL,
  symbol      TEXT NOT NULL,
  quantity    NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  price       NUMERIC(18,4) NOT NULL CHECK (price >= 0),
  source          TEXT NOT NULL DEFAULT 'normal',   -- 'normal' | 'temettu'
  usd_rate        NUMERIC(18,6),                    -- alis anindaki dolar kuru (TL/USD)
  commission_rate NUMERIC(8,4) NOT NULL DEFAULT 0,  -- komisyon yuzdesi
  bsmv_rate       NUMERIC(8,4) NOT NULL DEFAULT 0,  -- bsmv yuzdesi (komisyon uzerine)
  total           NUMERIC(18,4) NOT NULL,           -- ara toplam + komisyon + bsmv
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nakit hareketleri ve temettuler
-- kind = 'cash'     => nakit giris (bakiyeyi artirir)
-- kind = 'dividend' => temettu (bakiyeyi artirir, symbol verilirse o hissenin maliyetini dusurur)
CREATE TABLE IF NOT EXISTS cash_movements (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  move_date   DATE NOT NULL,
  amount      NUMERIC(18,4) NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'cash',     -- 'cash' | 'dividend'
  symbol      TEXT,                             -- temettu ise hisse kodu
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Guncel fiyat tablosu (TUM kullanicilar icin ORTAK; Windows servisi de doldurabilir)
CREATE TABLE IF NOT EXISTS prices (
  id          SERIAL PRIMARY KEY,
  symbol      TEXT NOT NULL UNIQUE,
  price       NUMERIC(18,4) NOT NULL CHECK (price >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===================== ABD (US) tablolari =====================
-- Tamamen ayri; mevcut BIST yapisini etkilemez.
CREATE TABLE IF NOT EXISTS us_purchases (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_date      DATE NOT NULL,
  symbol          TEXT NOT NULL,
  quantity        NUMERIC(18,6) NOT NULL CHECK (quantity > 0),
  price           NUMERIC(18,6) NOT NULL CHECK (price >= 0),   -- USD
  source          TEXT NOT NULL DEFAULT 'normal',
  usdtry          NUMERIC(18,6),                               -- alis anindaki USD/TRY
  commission_rate NUMERIC(8,4) NOT NULL DEFAULT 0,
  bsmv_rate       NUMERIC(8,4) NOT NULL DEFAULT 0,
  total           NUMERIC(18,6) NOT NULL,                      -- USD, masraf dahil
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_us_purchases_user ON us_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_us_purchases_symbol ON us_purchases(user_id, symbol);

CREATE TABLE IF NOT EXISTS us_cash_movements (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  move_date   DATE NOT NULL,
  amount      NUMERIC(18,6) NOT NULL,           -- USD
  kind        TEXT NOT NULL DEFAULT 'cash',     -- 'cash' | 'dividend'
  symbol      TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_us_cash_user ON us_cash_movements(user_id);

-- Guncel ABD fiyatlari (servis doldurur; ORTAK)
CREATE TABLE IF NOT EXISTS us_prices (
  id          SERIAL PRIMARY KEY,
  symbol      TEXT NOT NULL UNIQUE,
  price       NUMERIC(18,6) NOT NULL CHECK (price >= 0),   -- USD
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ABD gecmis fiyatlari (servis doldurur; ORTAK)
CREATE TABLE IF NOT EXISTS us_price_history (
  symbol      TEXT NOT NULL,
  date        DATE NOT NULL,
  close       NUMERIC(18,6) NOT NULL,
  adj_close   NUMERIC(18,6),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, date)
);

-- Gunluk USD/TRY kuru (servis doldurur; ORTAK)
CREATE TABLE IF NOT EXISTS fx_rates (
  date        DATE PRIMARY KEY,
  rate        NUMERIC(18,6) NOT NULL,           -- USD/TRY
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===================== KIYMETLI MADEN tablolari =====================
-- Tamamen ayri; mevcut yapiyi etkilemez. Komisyon yok; sadece alim.
CREATE TABLE IF NOT EXISTS metal_purchases (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_date  DATE NOT NULL,
  metal       TEXT NOT NULL,                                  -- 'gold' | 'silver'
  quantity    NUMERIC(18,4) NOT NULL CHECK (quantity > 0),    -- gram
  price       NUMERIC(18,4) NOT NULL CHECK (price >= 0),      -- TL / gram
  total       NUMERIC(18,4) NOT NULL,                         -- TL (gram * fiyat)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_metal_purchases_user ON metal_purchases(user_id, metal);

-- Guncel gram TL fiyatlari (servis doldurur; ORTAK). Sadece son deger tutulur.
CREATE TABLE IF NOT EXISTS metal_prices (
  metal       TEXT PRIMARY KEY,                               -- 'gold' | 'silver'
  price       NUMERIC(18,4) NOT NULL CHECK (price >= 0),      -- TL / gram
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===================== DOVIZ tablolari =====================
-- Maden ile ayni mantik. Komisyon yok; sadece alim. Birim TL fiyati.
CREATE TABLE IF NOT EXISTS currency_purchases (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_date  DATE NOT NULL,
  currency    TEXT NOT NULL,                                  -- 'usd' | 'eur'
  quantity    NUMERIC(18,4) NOT NULL CHECK (quantity > 0),    -- doviz adedi (USD/EUR)
  price       NUMERIC(18,4) NOT NULL CHECK (price >= 0),      -- TL / birim (alis kuru)
  total       NUMERIC(18,4) NOT NULL,                         -- TL (adet * kur)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_currency_purchases_user ON currency_purchases(user_id, currency);

-- Guncel doviz TL kurlari. USD fx_rates'ten okunur; EUR'yu servis buraya yazar.
CREATE TABLE IF NOT EXISTS currency_prices (
  currency    TEXT PRIMARY KEY,                               -- 'usd' | 'eur'
  price       NUMERIC(18,4) NOT NULL CHECK (price >= 0),      -- TL / birim
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===================== KRIPTO tablolari =====================
-- Alim USD (USDT) bazli. symbol = coin (orn 'ADA'); Binance ciftleri symbol||'USDT'.
-- Kripto adetleri/fiyatlari cok ondalikli olabilir -> NUMERIC(28,10).
CREATE TABLE IF NOT EXISTS crypto_purchases (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_date  DATE NOT NULL,
  symbol      TEXT NOT NULL,                                  -- coin (orn 'ADA')
  quantity    NUMERIC(28,10) NOT NULL CHECK (quantity > 0),   -- coin adedi
  price       NUMERIC(28,10) NOT NULL CHECK (price >= 0),     -- USD / coin
  total       NUMERIC(28,10) NOT NULL,                        -- USD (adet * fiyat)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crypto_purchases_user ON crypto_purchases(user_id, symbol);

-- Guncel kripto fiyatlari (USD; ORTAK). Yalnizca alimi yapilan coin'ler burada
-- tutulur -> fiyat ceken servis SELECT symbol FROM crypto_prices ile sadece
-- gerekli coin'leri ceker. Sadece son fiyat tutulur (volume/degisim yok).
CREATE TABLE IF NOT EXISTS crypto_prices (
  symbol      TEXT PRIMARY KEY,                               -- coin (orn 'ADA')
  price       NUMERIC(28,10) NOT NULL CHECK (price >= 0),     -- USD
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Elde tutulan nakit (kullanici basina tek satir; TL/EUR/USD). Genel panoda kullanilir.
CREATE TABLE IF NOT EXISTS cash_holdings (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  try_amount  NUMERIC(18,4) NOT NULL DEFAULT 0,   -- elde TL
  eur_amount  NUMERIC(18,4) NOT NULL DEFAULT 0,   -- elde EUR
  usd_amount  NUMERIC(18,4) NOT NULL DEFAULT 0,   -- elde USD
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Kullaniciya ozel Binance API anahtarlari (AES-GCM ile sifreli saklanir; read-only)
CREATE TABLE IF NOT EXISTS binance_keys (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  api_key     TEXT NOT NULL,                      -- sifreli
  api_secret  TEXT NOT NULL,                      -- sifreli
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Kullaniciya ozel Telegram bildirim ayari (chat_id yoksa mesaj gonderilmez)
CREATE TABLE IF NOT EXISTS telegram_settings (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chat_id     TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Aylik enflasyon orani % (ORTAK; kullanici manuel girer). Fon-enflasyon kiyasi icin.
-- Kumulatif carpan kod tarafinda her ay (1+rate/100) ile hesaplanir.
CREATE TABLE IF NOT EXISTS tufe (
  ym          TEXT PRIMARY KEY,                 -- 'YYYY-MM'
  rate        NUMERIC(10,4) NOT NULL,           -- aylik enflasyon orani %
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Kullanicinin kazandigi basarimlar (kupalar). Tanimlar kodda; burada sadece kazanim.
CREATE TABLE IF NOT EXISTS user_achievements (
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_key  TEXT NOT NULL,
  unlocked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, achievement_key)
);

-- Gunluk portfoy snapshot'lari (kullanici basina gunde 1 satir). Haftalik ozet ve
-- Genel zaman grafigi icin kullanilir.
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snap_date   DATE NOT NULL,
  total_try   NUMERIC(20,4) NOT NULL DEFAULT 0,
  bist        NUMERIC(20,4) NOT NULL DEFAULT 0,
  us          NUMERIC(20,4) NOT NULL DEFAULT 0,
  metal       NUMERIC(20,4) NOT NULL DEFAULT 0,
  currency    NUMERIC(20,4) NOT NULL DEFAULT 0,
  crypto      NUMERIC(20,4) NOT NULL DEFAULT 0,
  cash        NUMERIC(20,4) NOT NULL DEFAULT 0,
  binance     NUMERIC(20,4) NOT NULL DEFAULT 0,
  usd_rate    NUMERIC(18,6),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, snap_date)
);

CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_purchases_symbol ON purchases(user_id, symbol);
CREATE INDEX IF NOT EXISTS idx_cash_user ON cash_movements(user_id);
`;

// Eski (kullaniciya ozel) prices tablosunu ortak yapiya tasi + fiyat
// degisikliklerinde NOTIFY gonderecek tetikleyiciyi kur.
const MIGRATIONS = `
-- Eski users tablosuna yeni sutunlari ekle
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;

-- Eski purchases tablosuna komisyon/bsmv sutunlari (eski kayitlar 0)
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(8,4) NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS bsmv_rate NUMERIC(8,4) NOT NULL DEFAULT 0;

-- tufe.idx (eski: endeks) -> tufe.rate (yeni: aylik oran %) yeniden adlandir
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tufe' AND column_name='idx')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tufe' AND column_name='rate') THEN
    ALTER TABLE tufe RENAME COLUMN idx TO rate;
  END IF;
END$$;

-- ABD alimlarda komisyon SABIT USD (yuzde/bsmv yok)
ALTER TABLE us_purchases ADD COLUMN IF NOT EXISTS commission NUMERIC(18,6) NOT NULL DEFAULT 0;

-- Gecmisi olmayan kullanicilar icin mevcut parolayi gecmise tohumla
INSERT INTO password_history (user_id, password)
SELECT id, password FROM users u
WHERE NOT EXISTS (SELECT 1 FROM password_history h WHERE h.user_id = u.id);

DO $$
BEGIN
  -- prices tablosunda eski user_id sutunu varsa ortak yapiya gec
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='prices' AND column_name='user_id') THEN
    -- ayni semboldekilerden en gunceli (en buyuk id) birak
    DELETE FROM prices p USING prices q WHERE p.symbol = q.symbol AND p.id < q.id;
    ALTER TABLE prices DROP COLUMN user_id CASCADE;
  END IF;

  -- symbol uzerinde benzersizlik yoksa ekle
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'prices'::regclass AND contype = 'u') THEN
    ALTER TABLE prices ADD CONSTRAINT prices_symbol_key UNIQUE (symbol);
  END IF;
END$$;

-- Fiyat degisikliginde bildirim gonder (web sayfasi anlik guncellensin)
CREATE OR REPLACE FUNCTION notify_price_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('price_change', COALESCE(NEW.symbol, OLD.symbol, ''));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prices_notify ON prices;
CREATE TRIGGER prices_notify
  AFTER INSERT OR UPDATE OR DELETE ON prices
  FOR EACH ROW EXECUTE PROCEDURE notify_price_change();

-- price_history degisince (Windows servisi yazinca) bir kez bildirim gonder.
-- Servis toplu yazabileceginden STATEMENT bazli (her satir icin degil).
CREATE OR REPLACE FUNCTION notify_history_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('history_change', '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- price_history tablosu (servis tarafindan olusturulur) varsa tetikleyiciyi kur
DO $$
BEGIN
  IF to_regclass('price_history') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS price_history_notify ON price_history';
    EXECUTE 'CREATE TRIGGER price_history_notify
               AFTER INSERT OR UPDATE OR DELETE ON price_history
               FOR EACH STATEMENT EXECUTE PROCEDURE notify_history_change()';
  END IF;
END$$;

-- ABD: us_prices veya fx_rates degisince ABD dashboard'u guncellemek icin bildirim
CREATE OR REPLACE FUNCTION notify_us_price_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('us_price_change', '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS us_prices_notify ON us_prices;
CREATE TRIGGER us_prices_notify
  AFTER INSERT OR UPDATE OR DELETE ON us_prices
  FOR EACH ROW EXECUTE PROCEDURE notify_us_price_change();

DROP TRIGGER IF EXISTS fx_rates_notify ON fx_rates;
CREATE TRIGGER fx_rates_notify
  AFTER INSERT OR UPDATE OR DELETE ON fx_rates
  FOR EACH STATEMENT EXECUTE PROCEDURE notify_us_price_change();

-- Kiymetli maden fiyat satirlarini tohumla (servis bu satirlari gunceller)
INSERT INTO metal_prices (metal, price) VALUES ('gold', 0), ('silver', 0)
  ON CONFLICT (metal) DO NOTHING;

-- metal_prices degisince (servis yazinca) kiymetli maden panosunu guncelle
CREATE OR REPLACE FUNCTION notify_metal_price_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('metal_price_change', '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS metal_prices_notify ON metal_prices;
CREATE TRIGGER metal_prices_notify
  AFTER INSERT OR UPDATE OR DELETE ON metal_prices
  FOR EACH STATEMENT EXECUTE PROCEDURE notify_metal_price_change();

-- Doviz fiyat satirlarini tohumla (USD fx_rates'ten okunur; EUR'yu servis gunceller)
INSERT INTO currency_prices (currency, price) VALUES ('usd', 0), ('eur', 0)
  ON CONFLICT (currency) DO NOTHING;

-- currency_prices degisince (servis EUR yazinca) doviz panosunu guncelle
CREATE OR REPLACE FUNCTION notify_currency_price_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('currency_price_change', '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS currency_prices_notify ON currency_prices;
CREATE TRIGGER currency_prices_notify
  AFTER INSERT OR UPDATE OR DELETE ON currency_prices
  FOR EACH STATEMENT EXECUTE PROCEDURE notify_currency_price_change();

-- crypto_prices degisince (servis veya alim aninda) kripto panosunu guncelle
CREATE OR REPLACE FUNCTION notify_crypto_price_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('crypto_price_change', '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS crypto_prices_notify ON crypto_prices;
CREATE TRIGGER crypto_prices_notify
  AFTER INSERT OR UPDATE OR DELETE ON crypto_prices
  FOR EACH STATEMENT EXECUTE PROCEDURE notify_crypto_price_change();
`;

async function migrate() {
  await pool.query(SCHEMA);
  await pool.query(MIGRATIONS);
  console.log('Tablolar hazir.');
}

// Bir kanali dinle (LISTEN/NOTIFY). Baglanti koparsa otomatik yeniden baglanir.
async function listen(channel, onNotify) {
  const connect = async () => {
    try {
      const client = await pool.connect();
      client.on('notification', (msg) => {
        if (msg.channel === channel && typeof onNotify === 'function') onNotify(msg.payload);
      });
      const reconnect = () => {
        try { client.removeAllListeners(); } catch (_) {}
        try { client.release(true); } catch (_) {}
        setTimeout(connect, 2000);
      };
      client.on('error', reconnect);
      client.on('end', reconnect);
      await client.query(`LISTEN ${channel}`);
      console.log(`LISTEN ${channel} aktif.`);
    } catch (e) {
      console.warn('LISTEN baglanti hatasi, tekrar denenecek:', e.message);
      setTimeout(connect, 3000);
    }
  };
  await connect();
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  init,
  listen,
};
