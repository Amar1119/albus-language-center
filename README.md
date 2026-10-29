# Albus Language Center — вэбсайт + бүртгэлийн систем

Сайтаас ирсэн бүртгэлийн хүсэлтүүд серверийн SQLite өгөгдлийн санд хадгалагдана.
Тэдгээрийг `/admin` хуудаснаас харж, төлөв өөрчилж, тэмдэглэл бичиж, Excel рүү татаж авна.

**Гадны сан огт ашиглаагүй.** Зөвхөн Node.js-ийн суурилагдсан модулиуд ашигласан (`node:http`, `node:sqlite`, `node:crypto`).
Тиймээс `npm install` хийх шаардлагагүй, supply-chain эрсдэл байхгүй, шинэчлэл хийх ачаалал бага.

## Шаардлага

- Node.js **22.13 буюу түүнээс дээш** (`node -v` гэж шалгана)

## Эхлүүлэх

```bash
cp .env.example .env      # ADMIN_PASSWORD-оо бичнэ
npm start                 # http://localhost:3000   ·   админ: http://localhost:3000/admin
npm test                  # 16 автомат тест
```

Хөгжүүлэлтийн үед `npm run dev` ашиглавал файл өөрчлөгдөхөд сервер автоматаар дахин асна.

## Бүтэц

```
server.js            эхлэх цэг, graceful shutdown
src/app.js           HTTP сервер, маршрутууд, статик файл
src/db.js            SQLite, migration, query-нууд
src/validate.js      сургалтын жагсаалт, оролтын шалгалт
src/security.js      rate limit, session, нууц үг, хамгаалалтын header
src/config.js        .env унших, тохиргоо
public/              сайт (index.html), админ (admin.html), js/, 404.html
test/api.test.js     API тестүүд
```

Сургалт нэмэх/хасах бол: `src/validate.js` дахь `COURSES`, `public/index.html` дахь карт болон `<select>`.

## API

| Арга | Зам | Тайлбар |
|---|---|---|
| POST | `/api/registrations` | Бүртгэл илгээх `{name, phone, course, message?}` |
| GET | `/api/courses` | Сургалтын жагсаалт |
| POST | `/api/admin/login` · `/logout` | Нэвтрэх / гарах |
| GET | `/api/admin/registrations?status=&course=&q=&limit=&offset=` | Жагсаалт |
| PATCH | `/api/admin/registrations/:id` | `{status?, admin_note?}` |
| DELETE | `/api/admin/registrations/:id` | Устгах |
| GET | `/api/admin/stats` | Тоон үзүүлэлт |
| GET | `/api/admin/export.csv` | Excel-д нээгдэх CSV |

## Аюулгүй байдал

- Нууц үгийг scrypt hash-аар харьцуулна; нэвтрэх оролдлогыг IP тус бүр 15 минутад 8-аар хязгаарлана.
- Session нь HttpOnly + SameSite=Strict cookie, production орчинд Secure.
- Өөр домэйноос ирсэн өөрчлөх хүсэлтийг (CSRF) Origin шалгалтаар хаана.
- Бүртгэлийг IP тус бүр 10 минутад 5-аар хязгаарлана. Honeypot талбар bot-уудыг шүүнэ. Нэг утас, нэг сургалтаар 24 цагт давхар бүртгэл үүсэхгүй.
- Content-Security-Policy (inline script хориотой), X-Frame-Options, nosniff, HSTS тохируулсан.
- Бүх SQL параметртэй query; CSV-д Excel формула injection-оос хамгаалсан.
- Request body 16KB-аас хэтрэхгүй; path traversal хаагдсан.

## Production-д байршуулах (Ubuntu VPS жишээ)

```bash
# 1. Node 22 суулгах
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs

# 2. Кодоо /opt/albus руу хуулаад
cd /opt/albus && cp .env.example .env && nano .env
```

**systemd** (`/etc/systemd/system/albus.service`):

```ini
[Unit]
Description=Albus Language Center
After=network.target

[Service]
WorkingDirectory=/opt/albus
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
Restart=always
User=www-data
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /opt/albus/data && sudo chown -R www-data /opt/albus/data
sudo systemctl enable --now albus
```

**Nginx + HTTPS** (`/etc/nginx/sites-available/albus`):

```nginx
server {
    server_name albus.mn www.albus.mn;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/albus /etc/nginx/sites-enabled/
sudo certbot --nginx -d albus.mn -d www.albus.mn     # үнэгүй SSL
```

`.env` дотор `TRUST_PROXY=1` байх ёстой (Nginx-ийн ард ажиллаж байгаа тул).

**Docker** ашиглах бол:

```bash
docker build -t albus .
docker run -d --name albus -p 3000:3000 -e ADMIN_PASSWORD='...' -e TRUST_PROXY=1 -v albus-data:/data albus
```

## Нөөцлөлт (backup)

Бүх өгөгдөл `data/albus.db` нэг файлд байна. Өдөр бүр нөөцлөх (cron):

```bash
0 3 * * * sqlite3 /opt/albus/data/albus.db ".backup '/opt/albus/backup/albus-$(date +\%F).db'"
```

## Telegram мэдэгдэл (заавал биш)

1. Telegram дээр @BotFather-аас бот үүсгэж token авна.
2. Ботдоо мессеж бичээд `https://api.telegram.org/bot<TOKEN>/getUpdates` хаягаас `chat.id`-аа олно.
3. `.env`-д `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` бичнэ. Шинэ бүртгэл бүр утсанд тань шууд ирнэ.
