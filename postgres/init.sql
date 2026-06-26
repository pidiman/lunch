CREATE TABLE IF NOT EXISTS lunch_menu_items (
  id BIGSERIAL PRIMARY KEY,
  item_uid TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT NOT NULL,
  menu_date DATE NOT NULL,
  menu_code TEXT,
  category TEXT,
  title TEXT NOT NULL,
  description TEXT,
  price_eur NUMERIC(10,2),
  currency TEXT DEFAULT 'EUR',
  allergens JSONB DEFAULT '[]'::jsonb,
  raw_text TEXT,
  parsed_at TIMESTAMPTZ,
  run_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lunch_menu_items_date
ON lunch_menu_items(menu_date);

CREATE INDEX IF NOT EXISTS idx_lunch_menu_items_source_date
ON lunch_menu_items(source_id, menu_date);

CREATE INDEX IF NOT EXISTS idx_lunch_menu_items_uid
ON lunch_menu_items(item_uid);

CREATE TABLE IF NOT EXISTS lunch_import_runs (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  source_count INTEGER DEFAULT 0,
  item_count INTEGER DEFAULT 0,
  error_message TEXT,
  meta JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS lunch_sources (
  source_id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO lunch_sources (source_id, source_name, source_type, source_url)
VALUES
  ('belavery', 'BelaVery', 'html_woocommerce_category', 'https://belavery.sk/produktova-kategoria/denne-menu/'),
  ('amelia', 'Ostravárna Amélia', 'html_daily_menu_page', 'http://www.ameliarestaurant.sk/dennemenu/index'),
  ('zark', 'ZARK', 'pdf_weekly_menu', 'https://cdn.website.dish.co/media/72/8d/10031135/Tyzdenne-menu.pdf')
ON CONFLICT (source_id) DO UPDATE SET
  source_name = EXCLUDED.source_name,
  source_type = EXCLUDED.source_type,
  source_url = EXCLUDED.source_url,
  updated_at = NOW();

CREATE OR REPLACE VIEW v_lunch_menu_today AS
SELECT
  source_id,
  source_name,
  menu_date,
  menu_code,
  category,
  title,
  description,
  price_eur,
  currency,
  allergens,
  source_url,
  parsed_at
FROM lunch_menu_items
WHERE menu_date = CURRENT_DATE
ORDER BY source_name, category, menu_code NULLS LAST, title;
