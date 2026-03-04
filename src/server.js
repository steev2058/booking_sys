require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const { read, write, nextId, nowISO, seedIfNeeded } = require('./store');

const app = express();
const PORT = process.env.PORT || 8090;
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_secret';
const SMS_ENDPOINT = process.env.SMS_ENDPOINT || 'https://services.mtnsyr.com:7443/General/MTNSERVICES/ConcatenatedSender.aspx';
const SMS_USER = process.env.SMS_USER || 'ALbaraka2013';
const SMS_PASS = process.env.SMS_PASS || 'Jj2013';
const SMS_FROM = process.env.SMS_FROM || 'AL-Baraka';

const OTP_WINDOW_MINUTES = Number(process.env.OTP_WINDOW_MINUTES || 10);
const OTP_MAX_PER_WINDOW = Number(process.env.OTP_MAX_PER_WINDOW || 5);
const OTP_MAX_VERIFY_ATTEMPTS = Number(process.env.OTP_MAX_VERIFY_ATTEMPTS || 5);
const OTP_LOCK_MINUTES = Number(process.env.OTP_LOCK_MINUTES || 30);
const EMPLOYEE_PREFIX = process.env.EMPLOYEE_PREFIX || '50';

const ROLE_ADMIN_LIKE = ['admin'];
const ROLE_VIEW_APPOINTMENTS = ['admin', 'manager', 'employee', 'branch_employee'];
const ROLE_DAY_MANAGE = ['admin', 'manager', 'branch_employee'];
const MANAGER_SCOPED_TO_BRANCH = String(process.env.MANAGER_SCOPED_TO_BRANCH || '1') === '1';

app.use(cors());
app.use(express.json());
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
  let added = 0;
  while (added < daysToAdd) {
    d.setDate(d.getDate() + 1);
    const en = EN_DAYS[d.getDay()];
    const key = ymd(d);
    if (allowedDayNames.includes(en) && !holidaysSet.has(key)) added += 1;
  }
  return ymd(d);
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
  const chars = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
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
  return /^\d{10}$/.test(String(phone || '').trim());
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
  const list = (data.dashboard_users || [])
    .map(u => String(u.employee_no || ''))
    .filter(v => v.startsWith(EMPLOYEE_PREFIX) && /^\d+$/.test(v))
    .map(v => Number(v));
  const max = list.length ? Math.max(...list) : Number(`${EMPLOYEE_PREFIX}000`);
  return String(max + 1);
}

function getSec(data, phone) {
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
  // Friday is non-working by default
  for (const row of data.business_days.filter(d => Number(d.branch_id) === Number(branchId) && d.day_name === 'Friday')) {
    row.active = 0;
  }
}

function calcSlotEnd(slotStart, minutes = 30) {
  const [h, m] = String(slotStart).split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

async function sendSmsRaw(phone, msg) {
  const qs = new URLSearchParams({ User: SMS_USER, Pass: SMS_PASS, From: SMS_FROM, Gsm: phone, Msg: msg, Lang: '0' });
  const url = `${SMS_ENDPOINT}?${qs.toString()}`;
  const r = await fetch(url, { method: 'GET' });
  const text = await r.text();
  return { ok: r.ok, text: (text || '').slice(0, 500) };
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

app.post('/api/send-otp', async (req, res) => {
  const { phone, full_name, transfer_number, captcha_answer, captcha_token } = req.body || {};
  if (!phone || !full_name || !transfer_number || !captcha_answer || !captcha_token) return res.status(400).json({ error: 'Missing fields' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'Phone must be exactly 10 digits' });

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
  const { transfer_number, branch_id, company_id, booking_date, slot_time, phone, full_name, otp_code, captcha_answer, captcha_token } = req.body || {};
  if (!transfer_number || !branch_id || !company_id || !booking_date || !slot_time || !phone || !full_name || !otp_code || !captcha_answer || !captcha_token) return res.status(400).json({ error: 'Missing required fields' });
  if (!isValidPhone(phone)) return res.status(400).json({ success: false, message: 'رقم الهاتف يجب أن يكون 10 خانات' });

  const data = await read();
  const locked = ensureNotLocked(data, phone);
  if (!locked.ok) return res.status(429).json({ success: false, message: 'تم قفل المحاولات مؤقتاً، حاول لاحقاً' });
  if (!verifyCaptcha(captcha_answer, captcha_token)) return res.status(400).json({ success: false, message: 'فشل التحقق من الكابتشا' });

  const cleanName = String(full_name || '').trim();
  const otp = [...data.otp_codes].reverse().find(o => o.phone === phone && o.transfer_number === transfer_number && o.code === otp_code);
  if (!otp || Number(otp.used) === 1) {
    const t = trackVerifyFail(data, phone);
    await write(data);
    if (t.locked) return res.status(429).json({ success: false, message: 'تم قفل المحاولات مؤقتاً بسبب كثرة الإدخال الخاطئ' });
    return res.status(400).json({ success: false, message: 'رمز التحقق غير صحيح' });
  }
  if (new Date(otp.expires_at).getTime() < Date.now()) return res.status(400).json({ success: false, message: 'انتهت صلاحية رمز التحقق' });

  const dayName = EN_DAYS[fromYmd(booking_date).getDay()];
  const dayCfg = data.business_days.find(d => Number(d.branch_id) === Number(branch_id) && d.day_name === dayName && Number(d.active) === 1);
  if (!dayCfg) return res.status(400).json({ success: false, message: 'اليوم غير متاح للحجز' });

  const holidaysSet = new Set((data.holidays || []).map(h => h.date));
  if (holidaysSet.has(booking_date)) return res.status(400).json({ success: false, message: 'هذا اليوم عطلة ولا يمكن الحجز فيه' });

  const allowedDayNames = data.business_days
    .filter(d => Number(d.branch_id) === Number(branch_id) && Number(d.active) === 1)
    .map(d => d.day_name);

  const relatedBookings = data.appointments.filter(a => a.status === 'booked' && (String(a.phone || '') === String(phone) || String(a.full_name || '') === cleanName));
  for (const b of relatedBookings) {
    if (!b.booking_date) continue;
    const earliest = addWorkingDays(b.booking_date, 2, allowedDayNames, holidaysSet);
    if (booking_date < earliest) {
      return res.status(409).json({
        success: false,
        message: `لا يمكن حجز موعد جديد قبل يومي عمل. أقرب تاريخ متاح: ${earliest}`
      });
    }
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
    full_name: cleanName,
    status: 'booked',
    created_at: nowISO()
  });
  otp.used = 1;
  resetVerifyFail(data, phone);
  await write(data);

  const branch = data.branches.find(b => Number(b.id) === Number(branch_id));
  const smsMessage = `السيد ${cleanName} تم حجز دور لمراجعة فرع ${branch?.name || ''} لاستلام حوالة ${transfer_number} من الساعة ${slot_time} إلى الساعة ${calcSlotEnd(slot_time, Number(dayCfg.interval_minutes || 30))} بتاريخ ${booking_date}.`;
  try {
    await sendSmsRaw(phone, smsMessage);
  } catch {
    // ignore confirmation SMS errors so booking remains confirmed
  }

  return res.json({ success: true, message: 'تم حجز الموعد بنجاح' });
});

app.post('/api/admin/login', async (req, res) => {
  const { username, employee_no, password } = req.body || {};
  const loginId = String(employee_no || username || '').trim();
  const data = await read();
  const user = data.dashboard_users.find(u => (u.username === loginId || String(u.employee_no || '') === loginId) && Number(u.active) === 1);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password || '', user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
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

app.delete('/api/admin/appointments/:id', auth(ROLE_ADMIN_LIKE), async (req, res) => {
  const data = await read();
  const row = data.appointments.find(a => Number(a.id) === Number(req.params.id));
  if (row) row.status = 'cancelled';
  await write(data);
  res.json({ ok: true });
});

app.get('/api/admin/branches', auth(ROLE_ADMIN_LIKE), async (_req, res) => {
  const data = await read();
  res.json({ branches: [...data.branches].sort((a, b) => Number(b.id) - Number(a.id)) });
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

app.get('/api/admin/users', auth(['admin']), async (_req, res) => {
  const data = await read();
  const users = (data.dashboard_users || []).map(u => ({
    id: u.id,
    username: u.username,
    employee_no: u.employee_no || '',
    full_name: u.full_name || '',
    role: normalizeRole(u.role),
    branch_id: u.branch_id || null,
    active: Number(u.active || 0)
  })).sort((a, b) => Number(b.id) - Number(a.id));
  res.json({ users });
});

app.post('/api/admin/users', auth(['admin']), async (req, res) => {
  const data = await read();
  const { username, full_name, role, branch_id, active } = req.body || {};
  const cleanUsername = String(username || '').trim();
  const cleanName = String(full_name || '').trim();
  const cleanRole = normalizeRole(role);
  if (!cleanUsername || !cleanName) return res.status(400).json({ error: 'username/full_name required' });
  if (!['manager', 'employee'].includes(cleanRole)) return res.status(400).json({ error: 'role must be manager or employee' });
  if ((cleanRole === 'employee' || (cleanRole === 'manager' && MANAGER_SCOPED_TO_BRANCH)) && !Number(branch_id)) return res.status(400).json({ error: 'branch_id required for this role' });
  if (data.dashboard_users.some(u => u.username === cleanUsername)) return res.status(409).json({ error: 'username already exists' });

  const employeeNo = generateEmployeeNo(data);
  const passwordPlain = randomPassword(10);

  data.dashboard_users.push({
    id: nextId(data, 'dashboard_users'),
    username: cleanUsername,
    employee_no: employeeNo,
    full_name: cleanName,
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
  const { full_name, role, branch_id, active, reset_password } = req.body || {};

  if (full_name !== undefined) row.full_name = String(full_name || '').trim();
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
    app.listen(PORT, () => console.log(`Baraka booking running on http://localhost:${PORT} [driver=${process.env.STORAGE_DRIVER || 'json'}]`));
  } catch (e) {
    console.error('Failed to start application:', e.message);
    process.exit(1);
  }
})();
