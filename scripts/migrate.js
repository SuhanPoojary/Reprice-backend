const fs = require('fs');
const path = require('path');

require('dotenv').config();
const { pool } = require('../db');

async function main() {
  const sqlPath = path.join(__dirname, '..', 'sql', 'neon_schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is missing. Set it in backend/.env');
  }

  console.log('Running migration:', sqlPath);
  await pool.query(sql);
  console.log('✅ Migration complete');
}

main()
  .catch((err) => {
    console.error('❌ Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch {
      // ignore
    }
  });
