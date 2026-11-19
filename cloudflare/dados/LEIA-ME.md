# Dados do app (Cloudflare)

Painel: https://radioverdescampos-dados.euabima.workers.dev/painel

- `worker.js`: recebe as estatísticas anônimas do app, roda a cada 5 minutos e responde ao painel.
- `painel.html`: a página do painel (vai embutida no worker).
- `build.mjs`: junta os dois em `dist/worker.js` (`node build.mjs`). É esse arquivo que vai no editor do worker.

Na Cloudflare (conta euabima@gmail.com):
- Worker `radioverdescampos-dados`
- Banco D1 `radioverdescampos-dados`, ligado ao worker com o nome `DB` (as tabelas são criadas sozinhas)
- Gatilho cron `*/5 * * * *`

Esqueceu a senha do painel? No banco D1, aba Console, rode `DELETE FROM config WHERE k IN ('pass','secret');` e abra o painel para criar outra.
