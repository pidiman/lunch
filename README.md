# Obedové menu - jednoduchý Docker stack

Jednoduchá mobile responsive landing page, ktorá číta dnešné obedové menu z PostgreSQL databázy.

## Architektúra

```text
n8n na inej machine
        ↓ PostgreSQL TCP cez LAN/Tailscale, host port 5434
RPI / webserver
        ├── obedove-menu      Node.js landing page
        └── obedove-menu-db   PostgreSQL databáza, container port 5432
```

Dôležité: n8n **nie je na rovnakom Docker hoste** ako webserver, preto v n8n credential nepoužívaj Docker hostname `obedove-menu-db`. Ten funguje iba medzi kontajnermi na tom istom serveri.

Dôležité 2: host port `5432` je u teba už obsadený iným PostgreSQL kontajnerom. Tento projekt preto používa na hoste port `5434`, ktorý sa mapuje do kontajnera na interný PostgreSQL port `5432`.

```text
n8n / LAN / Tailscale → IP_WEBSERVERA:5434 → obedove-menu-db:5432
```

## Služby

- `obedove-menu` - Node.js web app / landing page
- `obedove-menu-db` - PostgreSQL
- `lunch-internal` - interná Docker sieť iba medzi webom a DB

## Spustenie

Image sa na RPI nebuilduje. Zbuilduje ho GitHub Actions ([.github/workflows/docker.yml](.github/workflows/docker.yml)) pri každom pushi do `main` a publikuje ho do `ghcr.io/pidiman/lunch` pre `arm64` aj `amd64`.

```bash
cp .env.example .env
nano .env
docker compose pull
docker compose up -d
```

### Release a rollback

Každý commit má vlastný image `ghcr.io/pidiman/lunch:sha-<7 znakov commitu>` a `latest` ukazuje na posledný commit v `main`. Konkrétnu verziu nasadíš (alebo sa k nej vrátiš) cez `.env`:

```env
IMAGE_TAG=sha-1a2b3c4
```

Potom spusti `docker compose pull && docker compose up -d`.

### Lokálny build (bez GHCR)

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Lokálny vývoj

CSS sa builduje cez Tailwind CLI (v Dockeri automaticky v prvom build stage). Pri lokálnom spustení mimo Dockeru:

```bash
cd app
npm install
npm run build:css   # vygeneruje app/tailwind.css
npm run migrate     # aplikuje DB migrácie (potrebuje DB_* premenné)
npm start
```

## DB migrácie

Schéma sa spravuje SQL súbormi v [app/migrations/](app/migrations/), ktoré sa aplikujú v poradí podľa názvu. Aplikované migrácie sa evidujú v tabuľke `schema_migrations`.

- Pri `docker compose up` sa najprv spustí jednorazová služba `obedove-menu-migrate`. Web štartuje až po jej úspešnom dokončení.
- Ručné spustenie: `docker compose run --rm obedove-menu-migrate`
- Nová zmena schémy = nový súbor, napr. `003_pridaj_stlpec.sql`. Už aplikované súbory sa nemenia.
- Webová aplikácia schému pri štarte nemení.

## Web

```text
http://IP_WEBSERVERA:8094
```

Napríklad cez LAN:

```text
http://192.168.1.50:8094
```

## Admin prihlásenie

Admin sekcia (`/admin`) používa účty s e-mailom a heslom (bez `ADMIN_TOKEN`):

- `/admin` zobrazuje iba prihlásenie. Registrácia je na hlavnej stránke cez tlačidlo „Prihlásiť sa" → tab „Registrácia".
- Prvý zaregistrovaný používateľ automaticky získa rolu **admin**.
- Ďalší registrovaní používatelia dostanú rolu **user** a musia počkať na schválenie adminom (tab „Používatelia").
- Rola **user** nemá prístup do `/admin`; na hlavnej stránke si nastaví obľúbené reštaurácie, poradie lokalít a predvolenú lokalitu („Môj výber“).
- Session platí 30 dní, odhlásenie je cez „Odhlásiť".

### Zabudnuté heslo

Na `/admin` je odkaz „Zabudnuté heslo?" — používateľ zadá e-mail a dostane 6-miestny jednorazový kód platný 15 minút.

Kódy sa posielajú cez lokálny SMTP relay kontajner (`smtp-relay`) na tom istom RPI. V `.env` nastav:

```env
SMTP_HOST=smtp-relay
SMTP_PORT=25
SMTP_FROM=obedove-menu@tvoja-domena.sk
```

Kontajner `obedove-menu` musí mať sieťový prístup k `smtp-relay` — buď pripoj `smtp-relay` do siete `lunch-internal`, alebo nastav `SMTP_HOST` na IP hosta (ak má relay publikovaný port 25).

## Reštaurácie a import (n8n)

Reštaurácie sa pridávajú a upravujú v admine (záložka **Reštaurácie**): názov, lokalita, URL, typ parsera, zapnutie, víkendové menu. n8n ich načíta z DB a podľa typu parsera stiahne menu. Workflowy a návod na ich nasadenie sú v [n8n/](n8n/README.md).

Tlačidlo **Otestovať** spustí parser cez n8n webhook a ukáže nájdené jedlá bez zápisu do DB. Potrebuje v `.env`:

```env
N8N_TEST_WEBHOOK_URL=http://IP_N8N:5678/webhook/obedove-menu-test-zdroja
N8N_TEST_WEBHOOK_TOKEN=tajný reťazec (rovnaký ako v n8n credentials „Obedové menu test token“)
```

Bez týchto premenných admin funguje, iba tlačidlo Otestovať je neaktívne.

## Healthcheck

```bash
curl http://127.0.0.1:8094/health
```

## PostgreSQL porty

V kontajneri PostgreSQL stále beží na štandardnom porte:

```text
obedove-menu-db:5432
```

Na hoste/webserveri je ale vystavený ako:

```text
IP_WEBSERVERA:5434
```

Preto n8n, Adminer alebo iný externý klient musí používať port `5434`, nie `5432`.

## Nastavenie PostgreSQL pre n8n na inej machine

V `.env` nastav `DB_BIND_IP` tak, aby bol PostgreSQL dostupný z n8n servera.

Odporúčané cez Tailscale:

```env
DB_BIND_IP=100.x.y.z
DB_PUBLIC_PORT=5434
```

Alternatíva cez LAN:

```env
DB_BIND_IP=192.168.1.50
DB_PUBLIC_PORT=5434
```

Núdzovo na všetkých interfaceoch:

```env
DB_BIND_IP=0.0.0.0
DB_PUBLIC_PORT=5434
```

Použi `0.0.0.0` iba vtedy, keď máš firewall a port nie je dostupný z internetu.

Po zmene `.env` reštartuj stack:

```bash
docker compose up -d
```

Over mapovanie portu na webserveri:

```bash
docker compose ps
ss -lntp | grep 5434
```

## n8n PostgreSQL credential

Keď je n8n na inej machine, nastav v n8n PostgreSQL credential takto:

```text
Host: IP_WEBSERVERA alebo TAILSCALE_IP_WEBSERVERA
Port: 5434
Database: obedove_menu
User: obedove_menu_user
Password: DB_PASSWORD z .env
SSL: false
```

Príklad cez Tailscale:

```text
Host: 100.x.y.z
Port: 5434
Database: obedove_menu
User: obedove_menu_user
Password: DB_PASSWORD z .env
SSL: false
```

Príklad cez LAN:

```text
Host: 192.168.1.50
Port: 5434
Database: obedove_menu
User: obedove_menu_user
Password: DB_PASSWORD z .env
SSL: false
```

## Test z n8n machine

Z n8n servera otestuj konektivitu:

```bash
nc -vz IP_WEBSERVERA 5434
```

Alebo cez PostgreSQL klienta:

```bash
psql "postgresql://obedove_menu_user:DB_PASSWORD@IP_WEBSERVERA:5434/obedove_menu"
```

## Adminer

Ak máš Adminer na inej machine, pripoj ho rovnako ako n8n:

```text
System: PostgreSQL
Server: IP_WEBSERVERA alebo TAILSCALE_IP_WEBSERVERA
Port: 5434
Username: obedove_menu_user
Password: DB_PASSWORD z .env
Database: obedove_menu
```

## Bezpečnostné odporúčanie

Najbezpečnejší variant pre tvoj homelab je:

```text
n8n machine → Tailscale → webserver Tailscale IP:5434 → PostgreSQL container
```

Port `5434` nevystavuj cez public internet. Ak používaš UFW/firewall, povoľ prístup iba z IP n8n servera alebo z Tailscale siete.
