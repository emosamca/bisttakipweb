// Telegram Bot API ile mesaj gonderimi (web sayfasi acik olmasa da sunucu gonderir)
const BOT_TOKEN = process.env.BOT_TOKEN || '';

function configured() {
  return !!BOT_TOKEN;
}

// chat_id'ye HTML formatli mesaj gonder. Basari/hata dondurur.
async function send(chatId, text) {
  if (!BOT_TOKEN) return { ok: false, error: 'BOT_TOKEN tanımlı değil' };
  if (!chatId) return { ok: false, error: 'chat_id yok' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) return { ok: false, error: (j && j.description) || `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { configured, send };
