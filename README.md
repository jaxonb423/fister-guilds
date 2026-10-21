# Fister Guilds server

Lightweight socket.io server (only dependency: `socket.io`) with JSON-file persistence.

## Deploy on Zeabur
1. Push `package.json` + `server.js` to a GitHub repo, then create a Zeabur service from it (Node.js is auto-detected, start command `npm start`).
2. Add a **Volume** to the service mounted at `/data`, and set env var `DATA_DIR=/data` so guilds survive redeploys.
3. Add a domain under Networking. Zeabur provides `PORT` automatically.
4. Optional env: `ALLOWED_ORIGINS=https://fister.fun` (default `*`).
5. Put your domain in `client-example.user.js` (`SERVER` and `@connect`).

`GET /health` returns player/guild counts.

## Socket API (all use ack callbacks, replies are `{ok, ...}` or `{ok:false, error}`)
| Event | Payload | Notes |
|---|---|---|
| `auth` | `{name}` first time, then `{id, token}` | returns `token` once on registration; names are unique |
| `profile:rename` | `{name}` | |
| `guild:create` | `{name, tag, color, emblem, description, open}` | tag 2-5 alphanumeric, unique |
| `guild:join` | `{guildId}` or `{tag}` | open guilds only, max 50 members |
| `guild:leave` | | owner leaving passes ownership on; empty guild is deleted |
| `guild:update` | `{name, color, emblem, description, open, tag}` | owner/officer; tag change owner only |
| `guild:kick` / `guild:promote` | `{playerId}` / `{playerId, officer}` | |
| `guild:search` / `guild:info` | `{q}` / `{guildId}` | search sorted by guild XP |
| `xp` | `{kind: 'kill' \| 'win' \| 'tick'}` | server picks the amount, has per-kind cooldowns and a daily cap |
| `tags:lookup` | `{names: [...]}` | returns guild tag/color/emblem/level for registered names |

Server pushes: `me:update`, `guild:update`, `guild:removed`, `me:levelup`, `guild:levelup`.

## Notes
- Leveling: player level = `floor(sqrt(xp/50))+1`, guild level = `floor(sqrt(xp/200))+1`; edit `XP_RULES` to rebalance.
- Since the game is client-side, XP reporting can't be fully cheat-proof. Cooldowns and the daily cap limit abuse.
- Tags are matched by registered name, so players should register the same name they use in-game.
- Runs as a single instance (state in memory). Don't scale to multiple replicas without moving to a real DB.
