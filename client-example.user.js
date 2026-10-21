// ==UserScript==
// @name         Fister Guilds (client example)
// @match        https://fister.fun/*
// @require      https://cdn.socket.io/4.8.1/socket.io.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      YOUR-APP.zeabur.app
// ==/UserScript==

(function () {
  const SERVER = 'https://YOUR-APP.zeabur.app';
  const socket = io(SERVER, { transports: ['websocket'] });
  const emit = (ev, data) => new Promise(r => socket.emit(ev, data, r));
  let me = null, guild = null;

  async function login() {
    const id = GM_getValue('gid'), token = GM_getValue('gtoken');
    let res = id && token ? await emit('auth', { id, token }) : null;
    if (!res || !res.ok) {
      const name = prompt('Pick your Fister Guilds name (must match your in-game name):');
      res = await emit('auth', { name });
      if (!res.ok) return alert('Guild login failed: ' + res.error);
      GM_setValue('gid', res.me.id);
      GM_setValue('gtoken', res.token);
    }
    me = res.me; guild = res.guild;
    console.log('[Guilds] logged in', me, guild);
  }

  socket.on('connect', login);
  socket.on('me:update', m => (me = m));
  socket.on('guild:update', g => (guild = g));
  socket.on('guild:removed', () => (guild = null));
  socket.on('me:levelup', e => console.log('Level up!', e.level));
  socket.on('guild:levelup', e => console.log('Guild level up!', e.level));

  // --- Report gameplay. Hook these into fister.fun's own events ---
  window.fisterGuild = {
    kill: () => emit('xp', { kind: 'kill' }),
    win: () => emit('xp', { kind: 'win' }),
    create: (name, tag, color, emblem) => emit('guild:create', { name, tag, color, emblem }),
    join: tag => emit('guild:join', { tag }),
    leave: () => emit('guild:leave'),
    search: q => emit('guild:search', { q }),
  };
  setInterval(() => document.visibilityState === 'visible' && emit('xp', { kind: 'tick' }), 60000);

  // --- Show tags for other plugin users: look up the names visible on screen ---
  // Replace getVisiblePlayerNames() / the nameplate element with fister.fun's real DOM/game objects.
  async function refreshTags() {
    const names = getVisiblePlayerNames();
    if (!names.length) return;
    const { tags } = await emit('tags:lookup', { names });
    for (const [name, info] of Object.entries(tags)) applyTag(name, info);
  }
  function getVisiblePlayerNames() { return []; /* TODO */ }
  function applyTag(name, info) {
    if (!info.guild) return;
    const label = `${info.guild.emblem} [${info.guild.tag}] ${name} (Lv ${info.level})`;
    // TODO: set nameplate text to `label` and color to info.guild.color
    console.debug('[Guilds]', label);
  }
  setInterval(refreshTags, 5000);
})();
