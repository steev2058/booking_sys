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
      if (requiredRoles.length && !requiredRoles.includes(payload.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
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
  const days = db.prepare(
    'SELECT id,day_name,start_time,end_time,interval_minutes FROM business_days WHERE branch_id=? AND active=1 ORDER BY id'
  ).all(branchId);
  res.json({ days });
});

app.get('/api/slots', (req, res) => {
  const branchId = Number(req.query.branch_id);
  const dayName = String(req.query.day_name || '');
  if (!branchId || !dayName) return res.status(400).json({ error: 'branch_id/day_name required' });

  const day = db.prepare(
    'SELECT start_time,end_time,interval_minutes FROM business_days WHERE branch_id=? AND day_name=? AND active=1'
  ).get(branchId, dayName);
  if (!day) return res.status(404).json({ error: 'Day config not found' });

  const allSlots = makeSlots(day.start_time, day.end_time, day.interval_minutes || 60);
  const booked = db.prepare(
    "SELECT slot_time FROM appointments WHERE branch_id=? AND day_name=? AND status='booked'"
  ).all(branchId, dayName).map(r => r.slot_time);

  const slots = allSlots.map(t => ({ time: t, available: !booked.includes(t) }));
  res.json({ slots, day });
});

app.get('/api/captcha', (_req, res) => {
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  const token = Buffer.from(`${a + b}:${Date.now()}`).toString('base64');
  res.json({ question: `${a} + ${b} = ?`, token });
});

app.post('/api/send-otp', (req, res) => {
  const { phone, transfer_number, captcha_answer, captcha_token } = req.body || {};
  if (!phone || !transfer_number || !captcha_answer || !captcha_token) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  let sum;
  try {
    sum = Number(Buffer.from(captcha_token, 'base64').toString().split(':')[0]);
  } catch {
    return res.status(400).json({ error: 'Invalid captcha token' });
  }
  if (Number(captcha_answer) !== sum) return res.status(400).json({ error: 'Captcha failed' });

  const code = String(Math.floor(1000 + Math.random() * 9000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO otp_codes (phone,code,transfer_number,expires_at,used) VALUES (?,?,?,?,0)')
    .run(phone, code, transfer_number, expiresAt);

  // TODO: integrate real SMS provider
  console.log(`[OTP MOCK] phone=${phone} code=${code}`);
  res.json({ ok: true, message: 'OTP sent' });
});

app.post('/api/book', (req, res) => {
  const { transfer_number, branch_id, company_id, day_name, slot_time, phone, otp_code } = req.body || {};
  if (!transfer_number || !branch_id || !company_id || !day_name || !slot_time || !phone || !otp_code) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const otp = db.prepare(
    'SELECT id,expires_at,used FROM otp_codes WHERE phone=? AND transfer_number=? AND code=? ORDER BY id DESC LIMIT 1'
  ).get(phone, transfer_number, otp_code);

  if (!otp || otp.used) return res.status(400).json({ success: false, message: 'رمز التحقق غير صحيح' });
  if (new Date(otp.expires_at).getTime() < Date.now()) return res.status(400).json({ success: false, message: 'انتهت صلاحية رمز التحقق' });

  try {
    db.prepare(
      "INSERT INTO appointments (transfer_number,branch_id,company_id,day_name,slot_time,phone,status) VALUES (?,?,?,?,?,?,'booked')"
    ).run(transfer_number, Number(branch_id), Number(company_id), day_name, slot_time, phone);
    db.prepare('UPDATE otp_codes SET used=1 WHERE id=?').run(otp.id);
    return res.json({ success: true, message: 'تم حجز الموعد بنجاح' });
  } catch {
    return res.status(409).json({ success: false, message: 'فشل الحجز، الرجاء اختيار وقت آخر' });
  }
});

// Dashboard auth
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT id,username,password_hash,role,branch_id FROM dashboard_users WHERE username=? AND active=1').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password || '', user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, branch_id: user.branch_id || null }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, role: user.role });
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

  const rows = db.prepare(sql).all(...args);
  res.json({ appointments: rows });
});

app.delete('/api/admin/appointments/:id', auth(['admin']), (req, res) => {
  const id = Number(req.params.id);
  db.prepare("UPDATE appointments SET status='cancelled' WHERE id=?").run(id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Baraka booking running on http://localhost:${PORT}`);
});
