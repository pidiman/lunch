-- Per-user personalization of the public page: favorite restaurants,
-- own location order and a default location tab.

CREATE TABLE IF NOT EXISTS public.lunch_user_favorites (
  user_id BIGINT NOT NULL REFERENCES public.lunch_users(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES public.lunch_sources(source_id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, source_id)
);

-- Only stored when the user's order differs from the global lunch_locations.weight order
CREATE TABLE IF NOT EXISTS public.lunch_user_location_weights (
  user_id BIGINT NOT NULL REFERENCES public.lunch_users(id) ON DELETE CASCADE,
  location_name TEXT NOT NULL REFERENCES public.lunch_locations(name) ON DELETE CASCADE ON UPDATE CASCADE,
  weight INTEGER NOT NULL,
  PRIMARY KEY (user_id, location_name)
);

ALTER TABLE public.lunch_users
  ADD COLUMN IF NOT EXISTS default_location TEXT
  REFERENCES public.lunch_locations(name) ON DELETE SET NULL ON UPDATE CASCADE;
