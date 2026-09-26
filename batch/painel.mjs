// =====================================================================
// Painel local da verificação do Vivino e das lojas — abre-se pelo
// vinhos.bat. Um servidor pequeno (sem dependências) em 127.0.0.1 que:
//   · corre o vivino-verificar.mjs (Simular / Enriquecer) e mostra o registo;
//   · lista as simulações guardadas numa tabela com caixas, e grava só o
//     que ficou marcado (a opção APLICAR do script — sem voltar a abrir
//     página nenhuma).
//
// Porque um servidor e não só uma página: uma página aberta do disco não
// pode correr o node nem o git. Só escuta em 127.0.0.1, e cada pedido que
// mexe em alguma coisa leva um código que só esta página conhece — outro
// site aberto no mesmo browser não consegue pôr o script a correr.
// =====================================================================
import http from "node:http";
import { spawn, exec } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
// A chave para a lista do catálogo (o script lê-a sozinho, pelo --env-file).
try { if (!process.env.SUPABASE_SERVICE_ROLE_KEY) process.loadEnvFile(path.join(DIR, ".env")); } catch {}
const SB_URL = process.env.SUPABASE_URL || "https://gjweqwfbnkgnibhajldc.supabase.co";
const PORTA = Number(process.env.PAINEL_PORTA || 8787);
const TOKEN = randomBytes(16).toString("hex");

let corrida = null;          // { modo, inicio, linhas: [], fim, codigo }

// O que se procura: tudo · só o Vivino · só os preços das lojas (ver MODO
// no vivino-verificar.mjs). Qualquer outra coisa vale "completo".
function modoPesquisa(x) { return ["completo", "vivino", "precos"].includes(x) ? x : "completo"; }
function correr(modo, opcoes) {
  if (corrida && corrida.fim == null) throw new Error("Já está a correr — espera que acabe.");
  const env = { ...process.env, MANUAL: "true", MOTOR: "browser" };
  delete env.APLICAR; delete env.IDS; delete env.NOVO; delete env.LOJAS; delete env.MODO; delete env.TROCAR_IMAGEM;
  if (modo === "gravar") env.APLICAR = opcoes.ficheiro;
  else if (modo === "novo") {
    // Vinho novo: sempre SIMULAÇÃO — só nasce no catálogo ao gravá-la.
    env.NOVO = JSON.stringify(opcoes.vinhos);
    env.ENSAIO = "true";
    env.MODO = modoPesquisa(opcoes.pesquisa);
  } else {
    env.ENSAIO = modo === "simular" ? "true" : "false";
    env.LIMITE = String(Math.max(1, Math.min(50, Number(opcoes.limite) || 10)));
    // Escolhidos na lista do catálogo: só esses, em vez da fila.
    const ids = (Array.isArray(opcoes.ids) ? opcoes.ids : []).map(x => parseInt(x, 10)).filter(x => x > 0).slice(0, 50);
    if (ids.length) env.IDS = ids.join(",");
    // Escolhidos a olho pela imagem: pode trocar-se também a que não veio do
    // Vivino (nunca a vossa fotografia). Só com escolhidos, nunca na fila.
    if (ids.length && opcoes.trocarImagem === true) env.TROCAR_IMAGEM = "true";
    env.MODO = modoPesquisa(opcoes.pesquisa);
  }
  corrida = { modo, inicio: new Date().toISOString(), linhas: [], fim: null, codigo: null };
  const c = corrida;
  const p = spawn(process.execPath, ["--env-file=.env", "vivino-verificar.mjs"], { cwd: DIR, env });
  const junta = d => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) c.linhas.push(l); };
  p.stdout.on("data", junta);
  p.stderr.on("data", junta);
  p.on("close", code => { c.fim = new Date().toISOString(); c.codigo = code; });
  p.on("error", e => { c.linhas.push("Erro a arrancar: " + e.message); c.fim = new Date().toISOString(); c.codigo = -1; });
}

async function simulacoes() {
  try {
    return (await readdir(path.join(DIR, "simulacoes"))).filter(f => /^simulacao-.*\.json$/.test(f)).sort().reverse();
  } catch { return []; }
}
function nomeSeguro(n) {
  if (!/^simulacao-[\w-]+\.json$/.test(String(n || ""))) throw new Error("Nome de simulação inválido.");
  return path.join(DIR, "simulacoes", n);
}

function lerCorpo(req) {
  return new Promise((ok, falha) => {
    let b = "";
    req.on("data", d => { b += d; if (b.length > 5e6) req.destroy(); });
    req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { falha(e); } });
  });
}
function json(res, cod, obj) {
  res.writeHead(cod, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORTA}`);
    // Só daqui: um pedido vindo de outro site traz outro Host/Origin.
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || "")) return json(res, 403, { erro: "host" });
    if (req.method === "POST") {
      if (req.headers["x-painel"] !== TOKEN) return json(res, 403, { erro: "código do painel inválido — recarrega a página" });
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(PAGINA.replace("__TOKEN__", TOKEN));
    }
    if (req.method === "GET" && url.pathname === "/estado") {
      const desde = Number(url.searchParams.get("desde") || 0);
      return json(res, 200, corrida ? { ...corrida, linhas: corrida.linhas.slice(desde), total: corrida.linhas.length } : null);
    }
    if (req.method === "GET" && url.pathname === "/catalogo") {
      // Também com o código: é a lista do catálogo, não um ficheiro nosso.
      if (req.headers["x-painel"] !== TOKEN) return json(res, 403, { erro: "código do painel inválido — recarrega a página" });
      const r = await fetch(`${SB_URL}/rest/v1/rpc/vivino_catalogo`, { method: "POST", body: "{}", headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY || "", Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY || ""}`,
        "Content-Type": "application/json", "Content-Profile": "winecatalog", "Accept-Profile": "winecatalog" } });
      const tx = await r.text();
      if (!r.ok) return json(res, 502, { erro: `Supabase ${r.status}: ${tx.slice(0, 200)}` });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(tx);
    }
    if (req.method === "GET" && url.pathname === "/simulacoes") return json(res, 200, await simulacoes());
    if (req.method === "GET" && url.pathname === "/simulacao") {
      return json(res, 200, JSON.parse(await readFile(nomeSeguro(url.searchParams.get("nome")), "utf8")));
    }
    if (req.method === "POST" && url.pathname === "/correr") {
      const b = await lerCorpo(req);
      if (!["simular", "enriquecer"].includes(b.modo)) return json(res, 400, { erro: "modo" });
      correr(b.modo, b);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/novo") {
      const b = await lerCorpo(req);
      const CORES = ["Tinto", "Branco", "Rosé", "Espumante", "Licoroso", "Frisante"];
      const vinhos = (Array.isArray(b.vinhos) ? b.vinhos : []).slice(0, 20).map(x => ({
        nome: String(x.nome || "").trim().slice(0, 150), produtor: String(x.produtor || "").trim().slice(0, 150),
        ano: /^\d{4}$/.test(String(x.ano || "")) ? +x.ano : null, tipo: CORES.includes(x.tipo) ? x.tipo : null,
        // Os links colados: só endereços http(s), até 6. Qual é de que sítio
        // decide-o o script (linksDoVinho).
        links: (String(x.links || "").match(/https?:\/\/[^\s,;<>"']+/gi) || []).slice(0, 6).map(u => u.slice(0, 500)),
      })).filter(x => x.nome);
      if (!vinhos.length) return json(res, 400, { erro: "Escreve pelo menos um nome." });
      if (vinhos.some(x => !x.tipo)) return json(res, 400, { erro: "Escolhe a cor de cada vinho — é ela que separa o tinto do branco com o mesmo nome." });
      correr("novo", { vinhos, pesquisa: b.pesquisa });
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/gravar") {
      // As caixas desmarcadas passam a "aplicar": false no próprio ficheiro —
      // fica escrito o que se decidiu — e o script grava o resto.
      const b = await lerCorpo(req);
      const fich = nomeSeguro(b.nome);
      const sim = JSON.parse(await readFile(fich, "utf8"));
      const escolhas = b.escolhas || {};
      for (const [i, pl] of (sim.vinhos || []).entries()) {
        const e = escolhas[i] || {};
        pl.alteracoes = (pl.alteracoes || []).map((a, j) => ({ ...a, aplicar: e.campos ? e.campos[j] !== false : a.aplicar !== false }));
        pl.aplicar = e.vinho !== false;
      }
      sim.revista = new Date().toISOString();
      await writeFile(fich, JSON.stringify(sim, null, 2), "utf8");
      correr("gravar", { ficheiro: path.join("simulacoes", path.basename(fich)) });
      return json(res, 200, { ok: true });
    }
    json(res, 404, { erro: "não existe" });
  } catch (e) {
    json(res, 500, { erro: String(e.message || e) });
  }
});

servidor.listen(PORTA, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORTA}/`;
  console.log(`Painel em ${url} — deixa esta janela aberta enquanto o usas (fecha-a para parar).`);
  const abrir = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  if (process.env.PAINEL_SEM_BROWSER !== "1") exec(abrir, () => {});
});
servidor.on("error", e => {
  console.error(e.code === "EADDRINUSE"
    ? `A porta ${PORTA} está ocupada — o painel já está aberto noutra janela? Abre http://127.0.0.1:${PORTA}/`
    : e.message);
  process.exit(1);
});

// ── A página ──────────────────────────────────────────────────────────
const PAGINA = `<!doctype html>
<html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vinhos — Vivino e lojas</title>
<style>
:root{--bd:#6b1a2e;--bd2:#8a2640;--ou:#b98b2e;--bg:#f6f1ea;--card:#fffdfb;--bo:#e6ddd2;--tx:#2b2220;--mu:#8a7d74;--ok:#2f7a4b;--er:#b3261e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{background:var(--bd);color:#fff;padding:14px 20px}header h1{margin:0;font:600 18px Georgia,serif}header p{margin:2px 0 0;opacity:.8;font-size:12.5px}
main{max-width:1100px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--bo);border-radius:12px;padding:16px;margin-bottom:14px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
h2{margin:0 0 10px;font:600 16px Georgia,serif;color:var(--bd)}
.linha{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
label{font-size:13px}#cat-lista table td,#cat-lista table th{padding:5px 8px;vertical-align:middle}
.mini{width:44px;text-align:center}.mini img{width:40px;height:54px;object-fit:contain;display:block;margin:0 auto;background:#faf7f4;border-radius:4px}
.mini .sem{display:flex;align-items:center;justify-content:center;width:40px;height:54px;margin:0 auto;border:1px dashed var(--bo);border-radius:4px;color:var(--mu);font-size:11px}
.mini small{display:block;font-size:10px;color:var(--mu);margin-top:2px}.mini small.v{color:var(--er)}
.prc{font-size:11.5px;line-height:1.35;white-space:nowrap;color:var(--mu)}.prc a{color:inherit;text-decoration:none}.prc a:hover{text-decoration:underline}
.prc .l{display:inline-block;width:78px}.prc .n{color:#bbb}.prc .med{color:var(--bd);font-weight:700}.prc .med .l:after{content:" ★"}.prc .out{color:var(--bd);font-weight:700}#cat-lista tr.sel td{background:#f6ecef}.ic{font-size:12px;color:var(--mu);white-space:nowrap}
#novos input,#novos select{width:100%;padding:6px 8px;border:1px solid var(--bo);border-radius:8px;font:inherit}#novos td{border:0;padding:3px}
input[type=number]{width:80px;padding:6px 8px;border:1px solid var(--bo);border-radius:8px;font:inherit}
select{padding:6px 8px;border:1px solid var(--bo);border-radius:8px;font:inherit;max-width:100%}
button{font:600 13px system-ui;border-radius:9px;padding:8px 14px;border:1px solid var(--bo);background:#fff;cursor:pointer}
button.prim{background:var(--bd);border-color:var(--bd);color:#fff}button.prim:hover{background:var(--bd2)}
button:disabled{opacity:.5;cursor:default}
.nota{color:var(--mu);font-size:12.5px;margin:6px 0 0}
pre{background:#1f1a19;color:#eee;border-radius:10px;padding:12px;max-height:340px;overflow:auto;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;margin:0}
.estado{font-size:12.5px;margin-bottom:8px}.estado b.ok{color:var(--ok)}.estado b.er{color:var(--er)}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--mu);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.3px;padding:6px;border-bottom:1px solid var(--bo)}
td{padding:6px;border-bottom:1px solid var(--bo);vertical-align:top;word-break:break-word}
tr.vinho td{background:#faf5ef;font-weight:600}tr.vinho.off td,tr.alt.off td,tr.alt.dim td{opacity:.45}
.antes{color:var(--mu);text-decoration:line-through}.seta{color:var(--mu);padding:0 4px}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;background:#f1e7d6;color:#7a5a17;font-weight:600}
a{color:var(--bd)}
</style></head><body>
<header><h1>🍷 Vinhos — Vivino e lojas</h1><p>O script corre neste computador. Esta página só funciona enquanto a janela do vinhos.bat estiver aberta.</p></header>
<main>
<div class="card"><h2>Correr</h2>
  <div class="linha">
    <label>Vinhos: <input type="number" id="limite" min="1" max="50" value="10"></label>
    <label>Procurar: <select id="pesquisa">
      <option value="completo">Tudo — Vivino e lojas (a ficha toda)</option>
      <option value="vivino">Só o Vivino — link, nota, avaliações, imagem</option>
      <option value="precos">Só preços (e imagem) — Garrafeira Nacional → Granvine → Vinha.pt</option>
    </select></label>
    <button class="prim" onclick="correr('simular')">Simular</button>
    <button onclick="correr('enriquecer')">Enriquecer (grava já)</button>
  </div>
  <p class="nota"><b>Simular</b> lê tudo e guarda uma simulação para reveres em baixo — não grava nada. <b>Enriquecer</b> grava logo no catálogo (tudo fica no histórico da app, com "Repor").
  Trata primeiro os vinhos pedidos na ficha ("🍷 Verificar no Vivino") e depois os que nunca foram verificados.</p>
</div>
<div class="card"><h2>Escolher no catálogo</h2>
  <p class="nota" style="margin:0 0 10px">Marca os vinhos que queres tratar (até 50) e corre só esses — em vez da fila.</p>
  <div class="linha"><input id="cat-q" placeholder="procurar por nome, produtor, região…" oninput="pintarCatalogo()" style="flex:1;min-width:200px;padding:7px 10px;border:1px solid var(--bo);border-radius:8px;font:inherit">
    <label>Imagem: <select id="cat-img" onchange="pintarCatalogo()"><option value="">todas</option><option value="sem">sem imagem</option><option value="vivino">do Vivino</option><option value="loja">de uma loja</option><option value="outro">de outro site</option><option value="nossa">fotografia vossa</option></select></label>
    <label><input type="checkbox" id="cat-sempreco" onchange="pintarCatalogo()"> sem preço</label>
    <label><input type="checkbox" id="cat-nunca" onchange="pintarCatalogo()"> nunca verificados</label>
    <label title="Sem o número do vinho (/w/nº) — p. ex. /wines/nº, que é uma colheita, ou /Wines/nome, que não existe"><input type="checkbox" id="cat-link" onchange="pintarCatalogo()"> link do Vivino suspeito</label></div>
  <div id="cat-lista" style="max-height:560px;overflow:auto;margin-top:10px;border:1px solid var(--bo);border-radius:10px"><p class="nota" style="padding:10px">A carregar…</p></div>
  <div class="linha" style="margin-top:10px"><span id="cat-n" class="nota">0 escolhidos</span>
    <button onclick="catMarcarVisiveis()">Marcar os que se veem</button><button onclick="catLimpar()">Limpar</button>
    <label title="Normalmente só se troca uma imagem que veio do Vivino. Ligado, os escolhidos ficam com a imagem da primeira loja que os tenha (ou do Vivino), seja qual for a que têm agora — menos a vossa fotografia."><input type="checkbox" id="cat-trocar"> trocar a imagem destes, venha de onde vier</label>
    <button class="prim" onclick="correrEscolhidos('simular')">Simular escolhidos</button>
    <button onclick="correrEscolhidos('enriquecer')">Enriquecer escolhidos</button></div>
</div>
<div class="card"><h2>Vinho novo</h2>
  <p class="nota" style="margin:0 0 10px">Um vinho que ainda não está no catálogo. O script procura-o no Vivino e nas lojas (nota, preço, castas, região, teor, harmonização…) e faz uma <b>simulação</b>: o vinho só é criado quando a gravares, em baixo. Se já existir, enriquece o que lá está.</p>
  <table id="novos"><tr><th>Nome *</th><th>Produtor</th><th>Ano</th><th>Cor *</th><th title="Vivino, Garrafeira Nacional, Granvine ou Vinha.pt — separados por espaço. O script abre-os diretamente, em vez de procurar.">Links (opcional)</th><th></th></tr></table>
  <div class="linha" style="margin-top:10px"><button onclick="novaLinha()">+ outro vinho</button>
    <button class="prim" id="btn-novo" onclick="procurarNovos()">Procurar (simular)</button></div>
</div>
<div class="card"><h2>Registo</h2><div class="estado" id="estado">Nada a correr.</div><pre id="log"></pre></div>
<div class="card"><h2>Simulações</h2>
  <div class="linha"><select id="sims" onchange="abrirSim()"></select><button onclick="listarSims()">🔄</button>
    <button class="prim" id="btn-gravar" onclick="gravar()" disabled>Gravar selecionados</button></div>
  <p class="nota">Desmarca o que não queres gravar — um vinho inteiro ou só um campo. Desmarcar um link novo do Vivino desmarca também a nota e as avaliações lidas nessa página. Ao gravar, fica no ficheiro o que decidiste.</p>
  <div id="tabela"></div>
</div>
</main>
<script>
const TOKEN="__TOKEN__";let visto=0,timer=null,sim=null,simNome=null;
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function post(u,b){const r=await fetch(u,{method:"POST",headers:{"Content-Type":"application/json","X-Painel":TOKEN},body:JSON.stringify(b)});const j=await r.json();if(!r.ok)throw new Error(j.erro||r.status);return j;}
let CAT=[];const ESC=new Set();
async function carregarCatalogo(){
  try{const r=await fetch("/catalogo",{headers:{"X-Painel":TOKEN}});const j=await r.json();if(!r.ok)throw new Error(j.erro||r.status);CAT=j;pintarCatalogo();}
  catch(e){document.getElementById("cat-lista").innerHTML='<p class="nota" style="padding:10px">Não consegui ler o catálogo: '+esc(e.message)+'</p>';}
}
const semAc=t=>String(t||"").normalize("NFD").replace(/[\\u0300-\\u036f]/g,"").toLowerCase();
function catVisiveis(){
  const q=semAc(document.getElementById("cat-q").value).split(/\\s+/).filter(Boolean);
  const im=document.getElementById("cat-img").value,sp=document.getElementById("cat-sempreco").checked,nv=document.getElementById("cat-nunca").checked,lk=document.getElementById("cat-link").checked;
  return CAT.filter(v=>{const t=semAc([v.nome,v.produtor,v.regiao,v.ano,v.tipo].join(" "));
    return q.every(p=>t.includes(p))&&(!im||(im==="sem"?!v.imagem_url:v.imagem_de===im))&&(!sp||!v.preco)&&(!nv||!v.visto)&&(!lk||v.link==="invalido");});
}
function semImg(el){el.outerHTML='<span class="sem" title="a imagem não abre">✕</span>';}
// Os preços de cada sítio, pela ordem da prioridade; o que é o preço médio
// vai a negrito com ★. Se o preço médio veio de outro sítio (uma garrafeira,
// uma pesquisa, reposto à mão), aparece numa linha à parte a dizer de onde.
const LOJAS_P=[["garrafeira_nacional","GN","loja-garrafeira-nacional"],["granvine","Granvine","loja-granvine"],["vinha","Vinha.pt","loja-vinha"],["vivino","Vivino","vivino-pagina"]];
const eur=n=>(Math.round(Number(n)*100)/100).toFixed(2).replace(".",",")+" €";
function precosHTML(v){
  const ps=v.precos&&typeof v.precos==="object"?v.precos:{};
  const origem=String(v.origem_preco||"");
  let usada=false;
  const linhas=LOJAS_P.map(([k,rot,o])=>{
    const p=ps[k];
    if(!p||p.preco==null)return '<div class="n"><span class="l">'+rot+'</span>—</div>';
    const med=origem===o||(k==="vivino"&&/^vivino-/.test(origem));
    if(med)usada=true;
    const tit=[p.nome,p.colheita?"colheita "+p.colheita:"",p.em?"lido a "+p.em:""].filter(Boolean).join(" · ");
    const val=p.url?'<a href="'+esc(p.url)+'" target="_blank" rel="noopener noreferrer" title="'+esc(tit)+'">'+eur(p.preco)+'</a>':'<span title="'+esc(tit)+'">'+eur(p.preco)+'</span>';
    return '<div class="'+(med?"med":"")+'"><span class="l">'+rot+'</span>'+val+(p.colheita&&v.ano&&Number(p.colheita)!==Number(v.ano)?' <span title="outra colheita">('+esc(p.colheita)+')</span>':'')+'</div>';
  });
  if(v.preco_medio!=null&&!usada)linhas.push('<div class="out" title="o preço médio veio daqui"><span class="l">médio</span>'+eur(v.preco_medio)+' <span style="font-weight:400">('+esc(origem||"?")+')</span></div>');
  return '<div class="prc">'+linhas.join("")+'</div>';
}
const IMG_DE={vivino:"Vivino",loja:"loja",nossa:"vossa",outro:"outro site"};
function miniatura(v){
  if(!v.imagem_url)return '<span class="sem">sem</span><small>&nbsp;</small>';
  const u=esc(v.imagem_url);
  return '<a href="'+u+'" target="_blank" rel="noopener noreferrer" title="'+u+'"><img src="'+u+'" loading="lazy" referrerpolicy="no-referrer" alt="" onerror="semImg(this)"></a>'+
    '<small class="'+(v.imagem_de==="vivino"?"v":"")+'">'+esc(IMG_DE[v.imagem_de]||"")+'</small>';
}
function pintarCatalogo(){
  const l=catVisiveis();
  const linhas=l.slice(0,400).map(v=>'<tr class="'+(ESC.has(v.id)?"sel":"")+'"><td><input type="checkbox" '+(ESC.has(v.id)?"checked":"")+' onchange="catMarca('+v.id+',this)"></td>'+
    '<td class="mini">'+miniatura(v)+'</td>'+
    '<td><b>'+esc(v.nome)+'</b>'+(v.ano?" "+esc(v.ano):"")+'<br><span class="nota">'+esc([v.produtor,v.tipo,v.regiao].filter(Boolean).join(" · "))+'</span></td>'+
    '<td>'+precosHTML(v)+'</td>'+
    '<td class="ic">'+(v.link==="invalido"?'<b title="link do Vivino suspeito" style="color:var(--er)">V?</b>':v.vivino?"V":"")+'</td>'+
    '<td class="ic">'+(v.visto?"visto "+esc(String(v.visto).slice(0,10)):"nunca visto")+'</td></tr>');
  document.getElementById("cat-lista").innerHTML=l.length?'<table>'+linhas.join("")+'</table>'+(l.length>400?'<p class="nota" style="padding:8px">…e mais '+(l.length-400)+' — afina a procura.</p>':''):'<p class="nota" style="padding:10px">Nenhum vinho com estes filtros.</p>';
  catContar();
}
function catMarca(id,el){if(el.checked){if(ESC.size>=50){el.checked=false;return alert("Até 50 de cada vez.");}ESC.add(id);}else ESC.delete(id);el.closest("tr").classList.toggle("sel",el.checked);catContar();}
function catMarcarVisiveis(){for(const v of catVisiveis()){if(ESC.size>=50)break;ESC.add(v.id);}pintarCatalogo();}
function catLimpar(){ESC.clear();pintarCatalogo();}
function catContar(){document.getElementById("cat-n").textContent=ESC.size+" escolhido"+(ESC.size===1?"":"s");}
async function correrEscolhidos(modo){
  if(!ESC.size)return alert("Marca pelo menos um vinho.");
  if(modo==="enriquecer"&&!confirm("Gravar já no catálogo os "+ESC.size+" escolhidos, sem simular primeiro?"))return;
  try{await post("/correr",{modo,ids:[...ESC],limite:ESC.size,pesquisa:document.getElementById("pesquisa").value,trocarImagem:document.getElementById("cat-trocar").checked});comecar();}catch(e){alert(e.message);}
}
async function correr(modo){
  if(modo==="enriquecer"&&!confirm("Gravar já no catálogo, sem simular primeiro?"))return;
  try{await post("/correr",{modo,limite:+document.getElementById("limite").value,pesquisa:document.getElementById("pesquisa").value});comecar();}
  catch(e){alert(e.message);}
}
function comecar(){visto=0;document.getElementById("log").textContent="";clearInterval(timer);timer=setInterval(seguir,1000);seguir();}
async function seguir(){
  const r=await fetch("/estado?desde="+visto).then(r=>r.json()).catch(()=>null);
  if(!r)return;
  const log=document.getElementById("log");
  if(r.linhas.length){log.textContent+=r.linhas.join("\\n")+"\\n";log.scrollTop=log.scrollHeight;}
  visto=r.total;
  const nomes={simular:"Simulação",enriquecer:"Enriquecer",gravar:"Gravar simulação",novo:"Vinho novo (simulação)"};
  document.getElementById("estado").innerHTML=r.fim==null?"⏳ "+nomes[r.modo]+" a correr…"
    :(r.codigo===0?'<b class="ok">✓ '+nomes[r.modo]+' terminou.</b>':'<b class="er">✗ '+nomes[r.modo]+' terminou com erro ('+r.codigo+').</b>');
  document.querySelectorAll("button").forEach(b=>{if(b.textContent.match(/Simular|Enriquecer|Procurar/))b.disabled=r.fim==null;});
  if(r.fim!=null){clearInterval(timer);timer=null;carregarCatalogo();if(r.modo!=="enriquecer")listarSims(r.modo==="simular"||r.modo==="novo");}
}
async function listarSims(abrirPrimeira){
  const l=await fetch("/simulacoes").then(r=>r.json());const s=document.getElementById("sims");
  const atual=abrirPrimeira?l[0]:(s.value||l[0]);
  s.innerHTML=l.length?l.map(n=>'<option'+(n===atual?' selected':'')+'>'+esc(n)+'</option>').join(""):'<option value="">(ainda não há simulações)</option>';
  abrirSim();
}
function valor(c,x){
  if(x==null)return"<i>vazio</i>";
  if(Array.isArray(x))return esc(x.join(", "));
  if(typeof x==="object")return Object.entries(x).map(([k,o])=>esc(k.replace("_"," "))+" "+(o&&o.url?'<a href="'+esc(o.url)+'" target="_blank">'+esc(o.preco)+" €</a>":esc(o&&o.preco))+(o&&o.colheita?" ("+esc(o.colheita)+")":"")).join("<br>");
  const t=String(x);return /^https?:/.test(t)?'<a href="'+esc(t)+'" target="_blank">'+esc(t.replace(/^https?:\\/\\/(www\\.)?/,""))+'</a>':esc(t)+(c==="preco_medio"?" €":"");
}
async function abrirSim(){
  const n=document.getElementById("sims").value;const t=document.getElementById("tabela");
  if(!n){t.innerHTML="";document.getElementById("btn-gravar").disabled=true;return;}
  sim=await fetch("/simulacao?nome="+encodeURIComponent(n)).then(r=>r.json());simNome=n;
  const rows=[];
  (sim.vinhos||[]).forEach((v,i)=>{
    rows.push('<tr class="vinho'+(v.aplicar===false?' off':'')+'" id="v'+i+'"><td><input type="checkbox" data-v="'+i+'"'+(v.aplicar!==false?" checked":"")+' onchange="marca(this)"></td><td colspan="3">'+(v.id?"#"+esc(v.id):'<span class="tag">novo</span>')+" "+esc(v.nome)+(v.produtor&&!v.id?' <span class="nota">· '+esc(v.produtor)+'</span>':"")+(v.ano?" "+esc(v.ano):"")+' <span class="tag">'+esc(v.estado)+'</span>'+(v.pagina?' <span class="nota">página: “'+esc(v.pagina)+'”</span>':"")+(!(v.alteracoes||[]).length?' <span class="nota">'+(v.id?"— nada a mudar; só regista a verificação":"— não se encontrou nada: é criado só com o que escreveste")+'</span>':"")+'</td></tr>');
    (v.alteracoes||[]).forEach((a,j)=>rows.push('<tr class="alt'+(a.aplicar===false?' off':'')+'"><td style="padding-left:22px"><input type="checkbox" data-v="'+i+'" data-c="'+j+'" data-campo="'+esc(a.campo)+'" data-o="'+esc(a.origem)+'"'+(a.aplicar!==false?" checked":"")+' onchange="marca(this)"></td><td>'+esc(a.campo)+'</td><td><span class="antes">'+valor(a.campo,a.antes)+'</span><span class="seta">→</span>'+valor(a.campo,a.depois)+'</td><td class="nota">'+esc(a.origem)+'</td></tr>'));
  });
  t.innerHTML=rows.length?'<table><tr><th></th><th>Campo</th><th>Antes → depois</th><th>Origem</th></tr>'+rows.join("")+'</table>':'<p class="nota">Simulação vazia.</p>';
  document.getElementById("btn-gravar").disabled=!rows.length||!!sim.revista;
  if(sim.revista)t.insertAdjacentHTML("afterbegin",'<p class="nota">Esta simulação já foi gravada ('+esc(sim.revista)+').</p>');
}
function marca(el){el.closest("tr").classList.toggle("off",!el.checked);
  if(el.dataset.c==null)document.querySelectorAll('input[data-v="'+el.dataset.v+'"][data-c]').forEach(c=>{c.disabled=!el.checked;c.closest("tr").classList.toggle("dim",!el.checked);});
  // Sem o link novo, o que se leu na página dele também não entra (o script faz o mesmo).
  if(el.dataset.campo==="vivino_url")document.querySelectorAll('input[data-v="'+el.dataset.v+'"][data-o^="vivino-"]').forEach(c=>{
    if(c!==el){c.checked=el.checked;c.disabled=!el.checked;c.closest("tr").classList.toggle("off",!el.checked);}});}
async function gravar(){
  const escolhas={};
  document.querySelectorAll("#tabela input[type=checkbox]").forEach(c=>{const i=c.dataset.v;escolhas[i]=escolhas[i]||{campos:{}};
    if(c.dataset.c==null)escolhas[i].vinho=c.checked;else escolhas[i].campos[c.dataset.c]=c.checked;});
  const n=Object.values(escolhas).filter(e=>e.vinho!==false).length;
  if(!confirm("Gravar "+n+" vinho(s) desta simulação no catálogo?"))return;
  try{await post("/gravar",{nome:simNome,escolhas});comecar();}catch(e){alert(e.message);}
}
const CORES=["Tinto","Branco","Rosé","Espumante","Licoroso","Frisante"];
function novaLinha(){
  const tr=document.createElement("tr");
  tr.innerHTML='<td><input class="n-nome" placeholder="ex.: Quinta do Crasto Reserva Vinhas Velhas"></td><td><input class="n-prod"></td>'+
    '<td style="width:80px"><input class="n-ano" inputmode="numeric" maxlength="4"></td>'+
    '<td style="width:130px"><select class="n-cor"><option value="">— cor —</option>'+CORES.map(c=>"<option>"+c+"</option>").join("")+'</select></td>'+
    '<td><input class="n-links" placeholder="cola aqui o link do Vivino, da loja…"></td>'+
    '<td style="width:30px"><button title="Tirar" onclick="this.closest(\\'tr\\').remove()">✕</button></td>';
  document.getElementById("novos").appendChild(tr);
}
async function procurarNovos(){
  const vinhos=[...document.querySelectorAll("#novos tr")].slice(1).map(tr=>({
    nome:tr.querySelector(".n-nome").value.trim(),produtor:tr.querySelector(".n-prod").value.trim(),
    ano:tr.querySelector(".n-ano").value.trim(),tipo:tr.querySelector(".n-cor").value,
    links:tr.querySelector(".n-links").value.trim()})).filter(x=>x.nome);
  if(!vinhos.length)return alert("Escreve pelo menos um nome.");
  if(vinhos.some(x=>!x.tipo))return alert("Escolhe a cor de cada vinho.");
  if(vinhos.some(x=>x.ano&&!/^\\d{4}$/.test(x.ano)))return alert("O ano tem quatro algarismos (ou fica vazio).");
  try{await post("/novo",{vinhos,pesquisa:document.getElementById("pesquisa").value});comecar();}catch(e){alert(e.message);}
}
novaLinha();
carregarCatalogo();
listarSims();fetch("/estado").then(r=>r.json()).then(r=>{if(r&&r.fim==null)comecar();});
</script></body></html>`;
