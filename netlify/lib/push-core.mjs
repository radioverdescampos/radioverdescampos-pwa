// Rádio Verdes Campos — núcleo dos avisos de notícias (Web Push)
// Usado pelas funções /api/push (inscrição) e news-check (verificação agendada).
import { generateVAPIDKeys, sendNotification } from 'web-push';
import { createHash } from 'node:crypto';

export const SUBJECT = 'mailto:contato@radioverdescamposfm.com.br';
export const PORTAL = 'https://radioverdescamposfm.com.br';
const UA = { 'user-agent': 'VerdesCamposApp/1.0 (+https://radioverdescamposfm.netlify.app)' };

// Chaves VAPID: criadas uma única vez e guardadas no armazenamento do próprio Netlify.
export async function getVapid(store, { create = false } = {}) {
  let v = await store.get('config/vapid', { type: 'json' });
  if (!v && create) {
    const keys = generateVAPIDKeys();
    await store.setJSON('config/vapid', { ...keys, createdAt: new Date().toISOString() });
    v = await store.get('config/vapid', { type: 'json' });
  }
  return v || null;
}

export function subKey(endpoint) {
  return 'subs/' + createHash('sha256').update(endpoint).digest('hex');
}

export function isValidSubscription(s) {
  return !!(s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000 &&
    s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string' &&
    s.keys.p256dh.length < 200 && s.keys.auth.length < 100);
}

export function sendTo(sub, payload, vapid) {
  return sendNotification(sub, JSON.stringify(payload), {
    TTL: 12 * 3600,
    urgency: 'high',
    vapidDetails: { subject: SUBJECT, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
  });
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// Lê o sitemap do portal e devolve só as notícias.
export function parseSitemap(xml) {
  const out = [];
  const re = /<url>([\s\S]*?)<\/url>/g;
  let m;
  while ((m = re.exec(xml))) {
    const loc = (m[1].match(/<loc>\s*([^<]+?)\s*<\/loc>/) || [])[1];
    const lastmod = (m[1].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/) || [])[1] || null;
    if (loc && /\/noticias\/[^/?#]+\/?$/.test(loc.trim())) out.push({ loc: decodeEntities(loc.trim()), lastmod });
  }
  return out;
}

function metaContent(html, prop) {
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
  const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(a) || html.match(b);
  return m ? decodeEntities(m[1]).trim() : null;
}

export function readMeta(html) {
  let title = metaContent(html, 'og:title');
  if (!title) {
    const t = (html.match(/<title>([^<]+)<\/title>/i) || [])[1];
    title = t ? decodeEntities(t).replace(/\s*\|\s*R[aá]dio Verdes Campos.*$/i, '').trim() : null;
  }
  const image = metaContent(html, 'og:image');
  return { title: title || null, image: image && /^https:\/\//.test(image) ? image : null };
}

export function titleFromSlug(loc) {
  const slug = new URL(loc).pathname.split('/').filter(Boolean).pop() || '';
  const t = slug.replace(/-/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : 'Notícia nova no portal';
}

const pathOf = (loc) => new URL(loc).pathname.replace(/\/$/, '');

// Verificação agendada: descobre notícias novas e avisa todos os inscritos.
export async function runCheck({ store, fetchFn = fetch, send = sendTo, now = Date.now(), maxPerRun = 3 }) {
  const res = await fetchFn(PORTAL + '/sitemap.xml', { headers: UA });
  if (!res.ok) throw new Error('sitemap HTTP ' + res.status);
  const items = parseSitemap(await res.text());
  if (!items.length) return { status: 'sitemap-sem-noticias' };

  const seenArr = await store.get('state/seen-news', { type: 'json' });
  if (!Array.isArray(seenArr)) {
    // Primeira execução: só memoriza o que já existe, sem avisar ninguém.
    await store.setJSON('state/seen-news', items.map((i) => pathOf(i.loc)));
    return { status: 'iniciado', noticias: items.length };
  }

  const seen = new Set(seenArr);
  const fresh = items.filter((i) => !seen.has(pathOf(i.loc)));
  if (!fresh.length) return { status: 'nada-novo' };

  const cutoff = now - 12 * 3600 * 1000;
  const recent = fresh
    .filter((i) => !i.lastmod || Date.parse(i.lastmod) >= cutoff)
    .sort((a, b) => (Date.parse(b.lastmod) || 0) - (Date.parse(a.lastmod) || 0))
    .slice(0, maxPerRun);

  // Marca como vistas antes de enviar, para nunca repetir o mesmo aviso.
  for (const i of fresh) seen.add(pathOf(i.loc));
  await store.setJSON('state/seen-news', [...seen]);

  const vapid = await getVapid(store);
  if (!vapid || !recent.length) return { status: 'sem-envio', novas: fresh.length, recentes: recent.length };

  const { blobs } = await store.list({ prefix: 'subs/' });
  const subs = [];
  for (let i = 0; i < blobs.length; i += 50) {
    const part = await Promise.all(blobs.slice(i, i + 50).map((b) =>
      store.get(b.key, { type: 'json' }).then((v) => (v && v.subscription ? { key: b.key, sub: v.subscription } : null)).catch(() => null)));
    subs.push(...part.filter(Boolean));
  }

  let sent = 0, removed = 0, failed = 0;
  for (const item of recent.reverse()) {           // a mais nova é enviada por último e fica no topo
    let meta = { title: null, image: null };
    try { const r = await fetchFn(item.loc, { headers: UA }); if (r.ok) meta = readMeta(await r.text()); } catch {}
    const payload = {
      title: 'Verdes Campos 97.9 · Notícia',
      body: meta.title || titleFromSlug(item.loc),
      url: item.loc,
      image: meta.image || undefined,
      tag: 'noticia-' + pathOf(item.loc).split('/').pop(),
    };
    for (let i = 0; i < subs.length; i += 25) {
      await Promise.all(subs.slice(i, i + 25).map(async (s) => {
        if (s.dead) return;
        try { await send(s.sub, payload, vapid); sent++; }
        catch (e) {
          if (e && (e.statusCode === 404 || e.statusCode === 410)) { s.dead = true; removed++; await store.delete(s.key).catch(() => {}); }
          else failed++;
        }
      }));
    }
  }
  return { status: 'enviado', noticias: recent.length, inscritos: subs.length, enviados: sent, removidos: removed, falhas: failed };
}
