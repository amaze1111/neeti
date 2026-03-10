const { Pool } = require('pg');

// const pool = new Pool({
//   user: 'nidhi',
//   host: 'localhost',
//   database: 'shasn',
//   password: 'shasn123',
//   port: 5432,
//   ssl: false,
// });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Unexpected DB client error:', err);
});

module.exports = pool;
