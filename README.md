

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

## MySQL + phpMyAdmin (بدء التحويل)
تم تجهيز مسار تحويل البيانات من `data.json` إلى MySQL.

### تشغيل MySQL + phpMyAdmin محليًا
```bash
npm run db:up
```

- MySQL: `127.0.0.1:3306`
- phpMyAdmin: `http://localhost:8081`
- المستخدم الافتراضي: `booking_user`
- كلمة المرور الافتراضية: `booking_pass`

### إنشاء الجداول
```bash
mysql -h 127.0.0.1 -P 3306 -u booking_user -pbooking_pass booking_sys < database/schema.sql
```

### نقل البيانات من JSON إلى MySQL
```bash
cp .env.example .env
node scripts/migrate-json-to-mysql.js
```

الآن التطبيق يدعم runtime مباشر على MySQL عبر المتغير:
```env
STORAGE_DRIVER=mysql
```
وللرجوع للوضع القديم:
```env
STORAGE_DRIVER=json
```

## ملاحظات
- تم الاستغناء عن `better-sqlite3` لضمان العمل على بيئات Python 3.6 بدون build native.
- التخزين الحالي JSON file-based في `data.json`.
- OTP مرتبط مع MTN API حسب الإعدادات في `.env`.
