# Obedové menu - jednoduchý Docker stack

Jednoduchá mobile responsive landing page, ktorá číta dnešné obedové menu z PostgreSQL databázy.

## Architektúra

```text
n8n na inej machine
        ↓ PostgreSQL TCP cez LAN/Tailscale
RPI / webserver
        ├── obedove-menu      Node.js landing page
        └── obedove-menu-db   PostgreSQL databáza
```

Dôležité: n8n **nie je na rovnakom Docker hoste** ako webserver, preto v n8n credential nepoužívaj Docker hostname `obedove-menu-db`. Ten funguje iba medzi kontajnermi na tom istom serveri.

## Služby

- `obedove-menu` - Node.js web app / landing page
- `obedove-menu-db` - PostgreSQL
- `lunch-internal` - interná Docker sieť iba medzi webom a DB

## Spustenie

```bash
cp .env.example .env
nano .env
docker compose up -d --build
```

## Web

```text
http://IP_WEBSERVERA:8094
```

Napríklad cez LAN:

```text
http://192.168.1.50:8094
```

## Healthcheck

```bash
curl http://127.0.0.1:8094/health
```

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
