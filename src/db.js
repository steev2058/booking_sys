const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const db = new Database(path.join(__dirname, '..', 'data.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  location TEXT NOT NULL,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS remittance_companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS business_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL,
  day_name TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  interval_minutes INTEGER DEFAULT 60,
  active INTEGER DEFAULT 1,
  FOREIGN KEY(branch_id) REFERENCES branches(id)
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_number TEXT NOT NULL,
  branch_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  day_name TEXT NOT NULL,
  slot_time TEXT NOT NULL,
  phone TEXT NOT NULL,
  status TEXT DEFAULT 'booked',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(branch_id) REFERENCES branches(id),
  FOREIGN KEY(company_id) REFERENCES remittance_companies(id),
  UNIQUE(branch_id, day_name, slot_time, status)
);

CREATE TABLE IF NOT EXISTS dashboard_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','branch_employee')),
  branch_id INTEGER,
  active INTEGER DEFAULT 1,
  FOREIGN KEY(branch_id) REFERENCES branches(id)
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  code TEXT NOT NULL,
  transfer_number TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

function seed() {
  const hasBranches = db.prepare('SELECT COUNT(*) c FROM branches').get().c;
  if (!hasBranches) {
    db.prepare('INSERT INTO branches (code,name,location) VALUES (?,?,?)').run('DAM01', 'فرع دمشق الرئيسي', 'دمشق - ساحة الأمويين');
    db.prepare('INSERT INTO branches (code,name,location) VALUES (?,?,?)').run('HOM01', 'فرع حمص', 'حمص - شارع الحضارة');
    db.prepare('INSERT INTO branches (code,name,location) VALUES (?,?,?)').run('ALE01', 'فرع حلب', 'حلب - الفرقان');
  }

  const hasCompanies = db.prepare('SELECT COUNT(*) c FROM remittance_companies').get().c;
  if (!hasCompanies) {
    db.prepare('INSERT INTO remittance_companies (name,description) VALUES (?,?)').run('ويسترن يونيون', 'استلام حوالات ويسترن يونيون');
    db.prepare('INSERT INTO remittance_companies (name,description) VALUES (?,?)').run('موني جرام', 'استلام حوالات موني جرام');
    db.prepare('INSERT INTO remittance_companies (name,description) VALUES (?,?)').run('حوالاتي', 'حوالات داخلية وخارجية');
  }

  const hasDays = db.prepare('SELECT COUNT(*) c FROM business_days').get().c;
  if (!hasDays) {
    const branches = db.prepare('SELECT id FROM branches').all();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
    for (const b of branches) {
      for (const d of days) {
        db.prepare(
          'INSERT INTO business_days (branch_id,day_name,start_time,end_time,interval_minutes) VALUES (?,?,?,?,?)'
        ).run(b.id, d, '09:00', '15:00', 60);
      }
    }
  }

  const hasUsers = db.prepare('SELECT COUNT(*) c FROM dashboard_users').get().c;
  if (!hasUsers) {
    const adminHash = bcrypt.hashSync('admin1234', 10);
    db.prepare('INSERT INTO dashboard_users (username,password_hash,role) VALUES (?,?,?)').run('admin', adminHash, 'admin');

    const dam = db.prepare('SELECT id FROM branches WHERE code=?').get('DAM01');
    const empHash = bcrypt.hashSync('branch1234', 10);
    db.prepare('INSERT INTO dashboard_users (username,password_hash,role,branch_id) VALUES (?,?,?,?)').run('dam_emp', empHash, 'branch_employee', dam.id);
  }
}

seed();
module.exports = db;
