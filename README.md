# منصة حجز دور بنك البركة (MVP)

## التشغيل
```bash
cp .env.example .env
npm install
npm run dev
```
ثم افتح:
- الواجهة العامة: `http://localhost:8090`
- لوحة التحكم: `http://localhost:8090/admin`

## حسابات افتراضية
- admin / admin1234
- dam_emp / branch1234

## الجداول
- branches
- remittance_companies
- business_days
- appointments
- dashboard_users
- otp_codes

## ملاحظات
- OTP حالياً Mock (يظهر في logs) حتى ربط SMS Gateway الحقيقي.
- CAPTCHA بسيط في النسخة الأولى.
