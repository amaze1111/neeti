# 🗳 SHASN Backend

Real-time multiplayer backend for SHASN — built with **Node.js + Express + Socket.IO + PostgreSQL**.

---

## Architecture

```
shasn-backend/
├── src/
│   ├── index.js                  # Entry point (Express + Socket.IO server)
│   ├── db/
│   │   ├── pool.js               # PostgreSQL connection pool
│   │   └── migrate.js            # Schema migration (run once)
│   ├── routes/
│   │   ├── auth.js               # POST /auth/register, /auth/login, GET /auth/me
│   │   └── rooms.js              # POST /rooms, /rooms/:code/join, GET /rooms/:code
│   ├── middleware/
│   │   └── auth.js               # JWT middleware
│   ├── services/
│   │   └── gameEngine.js         # Pure game logic (no DB, fully testable)
│   └── socket/
│       └── gameHandler.js        # All Socket.IO events
├── .env.example
├── package.json
└── railway.toml
```

---

## Local Development

### 1. Prerequisites
- Node.js ≥ 18
- PostgreSQL 14+

### 2. Install
```bash
npm install
cp .env.example .env
# Edit .env with your DB credentials and JWT secret
```

### 3. Create the database
```bash
createdb shasn
npm run db:migrate
```

### 4. Start
```bash
npm run dev     # development (auto-reload)
npm start       # production
```

Server starts at `http://localhost:3000`

---

## Deploy to Railway

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add a **PostgreSQL** plugin to the project (Railway provides `DATABASE_URL` automatically)
4. Set these environment variables in Railway:
   ```
   NODE_ENV=production
   JWT_SECRET=<your-long-random-secret>
   JWT_EXPIRES_IN=7d
   CORS_ORIGIN=*
   ```
5. Railway auto-deploys on every push to `main`
6. Run migration once: Railway → your service → Terminal → `npm run db:migrate`

---

## REST API

### Auth

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/auth/register` | `{ username, email, password }` | Create account |
| POST | `/auth/login` | `{ email, password }` | Returns `{ user, token }` |
| GET | `/auth/me` | — | Requires `Authorization: Bearer <token>` |

### Rooms

All room endpoints require `Authorization: Bearer <token>`.

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/rooms` | `{ ideology }` | Create a room, returns `{ room: { code } }` |
| POST | `/rooms/:code/join` | `{ ideology }` | Join a room |
| GET | `/rooms/:code` | — | Get room + players |
| PATCH | `/rooms/:code/ready` | — | Toggle ready state |

---

## Socket.IO Events

Connect with:
```js
const socket = io('https://your-railway-url.up.railway.app', {
  auth: { token: '<jwt>' }
});
```

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `room:join` | `{ roomCode }` | Subscribe to room updates |
| `room:ready` | `{ roomCode }` | Toggle ready / start game when both ready |
| `room:set_ideology` | `{ roomCode, ideology }` | Change ideology before game starts |
| `game:answer_card` | `{ roomCode, choice: 'a'\|'b' }` | Answer the ideology card |
| `game:place_voter` | `{ roomCode, zoneIndex }` | Place voter peg (0–8) |
| `game:gerrymander` | `{ roomCode, fromZoneIndex, toZoneIndex, pegOwnerSlot }` | Move a peg |
| `game:buy_conspiracy` | `{ roomCode }` | Buy a conspiracy card (costs 3 resources) |
| `game:use_conspiracy` | `{ roomCode, instanceId, params? }` | Use a conspiracy card |
| `game:end_turn` | `{ roomCode }` | Pass remaining actions |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `room:state` | `{ room, players }` | Room status update |
| `game:state` | `{ state }` | Full game state after every action |
| `game:card` | `{ card }` | Ideology card drawn for this turn |
| `game:over` | `{ winner, scores }` | Game ended |
| `game:error` | `{ message }` | Action failed with reason |
| `room:player_disconnected` | `{ slot, username }` | Opponent disconnected |

---

## iOS Integration (Swift)

### 1. Add Socket.IO Client

In your `Package.swift` or via Xcode:
```
https://github.com/socketio/socket.io-client-swift
```

### 2. Auth flow
```swift
// Register / Login
let response = try await URLSession.shared.data(from: loginURL, delegate: nil)
let token = decoded.token  // store in Keychain

// Connect socket
let manager = SocketManager(socketURL: URL(string: "https://your-app.up.railway.app")!,
                            config: [.extraHeaders(["Authorization": "Bearer \(token)"])])
// or use .connectParams(["token": token])
let socket = manager.defaultSocket
```

### 3. Game events
```swift
// Listen for game state
socket.on("game:state") { data, _ in
    let state = data[0] as? [String: Any]
    DispatchQueue.main.async { self.updateUI(state) }
}

// Answer a card
socket.emit("game:answer_card", ["roomCode": roomCode, "choice": "a"])

// Place a voter
socket.emit("game:place_voter", ["roomCode": roomCode, "zoneIndex": 2])
```

---

## Game State Shape

```jsonc
{
  "players": [
    {
      "slot": 1, "username": "Alice", "ideology": "capitalist",
      "funds": 3, "clout": 1, "media": 0, "trust": 2,
      "ideologyCards": { "capitalist": 2, "supremo": 0, "showstopper": 1, "idealist": 0 },
      "conspiracies": [{ "instanceId": "cc_01_1234", "name": "Smear Campaign", ... }],
      "actionsLeft": 1
    },
    { "slot": 2, ... }
  ],
  "zones": [
    { "name": "Capital", "capacity": 5, "pegs": [1, 1, 2] },
    ...
  ],
  "currentSlot": 1,
  "turn": 3,
  "phase": "action",       // "ideology" | "action" | "finished"
  "currentCard": { "id": "ic_03", "question": "...", "a": {...}, "b": {...} },
  "winner": null,           // null | 1 | 2 | 0 (draw)
  "log": [
    { "turn": 3, "slot": 1, "type": "place_voter", "text": "Alice placed a voter in Capital" }
  ]
}
```

---

## Scaling Notes (future)
- Replace in-memory `activeSessions` Map with **Redis** for horizontal scaling
- Add Socket.IO Redis adapter (`@socket.io/redis-adapter`) for multiple server instances
- Add rate limiting per user with `express-rate-limit`
