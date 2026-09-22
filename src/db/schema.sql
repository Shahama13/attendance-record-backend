-- =====================================================================
-- Attendance Management System — PostgreSQL schema
-- v2: adds a parent "sites" level above campuses.
--
-- Hierarchy: sites (e.g. "UTAS Nizwa") -> campuses (e.g. "North", "South")
-- The OLD flat "sites" table (which was really campus-level) is renamed
-- to "campuses" and gets a site_id FK pointing at the new parent table.
-- Every table that used to reference site_id now references campus_id.
-- =====================================================================

CREATE TYPE user_role AS ENUM ('admin', 'hr', 'supervisor', 'viewer');
CREATE TYPE employee_status AS ENUM ('active', 'inactive');
CREATE TYPE sheet_status AS ENUM ('pending', 'verified');

-- ---------------------------------------------------------------------
-- Sites — the parent org level (e.g. "UTAS Nizwa")
-- ---------------------------------------------------------------------
CREATE TABLE sites (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(160) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Campuses — what used to be the flat "sites" table. Created only via
-- the atomic campus-creation transaction (see campuses.routes.js) —
-- there is no partial/incomplete campus row; a row here always has its
-- roster and >=2 supervisors already attached in the same transaction
-- that created it.
-- ---------------------------------------------------------------------
CREATE TABLE campuses (
  id          SERIAL PRIMARY KEY,
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  code        VARCHAR(10) NOT NULL,              -- 'north', 'south' -- unique WITHIN a site, not globally: two different sites can each have their own 'north' campus
  name        VARCHAR(120) NOT NULL,             -- 'North Campus'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, code)
);
CREATE INDEX idx_campuses_site ON campuses(site_id);

-- ---------------------------------------------------------------------
-- Users (portal admins/HR/viewers, and supervisors who use the app)
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id             SERIAL PRIMARY KEY,
  username       VARCHAR(60) UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  full_name      VARCHAR(120) NOT NULL,
  role           user_role NOT NULL,
  campus_id      INTEGER REFERENCES campuses(id) ON DELETE SET NULL, -- supervisors are scoped to one campus
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Employee master list
-- reference_signature: base64/text crop captured from the campus's
-- specimen sheet at creation time. Same storage gap as image_url below
-- (no object storage wired in yet) — stored inline for now.
-- ---------------------------------------------------------------------
CREATE TABLE employees (
  id                    SERIAL PRIMARY KEY,
  employee_code         VARCHAR(20) UNIQUE NOT NULL,    -- 'N01', 'S07', ...
  name_en               VARCHAR(160) NOT NULL,
  name_ar               VARCHAR(160),                    -- optional: no longer collected at campus creation
  campus_id             INTEGER NOT NULL REFERENCES campuses(id) ON DELETE RESTRICT,
  department            VARCHAR(80),
  status                employee_status NOT NULL DEFAULT 'active',
  reference_signature   TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_employees_campus ON employees(campus_id);

-- ---------------------------------------------------------------------
-- One attendance sheet = one campus + one date
-- ---------------------------------------------------------------------
CREATE TABLE attendance_sheets (
  id             SERIAL PRIMARY KEY,
  campus_id      INTEGER NOT NULL REFERENCES campuses(id) ON DELETE RESTRICT,
  sheet_date     DATE NOT NULL,
  total_present  INTEGER NOT NULL DEFAULT 0,
  image_url      TEXT,                            -- original scanned sheet in object storage
  status         sheet_status NOT NULL DEFAULT 'pending',
  submitted_by   INTEGER REFERENCES users(id),
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by    INTEGER REFERENCES users(id),
  verified_at    TIMESTAMPTZ,
  UNIQUE (campus_id, sheet_date)                   -- enforces "one submission per campus per day"
);
CREATE INDEX idx_sheets_date ON attendance_sheets(sheet_date);
CREATE INDEX idx_sheets_campus_date ON attendance_sheets(campus_id, sheet_date);

-- ---------------------------------------------------------------------
-- Per-employee row on a given sheet
-- ---------------------------------------------------------------------
CREATE TABLE attendance_records (
  id                     SERIAL PRIMARY KEY,
  sheet_id               INTEGER NOT NULL REFERENCES attendance_sheets(id) ON DELETE CASCADE,
  employee_id            INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  present                BOOLEAN NOT NULL DEFAULT false,
  clock_in               TIME,
  clock_out              TIME,
  signature_detected     BOOLEAN NOT NULL DEFAULT false,
  -- 0.0-1.0 similarity of today's signature crop against the employee's
  -- reference_signature. NULL means no comparison was made (either the
  -- employee has no reference on file yet, or the OCR service hasn't
  -- implemented matching — see ocr.routes.js). Advisory only: never
  -- blocks a submission, only flags it for review.
  signature_match_score  NUMERIC(4,3),
  UNIQUE (sheet_id, employee_id)
);
CREATE INDEX idx_records_employee ON attendance_records(employee_id);
CREATE INDEX idx_records_sheet ON attendance_records(sheet_id);

-- ---------------------------------------------------------------------
-- Audit log — every create/update/verify/delete gets one row
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id),
  action       VARCHAR(60) NOT NULL,             -- 'attendance.submit', 'campus.create', ...
  entity_type  VARCHAR(40) NOT NULL,
  entity_id    INTEGER,
  details      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at);

-- ---------------------------------------------------------------------
-- Keep updated_at fresh
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_employees_updated_at BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();