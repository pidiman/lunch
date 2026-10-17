const { Pool } = require('pg');

// Fail fast on missing deploy-specific config instead of silently using a guess
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Chýba povinná premenná prostredia ${name}.`);
    process.exit(1);
  }
  return value;
}

function createPool(options = {}) {
  const pool = new Pool({
    host: requireEnv('DB_HOST'),
    port: Number(process.env.DB_PORT || 5432),
    database: requireEnv('DB_NAME'),
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    ...options,
  });
  pool.on('error', (err) => console.error('pg pool error:', err.message));
  return pool;
}

module.exports = { requireEnv, createPool };
