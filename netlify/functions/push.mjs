// /api/push — liga e desliga os avisos de notícias de cada aparelho.
import { getStore } from '@netlify/blobs';
import { getVapid, isValidSubscription, subKey, sendTo } from '../lib/push-core.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export default async (req) => {
  const store = getStore({ name: 'avisos', consistency: 'strong' });

  // Chave pública que o aparelho usa para se inscrever.
  if (req.method === 'GET') {
    const v = await getVapid(store, { create: true });
    return json({ publicKey: v.publicKey });
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'json' }, 400); }
    const sub = body && body.subscription;
    if (!isValidSubscription(sub)) return json({ error: 'inscricao-invalida' }, 400);
    const key = subKey(sub.endpoint);
    const existed = await store.get(key);
    await store.setJSON(key, {
      subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
      updatedAt: new Date().toISOString(),
    });
    if (body.welcome && !existed) {
      try {
        const v = await getVapid(store, { create: true });
        await sendTo(sub, {
          title: 'Avisos ligados',
          body: 'Você vai receber aqui as notícias novas da Verdes Campos 97.9.',
          url: '/',
          tag: 'boas-vindas',
        }, v);
      } catch { return json({ ok: true, boasVindas: false }); }
    }
    return json({ ok: true });
  }

  if (req.method === 'DELETE') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'json' }, 400); }
    if (body && typeof body.endpoint === 'string') await store.delete(subKey(body.endpoint));
    return json({ ok: true });
  }

  return json({ error: 'metodo' }, 405);
};

export const config = { path: '/api/push' };
