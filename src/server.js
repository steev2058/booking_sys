require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const { read, write, nextId, nowISO, seedIfNeeded } = require('./store');

seedIfNeeded();

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

function makeSlots(start, end, interval = 60) {
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

async function sendSmsOtp(phone, code) {
  const msg = `رمز التحقق الخاص بك هو: ${code}`;
  const qs = new URLSearchParams({ User: SMS_USER, Pass: SMS_PASS, From: SMS_FROM, Gsm: phone, Msg: msg, Lang: '0' });
  const url = `${SMS_ENDPOINT}?${qs.toString()}`;
  const r = await fetch(url, { method: 'GET' });
  const text = await r.text();
  return { ok: r.ok, text: (text || '').slice(0, 500) };
}

app.get('/api/branches', (_req, res) => {
  const data = read();
  res.json({ branches: data.branches.filter(b => b.active === 1).sort((a, b) => a.name.localeCompare(b.name)) });
});

app.get('/api/companies', (_req, res) => {
  const data = read();
  res.json({ companies: data.remittance_companies.filter(c => c.active === 1).sort((a, b) => a.name.localeCompare(b.name)) });
});

app.get('/api/business-days', (req, res) => {
  const branchId = Number(req.query.branch_id);
  if (!branchId) return res.status(400).json({ error: 'branch_id required' });
  const data = read();
  res.json({ days: data.business_days.filter(d => d.branch_id === branchId && d.active === 1) });
});

app.get('/api/slots', (req, res) => {
  const branchId = Number(req.query.branch_id);
  const dayName = String(req.query.day_name || '');
  if (!branchId || !dayName) return res.status(400).json({ error: 'branch_id/day_name required' });
  const data = read();
  const day = data.business_days.find(d => d.branch_id === branchId && d.day_name === dayName && d.active === 1);
  if (!day) return res.status(404).json({ error: 'Day config not found' });

  const allSlots = makeSlots(day.start_time, day.end_time, day.interval_minutes || 60);
  const booked = data.appointments.filter(a => a.branch_id === branchId && a.day_name === dayName && a.status === 'booked').map(a => a.slot_time);
  const slots = allSlots.map(t => ({ time: t, available: !booked.includes(t) }));
  res.json({ slots, day });
});

app.get('/api/captcha', (_req, res) => {
  const c = createCaptcha();
  res.json({
    image: c.image,
    challenge: c.code.split('').join(' '),
    token: c.token,
    hint: 'ادخل الرموز في الصورة'
  });
});

app.post('/api/send-otp', async (req, res) => {
  const { phone, transfer_number, captcha_answer, captcha_token } = req.body || {};
  if (!phone || !transfer_number || !captcha_answer || !captcha_token) return res.status(400).json({ error: 'Missing fields' });

  const data = read();
  const locked = ensureNotLocked(data, phone);
  if (!locked.ok) return res.status(429).json({ error: locked.message });
  if (!verifyCaptcha(captcha_answer, captcha_token)) return res.status(400).json({ error: 'Captcha failed' });
  if (!canSendOtp(data, phone)) return res.status(429).json({ error: `Too many OTP requests. Max ${OTP_MAX_PER_WINDOW} every ${OTP_WINDOW_MINUTES} minutes` });

  const code = String(Math.floor(1000 + Math.random() * 9000));
  data.otp_codes.push({
    id: nextId(data, 'otp_codes'),
    phone,
    code,
    transfer_number,
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    used: 0,
    created_at: nowISO()
  });
  write(data);

  try {
    const sms = await sendSmsOtp(phone, code);
    if (!sms.ok) return res.status(502).json({ error: 'SMS provider error', details: sms.text });
    return res.json({ ok: true, message: 'تم إرسال رمز التحقق بنجاح' });
  } catch {
    return res.status(502).json({ error: 'SMS send failed' });
  }
});

app.post('/api/book', (req, res) => {
  const { transfer_number, branch_id, company_id, day_name, slot_time, phone, otp_code } = req.body || {};
  if (!transfer_number || !branch_id || !company_id || !day_name || !slot_time || !phone || !otp_code) return res.status(400).json({ error: 'Missing required fields' });

  const data = read();
  const locked = ensureNotLocked(data, phone);
  if (!locked.ok) return res.status(429).json({ success: false, message: 'تم قفل المحاولات مؤقتاً، حاول لاحقاً' });

  const otp = [...data.otp_codes].reverse().find(o => o.phone === phone && o.transfer_number === transfer_number && o.code === otp_code);
  if (!otp || otp.used) {
    const t = trackVerifyFail(data, phone);
    write(data);
    if (t.locked) return res.status(429).json({ success: false, message: 'تم قفل المحاولات مؤقتاً بسبب كثرة الإدخال الخاطئ' });
    return res.status(400).json({ success: false, message: 'رمز التحقق غير صحيح' });
  }
  if (new Date(otp.expires_at).getTime() < Date.now()) return res.status(400).json({ success: false, message: 'انتهت صلاحية رمز التحقق' });

  const duplicate = data.appointments.find(a => a.branch_id === Number(branch_id) && a.day_name === day_name && a.slot_time === slot_time && a.status === 'booked');
  if (duplicate) return res.status(409).json({ success: false, message: 'فشل عملية الحجز يرجى اختيار وقت آخر' });

  data.appointments.push({
    id: nextId(data, 'appointments'),
    transfer_number,
    branch_id: Number(branch_id),
    company_id: Number(company_id),
    day_name,
    slot_time,
    phone,
    status: 'booked',
    created_at: nowISO()
  });
  otp.used = 1;
  resetVerifyFail(data, phone);
  write(data);
  return res.json({ success: true, message: 'تم حجز الموعد بنجاح' });
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const data = read();
  const user = data.dashboard_users.find(u => u.username === username && u.active === 1);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password || '', user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, branch_id: user.branch_id || null }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, role: user.role, branch_id: user.branch_id || null });
});

app.get('/api/admin/appointments', auth(['admin', 'branch_employee']), (req, res) => {
  const { branch_id, day_name } = req.query;
  const data = read();
  let rows = data.appointments;

  if (req.user.role === 'branch_employee') rows = rows.filter(a => a.branch_id === Number(req.user.branch_id));
  else if (branch_id) rows = rows.filter(a => a.branch_id === Number(branch_id));
  if (day_name) rows = rows.filter(a => a.day_name === String(day_name));

  const out = rows.map(a => {
    const b = data.branches.find(x => x.id === a.branch_id) || {};
    const c = data.remittance_companies.find(x => x.id === a.company_id) || {};
    return { ...a, branch_name: b.name || '', branch_code: b.code || '', company_name: c.name || '' };
  }).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  res.json({ appointments: out });
});

app.delete('/api/admin/appointments/:id', auth(['admin']), (req, res) => {
  const data = read();
  const row = data.appointments.find(a => a.id === Number(req.params.id));
  if (row) row.status = 'cancelled';
  write(data);
  res.json({ ok: true });
});

app.get('/api/admin/branches', auth(['admin']), (_req, res) => {
  const data = read();
  res.json({ branches: [...data.branches].sort((a, b) => b.id - a.id) });
});
app.post('/api/admin/branches', auth(['admin']), (req, res) => {
  const { code, name, location } = req.body || {};
  if (!code || !name || !location) return res.status(400).json({ error: 'Missing fields' });
  const data = read();
  data.branches.push({ id: nextId(data, 'branches'), code, name, location, active: 1 });
  write(data);
  res.json({ ok: true });
});
app.put('/api/admin/branches/:id', auth(['admin']), (req, res) => {
  const data = read();
  const row = data.branches.find(b => b.id === Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { code, name, location, active } = req.body || {};
  row.code = code; row.name = name; row.location = location; row.active = Number(active ? 1 : 0);
  write(data);
  res.json({ ok: true });
});
app.delete('/api/admin/branches/:id', auth(['admin']), (req, res) => {
  const data = read();
  data.branches = data.branches.filter(b => b.id !== Number(req.params.id));
  write(data);
  res.json({ ok: true });
});

app.get('/api/admin/companies', auth(['admin']), (_req, res) => {
  const data = read();
  res.json({ companies: [...data.remittance_companies].sort((a, b) => b.id - a.id) });
});
app.post('/api/admin/companies', auth(['admin']), (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const data = read();
  data.remittance_companies.push({ id: nextId(data, 'remittance_companies'), name, description: description || '', active: 1 });
  write(data);
  res.json({ ok: true });
});
app.put('/api/admin/companies/:id', auth(['admin']), (req, res) => {
  const data = read();
  const row = data.remittance_companies.find(c => c.id === Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { name, description, active } = req.body || {};
  row.name = name; row.description = description || ''; row.active = Number(active ? 1 : 0);
  write(data);
  res.json({ ok: true });
});
app.delete('/api/admin/companies/:id', auth(['admin']), (req, res) => {
  const data = read();
  data.remittance_companies = data.remittance_companies.filter(c => c.id !== Number(req.params.id));
  write(data);
  res.json({ ok: true });
});

app.get('/api/admin/business-days', auth(['admin', 'branch_employee']), (req, res) => {
  const data = read();
  let rows = data.business_days;
  if (req.user.role === 'branch_employee') rows = rows.filter(d => d.branch_id === Number(req.user.branch_id));
  else if (req.query.branch_id) rows = rows.filter(d => d.branch_id === Number(req.query.branch_id));
  res.json({ business_days: rows.sort((a, b) => b.id - a.id) });
});
app.post('/api/admin/business-days', auth(['admin', 'branch_employee']), (req, res) => {
  const data = read();
  let { branch_id, day_name, start_time, end_time, interval_minutes, active } = req.body || {};
  if (req.user.role === 'branch_employee') branch_id = req.user.branch_id;
  data.business_days.push({
    id: nextId(data, 'business_days'),
    branch_id: Number(branch_id),
    day_name,
    start_time,
    end_time,
    interval_minutes: Number(interval_minutes || 60),
    active: Number(active ?? 1)
  });
  write(data);
  res.json({ ok: true });
});
app.put('/api/admin/business-days/:id', auth(['admin', 'branch_employee']), (req, res) => {
  const data = read();
  const row = data.business_days.find(d => d.id === Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'branch_employee' && Number(row.branch_id) !== Number(req.user.branch_id)) return res.status(403).json({ error: 'Forbidden for other branch' });
  let { branch_id, day_name, start_time, end_time, interval_minutes, active } = req.body || {};
  if (req.user.role === 'branch_employee') branch_id = req.user.branch_id;
  row.branch_id = Number(branch_id);
  row.day_name = day_name;
  row.start_time = start_time;
  row.end_time = end_time;
  row.interval_minutes = Number(interval_minutes || 60);
  row.active = Number(active ? 1 : 0);
  write(data);
  res.json({ ok: true });
});
app.delete('/api/admin/business-days/:id', auth(['admin', 'branch_employee']), (req, res) => {
  const data = read();
  const row = data.business_days.find(d => d.id === Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'branch_employee' && Number(row.branch_id) !== Number(req.user.branch_id)) return res.status(403).json({ error: 'Forbidden for other branch' });
  data.business_days = data.business_days.filter(d => d.id !== Number(req.params.id));
  write(data);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Baraka booking running on http://localhost:${PORT}`));
