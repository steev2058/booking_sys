const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

function nowISO() {
  return new Date().toISOString();
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'booking_user',
  password: process.env.DB_PASS || 'booking_pass',
  database: process.env.DB_NAME || 'booking_sys',
  waitForConnections: true,
  connectionLimit: 10
});

const TABLE_KEYS = ['branches', 'remittance_companies', 'business_days', 'appointments', 'dashboard_users', 'otp_codes'];

function normalizeDate(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

async function read() {
  const [branches] = await pool.query('SELECT * FROM branches');
  const [companies] = await pool.query('SELECT * FROM remittance_companies');
  const [days] = await pool.query('SELECT * FROM business_days');
  const [appointments] = await pool.query('SELECT * FROM appointments');
  const [users] = await pool.query('SELECT * FROM dashboard_users');
  const [otpCodes] = await pool.query('SELECT * FROM otp_codes');
  const [otpSecurity] = await pool.query('SELECT * FROM otp_security');

  const data = {
    branches,
    remittance_companies: companies,
    business_days: days,
    appointments: appointments.map(r => ({ ...r, created_at: normalizeDate(r.created_at) })),
    dashboard_users: users,
    otp_codes: otpCodes.map(r => ({ ...r, expires_at: normalizeDate(r.expires_at), created_at: normalizeDate(r.created_at) })),
    otp_security: otpSecurity.map(r => ({ ...r, window_start: normalizeDate(r.window_start), locked_until: normalizeDate(r.locked_until) }))
  };

  data.counters = {};
  for (const k of TABLE_KEYS) {
    const max = (data[k] || []).reduce((m, row) => Math.max(m, Number(row.id || 0)), 0);
    data.counters[k] = max + 1;
  }

  return data;
}

function toMysqlDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function write(data) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query('DELETE FROM appointments');
    await conn.query('DELETE FROM business_days');
    await conn.query('DELETE FROM branches');
    await conn.query('DELETE FROM dashboard_users');
    await conn.query('DELETE FROM otp_codes');
    await conn.query('DELETE FROM otp_security');
    await conn.query('DELETE FROM remittance_companies');

    for (const r of data.branches || []) {
      await conn.query('INSERT INTO branches (id, code, name, location, active) VALUES (?,?,?,?,?)', [r.id, r.code, r.name, r.location, Number(r.active || 0)]);
    }
    for (const r of data.remittance_companies || []) {
      await conn.query('INSERT INTO remittance_companies (id, name, description, active) VALUES (?,?,?,?)', [r.id, r.name, r.description || '', Number(r.active || 0)]);
    }
    for (const r of data.business_days || []) {
      await conn.query('INSERT INTO business_days (id, branch_id, day_name, start_time, end_time, interval_minutes, active) VALUES (?,?,?,?,?,?,?)', [r.id, r.branch_id, r.day_name, r.start_time, r.end_time, Number(r.interval_minutes || 60), Number(r.active || 0)]);
    }
    for (const r of data.appointments || []) {
      await conn.query('INSERT INTO appointments (id, transfer_number, branch_id, company_id, day_name, slot_time, phone, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)', [r.id, r.transfer_number, r.branch_id, r.company_id, r.day_name, r.slot_time, r.phone, r.status || 'booked', toMysqlDate(r.created_at)]);
    }
    for (const r of data.dashboard_users || []) {
      await conn.query('INSERT INTO dashboard_users (id, username, password_hash, role, branch_id, active) VALUES (?,?,?,?,?,?)', [r.id, r.username, r.password_hash, r.role, r.branch_id || null, Number(r.active || 0)]);
    }
    for (const r of data.otp_codes || []) {
      await conn.query('INSERT INTO otp_codes (id, phone, code, transfer_number, expires_at, used, created_at) VALUES (?,?,?,?,?,?,?)', [r.id, r.phone, r.code, r.transfer_number, toMysqlDate(r.expires_at), Number(r.used || 0), toMysqlDate(r.created_at)]);
    }
    for (const r of data.otp_security || []) {
      await conn.query('INSERT INTO otp_security (phone, send_count, window_start, verify_fail_count, locked_until) VALUES (?,?,?,?,?)', [r.phone, Number(r.send_count || 0), toMysqlDate(r.window_start), Number(r.verify_fail_count || 0), toMysqlDate(r.locked_until)]);
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

function nextId(data, key) {
  const n = Number(data.counters[key] || 1);
  data.counters[key] = n + 1;
  return n;
}

async function seedIfNeeded() {
  const d = await read();

  if (!d.branches.length) {
    d.branches.push({ id: nextId(d, 'branches'), code: 'DAM01', name: 'فرع دمشق الرئيسي', location: 'دمشق - ساحة الأمويين', active: 1 });
    d.branches.push({ id: nextId(d, 'branches'), code: 'HOM01', name: 'فرع حمص', location: 'حمص - شارع الحضارة', active: 1 });
    d.branches.push({ id: nextId(d, 'branches'), code: 'ALE01', name: 'فرع حلب', location: 'حلب - الفرقان', active: 1 });
  }

  if (!d.remittance_companies.length) {
    d.remittance_companies.push({ id: nextId(d, 'remittance_companies'), name: 'ويسترن يونيون', description: 'استلام حوالات ويسترن يونيون', active: 1 });
    d.remittance_companies.push({ id: nextId(d, 'remittance_companies'), name: 'موني جرام', description: 'استلام حوالات موني جرام', active: 1 });
    d.remittance_companies.push({ id: nextId(d, 'remittance_companies'), name: 'حوالاتي', description: 'حوالات داخلية وخارجية', active: 1 });
  }

  if (!d.business_days.length) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
    for (const b of d.branches) {
      for (const day of days) {
        d.business_days.push({
          id: nextId(d, 'business_days'),
          branch_id: b.id,
          day_name: day,
          start_time: '09:00',
          end_time: '15:00',
          interval_minutes: 60,
          active: 1
        });
      }
    }
  }

  if (!d.dashboard_users.length) {
    d.dashboard_users.push({
      id: nextId(d, 'dashboard_users'),
      username: 'admin',
      password_hash: bcrypt.hashSync('admin1234', 10),
      role: 'admin',
      branch_id: null,
      active: 1
    });
    const dam = d.branches.find(b => b.code === 'DAM01');
    d.dashboard_users.push({
      id: nextId(d, 'dashboard_users'),
      username: 'dam_emp',
      password_hash: bcrypt.hashSync('branch1234', 10),
      role: 'branch_employee',
      branch_id: dam ? dam.id : null,
      active: 1
    });
  }

  await write(d);
}

module.exports = { nowISO, read, write, nextId, seedIfNeeded };
