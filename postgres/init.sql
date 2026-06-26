-- Obedové menu PostgreSQL schema
-- Project: pidiman/lunch
-- Purpose:
--   n8n import workflow stores normalized daily lunch menu items here.
--   Web landing page reads today's menu from v_lunch_menu_today.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) Source registry
-- One row per restaurant/source. n8n can use this later to drive imports dynamically.
CREATE TABLE IF NOT EXISTS lunch_sources (
  source_id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (
    source_type IN (
      'html_woocommerce_category',
      'html_daily_menu_page',
      'pdf_weekly_menu',
      'api',
      'manual'
    )
  ),
  source_url TEXT NOT NULL,
  restaurant_name TEXT,
  city TEXT DEFAULT 'Bratislava',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  parser_name TEXT,
  parser_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) Import run log
-- One row per n8n run. Useful for debugging and alerting.
CREATE TABLE IF NOT EXISTS lunch_import_runs (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (
    status IN ('running', 'success', 'partial_success', 'failed')
  ),
  source_count INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3) Normalized daily menu items
-- This is the main table used by n8n and the landing page.
CREATE TABLE IF NOT EXISTS lunch_menu_items (
  id BIGSERIAL PRIMARY KEY,

  -- Stable unique key generated in n8n, for example:
  -- belavery-2026-06-26-02-furmanske-halusky
  item_uid TEXT NOT NULL UNIQUE,

  -- Source metadata duplicated intentionally for simple web reads and historical snapshots.
  source_id TEXT NOT NULL REFERENCES lunch_sources(source_id) ON UPDATE CASCADE,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT NOT NULL,

  -- Menu date in Europe/Bratislava.
  menu_date DATE NOT NULL,

  -- Optional restaurant menu code: 01, 02, S, soup, etc.
  menu_code TEXT,

  -- Recommended values: soup, main, pizza, special, side, dessert, drink, unknown.
  category TEXT NOT NULL DEFAULT 'main',

  title TEXT NOT NULL,
  description TEXT,
  price_eur NUMERIC(10,2) CHECK (price_eur IS NULL OR price_eur >= 0),
  currency TEXT NOT NULL DEFAULT 'EUR',

  -- Allergens are stored as JSON array, for example ["1", "3", "7"].
  allergens JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Raw extracted text for troubleshooting parser issues.
  raw_text TEXT,

  -- n8n/import metadata.
  parsed_at TIMESTAMPTZ,
  run_id TEXT REFERENCES lunch_import_runs(run_id) ON UPDATE CASCADE,
  parser_name TEXT,
  parser_version TEXT,

  -- Soft flags for later features.
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  is_duplicate BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4) Parser/import errors per source
CREATE TABLE IF NOT EXISTS lunch_import_errors (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT REFERENCES lunch_import_runs(run_id) ON UPDATE CASCADE,
  source_id TEXT REFERENCES lunch_sources(source_id) ON UPDATE CASCADE,
  stage TEXT NOT NULL,
  error_code TEXT NOT NULL,
  error_message TEXT,
  debug_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5) Seed current known sources
INSERT INTO lunch_sources (
  source_id,
  source_name,
  source_type,
  source_url,
  restaurant_name,
  city,
  parser_name,
  parser_version
)
VALUES
  (
    'belavery',
    'BelaVery',
    'html_woocommerce_category',
    'https://belavery.sk/produktova-kategoria/denne-menu/',
    'BelaVery',
    'Bratislava',
    'belavery',
    'v4-price-space-fix'
  ),
  (
    'amelia',
    'Ostravárna Amélia',
    'html_daily_menu_page',
    'http://www.ameliarestaurant.sk/dennemenu/index',
    'Ostravárna Amélia',
    'Bratislava',
    'amelia',
    'v1-day-block-price-parser'
  ),
  (
    'zark',
    'ZARK',
    'pdf_weekly_menu',
    'https://cdn.website.dish.co/media/72/8d/10031135/Tyzdenne-menu.pdf',
    'ZARK',
    'Bratislava',
    'zark_pdf',
    'v1-weekday-block-parser'
  )
ON CONFLICT (source_id) DO UPDATE SET
  source_name = EXCLUDED.source_name,
  source_type = EXCLUDED.source_type,
  source_url = EXCLUDED.source_url,
  restaurant_name = EXCLUDED.restaurant_name,
  city = EXCLUDED.city,
  parser_name = EXCLUDED.parser_name,
  parser_version = EXCLUDED.parser_version,
  updated_at = NOW();

-- 6) Indexes for n8n upsert and fast landing page reads
CREATE INDEX IF NOT EXISTS idx_lunch_menu_items_date
ON lunch_menu_items(menu_date);

CREATE INDEX IF NOT EXISTS idx_lunch_menu_items_source_date
ON lunch_menu_items(source_id, menu_date);

CREATE INDEX IF NOT EXISTS idx_lunch_menu_items_category_date
ON lunch_menu_items(menu_date, category);

CREATE INDEX IF NOT EXISTS idx_lunch_menu_items_run_id
ON lunch_menu_items(run_id);

CREATE INDEX IF NOT EXISTS idx_lunch_menu_items_available_today
ON lunch_menu_items(menu_date, source_name, category, menu_code)
WHERE is_available = TRUE;

CREATE INDEX IF NOT EXISTS idx_lunch_import_runs_status_started
ON lunch_import_runs(status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_lunch_import_errors_run_id
ON lunch_import_errors(run_id);

-- 7) updated_at trigger helper
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lunch_sources_updated_at ON lunch_sources;
CREATE TRIGGER trg_lunch_sources_updated_at
BEFORE UPDATE ON lunch_sources
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_lunch_import_runs_updated_at ON lunch_import_runs;
CREATE TRIGGER trg_lunch_import_runs_updated_at
BEFORE UPDATE ON lunch_import_runs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_lunch_menu_items_updated_at ON lunch_menu_items;
CREATE TRIGGER trg_lunch_menu_items_updated_at
BEFORE UPDATE ON lunch_menu_items
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- 8) View used by the simple landing page
CREATE OR REPLACE VIEW v_lunch_menu_today AS
SELECT
  id,
  item_uid,
  source_id,
  source_name,
  source_type,
  source_url,
  menu_date,
  menu_code,
  category,
  title,
  description,
  price_eur,
  currency,
  allergens,
  parsed_at,
  parser_name,
  parser_version
FROM lunch_menu_items
WHERE menu_date = CURRENT_DATE
  AND is_available = TRUE
ORDER BY
  source_name,
  CASE category
    WHEN 'soup' THEN 1
    WHEN 'main' THEN 2
    WHEN 'special' THEN 3
    WHEN 'pizza' THEN 4
    WHEN 'side' THEN 5
    WHEN 'dessert' THEN 6
    WHEN 'drink' THEN 7
    ELSE 99
  END,
  menu_code NULLS LAST,
  title;

-- 9) View for last successful import status
CREATE OR REPLACE VIEW v_lunch_import_status AS
SELECT
  r.run_id,
  r.started_at,
  r.finished_at,
  r.status,
  r.source_count,
  r.item_count,
  r.error_count,
  r.error_message,
  r.meta
FROM lunch_import_runs r
ORDER BY r.started_at DESC;

COMMIT;
