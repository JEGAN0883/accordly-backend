/**
 * Accordly Database Schema
 * Run: node src/db/migrate.js
 * 
 * Uses PostgreSQL. Get a free DB at:
 * - railway.app (recommended for deployment)
 * - neon.tech (serverless PostgreSQL)
 * - render.com (free tier)
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const schema = `

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── USERS ──
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name    VARCHAR(100) NOT NULL,
  last_name     VARCHAR(100) NOT NULL,
  role          VARCHAR(20) NOT NULL DEFAULT 'parent' 
                CHECK (role IN ('parent','attorney','mediator','judge','gal','admin')),
  plan          VARCHAR(20) NOT NULL DEFAULT 'free'
                CHECK (plan IN ('free','essential','safe','pro','attorney_pro','mediator','judge','court')),
  plan_status   VARCHAR(20) DEFAULT 'active' CHECK (plan_status IN ('active','past_due','cancelled','trialing')),
  stripe_customer_id    VARCHAR(100),
  stripe_subscription_id VARCHAR(100),
  dv_waiver     BOOLEAN DEFAULT FALSE,
  dv_waiver_granted_at TIMESTAMPTZ,
  two_factor_secret     VARCHAR(100),
  two_factor_enabled    BOOLEAN DEFAULT FALSE,
  phone         VARCHAR(20),
  avatar_url    VARCHAR(500),
  timezone      VARCHAR(60) DEFAULT 'America/Los_Angeles',
  language      VARCHAR(10) DEFAULT 'en',
  last_login    TIMESTAMPTZ,
  email_verified BOOLEAN DEFAULT FALSE,
  email_verify_token VARCHAR(100),
  password_reset_token VARCHAR(100),
  password_reset_expires TIMESTAMPTZ,
  push_token    VARCHAR(500),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── CO-PARENT RELATIONSHIPS ──
CREATE TABLE IF NOT EXISTS coparent_relationships (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  parent_a_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_b_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  invite_email    VARCHAR(255),
  invite_token    VARCHAR(100),
  invite_status   VARCHAR(20) DEFAULT 'pending' 
                  CHECK (invite_status IN ('pending','accepted','declined')),
  case_number     VARCHAR(100),
  court_name      VARCHAR(200),
  court_state     VARCHAR(50),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── CHILDREN ──
CREATE TABLE IF NOT EXISTS children (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  relationship_id UUID NOT NULL REFERENCES coparent_relationships(id) ON DELETE CASCADE,
  first_name      VARCHAR(100) NOT NULL,
  last_name       VARCHAR(100) NOT NULL,
  date_of_birth   DATE NOT NULL,
  school_name     VARCHAR(200),
  school_grade    VARCHAR(20),
  allergies       TEXT,
  medications     TEXT,
  doctor_name     VARCHAR(200),
  doctor_phone    VARCHAR(20),
  counselor_name  VARCHAR(200),
  counselor_phone VARCHAR(20),
  notes           TEXT,
  avatar_url      VARCHAR(500),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── MESSAGES ──
CREATE TABLE IF NOT EXISTS messages (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  relationship_id   UUID NOT NULL REFERENCES coparent_relationships(id) ON DELETE CASCADE,
  sender_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content           TEXT NOT NULL,
  content_original  TEXT,               -- original before AI rewrite suggestion
  status            VARCHAR(20) DEFAULT 'sent' 
                    CHECK (status IN ('draft','sent','delivered','read','blocked')),
  read_at           TIMESTAMPTZ,
  -- AI Analysis
  ai_analyzed       BOOLEAN DEFAULT FALSE,
  ai_threat_level   VARCHAR(20) CHECK (ai_threat_level IN ('none','low','medium','high','critical')),
  ai_categories     JSONB DEFAULT '[]', -- ['threatening','coercive','alienation','financial','harassment']
  ai_analysis_text  TEXT,
  ai_suggested_rewrite TEXT,
  ai_blocked        BOOLEAN DEFAULT FALSE,
  ai_blocked_reason TEXT,
  -- Metadata
  has_attachments   BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_relationship ON messages(relationship_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_ai_threat ON messages(ai_threat_level) WHERE ai_threat_level != 'none';

-- ── MESSAGE ATTACHMENTS ──
CREATE TABLE IF NOT EXISTS message_attachments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_url    VARCHAR(500) NOT NULL,
  file_name   VARCHAR(255),
  file_size   INTEGER,
  file_type   VARCHAR(50),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── CALENDAR EVENTS ──
CREATE TABLE IF NOT EXISTS calendar_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  relationship_id UUID NOT NULL REFERENCES coparent_relationships(id) ON DELETE CASCADE,
  created_by_id   UUID NOT NULL REFERENCES users(id),
  title           VARCHAR(300) NOT NULL,
  event_type      VARCHAR(50) CHECK (event_type IN (
    'custody','pickup','dropoff','medical','school','activity',
    'holiday','vacation','court_date','mediation','other'
  )),
  start_datetime  TIMESTAMPTZ NOT NULL,
  end_datetime    TIMESTAMPTZ,
  all_day         BOOLEAN DEFAULT FALSE,
  location        VARCHAR(300),
  notes           TEXT,
  custody_parent  UUID REFERENCES users(id),
  -- Visit tracking
  status          VARCHAR(20) DEFAULT 'scheduled' 
                  CHECK (status IN ('scheduled','completed','missed','cancelled','disputed')),
  checkin_at      TIMESTAMPTZ,
  checkin_lat     DECIMAL(10,7),
  checkin_lng     DECIMAL(10,7),
  checkout_at     TIMESTAMPTZ,
  -- Swap requests
  swap_requested_by UUID REFERENCES users(id),
  swap_requested_at TIMESTAMPTZ,
  swap_reason     TEXT,
  swap_status     VARCHAR(20) CHECK (swap_status IN ('none','pending','approved','declined','counter')),
  swap_response_at TIMESTAMPTZ,
  recurrence_rule VARCHAR(200),
  recurrence_id   UUID,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calendar_relationship ON calendar_events(relationship_id, start_datetime);

-- ── CHILD SUPPORT PAYMENTS ──
CREATE TABLE IF NOT EXISTS child_support_payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  relationship_id UUID NOT NULL REFERENCES coparent_relationships(id) ON DELETE CASCADE,
  ordered_by_id   UUID REFERENCES users(id),  -- who is required to pay
  amount_ordered  DECIMAL(10,2) NOT NULL,
  amount_paid     DECIMAL(10,2) DEFAULT 0,
  due_date        DATE NOT NULL,
  paid_date       DATE,
  status          VARCHAR(20) DEFAULT 'pending'
                  CHECK (status IN ('pending','paid','partial','overdue','waived')),
  payment_method  VARCHAR(50),
  notes           TEXT,
  -- Reminders
  reminder_7_sent   BOOLEAN DEFAULT FALSE,
  reminder_14_sent  BOOLEAN DEFAULT FALSE,
  reminder_21_sent  BOOLEAN DEFAULT FALSE,
  dhs_filed         BOOLEAN DEFAULT FALSE,
  dhs_filed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── SHARED EXPENSES ──
CREATE TABLE IF NOT EXISTS shared_expenses (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  relationship_id UUID NOT NULL REFERENCES coparent_relationships(id) ON DELETE CASCADE,
  created_by_id   UUID NOT NULL REFERENCES users(id),
  child_id        UUID REFERENCES children(id),
  category        VARCHAR(50) CHECK (category IN (
    'medical','dental','education','activities','clothing','childcare','other'
  )),
  description     VARCHAR(300) NOT NULL,
  total_amount    DECIMAL(10,2) NOT NULL,
  your_share_pct  INTEGER DEFAULT 50,
  amount_owed     DECIMAL(10,2),
  status          VARCHAR(20) DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','paid','disputed','denied')),
  receipt_url     VARCHAR(500),
  expense_date    DATE NOT NULL,
  paid_date       DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── PARENTING PLAN ──
CREATE TABLE IF NOT EXISTS parenting_plans (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  relationship_id UUID NOT NULL REFERENCES coparent_relationships(id) ON DELETE CASCADE,
  uploaded_by_id  UUID NOT NULL REFERENCES users(id),
  version         INTEGER DEFAULT 1,
  effective_date  DATE,
  court_name      VARCHAR(200),
  case_number     VARCHAR(100),
  document_url    VARCHAR(500),
  -- AI extraction results
  ai_extracted    BOOLEAN DEFAULT FALSE,
  obligations     JSONB DEFAULT '[]',
  custody_split   JSONB,
  rofr_threshold_hours INTEGER,
  rofr_notice_hours    INTEGER,
  travel_notice_days   INTEGER,
  is_current      BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── VIOLATIONS ──
CREATE TABLE IF NOT EXISTS violations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  relationship_id UUID NOT NULL REFERENCES coparent_relationships(id) ON DELETE CASCADE,
  reported_by_id  UUID NOT NULL REFERENCES users(id),
  violator_id     UUID REFERENCES users(id),
  violation_type  VARCHAR(50) CHECK (violation_type IN (
    'missed_visit','late_pickup','communication','payment','medical',
    'travel','alienation','safety','rofr','other'
  )),
  severity        VARCHAR(20) DEFAULT 'medium'
                  CHECK (severity IN ('low','medium','high','critical')),
  description     TEXT NOT NULL,
  incident_date   TIMESTAMPTZ NOT NULL,
  evidence_urls   JSONB DEFAULT '[]',
  ai_analysis     TEXT,
  related_message_id UUID REFERENCES messages(id),
  related_event_id   UUID REFERENCES calendar_events(id),
  status          VARCHAR(20) DEFAULT 'logged'
                  CHECK (status IN ('logged','documented','escalated','resolved')),
  escalated_to    VARCHAR(50),
  escalated_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── MEDICATION LOGS ──
CREATE TABLE IF NOT EXISTS medication_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  child_id        UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  logged_by_id    UUID NOT NULL REFERENCES users(id),
  medication_name VARCHAR(200) NOT NULL,
  dosage          VARCHAR(100),
  administered_at TIMESTAMPTZ NOT NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── CHILD WELLNESS CHECK-INS ──
CREATE TABLE IF NOT EXISTS wellness_checkins (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  child_id        UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  checked_in_by_id UUID NOT NULL REFERENCES users(id),
  emoji           VARCHAR(10) NOT NULL,
  context         VARCHAR(50) CHECK (context IN ('after_transition','morning','evening','general')),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── CALLS ──
CREATE TABLE IF NOT EXISTS documented_calls (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  relationship_id UUID NOT NULL REFERENCES coparent_relationships(id) ON DELETE CASCADE,
  initiated_by_id UUID NOT NULL REFERENCES users(id),
  participant_ids JSONB NOT NULL DEFAULT '[]',
  call_type       VARCHAR(10) CHECK (call_type IN ('video','audio')),
  status          VARCHAR(20) CHECK (status IN ('initiated','connected','completed','missed','declined')),
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  duration_seconds INTEGER,
  is_virtual_visit BOOLEAN DEFAULT FALSE,
  scheduled_event_id UUID REFERENCES calendar_events(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── PROFESSIONAL ACCESS ──
CREATE TABLE IF NOT EXISTS professional_access (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  professional_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relationship_id UUID REFERENCES coparent_relationships(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  access_type     VARCHAR(30) CHECK (access_type IN ('attorney','mediator','gal','judge','counselor','pc')),
  access_level    VARCHAR(20) DEFAULT 'read' CHECK (access_level IN ('read','limited','full')),
  court_order_number VARCHAR(100),
  granted_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,
  is_active       BOOLEAN DEFAULT TRUE
);

-- ── COURT DEADLINES ──
CREATE TABLE IF NOT EXISTS court_deadlines (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  relationship_id UUID NOT NULL REFERENCES coparent_relationships(id) ON DELETE CASCADE,
  created_by_id   UUID NOT NULL REFERENCES users(id),
  deadline_type   VARCHAR(50),
  title           VARCHAR(300) NOT NULL,
  due_date        DATE NOT NULL,
  notes           TEXT,
  notify_attorney BOOLEAN DEFAULT FALSE,
  alert_30_sent   BOOLEAN DEFAULT FALSE,
  alert_7_sent    BOOLEAN DEFAULT FALSE,
  alert_1_sent    BOOLEAN DEFAULT FALSE,
  is_completed    BOOLEAN DEFAULT FALSE,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── AUDIT LOG (tamper-evident — never update, only insert) ──
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  table_name  VARCHAR(100) NOT NULL,
  record_id   UUID NOT NULL,
  action      VARCHAR(20) NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  old_data    JSONB,
  new_data    JSONB,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_record ON audit_log(table_name, record_id);

-- ── NOTIFICATIONS ──
CREATE TABLE IF NOT EXISTS notifications (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            VARCHAR(50) NOT NULL,
  title           VARCHAR(200) NOT NULL,
  body            TEXT NOT NULL,
  data            JSONB DEFAULT '{}',
  read_at         TIMESTAMPTZ,
  push_sent_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

-- ── UPDATED_AT TRIGGERS ──
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','children','calendar_events','child_support_payments','parenting_plans']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at()', t);
  END LOOP;
END $$;

`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🛡 Running Accordly database migrations...');
    await client.query(schema);
    console.log('✅ Migrations complete.');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
