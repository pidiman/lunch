# n8n workflowy (v4)

Reštaurácie sa spravujú v admine webu (záložka **Reštaurácie**). n8n z nich iba číta: aké reštaurácie importovať a ktorým parserom.

| Súbor | Workflow | Čo robí |
|---|---|---|
| `obedove-menu-parser-v4.json` | Obedové menu – parser reštaurácie (v4) | Sub-workflow: spracuje **jednu** reštauráciu podľa `parser_name` |
| `obedove-menu-import-v4.json` | Obedové menu – import (v4) | Denne o 10:05 a 11:15 načíta reštaurácie z DB a uloží menu |
| `obedove-menu-test-zdroja-v4.json` | Obedové menu – test zdroja (v4) | Webhook pre tlačidlo **Otestovať** v admine, nič nezapisuje |

## Typy parserov

| `parser_name` | Na čo |
|---|---|
| `ai_extract` | Ľubovoľný web reštaurácie – HTML, PDF aj obrázok menu. Claude (`claude-opus-5-5`, effort `low`) vráti jedlá ako štruktúrovaný JSON. |
| `woocommerce_category` | E-shop na WooCommerce (BelaVery) |
| `amelia` | ameliarestaurant.sk – denné menu, týždenný špeciál, víkendové menu, zatvorené dni |
| `zark_pdf` | ZARK – nájde týždenné PDF a overí, že je z aktuálneho týždňa |
| `sme_restauracie` | restauracie.sme.sk – SME chráni stránky captchou, import môže nepravidelne zlyhávať |
| `manual` | Bez importu, jedlá sa zadávajú v admine |

`parser_config` (Pokročilé nastavenia v admine), napr. `{"model": "claude-sonnet-5-5", "effort": "medium"}` pre `ai_extract` alebo `{"discoveryUrl": "…"}` pre `zark_pdf`.

## Nasadenie

1. **Najprv web s migráciou 006** (pridá stĺpce, ktoré v4 číta). Bez nej import v4 zlyhá na `parser_config`.
2. **Credentials v n8n** (Credentials → Add):
   - *Header Auth* s názvom **`Anthropic API (x-api-key)`**: Name `x-api-key`, Value = API kľúč z console.anthropic.com
   - *Header Auth* s názvom **`Obedové menu test token (x-menu-token)`**: Name `x-menu-token`, Value = náhodný tajný reťazec
   - Postgres a SMTP credentials sú tie isté ako vo v3 (`Postgres rpi4-webserver-lunch`, `SMTP account 25`).
3. **Import** všetkých troch JSON (Workflows → Import from File). Importujú sa **neaktívne**.
4. V uzle **Execute - Parser** (v importe aj v teste) skontroluj, že je vybraný workflow „parser reštaurácie (v4)“. Ak import v UI vytvoril nové ID, vyber ho zo zoznamu.
5. V prípade potreby v uzloch zvoľ credentials (n8n ich podľa názvu zvyčajne priradí sám).
6. Aktivuj **test zdroja (v4)** a jeho produkčnú URL (`…/webhook/obedove-menu-test-zdroja`) daj do `.env` webu:
   ```env
   N8N_TEST_WEBHOOK_URL=http://IP_N8N:5678/webhook/obedove-menu-test-zdroja
   N8N_TEST_WEBHOOK_TOKEN=rovnaký tajný reťazec ako v credentials
   ```
7. Spusti **import (v4)** ručne (Manual Trigger) a skontroluj výsledok. Až potom **deaktivuj v3** a **aktivuj v4**.

Obe verzie naraz nespúšťaj: v3 pri každom behu znova zapína reštaurácie (`enabled=TRUE`) a novým reštauráciám nastavuje lokalitu „Praca“.

## Návrat na v3

Deaktivuj v4, aktivuj v3. Migrácia 006 je iba aditívna, v3 s ňou funguje (a vďaka nej sa jej audit `partial_failure` už aj uloží).

## Test iného dňa

V env n8n nastav `MENU_DATE_OVERRIDE=YYYY-MM-DD` a spusti import ručne. Po teste premennú odstráň.
