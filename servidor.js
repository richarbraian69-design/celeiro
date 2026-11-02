'use strict';
/*
 * Celeiro — servidor das finanças da casa e da Agência Crown.
 * Guarda tudo num arquivo JSON dentro do disco do Railway (sem banco externo),
 * cuida do login de cada pessoa, avisa os aparelhos abertos quando algo muda
 * e lê prints de extrato com o Claude (se houver a chave ANTHROPIC_API_KEY).
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORTA = process.env.PORT || 3000;
function discoEm(p) { try { return fs.statSync(p).isDirectory() && fs.statSync(p).dev !== fs.statSync(__dirname).dev; } catch (e) { return false; } }
const DADOS = path.resolve(process.env.CELEIRO_DADOS || process.env.RAILWAY_VOLUME_MOUNT_PATH || (discoEm('/data') ? '/data' : path.join(__dirname, 'dados')));
const ARQ = path.join(DADOS, 'celeiro.json');
const BACKUPS = path.join(DADOS, 'backups');
const FUSO = process.env.FUSO || 'America/Sao_Paulo';
const MODELO = process.env.ANTHROPIC_MODELO || 'claude-sonnet-5-5';
const COLECOES = new Set(['config', 'clientes', 'lancamentos', 'movimentos', 'exames', 'recebimentos', 'ajustes']);
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,120}$/;
const DIAS_SESSAO = 90;
const COPIAS = 30;

/* ---------- Armazenamento ---------- */
fs.mkdirSync(BACKUPS, { recursive: true });
let db = { usuarios: [], sessoes: {}, docs: {}, apagados: {}, seq: 0 };
if (fs.existsSync(ARQ)) {
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(ARQ, 'utf8'))); }
  catch (e) { console.error('Não consegui ler ' + ARQ + '. Corrija ou restaure uma cópia da pasta backups/. Nada foi apagado.', e.message); process.exit(1); }
}
let timerGravar = null, ultimoErroGravar = '', ultimaGravacao = 0;
function gravar() { clearTimeout(timerGravar); timerGravar = setTimeout(gravarAgora, 250); }
function gravarAgora() {
  timerGravar = null;
  if (!db.criadoEm) db.criadoEm = new Date().toISOString();
  try {
    const tmp = ARQ + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, ARQ);
    ultimaGravacao = Date.now(); ultimoErroGravar = '';
  } catch (e) { ultimoErroGravar = e.message; console.error('[dados] NÃO consegui gravar em ' + ARQ + ': ' + e.message); }
}
const NO_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
function discoSeparado() { try { return fs.statSync(DADOS).dev !== fs.statSync(__dirname).dev; } catch (e) { return false; } }
function dadosPersistentes() {
  if (!NO_RAILWAY) return true;
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH || (DADOS === '/data' ? '/data' : '');
  return !!vol && (DADOS === path.resolve(vol) || DADOS.startsWith(path.resolve(vol) + path.sep)) && discoSeparado();
}
const INICIADO = new Date();
function encerrar() { if (timerGravar) gravarAgora(); process.exit(0); }
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);

function hojeNoFuso() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => (p.find(x => x.type === t) || {}).value;
  return g('year') + '-' + g('month') + '-' + g('day');
}
function copiaDeSeguranca(nome) {
  if (timerGravar) gravarAgora();
  if (!fs.existsSync(ARQ)) return;
  fs.copyFileSync(ARQ, path.join(BACKUPS, nome));
  const antigos = fs.readdirSync(BACKUPS).filter(f => /^celeiro-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  antigos.slice(0, Math.max(0, antigos.length - COPIAS)).forEach(f => { try { fs.unlinkSync(path.join(BACKUPS, f)); } catch (e) {} });
}
function backupDiario() {
  const alvo = 'celeiro-' + hojeNoFuso() + '.json';
  if (db.usuarios.length && !fs.existsSync(path.join(BACKUPS, alvo))) copiaDeSeguranca(alvo);
}
setInterval(backupDiario, 30 * 60 * 1000);
setTimeout(backupDiario, 5000);

/* ---------- Utilidades ---------- */
class Erro extends Error { constructor(m, status) { super(m); this.status = status || 400; } }
function novoId(prefixo) { return prefixo + crypto.randomBytes(9).toString('base64url'); }
function normNome(n) { return String(n || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function hashSenha(senha) { const sal = crypto.randomBytes(16).toString('hex'); return sal + ':' + crypto.scryptSync(String(senha), sal, 64).toString('hex'); }
function senhaConfere(senha, guardado) {
  const [sal, h] = String(guardado || '').split(':'); if (!sal || !h) return false;
  const x = crypto.scryptSync(String(senha), sal, 64), y = Buffer.from(h, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function validarNome(n) { n = String(n || '').trim(); if (n.length < 1 || n.length > 40) throw new Erro('O nome precisa ter entre 1 e 40 letras.'); return n; }
function validarSenha(s) { s = String(s || ''); if (s.length < 6 || s.length > 100) throw new Erro('A senha precisa ter pelo menos 6 caracteres.'); return s; }
function cookies(req) {
  const o = {}; (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return o;
}
function perfil(u) { return { id: u.id, nome: u.nome, admin: !!u.admin }; }
function caminho(col, id) {
  if (!COLECOES.has(col)) throw new Erro('Coleção desconhecida: ' + col);
  if (!SEG.test(String(id || ''))) throw new Erro('Identificador inválido.');
  return col + '/' + id;
}
function objeto(d) { if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Erro('Os dados precisam ser um objeto.'); return d; }
function mesclar(alvo, novo) {
  for (const k of Object.keys(novo)) {
    const v = novo[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && alvo[k] && typeof alvo[k] === 'object' && !Array.isArray(alvo[k])) mesclar(alvo[k], v);
    else alvo[k] = v;
  }
  return alvo;
}

/* ---------- Sessões ---------- */
function abrirSessao(req, res, u) {
  const t = crypto.randomBytes(32).toString('hex');
  db.sessoes[t] = { uid: u.id, criada: Date.now() }; gravar();
  res.set('Set-Cookie', 'celeiro_sessao=' + t + '; HttpOnly; Path=/; Max-Age=' + (DIAS_SESSAO * 86400) + '; SameSite=Lax' + (req.secure ? '; Secure' : ''));
}
function usuarioDe(req) {
  const t = cookies(req).celeiro_sessao, s = t && db.sessoes[t];
  if (!s) return null;
  if (Date.now() - s.criada > DIAS_SESSAO * 864e5) { delete db.sessoes[t]; gravar(); return null; }
  return db.usuarios.find(u => u.id === s.uid) || null;
}
const tentativas = new Map();
function limitarLogin(req) {
  const ip = req.ip || 'x', t = tentativas.get(ip);
  if (t && t.ate > Date.now() && t.n >= 8) throw new Erro('Muitas tentativas. Espere 15 minutos e tente de novo.', 429);
}
function falhouLogin(req) {
  const ip = req.ip || 'x', t = tentativas.get(ip);
  if (!t || t.ate < Date.now()) tentativas.set(ip, { n: 1, ate: Date.now() + 15 * 60 * 1000 }); else t.n++;
}

/* ---------- Avisos ao vivo (cada aparelho aberto recebe o número da última mudança) ---------- */
const ouvintes = new Set();
function avisar() { const msg = 'data: ' + db.seq + '\n\n'; for (const r of ouvintes) { try { r.write(msg); } catch (e) {} } }
setInterval(() => { for (const r of ouvintes) { try { r.write(': ping\n\n'); } catch (e) {} } }, 25000);
function escrever(p, dados, uid) {
  db.seq++;
  if (dados === null) { delete db.docs[p]; db.apagados[p] = db.seq; }
  else { db.docs[p] = { d: dados, s: db.seq, em: new Date().toISOString(), por: uid }; delete db.apagados[p]; }
  gravar(); avisar();
  return db.seq;
}

/* ---------- Aplicação ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'same-origin'); res.set('X-Frame-Options', 'DENY'); next(); });

const CABECA = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<meta name="theme-color" content="#f7f7f5" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0f0f0e" media="(prefers-color-scheme: dark)">' +
  '<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Celeiro">' +
  '<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icone-192.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">' +
  '<meta name="robots" content="noindex"></head><body>';
function pagina() { return CABECA + fs.readFileSync(path.join(__dirname, 'publico', 'index.html'), 'utf8') + '</body></html>'; }
const PAGINA = pagina();
app.get('/', (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('html').send(PAGINA); });
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').send(JSON.stringify({
  name: 'Celeiro', short_name: 'Celeiro', start_url: '/', display: 'standalone', background_color: '#f7f7f5', theme_color: '#f7f7f5', lang: 'pt-BR',
  icons: [{ src: '/icone-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icone-512.png', sizes: '512x512', type: 'image/png' }, { src: '/icone-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }]
})));
app.use(express.static(path.join(__dirname, 'publico'), { index: false, maxAge: '7d' }));
app.get('/saude', (req, res) => res.type('text').send('ok'));
app.get('/diagnostico', (req, res) => {
  let arq = 'ainda não existe';
  try { const st = fs.statSync(ARQ); arq = (st.size / 1024).toFixed(1) + ' KB, gravado em ' + st.mtime.toISOString(); } catch (e) {}
  let teste = 'ok';
  try { const t = path.join(DADOS, '.teste-escrita'); fs.writeFileSync(t, String(Date.now())); fs.unlinkSync(t); } catch (e) { teste = 'FALHOU: ' + e.message; }
  let backups = [];
  try { backups = fs.readdirSync(BACKUPS).filter(f => f.endsWith('.json')).sort(); } catch (e) {}
  const ok = dadosPersistentes() && teste === 'ok' && !ultimoErroGravar;
  res.set('Cache-Control', 'no-store').type('text').send([
    'Celeiro · diagnóstico dos dados', '',
    ok ? 'RESULTADO: OK. Os dados ficam no disco e sobrevivem às atualizações.' : 'RESULTADO: PROBLEMA. Veja as linhas abaixo.', '',
    'Pasta dos dados ........ ' + DADOS,
    'Volume do Railway ...... ' + (process.env.RAILWAY_VOLUME_MOUNT_PATH || (NO_RAILWAY ? 'NENHUM ligado a este serviço' : 'não está no Railway')),
    'Disco separado do app .. ' + (discoSeparado() ? 'sim' : 'NÃO'),
    'Teste de escrita ....... ' + teste,
    'Última gravação ........ ' + (ultimoErroGravar ? 'ERRO: ' + ultimoErroGravar : ultimaGravacao ? new Date(ultimaGravacao).toISOString() : 'nenhuma desde que o servidor ligou'),
    'Arquivo celeiro.json ... ' + arq,
    'Dados criados em ....... ' + (db.criadoEm || '—'),
    'Contas ................. ' + db.usuarios.length,
    'Registros guardados .... ' + Object.keys(db.docs).length,
    'Leitura de prints ...... ' + (process.env.ANTHROPIC_API_KEY ? 'ligada (' + MODELO + ')' : 'desligada: falta ANTHROPIC_API_KEY'),
    'Cópias de segurança .... ' + (backups.length ? backups.length + ' (última: ' + backups[backups.length - 1] + ')' : 'nenhuma ainda'),
    'Servidor ligado em ..... ' + INICIADO.toISOString()
  ].join('\n'));
});

/* Toda chamada que altera algo precisa do cabeçalho X-Celeiro (bloqueia formulários de outros sites). */
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); if (req.method !== 'GET' && req.get('X-Celeiro') !== '1') return res.status(403).json({ erro: 'Requisição recusada.' }); next(); });
function exigir(req, res, next) { const u = usuarioDe(req); if (!u) return res.status(401).json({ erro: 'Sua sessão terminou. Entre de novo.' }); req.u = u; next(); }
function exigirAdmin(req, res, next) { if (!req.u.admin) return res.status(403).json({ erro: 'Só o administrador pode fazer isso.' }); next(); }
const rota = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => { if (!(e instanceof Erro)) console.error(e); res.status(e.status || 500).json({ erro: e instanceof Erro ? e.message : 'Erro no servidor.' }); });

/* Leitura de prints (antes do leitor de JSON comum, que tem limite menor) */
const FERRAMENTA = {
  name: 'registrar_gastos',
  description: 'Registra os gastos encontrados nos prints.',
  input_schema: {
    type: 'object',
    properties: {
      gastos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            data: { type: 'string', description: 'AAAA-MM-DD' },
            descricao: { type: 'string', description: 'Curta, como aparece no print' },
            valor: { type: 'number', description: 'Valor positivo em reais' },
            forma: { type: 'string', enum: ['credito', 'debito', 'pix', 'boleto', 'dinheiro'] },
            caixinha: { type: ['string', 'null'], description: 'Id da caixinha mais provável, ou null se houver dúvida' },
            duvida: { type: 'string', description: 'Se caixinha for null, uma pergunta curta para o dono; senão vazio' }
          },
          required: ['data', 'descricao', 'valor', 'forma', 'caixinha', 'duvida']
        }
      }
    },
    required: ['gastos']
  }
};
app.post('/api/ler-print', exigir, express.json({ limit: '30mb' }), rota(async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) throw new Erro('A leitura de prints está desligada: falta a chave ANTHROPIC_API_KEY no Railway.');
  const imgs = Array.isArray(req.body.imagens) ? req.body.imagens.slice(0, 14) : [];
  if (!imgs.length) throw new Erro('Nenhuma imagem recebida.');
  const conteudo = imgs.map(i => {
    if (!/^image\/(jpeg|png|webp)$/.test(i.tipo) || typeof i.dados !== 'string') throw new Erro('Formato de imagem não aceito.');
    return { type: 'image', source: { type: 'base64', media_type: i.tipo, data: i.dados } };
  });
  const caixinhas = String(req.body.caixinhas || '').slice(0, 6000);
  conteudo.push({ type: 'text', text:
    'Estas imagens são prints de gastos de uma família brasileira (extrato do banco, app do cartão, nota fiscal ou comprovante). Hoje é ' + hojeNoFuso() + '.\n' +
    'As imagens podem ser pedaços consecutivos de um mesmo print comprido, com uma pequena sobreposição entre um pedaço e o seguinte: não repita o mesmo gasto.\n' +
    'Liste cada gasto visível. Ignore entradas de dinheiro, pagamentos de fatura, estornos e saldos.\n' +
    'Caixinhas disponíveis (id: nome e o que entra nela):\n' + caixinhas + '\n\n' +
    'Para cada gasto: data (se o ano não aparecer, use o mais provável perto de hoje), descrição curta, valor positivo, forma de pagamento (se não der para saber, "credito"), a caixinha mais provável (ou null se não der para ter certeza) e, quando for null, uma pergunta curta em português para o dono responder, como "A compra na farmácia foi fralda ou remédio?".\n' +
    'Registre tudo chamando a ferramenta registrar_gastos uma única vez.' });
  const ctl = new AbortController(); const tempo = setTimeout(() => ctl.abort(), 170000);
  req.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  let r;
  try {
    r = await fetch(process.env.CELEIRO_ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODELO, max_tokens: 8000, tools: [FERRAMENTA], tool_choice: { type: 'tool', name: 'registrar_gastos' }, messages: [{ role: 'user', content: conteudo }] })
    });
  } catch (e) { throw new Erro(ctl.signal.aborted ? 'A leitura demorou demais. Tente com menos prints.' : 'Não consegui falar com o Claude agora. Tente de novo.', 502); }
  finally { clearTimeout(tempo); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('[print] Anthropic respondeu ' + r.status + ': ' + JSON.stringify(j).slice(0, 400));
    if (r.status === 401 || r.status === 403) throw new Erro('A chave ANTHROPIC_API_KEY do Railway foi recusada. Confira a chave.', 502);
    if (r.status === 429) throw new Erro('Muitas leituras seguidas. Espere um pouco e tente de novo.', 429);
    if (r.status === 400 && /credit|billing/i.test(JSON.stringify(j))) throw new Erro('A conta da API da Anthropic está sem crédito.', 502);
    if (r.status === 404) throw new Erro('O modelo ' + MODELO + ' não está disponível nessa chave. Ajuste ANTHROPIC_MODELO no Railway.', 502);
    throw new Erro('O Claude não conseguiu ler o print agora. Tente de novo.', 502);
  }
  const uso = (j.content || []).find(b => b.type === 'tool_use');
  const gastos = uso && uso.input && Array.isArray(uso.input.gastos) ? uso.input.gastos : [];
  res.json({ gastos });
}));

app.use('/api', express.json({ limit: '8mb' }));

/* Conta */
app.get('/api/estado', (req, res) => {
  const u = usuarioDe(req);
  res.json({ primeiroAcesso: db.usuarios.length === 0, logado: !!u, usuario: u ? perfil(u) : null, semDisco: !dadosPersistentes(), vazio: !db.docs['config/geral'], print: !!process.env.ANTHROPIC_API_KEY });
});
app.post('/api/primeiro-acesso', rota((req, res) => {
  if (db.usuarios.length) throw new Erro('O administrador já foi criado. Entre com seu nome e senha.', 403);
  const u = { id: novoId('u'), nome: validarNome(req.body.nome), senha: hashSenha(validarSenha(req.body.senha)), admin: true, criado: new Date().toISOString() };
  db.usuarios.push(u); abrirSessao(req, res, u); gravar();
  res.json({ usuario: perfil(u) });
}));
app.post('/api/entrar', rota((req, res) => {
  limitarLogin(req);
  const u = db.usuarios.find(x => normNome(x.nome) === normNome(req.body.nome));
  if (!u || !senhaConfere(req.body.senha, u.senha)) { falhouLogin(req); throw new Erro('Nome ou senha incorretos.', 401); }
  tentativas.delete(req.ip || 'x');
  abrirSessao(req, res, u);
  res.json({ usuario: perfil(u) });
}));
app.post('/api/sair', (req, res) => {
  const t = cookies(req).celeiro_sessao; if (t && db.sessoes[t]) { delete db.sessoes[t]; gravar(); }
  res.set('Set-Cookie', 'celeiro_sessao=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});
app.post('/api/senha', exigir, rota((req, res) => {
  if (!senhaConfere(req.body.atual, req.u.senha)) throw new Erro('A senha atual não confere.', 403);
  req.u.senha = hashSenha(validarSenha(req.body.nova));
  const atual = cookies(req).celeiro_sessao;
  for (const t in db.sessoes) if (db.sessoes[t].uid === req.u.id && t !== atual) delete db.sessoes[t];
  gravar(); res.json({ ok: true });
}));
app.get('/api/contas', exigir, (req, res) => res.json({ contas: db.usuarios.map(perfil) }));
app.post('/api/contas', exigir, exigirAdmin, rota((req, res) => {
  const nome = validarNome(req.body.nome);
  if (db.usuarios.some(u => normNome(u.nome) === normNome(nome))) throw new Erro('Já existe uma conta com esse nome.');
  db.usuarios.push({ id: novoId('u'), nome, senha: hashSenha(validarSenha(req.body.senha)), admin: !!req.body.admin, criado: new Date().toISOString() });
  gravar(); res.json({ contas: db.usuarios.map(perfil) });
}));
app.post('/api/contas/:id/senha', exigir, exigirAdmin, rota((req, res) => {
  const u = db.usuarios.find(x => x.id === req.params.id); if (!u) throw new Erro('Conta não encontrada.', 404);
  u.senha = hashSenha(validarSenha(req.body.senha));
  for (const t in db.sessoes) if (db.sessoes[t].uid === u.id) delete db.sessoes[t];
  gravar(); res.json({ ok: true });
}));
app.delete('/api/contas/:id', exigir, exigirAdmin, rota((req, res) => {
  if (req.params.id === req.u.id) throw new Erro('Você não pode apagar a sua própria conta.');
  db.usuarios = db.usuarios.filter(u => u.id !== req.params.id);
  for (const t in db.sessoes) if (db.sessoes[t].uid === req.params.id) delete db.sessoes[t];
  gravar(); res.json({ contas: db.usuarios.map(perfil) });
}));

/* Dados */
app.get('/api/dados', exigir, (req, res) => {
  const desde = Math.max(0, parseInt(req.query.desde, 10) || 0);
  const docs = {}, apagados = [];
  for (const p in db.docs) if (!desde || db.docs[p].s > desde) docs[p] = db.docs[p].d;
  if (desde) for (const p in db.apagados) if (db.apagados[p] > desde) apagados.push(p);
  res.json({ seq: db.seq, completo: !desde, docs, apagados });
});
app.get('/api/eventos', exigir, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 4000\n\ndata: ' + db.seq + '\n\n');
  ouvintes.add(res);
  req.on('close', () => ouvintes.delete(res));
});
app.put('/api/doc/:col/:id', exigir, rota((req, res) => {
  const p = caminho(req.params.col, req.params.id);
  res.json({ seq: escrever(p, objeto(req.body.data), req.u.id) });
}));
app.patch('/api/doc/:col/:id', exigir, rota((req, res) => {
  const p = caminho(req.params.col, req.params.id);
  if (!db.docs[p]) throw new Erro('Esse registro não existe mais.', 404);
  const novo = mesclar(JSON.parse(JSON.stringify(db.docs[p].d)), objeto(req.body.data));
  res.json({ seq: escrever(p, novo, req.u.id) });
}));
app.delete('/api/doc/:col/:id', exigir, rota((req, res) => {
  const p = caminho(req.params.col, req.params.id);
  res.json({ seq: db.docs[p] ? escrever(p, null, req.u.id) : db.seq });
}));

/* Cópia dos dados */
app.get('/api/exportar', exigir, (req, res) => {
  const docs = {}; for (const p in db.docs) docs[p] = db.docs[p].d;
  res.set('Content-Disposition', 'attachment; filename="celeiro-dados-' + hojeNoFuso() + '.json"');
  res.type('application/json').send(JSON.stringify({ formato: 'celeiro-exportacao', versao: 1, exportadoEm: new Date().toISOString(), docs }, null, 1));
});
app.post('/api/importar', exigir, exigirAdmin, rota((req, res) => {
  const b = req.body || {};
  if (b.formato !== 'celeiro-exportacao' || !b.docs || typeof b.docs !== 'object') throw new Erro('Esse arquivo não é uma cópia do Celeiro.');
  if (Object.keys(db.docs).length && !b.substituir) throw new Erro('Já existem dados aqui. Confirme que quer substituir tudo.', 409);
  const novos = {};
  for (const p of Object.keys(b.docs)) { const [c, i, extra] = p.split('/'); if (extra !== undefined) throw new Erro('Registro inválido: ' + p); novos[caminho(c, i)] = objeto(b.docs[p]); }
  if (!novos['config/geral']) throw new Erro('O arquivo não traz o orçamento (config/geral).');
  if (Object.keys(db.docs).length) copiaDeSeguranca('antes-da-importacao-' + Date.now() + '.json');
  db.seq++;
  for (const p in db.docs) if (!novos[p]) db.apagados[p] = db.seq;
  db.docs = {};
  const em = new Date().toISOString();
  for (const p in novos) db.docs[p] = { d: novos[p], s: db.seq, em, por: req.u.id };
  gravar(); avisar();
  res.json({ ok: true, registros: Object.keys(novos).length });
}));

/* ---------- Porta do JARVIS: o assistente do Mac consulta o mês e lança gastos sem abrir a tela ----------
 * Liga com a variável JARVIS_TOKEN_SHA256 no Railway: a impressão digital (SHA-256, em hex) da chave que
 * fica só no Mac do JARVIS. Sem ela, nada disto existe. Os cálculos repetem as "Regras de cálculo" da tela.
 * De propósito, não apaga nem altera nada: só lê e lança gasto novo (com desfazer pela tela, como sempre). */
const JARVIS_SHA = String(process.env.JARVIS_TOKEN_SHA256 || '').trim().toLowerCase();
const JARVIS_HASH = /^[0-9a-f]{64}$/.test(JARVIS_SHA) ? Buffer.from(JARVIS_SHA, 'hex') : null;
function exigirJarvis(req, res, next) {
  if (!JARVIS_HASH) return res.status(404).type('text').send('Página não encontrada.');
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (!m || !crypto.timingSafeEqual(crypto.createHash('sha256').update(m[1]).digest(), JARVIS_HASH)) {
    try { limitarLogin(req); } catch (e) { return res.status(429).json({ erro: e.message }); }
    falhouLogin(req);
    return res.status(401).json({ erro: 'Chave do JARVIS inválida.' });
  }
  next();
}
function num(v) {
  if (typeof v === 'number') return v;
  let s = String(v || '').replace(/R\$|\s/g, '');
  if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s); return isFinite(n) ? n : 0;
}
const soma = (l, f) => l.reduce((t, x) => t + f(x), 0);
const ymDe = iso => String(iso).slice(0, 7);
const pad = n => String(n).padStart(2, '0');
function addMes(ym, n) { let [y, m] = ym.split('-').map(Number); m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return y + '-' + pad(m); }
const r2 = v => Math.round(v * 100) / 100;
function colecao(col) { const l = []; for (const p in db.docs) if (p.startsWith(col + '/')) l.push(Object.assign({}, db.docs[p].d, { id: p.slice(col.length + 1) })); return l; }
function estadoCeleiro() {
  const cfg = (db.docs['config/geral'] || {}).d;
  if (!cfg) throw new Erro('O Celeiro ainda não tem orçamento.', 503);
  const lanc = colecao('lancamentos').map(l => Object.assign(l, { valor: num(l.valor) })), movs = colecao('movimentos').map(m => Object.assign(m, { valor: num(m.valor) }));
  const ideal = cfg.modo === 'ideal', valorItem = it => (ideal && it.ideal != null) ? num(it.ideal) : num(it.valor);
  const caixinhas = cfg.caixinhas || [], fundos = cfg.fundos || [];
  const lancDoMes = ym => lanc.filter(l => ymDe(l.data) === ym);
  const depositosNoMes = (f, ym) => soma(movs.filter(m => m.fundo === f && ymDe(m.data) === ym && m.valor > 0), m => m.valor);
  const prevCx = cx => soma(cx.itens || [], valorItem);
  const gastoCx = (cx, ym) => soma(lancDoMes(ym).filter(l => l.caixinha === cx.id), l => l.valor) + soma((cx.itens || []).filter(it => it.paraFundo), it => Math.min(depositosNoMes(it.paraFundo, ym), valorItem(it)));
  const acharCx = id => caixinhas.find(c => c.id === id);
  const fecha = num((cfg.cartao || {}).fecha) || 2, vence = num((cfg.cartao || {}).vence) || 9;
  const venctoDe = iso => { const p = iso.split('-').map(Number), ym = p[0] + '-' + pad(p[1]); return p[2] > fecha ? addMes(ym, 1) : ym; };
  return { cfg, lanc, movs, caixinhas, fundos, lancDoMes, depositosNoMes, prevCx, gastoCx, acharCx, venctoDe, vence, saldoFundo: f => soma(movs.filter(m => m.fundo === f), m => m.valor) };
}
function linhaLanc(l, e) { return { id: l.id, data: l.data, desc: l.desc || '', valor: r2(l.valor), forma: l.forma || '', caixinha: (e.acharCx(l.caixinha) || {}).nome || 'Sem caixinha', por: l.por || '' }; }
function acharCaixinha(e, nome) {
  const n = normNome(nome); if (!n) throw new Erro('Diga a caixinha do gasto.');
  let l = e.caixinhas.filter(c => normNome(c.nome) === n);
  if (!l.length && n.length >= 3) l = e.caixinhas.filter(c => normNome(c.nome).includes(n));
  if (l.length === 1) return l[0];
  throw new Erro(l.length ? 'Caixinha "' + nome + '" é ambígua: ' + l.map(c => c.nome).join(', ') + '.' : 'Caixinha "' + nome + '" não encontrada. Existem: ' + e.caixinhas.map(c => c.nome).join(', ') + '.', l.length ? 409 : 404);
}
const jarvis = express.Router();
jarvis.use(exigirJarvis);
jarvis.get('/contexto', rota((req, res) => {
  const e = estadoCeleiro();
  res.json({ hoje: hojeNoFuso(), modo: e.cfg.modo || 'real', caixinhas: e.caixinhas.map(c => c.nome), reservas: e.fundos.map(f => f.nome), formas: ['credito', 'debito', 'pix', 'boleto', 'dinheiro'] });
}));
jarvis.get('/resumo', rota((req, res) => {
  const e = estadoCeleiro(), hoje = hojeNoFuso(), ym = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : ymDe(hoje);
  const caixinhas = e.caixinhas.map(cx => { const p = e.prevCx(cx), g = e.gastoCx(cx, ym); return { nome: cx.nome, previsto: r2(p), gasto: r2(g), restante: r2(p - g), passou: p > 0 && g > p }; });
  const semCx = soma(e.lancDoMes(ym).filter(l => !e.acharCx(l.caixinha)), l => l.valor);
  const previsto = soma(caixinhas, c => c.previsto), gasto = soma(caixinhas, c => c.gasto) + semCx;
  const ymV = e.venctoDe(hoje), fatura = soma(e.lanc.filter(l => l.forma === 'credito' && e.venctoDe(String(l.data)) === ymV), l => l.valor);
  const reservas = e.fundos.map(f => ({ nome: f.nome, saldo: r2(e.saldoFundo(f.id)), meta: num(f.meta) || null, mensal: num(f.mensal) || null,
    noMes: r2(soma(e.movs.filter(m => m.fundo === f.id && ymDe(m.data) === ym), m => m.valor)), abaixoDoPiso: !!(f.piso && e.saldoFundo(f.id) < num(f.piso)) }));
  const receb = (db.docs['recebimentos/' + ym] || {}).d || { itens: {}, avulsos: [] };
  let fatPrev = 0, fatRec = 0, pendentes = [];
  colecao('clientes').filter(c => c.ativo !== false).forEach(c => {
    const st = (receb.itens || {})[c.id] || 'pendente'; if (st === 'isento') return;
    fatPrev += num(c.valor); if (st === 'recebido') fatRec += num(c.valor); else pendentes.push({ nome: c.nome, valor: r2(num(c.valor)) });
  });
  (receb.avulsos || []).forEach(a => { fatPrev += num(a.valor); if (a.recebido) fatRec += num(a.valor); });
  res.json({ hoje, mes: ym, previsto: r2(previsto), gasto: r2(gasto), restante: r2(previsto - gasto), semCaixinha: r2(semCx),
    caixinhasPassaram: caixinhas.filter(c => c.passou).map(c => c.nome), caixinhas,
    fatura: { vencimento: ymV + '-' + pad(e.vence), valor: r2(fatura) },
    reservas, guardadoNoMes: r2(soma(reservas, f => f.noMes)), metaGuardar: r2(soma(e.fundos, f => num(f.mensal))),
    crown: { previsto: r2(fatPrev), recebido: r2(fatRec), aReceber: pendentes.sort((a, b) => b.valor - a.valor) },
    ultimos: e.lancDoMes(ym).sort((a, b) => String(b.data).localeCompare(String(a.data)) || String(b.criado || '').localeCompare(String(a.criado || ''))).slice(0, 8).map(l => linhaLanc(l, e)) });
}));
jarvis.get('/lancamentos', rota((req, res) => {
  const e = estadoCeleiro(), q = req.query, ym = /^\d{4}-\d{2}$/.test(q.mes || '') ? q.mes : ymDe(hojeNoFuso());
  let l = e.lancDoMes(ym);
  if (q.caixinha) { const cx = acharCaixinha(e, q.caixinha); l = l.filter(x => x.caixinha === cx.id); }
  if (q.busca) { const b = normNome(q.busca); l = l.filter(x => normNome(x.desc).includes(b)); }
  l.sort((a, b) => String(b.data).localeCompare(String(a.data)));
  const limite = Math.max(1, Math.min(300, parseInt(q.limite, 10) || 60));
  res.json({ mes: ym, total: l.length, soma: r2(soma(l, x => x.valor)), lancamentos: l.slice(0, limite).map(x => linhaLanc(x, e)) });
}));
jarvis.post('/lancamentos', rota((req, res) => {
  const e = estadoCeleiro(), b = req.body || {}, valor = num(b.valor);
  if (!(valor > 0) || valor > 1e6) throw new Erro('Valor do gasto inválido.');
  const data = b.data ? String(b.data) : hojeNoFuso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Erro('Data no formato AAAA-MM-DD.');
  const forma = String(b.forma || 'pix');
  if (!['credito', 'debito', 'pix', 'boleto', 'dinheiro'].includes(forma)) throw new Erro('Forma: credito, debito, pix, boleto ou dinheiro.');
  const cx = acharCaixinha(e, b.caixinha), desc = String(b.desc || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140);
  const id = novoId('j'), p = caminho('lancamentos', id);
  escrever(p, { valor, data, desc, caixinha: cx.id, forma, criado: new Date().toISOString(), por: 'JARVIS' }, 'jarvis');
  const ym = ymDe(data), e2 = estadoCeleiro(), cx2 = e2.acharCx(cx.id), prev = e2.prevCx(cx2), gasto = e2.gastoCx(cx2, ym);
  res.json({ ok: true, lancamento: linhaLanc(Object.assign({ id }, db.docs[p].d), e2), caixinha: { nome: cx.nome, previsto: r2(prev), gasto: r2(gasto), restante: r2(prev - gasto) } });
}));
app.use('/api/jarvis', jarvis);

app.use((req, res) => res.status(404).type('text').send('Página não encontrada.'));

app.listen(PORTA, () => {
  console.log('Celeiro rodando na porta ' + PORTA + ' · dados em ' + DADOS + (dadosPersistentes() ? '' : ' (ATENÇÃO: sem disco; os dados somem a cada atualização)') + ' · prints: ' + (process.env.ANTHROPIC_API_KEY ? MODELO : 'desligado'));
});
