#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const dataPath = path.join(__dirname, '..', 'data.json');

function toMySqlDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function main() {
  if (!fs.existsSync(dataPath)) {
    throw new Error('data.json not found');
  }

  const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'booking_user',
    password: process.env.DB_PASS || 'booking_pass',
    database: process.env.DB_NAME || 'booking_sys',
    multipleStatements: true
  });

  const tables = ['appointments', 'business_days', 'branches', 'dashboard_users', 'otp_codes', 'otp_security', 'remittance_companies'];
  for (const t of tables) await conn.execute(`DELETE FROM ${t}`);

  for (const r of raw.branches || []) {
    await conn.execute('INSERT INTO branches (id, code, name, location, active) VALUES (?,?,?,?,?)', [r.id, r.code, r.name, r.location, Number(r.active || 0)]);
  }

  for (const r of raw.remittance_companies || []) {
    await conn.execute('INSERT INTO remittance_companies (id, name, description, active) VALUES (?,?,?,?)', [r.id, r.name, r.description || '', Number(r.active || 0)]);
  }

  for (const r of raw.business_days || []) {
    await conn.execute('INSERT INTO business_days (id, branch_id, day_name, start_time, end_time, interval_minutes, active) VALUES (?,?,?,?,?,?,?)', [r.id, r.branch_id, r.day_name, r.start_time, r.end_time, Number(r.interval_minutes || 60), Number(r.active || 0)]);
  }

  for (const r of raw.appointments || []) {
    await conn.execute('INSERT INTO appointments (id, transfer_number, branch_id, company_id, day_name, slot_time, phone, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)', [r.id, r.transfer_number, r.branch_id, r.company_id, r.day_name, r.slot_time, r.phone, r.status || 'booked', toMySqlDate(r.created_at)]);
  }

  for (const r of raw.dashboard_users || []) {
    await conn.execute('INSERT INTO dashboard_users (id, username, password_hash, role, branch_id, active) VALUES (?,?,?,?,?,?)', [r.id, r.username, r.password_hash, r.role, r.branch_id || null, Number(r.active || 0)]);
  }

  for (const r of raw.otp_codes || []) {
    await conn.execute('INSERT INTO otp_codes (id, phone, code, transfer_number, expires_at, used, created_at) VALUES (?,?,?,?,?,?,?)', [r.id, r.phone, r.code, r.transfer_number, toMySqlDate(r.expires_at), Number(r.used || 0), toMySqlDate(r.created_at)]);
  }

  for (const r of raw.otp_security || []) {
    await conn.execute('INSERT INTO otp_security (phone, send_count, window_start, verify_fail_count, locked_until) VALUES (?,?,?,?,?)', [r.phone, Number(r.send_count || 0), toMySqlDate(r.window_start), Number(r.verify_fail_count || 0), toMySqlDate(r.locked_until)]);
  }

  await conn.end();
  console.log('✅ JSON data imported into MySQL successfully.');
}

main().catch((err) => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
