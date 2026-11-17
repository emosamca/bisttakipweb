// SMTP ile e-posta gonderimi (Zoho: smtppro.zoho.eu, 465/SSL)
// .env: SMTP_HOST, SMTP_PORT (varsayilan 465), SMTP_USER, SMTP_PASS, MAIL_FROM (istege bagli)
const nodemailer = require('nodemailer');

const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;
const MAIL_FROM = process.env.MAIL_FROM || (SMTP_USER ? `"Portföyüm" <${SMTP_USER}>` : '');

let transporter = null;

function configured() {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465, // 465: dogrudan SSL, 587: STARTTLS
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
  }
  return transporter;
}

// Basari/hata dondurur, hata firlatmaz
async function send(to, subject, text, html) {
  if (!configured()) return { ok: false, error: 'SMTP tanimli degil (SMTP_HOST/SMTP_USER/SMTP_PASS)' };
  if (!to) return { ok: false, error: 'Alici yok' };
  try {
    await getTransporter().sendMail({ from: MAIL_FROM, to, subject, text, html });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { configured, send };
