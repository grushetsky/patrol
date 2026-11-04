-- Slice 1: identity, bootstrap, sessions, and roles (ADR 0025, 0026).
-- Credential material (password hashes, TOTP secrets, recovery-code hashes,
-- session token hashes) lives only here and never crosses the API surface.

-- The single rights holder per deployment, with the signatory embedded as a
-- value (ADR 0026: the signatory is a profile, not an account). Bootstrap
-- records the legal name and country; the contact and signatory profile are
-- completed later through settings, so those columns stay nullable. The
-- `singleton` column exists only to carry a UNIQUE constraint: every row
-- holds true, so the database itself refuses a second rights holder even
-- against two racing bootstrap transactions.
CREATE TABLE rights_holder (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  singleton boolean NOT NULL DEFAULT true,
  legal_name text NOT NULL,
  country text NOT NULL,
  address_line1 text,
  address_line2 text,
  address_city text,
  address_region text,
  address_postal_code text,
  role_mailbox text,
  phone text,
  signatory_full_legal_name text,
  signatory_authority_basis text,
  signatory_contact_email text,
  signatory_contact_phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX rights_holder_singleton_key ON rights_holder (singleton);

-- Operator accounts. `password_hash` is null between invitation and the
-- password step; `totp_secret` is null until the enrolment ceremony confirms
-- a candidate secret. Exactly one rights holder exists, so no tenant column.
CREATE TABLE operators (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  email text NOT NULL,
  password_hash text,
  role text NOT NULL CHECK (role IN ('operator', 'administrator')),
  state text NOT NULL DEFAULT 'invited'
    CHECK (state IN ('invited', 'active', 'disabled')),
  preferred_language text CHECK (preferred_language IN ('en', 'ru')),
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_sign_in_at timestamptz,
  totp_secret text,
  totp_enrolled_at timestamptz,
  disabled_at timestamptz,
  disabled_by uuid REFERENCES operators (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX operators_email_key ON operators (email);
CREATE INDEX operators_role_state_idx ON operators (role, state);

-- The TOTP enrolment ceremony a setup or invitation starts: the enrollment
-- token is stored only as its SHA-256, the candidate secret appears once the
-- operator begins enrolment, and confirmation moves it onto the operator row.
CREATE TABLE totp_enrollment (
  operator_id uuid PRIMARY KEY REFERENCES operators (id) ON DELETE CASCADE,
  enrollment_token_hash text NOT NULL,
  enrollment_expires_at timestamptz NOT NULL,
  pending_secret text,
  pending_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX totp_enrollment_token_key ON totp_enrollment (enrollment_token_hash);

-- Single-use operator invitations, valid twenty-four hours, stored only as a
-- hash. The bootstrap setup token is the first invitation row; it has no
-- issuing operator, which is why invited_by is nullable.
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('operator', 'administrator')),
  token_hash text NOT NULL,
  invited_by uuid REFERENCES operators (id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX invitations_token_key ON invitations (token_hash);
CREATE INDEX invitations_email_idx ON invitations (email);
CREATE INDEX invitations_pending_idx ON invitations (expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- The second-factor challenge a correct password issues. The challenge id is
-- a 256-bit random token; only its hash is stored. Consumed rows are deleted.
CREATE TABLE auth_challenges (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  operator_id uuid NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX auth_challenges_token_key ON auth_challenges (token_hash);
CREATE INDEX auth_challenges_operator_idx ON auth_challenges (operator_id);

-- Server-side sessions: 256-bit tokens stored only as SHA-256. Idle expiry
-- slides with activity; absolute expiry is seven days from creation. The
-- CSRF token is stored verbatim because GET /auth/session returns it to the
-- operator's own client; it is not a secret from the server, and a leaked
-- row still cannot reconstruct the session token. Revocation deletes the
-- row; there is no revoked marker to consult.
CREATE TABLE operator_sessions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  operator_id uuid NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  user_agent text NOT NULL,
  coarse_ip text
);

CREATE UNIQUE INDEX operator_sessions_token_key ON operator_sessions (token_hash);
CREATE INDEX operator_sessions_operator_idx ON operator_sessions (operator_id, created_at DESC);

-- Ten single-use recovery codes per enrolment, stored only as hashes.
-- Consumption deletes the row, so a spent code is simply absent; a reset or
-- re-enrolment deletes every remaining code before issuing fresh ones.
CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  operator_id uuid NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX recovery_codes_code_key ON recovery_codes (code_hash);
CREATE INDEX recovery_codes_operator_idx ON recovery_codes (operator_id);

-- Append-only security events, separate from the domain audit trail. Never a
-- password, a TOTP secret, a session token, or a recovery code in `detail`.
CREATE TABLE security_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  operator_id uuid REFERENCES operators (id) ON DELETE SET NULL,
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  coarse_ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX security_events_operator_idx ON security_events (operator_id, created_at DESC);
CREATE INDEX security_events_kind_idx ON security_events (kind, created_at DESC);
