-- Per-user choice of the public page layout. 'listok' (Týždenný lístok) is the default;
-- admins can switch themselves to 'palcom' in the admin page.

ALTER TABLE public.lunch_users
  ADD COLUMN IF NOT EXISTS page_layout TEXT NOT NULL DEFAULT 'listok'
  CHECK (page_layout IN ('listok', 'palcom'));
