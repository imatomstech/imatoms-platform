-- ============================================================
--  iMATOMs Platform V3.0 — Migration Script
--  ใช้กับ database ที่มีอยู่แล้ว (imatoms_db)
--  ไม่ DROP ตารางเดิม — ALTER + CREATE เท่านั้น
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ALTER TABLE users — เพิ่ม columns ที่ขาด
-- ============================================================
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS full_name    VARCHAR(150),
  ADD COLUMN IF NOT EXISTS position     VARCHAR(100),
  ADD COLUMN IF NOT EXISTS phone        VARCHAR(20),
  ADD COLUMN IF NOT EXISTS building_id  INTEGER REFERENCES buildings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS business_group VARCHAR(100),
  ADD COLUMN IF NOT EXISTS department   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS modules      TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS avatar_url   TEXT,
  ADD COLUMN IF NOT EXISTS status       VARCHAR(20) DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS last_login   TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMP DEFAULT NOW();

-- password column เดิมชื่อ 'password' → เพิ่ม password_hash ใหม่
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- ============================================================
-- ALTER TABLE buildings — เพิ่ม columns ที่ขาด
-- ============================================================
ALTER TABLE buildings
  ADD COLUMN IF NOT EXISTS type         VARCHAR(50) DEFAULT 'office',
  ADD COLUMN IF NOT EXISTS address      TEXT,
  ADD COLUMN IF NOT EXISTS floors       INT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS area_sqm     NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS built_year   INT,
  ADD COLUMN IF NOT EXISTS manager_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS manager_phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS status       VARCHAR(20) DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS logo_url     TEXT,
  ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMP DEFAULT NOW();

-- ============================================================
-- ALTER TABLE assets — เพิ่ม columns ที่ขาด
-- ============================================================
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS asset_no       VARCHAR(50),
  ADD COLUMN IF NOT EXISTS category_id    INTEGER,
  ADD COLUMN IF NOT EXISTS brand          VARCHAR(100),
  ADD COLUMN IF NOT EXISTS model          VARCHAR(100),
  ADD COLUMN IF NOT EXISTS serial_no      VARCHAR(100),
  ADD COLUMN IF NOT EXISTS location       VARCHAR(200),
  ADD COLUMN IF NOT EXISTS floor          VARCHAR(20),
  ADD COLUMN IF NOT EXISTS zone           VARCHAR(50),
  ADD COLUMN IF NOT EXISTS module         VARCHAR(50) DEFAULT 'office',
  ADD COLUMN IF NOT EXISTS criticality    VARCHAR(20) DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS install_date   DATE,
  ADD COLUMN IF NOT EXISTS warranty_expire DATE,
  ADD COLUMN IF NOT EXISTS purchase_cost  NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS current_value  NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS useful_life_years INT,
  ADD COLUMN IF NOT EXISTS pm_interval_days INT DEFAULT 90,
  ADD COLUMN IF NOT EXISTS last_pm_date   DATE,
  ADD COLUMN IF NOT EXISTS next_pm_date   DATE,
  ADD COLUMN IF NOT EXISTS notes          TEXT,
  ADD COLUMN IF NOT EXISTS extra_data     JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS created_by     INTEGER,
  ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMP DEFAULT NOW();

-- ============================================================
-- NEW TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMP NOT NULL,
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(100) NOT NULL,
  table_name  VARCHAR(100),
  record_id   INTEGER,
  old_data    JSONB,
  new_data    JSONB,
  ip_address  VARCHAR(45),
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS asset_categories (
  id          SERIAL PRIMARY KEY,
  building_id INTEGER REFERENCES buildings(id) ON DELETE CASCADE,
  code        VARCHAR(20) NOT NULL,
  name        VARCHAR(100) NOT NULL,
  module      VARCHAR(50) NOT NULL,
  parent_id   INTEGER REFERENCES asset_categories(id),
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pm_plans (
  id              SERIAL PRIMARY KEY,
  building_id     INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  asset_id        INTEGER REFERENCES assets(id) ON DELETE CASCADE,
  plan_no         VARCHAR(50) NOT NULL,
  name            VARCHAR(200) NOT NULL,
  pm_type         VARCHAR(30) DEFAULT 'preventive',
  frequency       VARCHAR(20) DEFAULT 'monthly',
  interval_days   INT,
  checklist       JSONB DEFAULT '[]',
  assigned_to     INTEGER REFERENCES users(id),
  estimated_hours NUMERIC(5,2),
  status          VARCHAR(20) DEFAULT 'active',
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS work_orders (
  id              SERIAL PRIMARY KEY,
  building_id     INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  wo_no           VARCHAR(50) UNIQUE NOT NULL,
  asset_id        INTEGER REFERENCES assets(id),
  wo_type         VARCHAR(30) DEFAULT 'corrective',
  title           VARCHAR(200) NOT NULL,
  description     TEXT,
  priority        VARCHAR(20) DEFAULT 'medium',
  status          VARCHAR(30) DEFAULT 'open',
  assigned_to     INTEGER REFERENCES users(id),
  requested_by    INTEGER REFERENCES users(id),
  planned_start   TIMESTAMP,
  planned_end     TIMESTAMP,
  actual_start    TIMESTAMP,
  actual_end      TIMESTAMP,
  labor_hours     NUMERIC(6,2),
  labor_cost      NUMERIC(10,2),
  parts_cost      NUMERIC(10,2),
  total_cost      NUMERIC(10,2),
  root_cause      TEXT,
  action_taken    TEXT,
  checklist_data  JSONB DEFAULT '[]',
  attachments     JSONB DEFAULT '[]',
  module          VARCHAR(50),
  created_by      INTEGER REFERENCES users(id),
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- ALTER TABLE work_orders — เพิ่ม columns สำหรับ Work Request (WR)
-- workflow เต็มรูปแบบ: accept → close → evaluate/approve, SLA, MTTR
-- ============================================================
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS accepted_at    TIMESTAMP,
  ADD COLUMN IF NOT EXISTS mttr_hours     NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS approved_by    INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at    TIMESTAMP,
  ADD COLUMN IF NOT EXISTS reviewed       BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS reject_reason  TEXT,
  ADD COLUMN IF NOT EXISTS reporter_name  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS reporter_phone VARCHAR(30),
  ADD COLUMN IF NOT EXISTS assigned_name_text VARCHAR(150), -- technician name when not a system user account
  ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}'::jsonb;   -- lossless bucket for extra client-side WR fields
-- wo_no already has a UNIQUE constraint from the original CREATE TABLE, so
-- ON CONFLICT (wo_no) in the sync endpoint below works without a new index.

CREATE TABLE IF NOT EXISTS spare_parts (
  id            SERIAL PRIMARY KEY,
  building_id   INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  part_no       VARCHAR(50) NOT NULL,
  name          VARCHAR(200) NOT NULL,
  unit          VARCHAR(20) DEFAULT 'pcs',
  qty_on_hand   INT DEFAULT 0,
  qty_min       INT DEFAULT 1,
  unit_cost     NUMERIC(10,2),
  location      VARCHAR(100),
  supplier      VARCHAR(100),
  lead_days     INT,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS risk_assessments (
  id              SERIAL PRIMARY KEY,
  building_id     INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  asset_id        INTEGER REFERENCES assets(id),
  ref_no          VARCHAR(50),
  title           VARCHAR(200) NOT NULL,
  hazard          TEXT,
  likelihood      INT CHECK (likelihood BETWEEN 1 AND 5),
  severity        INT CHECK (severity BETWEEN 1 AND 5),
  risk_score      INT,
  risk_level      VARCHAR(20),
  control_measure TEXT,
  responsible     INTEGER REFERENCES users(id),
  review_date     DATE,
  status          VARCHAR(20) DEFAULT 'open',
  module          VARCHAR(50),
  created_by      INTEGER REFERENCES users(id),
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS incidents (
  id              SERIAL PRIMARY KEY,
  building_id     INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  incident_no     VARCHAR(50) UNIQUE NOT NULL,
  title           VARCHAR(200) NOT NULL,
  description     TEXT,
  incident_type   VARCHAR(50),
  severity        VARCHAR(20),
  asset_id        INTEGER REFERENCES assets(id),
  location        VARCHAR(200),
  occurred_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  reported_by     INTEGER REFERENCES users(id),
  injured_persons INT DEFAULT 0,
  property_damage NUMERIC(12,2),
  status          VARCHAR(30) DEFAULT 'open',
  module          VARCHAR(50),
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS capa_items (
  id            SERIAL PRIMARY KEY,
  building_id   INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  incident_id   INTEGER REFERENCES incidents(id),
  risk_id       INTEGER REFERENCES risk_assessments(id),
  capa_no       VARCHAR(50) NOT NULL,
  type          VARCHAR(20),
  description   TEXT NOT NULL,
  root_cause    TEXT,
  action        TEXT,
  responsible   INTEGER REFERENCES users(id),
  due_date      DATE,
  status        VARCHAR(20) DEFAULT 'open',
  effectiveness TEXT,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS biomedical_devices (
  id              SERIAL PRIMARY KEY,
  building_id     INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  bme_no          VARCHAR(50) NOT NULL,
  name            VARCHAR(200) NOT NULL,
  brand           VARCHAR(100),
  model           VARCHAR(100),
  serial_no       VARCHAR(100),
  risk_class      VARCHAR(10),
  department      VARCHAR(100),
  location        VARCHAR(200),
  status          VARCHAR(30) DEFAULT 'in_service',
  install_date    DATE,
  warranty_expire DATE,
  calibration_due DATE,
  pm_interval     INT DEFAULT 90,
  last_pm         DATE,
  next_pm         DATE,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jci_compliance (
  id              SERIAL PRIMARY KEY,
  building_id     INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  chapter         VARCHAR(10) NOT NULL,
  chapter_name    VARCHAR(200),
  standard        VARCHAR(100),
  me_code         VARCHAR(20),
  requirement     TEXT,
  compliance_pct  INT DEFAULT 0,
  evidence        TEXT,
  reviewer        INTEGER REFERENCES users(id),
  review_date     DATE,
  status          VARCHAR(20) DEFAULT 'pending',
  notes           TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mep_systems (
  id              SERIAL PRIMARY KEY,
  building_id     INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  system_type     VARCHAR(50) NOT NULL,
  name            VARCHAR(200) NOT NULL,
  brand           VARCHAR(100),
  capacity        VARCHAR(100),
  location        VARCHAR(200),
  floor           VARCHAR(20),
  install_date    DATE,
  status          VARCHAR(30) DEFAULT 'operational',
  asset_id        INTEGER REFERENCES assets(id),
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_requests (
  id            SERIAL PRIMARY KEY,
  building_id   INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  request_no    VARCHAR(50) UNIQUE NOT NULL,
  tenant_name   VARCHAR(100) NOT NULL,
  floor         VARCHAR(20),
  unit          VARCHAR(30),
  category      VARCHAR(50),
  description   TEXT,
  priority      VARCHAR(20) DEFAULT 'normal',
  status        VARCHAR(30) DEFAULT 'open',
  assigned_to   INTEGER REFERENCES users(id),
  sla_hours     INT DEFAULT 4,
  opened_at     TIMESTAMP DEFAULT NOW(),
  closed_at     TIMESTAMP,
  rating        INT,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS energy_readings (
  id            SERIAL PRIMARY KEY,
  building_id   INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  meter_id      VARCHAR(50),
  energy_type   VARCHAR(30) DEFAULT 'electricity',
  reading_date  DATE NOT NULL,
  reading_kwh   NUMERIC(12,2),
  cost_thb      NUMERIC(12,2),
  floor         VARCHAR(20),
  zone          VARCHAR(50),
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS water_readings (
  id            SERIAL PRIMARY KEY,
  building_id   INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  meter_id      VARCHAR(50),
  reading_date  DATE NOT NULL,
  reading_m3    NUMERIC(10,2),
  cost_thb      NUMERIC(10,2),
  usage_type    VARCHAR(30) DEFAULT 'domestic',
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS carbon_records (
  id              SERIAL PRIMARY KEY,
  building_id     INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  record_date     DATE NOT NULL,
  scope           INT,
  source          VARCHAR(100),
  emission_kgco2  NUMERIC(12,2),
  unit            VARCHAR(30),
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS safety_inspections (
  id              SERIAL PRIMARY KEY,
  building_id     INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  insp_no         VARCHAR(50) NOT NULL,
  insp_type       VARCHAR(50),
  area            VARCHAR(200),
  floor           VARCHAR(20),
  inspector       INTEGER REFERENCES users(id),
  inspected_at    TIMESTAMP DEFAULT NOW(),
  total_items     INT DEFAULT 0,
  pass_items      INT DEFAULT 0,
  fail_items      INT DEFAULT 0,
  score_pct       NUMERIC(5,2),
  status          VARCHAR(20) DEFAULT 'draft',
  checklist_data  JSONB DEFAULT '[]',
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS permit_to_work (
  id            SERIAL PRIMARY KEY,
  building_id   INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  ptw_no        VARCHAR(50) UNIQUE NOT NULL,
  work_type     VARCHAR(50),
  description   TEXT,
  location      VARCHAR(200),
  contractor    VARCHAR(100),
  supervisor    VARCHAR(100),
  start_date    TIMESTAMP,
  end_date      TIMESTAMP,
  hazards       JSONB DEFAULT '[]',
  precautions   JSONB DEFAULT '[]',
  approved_by   INTEGER REFERENCES users(id),
  status        VARCHAR(20) DEFAULT 'draft',
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS training_courses (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(30) UNIQUE NOT NULL,
  name          VARCHAR(200) NOT NULL,
  category      VARCHAR(50),
  description   TEXT,
  duration_hrs  NUMERIC(5,2),
  required_role TEXT[],
  module        VARCHAR(50),
  is_mandatory  BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS training_records (
  id            SERIAL PRIMARY KEY,
  building_id   INTEGER REFERENCES buildings(id),
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id     INTEGER NOT NULL REFERENCES training_courses(id),
  trained_date  DATE,
  expire_date   DATE,
  score         NUMERIC(5,2),
  result        VARCHAR(20) DEFAULT 'pending',
  trainer       VARCHAR(100),
  cert_no       VARCHAR(50),
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budgets (
  id            SERIAL PRIMARY KEY,
  building_id   INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  fiscal_year   INT NOT NULL,
  category      VARCHAR(50),
  item_name     VARCHAR(200),
  budget_thb    NUMERIC(15,2),
  actual_thb    NUMERIC(15,2) DEFAULT 0,
  module        VARCHAR(50),
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kpi_records (
  id            SERIAL PRIMARY KEY,
  building_id   INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  kpi_code      VARCHAR(50) NOT NULL,
  kpi_name      VARCHAR(200) NOT NULL,
  pillar        VARCHAR(50),
  module        VARCHAR(50),
  period_year   INT,
  period_month  INT,
  target        NUMERIC(12,4),
  actual        NUMERIC(12,4),
  unit          VARCHAR(30),
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id            SERIAL PRIMARY KEY,
  building_id   INTEGER REFERENCES buildings(id),
  user_id       INTEGER REFERENCES users(id),
  title         VARCHAR(200) NOT NULL,
  message       TEXT,
  type          VARCHAR(30) DEFAULT 'info',
  module        VARCHAR(50),
  ref_table     VARCHAR(100),
  ref_id        INTEGER,
  is_read       BOOLEAN DEFAULT FALSE,
  sent_line     BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_assets_building      ON assets(building_id);
CREATE INDEX IF NOT EXISTS idx_assets_next_pm       ON assets(next_pm_date);
CREATE INDEX IF NOT EXISTS idx_work_orders_building ON work_orders(building_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_status   ON work_orders(status);
CREATE INDEX IF NOT EXISTS idx_incidents_building   ON incidents(building_id);
CREATE INDEX IF NOT EXISTS idx_energy_building_date ON energy_readings(building_id, reading_date);
CREATE INDEX IF NOT EXISTS idx_notif_user_read      ON notifications(user_id, is_read);

-- ============================================================
-- SEED DATA
-- ============================================================

-- Pilot Building
INSERT INTO buildings (name, code, type, address, floors, area_sqm, status)
VALUES ('iMATOMs Pilot Building', 'BLD-PILOT', 'office', 'Bangkok, Thailand', 20, 25000, 'active')
ON CONFLICT (code) DO NOTHING;

-- Admin user (password: Admin@iMATOMs2024)
-- เพิ่ม full_name และ password_hash ใน user เดิม (id=1 ถ้ามี) หรือ insert ใหม่
DO $$
DECLARE v_bid INTEGER;
BEGIN
  SELECT id INTO v_bid FROM buildings WHERE code='BLD-PILOT';

  -- อัปเดต admin เดิม (username=admin) ถ้ามี
  UPDATE users SET
    full_name     = 'TKO Administrator',
    position      = 'System Admin',
    role          = 'admin',
    status        = 'approved',
    building_id   = v_bid,
    modules       = ARRAY['healthcare','office','factory','commercial','university','reliability'],
    password_hash = crypt('Admin@iMATOMs2024', gen_salt('bf', 12))
  WHERE username = 'admin';

  -- ถ้าไม่มี admin ให้ insert ใหม่
  IF NOT FOUND THEN
    INSERT INTO users (username, email, password, password_hash, full_name, position, role, building_id, modules, status)
    VALUES ('admin', 'kittananonsee@gmail.com', crypt('Admin@iMATOMs2024', gen_salt('bf',12)),
            crypt('Admin@iMATOMs2024', gen_salt('bf',12)),
            'TKO Administrator', 'System Admin', 'admin', v_bid,
            ARRAY['healthcare','office','factory','commercial','university','reliability'], 'approved');
  END IF;
END $$;

-- Sample Assets
DO $$
DECLARE v_bid INTEGER;
BEGIN
  SELECT id INTO v_bid FROM buildings WHERE code='BLD-PILOT';
  INSERT INTO assets (building_id, asset_no, name, brand, model, location, floor, module, status, criticality, pm_interval_days, next_pm_date)
  VALUES
    (v_bid,'AST-001','Chiller Unit #1','Carrier','30XW-P','Basement M/R','B1','office','operational','critical',90, CURRENT_DATE+30),
    (v_bid,'AST-002','AHU Floor 5','York','YRAA','Floor 5','5','office','operational','high',60, CURRENT_DATE+15),
    (v_bid,'AST-003','Elevator #1','KONE','MonoSpace','Lobby','GF','office','operational','critical',180, CURRENT_DATE+45),
    (v_bid,'AST-004','Fire Pump','Grundfos','NB-80','Pump Room','B2','office','operational','critical',90, CURRENT_DATE+10),
    (v_bid,'AST-005','Ventilator ICU #1','Mindray','SV800','ICU Ward','3','healthcare','operational','critical',30, CURRENT_DATE+7)
  ON CONFLICT DO NOTHING;
END $$;

-- KPI seed
DO $$
DECLARE v_bid INTEGER;
BEGIN
  SELECT id INTO v_bid FROM buildings WHERE code='BLD-PILOT';
  INSERT INTO kpi_records (building_id, kpi_code, kpi_name, pillar, module, period_year, period_month, target, actual, unit)
  VALUES
    (v_bid,'PM_COMPLIANCE','PM Compliance Rate','reliability','office', EXTRACT(YEAR FROM NOW())::INT, EXTRACT(MONTH FROM NOW())::INT, 95, 88, '%'),
    (v_bid,'MTBF','Mean Time Between Failures','reliability','office', EXTRACT(YEAR FROM NOW())::INT, EXTRACT(MONTH FROM NOW())::INT, 720, 684, 'hours'),
    (v_bid,'ENERGY_IEI','Energy Intensity Index','esg','office', EXTRACT(YEAR FROM NOW())::INT, EXTRACT(MONTH FROM NOW())::INT, 120, 134.5, 'kWh/sqm')
  ON CONFLICT DO NOTHING;
END $$;

-- Training Courses
INSERT INTO training_courses (code, name, category, duration_hrs, is_mandatory, module) VALUES
('TC-001','การบำรุงรักษาเชิงป้องกัน (PM Fundamentals)','maintenance',8,TRUE,'office'),
('TC-002','ความปลอดภัยในการทำงาน (Safety Induction)','safety',4,TRUE,'office'),
('TC-003','IEC 62353 Electrical Safety for Medical Devices','healthcare',8,TRUE,'healthcare'),
('TC-004','Fire Safety & Evacuation','safety',4,TRUE,'office'),
('TC-005','LEED Green Building Operations','esg',16,FALSE,'office')
ON CONFLICT (code) DO NOTHING;

SELECT 'Migration completed successfully!' AS result;
