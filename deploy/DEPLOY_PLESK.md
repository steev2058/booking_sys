# Deploy on external hosting (Plesk)

## 1) Upload project
- Upload repository files to server path (e.g. `/var/www/vhosts/<domain>/httpdocs/booking`)
- Ensure Node.js is enabled in Plesk for this domain.

## 2) Install dependencies
```bash
cd booking
npm ci --omit=dev
cp .env.production.example .env
# edit .env values
```

## 3) Run with PM2
```bash
npm i -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## 4) Reverse proxy (if using custom nginx)
- Use `deploy/nginx-booking.conf` and replace server_name.

## 5) Verify
- `GET /api/branches`
- open `/` and `/admin`
- test OTP sending through MTN endpoint.
