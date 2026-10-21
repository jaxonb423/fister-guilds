// Fister Guilds - lightweight socket.io server (no express, JSON-file persistence)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data'); // point at a Zeabur volume
const DATA_FILE = path.join(DATA_DIR, 'guilds.json');
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

const MAX_MEMBERS = 50;
const DAILY_XP_CAP = 4000;

// ---------- XP rules (server decides amounts; clients only report event kinds) ----------
const XP_RULES = {
  kill: { xp: 10, cooldown: 1500 },
  win:  { xp: 50, cooldown: 20000 },
  tick: { xp: 5,  cooldown: 55000 }, // client sends once a minute while actually in a match
};
const playerXpForLevel = l => 50 * (l - 1) ** 2;
const guildXpForLevel = l => 200 * (l - 1) ** 2;
const playerLevel = xp => Math.floor(Math.sqrt(xp / 50)) + 1;
const guildLevel = xp => Math.floor(Math.sqrt(xp / 200)) + 1;

// ---------- Persistence ----------
let db = { players: {}, guilds: {}, names: {}, tags: {} };
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
} catch (e) { console.error('Failed to load data:', e); }

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 5000);
}
function saveNow() {
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { console.error('Save failed:', e); }
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { saveNow(); process.exit(0); });

// ---------- Helpers ----------
const now = () => Date.now();
const uid = (n = 8) => crypto.randomBytes(n).toString('hex');
const hash = t => crypto.createHash('sha256').update(t).digest('hex');
const cleanStr = (s, max) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const isColor = c => /^#[0-9a-fA-F]{6}$/.test(c);
const cleanEmblem = e => Array.from(String(e ?? '')).slice(0, 2).join('').replace(/[<>]/g, '');
const today = () => new Date().toISOString().slice(0, 10);

function validName(n) { return /^[\w .\-]{2,20}$/.test(n); }

function publicGuild(g, full = false) {
  if (!g) return null;
  const out = {
    id: g.id, name: g.name, tag: g.tag, color: g.color, emblem: g.emblem,
    description: g.description, open: g.open, level: guildLevel(g.xp), xp: g.xp,
    nextLevelXp: guildXpForLevel(guildLevel(g.xp) + 1), members: g.members.length, max: MAX_MEMBERS,
  };
  if (full) {
    out.ownerId = g.ownerId;
    out.officers = g.officers;
    out.roster = g.members.map(id => {
      const p = db.players[id];
      return {
        id, name: p.name, level: playerLevel(p.xp), contributed: p.guildXp || 0,
        role: id === g.ownerId ? 'owner' : g.officers.includes(id) ? 'officer' : 'member',
        online: isOnline(id),
      };
    }).sort((a, b) => b.contributed - a.contributed);
  }
  return out;
}
function publicMe(p) {
  const lvl = playerLevel(p.xp);
  return { id: p.id, name: p.name, xp: p.xp, level: lvl, nextLevelXp: playerXpForLevel(lvl + 1),
           guildId: p.guildId || null, guildXp: p.guildXp || 0 };
}
function tagInfo(p) {
  const g = p.guildId && db.guilds[p.guildId];
  return { name: p.name, level: playerLevel(p.xp),
           guild: g ? { id: g.id, tag: g.tag, color: g.color, emblem: g.emblem, name: g.name, level: guildLevel(g.xp) } : null };
}

// ---------- Server ----------
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, players: Object.keys(db.players).length, guilds: Object.keys(db.guilds).length }));
  }
  res.writeHead(404); res.end();
});
const io = new Server(httpServer, {
  cors: { origin: ORIGINS.includes('*') ? '*' : ORIGINS },
  maxHttpBufferSize: 1e5,
});

const sockets = new Map(); // playerId -> Set(socket.id)
const isOnline = id => (sockets.get(id)?.size || 0) > 0;

function pushGuild(guildId) {
  const g = db.guilds[guildId];
  if (g) io.to('g:' + guildId).emit('guild:update', publicGuild(g, true));
}
function pushMe(playerId) {
  const p = db.players[playerId];
  if (p) io.to('p:' + playerId).emit('me:update', publicMe(p));
}
function moveSocketsToGuild(playerId, oldGid, newGid) {
  for (const sid of sockets.get(playerId) || []) {
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    if (oldGid) s.leave('g:' + oldGid);
    if (newGid) s.join('g:' + newGid);
  }
}
function removeFromGuild(playerId, reason) {
  const p = db.players[playerId];
  const g = p && db.guilds[p.guildId];
  if (!g) return;
  g.members = g.members.filter(m => m !== playerId);
  g.officers = g.officers.filter(m => m !== playerId);
  moveSocketsToGuild(playerId, g.id, null);
  p.guildId = null; p.guildXp = 0;
  if (g.members.length === 0) {
    delete db.tags[g.tag.toUpperCase()]; delete db.guilds[g.id];
  } else {
    if (g.ownerId === playerId) g.ownerId = g.officers[0] || g.members[0];
    g.officers = g.officers.filter(o => o !== g.ownerId);
    pushGuild(g.id);
  }
  io.to('p:' + playerId).emit('guild:removed', { reason: reason || 'left' });
  pushMe(playerId);
  save();
}

io.on('connection', socket => {
  // basic flood control: 80 events / 10s
  let bucket = 0;
  const reset = setInterval(() => (bucket = 0), 10000);
  socket.use((_, next) => (++bucket > 80 ? next(new Error('rate_limited')) : next()));
  socket.on('disconnect', () => {
    clearInterval(reset);
    const id = socket.data.pid;
    if (id) {
      sockets.get(id)?.delete(socket.id);
      const p = db.players[id];
      if (p) { p.lastSeen = now(); if (p.guildId) pushGuild(p.guildId); }
    }
  });

  const authed = fn => (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const p = db.players[socket.data.pid];
    if (!p) return ack({ ok: false, error: 'not_authed' });
    try { fn(p, data || {}, ack); } catch (e) { console.error(e); ack({ ok: false, error: 'server_error' }); }
  };

  // ----- auth: first time sends {name}; server returns {id, token}. Later: {id, token, name?} -----
  socket.on('auth', (data = {}, ack = () => {}) => {
    if (typeof ack !== 'function') ack = () => {};
    let p;
    if (data.id && data.token) {
      p = db.players[data.id];
      if (!p || p.tokenHash !== hash(String(data.token))) return ack({ ok: false, error: 'bad_credentials' });
    } else {
      const name = cleanStr(data.name, 20);
      if (!validName(name)) return ack({ ok: false, error: 'invalid_name' });
      if (db.names[name.toLowerCase()]) return ack({ ok: false, error: 'name_taken' });
      const id = uid(6), token = uid(16);
      p = db.players[id] = { id, name, tokenHash: hash(token), xp: 0, guildId: null, guildXp: 0, createdAt: now(), lastSeen: now(), daily: { d: today(), xp: 0 }, last: {} };
      db.names[name.toLowerCase()] = id;
      p._newToken = token;
      save();
    }
    socket.data.pid = p.id;
    if (!sockets.has(p.id)) sockets.set(p.id, new Set());
    sockets.get(p.id).add(socket.id);
    socket.join('p:' + p.id);
    if (p.guildId && db.guilds[p.guildId]) { socket.join('g:' + p.guildId); pushGuild(p.guildId); }
    else p.guildId = null;
    const token = p._newToken; delete p._newToken;
    ack({ ok: true, token, me: publicMe(p), guild: publicGuild(db.guilds[p.guildId], true) });
  });

  socket.on('profile:rename', authed((p, d, ack) => {
    const name = cleanStr(d.name, 20);
    if (!validName(name)) return ack({ ok: false, error: 'invalid_name' });
    const owner = db.names[name.toLowerCase()];
    if (owner && owner !== p.id) return ack({ ok: false, error: 'name_taken' });
    delete db.names[p.name.toLowerCase()];
    p.name = name; db.names[name.toLowerCase()] = p.id;
    if (p.guildId) pushGuild(p.guildId);
    pushMe(p.id); save(); ack({ ok: true, me: publicMe(p) });
  }));

  // ----- guilds -----
  socket.on('guild:create', authed((p, d, ack) => {
    if (p.guildId) return ack({ ok: false, error: 'already_in_guild' });
    const name = cleanStr(d.name, 24), tag = cleanStr(d.tag, 5).toUpperCase();
    if (name.length < 3) return ack({ ok: false, error: 'invalid_name' });
    if (!/^[A-Z0-9]{2,5}$/.test(tag)) return ack({ ok: false, error: 'invalid_tag' });
    if (db.tags[tag]) return ack({ ok: false, error: 'tag_taken' });
    const g = {
      id: uid(5), name, tag,
      color: isColor(d.color) ? d.color : '#ffcc00',
      emblem: cleanEmblem(d.emblem) || '⚔️',
      description: cleanStr(d.description, 120),
      open: d.open !== false,
      ownerId: p.id, officers: [], members: [p.id], xp: 0, createdAt: now(),
    };
    db.guilds[g.id] = g; db.tags[tag] = g.id;
    p.guildId = g.id; p.guildXp = 0;
    moveSocketsToGuild(p.id, null, g.id);
    pushMe(p.id); save();
    ack({ ok: true, guild: publicGuild(g, true) });
  }));

  socket.on('guild:join', authed((p, d, ack) => {
    if (p.guildId) return ack({ ok: false, error: 'already_in_guild' });
    const g = db.guilds[d.guildId] || db.guilds[db.tags[String(d.tag || '').toUpperCase()]];
    if (!g) return ack({ ok: false, error: 'not_found' });
    if (!g.open) return ack({ ok: false, error: 'closed' });
    if (g.members.length >= MAX_MEMBERS) return ack({ ok: false, error: 'full' });
    g.members.push(p.id); p.guildId = g.id; p.guildXp = 0;
    moveSocketsToGuild(p.id, null, g.id);
    pushGuild(g.id); pushMe(p.id); save();
    ack({ ok: true, guild: publicGuild(g, true) });
  }));

  socket.on('guild:leave', authed((p, d, ack) => {
    if (!p.guildId) return ack({ ok: false, error: 'no_guild' });
    removeFromGuild(p.id, 'left'); ack({ ok: true });
  }));

  socket.on('guild:update', authed((p, d, ack) => {
    const g = db.guilds[p.guildId];
    if (!g) return ack({ ok: false, error: 'no_guild' });
    const isOwner = g.ownerId === p.id;
    if (!isOwner && !g.officers.includes(p.id)) return ack({ ok: false, error: 'forbidden' });
    if (d.color !== undefined) { if (!isColor(d.color)) return ack({ ok: false, error: 'invalid_color' }); g.color = d.color; }
    if (d.emblem !== undefined) g.emblem = cleanEmblem(d.emblem) || g.emblem;
    if (d.description !== undefined) g.description = cleanStr(d.description, 120);
    if (d.open !== undefined) g.open = !!d.open;
    if (d.name !== undefined) { const n = cleanStr(d.name, 24); if (n.length < 3) return ack({ ok: false, error: 'invalid_name' }); g.name = n; }
    if (d.tag !== undefined) {
      if (!isOwner) return ack({ ok: false, error: 'owner_only' });
      const tag = cleanStr(d.tag, 5).toUpperCase();
      if (!/^[A-Z0-9]{2,5}$/.test(tag)) return ack({ ok: false, error: 'invalid_tag' });
      if (db.tags[tag] && db.tags[tag] !== g.id) return ack({ ok: false, error: 'tag_taken' });
      delete db.tags[g.tag]; g.tag = tag; db.tags[tag] = g.id;
    }
    pushGuild(g.id); save(); ack({ ok: true, guild: publicGuild(g, true) });
  }));

  socket.on('guild:kick', authed((p, d, ack) => {
    const g = db.guilds[p.guildId];
    if (!g) return ack({ ok: false, error: 'no_guild' });
    const target = db.players[d.playerId];
    if (!target || target.guildId !== g.id || target.id === p.id) return ack({ ok: false, error: 'invalid_target' });
    const isOwner = g.ownerId === p.id, isOfficer = g.officers.includes(p.id);
    if (target.id === g.ownerId || (!isOwner && !(isOfficer && !g.officers.includes(target.id)))) return ack({ ok: false, error: 'forbidden' });
    removeFromGuild(target.id, 'kicked'); ack({ ok: true });
  }));

  socket.on('guild:promote', authed((p, d, ack) => {
    const g = db.guilds[p.guildId];
    if (!g || g.ownerId !== p.id) return ack({ ok: false, error: 'forbidden' });
    const target = db.players[d.playerId];
    if (!target || target.guildId !== g.id || target.id === p.id) return ack({ ok: false, error: 'invalid_target' });
    g.officers = g.officers.filter(o => o !== target.id);
    if (d.officer !== false) g.officers.push(target.id);
    pushGuild(g.id); save(); ack({ ok: true });
  }));

  socket.on('guild:search', authed((p, d, ack) => {
    const q = cleanStr(d.q, 24).toLowerCase();
    const list = Object.values(db.guilds)
      .filter(g => !q || g.name.toLowerCase().includes(q) || g.tag.toLowerCase() === q)
      .sort((a, b) => b.xp - a.xp).slice(0, 20).map(g => publicGuild(g));
    ack({ ok: true, guilds: list });
  }));

  socket.on('guild:info', authed((p, d, ack) => {
    const g = db.guilds[d.guildId];
    ack(g ? { ok: true, guild: publicGuild(g, g.id === p.guildId) } : { ok: false, error: 'not_found' });
  }));

  // ----- leveling -----
  socket.on('xp', authed((p, d, ack) => {
    const rule = XP_RULES[d.kind];
    if (!rule) return ack({ ok: false, error: 'bad_kind' });
    const t = now();
    p.last = p.last || {};
    if (t - (p.last[d.kind] || 0) < rule.cooldown) return ack({ ok: false, error: 'cooldown' });
    if (!p.daily || p.daily.d !== today()) p.daily = { d: today(), xp: 0 };
    if (p.daily.xp >= DAILY_XP_CAP) return ack({ ok: false, error: 'daily_cap' });
    p.last[d.kind] = t;
    const before = playerLevel(p.xp);
    p.xp += rule.xp; p.daily.xp += rule.xp;
    let guildLeveled = false;
    const g = db.guilds[p.guildId];
    if (g) {
      const gb = guildLevel(g.xp);
      g.xp += rule.xp; p.guildXp = (p.guildXp || 0) + rule.xp;
      guildLeveled = guildLevel(g.xp) > gb;
      if (guildLeveled || Math.random() < 0.15) pushGuild(g.id); // throttle roster pushes
      if (guildLeveled) io.to('g:' + g.id).emit('guild:levelup', { level: guildLevel(g.xp) });
    }
    const after = playerLevel(p.xp);
    save();
    ack({ ok: true, gained: rule.xp, me: publicMe(p), levelUp: after > before, guildLevelUp: guildLeveled });
    if (after > before) io.to('p:' + p.id).emit('me:levelup', { level: after });
  }));

  // ----- tags: client sends the player names currently visible in the match -----
  socket.on('tags:lookup', authed((p, d, ack) => {
    const names = Array.isArray(d.names) ? d.names.slice(0, 60) : [];
    const out = {};
    for (const n of names) {
      const id = db.names[String(n).toLowerCase()];
      if (id && db.players[id]) out[n] = tagInfo(db.players[id]);
    }
    ack({ ok: true, tags: out });
  }));
});

httpServer.listen(PORT, () => console.log(`Fister guild server listening on :${PORT}`));
