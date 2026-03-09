const express  = require('express');
const pool     = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

function generateCode() {
  // Remove ambiguous characters: 0/O, 1/I/L to avoid confusion
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Lazy-require to avoid circular dep at module load time
function getMarkAsBotRoom() {
  return require('../socket/gameHandler').markAsBotRoom;
}

// POST /rooms  — create a multiplayer room
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let code, exists = true;
    while (exists) {
      code = generateCode();
      const { rows } = await client.query("SELECT id FROM rooms WHERE code = $1 AND status != 'finished'", [code]);
      exists = rows.length > 0;
    }
    const { rows: [room] } = await client.query(
      `INSERT INTO rooms (code, host_id) VALUES ($1, $2) RETURNING *`, [code, req.user.userId]
    );
    await client.query(
      `INSERT INTO room_players (room_id, user_id, slot, ideology, is_ready) VALUES ($1, $2, 1, 'none', false)`,
      [room.id, req.user.userId]
    );
    await client.query('COMMIT');
    res.status(201).json({ room: { id: room.id, code: room.code, status: room.status } });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Failed to create room' });
  } finally {
    client.release();
  }
});

// POST /rooms/bot  — create a solo bot room (player vs AI)
router.post('/bot', async (req, res) => {
  const { difficulty = 'medium' } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let code, exists = true;
    while (exists) {
      code = generateCode();
      const { rows } = await client.query("SELECT id FROM rooms WHERE code = $1 AND status != 'finished'", [code]);
      exists = rows.length > 0;
    }

    // Create room with max_players = 2 but mark it as a bot room
    const { rows: [room] } = await client.query(
      `INSERT INTO rooms (code, host_id, is_bot) VALUES ($1, $2, TRUE) RETURNING *`, [code, req.user.userId]
    );

    // Add human as slot 1
    await client.query(
      `INSERT INTO room_players (room_id, user_id, slot, ideology, is_ready) VALUES ($1, $2, 1, 'none', false)`,
      [room.id, req.user.userId]
    );

    // Add bot as slot 2 using a fixed bot UUID (avoids unique constraint on user_id)
    await client.query(
      `INSERT INTO room_players (room_id, user_id, slot, ideology, is_ready) VALUES ($1, $2, 2, 'none', true)`,
      [room.id, '00000000-0000-0000-0000-000000000001']
    );

    await client.query('COMMIT');

    // Mark room as bot room in the WebSocket handler
    getMarkAsBotRoom()(code);
    process.env.BOT_DIFFICULTY = difficulty;

    console.log(`🤖 Bot room created: ${code} (difficulty: ${difficulty})`);
    res.status(201).json({ room: { id: room.id, code: room.code, status: room.status }, isBotRoom: true, difficulty });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Failed to create bot room' });
  } finally {
    client.release();
  }
});

// POST /rooms/:code/join  — join existing multiplayer room
router.post('/:code/join', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [room] } = await client.query("SELECT * FROM rooms WHERE code = $1", [req.params.code.toUpperCase()]);
    if (!room)                     return res.status(404).json({ error: 'Room not found' });
    if (room.status !== 'waiting') return res.status(409).json({ error: 'Game already in progress' });

    const { rows: players } = await client.query('SELECT * FROM room_players WHERE room_id = $1', [room.id]);
    const existing = players.find(p => p.user_id === req.user.userId);
    if (existing) {
      await client.query('ROLLBACK');
      // Return success instead of error — idempotent join
      return res.json({ room: { id: room.id, code: room.code, slot: existing.slot, status: room.status } });
    }
    if (players.length >= room.max_players) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Room is full' });
    }

    const slot = players.length + 1;
    await client.query(
      `INSERT INTO room_players (room_id, user_id, slot, ideology, is_ready) VALUES ($1, $2, $3, 'none', false)`,
      [room.id, req.user.userId, slot]
    );
    await client.query('COMMIT');
    res.json({ room: { id: room.id, code: room.code, slot, status: room.status } });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Failed to join room' });
  } finally {
    client.release();
  }
});

// GET /rooms/:code
router.get('/:code', async (req, res) => {
  try {
    const { rows: [room] } = await pool.query('SELECT * FROM rooms WHERE code = $1', [req.params.code.toUpperCase()]);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const { rows: players } = await pool.query(
      `SELECT rp.slot, rp.ideology, rp.is_ready, u.username FROM room_players rp
       JOIN users u ON rp.user_id = u.id WHERE rp.room_id = $1 ORDER BY rp.slot`, [room.id]
    );
    res.json({ room: { id: room.id, code: room.code, status: room.status, players } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch room' });
  }
});

module.exports = router;
