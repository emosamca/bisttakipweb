// Faz 1 basarim (kupa) tanimlari — uygulama ici, bronz/gumus/altin + puan/seviye.
// Her tanim: key, kategori, baslik, aciklama, ikon, tier, puan, check(ctx)->bool.
// Bazi tanimlarda progress(ctx)->{current,target,usd} ile ilerleme cubugu gosterilir.

const DEFS = [
  // ---------- İlk Adımlar ----------
  { key: 'first_purchase', cat: 'İlk Adımlar', title: 'Yolculuk Başladı', desc: 'İlk alımını yaptın', icon: '🌱', tier: 'bronze', points: 10, check: (c) => c.purchaseCount > 0 },
  { key: 'first_bist', cat: 'İlk Adımlar', title: 'Borsa İstanbul', desc: 'İlk BIST alımın', icon: '🏦', tier: 'bronze', points: 10, check: (c) => c.bistCount > 0 },
  { key: 'first_us', cat: 'İlk Adımlar', title: 'Wall Street', desc: 'İlk ABD hissesi alımın', icon: '🇺🇸', tier: 'bronze', points: 10, check: (c) => c.usCount > 0 },
  { key: 'first_metal', cat: 'İlk Adımlar', title: 'Değerli Maden', desc: 'İlk altın/gümüş alımın', icon: '🥇', tier: 'bronze', points: 10, check: (c) => c.metalCount > 0 },
  { key: 'first_currency', cat: 'İlk Adımlar', title: 'Döviz Büfesi', desc: 'İlk döviz alımın', icon: '💱', tier: 'bronze', points: 10, check: (c) => c.currencyCount > 0 },
  { key: 'first_crypto', cat: 'İlk Adımlar', title: 'Kripto Çağı', desc: 'İlk kripto alımın', icon: '🪙', tier: 'bronze', points: 10, check: (c) => c.cryptoCount > 0 },
  { key: 'first_dividend', cat: 'İlk Adımlar', title: 'Pasif Gelir', desc: 'İlk temettünü aldın', icon: '💸', tier: 'silver', points: 20, check: (c) => c.hasDividend },
  { key: 'connect_binance', cat: 'İlk Adımlar', title: 'Borsaya Bağlı', desc: 'Binance hesabını bağladın', icon: '🟡', tier: 'silver', points: 20, check: (c) => c.hasBinance },
  { key: 'setup_telegram', cat: 'İlk Adımlar', title: 'Haberim Olsun', desc: 'Telegram bildirimini açtın', icon: '🔔', tier: 'bronze', points: 10, check: (c) => c.hasTelegram },

  // ---------- Kilometre Taşları (TL) ----------
  { key: 'm_100k', cat: 'Kilometre Taşları', title: 'Yüz Bin', desc: 'Portföyün ₺100.000’a ulaştı', icon: '🥉', tier: 'bronze', points: 20, check: (c) => c.totalTRY >= 100000, progress: (c) => ({ current: c.totalTRY, target: 100000 }) },
  { key: 'm_250k', cat: 'Kilometre Taşları', title: 'Çeyrek Milyon', desc: 'Portföyün ₺250.000’a ulaştı', icon: '🥉', tier: 'bronze', points: 30, check: (c) => c.totalTRY >= 250000, progress: (c) => ({ current: c.totalTRY, target: 250000 }) },
  { key: 'm_500k', cat: 'Kilometre Taşları', title: 'Yarım Milyon', desc: 'Portföyün ₺500.000’a ulaştı', icon: '🥈', tier: 'silver', points: 50, check: (c) => c.totalTRY >= 500000, progress: (c) => ({ current: c.totalTRY, target: 500000 }) },
  { key: 'm_1m', cat: 'Kilometre Taşları', title: 'Milyoner', desc: 'Portföyün ₺1.000.000’a ulaştı', icon: '🏆', tier: 'gold', points: 100, check: (c) => c.totalTRY >= 1000000, progress: (c) => ({ current: c.totalTRY, target: 1000000 }) },
  { key: 'm_2_5m', cat: 'Kilometre Taşları', title: '2,5 Milyon', desc: 'Portföyün ₺2.500.000’a ulaştı', icon: '🏆', tier: 'gold', points: 150, check: (c) => c.totalTRY >= 2500000, progress: (c) => ({ current: c.totalTRY, target: 2500000 }) },
  { key: 'm_5m', cat: 'Kilometre Taşları', title: 'Beş Milyon', desc: 'Portföyün ₺5.000.000’a ulaştı', icon: '👑', tier: 'gold', points: 250, check: (c) => c.totalTRY >= 5000000, progress: (c) => ({ current: c.totalTRY, target: 5000000 }) },
  // USD
  { key: 'm_usd_10k', cat: 'Kilometre Taşları', title: '$10K Kulübü', desc: 'Portföyün $10.000’a ulaştı', icon: '💵', tier: 'silver', points: 50, check: (c) => c.totalUSD != null && c.totalUSD >= 10000, progress: (c) => ({ current: c.totalUSD || 0, target: 10000, usd: true }) },
  { key: 'm_usd_100k', cat: 'Kilometre Taşları', title: '$100K Kulübü', desc: 'Portföyün $100.000’a ulaştı', icon: '💰', tier: 'gold', points: 200, check: (c) => c.totalUSD != null && c.totalUSD >= 100000, progress: (c) => ({ current: c.totalUSD || 0, target: 100000, usd: true }) },

  // ---------- Performans ----------
  { key: 'daily_5', cat: 'Performans', title: 'Rüzgar Arkamda', desc: 'Portföyün bir günde %5 arttı', icon: '📈', tier: 'silver', points: 30, check: (c) => c.dailyChangePct != null && c.dailyChangePct >= 5 },
  { key: 'daily_10', cat: 'Performans', title: 'Roket', desc: 'Portföyün bir günde %10 arttı', icon: '🚀', tier: 'gold', points: 60, check: (c) => c.dailyChangePct != null && c.dailyChangePct >= 10 },
];

// Seviye eşikleri (toplam puana göre)
const LEVELS = [
  { min: 0, name: 'Çaylak' },
  { min: 50, name: 'Acemi Yatırımcı' },
  { min: 120, name: 'Yatırımcı' },
  { min: 250, name: 'Tecrübeli' },
  { min: 450, name: 'Uzman' },
  { min: 700, name: 'Usta' },
  { min: 1000, name: 'Efsane' },
];

function levelFor(points) {
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) if (points >= LEVELS[i].min) idx = i;
  const cur = LEVELS[idx];
  const next = LEVELS[idx + 1] || null;
  return {
    level: idx + 1,
    name: cur.name,
    currentMin: cur.min,
    nextMin: next ? next.min : null,
    nextName: next ? next.name : null,
  };
}

const TOTAL_POINTS = DEFS.reduce((s, d) => s + d.points, 0);

module.exports = { DEFS, LEVELS, levelFor, TOTAL_POINTS };
