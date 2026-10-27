// Sunucuda calisan parola kurtarma komutu (ornegin tek admin sifresini unutursa).
// Kullanim: node reset-password.js <kullaniciadi> [yeniSifre]
// Sifre verilmezse rastgele gecici sifre uretilir; ilk giriste degistirmek zorunludur.
require('dotenv').config();

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

function randomPassword(len = 10) {
  // Karistirilabilecek karakterler (0/O, 1/l/I) cikarildi
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}

async function main() {
  const [username, given] = process.argv.slice(2);
  if (!username) {
    console.error('Kullanim: node reset-password.js <kullaniciadi> [yeniSifre]');
    process.exit(1);
  }
  if (given && given.length < 6) {
    console.error('Parola en az 6 karakter olmali');
    process.exit(1);
  }
  await db.init();
  const r = await db.query('SELECT id FROM users WHERE username = $1', [username.trim()]);
  if (!r.rows.length) {
    console.error(`Kullanici bulunamadi: ${username}`);
    process.exit(1);
  }
  const id = r.rows[0].id;
  const password = given || randomPassword();
  const hash = await bcrypt.hash(password, 10);
  await db.query('UPDATE users SET password = $1, must_change_password = true WHERE id = $2', [hash, id]);
  await db.query('INSERT INTO password_history (user_id, password) VALUES ($1, $2)', [id, hash]);
  await db.query('DELETE FROM password_resets WHERE user_id = $1', [id]);
  console.log(`"${username}" icin gecici parola: ${password}`);
  console.log('Ilk giriste parola degisimi zorunludur.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Parola sifirlanamadi:', err.message);
  process.exit(1);
});
