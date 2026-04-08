-- ============================================================
-- SHAKTI v2.0 — Hardened Database Schema
-- PostgreSQL 15 (No pgvector, standard image)
-- 100% Local / On-Premise Government Deployment
-- Per Report §8, §39–§46
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 001: officers (imported from authorized Excel sheet)
-- ============================================================
CREATE TABLE IF NOT EXISTS officers (
    id              SERIAL PRIMARY KEY,
    buckle_id       VARCHAR(50) UNIQUE NOT NULL,
    full_name       VARCHAR(255) NOT NULL,
    phone_number    VARCHAR(20),
    position        VARCHAR(100),
    department      VARCHAR(100),
    station         VARCHAR(100),
    is_active       BOOLEAN DEFAULT TRUE,
    imported_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_officers_buckle_id ON officers(buckle_id);

-- ============================================================
-- 002: users — Hardened (§39.8)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id                      SERIAL PRIMARY KEY,
    buckle_id               VARCHAR(50) UNIQUE NOT NULL REFERENCES officers(buckle_id),
    email                   VARCHAR(255) UNIQUE NOT NULL,
    password_hash           VARCHAR(255) NOT NULL,
    full_name               VARCHAR(255) NOT NULL,
    role                    VARCHAR(20) DEFAULT 'officer'
                            CHECK (role IN ('super_admin', 'station_admin', 'officer', 'viewer')),
    failed_login_attempts   INTEGER DEFAULT 0,
    locked_until            TIMESTAMPTZ,
    must_change_password    BOOLEAN DEFAULT FALSE,
    last_login              TIMESTAMPTZ,
    last_password_change    TIMESTAMPTZ DEFAULT NOW(),
    login_count             INTEGER DEFAULT 0,
    is_active               BOOLEAN DEFAULT TRUE,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_buckle_id ON users(buckle_id);

-- ============================================================
-- 003: refresh_tokens (§39.4)
-- ============================================================
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(128) NOT NULL,
    family_id       UUID NOT NULL,
    is_revoked      BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    replaced_by     UUID REFERENCES refresh_tokens(id),
    ip_address      INET,
    user_agent      TEXT,
    CONSTRAINT unique_token_hash UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expiry ON refresh_tokens(expires_at) WHERE NOT is_revoked;

-- ============================================================
-- 004: sessions — Activity Tracking (§45.1.3)
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    ended_at        TIMESTAMPTZ,
    ip_address      INET,
    user_agent      TEXT,
    logout_reason   VARCHAR(50)
                    CHECK (logout_reason IN ('manual', 'expired', 'admin_forced', 'lockout'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(user_id) WHERE ended_at IS NULL;

-- ============================================================
-- 005: cases — Hardened (§40.2)
-- ============================================================
CREATE TABLE IF NOT EXISTS cases (
    id                      SERIAL PRIMARY KEY,
    case_name               VARCHAR(255) NOT NULL,
    case_number             VARCHAR(50) UNIQUE NOT NULL,
    case_type               VARCHAR(50),
    fir_number              TEXT,
    description             TEXT,
    investigation_details   TEXT,
    operator                TEXT,
    status                  VARCHAR(20) DEFAULT 'open'
                            CHECK (status IN ('open', 'active', 'closed', 'archived', 'locked')),
    priority                VARCHAR(10) DEFAULT 'medium'
                            CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    -- Ownership & audit
    created_by_user_id      INTEGER NOT NULL REFERENCES users(id),
    updated_by_user_id      INTEGER REFERENCES users(id),
    closed_by_user_id       INTEGER REFERENCES users(id),
    -- Evidence lock (§42)
    is_evidence_locked      BOOLEAN DEFAULT FALSE,
    locked_at               TIMESTAMPTZ,
    locked_by               INTEGER REFERENCES users(id),
    lock_reason             TEXT,
    -- Dates
    start_date              DATE,
    end_date                DATE,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW(),
    closed_at               TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cases_created_by ON cases(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);

-- ============================================================
-- 006: case_assignments — Multi-officer (§40.3)
-- ============================================================
CREATE TABLE IF NOT EXISTS case_assignments (
    id              SERIAL PRIMARY KEY,
    case_id         INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            VARCHAR(20) DEFAULT 'investigator'
                    CHECK (role IN ('owner', 'investigator', 'viewer', 'auditor')),
    assigned_by     INTEGER NOT NULL REFERENCES users(id),
    assigned_at     TIMESTAMPTZ DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ,
    is_active       BOOLEAN DEFAULT TRUE,
    CONSTRAINT unique_active_assignment UNIQUE (case_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_assignments_case ON case_assignments(case_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_assignments_user ON case_assignments(user_id) WHERE is_active;

-- ============================================================
-- 007: uploaded_files
-- ============================================================
CREATE TABLE IF NOT EXISTS uploaded_files (
    id              SERIAL PRIMARY KEY,
    case_id         INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    file_name       TEXT NOT NULL,
    file_type       TEXT,
    file_size       BIGINT,
    original_name   TEXT,
    mime_type       TEXT,
    parse_status    TEXT DEFAULT 'pending'
                    CHECK (parse_status IN ('pending', 'processing', 'completed', 'failed')),
    record_count    INTEGER DEFAULT 0,
    uploaded_by     INTEGER REFERENCES users(id),
    uploaded_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_case ON uploaded_files(case_id);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_type ON uploaded_files(file_type);

-- ============================================================
-- 008: ingestion_jobs — Async pipeline (§41.3)
-- ============================================================
CREATE TABLE IF NOT EXISTS ingestion_jobs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id             INTEGER NOT NULL REFERENCES cases(id),
    user_id             INTEGER NOT NULL REFERENCES users(id),
    original_filename   VARCHAR(500) NOT NULL,
    storage_path        VARCHAR(500) NOT NULL,
    file_size_bytes     BIGINT NOT NULL,
    file_checksum       VARCHAR(64) NOT NULL,
    mime_type           VARCHAR(100),
    expected_type       VARCHAR(20) NOT NULL
                        CHECK (expected_type IN ('cdr', 'sdr', 'ipdr', 'tower_dump', 'ild')),
    detected_type       VARCHAR(20),
    confidence_score    DECIMAL(3,2),
    classification_meta JSONB,
    status              VARCHAR(20) DEFAULT 'queued'
                        CHECK (status IN ('queued', 'processing', 'completed', 'failed',
                                         'quarantined', 'mismatched', 'cancelled')),
    total_rows          INTEGER,
    valid_rows          INTEGER,
    rejected_rows       INTEGER,
    error_message       TEXT,
    parser_version      VARCHAR(20) DEFAULT '1.0.0',
    normalizer_version  VARCHAR(20) DEFAULT '1.0.0',
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    reviewed_at         TIMESTAMPTZ,
    reviewed_by         INTEGER REFERENCES users(id),
    CONSTRAINT unique_file_per_case UNIQUE (case_id, file_checksum)
);
CREATE INDEX IF NOT EXISTS idx_jobs_case ON ingestion_jobs(case_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON ingestion_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_checksum ON ingestion_jobs(file_checksum);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON ingestion_jobs(user_id);

-- ============================================================
-- 009: rejected_rows (§41.4)
-- ============================================================
CREATE TABLE IF NOT EXISTS rejected_rows (
    id              SERIAL PRIMARY KEY,
    job_id          UUID NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
    row_number      INTEGER NOT NULL,
    raw_data        JSONB NOT NULL,
    rejection_reason VARCHAR(500) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rejected_job ON rejected_rows(job_id);

-- ============================================================
-- 010: file_classifications
-- ============================================================
CREATE TABLE IF NOT EXISTS file_classifications (
    id                      SERIAL PRIMARY KEY,
    file_id                 INTEGER REFERENCES uploaded_files(id) ON DELETE CASCADE,
    expected_type           VARCHAR(20) NOT NULL,
    detected_type           VARCHAR(20),
    confidence              NUMERIC(5,4),
    all_scores              JSONB,
    matched_columns         INTEGER,
    total_columns           INTEGER,
    classification_result   VARCHAR(20) NOT NULL
                            CHECK (classification_result IN ('ACCEPTED', 'WRONG_TYPE', 'REJECTED')),
    error_message           TEXT,
    classified_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 011: cdr_records (Call Detail Records)
-- ============================================================
CREATE TABLE IF NOT EXISTS cdr_records (
    id              SERIAL PRIMARY KEY,
    case_id         INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    file_id         INTEGER REFERENCES uploaded_files(id) ON DELETE SET NULL,
    calling_number  TEXT,
    called_number   TEXT,
    date_time       TIMESTAMPTZ,
    call_date       TEXT,
    call_time       TEXT,
    call_type       TEXT,
    duration        INTEGER,
    duration_sec    INTEGER,
    imei_a          TEXT,
    imei_b          TEXT,
    first_cell_id   TEXT,
    last_cell_id    TEXT,
    cell_id_a       TEXT,
    cell_id_b       TEXT,
    roaming         TEXT,
    operator        TEXT,
    lat             DOUBLE PRECISION,
    long            DOUBLE PRECISION,
    raw_data        JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
-- CDR Indexes (§46.2)
CREATE INDEX IF NOT EXISTS idx_cdr_case_id ON cdr_records(case_id);
CREATE INDEX IF NOT EXISTS idx_cdr_calling ON cdr_records(calling_number);
CREATE INDEX IF NOT EXISTS idx_cdr_called ON cdr_records(called_number);
CREATE INDEX IF NOT EXISTS idx_cdr_datetime ON cdr_records(date_time);
CREATE INDEX IF NOT EXISTS idx_cdr_case_date ON cdr_records(case_id, date_time);
CREATE INDEX IF NOT EXISTS idx_cdr_case_calling ON cdr_records(case_id, calling_number);
CREATE INDEX IF NOT EXISTS idx_cdr_case_called ON cdr_records(case_id, called_number);
CREATE INDEX IF NOT EXISTS idx_cdr_cell_id ON cdr_records(first_cell_id);

-- ============================================================
-- 012: ipdr_records (Internet Protocol Detail Records)
-- ============================================================
CREATE TABLE IF NOT EXISTS ipdr_records (
    id                  SERIAL PRIMARY KEY,
    case_id             INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    file_id             INTEGER REFERENCES uploaded_files(id) ON DELETE SET NULL,
    source_ip           TEXT,
    destination_ip      TEXT,
    source_port         TEXT,
    destination_port    TEXT,
    msisdn              TEXT,
    imsi                TEXT,
    imei                TEXT,
    private_ip          TEXT,
    public_ip           TEXT,
    nat_ip              TEXT,
    nat_port            TEXT,
    private_port        TEXT,
    protocol            TEXT,
    uplink_volume       BIGINT,
    downlink_volume     BIGINT,
    total_volume        BIGINT,
    start_time          TEXT,
    end_time            TEXT,
    duration            TEXT,
    cell_id             TEXT,
    lac                 TEXT,
    rat_type            TEXT,
    domain_name         TEXT,
    url                 TEXT,
    operator            TEXT,
    raw_data            JSONB,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
-- IPDR Indexes (§46.3)
CREATE INDEX IF NOT EXISTS idx_ipdr_case_id ON ipdr_records(case_id);
CREATE INDEX IF NOT EXISTS idx_ipdr_private_ip ON ipdr_records(private_ip);
CREATE INDEX IF NOT EXISTS idx_ipdr_public_ip ON ipdr_records(public_ip);
CREATE INDEX IF NOT EXISTS idx_ipdr_start_time ON ipdr_records(start_time);
CREATE INDEX IF NOT EXISTS idx_ipdr_case_time ON ipdr_records(case_id, start_time);
CREATE INDEX IF NOT EXISTS idx_ipdr_msisdn ON ipdr_records(msisdn);

-- ============================================================
-- 013: ild_records (International Long Distance)
-- ============================================================
CREATE TABLE IF NOT EXISTS ild_records (
    id                  SERIAL PRIMARY KEY,
    case_id             INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    file_id             INTEGER REFERENCES uploaded_files(id) ON DELETE SET NULL,
    calling_number      TEXT,
    called_number       TEXT,
    calling_party       TEXT,
    called_party        TEXT,
    call_date           TEXT,
    call_time           TEXT,
    date_time           TIMESTAMPTZ,
    call_type           TEXT,
    call_direction      TEXT,
    duration            INTEGER,
    duration_sec        INTEGER,
    international_num   TEXT,
    destination_country TEXT,
    country_code        TEXT,
    imei                TEXT,
    cell_id             TEXT,
    operator            TEXT,
    roaming_circle      TEXT,
    raw_data            JSONB,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
-- ILD Indexes (§46.5)
CREATE INDEX IF NOT EXISTS idx_ild_case_id ON ild_records(case_id);
CREATE INDEX IF NOT EXISTS idx_ild_calling ON ild_records(calling_number);
CREATE INDEX IF NOT EXISTS idx_ild_called ON ild_records(called_number);
CREATE INDEX IF NOT EXISTS idx_ild_country ON ild_records(destination_country);
CREATE INDEX IF NOT EXISTS idx_ild_datetime ON ild_records(date_time);
CREATE INDEX IF NOT EXISTS idx_ild_case_date ON ild_records(case_id, date_time);

-- ============================================================
-- 014: sdr_records (Subscriber Detail Records)
-- ============================================================
CREATE TABLE IF NOT EXISTS sdr_records (
    id                  SERIAL PRIMARY KEY,
    case_id             INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    file_id             INTEGER REFERENCES uploaded_files(id) ON DELETE SET NULL,
    subscriber_name     TEXT,
    msisdn              TEXT,
    imsi                TEXT,
    imei                TEXT,
    activation_date     TEXT,
    address             TEXT,
    id_proof_type       TEXT,
    id_proof_number     TEXT,
    alternate_number    TEXT,
    email               TEXT,
    data                JSONB,
    operator            TEXT,
    raw_data            JSONB,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
-- SDR Indexes (§46.5)
CREATE INDEX IF NOT EXISTS idx_sdr_case_id ON sdr_records(case_id);
CREATE INDEX IF NOT EXISTS idx_sdr_msisdn ON sdr_records(msisdn);
CREATE INDEX IF NOT EXISTS idx_sdr_imei ON sdr_records(imei);
CREATE INDEX IF NOT EXISTS idx_sdr_activation ON sdr_records(activation_date);

-- ============================================================
-- 015: tower_dump_records (Tower Dump Forensics)
-- ============================================================
CREATE TABLE IF NOT EXISTS tower_dump_records (
    id              SERIAL PRIMARY KEY,
    case_id         INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    file_id         INTEGER REFERENCES uploaded_files(id) ON DELETE SET NULL,
    a_party         TEXT,
    b_party         TEXT,
    call_date       TEXT,
    call_time       TEXT,
    start_time      TIMESTAMPTZ,
    call_type       TEXT,
    duration_sec    INTEGER,
    imei            TEXT,
    imsi            TEXT,
    first_cell_id   TEXT,
    last_cell_id    TEXT,
    cell_id         TEXT,
    lac             TEXT,
    lat             DOUBLE PRECISION,
    long            DOUBLE PRECISION,
    azimuth         TEXT,
    site_name       TEXT,
    site_address    TEXT,
    operator        TEXT,
    raw_data        JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
-- Tower Indexes (§46.4)
CREATE INDEX IF NOT EXISTS idx_tower_case_id ON tower_dump_records(case_id);
CREATE INDEX IF NOT EXISTS idx_tower_cell_id ON tower_dump_records(cell_id);
CREATE INDEX IF NOT EXISTS idx_tower_imsi ON tower_dump_records(imsi);
CREATE INDEX IF NOT EXISTS idx_tower_imei ON tower_dump_records(imei);
CREATE INDEX IF NOT EXISTS idx_tower_cell_time ON tower_dump_records(cell_id, start_time);
CREATE INDEX IF NOT EXISTS idx_tower_start ON tower_dump_records(start_time);

-- ============================================================
-- 016: audit_logs (enhanced per §33)
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id                  SERIAL PRIMARY KEY,
    user_id             INTEGER REFERENCES users(id),
    officer_buckle_id   VARCHAR(50),
    officer_name        VARCHAR(255),
    session_id          TEXT,
    action              TEXT NOT NULL,
    resource_type       TEXT,
    resource_id         TEXT,
    details             JSONB,
    ip_address          INET,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

-- ============================================================
-- 017: chat_history (§45.1.2)
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_history (
    id              SERIAL PRIMARY KEY,
    session_id      UUID NOT NULL,
    case_id         INTEGER REFERENCES cases(id),
    user_id         INTEGER NOT NULL REFERENCES users(id),
    role            VARCHAR(10) NOT NULL
                    CHECK (role IN ('user', 'assistant', 'system')),
    message         TEXT NOT NULL,
    generated_sql   TEXT,
    citations       JSONB,
    confidence      DECIMAL(3,2),
    response_time_ms INTEGER,
    model_version   VARCHAR(50),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_history(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_case ON chat_history(case_id);
CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_history(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_history(created_at);

-- ============================================================
-- 018: evidence_exports (§42.2)
-- ============================================================
CREATE TABLE IF NOT EXISTS evidence_exports (
    id              SERIAL PRIMARY KEY,
    case_id         INTEGER NOT NULL REFERENCES cases(id),
    user_id         INTEGER NOT NULL REFERENCES users(id),
    export_type     VARCHAR(20) NOT NULL
                    CHECK (export_type IN ('pdf', 'csv', 'excel', 'json')),
    data_scope      VARCHAR(50) NOT NULL,
    record_count    INTEGER,
    file_checksum   VARCHAR(64),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    ip_address      INET,
    user_agent      TEXT
);
CREATE INDEX IF NOT EXISTS idx_exports_case ON evidence_exports(case_id);
CREATE INDEX IF NOT EXISTS idx_exports_user ON evidence_exports(user_id);

-- ============================================================
-- 019: officer_imports (§44.5)
-- ============================================================
CREATE TABLE IF NOT EXISTS officer_imports (
    id                  SERIAL PRIMARY KEY,
    imported_by         INTEGER NOT NULL REFERENCES users(id),
    file_checksum       VARCHAR(64) NOT NULL,
    original_filename   VARCHAR(500) NOT NULL,
    total_rows          INTEGER NOT NULL,
    new_count           INTEGER DEFAULT 0,
    updated_count       INTEGER DEFAULT 0,
    deactivated_count   INTEGER DEFAULT 0,
    error_count         INTEGER DEFAULT 0,
    changes_json        JSONB,
    status              VARCHAR(20) DEFAULT 'applied'
                        CHECK (status IN ('applied', 'rolled_back', 'failed')),
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 020: archived_cases (§45.1.1)
-- ============================================================
CREATE TABLE IF NOT EXISTS archived_cases (
    id                      INTEGER PRIMARY KEY,
    case_name               VARCHAR(255) NOT NULL,
    case_number             VARCHAR(50) NOT NULL,
    case_type               VARCHAR(50),
    description             TEXT,
    investigation_details   TEXT,
    status                  VARCHAR(20) DEFAULT 'archived',
    priority                VARCHAR(10),
    created_by_user_id      INTEGER,
    updated_by_user_id      INTEGER,
    closed_by_user_id       INTEGER,
    start_date              DATE,
    end_date                DATE,
    created_at              TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ,
    closed_at               TIMESTAMPTZ,
    archived_at             TIMESTAMPTZ DEFAULT NOW(),
    archived_by             INTEGER,
    archive_reason          VARCHAR(100) DEFAULT 'retention_policy',
    original_data_json      JSONB
);
CREATE INDEX IF NOT EXISTS idx_archived_cases_number ON archived_cases(case_number);
CREATE INDEX IF NOT EXISTS idx_archived_cases_date ON archived_cases(archived_at);

-- ============================================================
-- 021: admin_accounts
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_accounts (
    id                      SERIAL PRIMARY KEY,
    email                   VARCHAR(255) UNIQUE NOT NULL,
    password_hash           VARCHAR(255) NOT NULL,
    full_name               VARCHAR(255) NOT NULL,
    role                    VARCHAR(30) NOT NULL DEFAULT 'it_admin'
                            CHECK (role IN ('it_admin', 'it_auditor')),
    permissions             JSONB NOT NULL DEFAULT '["console_access"]'::jsonb,
    failed_login_attempts   INTEGER DEFAULT 0,
    locked_until            TIMESTAMPTZ,
    last_login              TIMESTAMPTZ,
    last_password_change    TIMESTAMPTZ DEFAULT NOW(),
    is_active               BOOLEAN DEFAULT TRUE,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS totp_enforced_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_admin_accounts_email ON admin_accounts(email);

-- ============================================================
-- 022: admin_refresh_tokens
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_refresh_tokens (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_account_id    INTEGER NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
    token_hash          VARCHAR(128) NOT NULL,
    family_id           UUID NOT NULL,
    is_revoked          BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    replaced_by         UUID REFERENCES admin_refresh_tokens(id),
    ip_address          INET,
    user_agent          TEXT,
    CONSTRAINT unique_admin_token_hash UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS idx_admin_refresh_tokens_account ON admin_refresh_tokens(admin_account_id);
CREATE INDEX IF NOT EXISTS idx_admin_refresh_tokens_family ON admin_refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_admin_refresh_tokens_expiry ON admin_refresh_tokens(expires_at) WHERE NOT is_revoked;

-- ============================================================
-- 023: admin_sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_account_id    INTEGER NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
    started_at          TIMESTAMPTZ DEFAULT NOW(),
    ended_at            TIMESTAMPTZ,
    ip_address          INET,
    user_agent          TEXT,
    logout_reason       VARCHAR(50)
                        CHECK (logout_reason IN ('manual', 'expired', 'admin_forced', 'lockout'))
);
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS last_reauthenticated_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_admin_sessions_account ON admin_sessions(admin_account_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_active ON admin_sessions(admin_account_id) WHERE ended_at IS NULL;

-- ============================================================
-- 024: admin_action_logs
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_action_logs (
    id                  SERIAL PRIMARY KEY,
    admin_account_id    INTEGER REFERENCES admin_accounts(id) ON DELETE SET NULL,
    session_id          TEXT,
    action              TEXT NOT NULL,
    resource_type       TEXT,
    resource_id         TEXT,
    details             JSONB,
    ip_address          INET,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_action_logs_account ON admin_action_logs(admin_account_id);
CREATE INDEX IF NOT EXISTS idx_admin_action_logs_action ON admin_action_logs(action);
CREATE INDEX IF NOT EXISTS idx_admin_action_logs_created ON admin_action_logs(created_at);

-- ============================================================
-- 025: admin_alert_acknowledgements
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_alert_acknowledgements (
    id                  SERIAL PRIMARY KEY,
    alert_key           TEXT NOT NULL UNIQUE,
    acknowledged_by     INTEGER REFERENCES admin_accounts(id) ON DELETE SET NULL,
    note                TEXT,
    acknowledged_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_alert_ack_alert_key ON admin_alert_acknowledgements(alert_key);

-- ============================================================
-- 026: admin_activity_feed_v
-- ============================================================
CREATE OR REPLACE VIEW admin_activity_feed_v AS
SELECT
    'audit'::TEXT AS source,
    al.id::TEXT AS id,
    al.created_at,
    'officer'::TEXT AS actor_type,
    al.user_id::TEXT AS actor_id,
    COALESCE(u.full_name, al.officer_name, 'Unknown officer') AS actor_name,
    u.email AS actor_email,
    u.role AS actor_role,
    al.action,
    al.resource_type,
    al.resource_id,
    al.session_id,
    COALESCE(HOST(al.ip_address), NULL) AS ip_address,
    COALESCE(al.details, '{}'::jsonb) AS details,
    CASE
        WHEN COALESCE(al.details->>'caseId', '') ~ '^[0-9]+$' THEN (al.details->>'caseId')::INTEGER
        WHEN al.resource_type = 'case' AND COALESCE(al.resource_id, '') ~ '^[0-9]+$' THEN al.resource_id::INTEGER
        ELSE NULL
    END AS case_id,
    CASE
        WHEN al.resource_type = 'file' AND COALESCE(al.resource_id, '') ~ '^[0-9]+$' THEN al.resource_id::INTEGER
        WHEN COALESCE(al.details->>'fileId', '') ~ '^[0-9]+$' THEN (al.details->>'fileId')::INTEGER
        ELSE NULL
    END AS file_id
FROM audit_logs al
LEFT JOIN users u ON u.id = al.user_id

UNION ALL

SELECT
    'admin'::TEXT AS source,
    aal.id::TEXT AS id,
    aal.created_at,
    'admin'::TEXT AS actor_type,
    aal.admin_account_id::TEXT AS actor_id,
    COALESCE(aa.full_name, 'Unknown admin') AS actor_name,
    aa.email AS actor_email,
    aa.role AS actor_role,
    aal.action,
    aal.resource_type,
    aal.resource_id,
    aal.session_id,
    COALESCE(HOST(aal.ip_address), NULL) AS ip_address,
    COALESCE(aal.details, '{}'::jsonb) AS details,
    CASE
        WHEN COALESCE(aal.details->>'caseId', '') ~ '^[0-9]+$' THEN (aal.details->>'caseId')::INTEGER
        WHEN aal.resource_type = 'case' AND COALESCE(aal.resource_id, '') ~ '^[0-9]+$' THEN aal.resource_id::INTEGER
        ELSE NULL
    END AS case_id,
    CASE
        WHEN aal.resource_type = 'file' AND COALESCE(aal.resource_id, '') ~ '^[0-9]+$' THEN aal.resource_id::INTEGER
        WHEN COALESCE(aal.details->>'fileId', '') ~ '^[0-9]+$' THEN (aal.details->>'fileId')::INTEGER
        ELSE NULL
    END AS file_id
FROM admin_action_logs aal
LEFT JOIN admin_accounts aa ON aa.id = aal.admin_account_id;

-- ============================================================
-- 026: admin_case_overview_v
-- ============================================================
CREATE OR REPLACE VIEW admin_case_overview_v AS
SELECT
    c.id,
    c.case_name,
    c.case_number,
    c.case_type,
    c.fir_number,
    c.operator,
    c.status,
    c.priority,
    c.description,
    c.investigation_details,
    c.start_date,
    c.end_date,
    c.created_at,
    c.updated_at,
    c.is_evidence_locked,
    c.locked_at,
    c.lock_reason,
    creator.id AS created_by_user_id,
    creator.full_name AS created_by_name,
    creator.buckle_id AS created_by_buckle_id,
    COALESCE(owner_summary.owner_id, creator.id) AS owner_id,
    COALESCE(owner_summary.owner_name, creator.full_name) AS owner_name,
    COALESCE(owner_summary.owner_buckle_id, creator.buckle_id) AS owner_buckle_id,
    COALESCE(assignment_summary.assignment_count, 0) AS assignment_count,
    COALESCE(assignment_summary.assigned_officers, '[]'::jsonb) AS assigned_officers,
    COALESCE(assignment_summary.assignment_search, '') AS assignment_search,
    COALESCE(file_summary.file_count, 0) AS file_count,
    COALESCE(file_summary.failed_parse_files, 0) AS failed_parse_files,
    COALESCE(file_summary.completed_files, 0) AS completed_files,
    COALESCE(file_summary.pending_files, 0) AS pending_files,
    COALESCE(activity_summary.recent_activity_count, 0) AS recent_activity_count,
    activity_summary.last_activity_at
FROM cases c
LEFT JOIN users creator ON creator.id = c.created_by_user_id
LEFT JOIN LATERAL (
    SELECT
        owner_user.id AS owner_id,
        owner_user.full_name AS owner_name,
        owner_user.buckle_id AS owner_buckle_id
    FROM case_assignments owner_assignment
    JOIN users owner_user ON owner_user.id = owner_assignment.user_id
    WHERE owner_assignment.case_id = c.id
      AND owner_assignment.role = 'owner'
      AND owner_assignment.is_active = TRUE
    ORDER BY owner_assignment.assigned_at DESC
    LIMIT 1
) owner_summary ON TRUE
LEFT JOIN LATERAL (
    SELECT
        COUNT(*)::INTEGER AS assignment_count,
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'userId', u.id,
                    'fullName', u.full_name,
                    'buckleId', u.buckle_id,
                    'role', ca.role
                )
                ORDER BY ca.assigned_at DESC
            ) FILTER (WHERE u.id IS NOT NULL),
            '[]'::jsonb
        ) AS assigned_officers,
        COALESCE(
            STRING_AGG(DISTINCT CONCAT_WS(' ', u.full_name, u.buckle_id), ' '),
            ''
        ) AS assignment_search
    FROM case_assignments ca
    JOIN users u ON u.id = ca.user_id
    WHERE ca.case_id = c.id
      AND ca.is_active = TRUE
) assignment_summary ON TRUE
LEFT JOIN LATERAL (
    SELECT
        COUNT(*)::INTEGER AS file_count,
        COUNT(*) FILTER (WHERE uf.parse_status = 'failed')::INTEGER AS failed_parse_files,
        COUNT(*) FILTER (WHERE uf.parse_status = 'completed')::INTEGER AS completed_files,
        COUNT(*) FILTER (WHERE uf.parse_status IN ('pending', 'processing'))::INTEGER AS pending_files
    FROM uploaded_files uf
    WHERE uf.case_id = c.id
) file_summary ON TRUE
LEFT JOIN LATERAL (
    SELECT
        COUNT(*) FILTER (WHERE a.created_at >= NOW() - INTERVAL '7 days')::INTEGER AS recent_activity_count,
        MAX(a.created_at) AS last_activity_at
    FROM admin_activity_feed_v a
    WHERE a.case_id = c.id
) activity_summary ON TRUE;

-- ============================================================
-- 027: admin_file_governance_v
-- ============================================================
CREATE OR REPLACE VIEW admin_file_governance_v AS
SELECT
    uf.id,
    uf.case_id,
    c.case_name,
    c.case_number,
    c.status AS case_status,
    c.priority AS case_priority,
    c.is_evidence_locked,
    uf.file_name,
    uf.original_name,
    uf.file_type,
    uf.file_size,
    uf.mime_type,
    uf.parse_status,
    uf.record_count,
    uf.uploaded_by,
    uploader.full_name AS uploaded_by_name,
    uploader.buckle_id AS uploaded_by_buckle_id,
    uf.uploaded_at,
    fc.expected_type,
    fc.detected_type,
    fc.confidence,
    fc.classification_result,
    fc.error_message,
    COALESCE(fc.detected_type, fc.expected_type, uf.file_type, 'unknown') AS telecom_module
FROM uploaded_files uf
LEFT JOIN cases c ON c.id = uf.case_id
LEFT JOIN users uploader ON uploader.id = uf.uploaded_by
LEFT JOIN file_classifications fc ON fc.file_id = uf.id;

-- ============================================================
-- 028: app_settings
-- ============================================================
CREATE TABLE IF NOT EXISTS app_settings (
    id          SERIAL PRIMARY KEY,
    key         VARCHAR(100) UNIQUE NOT NULL,
    value       JSONB,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO app_settings (key, value) VALUES
    ('ollama_model', '"phi3.5"'),
    ('max_file_size', '52428800'),
    ('rate_limit_window', '900000'),
    ('rate_limit_max', '100')
ON CONFLICT (key) DO NOTHING;
