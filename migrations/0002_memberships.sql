PRAGMA foreign_keys = ON;

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  plan_id TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('basic', 'advanced')),
  interval TEXT NOT NULL CHECK (interval IN ('month', 'year')),
  status TEXT NOT NULL CHECK (status IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  current_period_start INTEGER,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id, updated_at DESC);
CREATE INDEX idx_subscriptions_customer ON subscriptions(stripe_customer_id);

CREATE TABLE membership_periods (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('basic', 'advanced')),
  interval TEXT NOT NULL CHECK (interval IN ('month', 'year')),
  allocated INTEGER NOT NULL CHECK (allocated > 0),
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  refunded INTEGER NOT NULL DEFAULT 0 CHECK (refunded >= 0),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'ended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_membership_periods_user ON membership_periods(user_id, ends_at DESC);
CREATE INDEX idx_membership_periods_subscription ON membership_periods(subscription_id, starts_at DESC);

-- This table intentionally has no foreign key to usage_requests: the reserve
-- trigger runs before that parent row exists. The period foreign key still
-- removes reservations when an account or subscription is deleted.
CREATE TABLE membership_reservations (
  usage_request_id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL REFERENCES membership_periods(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'refunded')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_membership_reservations_period ON membership_reservations(period_id, status);

CREATE TABLE membership_payments (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  period_id TEXT REFERENCES membership_periods(id) ON DELETE SET NULL,
  period_key TEXT NOT NULL UNIQUE,
  stripe_invoice_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  stripe_charge_id TEXT,
  plan_id TEXT NOT NULL,
  amount_cny INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'disputed')),
  refunded_amount INTEGER NOT NULL DEFAULT 0,
  customer_email TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_membership_payments_user ON membership_payments(user_id, created_at DESC);
CREATE INDEX idx_membership_payments_intent ON membership_payments(stripe_payment_intent_id);

DROP TRIGGER usage_reserve_credit;
DROP TRIGGER usage_refund_credit;

CREATE TRIGGER usage_reserve_credit
BEFORE INSERT ON usage_requests
WHEN NEW.cost = 1
BEGIN
  INSERT INTO membership_reservations (usage_request_id, period_id, status, created_at)
  SELECT NEW.id, period.id, 'reserved', NEW.created_at
  FROM membership_periods period
  JOIN subscriptions subscription ON subscription.id = period.subscription_id
  WHERE period.user_id = NEW.user_id
    AND period.status = 'active'
    AND period.starts_at <= NEW.created_at
    AND period.ends_at > NEW.created_at
    AND period.used + period.refunded < period.allocated
    AND subscription.status IN ('active', 'trialing', 'past_due')
  ORDER BY period.ends_at ASC
  LIMIT 1;

  UPDATE membership_periods
  SET used = used + 1,
      updated_at = NEW.created_at
  WHERE id = (SELECT period_id FROM membership_reservations WHERE usage_request_id = NEW.id);

  INSERT INTO credit_ledger (id, user_id, delta, kind, source_key, metadata_json, created_at)
  SELECT NEW.id || ':debit', NEW.user_id, -1, 'conversation',
         'usage:' || NEW.user_id || ':' || NEW.request_id,
         json_object('requestId', NEW.request_id), NEW.created_at
  WHERE NOT EXISTS (SELECT 1 FROM membership_reservations WHERE usage_request_id = NEW.id)
    AND COALESCE((SELECT credit_balance FROM users WHERE id = NEW.user_id AND deleted_at IS NULL), 0) >= 1;

  SELECT RAISE(ABORT, 'INSUFFICIENT_CREDITS')
  WHERE NOT EXISTS (SELECT 1 FROM membership_reservations WHERE usage_request_id = NEW.id)
    AND COALESCE((SELECT credit_balance FROM users WHERE id = NEW.user_id AND deleted_at IS NULL), 0) < 1;
END;

CREATE TRIGGER usage_refund_credit
AFTER UPDATE OF status ON usage_requests
WHEN OLD.status = 'reserved' AND NEW.status = 'refunded' AND NEW.cost = 1
BEGIN
  UPDATE membership_periods
  SET used = MAX(0, used - 1),
      updated_at = NEW.updated_at
  WHERE id = (SELECT period_id FROM membership_reservations WHERE usage_request_id = NEW.id);

  UPDATE membership_reservations
  SET status = 'refunded'
  WHERE usage_request_id = NEW.id AND status = 'reserved';

  INSERT OR IGNORE INTO credit_ledger (id, user_id, delta, kind, source_key, metadata_json, created_at)
  SELECT NEW.id || ':refund', NEW.user_id, 1, 'conversation_refund',
         'usage-refund:' || NEW.user_id || ':' || NEW.request_id,
         json_object('requestId', NEW.request_id, 'errorCode', NEW.error_code), NEW.updated_at
  WHERE NOT EXISTS (SELECT 1 FROM membership_reservations WHERE usage_request_id = NEW.id);
END;
