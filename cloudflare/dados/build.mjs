// Junta worker.js + painel.html em dist/worker.js, que é o código colado no editor do worker na Cloudflare.
// Uso: node build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const dir = new URL('./', import.meta.url);
const html = readFileSync(new URL('painel.html', dir), 'utf8');
const src = readFileSync(new URL('worker.js', dir), 'utf8');
mkdirSync(new URL('dist/', dir), { recursive: true });
writeFileSync(new URL('dist/worker.js', dir), src.replace('__PAINEL__', () => JSON.stringify(html)));
console.log('dist/worker.js pronto');
