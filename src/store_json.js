const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const FILE = path.join(__dirname, '..', 'data.json');

function nowISO() {
  return new Date().toISOString();
}

function defaultData() {
  return {
    counters: { branches: 1, remittance_companies: 1, business_days: 1, appointments: 1, dashboard_users: 1, otp_codes: 1 },
    branches: [],
    remittance_companies: [],
    business_days: [],
    appointments: [],
    dashboard_users: [],
    otp_codes: [],
    otp_security: []
  };
}

function read() {
  if (!fs.existsSync(FILE)) return defaultData();
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return defaultData();
  }
}

function write(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function nextId(data, key) {
  const n = Number(data.counters[key] || 1);
  data.counters[key] = n + 1;
  return n;
}

function seedIfNeeded() {
  const d = read();

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

  write(d);
}

module.exports = { FILE, nowISO, read, write, nextId, seedIfNeeded };
