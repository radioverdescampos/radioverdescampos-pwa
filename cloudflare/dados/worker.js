/* =========================================================================
   Rádio Verdes Campos 97.9 FM — Dados do app
   Cloudflare Worker + banco D1 (ligação "DB") + agendamento a cada 5 minutos.

   POST /e            eventos anônimos enviados pelo app (abrir, instalar,
                      tocar, sinal de quem está ouvindo, parar, avisos)
   GET  /painel       painel com senha
   GET  /api/resumo   números do painel (precisa estar logado)
   GET  /saude        teste rápido (não mostra dados)

   Não guarda nome, telefone, e-mail nem IP. Cada aparelho é um código
   aleatório criado pelo próprio app. A cidade vem da localização aproximada
   da conexão, que a Cloudflare informa em cada acesso.
   ========================================================================= */

const TZ = -3 * 3600;          // horário de Brasília (sem horário de verão)
const LIVE = 150;              // segundos sem sinal para deixar de contar como "ouvindo agora"
const ORIGINS = [
  /^https:\/\/radioverdescamposfm\.netlify\.app$/,
  /^https:\/\/[a-z0-9-]+--radioverdescamposfm\.netlify\.app$/,
  /^https:\/\/(www\.|app\.)?radioverdescamposfm\.com(\.br)?$/,
];
const IDRE = /^[A-Za-z0-9-]{16,40}$/;
const OSES = ['android', 'ios', 'desktop', 'other'];
const KINDS = new Set(['open', 'install', 'play', 'hb', 'stop', 'push']);
const COOKIE = 'vcpainel';
const ITER = 10000;            // PBKDF2 (limite de CPU do plano grátis)

const PAINEL = __PAINEL__;

/* ------------------------------------------------------------------ banco */
const SCHEMA_VERSION = '1';
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS devices (
     id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
     os TEXT, mode TEXT, installed_at INTEGER, city TEXT, region TEXT, country TEXT,
     push INTEGER NOT NULL DEFAULT 0, opens INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0
   ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS devices_last ON devices(last_seen)`,
  `CREATE INDEX IF NOT EXISTS devices_inst ON devices(installed_at)`,
  `CREATE TABLE IF NOT EXISTS activity (day TEXT NOT NULL, device TEXT NOT NULL, PRIMARY KEY (day, device)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY, device TEXT NOT NULL, start INTEGER NOT NULL, last INTEGER NOT NULL,
     os TEXT, mode TEXT, city TEXT, program TEXT
   ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS sessions_start ON sessions(start)`,
  `CREATE TABLE IF NOT EXISTS live (
     device TEXT PRIMARY KEY, session TEXT NOT NULL, last INTEGER NOT NULL,
     os TEXT, mode TEXT, city TEXT, region TEXT, program TEXT
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS samples (ts INTEGER PRIMARY KEY, total INTEGER NOT NULL,
     android INTEGER NOT NULL, ios INTEGER NOT NULL, desktop INTEGER NOT NULL, other INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS hourly (day TEXT NOT NULL, hour INTEGER NOT NULL, total_sum INTEGER NOT NULL,
     samples INTEGER NOT NULL, peak INTEGER NOT NULL, PRIMARY KEY (day, hour)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS prog (day TEXT NOT NULL, program TEXT NOT NULL, listeners_sum INTEGER NOT NULL,
     PRIMARY KEY (day, program)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS login_fail (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, first INTEGER NOT NULL) WITHOUT ROWID`,
];

let ready = null;
function schema(env){
  if (!env.DB) throw new Error('Banco D1 não ligado: falta a ligação "DB" no worker.');
  return ready || (ready = (async () => {
    try {
      const v = await env.DB.prepare("SELECT v FROM config WHERE k = 'schema'").first('v');
      if (v === SCHEMA_VERSION) return;
    } catch {}
    await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
    await env.DB.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('schema', ?)").bind(SCHEMA_VERSION).run();
  })().catch(e => { ready = null; throw e; }));
}

/* ---------------------------------------------------------- utilidades */
const nowS = () => Math.floor(Date.now() / 1000);
const sp = ts => new Date((ts + TZ) * 1000);
const dayOf = ts => sp(ts).toISOString().slice(0, 10);
const dayStart = ts => Math.floor((ts + TZ) / 86400) * 86400 - TZ;
const minOf = ts => { const d = sp(ts); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
function clip(v, n){
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);
  return s || null;
}
const enc = new TextEncoder();
const hex = b => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16)));
const rnd = n => hex(crypto.getRandomValues(new Uint8Array(n)));
function same(a, b){
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function pbkdf2(pass, salt, iter){
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations: iter }, key, 256));
}
async function hmac(secret, msg){
  const key = await crypto.subtle.importKey('raw', unhex(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
async function sha(msg){ return hex(await crypto.subtle.digest('SHA-256', enc.encode(msg))); }

const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};
function json(obj, status = 200, extra = {}){
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC, ...extra } });
}
function allowed(origin, env){
  if (ORIGINS.some(r => r.test(origin))) return true;
  return !!env.ALLOW_LOCAL && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/* ------------------------------------------------- eventos vindos do app */
async function event(req, env){
  const origin = req.headers.get('Origin') || '';
  const ok = allowed(origin, env);
  const cors = ok ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {};
  if (req.method === 'OPTIONS'){
    return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '86400' } });
  }
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  if (!ok) return new Response(null, { status: 403 });
  const body = await req.text();
  if (body.length > 1024) return new Response(null, { status: 413, headers: cors });
  let e; try { e = JSON.parse(body); } catch { return new Response(null, { status: 400, headers: cors }); }
  if (!e || !KINDS.has(e.t) || !IDRE.test(e.d || '')) return new Response(null, { status: 400, headers: cors });
  if (['play', 'hb', 'stop'].includes(e.t) && !IDRE.test(e.s || '')) return new Response(null, { status: 400, headers: cors });
  try {
    await schema(env);
    await record(env, e, req.cf || {}, nowS());
  } catch (err) {
    console.log('[evento] falhou:', err && err.message);
    return new Response(null, { status: 503, headers: cors });
  }
  return new Response(null, { status: 204, headers: cors });
}

async function record(env, e, cf, ts){
  const db = env.DB;
  const os = OSES.includes(e.os) ? e.os : 'other';
  const mode = e.m === 'app' ? 'app' : 'web';
  const city = clip(cf.city, 60), region = clip(cf.regionCode || cf.region, 40), country = clip(cf.country, 4);
  const prog = clip(e.p, 60);
  const push = e.n === 1 || e.n === true ? 1 : e.n === 0 || e.n === false ? 0 : null;
  const today = dayOf(ts);

  const device = (opens, plays, installed) => db.prepare(
    `INSERT INTO devices (id, first_seen, last_seen, os, mode, installed_at, city, region, country, push, opens, plays)
     VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9, 0), ?10, ?11)
     ON CONFLICT(id) DO UPDATE SET
       last_seen = excluded.last_seen, os = excluded.os,
       mode = CASE WHEN devices.mode = 'app' THEN 'app' ELSE excluded.mode END,
       installed_at = COALESCE(devices.installed_at, excluded.installed_at),
       city = COALESCE(excluded.city, devices.city), region = COALESCE(excluded.region, devices.region),
       country = COALESCE(excluded.country, devices.country),
       push = COALESCE(?9, devices.push),
       opens = devices.opens + excluded.opens, plays = devices.plays + excluded.plays`
  ).bind(e.d, ts, os, mode, installed ? ts : null, city, region, country, push, opens, plays);
  const active = () => db.prepare('INSERT OR IGNORE INTO activity (day, device) VALUES (?1, ?2)').bind(today, e.d);
  const session = start => db.prepare(
    'INSERT OR IGNORE INTO sessions (id, device, start, last, os, mode, city, program) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
  ).bind(e.s, e.d, start, ts, os, mode, city, prog);
  const live = throttle => db.prepare(
    `INSERT INTO live (device, session, last, os, mode, city, region, program) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(device) DO UPDATE SET session = excluded.session, last = excluded.last, os = excluded.os, mode = excluded.mode,
       city = excluded.city, region = excluded.region, program = excluded.program` +
    (throttle ? ' WHERE excluded.last - live.last >= 20 OR excluded.session <> live.session' : '')
  ).bind(e.d, e.s, ts, os, mode, city, region, prog);

  let st;
  switch (e.t){
    case 'open':    st = [device(1, 0, mode === 'app'), active()]; break;
    case 'install': st = [device(0, 0, true), active()]; break;
    case 'push':    st = [device(0, 0, mode === 'app')]; break;
    case 'play':    st = [device(0, 1, mode === 'app'), active(), session(ts), live(false)]; break;
    case 'hb':      st = [active(), session(ts - 60), live(true)]; break;
    case 'stop':    st = [
      db.prepare('UPDATE sessions SET last = ?1 WHERE id = ?2 AND device = ?3 AND last < ?1').bind(ts, e.s, e.d),
      db.prepare('DELETE FROM live WHERE device = ?1').bind(e.d),
    ]; break;
  }
  await db.batch(st);
}

/* ------------------------------------------ a cada 5 minutos (agendado) */
async function tick(env, ts){
  await schema(env);
  const db = env.DB;
  const bucket = Math.floor(ts / 300) * 300;
  const cut = ts - LIVE;
  const last = await db.prepare("SELECT v FROM config WHERE k = 'tick'").first('v');
  if (last !== String(bucket)){
    // leva o último sinal de cada ouvinte para a sessão dele (tempo ouvido)
    await db.prepare('UPDATE sessions SET last = live.last FROM live WHERE live.session = sessions.id AND live.last > sessions.last').run();
    const { results } = await db.prepare('SELECT os, program, COUNT(*) AS n FROM live WHERE last > ?1 GROUP BY os, program').bind(cut).all();
    const c = { android: 0, ios: 0, desktop: 0, other: 0 }, progs = {};
    let total = 0;
    for (const r of results){
      c[OSES.includes(r.os) ? r.os : 'other'] += r.n; total += r.n;
      if (r.program) progs[r.program] = (progs[r.program] || 0) + r.n;
    }
    const d = dayOf(bucket), h = sp(bucket).getUTCHours();
    await db.batch([
      db.prepare('INSERT OR REPLACE INTO samples (ts, total, android, ios, desktop, other) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(bucket, total, c.android, c.ios, c.desktop, c.other),
      db.prepare(`INSERT INTO hourly (day, hour, total_sum, samples, peak) VALUES (?1, ?2, ?3, 1, ?3)
                  ON CONFLICT(day, hour) DO UPDATE SET total_sum = hourly.total_sum + excluded.total_sum,
                  samples = hourly.samples + 1, peak = MAX(hourly.peak, excluded.peak)`).bind(d, h, total),
      ...Object.entries(progs).map(([p, n]) => db.prepare(
        `INSERT INTO prog (day, program, listeners_sum) VALUES (?1, ?2, ?3)
         ON CONFLICT(day, program) DO UPDATE SET listeners_sum = prog.listeners_sum + excluded.listeners_sum`).bind(d, p, n)),
      db.prepare('DELETE FROM live WHERE last <= ?1').bind(cut),
      db.prepare('DELETE FROM samples WHERE ts < ?1').bind(bucket - 8 * 86400),
      db.prepare('DELETE FROM login_fail WHERE first < ?1').bind(ts - 86400),
      db.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('tick', ?1)").bind(String(bucket)),
    ]);
  }
  const L = await light(env, ts);
  const st = [db.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('light', ?1)").bind(JSON.stringify(L))];
  const hv = await db.prepare("SELECT v FROM config WHERE k = 'heavy'").first('v');
  const hAt = hv ? (JSON.parse(hv).at || 0) : 0;
  if (ts - hAt >= 1740 || dayOf(hAt) !== dayOf(ts)){
    st.push(db.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('heavy', ?1)").bind(JSON.stringify(await heavy(env, ts))));
  }
  await db.batch(st);
}

/* --------------------------------------------------------------- resumos */
// Números que mudam ao longo do dia (refeito a cada 5 minutos)
async function light(env, ts){
  const db = env.DB;
  const t0 = dayStart(ts), y0 = t0 - 86400, today = dayOf(ts);
  const [s, inst, act, ses, hrs] = await db.batch([
    db.prepare('SELECT ts, total FROM samples WHERE ts >= ?1 ORDER BY ts').bind(y0),
    db.prepare('SELECT COUNT(*) AS total, SUM(installed_at >= ?1) AS today, SUM(installed_at >= ?2) AS d7 FROM devices WHERE installed_at IS NOT NULL').bind(t0, t0 - 6 * 86400),
    db.prepare('SELECT COUNT(*) AS n FROM activity WHERE day = ?1').bind(today),
    db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE start >= ?1').bind(t0),
    db.prepare('SELECT COALESCE(SUM(total_sum), 0) AS s FROM hourly WHERE day = ?1').bind(today),
  ]);
  const series = { today: [], yesterday: [] };
  let peak = { n: 0, min: null };
  for (const r of s.results){
    const p = [minOf(r.ts), r.total];
    if (r.ts >= t0){ series.today.push(p); if (r.total > peak.n) peak = { n: r.total, min: p[0] }; }
    else series.yesterday.push(p);
  }
  const i = inst.results[0] || {};
  return {
    at: ts, today, series, peak,
    installs: { total: i.total || 0, today: i.today || 0, d7: i.d7 || 0 },
    activeToday: act.results[0].n, sessionsToday: ses.results[0].n,
    hoursToday: Math.round(hrs.results[0].s * 5 / 60 * 10) / 10,
  };
}

// Números de 7 e 30 dias (refeito a cada 30 minutos)
async function heavy(env, ts){
  const db = env.DB;
  const t0 = dayStart(ts), t7 = t0 - 6 * 86400, t30 = t0 - 29 * 86400;
  const d7 = dayOf(t7), d30 = dayOf(t30);
  const q = await db.batch([
    db.prepare("SELECT date(installed_at - 10800, 'unixepoch') AS d, COUNT(*) AS n FROM devices WHERE installed_at >= ?1 GROUP BY d").bind(t30),
    db.prepare('SELECT day AS d, COUNT(*) AS n FROM activity WHERE day >= ?1 GROUP BY day').bind(d30),
    db.prepare('SELECT day AS d, SUM(total_sum) AS s, MAX(peak) AS p FROM hourly WHERE day >= ?1 GROUP BY day').bind(d30),
    db.prepare('SELECT COUNT(DISTINCT CASE WHEN day >= ?2 THEN device END) AS a7, COUNT(DISTINCT device) AS a30 FROM activity WHERE day >= ?1').bind(d30, d7),
    db.prepare('SELECT os, COUNT(*) AS n, SUM(installed_at IS NOT NULL) AS inst FROM devices WHERE last_seen >= ?1 GROUP BY os').bind(t30),
    db.prepare('SELECT city, region, COUNT(*) AS n, SUM(installed_at IS NOT NULL) AS inst FROM devices WHERE last_seen >= ?1 AND city IS NOT NULL GROUP BY city, region ORDER BY n DESC LIMIT 12').bind(t30),
    db.prepare('SELECT program, SUM(listeners_sum) AS s FROM prog WHERE day >= ?1 GROUP BY program ORDER BY s DESC LIMIT 12').bind(d7),
    db.prepare('SELECT hour, SUM(total_sum) AS s, SUM(samples) AS n, MAX(peak) AS p FROM hourly WHERE day >= ?1 GROUP BY hour').bind(d7),
    db.prepare('SELECT COUNT(*) AS n, AVG(last - start) AS avg FROM sessions WHERE start >= ?1').bind(t7),
    db.prepare('SELECT COUNT(*) AS devices, SUM(installed_at IS NOT NULL) AS inst, SUM(push) AS push FROM devices'),
    db.prepare('SELECT os, COUNT(*) AS n FROM devices WHERE installed_at IS NOT NULL GROUP BY os'),
  ]);
  const map = (r, f) => Object.fromEntries(r.results.map(x => [x.d, f(x)]));
  const inst = map(q[0], x => x.n), act = map(q[1], x => x.n), hrs = map(q[2], x => x);
  const days = [];
  for (let k = 29; k >= 0; k--){
    const d = dayOf(t0 - k * 86400);
    days.push({ d, installs: inst[d] || 0, active: act[d] || 0,
      hours: hrs[d] ? Math.round(hrs[d].s * 5 / 60 * 10) / 10 : 0, peak: hrs[d] ? hrs[d].p : 0 });
  }
  const hours = Array.from({ length: 24 }, (_, h) => ({ h, avg: 0, peak: 0 }));
  for (const r of q[7].results) hours[r.hour] = { h: r.hour, avg: r.n ? Math.round(r.s / r.n * 10) / 10 : 0, peak: r.p || 0 };
  const a = q[3].results[0] || {}, se = q[8].results[0] || {}, tot = q[9].results[0] || {};
  return {
    at: ts, days, hours,
    active7: a.a7 || 0, active30: a.a30 || 0,
    os30: q[4].results.map(r => ({ os: r.os || 'other', n: r.n, inst: r.inst || 0 })),
    osInstalled: q[10].results.map(r => ({ os: r.os || 'other', n: r.n })),
    cities: q[5].results.map(r => ({ city: r.city, region: r.region, n: r.n, inst: r.inst || 0 })),
    programs: q[6].results.map(r => ({ program: r.program, hours: Math.round(r.s * 5 / 60 * 10) / 10 })),
    sessions7: { n: se.n || 0, avgMin: se.avg ? Math.round(se.avg / 60) : 0 },
    totals: { devices: tot.devices || 0, installed: tot.inst || 0, push: tot.push || 0 },
  };
}

async function liveNow(env, ts){
  const { results } = await env.DB.prepare('SELECT os, mode, city, region, program FROM live WHERE last > ?1').bind(ts - LIVE).all();
  const out = { total: results.length, os: { android: 0, ios: 0, desktop: 0, other: 0 }, mode: { app: 0, web: 0 }, cities: [], programs: [] };
  const cities = {}, progs = {};
  for (const r of results){
    out.os[OSES.includes(r.os) ? r.os : 'other']++;
    out.mode[r.mode === 'app' ? 'app' : 'web']++;
    const ck = (r.city || 'Não identificada') + '|' + (r.region || '');
    cities[ck] = (cities[ck] || 0) + 1;
    const pk = r.program || 'Programação musical';
    progs[pk] = (progs[pk] || 0) + 1;
  }
  out.cities = Object.entries(cities).map(([k, n]) => { const [city, region] = k.split('|'); return { city, region, n }; }).sort((a, b) => b.n - a.n).slice(0, 15);
  out.programs = Object.entries(progs).map(([program, n]) => ({ program, n })).sort((a, b) => b.n - a.n);
  return out;
}

/* ------------------------------------------------------------- login */
async function authState(env){
  const { results } = await env.DB.prepare("SELECT k, v FROM config WHERE k IN ('pass', 'secret')").all();
  const o = Object.fromEntries(results.map(r => [r.k, r.v]));
  return { pass: o.pass ? JSON.parse(o.pass) : null, secret: o.secret || null };
}
function readCookie(req){
  const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  return m ? m[1] : '';
}
async function loggedIn(req, a){
  if (!a.pass || !a.secret) return false;
  const [exp, sig] = readCookie(req).split('.');
  if (!exp || !sig || Number(exp) < nowS()) return false;
  return same(sig, await hmac(a.secret, 'painel:' + exp));
}
async function cookieFor(secret){
  const exp = nowS() + 30 * 86400;
  return `${COOKIE}=${exp}.${await hmac(secret, 'painel:' + exp)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`;
}
const CLEAR = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
async function newPass(senha){ const salt = rnd(16); return { salt, iter: ITER, hash: await pbkdf2(senha, salt, ITER) }; }
async function checkPass(p, senha){ return same(p.hash, await pbkdf2(senha, p.salt, p.iter || ITER)); }
function validPass(s){ return typeof s === 'string' && s.length >= 8 && s.length <= 200; }

async function api(req, env, url){
  const db = env.DB;
  const path = url.pathname;
  if (req.method === 'POST'){
    if (req.headers.get('Origin') !== url.origin) return json({ erro: 'Origem não permitida.' }, 403);
  }
  const a = await authState(env);

  if (path === '/api/resumo' && req.method === 'GET'){
    if (!a.pass) return json({ need: 'setup' }, 401);
    if (!(await loggedIn(req, a))) return json({ need: 'login' }, 401);
    const ts = nowS();
    const { results } = await db.prepare("SELECT k, v FROM config WHERE k IN ('light', 'heavy')").all();
    const c = Object.fromEntries(results.map(r => [r.k, JSON.parse(r.v)]));
    const L = c.light && ts - c.light.at < 900 && c.light.today === dayOf(ts) ? c.light : await light(env, ts);
    const H = c.heavy && ts - c.heavy.at < 7200 && dayOf(c.heavy.at) === dayOf(ts) ? c.heavy : await heavy(env, ts);
    return json({ now: ts, nowMin: minOf(ts), live: await liveNow(env, ts), light: L, heavy: H });
  }

  let body = {};
  if (req.method === 'POST'){ try { body = await req.json(); } catch {} }

  if (path === '/api/setup' && req.method === 'POST'){
    if (a.pass) return json({ erro: 'A senha do painel já foi criada.' }, 409);
    if (!validPass(body.senha)) return json({ erro: 'Use pelo menos 8 caracteres.' }, 400);
    const p = await newPass(body.senha), secret = rnd(32);
    const r = await db.prepare("INSERT OR IGNORE INTO config (k, v) VALUES ('pass', ?1)").bind(JSON.stringify(p)).run();
    if (!r.meta || !r.meta.changes) return json({ erro: 'A senha do painel já foi criada.' }, 409);
    await db.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('secret', ?1)").bind(secret).run();
    return json({ ok: true }, 200, { 'Set-Cookie': await cookieFor(secret) });
  }

  if (path === '/api/login' && req.method === 'POST'){
    if (!a.pass) return json({ need: 'setup' }, 401);
    const ip = (await sha('vc:' + (req.headers.get('CF-Connecting-IP') || 'local'))).slice(0, 32);
    const ts = nowS();
    const f = await db.prepare('SELECT n, first FROM login_fail WHERE ip = ?1').bind(ip).first();
    if (f && f.n >= 8 && ts - f.first < 900) return json({ erro: 'Muitas tentativas. Espere 15 minutos.' }, 429);
    if (typeof body.senha !== 'string' || !(await checkPass(a.pass, body.senha))){
      await db.prepare(`INSERT INTO login_fail (ip, n, first) VALUES (?1, 1, ?2)
        ON CONFLICT(ip) DO UPDATE SET n = CASE WHEN ?2 - login_fail.first >= 900 THEN 1 ELSE login_fail.n + 1 END,
        first = CASE WHEN ?2 - login_fail.first >= 900 THEN ?2 ELSE login_fail.first END`).bind(ip, ts).run();
      return json({ erro: 'Senha incorreta.' }, 401);
    }
    await db.prepare('DELETE FROM login_fail WHERE ip = ?1').bind(ip).run();
    return json({ ok: true }, 200, { 'Set-Cookie': await cookieFor(a.secret) });
  }

  if (path === '/api/sair' && req.method === 'POST'){
    return json({ ok: true }, 200, { 'Set-Cookie': CLEAR });
  }

  if (path === '/api/senha' && req.method === 'POST'){
    if (!(await loggedIn(req, a))) return json({ need: 'login' }, 401);
    if (typeof body.atual !== 'string' || !(await checkPass(a.pass, body.atual))) return json({ erro: 'A senha atual não confere.' }, 400);
    if (!validPass(body.nova)) return json({ erro: 'A nova senha precisa de pelo menos 8 caracteres.' }, 400);
    const p = await newPass(body.nova), secret = rnd(32);
    await db.batch([
      db.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('pass', ?1)").bind(JSON.stringify(p)),
      db.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('secret', ?1)").bind(secret),
    ]);
    return json({ ok: true }, 200, { 'Set-Cookie': await cookieFor(secret) });
  }

  return json({ erro: 'Não encontrado.' }, 404);
}

/* ------------------------------------------------------------- entrada */
const CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    try {
      if (url.pathname === '/e') return await event(req, env);
      if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain' } });
      if (url.pathname === '/' || url.pathname === '/painel/') return Response.redirect(url.origin + '/painel', 302);
      await schema(env);
      if (url.pathname === '/saude') return json({ ok: true, banco: true, agora: new Date().toISOString() });
      if (url.pathname === '/painel' && req.method === 'GET'){
        return new Response(PAINEL, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'Content-Security-Policy': CSP, ...SEC } });
      }
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      return new Response('Não encontrado', { status: 404, headers: SEC });
    } catch (err) {
      console.log('[erro]', err && (err.stack || err.message));
      return json({ erro: 'Falha no servidor: ' + (err && err.message) }, 500);
    }
  },
  async scheduled(ev, env, ctx){
    ctx.waitUntil(tick(env, Math.floor(ev.scheduledTime / 1000)).catch(err => console.log('[agendado] falhou:', err && err.message)));
  },
};
