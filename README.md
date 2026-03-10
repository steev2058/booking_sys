

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

## التقارير اليومية عبر الإيميل
- يتم إرسال تقرير يومي Excel تلقائيًا عند التوليد إلى:
  - عناوين `REPORT_ADMIN_EMAILS`
  - وإيميلات المستخدمين في لوحة التحكم (حقل **إيميل التقارير** عند إضافة/تعديل المستخدم)
- تفاصيل الملف المرسل: الاسم، رقم الموبايل، تاريخ الحجز، وقت الحجز، اسم الفرع.
- يحتوي الإيميل أيضًا على رابط صفحة التقارير: `REPORTS_DASHBOARD_URL`.

المتغيرات المطلوبة في `.env`:
```env
REPORTS_DASHBOARD_URL=http://dit-83-555:8090/admin/
REPORT_ADMIN_EMAILS=M.Joha@albarakasyria.com
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=no-reply@albarakasyria.com
```

## ملاحظات
- تم الاستغناء عن `better-sqlite3` لضمان العمل على بيئات Python 3.6 بدون build native.
- التخزين الحالي JSON file-based في `data.json`.
- OTP مرتبط مع MTN API حسب الإعدادات في `.env`.
