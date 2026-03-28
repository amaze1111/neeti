const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool     = require('../db/pool');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function sanitizeUser(row) {
  if (!row) return row;
  const safeUser = { ...row };
  delete safeUser.password;
  delete safeUser.password_hash;
  delete safeUser.hashed_password;
  delete safeUser.passhash;
  delete safeUser.passwd;
  return {
    ...safeUser,
    wins: Number(safeUser.wins ?? 0),
    losses: Number(safeUser.losses ?? 0),
  };
}

function withDebug(req, payload, error, extra = {}) {
  if (req.get('x-debug-auth') !== '1') return payload;
  return {
    ...payload,
    debug: {
      code: error?.code ?? null,
      detail: error?.detail ?? null,
      constraint: error?.constraint ?? null,
      message: error?.message ?? null,
      ...extra,
    },
  };
}

async function getUserTableColumns() {
  const { rows } = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
  `);
  return rows.map((row) => row.column_name);
}

function pickFirstColumn(columns, candidates) {
  return candidates.find((candidate) => columns.includes(candidate)) ?? null;
}

async function insertUser({ username, email, hash }) {
  const columns = await getUserTableColumns();
  const userId = uuidv4();
  const passwordColumn = pickFirstColumn(columns, [
    'password',
    'password_hash',
    'hashed_password',
    'passhash',
    'passwd',
  ]);

  if (!passwordColumn) {
    const error = new Error('No password column found on users table');
    error.code = 'NO_PASSWORD_COLUMN';
    error.columns = columns;
    throw error;
  }

  const insertColumns = ['id', 'username', 'email', passwordColumn];
  const values = [userId, username, email, hash];

  if (columns.includes('avatar_seed')) {
    insertColumns.push('avatar_seed');
    values.push(username);
  }

  const placeholders = insertColumns.map((_, index) => `$${index + 1}`).join(', ');
  const query = `INSERT INTO users (${insertColumns.join(', ')}) VALUES (${placeholders}) RETURNING *`;
  const { rows } = await pool.query(query, values);
  return rows[0];
}

async function findUserByEmail(email) {
  const columns = await getUserTableColumns();
  const passwordColumn = pickFirstColumn(columns, [
    'password',
    'password_hash',
    'hashed_password',
    'passhash',
    'passwd',
  ]);
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return { user: rows[0], columns, passwordColumn };
}

// POST /auth/register
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email and password are required' });
  }
  if (username.length < 3 || username.length > 32) {
    return res.status(400).json({ error: 'username must be 3–32 characters' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const user = await insertUser({
      username: username.trim(),
      email: email.toLowerCase().trim(),
      hash,
    });
    res.status(201).json({ user: sanitizeUser(user), token: signToken(user) });
  } catch (e) {
    if (e.code === '23505') { // unique violation
      const field = e.constraint?.includes('email') ? 'email' : 'username';
      return res.status(409).json({ error: `That ${field} is already taken` });
    }
    console.error(e);
    res.status(500).json(withDebug(req, { error: 'Registration failed' }, e, { columns: e.columns ?? null }));
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const { user, columns, passwordColumn } = await findUserByEmail(email.toLowerCase().trim());
    const storedHash = passwordColumn ? user?.[passwordColumn] : null;
    if (!user || !storedHash || !(await bcrypt.compare(password, storedHash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    res.json({ user: sanitizeUser(user), token: signToken(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json(withDebug(req, { error: 'Login failed' }, e, { columns: e.columns ?? null }));
  }
});

// GET /auth/me  (requires token)
router.get('/me', require('../middleware/auth').authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, email, wins, losses, created_at FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not fetch user' });
  }
});

module.exports = router;
