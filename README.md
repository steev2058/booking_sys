

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

## جداول البيانات (داخل data.json)
- branches
- remittance_companies
- business_days
- appointments
- dashboard_users
- otp_codes
- otp_security

## ملاحظات
- تم الاستغناء عن `better-sqlite3` لضمان العمل على بيئات Python 3.6 بدون build native.
- التخزين الحالي JSON file-based في `data.json`.
- OTP مرتبط مع MTN API حسب الإعدادات في `.env`.
