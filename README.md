# Obedové menu - jednoduchý Docker stack

Jednoduchá landing page, ktorá číta dnešné obedové menu z PostgreSQL databázy.

## Služby

- `obedove-menu` - Node.js web app / landing page
- `obedove-menu-db` - PostgreSQL
- `db-shared` - externá Docker sieť pre n8n a existujúci Adminer

## Spustenie

```bash
docker network create db-shared || true
cp .env.example .env
nano .env
docker compose up -d --build
```

## Web

```text
http://IP_SERVERA:8094
```

## Healthcheck

```bash
curl http://127.0.0.1:8094/health
```

## n8n PostgreSQL credential

Ak je n8n v `db-shared`:

```text
Host: obedove-menu-db
Port: 5432
Database: obedove_menu
User: obedove_menu_user
Password: DB_PASSWORD z .env
SSL: false
```

Ak n8n ešte nie je v `db-shared`:

```bash
docker network connect db-shared NAZOV_N8N_CONTAINERU
```

## Adminer

Existujúci Adminer v `db-shared`:

```text
System: PostgreSQL
Server: obedove-menu-db
Username: obedove_menu_user
Password: DB_PASSWORD z .env
Database: obedove_menu
```
