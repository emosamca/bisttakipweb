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
  id          SERIAL PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  password    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hisse alimlari
CREATE TABLE IF NOT EXISTS purchases (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_date  DATE NOT NULL,
  symbol      TEXT NOT NULL,
  quantity    NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  price       NUMERIC(18,4) NOT NULL CHECK (price >= 0),
  source      TEXT NOT NULL DEFAULT 'normal',   -- 'normal' | 'temettu'
  usd_rate    NUMERIC(18,6),                    -- alis anindaki dolar kuru (TL/USD)
  total       NUMERIC(18,4) NOT NULL,           -- quantity * price
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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

CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_purchases_symbol ON purchases(user_id, symbol);
CREATE INDEX IF NOT EXISTS idx_cash_user ON cash_movements(user_id);
`;

// Eski (kullaniciya ozel) prices tablosunu ortak yapiya tasi + fiyat
// degisikliklerinde NOTIFY gonderecek tetikleyiciyi kur.
const MIGRATIONS = `
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
