-- Neon Postgres schema for MobileTrade
-- Run this on a fresh database, or use it as a reference.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- USERS
CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text UNIQUE,
  email text,
  password_hash text NOT NULL,
  google_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text UNIQUE,
  email text,
  password_hash text NOT NULL,
  google_id text,
  partner_id uuid,
  latitude double precision,
  longitude double precision,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Ensure newer columns exist even on older databases
ALTER TABLE agents ADD COLUMN IF NOT EXISTS google_id text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS partner_id uuid;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS longitude double precision;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_agents_partner ON agents(partner_id);

CREATE TABLE IF NOT EXISTS partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text UNIQUE,
  email text,
  password_hash text NOT NULL,
  google_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ADDRESSES
CREATE TABLE IF NOT EXISTS customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  full_address text NOT NULL,
  city text,
  state text,
  pincode text,
  latitude double precision,
  longitude double precision,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ORDERS
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_status') THEN
    CREATE TYPE order_status AS ENUM ('pending', 'in-progress', 'completed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  address_id uuid NOT NULL REFERENCES customer_addresses(id) ON DELETE RESTRICT,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,

  phone_model text,
  phone_variant text,
  phone_condition text,
  price numeric(12,2) NOT NULL DEFAULT 0,
  pickup_date date,
  time_slot text,
  payment_method text,
  status order_status NOT NULL DEFAULT 'pending',

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_agent ON orders(agent_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
