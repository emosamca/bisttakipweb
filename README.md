# BIST Portföy Takip

BIST hisse alımlarını, nakit bakiyeyi ve temettüleri takip eden basit web uygulaması.
Koyu temalı, kullanıcı adı/şifre girişli, PostgreSQL veritabanı kullanır.

## Özellikler

- **Giriş**: Kullanıcı adı ve şifre ile oturum.
- **Dashboard**: Nakit bakiye, toplam maliyet, toplam temettü, yatırılan nakit kartları + hisse tablosu.
- **Alım Ekle**: Tarih, hisse, adet, alış fiyatı, alış kaynağı (Normal/Temettü), dolar kuru.
  Toplam tutar otomatik hesaplanır ve nakit bakiyeden düşülür.
  Girilen tarihten önce o hisseden alım varsa **toplam adet** ve **ortalama maliyet** anlık gösterilir
  (geçmişe dönük girişlerde bile o tarihe göre hesaplanır).
- **Nakit / Temettü Ekle**: Tarih, miktar ve (opsiyonel) hisse. Hisse boşsa nakit girişi sayılır;
  hisse girilirse temettü olarak kaydedilir, bakiyeye eklenir ve o hissenin **ortalama maliyetinden düşülür**.

## Kurulum (Node.js)

Gereksinim: Node.js 18+

```bash
npm install
npm start
```

Uygulama `http://localhost:3000` adresinde çalışır.

Ayarlar `.env` dosyasındadır:

```
DATABASE_URL=""
PORT=3000
SESSION_SECRET=...        # production'da mutlaka değiştirin
DEFAULT_USER=        # ilk açılışta oluşturulur
DEFAULT_PASSWORD=
```

> İlk başlatmada tablolar otomatik oluşturulur ve varsayılan kullanıcı eklenir
> (` / `). Giriş yaptıktan sonra `.env`'deki şifreyi değiştirip
> yeni kullanıcı oluşturmanız önerilir.

### HTTPS (HTTP ile aynı anda)

Sertifika tanımlanırsa uygulama `PORT` (HTTP) ile birlikte `HTTPS_PORT`'ta
(varsayılan 3443) HTTPS de sunar. Sertifikalar `C:\certs` klasöründedir:

```
HTTPS_PORT=3443
HTTPS_CERT=C:\certs\origin.cert   # sertifika
HTTPS_KEY=C:\certs\origin.pem     # özel anahtar
HTTPS_CA=C:\certs\chain.pem       # isteğe bağlı ara sertifika zinciri
# veya tek .pfx dosyası
HTTPS_PFX=C:\certs\site.pfx
HTTPS_PFX_PASSPHRASE=...
```

Sertifika tanımlı değilse, okunamazsa ya da port doluysa hata loglanır ve
uygulama yalnızca HTTP ile çalışmaya devam eder.

Portları yalnızca Cloudflare'e açmak için (yönetici PowerShell):
`.\deploy\cloudflare-firewall.ps1`. Kurulum scripti bunu otomatik çalıştırır.

## Kurulum (Docker)

```bash
docker build -t bist-takip .
docker run -d -p 3000:3000 --env-file .env --name bist-takip bist-takip
# HTTPS ile (sertifika klasörünü bağlayın, .env'de HTTPS_CERT=/certs/origin.cert vb.)
docker run -d -p 3000:3000 -p 3443:3443 -v C:/certs:/certs:ro --env-file .env --name bist-takip bist-takip
```

## Sunucuda kalıcı çalıştırma (systemd örneği)

`/etc/systemd/system/bist-takip.service`:

```ini
[Unit]
Description=BIST Portfoy Takip
After=network.target

[Service]
WorkingDirectory=/opt/bist-takip
ExecStart=/usr/bin/node server.js
Restart=always
EnvironmentFile=/opt/bist-takip/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now bist-takip
```

## Veritabanı şeması

İlk açılışta otomatik oluşturulur:

- `users` — kullanıcılar (bcrypt'li şifre)
- `purchases` — hisse alımları (tarih, hisse, adet, fiyat, kaynak, dolar kuru, toplam)
- `cash_movements` — nakit girişleri ve temettüler (`kind`: `cash` / `dividend`)
- `prices` — **tüm kullanıcılar için ortak** güncel fiyat tablosu (`symbol` benzersiz)

## Otomatik fiyat güncelleme (Windows servisi entegrasyonu)

`prices` tablosu ortaktır ve kullanıcıdan bağımsızdır. Bir Windows servisi (veya
herhangi bir dış uygulama) fiyatları doğrudan veritabanına yazabilir:

```sql
INSERT INTO prices (symbol, price, updated_at)
VALUES ('THYAO', 312.50, now())
ON CONFLICT (symbol)
DO UPDATE SET price = EXCLUDED.price, updated_at = now();
```

Tablodaki her değişiklikte (INSERT/UPDATE/DELETE) bir veritabanı tetikleyicisi
`pg_notify('price_change', ...)` çağırır. Web sunucusu bu bildirimi `LISTEN` ile
dinler ve açık olan tüm tarayıcılara **SSE** (`/api/events`) üzerinden iletir.
Böylece servis fiyatı güncellediği anda dashboard'daki güncel değer, kâr/zarar,
pasta grafiği ve fiyat tablosu **otomatik** yenilenir — sayfayı yenilemeye gerek yoktur.

> Not: Tetikleyici tablonun kendisinde olduğu için, fiyat değişikliğinin web
> arayüzünden mi yoksa Windows servisinden mi geldiği fark etmez; her iki durumda
> da canlı güncelleme çalışır.

## Hesaplama mantığı

- **Nakit bakiye** = tüm nakit/temettü girişleri − tüm alım toplamları
- **Net maliyet** (hisse) = alım toplamları − o hisseye ait temettüler
- **Ortalama maliyet** = net maliyet ÷ adet
- **Tarihten önceki durum** = yalnızca o tarihten önceki alım ve temettüler dikkate alınır
