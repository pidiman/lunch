-- Slovak diacritics: location "Praca" -> "Práca".
-- User preferences (lunch_user_location_weights, lunch_users.default_location) follow
-- via ON UPDATE CASCADE; lunch_sources.source_location is plain text, so update it too.

UPDATE public.lunch_locations
SET name = 'Práca', updated_at = NOW()
WHERE name = 'Praca'
  AND NOT EXISTS (SELECT 1 FROM public.lunch_locations WHERE name = 'Práca');

UPDATE public.lunch_sources
SET source_location = 'Práca'
WHERE source_location = 'Praca';

-- If both names existed, the old one is now unused
DELETE FROM public.lunch_locations WHERE name = 'Praca';

ALTER TABLE public.lunch_sources ALTER COLUMN source_location SET DEFAULT 'Práca';
