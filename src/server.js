require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');

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

db.exec(`
CREATE TABLE IF NOT EXISTS otp_security (
  phone TEXT PRIMARY KEY,
  send_count INTEGER DEFAULT 0,
  window_start TEXT,
  verify_fail_count INTEGER DEFAULT 0,
  locked_until TEXT
);
`);

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
    const h = Math.floor(cur / 60).toString().padStart(2, '0');
    const m = (cur % 60).toString().padStart(2, '0');
    out.push(`${h}:${m}`);
    cur += interval;
  }
  return out;
}

function createCaptcha() {
  const chars = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  const token = Buffer.from(`${code}:${Date.now() + 2 * 60 * 1000}`).toString('base64');
  return { code, token };
}

function verifyCaptcha(answer, token) {
  try {
    const [code, exp] = Buffer.from(token, 'base64').toString().split(':');
    if (!code || !exp) return false;
    if (Date.now() > Number(exp)) return false;
    return String(answer || '').trim().toUpperCase() === String(code).trim().toUpperCase();
  } catch {
    return false;
  }
}

function getSecurity(phone) {
  let row = db.prepare('SELECT * FROM otp_security WHERE phone=?').get(phone);
  if (!row) {
    db.prepare('INSERT INTO otp_security (phone,send_count,window_start,verify_fail_count,locked_until) VALUES (?,?,?,?,?)')
      .run(phone, 0, new Date().toISOString(), 0, null);
    row = db.prepare('SELECT * FROM otp_security WHERE phone=?').get(phone);
  }
  return row;
}

function ensureNotLocked(phone) {
  const sec = getSecurity(phone);
  if (sec.locked_until && new Date(sec.locked_until).getTime() > Date.now()) {
    return { ok: false, message: `Too many attempts. Try again after ${sec.locked_until}` };
  }
  return { ok: true };
}

function canSendOtp(phone) {
  const sec = getSecurity(phone);
  const now = Date.now();
  const windowMs = OTP_WINDOW_MINUTES * 60 * 1000;
  const ws = sec.window_start ? new Date(sec.window_start).getTime() : 0;

  if (!ws || now - ws > windowMs) {
    db.prepare('UPDATE otp_security SET send_count=?,window_start=? WHERE phone=?').run(0, new Date().toISOString(), phone);
  }

  const sec2 = getSecurity(phone);
  if (sec2.send_count >= OTP_MAX_PER_WINDOW) return false;
  db.prepare('UPDATE otp_security SET send_count=send_count+1 WHERE phone=?').run(phone);
  return true;
}

function trackVerifyFail(phone) {
  const sec = getSecurity(phone);
  const fail = Number(sec.verify_fail_count || 0) + 1;
  if (fail >= OTP_MAX_VERIFY_ATTEMPTS) {
    const lockedUntil = new Date(Date.now() + OTP_LOCK_MINUTES * 60 * 1000).toISOString();
    db.prepare('UPDATE otp_security SET verify_fail_count=?,locked_until=? WHERE phone=?').run(0, lockedUntil, phone);
    return { locked: true, lockedUntil };
  }
  db.prepare('UPDATE otp_security SET verify_fail_count=? WHERE phone=?').run(fail, phone);
  return { locked: false };
}

function resetVerifyFail(phone) {
  db.prepare('UPDATE otp_security SET verify_fail_count=?,locked_until=? WHERE phone=?').run(0, null, phone);
}

async function sendSmsOtp(phone, code) {
  const msg = `رمز التحقق الخاص بك هو: ${code}`;
  const qs = new URLSearchParams({ User: SMS_USER, Pass: SMS_PASS, From: SMS_FROM, Gsm: phone, Msg: msg, Lang: '0' });
  const url = `${SMS_ENDPOINT}?${qs.toString()}`;
  const r = await fetch(url, { method: 'GET' });
  const text = await r.text();
  return { ok: r.ok, text: (text || '').slice(0, 500) };
}

// Public APIs
app.get('/api/branches', (_req, res) => {
  const branches = db.prepare('SELECT id,code,name,location FROM branches WHERE active=1 ORDER BY name').all();
  res.json({ branches });
});

app.get('/api/companies', (_req, res) => {
  const companies = db.prepare('SELECT id,name,description FROM remittance_companies WHERE active=1 ORDER BY name').all();
  res.json({ companies });
});

app.get('/api/business-days', (req, res) => {
  const branchId = Number(req.query.branch_id);
  if (!branchId) return res.status(400).json({ error: 'branch_id required' });
  const days = db.prepare('SELECT id,day_name,start_time,end_time,interval_minutes FROM business_days WHERE branch_id=? AND active=1 ORDER BY id').all(branchId);
  res.json({ days });
});

app.get('/api/slots', (req, res) => {
  const branchId = Number(req.query.branch_id);
  const dayName = String(req.query.day_name || '');
  if (!branchId || !dayName) return res.status(400).json({ error: 'branch_id/day_name required' });

  const day = db.prepare('SELECT start_time,end_time,interval_minutes FROM business_days WHERE branch_id=? AND day_name=? AND active=1').get(branchId, dayName);
  if (!day) return res.status(404).json({ error: 'Day config not found' });

  const allSlots = makeSlots(day.start_time, day.end_time, day.interval_minutes || 60);
  const booked = db.prepare("SELECT slot_time FROM appointments WHERE branch_id=? AND day_name=? AND status='booked'").all(branchId, dayName).map(r => r.slot_time);
  const slots = allSlots.map(t => ({ time: t, available: !booked.includes(t) }));
  res.json({ slots, day });
});

app.get('/api/captcha', (_req, res) => {
  const c = createCaptcha();
  res.json({ challenge: c.code.split('').join(' '), token: c.token, hint: 'اكتب الأحرف/الأرقام بدون فراغات' });
});

app.post('/api/send-otp', async (req, res) => {
  const { phone, transfer_number, captcha_answer, captcha_token } = req.body || {};
  if (!phone || !transfer_number || !captcha_answer || !captcha_token) return res.status(400).json({ error: 'Missing fields' });

  const locked = ensureNotLocked(phone);
  if (!locked.ok) return res.status(429).json({ error: locked.message });

  if (!verifyCaptcha(captcha_answer, captcha_token)) return res.status(400).json({ error: 'Captcha failed' });
  if (!canSendOtp(phone)) return res.status(429).json({ error: `Too many OTP requests. Max ${OTP_MAX_PER_WINDOW} every ${OTP_WINDOW_MINUTES} minutes` });

  const code = String(Math.floor(1000 + Math.random() * 9000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO otp_codes (phone,code,transfer_number,expires_at,used) VALUES (?,?,?,?,0)').run(phone, code, transfer_number, expiresAt);

  try {
    const sms = await sendSmsOtp(phone, code);
    if (!sms.ok) {
      console.log('[SMS ERROR]', sms.text);
      return res.status(502).json({ error: 'SMS provider error', details: sms.text });
    }
    return res.json({ ok: true, message: 'تم إرسال رمز التحقق بنجاح' });
  } catch (e) {
    console.log('[SMS EXCEPTION]', String(e?.message || e));
    return res.status(502).json({ error: 'SMS send failed' });
  }
});

app.post('/api/book', (req, res) => {
  const { transfer_number, branch_id, company_id, day_name, slot_time, phone, otp_code } = req.body || {};
  if (!transfer_number || !branch_id || !company_id || !day_name || !slot_time || !phone || !otp_code) return res.status(400).json({ error: 'Missing required fields' });

  const locked = ensureNotLocked(phone);
  if (!locked.ok) return res.status(429).json({ success: false, message: 'تم قفل المحاولات مؤقتاً، حاول لاحقاً' });

  const otp = db.prepare('SELECT id,expires_at,used FROM otp_codes WHERE phone=? AND transfer_number=? AND code=? ORDER BY id DESC LIMIT 1').get(phone, transfer_number, otp_code);
  if (!otp || otp.used) {
    const t = trackVerifyFail(phone);
    if (t.locked) return res.status(429).json({ success: false, message: 'تم قفل المحاولات مؤقتاً بسبب كثرة الإدخال الخاطئ' });
    return res.status(400).json({ success: false, message: 'رمز التحقق غير صحيح' });
  }
  if (new Date(otp.expires_at).getTime() < Date.now()) return res.status(400).json({ success: false, message: 'انتهت صلاحية رمز التحقق' });

  try {
    db.prepare("INSERT INTO appointments (transfer_number,branch_id,company_id,day_name,slot_time,phone,status) VALUES (?,?,?,?,?,?,'booked')").run(transfer_number, Number(branch_id), Number(company_id), day_name, slot_time, phone);
    db.prepare('UPDATE otp_codes SET used=1 WHERE id=?').run(otp.id);
    resetVerifyFail(phone);
    return res.json({ success: true, message: 'تم حجز الموعد بنجاح' });
  } catch {
    return res.status(409).json({ success: false, message: 'فشل عملية الحجز يرجى اختيار وقت آخر' });
  }
});

// Admin auth
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT id,username,password_hash,role,branch_id FROM dashboard_users WHERE username=? AND active=1').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password || '', user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, branch_id: user.branch_id || null }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, role: user.role, branch_id: user.branch_id || null });
});

app.get('/api/admin/appointments', auth(['admin', 'branch_employee']), (req, res) => {
  const { branch_id, day_name } = req.query;
  const where = [];
  const args = [];

  if (req.user.role === 'branch_employee') {
    where.push('a.branch_id=?');
    args.push(req.user.branch_id);
  } else if (branch_id) {
    where.push('a.branch_id=?');
    args.push(Number(branch_id));
  }
  if (day_name) {
    where.push('a.day_name=?');
    args.push(String(day_name));
  }

  const sql = `
    SELECT a.id,a.transfer_number,a.day_name,a.slot_time,a.phone,a.status,a.created_at,
           b.name as branch_name,b.code as branch_code,
           c.name as company_name
    FROM appointments a
    JOIN branches b ON b.id=a.branch_id
    JOIN remittance_companies c ON c.id=a.company_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.created_at DESC
  `;
  res.json({ appointments: db.prepare(sql).all(...args) });
});

app.delete('/api/admin/appointments/:id', auth(['admin']), (req, res) => {
  db.prepare("UPDATE appointments SET status='cancelled' WHERE id=?").run(Number(req.params.id));
  res.json({ ok: true });
});

// Branches CRUD (admin only)
app.get('/api/admin/branches', auth(['admin']), (_req, res) => {
  res.json({ branches: db.prepare('SELECT id,code,name,location,active FROM branches ORDER BY id DESC').all() });
});
app.post('/api/admin/branches', auth(['admin']), (req, res) => {
  const { code, name, location } = req.body || {};
  if (!code || !name || !location) return res.status(400).json({ error: 'Missing fields' });
  db.prepare('INSERT INTO branches (code,name,location,active) VALUES (?,?,?,1)').run(code, name, location);
  res.json({ ok: true });
});
app.put('/api/admin/branches/:id', auth(['admin']), (req, res) => {
  const { code, name, location, active } = req.body || {};
  db.prepare('UPDATE branches SET code=?,name=?,location=?,active=? WHERE id=?').run(code, name, location, Number(active ? 1 : 0), Number(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/admin/branches/:id', auth(['admin']), (req, res) => {
  db.prepare('DELETE FROM branches WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Companies CRUD (admin only)
app.get('/api/admin/companies', auth(['admin']), (_req, res) => {
  res.json({ companies: db.prepare('SELECT id,name,description,active FROM remittance_companies ORDER BY id DESC').all() });
});
app.post('/api/admin/companies', auth(['admin']), (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  db.prepare('INSERT INTO remittance_companies (name,description,active) VALUES (?,?,1)').run(name, description || '');
  res.json({ ok: true });
});
app.put('/api/admin/companies/:id', auth(['admin']), (req, res) => {
  const { name, description, active } = req.body || {};
  db.prepare('UPDATE remittance_companies SET name=?,description=?,active=? WHERE id=?').run(name, description || '', Number(active ? 1 : 0), Number(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/admin/companies/:id', auth(['admin']), (req, res) => {
  db.prepare('DELETE FROM remittance_companies WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Business days CRUD (admin + branch employee limited)
app.get('/api/admin/business-days', auth(['admin', 'branch_employee']), (req, res) => {
  if (req.user.role === 'branch_employee') {
    const rows = db.prepare('SELECT id,branch_id,day_name,start_time,end_time,interval_minutes,active FROM business_days WHERE branch_id=? ORDER BY id DESC').all(req.user.branch_id);
    return res.json({ business_days: rows });
  }
  const branchId = req.query.branch_id ? Number(req.query.branch_id) : null;
  const rows = branchId
    ? db.prepare('SELECT id,branch_id,day_name,start_time,end_time,interval_minutes,active FROM business_days WHERE branch_id=? ORDER BY id DESC').all(branchId)
    : db.prepare('SELECT id,branch_id,day_name,start_time,end_time,interval_minutes,active FROM business_days ORDER BY id DESC').all();
  res.json({ business_days: rows });
});

app.post('/api/admin/business-days', auth(['admin', 'branch_employee']), (req, res) => {
  let { branch_id, day_name, start_time, end_time, interval_minutes, active } = req.body || {};
  if (req.user.role === 'branch_employee') branch_id = req.user.branch_id;
  db.prepare('INSERT INTO business_days (branch_id,day_name,start_time,end_time,interval_minutes,active) VALUES (?,?,?,?,?,?)')
    .run(Number(branch_id), day_name, start_time, end_time, Number(interval_minutes || 60), Number(active ?? 1));
  res.json({ ok: true });
});

app.put('/api/admin/business-days/:id', auth(['admin', 'branch_employee']), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id,branch_id FROM business_days WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'branch_employee' && Number(existing.branch_id) !== Number(req.user.branch_id)) {
    return res.status(403).json({ error: 'Forbidden for other branch' });
  }

  let { branch_id, day_name, start_time, end_time, interval_minutes, active } = req.body || {};
  if (req.user.role === 'branch_employee') branch_id = req.user.branch_id;

  db.prepare('UPDATE business_days SET branch_id=?,day_name=?,start_time=?,end_time=?,interval_minutes=?,active=? WHERE id=?')
    .run(Number(branch_id), day_name, start_time, end_time, Number(interval_minutes || 60), Number(active ? 1 : 0), id);
  res.json({ ok: true });
});

app.delete('/api/admin/business-days/:id', auth(['admin', 'branch_employee']), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id,branch_id FROM business_days WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'branch_employee' && Number(existing.branch_id) !== Number(req.user.branch_id)) {
    return res.status(403).json({ error: 'Forbidden for other branch' });
  }
  db.prepare('DELETE FROM business_days WHERE id=?').run(id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Baraka booking running on http://localhost:${PORT}`));
