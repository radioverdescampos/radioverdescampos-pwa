// Confere o portal a cada 5 minutos (das 6h à meia-noite, horário de Brasília)
// e avisa os inscritos quando sai notícia nova.
import { getStore } from '@netlify/blobs';
import { runCheck } from '../lib/push-core.mjs';

export default async () => {
  const store = getStore({ name: 'avisos', consistency: 'strong' });
  try {
    const result = await runCheck({ store });
    console.log('[news-check]', JSON.stringify(result));
  } catch (e) {
    console.error('[news-check] erro:', e && e.message);
  }
  return new Response('ok');
};

// Horário em UTC: 09h–02h59 UTC = 06h–23h59 em Brasília.
export const config = { schedule: '*/5 0-2,9-23 * * *' };
