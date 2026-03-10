CREATE DATABASE IF NOT EXISTS booking_sys CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE booking_sys;

CREATE TABLE IF NOT EXISTS branches (
  id INT PRIMARY KEY,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  location VARCHAR(255) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS remittance_companies (
  id INT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description VARCHAR(255) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS business_days (
  id INT PRIMARY KEY,
  branch_id INT NOT NULL,
  day_name VARCHAR(50) NOT NULL,
  start_time VARCHAR(10) NOT NULL,
  end_time VARCHAR(10) NOT NULL,
  interval_minutes INT NOT NULL DEFAULT 60,
  active TINYINT(1) NOT NULL DEFAULT 1,
  INDEX idx_business_days_branch (branch_id)
);

CREATE TABLE IF NOT EXISTS appointments (
  id INT PRIMARY KEY,
  transfer_number VARCHAR(80) NOT NULL,
  branch_id INT NOT NULL,
  company_id INT NOT NULL,
  day_name VARCHAR(50) NOT NULL,
  booking_date DATE NULL,
  slot_time VARCHAR(10) NOT NULL,
  slot_to VARCHAR(10) NULL,
  phone VARCHAR(30) NOT NULL,
  full_name VARCHAR(160) NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'booked',
  created_at DATETIME NULL,
  INDEX idx_appt_branch_day_slot (branch_id, day_name, slot_time),
  INDEX idx_appt_booking_date (booking_date),
  INDEX idx_appt_phone (phone)
);

CREATE TABLE IF NOT EXISTS dashboard_users (
  id INT PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  employee_no VARCHAR(20) NULL UNIQUE,
  full_name VARCHAR(160) NULL,
  report_email VARCHAR(190) NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(40) NOT NULL,
  branch_id INT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INT PRIMARY KEY,
  phone VARCHAR(30) NOT NULL,
  full_name VARCHAR(160) NULL,
  code VARCHAR(10) NOT NULL,
  transfer_number VARCHAR(80) NOT NULL,
  expires_at DATETIME NOT NULL,
  used TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NULL,
  INDEX idx_otp_phone_transfer (phone, transfer_number)
);

CREATE TABLE IF NOT EXISTS otp_security (
  phone VARCHAR(30) PRIMARY KEY,
  send_count INT NOT NULL DEFAULT 0,
  window_start DATETIME NULL,
  verify_fail_count INT NOT NULL DEFAULT 0,
  locked_until DATETIME NULL
);

CREATE TABLE IF NOT EXISTS daily_reports (
  id INT PRIMARY KEY,
  report_date DATE NOT NULL,
  branch_id INT NOT NULL,
  total_booked INT NOT NULL DEFAULT 0,
  payload_json LONGTEXT NULL,
  created_at DATETIME NULL,
  UNIQUE KEY uniq_report_date_branch (report_date, branch_id),
  INDEX idx_report_date (report_date)
);

CREATE TABLE IF NOT EXISTS report_email_logs (
  id INT PRIMARY KEY,
  dedupe_key VARCHAR(255) NOT NULL UNIQUE,
  email VARCHAR(190) NOT NULL,
  report_date DATE NOT NULL,
  branch_id INT NULL,
  sent_at DATETIME NULL,
  INDEX idx_report_email_date (report_date)
);
