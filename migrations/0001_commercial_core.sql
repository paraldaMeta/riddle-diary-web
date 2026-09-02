PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  credit_balance INTEGER NOT NULL DEFAULT 0,
  trial_granted INTEGER NOT NULL DEFAULT 0 CHECK (trial_granted IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE user_emails (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at INTEGER NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_user_emails_user ON user_emails(user_id);

CREATE TABLE user_phones (
  phone TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at INTEGER NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_user_phones_user ON user_phones(user_id);

CREATE TABLE oauth_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX idx_oauth_identities_user ON oauth_identities(user_id);

CREATE TABLE password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_params TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip_hash TEXT,
  user_agent_hash TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE verification_challenges (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'phone')),
  identifier TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'register', 'reset', 'link')),
  code_hash TEXT NOT NULL,
  payload_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  requested_ip_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_challenges_identifier ON verification_challenges(channel, identifier, purpose, created_at DESC);
CREATE INDEX idx_challenges_expiry ON verification_challenges(expires_at);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL DEFAULT '/',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_oauth_states_expiry ON oauth_states(expires_at);

CREATE TABLE rate_limits (
  bucket_key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE INDEX idx_rate_limits_reset ON rate_limits(reset_at);

CREATE TABLE credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_credit_ledger_user ON credit_ledger(user_id, created_at DESC);

CREATE TRIGGER credit_ledger_apply_balance
AFTER INSERT ON credit_ledger
BEGIN
  UPDATE users
  SET credit_balance = credit_balance + NEW.delta,
      updated_at = NEW.created_at
  WHERE id = NEW.user_id AND deleted_at IS NULL;
END;

CREATE TABLE usage_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  cost INTEGER NOT NULL CHECK (cost IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'succeeded', 'refunded')),
  conversation_id TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, request_id)
);
CREATE INDEX idx_usage_requests_user ON usage_requests(user_id, created_at DESC);

CREATE TRIGGER usage_reserve_credit
BEFORE INSERT ON usage_requests
WHEN NEW.cost = 1
BEGIN
  SELECT RAISE(ABORT, 'INSUFFICIENT_CREDITS')
  WHERE COALESCE((SELECT credit_balance FROM users WHERE id = NEW.user_id AND deleted_at IS NULL), 0) < 1;

  INSERT INTO credit_ledger (id, user_id, delta, kind, source_key, metadata_json, created_at)
  VALUES (
    NEW.id || ':debit',
    NEW.user_id,
    -1,
    'conversation',
    'usage:' || NEW.user_id || ':' || NEW.request_id,
    json_object('requestId', NEW.request_id),
    NEW.created_at
  );
END;

CREATE TRIGGER usage_refund_credit
AFTER UPDATE OF status ON usage_requests
WHEN OLD.status = 'reserved' AND NEW.status = 'refunded' AND NEW.cost = 1
BEGIN
  INSERT OR IGNORE INTO credit_ledger (id, user_id, delta, kind, source_key, metadata_json, created_at)
  VALUES (
    NEW.id || ':refund',
    NEW.user_id,
    1,
    'conversation_refund',
    'usage-refund:' || NEW.user_id || ':' || NEW.request_id,
    json_object('requestId', NEW.request_id, 'errorCode', NEW.error_code),
    NEW.updated_at
  );
END;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  recognized_question TEXT NOT NULL,
  answer TEXT NOT NULL,
  is_prediction INTEGER NOT NULL DEFAULT 0 CHECK (is_prediction IN (0, 1)),
  topic TEXT,
  draw_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, request_id)
);
CREATE INDEX idx_conversations_user ON conversations(user_id, created_at DESC, id DESC);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  stripe_session_id TEXT NOT NULL UNIQUE,
  payment_intent_id TEXT,
  charge_id TEXT,
  package_id TEXT NOT NULL,
  amount_cny INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'disputed')),
  refunded_amount INTEGER NOT NULL DEFAULT 0,
  customer_email TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_payments_user ON payments(user_id, created_at DESC);
CREATE INDEX idx_payments_intent ON payments(payment_intent_id);

CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
CREATE INDEX idx_webhook_events_processed ON webhook_events(processed_at);
