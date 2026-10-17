-- Restaurants are managed in the admin; n8n reads them from here and picks a parser by parser_name.
-- Additive only: the previous app version and the previous n8n flow keep working with this schema.

ALTER TABLE public.lunch_sources
  ADD COLUMN IF NOT EXISTS parser_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.lunch_sources
  ADD COLUMN IF NOT EXISTS has_weekend_menu BOOLEAN NOT NULL DEFAULT FALSE;

-- Map the known restaurants onto the parser registry (see PARSERS in server.js and the n8n parser workflow)
UPDATE public.lunch_sources SET parser_name = 'woocommerce_category' WHERE source_id = 'belavery';
UPDATE public.lunch_sources SET parser_name = 'amelia' WHERE source_id = 'amelia';
UPDATE public.lunch_sources SET parser_name = 'sme_restauracie' WHERE source_id = 'bequick';
UPDATE public.lunch_sources
SET parser_name = 'zark_pdf',
    parser_config = parser_config || '{"discoveryUrl": "https://zark.eatbu.com/?lang=sk"}'::jsonb
WHERE source_id = 'zark';

-- Anything else has no automatic import; its menu is entered by hand in the admin
UPDATE public.lunch_sources
SET parser_name = 'manual'
WHERE parser_name IS NULL
   OR parser_name NOT IN ('sme_restauracie', 'woocommerce_category', 'amelia', 'zark_pdf', 'ai_extract', 'manual');

-- The n8n import audit writes 'partial_failure' when some restaurants fail; the original CHECK
-- only allowed 'partial_success', so storing the audit of such a run failed. Allow both.
ALTER TABLE public.lunch_import_runs DROP CONSTRAINT IF EXISTS lunch_import_runs_status_check;
ALTER TABLE public.lunch_import_runs ADD CONSTRAINT lunch_import_runs_status_check
  CHECK (status IN ('running', 'success', 'partial_success', 'partial_failure', 'failed'));
