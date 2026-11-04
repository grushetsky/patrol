CREATE TABLE IF NOT EXISTS rights_holder (
  id text,
  legal_name text,
  country text,
  address text,
  role_mailbox text,
  phone text,
  signatory_name text,
  signatory_authority_basis text,
  signatory_email text,
  signatory_phone text,
  created_at timestamptz,
  updated_at timestamptz
);

CREATE TABLE IF NOT EXISTS operator_account (
  id text,
  email text,
  role text,
  state text,
  preferred_language text,
  password_hash text,
  totp_secret text,
  pending_totp_secret text,
  totp_enrolled_at timestamptz,
  last_sign_in_at timestamptz,
  failed_attempts int,
  locked_until timestamptz,
  disabled_at timestamptz,
  disabled_by text,
  created_at timestamptz,
  updated_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS operator_account_email_key
  ON operator_account (email);

CREATE TABLE IF NOT EXISTS operator_session (
  id text,
  operator_id text,
  token_sha256 text,
  created_at timestamptz,
  last_seen_at timestamptz,
  idle_expires_at timestamptz,
  absolute_expires_at timestamptz,
  revoked_at timestamptz,
  user_agent text,
  coarse_ip text
);

CREATE UNIQUE INDEX IF NOT EXISTS operator_session_token_key
  ON operator_session (token_sha256);

CREATE INDEX IF NOT EXISTS operator_session_operator_idx
  ON operator_session (operator_id);

CREATE TABLE IF NOT EXISTS recovery_code (
  id text,
  operator_id text,
  code_hash text,
  used_at timestamptz,
  created_at timestamptz
);

CREATE INDEX IF NOT EXISTS recovery_code_operator_idx
  ON recovery_code (operator_id);

CREATE UNIQUE INDEX IF NOT EXISTS recovery_code_hash_key
  ON recovery_code (operator_id, code_hash);

CREATE TABLE IF NOT EXISTS setup_token (
  id text,
  token_hash text,
  operator_id text,
  purpose text,
  expires_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS setup_token_hash_key
  ON setup_token (token_hash);

CREATE TABLE IF NOT EXISTS enrollment_token (
  id text,
  token_hash text,
  operator_id text,
  expires_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS enrollment_token_hash_key
  ON enrollment_token (token_hash);

CREATE TABLE IF NOT EXISTS login_challenge (
  id text,
  operator_id text,
  expires_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS login_challenge_id_key
  ON login_challenge (id);

CREATE TABLE IF NOT EXISTS invitation (
  id text,
  email text,
  role text,
  token_hash text,
  invited_by text,
  created_at timestamptz,
  expires_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS invitation_token_key
  ON invitation (token_hash);

CREATE INDEX IF NOT EXISTS invitation_email_idx
  ON invitation (email);

CREATE TABLE IF NOT EXISTS security_event (
  id text,
  kind text,
  operator_id text,
  email text,
  coarse_ip text,
  user_agent text,
  detail text,
  created_at timestamptz
);
