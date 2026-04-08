-- ============================================================
-- SHAKTI v2.0 — Seed Data for Development
-- ============================================================

-- 1. Seed authorized officers (simulating Excel import)
INSERT INTO officers (buckle_id, full_name, phone_number, position, department, station) VALUES
    ('BK-4782', 'Rajesh Kumar Sharma', '+91-9876543210', 'Sub-Inspector', 'Cyber Crime Cell', 'Ahmedabad Central'),
    ('BK-9999', 'Priya Patel', '+91-9988776655', 'Inspector', 'Cyber Crime Cell', 'Ahmedabad Central'),
    ('BK-1001', 'Amit Verma', '+91-9123456789', 'ASI', 'Telecom Surveillance', 'Mumbai HQ'),
    ('BK-2022', 'Sunita Desai', '+91-9234567890', 'Inspector', 'Special Branch', 'Pune Central'),
    ('BK-3033', 'Vikram Singh', '+91-9345678901', 'SI', 'Cyber Crime Cell', 'Delhi North')
ON CONFLICT (buckle_id) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    phone_number = EXCLUDED.phone_number,
    position = EXCLUDED.position,
    department = EXCLUDED.department,
    station = EXCLUDED.station,
    updated_at = NOW();

-- 2. Seed users (password: Shakti@123) — valid bcrypt hash
INSERT INTO users (buckle_id, email, password_hash, full_name, role) VALUES
    ('BK-4782', 'rajesh@police.gov.in',  '$2a$12$QarFNbW.z.vtz2vywPNWjuF7WUJjpf0q0C26Vcw72oy16s5nZANFG', 'Rajesh Kumar Sharma', 'officer'),
    ('BK-9999', 'admin@police.gov.in',   '$2a$12$QarFNbW.z.vtz2vywPNWjuF7WUJjpf0q0C26Vcw72oy16s5nZANFG', 'Priya Patel', 'super_admin')
ON CONFLICT (buckle_id) DO UPDATE SET
    email = EXCLUDED.email,
    password_hash = EXCLUDED.password_hash,
    full_name = EXCLUDED.full_name,
    role = EXCLUDED.role,
    updated_at = NOW();

-- 3. Seed internal IT admin account (password: Shakti@123)
INSERT INTO admin_accounts (email, password_hash, full_name, role, permissions) VALUES
    ('it.admin@police.gov.in', '$2a$12$QarFNbW.z.vtz2vywPNWjuF7WUJjpf0q0C26Vcw72oy16s5nZANFG', 'IT Department Admin', 'it_admin', '["console_access"]'::jsonb)
ON CONFLICT (email) DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    full_name = EXCLUDED.full_name,
    role = EXCLUDED.role,
    permissions = EXCLUDED.permissions,
    updated_at = NOW();
