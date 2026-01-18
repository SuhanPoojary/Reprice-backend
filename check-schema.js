require('dotenv').config();
const { pool } = require('./db');

async function check() {
  try {
    // Check if partner_accepted column exists
    const result = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'orders'
      ORDER BY ordinal_position
    `);
    
    console.log('Orders table columns:');
    result.rows.forEach(row => {
      console.log(`  - ${row.column_name} (${row.data_type})`);
    });
    
    // Try to check one order
    const orders = await pool.query(`SELECT id, partner_accepted FROM orders LIMIT 1`);
    console.log('\nSample order partner_accepted value:', orders.rows[0]);
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

check();
