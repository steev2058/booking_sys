require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');
const { read, write, nextId, nowISO, seedIfNeeded, getCooldownData } = require('./store');

const app = express();
const PORT = process.env.PORT || 8090;

process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err && (err.stack || err.message || err));
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason && (reason.stack || reason.message || reason));
});
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_secret';
const SMS_ENDPOINT = process.env.SMS_ENDPOINT || 'https://services.mtnsyr.com:7443/General/MTNSERVICES/ConcatenatedSender.aspx';
const SMS_USER = process.env.SMS_USER || 'ALbaraka2013';
const SMS_PASS = process.env.SMS_PASS || 'Jj2013';
const SMS_FROM = process.env.SMS_FROM || 'AL-Baraka';

const OTP_WINDOW_MINUTES = Number(process.env.OTP_WINDOW_MINUTES || 10);
const OTP_MAX_PER_WINDOW = Number(process.env.OTP_MAX_PER_WINDOW || 5);
const OTP_MAX_VERIFY_ATTEMPTS = Number(process.env.OTP_MAX_VERIFY_ATTEMPTS || 5);
const OTP_LOCK_MINUTES = Number(process.env.OTP_LOCK_MINUTES || 30);
const EMPLOYEE_PREFIX = (process.env.EMPLOYEE_PREFIX || 'BBSY0').toUpperCase();
const REPORTS_DASHBOARD_URL = process.env.REPORTS_DASHBOARD_URL || '';
const REPORT_ADMIN_EMAILS = String(process.env.REPORT_ADMIN_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'no-reply@albarakasyria.com';

const ROLE_ADMIN_LIKE = ['admin'];
const ROLE_VIEW_APPOINTMENTS = ['admin', 'manager', 'employee', 'branch_employee'];
const ROLE_DAY_MANAGE = ['admin', 'manager', 'branch_employee'];
const MANAGER_SCOPED_TO_BRANCH = String(process.env.MANAGER_SCOPED_TO_BRANCH || '1') === '1';

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  if (req.path.startsWith('/api/precheck-booking') || req.path.startsWith('/api/captcha')) {
    const started = Date.now();
    console.log(`[REQ] ${req.method} ${req.path}`);
    res.on('finish', () => console.log(`[RES] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - started}ms)`));
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));

function auth(requiredRoles = []) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const token = h.slice(7);
      const payload = jwt.verify(token, JWT_SECRET);
      if (requiredRoles.length && !requiredRoles.includes(payload.role)) return res.status(403).json({ error: 'Forbidden' });
      req.user = payload;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const AR_DAYS = {
  Sunday: 'الأحد',
  Monday: 'الإثنين',
  Tuesday: 'الثلاثاء',
  Wednesday: 'الأربعاء',
  Thursday: 'الخميس',
  Friday: 'الجمعة',
  Saturday: 'السبت'
};

function ymd(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function fromYmd(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addWorkingDays(startDateYmd, daysToAdd, allowedDayNames, holidaysSet = new Set()) {
  let d = fromYmd(startDateYmd);
  if (Number.isNaN(d.getTime())) return null;
  let added = 0;
  let guard = 0;
  while (added < daysToAdd) {
    guard += 1;
    if (guard > 400) return null; // safety guard against malformed data
    d.setDate(d.getDate() + 1);
    const en = EN_DAYS[d.getDay()];
    const key = ymd(d);
    if (allowedDayNames.includes(en) && !holidaysSet.has(key)) added += 1;
  }
  return ymd(d);
}

function checkBookingCooldown(data, { phone, booking_date, branch_id }) {
  const holidaysSet = new Set((data.holidays || []).map(h => h.date));
  const allowedDayNames = data.business_days
    .filter(d => Number(d.branch_id) === Number(branch_id) && Number(d.active) === 1)
    .map(d => d.day_name);

  const validDayNames = allowedDayNames.length ? allowedDayNames : EN_DAYS;
  const samePhoneBookings = data.appointments.filter(a => a.status === 'booked' && String(a.phone || '') === String(phone || ''));

  for (const b of samePhoneBookings) {
    const bDate = normalizeAppointmentDate(b);
    if (!bDate) continue;
    const earliest = addWorkingDays(bDate, 2, validDayNames, holidaysSet);
    if (!earliest) continue;
    if (booking_date < earliest) {
      return { blocked: true, earliest };
    }
  }
  return { blocked: false };
}

function makeSlots(start, end, interval = 30) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const out = [];
  let cur = sh * 60 + sm;
  const endM = eh * 60 + em;
  while (cur + interval <= endM) {
    out.push(`${String(Math.floor(cur / 60)).padStart(2, '0')}:${String(cur % 60).padStart(2, '0')}`);
    cur += interval;
  }
  return out;
}

function createCaptcha() {
  const chars = '0123456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];

  const palette = ['#2e2e2e', '#5a7dbf', '#7f2f6d', '#2d8f6f', '#b86a1d'];
  const letters = code.split('').map((ch, i) => {
    const x = 34 + i * 42;
    const y = 46 + (Math.random() * 6 - 3);
    const rot = Math.floor(Math.random() * 24 - 12);
    const col = palette[Math.floor(Math.random() * palette.length)];
    return `<text x="${x}" y="${y}" transform="rotate(${rot} ${x} ${y})" font-size="34" font-family="Tahoma, Arial" font-weight="700" fill="${col}">${ch}</text>`;
  }).join('');

  const lines = Array.from({ length: 4 }).map(() => {
    const x1 = Math.floor(Math.random() * 240);
    const y1 = Math.floor(Math.random() * 80);
    const x2 = Math.floor(Math.random() * 240);
    const y2 = Math.floor(Math.random() * 80);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#6b6b6b" stroke-width="1" opacity="0.45" />`;
  }).join('');

  const dots = Array.from({ length: 22 }).map(() => {
    const cx = Math.floor(Math.random() * 240);
    const cy = Math.floor(Math.random() * 80);
    const r = Math.random() * 1.4 + 0.4;
    return `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(2)}" fill="#8c8c8c" opacity="0.35" />`;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80" viewBox="0 0 240 80"><rect width="240" height="80" rx="12" fill="#e5c6cf"/>${lines}${dots}${letters}</svg>`;
  const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const token = Buffer.from(`${code}:${Date.now() + 2 * 60 * 1000}`).toString('base64');
  return { code, token, image };
}

function verifyCaptcha(answer, token) {
  try {
    const [code, exp] = Buffer.from(token, 'base64').toString().split(':');
    return Date.now() <= Number(exp) && String(answer || '').trim().toUpperCase() === String(code || '').toUpperCase();
  } catch {
    return false;
  }
}

function isValidPhone(phone) {
  return /^09\d{8}$/.test(String(phone || '').trim());
}

function isValidFullName(name) {
  return /^[A-Za-z\u0600-\u06FF\s]{3,}$/.test(String(name || '').trim());
}

function normalizeRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'employe') return 'employee';
  return r;
}

function randomPassword(len = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function generateEmployeeNo(data) {
  const prefix = EMPLOYEE_PREFIX.toUpperCase();
  const list = (data.dashboard_users || [])
    .map(u => String(u.employee_no || '').trim().toUpperCase())
    .filter(v => v.startsWith(prefix))
    .map(v => Number(v.slice(prefix.length)))
    .filter(v => Number.isFinite(v));
  const max = list.length ? Math.max(...list) : 0;
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

function isValidEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function reportRowsForDate(data, dateYmd, scopedBranchId = null) {
  const reports = buildLiveReportsForDate(data, dateYmd, scopedBranchId);
  const rows = [];
  for (const r of reports) {
    for (const p of (r.payload || [])) {
      rows.push({
        full_name: p.full_name || '-',
        phone: p.phone || '-',
        booking_date: r.report_date,
        booking_time: `${p.slot_from || '-'} - ${p.slot_to || '-'}`,
        branch_name: r.branch_name || '-'
      });
    }
  }
  return rows;
}

function buildExcelBuffer(rows) {
  const header = ['الاسم', 'رقم الموبايل', 'تاريخ الحجز', 'وقت الحجز', 'اسم الفرع'];
  const lines = [header.join('\t')];
  for (const row of rows) {
    lines.push([
      row.full_name || '-',
      row.phone || '-',
      row.booking_date || '-',
      row.booking_time || '-',
      row.branch_name || '-'
    ].join('\t'));
  }
  return Buffer.from(`\uFEFF${lines.join('\n')}`, 'utf8');
}

async function sendReportEmail({ to, dateYmd, rows, dashboardUrl }) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !to) return { ok: false, skipped: true };
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const fileName = `daily_booking_report_${dateYmd}.xls`;
  const html = `
    <div dir="rtl" style="font-family:Arial,sans-serif">
      <h3>تقرير الحجوزات اليومية - ${dateYmd}</h3>
      <p>مرفق ملف Excel يتضمن التفاصيل التالية:</p>
      <ul>
        <li>الاسم</li>
        <li>رقم الموبايل</li>
        <li>تاريخ الحجز</li>
        <li>وقت الحجز</li>
        <li>اسم الفرع المحجوز به</li>
      </ul>
      <p>رابط صفحة التقارير في لوحة التحكم:</p>
      <p><a href="${dashboardUrl}">${dashboardUrl}</a></p>
    </div>
  `;

  await transporter.sendMail({
    from: SMTP_FROM,
    to,
    subject: `تقرير حجوزات منصة الدور - ${dateYmd}`,
    html,
    attachments: [
      {
        filename: fileName,
        content: buildExcelBuffer(rows),
        contentType: 'application/vnd.ms-excel'
      }
    ]
  });

  return { ok: true };
}

async function sendDailyReportsEmailsIfNeeded(data, dateYmd = ymd(new Date())) {
  const users = data.dashboard_users || [];
  const allRecipients = new Set(REPORT_ADMIN_EMAILS);
  for (const u of users) {
    if (['admin', 'manager', 'branch_employee', 'employee'].includes(normalizeRole(u.role)) && u.report_email) {
      allRecipients.add(normalizeEmail(u.report_email));
    }
  }

  if (!allRecipients.size) return false;
  data.report_email_logs = data.report_email_logs || [];
  const dashboardUrl = REPORTS_DASHBOARD_URL || `http://localhost:${PORT}/admin/`;

  let sentAny = false;
  for (const email of allRecipients) {
    const user = users.find(u => normalizeEmail(u.report_email) === email);
    const role = user ? normalizeRole(user.role) : 'admin';
    const scopedBranchId = (role === 'manager' || role === 'employee' || role === 'branch_employee') ? Number(user?.branch_id || 0) || null : null;
    const dedupeRaw = `${dateYmd}::${email}::${scopedBranchId || 'all'}`;
    const dedupeKey = crypto.createHash('sha1').update(dedupeRaw).digest('hex');
    if (data.report_email_logs.some(x => x.key === dedupeKey)) continue;

    const rows = reportRowsForDate(data, dateYmd, scopedBranchId);
    if (!rows.length) continue;

    try {
      await sendReportEmail({ to: email, dateYmd, rows, dashboardUrl });
      data.report_email_logs.push({ key: dedupeKey, email, date: dateYmd, branch_id: scopedBranchId, sent_at: nowISO() });
      sentAny = true;
    } catch (e) {
      console.error('[REPORT_EMAIL_ERROR]', email, e.message || e);
    }
  }
  return sentAny;
}

function getSec(data, phone) {
  data.otp_security = data.otp_security || [];
  let row = data.otp_security.find(x => x.phone === phone);
  if (!row) {
    row = { phone, send_count: 0, window_start: nowISO(), verify_fail_count: 0, locked_until: null };
    data.otp_security.push(row);
  }
  return row;
}

function ensureNotLocked(data, phone) {
  const sec = getSec(data, phone);
  if (sec.locked_until && new Date(sec.locked_until).getTime() > Date.now()) {
    return { ok: false, message: `Too many attempts. Try again after ${sec.locked_until}` };
  }
  return { ok: true };
}

function canSendOtp(data, phone) {
  const sec = getSec(data, phone);
  const now = Date.now();
  const windowMs = OTP_WINDOW_MINUTES * 60 * 1000;
  const ws = sec.window_start ? new Date(sec.window_start).getTime() : 0;
  if (!ws || now - ws > windowMs) {
    sec.send_count = 0;
    sec.window_start = nowISO();
  }
  if (sec.send_count >= OTP_MAX_PER_WINDOW) return false;
  sec.send_count += 1;
  return true;
}

function trackVerifyFail(data, phone) {
  const sec = getSec(data, phone);
  sec.verify_fail_count = Number(sec.verify_fail_count || 0) + 1;
  if (sec.verify_fail_count >= OTP_MAX_VERIFY_ATTEMPTS) {
    sec.verify_fail_count = 0;
    sec.locked_until = new Date(Date.now() + OTP_LOCK_MINUTES * 60 * 1000).toISOString();
    return { locked: true, lockedUntil: sec.locked_until };
  }
  return { locked: false };
}

function resetVerifyFail(data, phone) {
  const sec = getSec(data, phone);
  sec.verify_fail_count = 0;
  sec.locked_until = null;
}

function ensureDefaultBusinessDays(data, branchId) {
  const defaults = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
  for (const day of defaults) {
    const exists = data.business_days.find(d => Number(d.branch_id) === Number(branchId) && d.day_name === day);
    if (!exists) {
      data.business_days.push({
        id: nextId(data, 'business_days'),
        branch_id: Number(branchId),
        day_name: day,
        start_time: '10:00',
        end_time: '14:00',
        interval_minutes: 30,
        active: 1
      });
    } else {
      exists.start_time = '10:00';
      exists.end_time = '14:00';
      exists.interval_minutes = 30;
      exists.active = 1;
    }
  }
  for (const row of data.business_days.filter(d => Number(d.branch_id) === Number(branchId) && d.day_name === 'Friday')) {
    row.active = 0;
  }
}

function calcSlotEnd(slotStart, minutes = 30) {
  const [h, m] = String(slotStart).split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function hhmmToMin(v = '00:00') {
  const [h, m] = String(v).split(':').map(Number);
  return (h * 60) + m;
}

function normalizeAppointmentDate(a) {
  if (a.booking_date) {
    const raw = String(a.booking_date);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return ymd(d);
  }
  if (a.created_at) {
    const d = new Date(a.created_at);
    if (!Number.isNaN(d.getTime())) return ymd(d);
  }
  return null;
}

function buildLiveReportsForDate(data, dateYmd, scopedBranchId = null) {
  const branches = (data.branches || []).filter(b => Number(b.active) === 1 && (!scopedBranchId || Number(b.id) === Number(scopedBranchId)));
  return branches.map(branch => {
    const rows = (data.appointments || [])
      .filter(a => a.status === 'booked' && Number(a.branch_id) === Number(branch.id) && normalizeAppointmentDate(a) === dateYmd)
      .map(a => ({
        id: a.id,
        full_name: a.full_name || '',
        phone: a.phone,
        transfer_number: a.transfer_number,
        slot_from: a.slot_time,
        slot_to: a.slot_to || ''
      }));

    return {
      branch_id: Number(branch.id),
      branch_name: branch.name || '',
      report_date: dateYmd,
      total_booked: rows.length,
      payload: rows
    };
  });
}

async function generateDailyReportsIfNeeded(dateYmd = ymd(new Date())) {
  const data = await read();
  let changed = false;
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const holidaysSet = new Set((data.holidays || []).map(h => h.date));
  if (holidaysSet.has(dateYmd)) return false;

  const dayName = EN_DAYS[fromYmd(dateYmd).getDay()];
  const liveRows = buildLiveReportsForDate(data, dateYmd);

  for (const r of liveRows) {
    const dayCfg = (data.business_days || []).find(d => Number(d.branch_id) === Number(r.branch_id) && d.day_name === dayName && Number(d.active) === 1);
    if (!dayCfg) continue;
    if (nowMin < hhmmToMin(dayCfg.start_time || '09:00')) continue;

    data.daily_reports = data.daily_reports || [];
    const exists = data.daily_reports.find(x => x.report_date === dateYmd && Number(x.branch_id) === Number(r.branch_id));
    if (exists) {
      exists.total_booked = r.total_booked;
      exists.payload = r.payload;
      exists.created_at = nowISO();
    } else {
      data.daily_reports.push({
        id: nextId(data, 'daily_reports'),
        report_date: dateYmd,
        branch_id: Number(r.branch_id),
        total_booked: r.total_booked,
        payload: r.payload,
        created_at: nowISO()
      });
    }
    changed = true;
  }

  if (changed) {
    await sendDailyReportsEmailsIfNeeded(data, dateYmd);
    await write(data);
  }
  return changed;
}


async function sendSmsRaw(phone, msg) {
  const qs = new URLSearchParams({ User: SMS_USER, Pass: SMS_PASS, From: SMS_FROM, Gsm: phone, Msg: msg, Lang: '0' });
  const url = `${SMS_ENDPOINT}?${qs.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, { method: 'GET', signal: controller.signal });
    const text = await r.text();
    return { ok: r.ok, text: (text || '').slice(0, 500) };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendSmsOtp(phone, code) {
  return sendSmsRaw(phone, `رمز التحقق الخاص بك هو: ${code}`);
}

app.get('/api/branches', async (_req, res) => {
  const data = await read();
  res.json({ branches: data.branches.filter(b => Number(b.active) === 1).sort((a, b) => a.name.localeCompare(b.name)) });
});

app.get('/api/companies', async (_req, res) => {
  const data = await read();
  res.json({ companies: data.remittance_companies.filter(c => Number(c.active) === 1).sort((a, b) => a.name.localeCompare(b.name)) });
});

app.get('/api/business-days', async (req, res) => {
  const branchId = Number(req.query.branch_id);
  if (!branchId) return res.status(400).json({ error: 'branch_id required' });
  const data = await read();

  ensureDefaultBusinessDays(data, branchId);
  await write(data);

  const rows = data.business_days.filter(d => Number(d.branch_id) === branchId && Number(d.active) === 1);
  const allowed = rows.map(r => r.day_name);
  const holidaysSet = new Set((data.holidays || []).map(h => h.date));

  const upcoming = [];
  let cursor = new Date();
  // يبدأ الحجز من اليوم التالي (لا نعرض تاريخ اليوم)
  cursor.setDate(cursor.getDate() + 1);
  for (let i = 0; i < 30 && upcoming.length < 14; i += 1) {
    const en = EN_DAYS[cursor.getDay()];
    const date = ymd(cursor);
    const cfg = rows.find(r => r.day_name === en);
    if (cfg && !holidaysSet.has(date)) {
      upcoming.push({
        date,
        day_name: en,
        day_name_ar: AR_DAYS[en] || en,
        start_time: cfg.start_time,
        end_time: cfg.end_time,
        interval_minutes: Number(cfg.interval_minutes || 30)
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  res.json({ days: upcoming });
});

app.get('/api/slots', async (req, res) => {
  const branchId = Number(req.query.branch_id);
  const bookingDate = String(req.query.booking_date || '');
  if (!branchId || !bookingDate) return res.status(400).json({ error: 'branch_id/booking_date required' });

  const data = await read();
  const dayName = EN_DAYS[fromYmd(bookingDate).getDay()];
  const day = data.business_days.find(d => Number(d.branch_id) === branchId && d.day_name === dayName && Number(d.active) === 1);
  if (!day) return res.status(404).json({ error: 'Day config not found' });

  const allSlots = makeSlots(day.start_time, day.end_time, Number(day.interval_minutes || 30));
  const bookedForDate = data.appointments.filter(a => Number(a.branch_id) === branchId && a.booking_date === bookingDate && a.status === 'booked');
  const slots = allSlots.map(t => {
    const count = bookedForDate.filter(b => b.slot_time === t).length;
    return {
      time: t,
      to_time: calcSlotEnd(t, Number(day.interval_minutes || 30)),
      booked_count: count,
      capacity: 3,
      available: count < 3
    };
  });
  res.json({ slots, day: { ...day, booking_date: bookingDate, day_name: dayName } });
});

app.get('/api/captcha', (_req, res) => {
  const c = createCaptcha();
  res.json({ image: c.image, challenge: c.code.split('').join(' '), token: c.token, hint: 'ادخل الرموز في الصورة' });
});

app.get('/api/precheck-booking', (_req, res) => {
  return res.status(405).json({
    success: false,
    message: 'Use POST /api/precheck-booking with JSON body: { phone, booking_date, branch_id }'
  });
});

app.post('/api/precheck-booking', async (req, res) => {
  const hardStopMs = Number(process.env.PRECHECK_HARD_TIMEOUT_MS || 9000);
  const hardStop = setTimeout(() => {
    if (!res.headersSent) {
      console.error('[ERR] /api/precheck-booking: hard-timeout reached');
      res.status(504).json({ success: false, message: 'انتهت مهلة التحقق المسبق. حاول مرة أخرى.' });
    }
  }, hardStopMs);

  try {
    const { phone, booking_date, branch_id } = req.body || {};
    if (!phone || !booking_date || !branch_id) return res.status(400).json({ success: false, message: 'Missing required fields' });
    if (!isValidPhone(phone)) return res.status(400).json({ success: false, message: 'رقم الهاتف يجب أن يبدأ بـ 09 ويتكون من 10 أرقام' });

    const data = await Promise.race([
      (getCooldownData ? getCooldownData() : read()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB_TIMEOUT_PRECHECK')), Number(process.env.PRECHECK_TIMEOUT_MS || 8000)))
    ]);
    const cooldown = checkBookingCooldown(data, { phone, booking_date, branch_id });
    if (cooldown.blocked) {
      return res.status(409).json({
        success: false,
        message: `لا يمكن الحجز الآن لنفس العميل. يمكنك الحجز بعد: ${cooldown.earliest}`,
        code: 'BOOKING_COOLDOWN',
        earliest_date: cooldown.earliest
      });
    }

    return res.json({ success: true });
  } catch (e) {
    console.error('[ERR] /api/precheck-booking:', e && (e.stack || e.message || e));
    if (String(e && e.message || '').includes('DB_TIMEOUT_PRECHECK')) {
      return res.status(504).json({ success: false, message: 'انتهت مهلة الاتصال بقاعدة البيانات أثناء التحقق. تحقق من MySQL ثم أعد المحاولة.' });
    }
    return res.status(500).json({ success: false, message: 'خطأ داخلي أثناء التحقق المسبق' });
  } finally {
    clearTimeout(hardStop);
  }
});

app.post('/api/send-otp', async (req, res) => {
  const { phone, full_name, transfer_number, captcha_answer, captcha_token } = req.body || {};
  if (!phone || !full_name || !transfer_number || !captcha_answer || !captcha_token) return res.status(400).json({ error: 'Missing fields' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'رقم الهاتف يجب أن يبدأ بـ 09 ويتكون من 10 أرقام' });
  if (!isValidFullName(full_name)) return res.status(400).json({ error: 'الاسم يجب أن يحتوي على محارف فقط بدون أرقام' });

  const data = await read();
  const locked = ensureNotLocked(data, phone);
  if (!locked.ok) return res.status(429).json({ error: locked.message });
  if (!verifyCaptcha(captcha_answer, captcha_token)) return res.status(400).json({ error: 'Captcha failed' });
  if (!canSendOtp(data, phone)) return res.status(429).json({ error: `Too many OTP requests. Max ${OTP_MAX_PER_WINDOW} every ${OTP_WINDOW_MINUTES} minutes` });

  const code = String(Math.floor(1000 + Math.random() * 9000));
  data.otp_codes.push({
    id: nextId(data, 'otp_codes'),
    phone,
    full_name: String(full_name || '').trim(),
    code,
    transfer_number,
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    used: 0,
    created_at: nowISO()
  });
  await write(data);

  try {
    const sms = await sendSmsOtp(phone, code);
    if (!sms.ok) return res.status(502).json({ error: 'SMS provider error', details: sms.text });
    return res.json({ ok: true, message: 'تم إرسال رمز التحقق بنجاح' });
  } catch {
    return res.status(502).json({ error: 'SMS send failed' });
  }
});

app.post('/api/book', async (req, res) => {
  const { transfer_number, branch_id, company_id, booking_date, slot_time, phone, full_name, otp_code } = req.body || {};
  if (!transfer_number || !branch_id || !company_id || !booking_date || !slot_time || !phone || !full_name || !otp_code) return res.status(400).json({ error: 'Missing required fields' });
  if (!isValidPhone(phone)) return res.status(400).json({ success: false, message: 'رقم الهاتف يجب أن يبدأ بـ 09 ويتكون من 10 أرقام' });
  if (!isValidFullName(full_name)) return res.status(400).json({ success: false, message: 'الاسم يجب أن يحتوي على محارف فقط بدون أرقام' });

  const data = await read();
  const locked = ensureNotLocked(data, phone);
  if (!locked.ok) return res.status(429).json({ success: false, message: 'تم قفل المحاولات مؤقتاً، حاول لاحقاً' });

  const cleanName = String(full_name || '').trim();
  const otp = [...data.otp_codes].reverse().find(o => o.phone === phone && o.transfer_number === transfer_number && o.code === otp_code);
  if (!otp || Number(otp.used) === 1) {
    const t = trackVerifyFail(data, phone);
    await write(data);
    if (t.locked) return res.status(429).json({ success: false, message: 'تم قفل المحاولات مؤقتاً بسبب كثرة الإدخال الخاطئ' });
    return res.status(400).json({ success: false, message: 'رمز التحقق غير صحيح' });
  }
  // OTP expiry check disabled per business request

  const dayName = EN_DAYS[fromYmd(booking_date).getDay()];
  const dayCfg = data.business_days.find(d => Number(d.branch_id) === Number(branch_id) && d.day_name === dayName && Number(d.active) === 1);
  if (!dayCfg) return res.status(400).json({ success: false, message: 'اليوم غير متاح للحجز' });

  const holidaysSet = new Set((data.holidays || []).map(h => h.date));
  if (holidaysSet.has(booking_date)) return res.status(400).json({ success: false, message: 'هذا اليوم عطلة ولا يمكن الحجز فيه' });

  const todayYmd = ymd(new Date());
  if (booking_date <= todayYmd) return res.status(400).json({ success: false, message: 'الحجز يبدأ من اليوم التالي للتاريخ الحالي' });

  const cooldown = checkBookingCooldown(data, { phone, booking_date, branch_id });
  if (cooldown.blocked) {
    return res.status(409).json({
      success: false,
      message: `لا يمكن الحجز الآن لنفس العميل. يمكنك الحجز بعد: ${cooldown.earliest}`,
      code: 'BOOKING_COOLDOWN',
      earliest_date: cooldown.earliest
    });
  }

  const sameSlotCount = data.appointments.filter(a => Number(a.branch_id) === Number(branch_id) && a.booking_date === booking_date && a.slot_time === slot_time && a.status === 'booked').length;
  if (sameSlotCount >= 3) return res.status(409).json({ success: false, message: 'هذه الشريحة ممتلئة، الرجاء اختيار وقت آخر' });

  data.appointments.push({
    id: nextId(data, 'appointments'),
    transfer_number,
    branch_id: Number(branch_id),
    company_id: Number(company_id),
    day_name: dayName,
    booking_date,
    slot_time,
    slot_to: calcSlotEnd(slot_time, Number(dayCfg.interval_minutes || 30)),
    phone,
    status: 'booked',
    created_at: nowISO()
  });
  otp.used = 1;
  resetVerifyFail(data, phone);
  await write(data);

  const branch = data.branches.find(b => Number(b.id) === Number(branch_id));
  const smsMessage = `السيد ${cleanName} تم حجز دور لمراجعة فرع ${branch?.name || ''} لاستلام حوالة ${transfer_number} من الساعة ${slot_time} إلى الساعة ${calcSlotEnd(slot_time, Number(dayCfg.interval_minutes || 30))} بتاريخ ${booking_date}.`;
  sendSmsRaw(phone, smsMessage).catch(() => {});

  return res.json({ success: true, message: 'تم حجز الموعد بنجاح' });
});

app.post('/api/admin/login', async (req, res) => {
  const { employee_no, password } = req.body || {};
  const loginId = String(employee_no || '').trim();
  if (!loginId) return res.status(400).json({ error: 'employee_no required' });
  const data = await read();
  const user = data.dashboard_users.find(u => String(u.employee_no || '') === loginId && Number(u.active) === 1);
  if (!user) return res.status(401).json({ error: 'رقم وظيفي غير موجود', code: 'EMPLOYEE_NOT_FOUND' });
  if (!bcrypt.compareSync(password || '', user.password_hash)) return res.status(401).json({ error: 'كلمة المرور غير صحيحة', code: 'WRONG_PASSWORD' });
  const role = normalizeRole(user.role);
  const token = jwt.sign({ id: user.id, username: user.username, employee_no: user.employee_no || null, role, branch_id: user.branch_id || null }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, role, branch_id: user.branch_id || null, employee_no: user.employee_no || null, username: user.username });
});

app.get('/api/admin/appointments', auth(ROLE_VIEW_APPOINTMENTS), async (req, res) => {
  const { branch_id, day_name } = req.query;
  const data = await read();
  let rows = data.appointments;

  if (req.user.role === 'branch_employee' || req.user.role === 'employee') {
    if (!req.user.branch_id) return res.status(403).json({ error: 'Employee account is not assigned to a branch' });
    rows = rows.filter(a => Number(a.branch_id) === Number(req.user.branch_id));
  } else if (req.user.role === 'manager' && MANAGER_SCOPED_TO_BRANCH) {
    if (!req.user.branch_id) return res.status(403).json({ error: 'Manager account is not assigned to a branch' });
    rows = rows.filter(a => Number(a.branch_id) === Number(req.user.branch_id));
  } else if (branch_id) rows = rows.filter(a => Number(a.branch_id) === Number(branch_id));
  if (day_name) rows = rows.filter(a => a.day_name === String(day_name));

  const out = rows.map(a => {
    const b = data.branches.find(x => Number(x.id) === Number(a.branch_id)) || {};
    const c = data.remittance_companies.find(x => Number(x.id) === Number(a.company_id)) || {};
    return { ...a, branch_name: b.name || '', branch_code: b.code || '', company_name: c.name || '' };
  }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

  res.json({ appointments: out });
});

app.delete('/api/admin/appointments/:id', auth(['admin', 'manager']), async (req, res) => {
  const data = await read();
  const row = data.appointments.find(a => Number(a.id) === Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'manager' && MANAGER_SCOPED_TO_BRANCH && Number(row.branch_id) !== Number(req.user.branch_id)) {
    return res.status(403).json({ error: 'Forbidden for other branch' });
  }
  row.status = 'cancelled';
  await write(data);
  res.json({ ok: true });
});

app.get('/api/admin/branches', auth(ROLE_ADMIN_LIKE), async (_req, res) => {
  const data = await read();
  res.json({ branches: [...data.branches].sort((a, b) => Number(b.id) - Number(a.id)) });
});

app.get('/api/admin/branches-lite', auth(['admin', 'manager', 'branch_employee', 'employee']), async (req, res) => {
  const data = await read();
  let rows = [...data.branches].filter(b => Number(b.active) === 1);
  if ((req.user.role === 'manager' || req.user.role === 'branch_employee' || req.user.role === 'employee') && req.user.branch_id) {
    rows = rows.filter(b => Number(b.id) === Number(req.user.branch_id));
  }
  res.json({ branches: rows.sort((a, b) => Number(a.id) - Number(b.id)) });
});

app.post('/api/admin/branches', auth(ROLE_ADMIN_LIKE), async (req, res) => {
  const { code, name, location } = req.body || {};
  if (!code || !name || !location) return res.status(400).json({ error: 'Missing fields' });
  const data = await read();
  data.branches.push({ id: nextId(data, 'branches'), code, name, location, active: 1 });
  await write(data);
  res.json({ ok: true });
});

app.put('/api/admin/branches/:id', auth(ROLE_ADMIN_LIKE), async (req, res) => {
  const data = await read();
  const row = data.branches.find(b => Number(b.id) === Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { code, name, location, active } = req.body || {};
  row.code = code; row.name = name; row.location = location; row.active = Number(active ? 1 : 0);
  await write(data);
  res.json({ ok: true });
});

app.delete('/api/admin/branches/:id', auth(ROLE_ADMIN_LIKE), async (req, res) => {
  const data = await read();
  data.branches = data.branches.filter(b => Number(b.id) !== Number(req.params.id));
  await write(data);
  res.json({ ok: true });
});

app.get('/api/admin/companies', auth(ROLE_ADMIN_LIKE), async (_req, res) => {
  const data = await read();
  res.json({ companies: [...data.remittance_companies].sort((a, b) => Number(b.id) - Number(a.id)) });
});

app.post('/api/admin/companies', auth(ROLE_ADMIN_LIKE), async (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const data = await read();
  data.remittance_companies.push({ id: nextId(data, 'remittance_companies'), name, description: description || '', active: 1 });
  await write(data);
  res.json({ ok: true });
});

app.put('/api/admin/companies/:id', auth(ROLE_ADMIN_LIKE), async (req, res) => {
  const data = await read();
  const row = data.remittance_companies.find(c => Number(c.id) === Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { name, description, active } = req.body || {};
  row.name = name; row.description = description || ''; row.active = Number(active ? 1 : 0);
  await write(data);
  res.json({ ok: true });
});

app.delete('/api/admin/companies/:id', auth(ROLE_ADMIN_LIKE), async (req, res) => {
  const data = await read();
  data.remittance_companies = data.remittance_companies.filter(c => Number(c.id) !== Number(req.params.id));
  await write(data);
  res.json({ ok: true });
});

app.get('/api/admin/business-days', auth(ROLE_DAY_MANAGE), async (req, res) => {
  const data = await read();
  let rows = data.business_days;
  if (req.user.role === 'branch_employee' || (req.user.role === 'manager' && MANAGER_SCOPED_TO_BRANCH)) rows = rows.filter(d => Number(d.branch_id) === Number(req.user.branch_id));
  else if (req.query.branch_id) rows = rows.filter(d => Number(d.branch_id) === Number(req.query.branch_id));
  res.json({ business_days: rows.sort((a, b) => Number(b.id) - Number(a.id)) });
});

app.post('/api/admin/business-days', auth(ROLE_DAY_MANAGE), async (req, res) => {
  const data = await read();
  let { branch_id, day_name, start_time, end_time, interval_minutes, active } = req.body || {};
  if (req.user.role === 'branch_employee' || (req.user.role === 'manager' && MANAGER_SCOPED_TO_BRANCH)) branch_id = req.user.branch_id;
  data.business_days.push({
    id: nextId(data, 'business_days'),
    branch_id: Number(branch_id),
    day_name,
    start_time,
    end_time,
    interval_minutes: Number(interval_minutes || 60),
    active: Number(active ?? 1)
  });
  await write(data);
  res.json({ ok: true });
});

app.put('/api/admin/business-days/:id', auth(ROLE_DAY_MANAGE), async (req, res) => {
  const data = await read();
  const row = data.business_days.find(d => Number(d.id) === Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if ((req.user.role === 'branch_employee' || (req.user.role === 'manager' && MANAGER_SCOPED_TO_BRANCH)) && Number(row.branch_id) !== Number(req.user.branch_id)) return res.status(403).json({ error: 'Forbidden for other branch' });
  let { branch_id, day_name, start_time, end_time, interval_minutes, active } = req.body || {};
  if (req.user.role === 'branch_employee' || (req.user.role === 'manager' && MANAGER_SCOPED_TO_BRANCH)) branch_id = req.user.branch_id;
  row.branch_id = Number(branch_id);
  row.day_name = day_name;
  row.start_time = start_time;
  row.end_time = end_time;
  row.interval_minutes = Number(interval_minutes || 60);
  row.active = Number(active ? 1 : 0);
  await write(data);
  res.json({ ok: true });
});

app.delete('/api/admin/business-days/:id', auth(ROLE_DAY_MANAGE), async (req, res) => {
  const data = await read();
  const row = data.business_days.find(d => Number(d.id) === Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if ((req.user.role === 'branch_employee' || (req.user.role === 'manager' && MANAGER_SCOPED_TO_BRANCH)) && Number(row.branch_id) !== Number(req.user.branch_id)) return res.status(403).json({ error: 'Forbidden for other branch' });
  data.business_days = data.business_days.filter(d => Number(d.id) !== Number(req.params.id));
  await write(data);
  res.json({ ok: true });
});

app.get('/api/admin/reports/daily', auth(['admin', 'manager']), async (req, res) => {
  const date = String(req.query.date || ymd(new Date()));
  const data = await read();
  const scopedBranchId = (req.user.role === 'manager' && MANAGER_SCOPED_TO_BRANCH) ? req.user.branch_id : null;
  const reports = buildLiveReportsForDate(data, date, scopedBranchId).sort((a, b) => Number(a.branch_id) - Number(b.branch_id));
  res.json({ reports });
});

app.post('/api/admin/reports/daily/generate', auth(['admin']), async (req, res) => {
  const date = String((req.body || {}).date || ymd(new Date()));
  const data = await read();
  const rows = buildLiveReportsForDate(data, date);
  data.daily_reports = data.daily_reports || [];

  for (const r of rows) {
    const exists = data.daily_reports.find(x => x.report_date === date && Number(x.branch_id) === Number(r.branch_id));
    if (exists) {
      exists.total_booked = r.total_booked;
      exists.payload = r.payload;
      exists.created_at = nowISO();
    } else {
      data.daily_reports.push({
        id: nextId(data, 'daily_reports'),
        report_date: date,
        branch_id: Number(r.branch_id),
        total_booked: r.total_booked,
        payload: r.payload,
        created_at: nowISO()
      });
    }
  }

  await sendDailyReportsEmailsIfNeeded(data, date);
  await write(data);
  res.json({ ok: true, generated: true, date, count: rows.length });
});

app.get('/api/admin/users', auth(['admin']), async (_req, res) => {
  const data = await read();
  const users = (data.dashboard_users || []).map(u => ({
    id: u.id,
    username: u.username,
    employee_no: u.employee_no || '',
    role: normalizeRole(u.role),
    branch_id: u.branch_id || null,
    report_email: u.report_email || '',
    active: Number(u.active || 0)
  })).sort((a, b) => Number(b.id) - Number(a.id));
  res.json({ users });
});

app.post('/api/admin/users', auth(['admin']), async (req, res) => {
  const data = await read();
  const { username, employee_no, role, branch_id, active, report_email } = req.body || {};
  const cleanUsername = String(username || '').trim();
  const cleanEmpNo = String(employee_no || '').trim();
  const cleanRole = normalizeRole(role);
  const cleanReportEmail = normalizeEmail(report_email);
  if (!cleanUsername) return res.status(400).json({ error: 'username required' });
  if (!['admin', 'manager', 'employee'].includes(cleanRole)) return res.status(400).json({ error: 'role must be admin, manager, or employee' });
  if ((cleanRole === 'employee' || (cleanRole === 'manager' && MANAGER_SCOPED_TO_BRANCH)) && !Number(branch_id)) return res.status(400).json({ error: 'branch_id required for this role' });
  if (data.dashboard_users.some(u => u.username === cleanUsername)) return res.status(409).json({ error: 'username already exists' });
  if (!isValidEmail(cleanReportEmail)) return res.status(400).json({ error: 'invalid report_email' });
  if (cleanEmpNo && !new RegExp(`^${EMPLOYEE_PREFIX}\\d+$`, 'i').test(cleanEmpNo)) return res.status(400).json({ error: `employee_no must start with ${EMPLOYEE_PREFIX}` });

  const employeeNo = (cleanEmpNo ? cleanEmpNo.toUpperCase() : generateEmployeeNo(data));
  if (data.dashboard_users.some(u => String(u.employee_no || '') === employeeNo)) return res.status(409).json({ error: 'employee_no already exists' });

  const passwordPlain = randomPassword(10);

  data.dashboard_users.push({
    id: nextId(data, 'dashboard_users'),
    username: cleanUsername,
    employee_no: employeeNo,
    report_email: cleanReportEmail || null,
    password_hash: bcrypt.hashSync(passwordPlain, 10),
    role: cleanRole,
    branch_id: (cleanRole === 'employee' || (cleanRole === 'manager' && MANAGER_SCOPED_TO_BRANCH)) ? Number(branch_id || 0) || null : null,
    active: Number(active ?? 1)
  });

  await write(data);
  return res.json({ ok: true, credentials: { username: cleanUsername, employee_no: employeeNo, password: passwordPlain } });
});

app.put('/api/admin/users/:id', auth(['admin']), async (req, res) => {
  const data = await read();
  const row = data.dashboard_users.find(u => Number(u.id) === Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { role, branch_id, active, reset_password, report_email } = req.body || {};

  const nextRole = role !== undefined ? normalizeRole(role) : normalizeRole(row.role);
  if (role !== undefined) {
    if (!['admin', 'manager', 'employee', 'branch_employee'].includes(nextRole)) return res.status(400).json({ error: 'invalid role' });
    row.role = nextRole;
  }
  if (branch_id !== undefined) row.branch_id = Number(branch_id || 0) || null;
  if ((nextRole === 'employee' || nextRole === 'branch_employee' || (nextRole === 'manager' && MANAGER_SCOPED_TO_BRANCH)) && !Number(row.branch_id || 0)) {
    return res.status(400).json({ error: 'branch_id required for this role' });
  }
  if (active !== undefined) row.active = Number(active ? 1 : 0);
  if (report_email !== undefined) {
    const cleanReportEmail = normalizeEmail(report_email);
    if (!isValidEmail(cleanReportEmail)) return res.status(400).json({ error: 'invalid report_email' });
    row.report_email = cleanReportEmail || null;
  }

  let newPassword = null;
  if (reset_password) {
    newPassword = randomPassword(10);
    row.password_hash = bcrypt.hashSync(newPassword, 10);
  }

  await write(data);
  res.json({ ok: true, new_password: newPassword });
});

app.delete('/api/admin/users/:id', auth(['admin']), async (req, res) => {
  const data = await read();
  const target = data.dashboard_users.find(u => Number(u.id) === Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (normalizeRole(target.role) === 'admin') return res.status(400).json({ error: 'cannot delete admin user' });
  data.dashboard_users = data.dashboard_users.filter(u => Number(u.id) !== Number(req.params.id));
  await write(data);
  res.json({ ok: true });
});

(async () => {
  try {
    await seedIfNeeded();
    await generateDailyReportsIfNeeded();
    setInterval(() => {
      generateDailyReportsIfNeeded().catch(() => {});
    }, 60 * 1000);

    app.listen(PORT, () => console.log(`Baraka booking running on http://localhost:${PORT} [driver=${process.env.STORAGE_DRIVER || 'json'}]`));
  } catch (e) {
    console.error('Failed to start application:', e.message);
    process.exit(1);
  }
})();
