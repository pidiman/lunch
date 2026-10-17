// One-off admin process: applies pending SQL files from ./migrations in name order.
// Run with `npm run migrate` (or `docker compose run --rm obedove-menu-migrate`).
const fs = require('fs');
const path = require('path');
const { createPool } = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DB_CONNECT_RETRIES = Number(process.env.DB_CONNECT_RETRIES || 20);
// Arbitrary constant so concurrent migrate runs serialize instead of racing
const MIGRATION_LOCK_ID = 727274;

const pool = createPool({ max: 1 });

async function connectWithRetry() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await pool.connect();
    } catch (err) {
      if (attempt >= DB_CONNECT_RETRIES) throw err;
      console.error(`Pripojenie k DB zlyhalo (pokus ${attempt}/${DB_CONNECT_RETRIES}), skúšam znova o 3 s:`, err.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function migrate() {
  const client = await connectWithRetry();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = new Set((await client.query('SELECT name FROM public.schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const pending = files.filter((f) => !applied.has(f));

    if (!pending.length) {
      console.log('Migrácie: databáza je aktuálna.');
      return;
    }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`Migrácie: aplikujem ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${file}: ${err.message}`);
      }
    }
    console.log(`Migrácie: aplikovaných ${pending.length}.`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

migrate()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('Migrácia zlyhala:', err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
