// =====================================================================
// Painel local da verificação do Vivino e das lojas — abre-se pelo
// vinhos.bat. Um servidor pequeno (sem dependências) em 127.0.0.1 que:
//   · corre o vivino-verificar.mjs (Simular / Enriquecer) sobre os vinhos
//     escolhidos na lista do catálogo e mostra o registo;
//   · lista as simulações guardadas numa tabela com caixas, e grava só o
//     que ficou marcado (a opção APLICAR do script — sem voltar a abrir
//     página nenhuma);
//   · e, em separadores à parte, os Nomes de vinhos, os Produtores, os
//     Duplicados e o que as garrafeiras escrevem (Comentários · Sugestões).
//
// Porque um servidor e não só uma página: uma página aberta do disco não
// pode correr o node nem o git. Só escuta em 127.0.0.1, e cada pedido que
// mexe em alguma coisa leva um código que só esta página conhece — outro
// site aberto no mesmo browser não consegue pôr o script a correr.
// =====================================================================
import http from "node:http";
import { spawn, exec } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compararComAgora } from "./vivino-verificar.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
// A chave para a lista do catálogo (o script lê-a sozinho, pelo --env-file).
try { if (!process.env.SUPABASE_SERVICE_ROLE_KEY) process.loadEnvFile(path.join(DIR, ".env")); } catch {}
const SB_URL = process.env.SUPABASE_URL || "https://gjweqwfbnkgnibhajldc.supabase.co";
const PORTA = Number(process.env.PAINEL_PORTA || 8787);
const TOKEN = randomBytes(16).toString("hex");

let corrida = null;          // { modo, inicio, linhas: [], fim, codigo, progresso, aParar, parado }
// O "Parar" (27/09/2026): o painel cria este ficheiro e o script vê-o entre
// dois vinhos (PARAR no vivino-verificar.mjs). Apaga-se antes de cada corrida.
const PARAR = path.join(DIR, ".parar");

// O que se lê: tudo · só os preços das lojas (ver MODO no
// vivino-verificar.mjs; o "vivino" ainda se aceita). Outra coisa vale "completo".
function modoPesquisa(x) { return ["completo", "vivino", "precos"].includes(x) ? x : "completo"; }
// ONDE se procura (SITES no script; 27/09/2026, pedido do dono: por omissão
// todos, com um visto por sítio para procurar só em alguns).
const SITIOS = ["vivino", "garrafeira_nacional", "granvine", "vinha"];
function sitiosDe(opcoes) {
  if (!Array.isArray(opcoes.sitios)) return SITIOS.join(",");
  const l = SITIOS.filter(x => opcoes.sitios.includes(x));
  if (!l.length) throw new Error("Marca pelo menos um sítio onde procurar.");
  if (modoPesquisa(opcoes.pesquisa) === "precos" && !l.some(x => x !== "vivino"))
    throw new Error("«Só preços» procura nas lojas (não abre o Vivino) — marca pelo menos uma loja.");
  return l.join(",");
}
function correr(modo, opcoes) {
  if (corrida && corrida.fim == null) throw new Error("Já está a correr — espera que acabe.");
  const env = { ...process.env, MANUAL: "true", MOTOR: "browser" };
  delete env.APLICAR; delete env.IDS; delete env.NOVO; delete env.LOJAS; delete env.MODO; delete env.SITES; delete env.TROCAR_IMAGEM; delete env.PARAR;
  // Os sítios validam-se antes de tudo: um erro aqui não deixa nada a meio.
  const sites = modo === "gravar" ? null : sitiosDe(opcoes);
  rmSync(PARAR, { force: true });
  // Gravar uma simulação é curto e não se interrompe: ficava meia gravada.
  if (modo !== "gravar") env.PARAR = PARAR;
  if (modo === "gravar") env.APLICAR = opcoes.ficheiro;
  else if (modo === "novo") {
    // Vinho novo: sempre SIMULAÇÃO — só nasce no catálogo ao gravá-la.
    env.NOVO = JSON.stringify(opcoes.vinhos);
    env.ENSAIO = "true";
    env.MODO = modoPesquisa(opcoes.pesquisa);
    env.SITES = sites;
  } else {
    // Sempre os vinhos escolhidos na lista (por critério ou ao acaso, até 50).
    // A fila às cegas (`vivino_a_tratar`) saiu do painel a 27/09/2026 — fica
    // para o GitHub Actions e para o `npm run vivino`; aqui, os pedidos da
    // app são um filtro da lista.
    const ids = (Array.isArray(opcoes.ids) ? opcoes.ids : []).map(x => parseInt(x, 10)).filter(x => x > 0).slice(0, 50);
    if (!ids.length) throw new Error("Escolhe primeiro os vinhos.");
    env.ENSAIO = modo === "simular" ? "true" : "false";
    env.IDS = ids.join(",");
    env.LIMITE = String(ids.length);
    // Escolhidos a olho pela imagem: pode trocar-se também a que não veio do
    // Vivino (nunca a vossa fotografia).
    if (opcoes.trocarImagem === true) env.TROCAR_IMAGEM = "true";
    env.MODO = modoPesquisa(opcoes.pesquisa);
    env.SITES = sites;
  }
  corrida = { modo, inicio: new Date().toISOString(), linhas: [], fim: null, codigo: null,
              progresso: null, aParar: false, parado: false, podeParar: modo !== "gravar" };
  const c = corrida;
  const p = spawn(process.execPath, ["--env-file=.env", "vivino-verificar.mjs"], { cwd: DIR, env });
  // O progresso sai das linhas "[3/20] #17 Cartuxa…" que o script escreve
  // antes de cada vinho; a barra e o tempo que falta calculam-se na página.
  const junta = d => {
    for (const l of String(d).split(/\r?\n/)) {
      if (!l.trim()) continue;
      c.linhas.push(l);
      const m = l.match(/^\[(\d+)\/(\d+)\] (.*)$/);
      if (m) c.progresso = { i: +m[1], n: +m[2], nome: m[3], em: new Date().toISOString() };
      if (/^Parado a pedido/.test(l)) c.parado = true;
    }
  };
  p.stdout.on("data", junta);
  p.stderr.on("data", junta);
  p.on("close", code => { c.fim = new Date().toISOString(); c.codigo = code; try { rmSync(PARAR, { force: true }); } catch {} });
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
// O erro de uma função: a mensagem dela (um RAISE EXCEPTION diz o que
// fazer — "junta-as no ecrã de Duplicados"), e só sem ela o texto cru.
function erroSupabase(status, tx) {
  try { const j = JSON.parse(tx); if (j && j.message) return j.message; } catch {}
  return `Supabase ${status}: ${String(tx).slice(0, 200)}`;
}
// Uma função do Supabase com a chave do batch; a resposta passa tal qual.
async function sbRpc(res, schema, fn, corpo) {
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(corpo), headers: {
    apikey: chave, Authorization: `Bearer ${chave}`,
    "Content-Type": "application/json", "Content-Profile": schema, "Accept-Profile": schema } });
  const tx = await r.text();
  if (!r.ok) return json(res, 502, { erro: erroSupabase(r.status, tx) });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  return res.end(tx);
}
async function sbDados(schema, fn, corpo) {
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(corpo), headers: {
    apikey: chave, Authorization: `Bearer ${chave}`,
    "Content-Type": "application/json", "Content-Profile": schema, "Accept-Profile": schema } });
  const tx = await r.text();
  if (!r.ok) throw new Error(erroSupabase(r.status, tx));
  return tx ? JSON.parse(tx) : null;
}
// Uma simulação por gravar é comparada com a BD de AGORA: o admin pode ter
// corrigido um vinho à mão depois de simular. Cada alteração leva `agora` e
// `desde` (igual · mudou · ja — ver `compararComAgora`). Só na resposta: o
// ficheiro fica como a simulação o escreveu.
async function comAgora(sim) {
  if (sim.revista) return sim;
  const ids = [...new Set((sim.vinhos || []).map(v => Number(v.id)).filter(n => Number.isInteger(n) && n > 0))];
  try {
    const fichas = {};
    for (let i = 0; i < ids.length; i += 50)
      for (const l of (await sbDados("winecatalog", "vivino_estes", { p_ids: ids.slice(i, i + 50) })) || [])
        fichas[l.id] = l.ficha || {};
    for (const v of sim.vinhos || []) if (v.id && fichas[v.id]) compararComAgora(v, fichas[v.id]);
  } catch (e) {
    sim.agora_erro = String(e.message || e);
  }
  return sim;
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
      return sbRpc(res, "winecatalog", "vivino_catalogo", {});
    }
    if (req.method === "POST" && url.pathname === "/garrafeiras") {
      // Os links do Vivino nas garrafeiras: sem `aplicar` é só a lista; com
      // ele, só os ids escolhidos — e a função volta a conferir as regras.
      const b = await lerCorpo(req);
      const aplicar = b.aplicar === true;
      const inteiros = a => Array.isArray(a) ? a.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 500) : [];
      // `forcar`: os "Por confirmar" que o admin abriu e aceitou — o visto é
      // a confirmação. Vão também em `p_ids`, que é o que a função percorre.
      const forcar = inteiros(b.forcar);
      const ids = [...new Set([...inteiros(b.ids), ...forcar])];
      if (aplicar && !ids.length) return json(res, 400, { erro: "Marca pelo menos um vinho." });
      return sbRpc(res, "garrafeira", "links_vivino_rever",
        { p_ids: aplicar ? ids : null, p_aplicar: aplicar, p_forcar: aplicar && forcar.length ? forcar : null });
    }
    if (req.method === "POST" && url.pathname === "/fichas") {
      // A ficha das garrafeiras × catálogo: sem `aplicar` é só a lista; com
      // ele, os campos marcados de cada vinho (a função volta a conferir).
      const b = await lerCorpo(req);
      const aplicar = b.aplicar === true;
      const itens = Array.isArray(b.itens) ? b.itens.slice(0, 500).map(x => ({
        vinho_id: Number(x.vinho_id),
        campos: (Array.isArray(x.campos) ? x.campos : []).map(String).filter(c => /^[a-z_]{2,30}$/.test(c)).slice(0, 30),
      })).filter(x => Number.isInteger(x.vinho_id) && x.vinho_id > 0 && x.campos.length) : [];
      if (aplicar && !itens.length) return json(res, 400, { erro: "Marca pelo menos um campo." });
      return sbRpc(res, "garrafeira", "fichas_catalogo_rever", { p_itens: aplicar ? itens : null, p_aplicar: aplicar });
    }
    if (req.method === "POST" && url.pathname === "/produtores") {
      // Os produtores oficiais (db/produtores.sql): a lista com as sugestões,
      // confirmar um oficial com as suas grafias, "são diferentes", tirar
      // uma grafia. Quem decide é sempre o admin; as funções voltam a conferir.
      const b = await lerCorpo(req);
      const txt = (x, n = 200) => String(x ?? "").trim().slice(0, n);
      if (b.acao === "listar") {
        const [sugestoes, oficiais, grafias, noNome] = await Promise.all([
          sbDados("winecatalog", "produtores_sugestoes", {}),
          sbDados("winecatalog", "produtores_listar", {}),
          // as grafias que existem, para escolher as que se acrescentam a um oficial
          sbDados("winecatalog", "produtores_grafias_lista", {}),
          // os produtores que ficam (e entram) no nome dos vinhos (db/nomes-manter.sql)
          sbDados("winecatalog", "produtores_no_nome_listar", {}),
        ]);
        return json(res, 200, { sugestoes, oficiais, grafias, noNome });
      }
      // o produtor no nome dos vinhos: ligar (pelo nome) ou desligar (pela chave)
      if (b.acao === "no_nome") {
        if (b.ligar === true) {
          if (!txt(b.produtor)) return json(res, 400, { erro: "Falta o produtor." });
          return sbRpc(res, "winecatalog", "produtores_no_nome_marcar", { p_itens: [{ produtor: txt(b.produtor) }] });
        }
        return sbRpc(res, "winecatalog", "produtores_no_nome_tirar", { p_chave: txt(b.chave, 300) });
      }
      // mudar o nome oficial (o antigo fica como grafia; db/produtores.sql)
      if (b.acao === "renomear") {
        if (!txt(b.nome)) return json(res, 400, { erro: "Falta o nome oficial." });
        return sbRpc(res, "winecatalog", "produtor_renomear", { p_id: Number(b.id) || 0, p_nome: txt(b.nome) });
      }
      if (b.acao === "definir") {
        const grafias = (Array.isArray(b.grafias) ? b.grafias : []).map(g => txt(g)).filter(Boolean).slice(0, 30);
        if (!txt(b.oficial)) return json(res, 400, { erro: "Falta o nome oficial." });
        return sbRpc(res, "winecatalog", "produtor_definir", { p_oficial: txt(b.oficial), p_grafias: grafias });
      }
      if (b.acao === "diferentes") return sbRpc(res, "winecatalog", "produtores_diferentes", { p_a: txt(b.a), p_b: txt(b.b) });
      if (b.acao === "tirar") return sbRpc(res, "winecatalog", "produtor_tirar_variante", { p_chave: txt(b.chave) });
      // o nome por extenso ao lado do oficial (só para se ler na ficha)
      if (b.acao === "completo") return sbRpc(res, "winecatalog", "produtor_nome_completo", { p_id: Number(b.id) || 0, p_nome_completo: txt(b.completo) });
      return json(res, 400, { erro: "acao" });
    }
    if (req.method === "POST" && url.pathname === "/duplicados") {
      // Os vinhos parecidos (db/parecidos.sql): uma letra de diferença, em
      // qualquer colheita, e os pares da mesma colheita dos Duplicados da app.
      // "É este" é a `corresponde` (funde, ou passa a ser outra colheita do
      // mesmo vinho); "nenhum destes" grava os pares como diferentes.
      const b = await lerCorpo(req);
      const id = Number(b.id) || 0;
      if (b.acao === "listar") return sbRpc(res, "winecatalog", "parecidos", { p_limite: 80 });
      if (b.acao === "corresponde")
        return sbRpc(res, "winecatalog", "corresponde", { p_id: id, p_alvo: Number(b.alvo) || 0, p_quem: "painel do PC (admin)" });
      if (b.acao === "nao") {
        const outros = (Array.isArray(b.outros) ? b.outros : []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 50);
        if (!outros.length) return json(res, 400, { erro: "Nenhum par." });
        return sbRpc(res, "winecatalog", "nao_correspondem", { p_id: id, p_outros: outros, p_quem: "painel do PC (admin)" });
      }
      return json(res, 400, { erro: "acao" });
    }
    if (req.method === "POST" && url.pathname === "/comentarios") {
      // Os comentários sobre vinhos e as sugestões das garrafeiras
      // (db/comentarios.sql): a lista de um tipo, os números dos dois
      // separadores, e fechar/reabrir com a resposta que a pessoa lê.
      const b = await lerCorpo(req);
      const tipo = b.tipo === "sugestao" ? "sugestao" : "vinho";
      const ESTADOS = ["aberto", "duvida", "resolvido", "rejeitado"];
      if (b.acao === "contar") return sbRpc(res, "winecatalog", "contar_comentarios", {});
      if (b.acao === "listar")
        return sbRpc(res, "winecatalog", "listar_comentarios",
          { p_tipo: tipo, p_estado: [...ESTADOS, "todos"].includes(b.estado) ? b.estado : "aberto" });
      if (b.acao === "responder") {
        // "duvida" é uma pergunta a quem escreveu (a vez passa para ele) —
        // a função recusa-a sem texto. O push sai do gatilho na base.
        if (!ESTADOS.includes(b.estado)) return json(res, 400, { erro: "estado" });
        return sbRpc(res, "winecatalog", "responder_comentario", { p_id: Number(b.id) || 0, p_estado: b.estado,
          p_resposta: String(b.resposta ?? "").trim().slice(0, 1000) || null, p_quem: "painel do PC (admin)" });
      }
      return json(res, 400, { erro: "acao" });
    }
    if (req.method === "POST" && url.pathname === "/nomes") {
      // A regra do nome (db/nomes-normalizar.sql): sem `aplicar` é a simulação
      // de tudo; com ele, só os itens escolhidos (a função recalcula a regra).
      const b = await lerCorpo(req);
      // Os produtores que ficam no nome dos seus vinhos (db/nomes-manter.sql).
      if (b.acao === "listar") return sbRpc(res, "winecatalog", "produtores_no_nome_listar", {});
      if (b.acao === "tirar") return sbRpc(res, "winecatalog", "produtores_no_nome_tirar", { p_chave: String(b.chave ?? "").trim().slice(0, 300) });
      if (b.acao === "manter") {
        const its = (Array.isArray(b.itens) ? b.itens : []).slice(0, 200)
          .map(x => ({ fonte: x.fonte === "garrafeira" ? "garrafeira" : "catalogo", id: Number(x.id) }))
          .filter(x => Number.isInteger(x.id) && x.id > 0);
        return sbRpc(res, "winecatalog", "produtores_no_nome_marcar", { p_itens: its });
      }
      const aplicar = b.aplicar === true;
      const itens = (Array.isArray(b.itens) ? b.itens : []).slice(0, 1000)
        .map(x => ({ fonte: x.fonte === "garrafeira" ? "garrafeira" : "catalogo", id: Number(x.id) }))
        .filter(x => Number.isInteger(x.id) && x.id > 0);
      if (aplicar && !itens.length) return json(res, 400, { erro: "Marca pelo menos um vinho." });
      // `produtor`: só os vinhos desse produtor (o separador Produtores, ao
      // pôr ou tirar um produtor do nome dos vinhos).
      const produtor = String(b.produtor ?? "").trim().slice(0, 200) || null;
      return sbRpc(res, "winecatalog", "nomes_rever", { p_itens: aplicar ? itens : null, p_aplicar: aplicar, p_produtor: produtor });
    }
    if (req.method === "POST" && url.pathname === "/vinho") {
      // O back-office (db/painel.sql): a ficha de um vinho, e corrigi-la à
      // mão pela MESMA `editar` da app (força 4 no rótulo, 3 na nota/preço/
      // imagem; a trava da identidade; o histórico com "painel do PC").
      const b = await lerCorpo(req);
      const id = Number(b.id);
      if (!Number.isInteger(id) || id <= 0) return json(res, 400, { erro: "Vinho inválido." });
      if (b.acao === "ver") return sbRpc(res, "winecatalog", "painel_vinho", { p_id: id });
      if (b.acao === "editar") {
        const campos = b.campos && typeof b.campos === "object" && !Array.isArray(b.campos) ? b.campos : {};
        const ks = Object.keys(campos);
        if (ks.length > 40 || ks.some(k => !/^[a-z][a-z0-9_]{0,39}$/.test(k)) || JSON.stringify(campos).length > 60000)
          return json(res, 400, { erro: "Campos inválidos." });
        const ident = b.identidade === true;
        if (!ks.length && !ident) return json(res, 400, { erro: "Nada mudou." });
        const txt = (x, n) => x == null ? null : String(x).trim().slice(0, n);
        return sbRpc(res, "winecatalog", "painel_editar", { p_id: id, p_campos: campos,
          p_nome: ident ? txt(b.nome, 200) : null, p_produtor: ident ? txt(b.produtor, 200) : null,
          p_ano: ident && /^\d{4}$/.test(String(b.ano ?? "")) ? Number(b.ano) : null,
          p_mexer_identidade: ident, p_quem: "painel do PC (admin)" });
      }
      return json(res, 400, { erro: "acao" });
    }
    if (req.method === "GET" && url.pathname === "/simulacoes") return json(res, 200, await simulacoes());
    if (req.method === "GET" && url.pathname === "/simulacao") {
      return json(res, 200, await comAgora(JSON.parse(await readFile(nomeSeguro(url.searchParams.get("nome")), "utf8"))));
    }
    if (req.method === "POST" && url.pathname === "/correr") {
      const b = await lerCorpo(req);
      if (!["simular", "enriquecer"].includes(b.modo)) return json(res, 400, { erro: "modo" });
      correr(b.modo, b);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/parar") {
      // Não mata o processo: pede-lhe que pare no fim do vinho que está a
      // tratar. Numa simulação, fica gravada com os que já foram tratados;
      // num Enriquecer, esses já estão no catálogo.
      if (!corrida || corrida.fim != null) return json(res, 400, { erro: "Não está nada a correr." });
      if (!corrida.podeParar) return json(res, 400, { erro: "Gravar uma simulação não se interrompe." });
      await writeFile(PARAR, new Date().toISOString(), "utf8");
      corrida.aParar = true;
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
      correr("novo", { vinhos, pesquisa: b.pesquisa, sitios: b.sitios });
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
// Três separadores (27/09/2026, pedido do dono): **Informação de vinhos**
// (a escolha dos vinhos a enriquecer ou corrigir, o registo, as simulações,
// o vinho novo e as garrafeiras × o catálogo) · **Nomes de vinhos** ·
// **Produtores**. Antes era uma página corrida, e a escolha dos vinhos vivia
// em dois cartões com os seus Simular/Enriquecer cada um — o "Correr N
// vinhos" (a fila, que o script escolhia sozinho) e o "Escolher no
// catálogo". Agora é UM menu: os filtros são o critério, e marca-se à mão,
// todos os que passam, ou N ao acaso entre eles; corre só o que está marcado.
const PAGINA = `<!doctype html>
<html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vinhos — painel</title>
<style>
:root{--bd:#6b1a2e;--bd2:#8a2640;--ou:#b98b2e;--bg:#f6f1ea;--card:#fffdfb;--bo:#e6ddd2;--tx:#2b2220;--mu:#8a7d74;--ok:#2f7a4b;--er:#b3261e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{background:var(--bd);color:#fff;padding:14px 20px 8px}header h1{margin:0;font:600 18px Georgia,serif}header p{margin:2px 0 0;opacity:.8;font-size:12.5px}
nav.tabs{position:sticky;top:0;z-index:5;background:var(--bd);display:flex;gap:2px;padding:0 12px;overflow-x:auto;box-shadow:0 2px 4px rgba(0,0,0,.15)}
nav.tabs button{background:none;border:0;border-bottom:3px solid transparent;border-radius:0;color:#fff;opacity:.72;padding:10px 14px;font:600 14px system-ui;white-space:nowrap}
nav.tabs button:hover{opacity:1}nav.tabs button.on{opacity:1;border-bottom-color:var(--ou)}
.tab[hidden]{display:none}
main{max-width:1100px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--bo);border-radius:12px;padding:16px;margin-bottom:14px;box-shadow:0 1px 2px rgba(0,0,0,.04);scroll-margin-top:52px}
h2{margin:0 0 10px;font:600 16px Georgia,serif;color:var(--bd)}
.seccao{margin:24px 0 8px;font:600 12px system-ui;text-transform:uppercase;letter-spacing:.5px;color:var(--mu)}
.linha{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.linha>label{max-width:100%}
.passo{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:16px 0 8px;font-weight:600;color:var(--bd)}
.passo .num{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--bd);color:#fff;font-size:12px}
.passo .nota{font-weight:400;margin:0}
.filtros{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
.filtros input[type=search]{flex:1 1 240px;min-width:200px;padding:7px 10px;border:1px solid var(--bo);border-radius:8px;font:inherit}
.filtros label{display:flex;align-items:center;gap:6px;color:var(--mu);font-size:12.5px}
select.ativo{border-color:var(--bd);background:#f6ecef;color:var(--bd);font-weight:600}
.ou{color:var(--mu);font-size:12.5px}.conta{font-weight:600}
.correr{background:#faf5ef;border:1px solid var(--bo);border-radius:10px;padding:10px 12px}
.sitios{gap:6px 14px}.sitios .rot{font-weight:600;color:var(--bd)}.sitios label.off{opacity:.45}.sitios a{font-size:12px}
label{font-size:13px}#cat-lista table td,#cat-lista table th{padding:5px 8px;vertical-align:middle}
.mini{width:44px;text-align:center}.mini img{width:40px;height:54px;object-fit:contain;display:block;margin:0 auto;background:#faf7f4;border-radius:4px}
.mini .sem{display:flex;align-items:center;justify-content:center;width:40px;height:54px;margin:0 auto;border:1px dashed var(--bo);border-radius:4px;color:var(--mu);font-size:11px}
.mini small{display:block;font-size:10px;color:var(--mu);margin-top:2px}.mini small.v{color:var(--er)}
.prc{font-size:11.5px;line-height:1.35;white-space:nowrap;color:var(--mu)}.prc a{color:inherit;text-decoration:none}.prc a:hover{text-decoration:underline}
.prc .l{display:inline-block;width:78px}.prc .n{color:#bbb}.prc .med{color:var(--bd);font-weight:700}.prc .med .l:after{content:" ★"}.prc .out{color:var(--bd);font-weight:700}#cat-lista tr.sel td{background:#f6ecef}.ic{font-size:12px;color:var(--mu);white-space:nowrap}.ic.datas div{line-height:1.35}.ic.datas .ord{color:var(--bd);font-weight:700}.ic.datas .por{font-size:11px;max-width:170px;overflow:hidden;text-overflow:ellipsis;margin:-1px 0 2px}
#novos input,#novos select{width:100%;padding:6px 8px;border:1px solid var(--bo);border-radius:8px;font:inherit}#novos td{border:0;padding:3px}
input[type=number]{width:80px;padding:6px 8px;border:1px solid var(--bo);border-radius:8px;font:inherit}
select{padding:6px 8px;border:1px solid var(--bo);border-radius:8px;font:inherit;max-width:100%}
button{font:600 13px system-ui;border-radius:9px;padding:8px 14px;border:1px solid var(--bo);background:#fff;cursor:pointer}
button.prim{background:var(--bd);border-color:var(--bd);color:#fff}button.prim:hover{background:var(--bd2)}
button:disabled{opacity:.5;cursor:default}
.nota{color:var(--mu);font-size:12.5px;margin:6px 0 0}
pre{background:#1f1a19;color:#eee;border-radius:10px;padding:12px;max-height:340px;overflow:auto;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;margin:0}
.estado{font-size:12.5px;margin-bottom:8px}.estado b.ok{color:var(--ok)}.estado b.er{color:var(--er)}
.prog{margin:0 0 10px}.prog[hidden]{display:none}
.prog-barra{height:8px;background:var(--bo);border-radius:6px;overflow:hidden;margin-bottom:6px}
.prog-barra>div{height:100%;width:0;background:var(--bd);transition:width .4s}
.prog .linha{justify-content:space-between}.prog .nota{margin:0}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--mu);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.3px;padding:6px;border-bottom:1px solid var(--bo)}
td{padding:6px;border-bottom:1px solid var(--bo);vertical-align:top;word-break:break-word}
tr.vinho td{background:#faf5ef;font-weight:600}tr.vinho.off td,tr.alt.off td,tr.alt.dim td,tr.off td{opacity:.45}
.antes{color:var(--mu);text-decoration:line-through}.seta{color:var(--mu);padding:0 4px}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;background:#f1e7d6;color:#7a5a17;font-weight:600}.tag.mudou{background:#f6dcdc;color:#8a1f2d}
a{color:var(--bd)}
a.nm{color:inherit;text-decoration:none}a.nm:hover b{text-decoration:underline;color:var(--bd)}
body.com-modal{overflow:hidden}
.modal{position:fixed;inset:0;z-index:20;background:rgba(35,20,24,.5);display:flex;justify-content:center;align-items:flex-start;padding:28px 12px;overflow:auto}
.modal[hidden]{display:none}
.modal .caixa{background:var(--card);border-radius:14px;width:100%;max-width:980px;box-shadow:0 12px 40px rgba(0,0,0,.3);overflow:hidden}
.modal .topo{background:var(--bd);color:#fff;padding:16px 18px;display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.modal .topo .garrafa{width:72px;height:104px;flex:none;background:#fff;border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden;color:var(--mu);font-size:11px;text-align:center}
.modal .topo .garrafa img{width:100%;height:100%;object-fit:contain}
.modal .topo .tit{flex:1 1 280px;min-width:0}
.modal .topo h3{margin:2px 0;font:600 20px Georgia,serif}.modal .topo .cor{font-style:italic;font-weight:400;opacity:.85;font-size:15px}
.modal .topo .sub{opacity:.85;font-size:13px}.modal .topo a{color:#fff}
.modal .topo .acoes{display:flex;gap:8px;flex-wrap:wrap}
.modal .topo button{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.35);color:#fff}
.modal .topo button.prim{background:var(--ou);border-color:var(--ou)}
.modal .corpo{padding:4px 18px 18px}
.modal h4{margin:18px 0 6px;font:600 12.5px system-ui;text-transform:uppercase;letter-spacing:.4px;color:var(--bd)}
.ficha td{padding:6px 8px;vertical-align:middle}.ficha td.k{color:var(--mu);width:210px}.ficha td.de{width:250px}
.ficha input[type=text],.ficha select,.ficha textarea,.ident input[type=text]{width:100%;padding:6px 8px;border:1px solid var(--bo);border-radius:8px;font:inherit}
.og{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;background:#eee;color:#666;white-space:nowrap}
.og.f4,.og.f3{background:#f1e7d6;color:#7a5a17}.og.f2{background:#f6ecef;color:var(--bd)}
.lista{margin:0;padding-left:18px}.lista li{margin:3px 0}.lista label.ret{font-size:12px;color:var(--er)}
.hist td{font-size:12.5px}
.aviso{background:#fff7e6;border:1px solid #f0d9a8;border-radius:10px;padding:8px 10px;font-size:12.5px;margin:12px 0}
.dup-g{border:1px solid var(--bo);border-radius:10px;padding:8px 10px;margin-bottom:8px}.dup-g table td{border:0;padding:4px 6px}
#mv-mesmo-q{padding:4px 8px;border:1px solid var(--bo);border-radius:6px;font:inherit}
.seg{display:inline-flex;flex-wrap:wrap;gap:2px;background:#efe7dd;border-radius:10px;padding:3px;max-width:100%}
.seg button{border:0;background:none;border-radius:8px;padding:7px 12px;color:var(--mu)}
.seg button.on{background:#fff;color:var(--bd);box-shadow:0 1px 2px rgba(0,0,0,.12)}
.seg .n{display:inline-block;min-width:18px;padding:0 6px;margin-left:4px;border-radius:99px;background:rgba(0,0,0,.07);font-size:11.5px;text-align:center}
.seg button.on .n{background:#f6ecef}
.prod-v[hidden]{display:none}
.msg{display:flex;gap:10px;align-items:flex-start;border-radius:10px;padding:9px 12px;margin:10px 0;font-size:13px;background:#eef6f0;border:1px solid #cfe5d6}
.msg.er{background:#fbeeee;border-color:#f0cccc}.msg.av{background:#fff7e6;border-color:#f0d9a8}
.msg>div{flex:1;min-width:0}.msg ul{margin:4px 0 0;padding-left:18px}.msg a.fecha{color:var(--mu);text-decoration:none;font-size:15px;line-height:1}
.pg{border:1px solid var(--bo);border-radius:12px;padding:10px 12px;margin-bottom:10px;background:#fff}
.pg-tit{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-weight:600;color:var(--bd);margin-bottom:4px}
.pg table td,.pg table th{border:0;padding:4px 8px;vertical-align:middle}.pg table tr+tr td{border-top:1px solid #f1ebe4}
.pg .c{text-align:center;width:84px}.pg input[type=text]{width:100%;padding:5px 8px;border:1px solid var(--bo);border-radius:8px;font:inherit}
.pg .rod{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px;padding-top:8px;border-top:1px dashed var(--bo)}
.po{border:1px solid var(--bo);border-radius:12px;background:#fff;margin-bottom:8px;overflow:hidden}
.po-cab{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;padding:10px 12px 6px}
.po-nome{flex:1 1 220px;min-width:0}.po-nome b{font:600 15.5px Georgia,serif}.po-nome i{display:block;color:var(--mu);font-size:12.5px}
.po-n{color:var(--mu);font-size:12.5px;white-space:nowrap}
.nn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--bo);border-radius:99px;padding:4px 10px;font-size:12.5px;color:var(--mu);cursor:pointer;user-select:none}
.nn.on{border-color:var(--bd);background:#f6ecef;color:var(--bd);font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:4px 12px 10px}
.chip{display:inline-flex;flex-wrap:wrap;align-items:center;gap:2px;max-width:100%;border:1px solid var(--bo);border-radius:14px;padding:2px 10px;font-size:12.5px;background:#faf7f4}
.chip.x{padding-right:3px}.chip.of{border-color:var(--ou);background:#fbf4e4}.chip.of:before{content:"★";color:var(--ou);margin-right:4px;font-size:11px}
.eq{color:var(--mu);font-size:11px;margin:0 5px}
.chip a{display:inline-flex;width:18px;height:18px;margin-left:4px;align-items:center;justify-content:center;border-radius:50%;text-decoration:none;color:var(--mu);font-size:11px}
.chip a:hover{background:#f6dcdc;color:var(--er)}
button.mais{border-style:dashed;border-radius:99px;padding:3px 10px;font-size:12.5px;font-weight:600;color:var(--bd);background:none}
.chips input[type=text]{padding:4px 8px;border:1px solid var(--bo);border-radius:8px;font:inherit;flex:0 1 240px;min-width:0}
.po-edit{border-top:1px solid var(--bo);padding:10px 12px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px 10px;align-items:center;background:#faf5ef}
.po-edit input{padding:6px 8px;border:1px solid var(--bo);border-radius:8px;font:inherit;width:100%}.po-edit .rot{color:var(--mu);font-size:12.5px}
.po-edit .nota{grid-column:1/-1;margin:0}
.po-res{border-top:1px solid var(--bo);padding:0 12px}.po-res .msg{margin:10px 0}
.prev{max-height:360px;overflow:auto;border:1px solid var(--bo);border-radius:10px;margin:8px 0;background:#fff}
.prev td{border-bottom:1px solid #f1ebe4;padding:5px 8px;vertical-align:middle}
.nn-l{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;border:1px solid var(--bo);border-radius:10px;padding:8px 12px;margin-bottom:6px;background:#fff}
.nn-l b{flex:1 1 200px;min-width:0}
.com-texto{white-space:pre-wrap;word-break:break-word;margin:8px 0 4px}
.com-resp{flex:1 1 260px;padding:6px 8px;border:1px solid var(--bo);border-radius:8px;font:inherit}
.com-fio{display:flex;flex-direction:column;gap:5px;margin:8px 0}.com-fala{padding:6px 9px;border-radius:8px;background:#f3eee8;white-space:pre-wrap;word-break:break-word}
.com-fala.adm{background:#f6ecef}.com-fala b{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.3px;color:var(--mu)}.com-fala.adm b{color:var(--bd)}
.ident{border:1px dashed var(--bo);border-radius:10px;padding:8px 10px}.ident .linha label{flex:1 1 200px;display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--mu)}
</style></head><body>
<header><h1>🍷 Vinhos — painel</h1><p>O script corre neste computador. Esta página só funciona enquanto a janela do vinhos.bat estiver aberta.</p></header>
<nav class="tabs" role="tablist">
  <button role="tab" data-tab="info" onclick="abrirTab('info')">Informação de vinhos<span id="tab-corre"></span></button>
  <button role="tab" data-tab="nomes" onclick="abrirTab('nomes')">Nomes de vinhos</button>
  <button role="tab" data-tab="produtores" onclick="abrirTab('produtores')">Produtores</button>
  <button role="tab" data-tab="duplicados" onclick="abrirTab('duplicados')" title="Vinhos que parecem o mesmo">Duplicados<span id="tab-dup"></span></button>
  <button role="tab" data-tab="comentarios" onclick="abrirTab('comentarios')" title="O que as garrafeiras dizem de um vinho">Comentários<span id="tab-com-vinho"></span></button>
  <button role="tab" data-tab="sugestoes" onclick="abrirTab('sugestoes')" title="Ideias e problemas da app, escritos na Garrafeira">Sugestões<span id="tab-com-sugestao"></span></button>
</nav>
<main>
<section class="tab" id="t-info">
<div class="card" id="c-escolher"><h2>Escolher os vinhos a enriquecer ou corrigir</h2>
  <p class="nota" style="margin:0">Carrega no <b>nome</b> de um vinho para ver a ficha inteira e corrigir à mão. Um menu só: os <b>filtros</b> dizem de onde se escolhe (sem filtros, o catálogo todo); depois ordenas a lista e marcas <b>à mão</b>, <b>os primeiros</b> pela ordem (os alterados há mais tempo, os criados há menos…), <b>alguns ao acaso</b>, ou <b>todos</b> os que passam. Corre só o que estiver marcado — até 50 de cada vez.</p>
  <div class="passo"><span class="num">1</span>Critério <span class="nota" id="cat-passam"></span></div>
  <div class="filtros"><input type="search" id="cat-q" placeholder="procurar por nome, produtor, região, cor, ano, quem criou…" oninput="pintarCatalogo()">
    <span id="cat-filtros" class="filtros"></span>
    <button onclick="catLimparFiltros()">Limpar filtros</button></div>
  <div class="passo"><span class="num">2</span>Escolha</div>
  <div class="linha"><label>Ordenar por <select id="cat-ordem" onchange="catOrdem()"></select></label></div>
  <div class="linha" style="margin-top:8px"><label>Quantos <input type="number" id="cat-quantos" min="1" max="50" value="10"></label>
    <button onclick="catPrimeiros()" title="Os primeiros da lista, pela ordem escolhida em cima — troca a escolha de agora">⬆ Os primeiros</button>
    <span class="ou">ou</span>
    <button onclick="catSortear()" title="Troca a escolha de agora por estes">🎲 Ao acaso</button>
    <span class="ou">entre os que passam, ou</span>
    <button onclick="catMarcarVisiveis()">Marcar todos os que passam</button></div>
  <div class="linha" style="margin-top:8px"><span id="cat-n" class="conta">0 escolhidos</span>
    <label><input type="checkbox" id="cat-so" onchange="pintarCatalogo()"> ver só os escolhidos</label>
    <button onclick="catLimpar()">Limpar a escolha</button></div>
  <div id="cat-lista" style="max-height:560px;overflow:auto;margin-top:10px;border:1px solid var(--bo);border-radius:10px"><p class="nota" style="padding:10px">A carregar…</p></div>
  <div class="passo"><span class="num">3</span>Correr <span class="nota" id="cat-n2"></span></div>
  <div class="correr">
    <div class="linha sitios" id="cat-sitios"></div>
    <div class="linha" style="margin-top:8px"><label>Ler: <select id="pesquisa" onchange="sitiosSincronizar('cat')">
      <option value="completo">Tudo — a ficha toda</option>
      <option value="precos">Só preços (e imagem) — pára na 1.ª loja que o tenha</option>
    </select></label>
    <label title="Normalmente só se troca uma imagem que veio do Vivino. Ligado, os escolhidos ficam com a imagem da primeira loja que os tenha (ou do Vivino), seja qual for a que têm agora — menos a vossa fotografia."><input type="checkbox" id="cat-trocar"> trocar a imagem destes, venha de onde vier</label>
    <button class="prim corre" onclick="correrEscolhidos('simular')">Simular</button>
    <button class="corre" onclick="correrEscolhidos('enriquecer')">Enriquecer (grava já)</button></div></div>
  <p class="nota"><b>Simular</b> lê tudo e guarda uma simulação para reveres em baixo — não grava nada. <b>Enriquecer</b> grava logo no catálogo (tudo fica no histórico da app, com "Repor").</p>
</div>
<div class="card" id="c-registo"><h2>Registo</h2><div class="estado" id="estado">Nada a correr.</div>
  <div class="prog" id="prog" hidden><div class="prog-barra"><div id="prog-b"></div></div>
    <div class="linha"><span class="nota" id="prog-t"></span>
      <button id="btn-parar" onclick="parar()" title="Pára no fim do vinho que está a tratar. Numa simulação, fica guardada com os que já foram tratados; no Enriquecer, esses já estão gravados.">⏹ Parar</button></div></div>
  <pre id="log"></pre></div>
<div class="card"><h2>Simulações</h2>
  <div class="linha"><select id="sims" onchange="abrirSim()"></select><button onclick="listarSims()">🔄</button>
    <button class="prim" id="btn-gravar" onclick="gravar()" disabled>Gravar selecionados</button></div>
  <p class="nota">Desmarca o que não queres gravar — um vinho inteiro ou só um campo. Desmarcar um link novo do Vivino desmarca também a nota e as avaliações lidas nessa página. Ao gravar, fica no ficheiro o que decidiste.</p>
  <div id="tabela"></div>
</div>
<div class="card"><h2>Vinho novo</h2>
  <p class="nota" style="margin:0 0 10px">Um vinho que ainda não está no catálogo. O script procura-o no Vivino e nas lojas (nota, preço, castas, região, teor, harmonização…) e faz uma <b>simulação</b>: o vinho só é criado quando a gravares, em Simulações. Se já existir, enriquece o que lá está.</p>
  <table id="novos"><tr><th>Nome *</th><th>Produtor</th><th>Ano</th><th>Cor *</th><th title="Vivino, Garrafeira Nacional, Granvine ou Vinha.pt — separados por espaço. O script abre-os diretamente, em vez de procurar.">Links (opcional)</th><th></th></tr></table>
  <div class="linha" style="margin-top:10px"><button onclick="novaLinha()">+ outro vinho</button></div>
  <div class="correr" style="margin-top:10px">
    <div class="linha sitios" id="novo-sitios"></div>
    <div class="linha" style="margin-top:8px"><label>Ler: <select id="novo-pesquisa" onchange="sitiosSincronizar('novo')">
      <option value="completo">Tudo — a ficha toda</option>
      <option value="precos">Só preços (e imagem)</option>
    </select></label>
    <button class="prim corre" id="btn-novo" onclick="procurarNovos()">Procurar (simular)</button></div></div>
</div>
<p class="seccao">As garrafeiras × o catálogo</p>
<div class="card"><h2>Links do Vivino nas garrafeiras</h2>
  <p class="nota" style="margin:0 0 10px">Compara o link de cada vinho das garrafeiras com o do catálogo. Só propõe trocar quando o da garrafeira <b>não tem o número do vinho</b> (<code>/wines/nº</code>, <code>/Wines/nome</code>…) ou <b>abre outro vinho</b>, ou quando está vazio — e só se o link do catálogo estiver confirmado (lido na página pelo script, ou escrito por ti). Um link para uma colheita do mesmo vinho fica como a pessoa o pôs.</p>
  <div class="linha"><button class="prim" onclick="garrProcurar()">Comparar</button>
    <span id="garr-n" class="nota"></span>
    <button id="btn-garr" onclick="garrCorrigir()" disabled>Corrigir os marcados</button></div>
  <div id="garr-lista" style="margin-top:10px"></div>
</div>
<div class="card"><h2>Fichas das garrafeiras × catálogo</h2>
  <p class="nota" style="margin:0 0 10px">O resto da ficha (nota, avaliações, preço, castas, teor, estágio, janela, notas de prova, harmonização…), <b>só da mesma colheita</b>. Propõe o que está <b>vazio</b> na garrafeira e o catálogo tem, e o que é <b>diferente</b> quando o do catálogo é <b>mais recente</b> do que a última vez que o dono gravou o vinho. Nunca a cor (cor diferente = outro vinho, não se toca), nunca a fotografia da pessoa, e as notas pessoais nem vão ao catálogo. O link do Vivino é no cartão de cima.</p>
  <div class="linha"><button class="prim" onclick="fichProcurar()">Comparar</button>
    <span id="fich-n" class="nota"></span>
    <button id="btn-fich" onclick="fichCorrigir()" disabled>Corrigir os marcados</button></div>
  <div id="fich-lista" style="margin-top:10px;max-height:640px;overflow:auto"></div>
</div>
</section>
<section class="tab" id="t-nomes" hidden>
<div class="card"><h2>Nomes dos vinhos</h2>
  <p class="nota" style="margin:0 0 10px">O nome é o que distingue o vinho: o <b>produtor</b>, a <b>cor</b> e a <b>colheita</b> são campos à parte. A regra tira do nome a <b>colheita</b> (quando é a do vinho) e o <b>produtor</b> da frente (só se o que sobra se aguentar sozinho — "Cartuxa Colheita" e "Herdade do Sobroso Reserva" ficam, esses vinhos chamam-se pelo produtor), no catálogo e em todas as garrafeiras. Quando o nome que sobra fica vago ("1836 Grande Reserva"), desmarca-o e carrega em <b>Manter o produtor no nome</b>: o PRODUTOR desse vinho fica numa lista, e nos vinhos dele o produtor nunca mais sai da frente do nome — e entra, se lá não estiver —, nos que já cá estão, nas garrafeiras e nos que vierem. A lista também se gere no separador <a href="#produtores">Produtores</a>. A <b>cor</b> no fim do nome também sai (é um campo da chave desde a fase 4). Os vinhos novos e os nomes mudados já passam pela regra sozinhos; esta lista é a dos que já cá estavam. Os avisos são para decidires à mão, no Editar.</p>
  <div class="filtros"><input type="search" id="nomes-q" placeholder="procurar por nome, produtor, garrafeira, dono…" oninput="nomesPintar()">
    <label>Onde <select id="nomes-onde" onchange="nomesPintar()"><option value="">catálogo e garrafeiras</option><option value="catalogo">só o catálogo</option><option value="garrafeira">só as garrafeiras</option></select></label>
    <label>O que muda no nome <select id="nomes-mud" onchange="nomesPintar()"><option value="">qualquer coisa</option><option value="ano">sai a colheita</option><option value="produtor">sai o produtor</option><option value="produtor_entra">entra o produtor</option><option value="cor">sai a cor</option><option value="avisos">só os com avisos</option></select></label>
    <label><input type="checkbox" id="nomes-so" onchange="nomesPintar()" checked> só os que mudam agora</label></div>
  <div class="linha" style="margin-top:10px"><span id="nomes-n" class="nota"></span></div>
  <div class="linha" style="margin-top:8px"><button onclick="nomesMarcar(true)">Marcar os que se veem</button><button onclick="nomesMarcar(false)">Desmarcar os que se veem</button>
    <button class="prim" id="btn-nomes" onclick="nomesAplicar()" disabled>Aplicar os marcados</button>
    <button id="btn-nomes-manter" onclick="nomesManter()" disabled title="Os produtores dos desmarcados que se veem e a quem a regra tirava o produtor da frente: nos vinhos deles, o produtor fica no nome">Manter o produtor no nome</button>
    <button onclick="nomesProcurar()" title="Volta a correr a regra sobre o catálogo e as garrafeiras de agora">🔄 Simular de novo</button></div>
  <div id="nomes-lista" style="margin-top:10px;max-height:640px;overflow:auto"></div>
  <details style="margin-top:10px" ontoggle="if(this.open)nomesManterListar()"><summary class="nota">Produtores no nome dos vinhos (também em Produtores)</summary><div id="nomes-manter" style="margin-top:6px"></div></details>
</div>
</section>
<section class="tab" id="t-produtores" hidden>
<div class="card"><h2>Produtores</h2>
  <p class="nota" style="margin:0 0 10px">Cada produtor tem um <b>nome oficial</b> e as <b>grafias</b> que são ele. O que estiver escrito numa grafia passa ao nome oficial <b>no catálogo e em todas as garrafeiras</b> — agora e em qualquer escrita futura.</p>
  <div class="filtros"><input type="search" id="prod-q" placeholder="procurar um produtor ou uma grafia…" oninput="prodPintar()">
    <button onclick="prodProcurar()">🔄 Atualizar</button></div>
  <div class="seg" role="tablist" id="prod-seg" style="margin-top:12px">
    <button data-v="sug" onclick="prodVista('sug')">Por decidir <span class="n" id="prod-n-sug"></span></button>
    <button data-v="of" onclick="prodVista('of')">Produtores oficiais <span class="n" id="prod-n-of"></span></button>
    <button data-v="nn" onclick="prodVista('nn')">Produtor no nome dos vinhos <span class="n" id="prod-n-nn"></span></button>
  </div>
  <div id="prod-msg"></div>
  <div class="prod-v" id="prod-v-sug">
    <p class="nota" style="margin:10px 0">Grafias que <b>podem</b> ser o mesmo produtor (as palavras de uma estão todas na outra). Parecido não quer dizer igual — "Quinta Nova" não é "Herdade da Malhadinha Nova". Marca as que são o produtor, escolhe o nome oficial e carrega em <b>Juntar</b>; se não forem, <b>Não são o mesmo</b> e o par não volta. Um vinho que fique igual a outro que já existe não se mexe: aparece nos Duplicados.</p>
    <div id="prod-lista"></div>
  </div>
  <div class="prod-v" id="prod-v-of" hidden>
    <p class="nota" style="margin:10px 0"><b>+ grafia</b> junta outra maneira de escrever o produtor. <b>✏️</b> muda o nome oficial (o antigo fica como grafia) ou o nome completo (só para se ler na ficha). Grafias juntas por <span class="eq">=</span> dão a mesma chave — para o catálogo já eram o mesmo produtor (palavras como "Herdade", "Quinta", "Casa", "do", "Vinhos" não contam).</p>
    <div id="prod-oficiais"></div>
  </div>
  <div class="prod-v" id="prod-v-nn" hidden>
    <p class="nota" style="margin:10px 0">Nos vinhos destes produtores, <b>o nome do produtor aparece sempre no nome do vinho</b>: não sai da frente e, se lá não estiver, entra ("1836 Grande Reserva" → "Companhia das Lezírias 1836 Grande Reserva"). Vale no catálogo, nas garrafeiras e nas escritas futuras; a colheita e a cor no fim continuam a sair. Ao ligar, vês logo os nomes que mudam antes de os aplicar.</p>
    <div class="linha"><input type="text" id="prod-nn-novo" list="prod-grafias" placeholder="produtor…" style="flex:1 1 240px;min-width:0;padding:7px 10px;border:1px solid var(--bo);border-radius:8px;font:inherit">
      <button class="prim" onclick="prodNoNomeAcrescentar()">+ Acrescentar</button></div>
    <div id="prod-nn" style="margin-top:10px"></div>
  </div>
  <datalist id="prod-grafias"></datalist>
</div>
</section>
<section class="tab" id="t-duplicados" hidden>
<div class="card"><h2>Vinhos que parecem o mesmo</h2>
  <p class="nota" style="margin:0 0 10px">Quando um vinho é o mesmo que outro, carrega em <b>É este</b>. Ficam o nome, o produtor e a cor do outro; a colheita é a de cada um. <b>Da mesma colheita</b>, juntam-se num só (desfaz-se na app, em Duplicados › Fusões). <b>De outra colheita</b>, este passa a ser essa colheita do outro vinho — colheitas diferentes nunca se juntam, são linhas diferentes do mesmo vinho. <b>Nenhum destes</b> / <b>Não são</b> fica gravado e o par não volta (nem nos Duplicados da app). Para o que isto não apanha, a ficha de cada vinho tem <b>🔗 É o mesmo que…</b>.</p>
  <div class="linha"><button onclick="dupProcurar()">🔄 Procurar de novo</button><span id="dup-n" class="nota"></span></div>
  <div class="passo">Uma letra de diferença <span class="nota">— um nome com uma letra trocada, a mais ou a menos ("Cristo" / "Crasto"), em qualquer colheita; o de cima é o suspeito (a palavra mais rara)</span></div>
  <div id="dup-letra"><p class="nota">A procurar…</p></div>
  <div class="passo">Mesma colheita, nome parecido <span class="nota">— os pares dos Duplicados da app</span></div>
  <div id="dup-colheita"></div>
</div>
</section>
<section class="tab" id="t-comentarios" hidden>
<div class="card"><h2>Comentários sobre vinhos</h2>
  <p class="nota" style="margin:0 0 10px">Escritos na Garrafeira, na página de cada vinho: <b>atributos errados</b>, um <b>site de onde atualizar</b> a ficha, ou outro problema. Corrige-se no catálogo — carrega no nome para abrir a ficha e editar, ou em <b>Escolher para enriquecer</b> para o correr na Informação de vinhos — e daí chega às garrafeiras (em "Fichas das garrafeiras × catálogo"). Fecha-se com uma <b>resposta</b>, ou devolve-se uma <b>pergunta</b> (❓ — fica à espera da resposta da pessoa): ela lê-as na Garrafeira e recebe um aviso no telemóvel.</p>
  <div class="linha"><label>Mostrar <select id="com-vinho-estado" onchange="comProcurar('vinho')"><option value="aberto">por tratar</option><option value="duvida">à espera de resposta</option><option value="todos">todos</option><option value="resolvido">tratados</option><option value="rejeitado">recusados</option></select></label>
    <button onclick="comProcurar('vinho')">🔄 Atualizar</button><span id="com-vinho-conta" class="nota"></span></div>
  <div id="com-vinho-lista" style="margin-top:10px"></div>
</div>
</section>
<section class="tab" id="t-sugestoes" hidden>
<div class="card"><h2>Sugestões de melhoria</h2>
  <p class="nota" style="margin:0 0 10px">Ideias para a app e coisas que não funcionam, escritas em Definições da Garrafeira. Fecha-se com uma <b>resposta</b>, ou devolve-se uma <b>pergunta</b> (❓): a pessoa lê-as lá e recebe um aviso.</p>
  <div class="linha"><label>Mostrar <select id="com-sugestao-estado" onchange="comProcurar('sugestao')"><option value="aberto">por tratar</option><option value="duvida">à espera de resposta</option><option value="todos">todas</option><option value="resolvido">tratadas</option><option value="rejeitado">recusadas</option></select></label>
    <button onclick="comProcurar('sugestao')">🔄 Atualizar</button><span id="com-sugestao-conta" class="nota"></span></div>
  <div id="com-sugestao-lista" style="margin-top:10px"></div>
</div>
</section>
</main>
<div class="modal" id="modal-vinho" hidden onclick="if(event.target===this)fecharVinho()">
  <div class="caixa" role="dialog" aria-modal="true" aria-labelledby="mv-titulo">
    <div class="topo" id="mv-topo"></div>
    <div class="corpo" id="mv-corpo"></div>
  </div>
</div>
<script>
const TOKEN="__TOKEN__";let visto=0,timer=null,sim=null,simNome=null;
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const semAc=t=>String(t||"").normalize("NFD").replace(/[\\u0300-\\u036f]/g,"").toLowerCase();
const palavras=el=>semAc(document.getElementById(el).value).split(/\\s+/).filter(Boolean);
async function post(u,b){const r=await fetch(u,{method:"POST",headers:{"Content-Type":"application/json","X-Painel":TOKEN},body:JSON.stringify(b)});const j=await r.json();if(!r.ok)throw new Error(j.erro||r.status);return j;}

// ── Separadores ── (o de agora fica no endereço: #info, #nomes, #produtores, #duplicados, #comentarios, #sugestoes)
const TABS=["info","nomes","produtores","duplicados","comentarios","sugestoes"],ABERTOS=new Set();
function abrirTab(t){
  if(!TABS.includes(t))t="info";
  for(const x of TABS)document.getElementById("t-"+x).hidden=x!==t;
  document.querySelectorAll("nav.tabs button").forEach(b=>{const on=b.dataset.tab===t;b.classList.toggle("on",on);b.setAttribute("aria-selected",on?"true":"false");});
  if(location.hash!=="#"+t)history.replaceState(null,"","#"+t);
  // Os Nomes e os Produtores só leem a BD: carregam sozinhos da primeira vez.
  if(!ABERTOS.has(t)){ABERTOS.add(t);if(t==="nomes")nomesProcurar();if(t==="produtores")prodProcurar();
    if(t==="comentarios")comProcurar("vinho");if(t==="sugestoes")comProcurar("sugestao");}
}
window.addEventListener("hashchange",()=>abrirTab(location.hash.slice(1)));

// ── Escolher os vinhos ──
let CAT=[];const ESC=new Set();
// O critério. Cada filtro: o rótulo, as opções [valor, texto] e o teste. A
// contagem de cada opção conta com a procura e os OUTROS filtros ligados,
// não com o próprio — vê-se quantos há antes de mudar.
const FILTROS=[
  {id:"img",rot:"Imagem",ops:[["","todas"],["sem","sem imagem"],["vivino","do Vivino"],["loja","de uma loja"],["outro","de outro site"],["nossa","fotografia vossa"]],
   t:(v,x)=>x==="sem"?!v.imagem_url:v.imagem_de===x},
  {id:"preco",rot:"Preço",ops:[["","todos"],["sem","sem preço"],["com","com preço"]],t:(v,x)=>x==="sem"?!v.preco:!!v.preco},
  {id:"prod",rot:"Produtor",ops:[["","todos"],["sem","sem produtor"]],t:v=>!String(v.produtor||"").trim(),
   tit:"Sem produtor: o script propõe a adega que a página do Vivino mostra (só preenche — trocar um produtor é o Editar da app)"},
  {id:"link",rot:"Link do Vivino",ops:[["","todos"],["sem","sem link"],["invalido","suspeito"],["por_limpar","por limpar"],["ok","certo"]],t:(v,x)=>x==="sem"?!v.link:v.link===x,
   tit:"Suspeito: sem o número do vinho (/w/nº) — p. ex. /wines/nº, que é uma colheita, ou /Wines/nome, que não existe. Por limpar: tem o número, mas com país, língua ou ?year= (o script arruma-o quando passa)."},
  {id:"visto",rot:"Verificado",ops:[["","quando for"],["nunca","nunca"],["30","nunca ou há mais de 30 dias"],["90","nunca ou há mais de 90 dias"]],
   t:(v,x)=>x==="nunca"?!v.visto:(!v.visto||Date.now()-new Date(v.visto).getTime()>Number(x)*864e5)},
  {id:"pedido",rot:"Pedidos na app",ops:[["","todos"],["sim","só os pedidos"]],t:v=>!!v.pedido,
   tit:"Os vinhos que se pediram na ficha da app, com «🍷 Verificar no Vivino». Saem daqui quando o script os trata."},
  // As opções destes dois vêm da lista (filtrosDinamicos), a mais frequente primeiro.
  {id:"criou",rot:"Criado por",ops:[["","todos"]],din:v=>autorCurto(v.criado_por)||"—",t:(v,x)=>(autorCurto(v.criado_por)||"—")===x,
   tit:"Quem criou o vinho no catálogo. Por trás de uma pesquisa com IA (Edge Function) ou de uma garrafeira, descobre-se pela hora nos registos de cada app."},
  {id:"alterou",rot:"Alterado por",ops:[["","todos"]],din:v=>autorCurto(v.alterado_por)||"—",t:(v,x)=>(autorCurto(v.alterado_por)||"—")===x,
   tit:"Quem fez a última alteração registada no histórico (desde 25/09/2026)."},
];
// Quem criou / alterou (27/09/2026): o email fica só com o que vem antes da
// arroba; o nome do processo do script fica curto. O completo vai no title.
const autorCurto=a=>String(a||"").replace(/([^\\s@·]+)@[^\\s·]+/g,"$1").replace(/^script no PC \\(.*\\)$/,"script no PC");
function filtrosDinamicos(){
  for(const f of FILTROS.filter(x=>x.din)){
    const sel=document.getElementById("f-"+f.id),atual=sel.value,n={};
    for(const v of CAT){const k=f.din(v);n[k]=(n[k]||0)+1;}
    const vals=Object.keys(n).sort((a,b)=>n[b]-n[a]||a.localeCompare(b,"pt"));
    f.ops=[["","todos"]].concat(vals.map(x=>[x,x]));
    sel.innerHTML=f.ops.map(([v,t])=>'<option value="'+esc(v)+'">'+esc(t)+'</option>').join("");
    sel.value=vals.includes(atual)?atual:"";
  }
}
function filtrosHTML(){
  document.getElementById("cat-filtros").innerHTML=FILTROS.map(f=>'<label'+(f.tit?' title="'+esc(f.tit)+'"':'')+'>'+esc(f.rot)+
    ' <select id="f-'+f.id+'" onchange="pintarCatalogo()">'+f.ops.map(([v,t])=>'<option value="'+v+'">'+esc(t)+'</option>').join("")+'</select></label>').join("");
}
const valorF=f=>document.getElementById("f-"+f.id).value;
// Os que passam a procura e os filtros; "sem" deixa um filtro de fora (para as contagens).
function catPool(sem){
  const q=palavras("cat-q"),ativos=FILTROS.filter(f=>f!==sem&&valorF(f));
  return CAT.filter(v=>{const t=semAc([v.nome,v.produtor,v.regiao,v.ano,v.tipo,autorCurto(v.criado_por),autorCurto(v.alterado_por)].join(" "));
    return q.every(p=>t.includes(p))&&ativos.every(f=>f.t(v,valorF(f)));});
}
function catContagens(){
  for(const f of FILTROS){
    const base=catPool(f),sel=document.getElementById("f-"+f.id);
    [...sel.options].forEach((o,i)=>{const [v,t]=f.ops[i];o.textContent=t+" ("+(v?base.filter(x=>f.t(x,v)).length:base.length)+")";});
    sel.classList.toggle("ativo",!!sel.value);
  }
}
// As ordens da lista (27/09/2026, pedido do dono). "Alterado" é a última
// mudança na linha (o "atualizado_em" ou o histórico, o mais recente dos
// dois); "criado" é quando nasceu. Um vinho sem o valor vai para o fim — menos
// em "verificados há mais tempo", em que "nunca" vem primeiro (a ordem da
// antiga fila). Empates ficam por nome. A escolha fica neste browser.
const data=x=>{const t=x?Date.parse(x):NaN;return Number.isNaN(t)?null:t;};
const numero=x=>x==null||x===""||Number.isNaN(Number(x))?null:Number(x);
const ORDENS=[
  {id:"nome",rot:"Nome (A → Z)"},
  {id:"alterado-",rot:"Alterados há menos tempo",g:"Datas",k:v=>data(v.alterado),desc:1,col:"alterado"},
  {id:"alterado+",rot:"Alterados há mais tempo",g:"Datas",k:v=>data(v.alterado),col:"alterado"},
  {id:"criado-",rot:"Criados há menos tempo",g:"Datas",k:v=>data(v.criado),desc:1,col:"criado"},
  {id:"criado+",rot:"Criados há mais tempo",g:"Datas",k:v=>data(v.criado),col:"criado"},
  {id:"visto+",rot:"Verificados há mais tempo (nunca primeiro)",g:"Datas",k:v=>v.visto?data(v.visto):-Infinity,col:"visto"},
  {id:"visto-",rot:"Verificados há menos tempo",g:"Datas",k:v=>data(v.visto),desc:1,col:"visto"},
  {id:"campos+",rot:"Menos informação primeiro",g:"Outras",k:v=>numero(v.campos)},
  {id:"preco-",rot:"Preço de referência — mais caros primeiro",g:"Outras",k:v=>numero(v.preco_medio),desc:1},
  {id:"preco+",rot:"Preço de referência — mais baratos primeiro",g:"Outras",k:v=>numero(v.preco_medio)},
  {id:"ano-",rot:"Colheita — mais recentes primeiro",g:"Outras",k:v=>numero(v.ano),desc:1},
];
function ordensHTML(){
  const g={};for(const o of ORDENS)(g[o.g||""]=g[o.g||""]||[]).push(o);
  document.getElementById("cat-ordem").innerHTML=Object.entries(g).map(([n,l])=>{
    const ops=l.map(o=>'<option value="'+o.id+'">'+esc(o.rot)+'</option>').join("");
    return n?'<optgroup label="'+esc(n)+'">'+ops+'</optgroup>':ops;}).join("");
  let guardada=null;try{guardada=localStorage.getItem("painel_ordem");}catch{}
  if(ORDENS.some(o=>o.id===guardada))document.getElementById("cat-ordem").value=guardada;
}
const ordemAtual=()=>ORDENS.find(o=>o.id===document.getElementById("cat-ordem").value)||ORDENS[0];
function ordenar(l){
  const o=ordemAtual();if(!o.k)return l;
  return l.map(v=>[v,o.k(v)]).sort(([,a],[,b])=>{
    if(a==null||b==null)return a==null&&b==null?0:a==null?1:-1;
    return (a<b?-1:a>b?1:0)*(o.desc?-1:1);}).map(x=>x[0]);
}
function catOrdem(){try{localStorage.setItem("painel_ordem",document.getElementById("cat-ordem").value);}catch{}pintarCatalogo();}
// Os escolhidos pela ordem da lista — é por ela que correm.
function escolhidosPelaOrdem(){
  const l=ordenar(CAT.filter(v=>ESC.has(v.id))).map(v=>v.id);
  return l.concat([...ESC].filter(id=>!l.includes(id)));
}
// A lista: os que passam os filtros, ou só os escolhidos — pela ordem escolhida.
function catVisiveis(){
  if(document.getElementById("cat-so").checked)return ordenar(CAT.filter(v=>ESC.has(v.id)));
  return ordenar(catPool());
}
async function carregarCatalogo(){
  try{const r=await fetch("/catalogo",{headers:{"X-Painel":TOKEN}});const j=await r.json();if(!r.ok)throw new Error(j.erro||r.status);CAT=j;filtrosDinamicos();pintarCatalogo();}
  catch(e){document.getElementById("cat-lista").innerHTML='<p class="nota" style="padding:10px">Não consegui ler o catálogo: '+esc(e.message)+'</p>';}
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
    if(p.retirado)return '<div title="retirado à mão na WineCatalog (Editar › Fontes de preço)"><span class="l">'+rot+'</span><s>'+eur(p.preco)+'</s></div>';
    const med=origem===o||(k==="vivino"&&/^vivino-/.test(origem));
    if(med)usada=true;
    const tit=[p.nome,p.colheita?"colheita "+p.colheita:"",p.em?"lido a "+p.em:""].filter(Boolean).join(" · ");
    const val=p.url?'<a href="'+esc(p.url)+'" target="_blank" rel="noopener noreferrer" title="'+esc(tit)+'">'+eur(p.preco)+'</a>':'<span title="'+esc(tit)+'">'+eur(p.preco)+'</span>';
    return '<div class="'+(med?"med":"")+'"><span class="l">'+rot+'</span>'+val+(p.colheita&&v.ano&&Number(p.colheita)!==Number(v.ano)?' <span title="outra colheita">('+esc(p.colheita)+')</span>':'')+'</div>';
  });
  if(v.preco_medio!=null&&!usada)linhas.push('<div class="out" title="o preço de referência veio daqui"><span class="l">referência</span>'+eur(v.preco_medio)+' <span style="font-weight:400">('+esc(origem||"?")+')</span></div>');
  return '<div class="prc">'+linhas.join("")+'</div>';
}
const IMG_DE={vivino:"Vivino",loja:"loja",nossa:"vossa",outro:"outro site"};
function miniatura(v){
  if(!v.imagem_url)return '<span class="sem">sem</span><small>&nbsp;</small>';
  const u=esc(v.imagem_url);
  return '<a href="'+u+'" target="_blank" rel="noopener noreferrer" title="'+u+'"><img src="'+u+'" loading="lazy" referrerpolicy="no-referrer" alt="" onerror="semImg(this)"></a>'+
    '<small class="'+(v.imagem_de==="vivino"?"v":"")+'">'+esc(IMG_DE[v.imagem_de]||"")+'</small>';
}
const DMA=new Intl.DateTimeFormat("pt-PT",{day:"2-digit",month:"2-digit",year:"2-digit"});
const DMAH=new Intl.DateTimeFormat("pt-PT",{dateStyle:"short",timeStyle:"short"});
function dataCurta(x,rot,sem,ord){
  const t=data(x);
  return '<div'+(ord?' class="ord"':'')+(t!=null?' title="'+esc(rot+" "+DMAH.format(t))+'"':'')+'>'+(t!=null?esc(rot+" "+DMA.format(t)):esc(sem))+'</div>';
}
// "antes do histórico": o vinho nasceu antes de 25/09/2026 e ninguém sabe quem.
const porTexto=a=>a==="antes do histórico"?"(antes do histórico)":"por "+autorCurto(a);
const porHTML=a=>a?'<div class="por" title="'+esc(a)+'">'+esc(porTexto(a))+'</div>':'';
function datasHTML(v,col){
  return dataCurta(v.alterado,"alterado","",col==="alterado")+porHTML(v.alterado_por)+
    dataCurta(v.criado,"criado","",col==="criado")+porHTML(v.criado_por)+dataCurta(v.visto,"visto","nunca visto",col==="visto");
}
function pintarCatalogo(){
  catContagens();
  const col=ordemAtual().col;
  const so=document.getElementById("cat-so").checked,pool=catPool(),l=catVisiveis();
  const ligados=FILTROS.filter(valorF).length+(palavras("cat-q").length?1:0);
  document.getElementById("cat-passam").textContent=ligados?"— "+pool.length+" de "+CAT.length+" vinhos passam":"— sem filtros: o catálogo todo ("+CAT.length+" vinhos)";
  const linhas=l.slice(0,400).map(v=>'<tr class="'+(ESC.has(v.id)?"sel":"")+'"><td><input type="checkbox" '+(ESC.has(v.id)?"checked":"")+' onchange="catMarca('+v.id+',this)"></td>'+
    '<td class="mini">'+miniatura(v)+'</td>'+
    '<td><a href="#" class="nm" onclick="abrirVinho('+v.id+');return false" title="Abrir a ficha do vinho"><b>'+esc(v.nome)+'</b></a>'+(v.ano?" "+esc(v.ano):"")+(v.pedido?' <span class="tag" title="pedido na app, com «🍷 Verificar no Vivino»">🍷 pedido</span>':'')+'<br><span class="nota">'+esc([v.produtor,v.tipo,v.regiao].filter(Boolean).join(" · "))+'</span></td>'+
    '<td>'+precosHTML(v)+'</td>'+
    '<td class="ic">'+(v.link==="invalido"?'<b title="link do Vivino suspeito" style="color:var(--er)">V?</b>':v.vivino?"V":"")+'</td>'+
    '<td class="ic datas">'+datasHTML(v,col)+'</td></tr>');
  document.getElementById("cat-lista").innerHTML=l.length?'<table>'+linhas.join("")+'</table>'+(l.length>400?'<p class="nota" style="padding:8px">…e mais '+(l.length-400)+' — afina a procura.</p>':'')
    :'<p class="nota" style="padding:10px">'+(so?"Ainda não escolheste nenhum vinho.":"Nenhum vinho com estes filtros.")+'</p>';
  catContar();
}
function catMarca(id,el){if(el.checked){if(ESC.size>=50){el.checked=false;return alert("Até 50 de cada vez.");}ESC.add(id);}else ESC.delete(id);el.closest("tr").classList.toggle("sel",el.checked);catContar();}
function catMarcarVisiveis(){
  const pool=ordenar(catPool());let fora=0;
  for(const v of pool){if(ESC.has(v.id))continue;if(ESC.size>=50){fora++;continue;}ESC.add(v.id);}
  pintarCatalogo();
  if(fora)alert("Só cabem 50 de cada vez — ficaram de fora "+fora+". Afina os filtros, ou sorteia.");
}
// Ao acaso entre os que passam os filtros: troca a escolha de agora e mostra
// só os sorteados, para se ver o que vai correr (e desmarcar algum).
const quantos=max=>Math.min(max,Math.max(1,Math.min(50,parseInt(document.getElementById("cat-quantos").value,10)||10)));
function catTrocarEscolha(l,como){
  if(!l.length)return alert("Nenhum vinho passa os filtros.");
  const n=quantos(l.length);
  if(ESC.size&&!confirm("Trocar os "+ESC.size+" escolhidos por "+n+" "+como+"?"))return;
  ESC.clear();for(const v of l.slice(0,n))ESC.add(v.id);
  document.getElementById("cat-so").checked=true;
  pintarCatalogo();
}
// Os primeiros da lista, pela ordem escolhida ("os 10 alterados há mais tempo").
function catPrimeiros(){catTrocarEscolha(ordenar(catPool()),"— os primeiros pela ordem da lista");}
function catSortear(){
  const a=catPool().slice();
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
  catTrocarEscolha(a,"ao acaso");
}
function catLimpar(){ESC.clear();document.getElementById("cat-so").checked=false;pintarCatalogo();}
function catLimparFiltros(){document.getElementById("cat-q").value="";for(const f of FILTROS)document.getElementById("f-"+f.id).value="";document.getElementById("cat-so").checked=false;pintarCatalogo();}
function catContar(){
  const t=ESC.size+" escolhido"+(ESC.size===1?"":"s");
  document.getElementById("cat-n").textContent=t;
  document.getElementById("cat-n2").textContent=ESC.size?"— "+t:"— escolhe primeiro os vinhos (passo 2)";
}
async function correrEscolhidos(modo){
  if(!ESC.size)return alert("Escolhe primeiro os vinhos (passo 2).");
  if(modo==="enriquecer"&&!confirm("Gravar já no catálogo os "+ESC.size+" escolhidos, sem simular primeiro?"))return;
  try{await post("/correr",{modo,ids:escolhidosPelaOrdem(),pesquisa:document.getElementById("pesquisa").value,sitios:sitiosEscolhidos("cat"),trocarImagem:document.getElementById("cat-trocar").checked});comecar(true);}catch(e){alert(e.message);}
}

// ── A ficha de um vinho: o back-office (27/09/2026, pedido do dono) ──
// Um clique no nome (na lista, nas simulações, nas garrafeiras) abre o vinho
// inteiro: cada campo com a origem, a força e a data, os preços de cada
// sítio, as fontes, as últimas verificações e o histórico. "Editar" corrige
// à mão pela MESMA "editar" da app (db/painel.sql: força 4 no rótulo, 3 na
// nota/preço/imagem; a trava da identidade) e manda só o que mudou.
// Os campos e a ordem são os do Editar da app (WC_EDIT em app.js).
const CAMPOS_ED=[
  ["imagem_url","Imagem","img"],
  ["tipo","Cor","sel",["Tinto","Branco","Rosé","Espumante","Licoroso","Frisante"]],
  ["estilo","Estilo","sel",["","Maduro","Verde","Colheita Tardia","Palhete"]],
  ["mencao","Menção","sel",["","Reserva","Grande Reserva","Garrafeira","Colheita Selecionada","Vinhas Velhas","Superior","Grande Escolha"]],
  ["classificacao","Classificação","sel",["","DOC","Vinho Regional","Vinho"]],
  ["castas","Castas","lista"],["regiao","Região","txt"],["sub_regiao","Sub-região","txt"],["pais","País","txt"],
  ["teor","Teor alcoólico (%)","num"],["estagio_meses","Estágio (meses)","int"],["estagio_texto","Estágio","txt"],
  ["vivino_nota","Nota Vivino da colheita","num"],["vivino_avaliacoes","Avaliações Vivino da colheita","int"],
  ["vivino_nota_global","Nota Vivino de todas as colheitas","num"],["vivino_avaliacoes_global","Avaliações Vivino de todas as colheitas","int"],
  ["vivino_url","Link do Vivino","txt"],["preco_medio","Preço de referência (€)","num"],
  ["beber_de","Beber de (ano)","int"],["beber_ate","Beber até (ano)","int"],
  ["notas_prova","Notas de prova","area"],["harmonizacao","Harmonização","area"],["ai_resumo","Resumo","area"]];
const ORIGEM_TXT={"catalogo-admin":"à mão (admin)","catalogo-pesquisa":"pesquisa (IA)","garrafeira":"uma garrafeira",
  "garrafeira-bruto":"garrafeira (bruto)","ws-verificacao":"WineSelection (verificação)","ws-sugestao":"WineSelection (sugestão)",
  "vivino-pagina":"página do Vivino","vivino-serper":"Google (Serper)","loja-garrafeira-nacional":"Garrafeira Nacional",
  "loja-granvine":"Granvine","loja-vinha":"Vinha.pt","lojas-script":"script (lojas)",
  "vinho-info-premium":"Garrafeira (IA)","vinho-info-gratis":"Garrafeira (pesquisa)","reposto":"reposto à mão"};
const NOME_LOJA={garrafeira_nacional:"Garrafeira Nacional",granvine:"Granvine",vinha:"Vinha.pt",vivino:"Vivino"};
const PRIORIDADE=["garrafeira_nacional","granvine","vinha","vivino"];
const JANELA=["beber_de","beber_ate"];
let VINHO=null,EDITAR=false,MESMO=false;
const dataFmt=x=>{const t=data(x);return t==null?"":DMA.format(t);};
const dataHora=x=>{const t=data(x);return t==null?"":DMAH.format(t);};
function origemHTML(o){
  if(!o||!o.o)return '<span class="nota">—</span>';
  const f=Number(o.f||0);
  return '<span class="og f'+f+'" title="força '+f+'">'+esc(ORIGEM_TXT[o.o]||o.o)+' · '+f+'</span>'+(o.em?' <span class="nota">'+esc(dataFmt(o.em))+'</span>':'');
}
function valorFicha(k,x){
  if(x==null||x===""||(Array.isArray(x)&&!x.length))return '<span class="nota">—</span>';
  if(Array.isArray(x))return esc(x.join(", "));
  if(typeof x==="object")return '<code>'+esc(JSON.stringify(x))+'</code>';
  const t=String(x);
  if(/^https?:\\/\\//i.test(t))return '<a href="'+esc(t)+'" target="_blank" rel="noopener noreferrer">'+esc(t.replace(/^https?:\\/\\/(www\\.)?/,"").slice(0,80))+'</a>';
  if(k==="preco_medio")return esc(eur(x));
  if(k==="teor")return esc(t)+" %";
  return esc(t);
}
const curto=(x,n)=>{const t=x==null?"":typeof x==="string"?x:JSON.stringify(x);return t.length>n?'<span title="'+esc(t)+'">'+esc(t.slice(0,n))+'…</span>':esc(t);};
async function abrirVinho(id){
  const m=document.getElementById("modal-vinho");
  m.hidden=false;document.body.classList.add("com-modal");
  document.getElementById("mv-topo").innerHTML='<div><h3>A carregar…</h3></div>';
  document.getElementById("mv-corpo").innerHTML="";
  try{VINHO=await post("/vinho",{acao:"ver",id});EDITAR=false;MESMO=false;pintarVinho();}
  catch(e){document.getElementById("mv-topo").innerHTML='<div><h3>Não consegui abrir o vinho</h3><div class="sub">'+esc(e.message)+'</div></div><div class="acoes"><button onclick="fecharVinho(true)">✕ Fechar</button></div>';}
}
function fecharVinho(forcar){
  if(!forcar&&EDITAR&&!confirm("Fechar sem guardar o que mudaste?"))return;
  EDITAR=false;document.getElementById("modal-vinho").hidden=true;document.body.classList.remove("com-modal");
}
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!document.getElementById("modal-vinho").hidden)fecharVinho();});
function editarVinho(on){
  if(!on&&!confirm("Deixar o que mudaste por gravar?"))return;
  EDITAR=on;pintarVinho();
}
function pintarVinho(){
  const v=VINHO,f=v.ficha||{},o=v.origens||{};
  const img=f.imagem_url?'<img src="'+esc(f.imagem_url)+'" alt="" referrerpolicy="no-referrer" onerror="this.parentNode.textContent=\\'a imagem não abre\\'">':'sem imagem';
  document.getElementById("mv-topo").innerHTML='<div class="garrafa">'+img+'</div>'+
    '<div class="tit"><div class="sub">#'+esc(v.id)+' · criado '+esc(dataFmt(v.criado))+(v.criado_por?' <span title="'+esc(v.criado_por)+'">'+esc(porTexto(v.criado_por))+'</span>':'')+
      ' · alterado '+esc(dataFmt(v.atualizado))+(v.alterado_por?' por <span title="'+esc(v.alterado_por)+'">'+esc(autorCurto(v.alterado_por))+'</span>':'')+(v.vezes?' · escrito '+esc(v.vezes)+'×':'')+'</div>'+
    '<h3 id="mv-titulo">'+esc(v.nome)+(f.tipo?' <span class="cor">'+esc(String(f.tipo).toLowerCase())+'</span>':'')+'</h3>'+
    '<div class="sub"><i>'+esc(v.produtor||"(sem produtor)")+'</i>'+(v.produtor_completo?' — '+esc(v.produtor_completo):'')+' · '+(v.ano?esc(v.ano):'sem colheita')+'</div>'+
    (f.vivino_url?'<div class="sub"><a href="'+esc(f.vivino_url)+'" target="_blank" rel="noopener noreferrer">abrir no Vivino ↗</a></div>':'')+'</div>'+
    '<div class="acoes">'+(EDITAR
      ?'<button class="prim" id="mv-guardar" onclick="guardarVinho()">Guardar</button><button onclick="editarVinho(false)">Cancelar</button>'
      :'<button class="prim" onclick="editarVinho(true)">✏️ Editar</button><button onclick="mesmoQue()" title="Este vinho é outro que já está no catálogo (escrito de outra maneira): junta-os, ou passa a ser outra colheita dele">🔗 É o mesmo que…</button><button onclick="abrirVinho('+v.id+')" title="Voltar a ler da BD">🔄</button>')+
    '<button onclick="fecharVinho()">✕ Fechar</button></div>';
  let h='';
  if(MESMO&&!EDITAR)h+='<div class="aviso"><b>Este vinho é o mesmo que…</b> <input id="mv-mesmo-q" placeholder="procura o outro (nome, produtor, ano)" oninput="mesmoProcurar()" style="width:min(360px,100%)">'+
    '<div id="mv-mesmo-l" style="margin-top:6px"></div><p class="nota">Ficam o nome, o produtor e a cor do outro. Da mesma colheita, juntam-se num só (reversível na app); de outra colheita, este passa a ser essa colheita do outro vinho.</p></div>';
  if(EDITAR){
    h+='<p class="aviso">O que corrigires fica com <b>força 4</b> nos campos de rótulo (cor, castas, teor, região…) — ninguém lhes passa por cima — e <b>3</b> na nota do Vivino, no preço e na imagem. <b>Esvaziar um campo apaga-o</b>, e apagar não o fixa: a próxima escrita de uma garrafeira pode voltar a preenchê-lo. Só vai o que mudares; fica no histórico como "painel do PC (admin)".</p>'+
      '<div class="ident"><label><input type="checkbox" id="mv-ident" onchange="document.getElementById(\\'mv-ident-c\\').hidden=!this.checked"> Mexer na identidade (nome, produtor, colheita)</label>'+
      '<div id="mv-ident-c" hidden><p class="nota">Muda a chave do vinho: se passar a ser igual a outro que já existe, não grava — juntam-se nos Duplicados da app.</p><div class="linha">'+
      '<label>Nome <input type="text" id="mv-nome" value="'+esc(v.nome)+'"></label><label>Produtor <input type="text" id="mv-produtor" value="'+esc(v.produtor||"")+'"></label>'+
      '<label>Colheita <input type="text" id="mv-ano" inputmode="numeric" maxlength="4" value="'+esc(v.ano??"")+'" style="width:80px"></label></div></div></div>';
  }
  h+='<h4>Ficha</h4><table class="ficha">';
  for(const [k,rot,tp,ops] of CAMPOS_ED){
    const x=f[k];
    if(!EDITAR){h+='<tr><td class="k">'+esc(rot)+'</td><td>'+(k==="imagem_url"&&x?'<a href="'+esc(x)+'" target="_blank" rel="noopener noreferrer">'+esc(String(x).replace(/^https?:\\/\\/(www\\.)?/,"").slice(0,70))+'</a>':valorFicha(k,x))+'</td><td class="de">'+(k in f?origemHTML(o[k]):"")+'</td></tr>';continue;}
    const val=x==null?"":Array.isArray(x)?x.join(", "):String(x);
    const semJanela=JANELA.includes(k)&&!v.ano;
    let inp;
    if(tp==="sel"){const l=ops.includes(val)?ops:[val].concat(ops);inp='<select id="mv-'+k+'">'+l.map(op=>'<option value="'+esc(op)+'"'+(op===val?" selected":"")+'>'+esc(op||"— vazio —")+'</option>').join("")+'</select>';}
    else if(tp==="area")inp='<textarea id="mv-'+k+'" rows="3">'+esc(val)+'</textarea>';
    else inp='<input type="text" id="mv-'+k+'" value="'+esc(val)+'"'+(tp==="lista"?' placeholder="separadas por vírgula"':'')+(tp==="num"||tp==="int"?' inputmode="decimal"':'')+(semJanela?' disabled title="Sem colheita não há janela de consumo"':'')+'>';
    h+='<tr><td class="k"><label for="mv-'+k+'">'+esc(rot)+'</label></td><td>'+inp+(k==="preco_medio"?'<p class="nota" id="mv-preco-aviso" hidden></p>':'')+'</td><td class="de">'+(k in f?origemHTML(o[k]):"")+'</td></tr>';
  }
  // Os campos que não estão na lista (de outra app, ou novos) aparecem na mesma — só para ler.
  const fora=Object.keys(f).filter(k=>k!=="precos"&&!CAMPOS_ED.some(c=>c[0]===k));
  for(const k of fora)h+='<tr><td class="k">'+esc(k)+'</td><td>'+valorFicha(k,f[k])+'</td><td class="de">'+origemHTML(o[k])+'</td></tr>';
  h+='</table>';
  h+=precosFichaHTML(f,o);
  const fontes=v.fontes&&typeof v.fontes==="object"?v.fontes:{};
  const fl=Object.entries(fontes).flatMap(([og,l])=>(Array.isArray(l)?l:[]).map(x=>({og,x})));
  if(fl.length)h+='<h4>Fontes</h4><ul class="lista">'+fl.slice(0,30).map(({og,x})=>'<li><span class="og">'+esc(ORIGEM_TXT[og]||og)+'</span> '+(x&&x.url?'<a href="'+esc(x.url)+'" target="_blank" rel="noopener noreferrer">'+esc(x.titulo||x.url)+'</a>':esc(x&&x.titulo||JSON.stringify(x)))+'</li>').join("")+'</ul>';
  if((v.verificacoes||[]).length)h+='<h4>Verificações do Vivino</h4><ul class="lista">'+v.verificacoes.map(x=>'<li>'+esc(dataHora(x.em))+' · <b>'+esc(x.estado)+'</b> · '+esc(x.revisao)+(x.pagina?' · <span class="nota">“'+esc(x.pagina)+'”</span>':'')+'</li>').join("")+'</ul>';
  if((v.fundidos||[]).length)h+='<h4>Fundidos nesta linha</h4><ul class="lista">'+v.fundidos.map(x=>'<li>#'+esc(x.id)+' '+esc(x.nome)+(x.produtor?' · '+esc(x.produtor):'')+(x.ano?' · '+esc(x.ano):'')+'</li>').join("")+'</ul>';
  const hist=v.historico||[];
  h+='<h4>Histórico'+(hist.length?' <span class="nota">(as últimas '+hist.length+')</span>':'')+'</h4>'+(hist.length
    ?'<table class="hist"><tr><th>Quando</th><th>Campo</th><th>Antes → depois</th><th>Quem</th></tr>'+hist.map(a=>'<tr><td class="ic">'+esc(dataHora(a.quando))+'</td><td>'+esc(a.campo==="_criado"?"criado":a.campo)+'</td><td><span class="antes">'+curto(a.antes,60)+'</span> → '+curto(a.depois,60)+(a.origem?' <span class="og">'+esc(ORIGEM_TXT[a.origem]||a.origem)+'</span>':'')+'</td><td class="nota"'+(a.autor&&a.autor!==a.quem?' title="no histórico: '+esc(a.quem||"")+'"':'')+'>'+esc(a.autor||a.quem||"")+'</td></tr>').join("")+'</table>'+
      '<p class="nota">Por trás de uma "Edge Function" (uma pesquisa com IA) ou de "uma garrafeira", quem foi descobre-se pela hora, nos registos de cada app — duas pessoas no mesmo minuto podem trocar-se.</p>'
    :'<p class="nota">Ainda sem alterações registadas (o histórico começou a 25/09/2026).</p>');
  document.getElementById("mv-corpo").innerHTML=h;
}
// Os preços de cada sítio. A editar, cada um pode ser RETIRADO (não se apaga:
// fica marcado, o script deixa de o ler e as apps não o contam — como no
// Editar da app). Retirar a fonte do preço de referência põe no campo o da
// seguinte que sobra, pela ordem de sempre.
function precosFichaHTML(f,o){
  const p=f.precos&&typeof f.precos==="object"?f.precos:{};
  const ks=Object.keys(p).filter(l=>p[l]&&p[l].preco!=null).sort((a,b)=>(PRIORIDADE.indexOf(a)+1||99)-(PRIORIDADE.indexOf(b)+1||99));
  if(!ks.length)return '';
  const fonte=fonteDoPrecoRef(f,o);
  return '<h4>Preços nas lojas</h4><ul class="lista">'+ks.map(l=>{const x=p[l];
    const t=esc(NOME_LOJA[l]||l)+' · '+esc(eur(x.preco))+(x.colheita?' · colheita '+esc(x.colheita):'');
    const a=x.url?'<a href="'+esc(x.url)+'" target="_blank" rel="noopener noreferrer">'+t+'</a>':t;
    return '<li>'+(EDITAR?'<label class="ret"><input type="checkbox" class="mv-ret" data-loja="'+esc(l)+'"'+(x.retirado?" checked":"")+' onchange="precoRetirarMudou()"> retirar</label> ':'')+
      (x.retirado&&!EDITAR?'<s>'+a+'</s> <span class="nota">· retirado à mão</span>':a)+(l===fonte?' <span class="tag">preço de referência</span>':'')+(x.em?' <span class="nota">· lido a '+esc(x.em)+'</span>':'')+'</li>';}).join("")+'</ul>';
}
function fonteDoPrecoRef(f,o){
  const precos=f.precos||{},m=Number(f.preco_medio);
  if(!(m>0))return null;
  const og=String(((o||{}).preco_medio||{}).o||"");
  const pela=og.startsWith("loja-")?og.slice(5).replace(/-/g,"_"):og.startsWith("vivino-")?"vivino":null;
  if(pela&&precos[pela])return pela;
  if(pela||og==="catalogo-admin"||og==="catalogo-pesquisa")return null;
  return PRIORIDADE.find(l=>precos[l]&&Math.abs(Number(precos[l].preco)-m)<0.005)||null;
}
function precoRetirarMudou(){
  const f=VINHO.ficha||{},precos=f.precos||{},el=document.getElementById("mv-preco_medio"),a=document.getElementById("mv-preco-aviso");
  const fonte=fonteDoPrecoRef(f,VINHO.origens||{});
  if(!el||!a||!fonte)return;
  const orig=f.preco_medio==null?"":String(f.preco_medio);
  const ret=new Set([...document.querySelectorAll(".mv-ret:checked")].map(c=>c.dataset.loja));
  const auto=el.dataset.auto;
  if(!ret.has(fonte)){if(auto!=null&&el.value===auto)el.value=orig;delete el.dataset.auto;a.hidden=true;return;}
  // Um valor escrito à mão no campo não se toca.
  if(el.value.trim()!==orig&&el.value!==auto)return;
  const nova=PRIORIDADE.concat(Object.keys(precos).filter(l=>!PRIORIDADE.includes(l)))
    .find(l=>!ret.has(l)&&precos[l]&&!precos[l].retirado&&Number(precos[l].preco)>0);
  el.value=nova?String(precos[nova].preco):"";el.dataset.auto=el.value;a.hidden=false;
  a.innerHTML=nova?'Vinha de <b>'+esc(NOME_LOJA[fonte]||fonte)+'</b>; passa a <b>'+esc(eur(precos[nova].preco))+'</b>, de <b>'+esc(NOME_LOJA[nova]||nova)+'</b>.'
    :'Vinha de <b>'+esc(NOME_LOJA[fonte]||fonte)+'</b> e não sobra outra fonte: o vinho fica <b>sem preço de referência</b>.';
}
function precosRetirados(){
  const antes=(VINHO.ficha||{}).precos,cs=[...document.querySelectorAll(".mv-ret")];
  if(!antes||!cs.length)return undefined;
  const hoje=new Date().toISOString().slice(0,10),novo=JSON.parse(JSON.stringify(antes));let mudou=false;
  cs.forEach(c=>{const x=novo[c.dataset.loja];if(!x||!!x.retirado===c.checked)return;mudou=true;
    if(c.checked){x.retirado=true;x.retirado_em=hoje;}else{delete x.retirado;delete x.retirado_em;}});
  return mudou?novo:undefined;
}
function lerValor(tp,cru){
  cru=String(cru||"").trim();
  if(cru==="")return null;
  if(tp==="lista"){const l=cru.split(",").map(x=>x.trim()).filter(Boolean);return l.length?l:null;}
  if(tp==="num"||tp==="int"){const n=parseFloat(cru.replace(",","."));return isFinite(n)?(tp==="int"?Math.round(n):n):null;}
  return cru;
}
function mesmoValor(a,b){
  const vazio=x=>x==null||x===""||(Array.isArray(x)&&!x.length);
  if(vazio(a)||vazio(b))return vazio(a)&&vazio(b);
  if(Array.isArray(a)||Array.isArray(b))return JSON.stringify([].concat(a).map(String))===JSON.stringify([].concat(b).map(String));
  if(typeof b==="number")return Number(a)===b;
  return String(a)===String(b);
}
async function guardarVinho(){
  const v=VINHO,f=v.ficha||{},campos={};
  for(const [k,,tp] of CAMPOS_ED){
    const el=document.getElementById("mv-"+k);
    if(!el||el.disabled)continue;
    const val=lerValor(tp,el.value);
    if(!mesmoValor(f[k],val))campos[k]=val;
  }
  const precos=precosRetirados();if(precos)campos.precos=precos;
  if(campos.tipo===null)return alert("A cor não pode ficar vazia — é parte da identidade do vinho.");
  const ident=document.getElementById("mv-ident").checked;
  const nome=ident?document.getElementById("mv-nome").value.trim():v.nome;
  const produtor=ident?document.getElementById("mv-produtor").value.trim():(v.produtor||"");
  const ano=ident?document.getElementById("mv-ano").value.trim():String(v.ano??"");
  if(ident&&!nome)return alert("O nome não pode ficar vazio.");
  if(ident&&ano&&!/^\\d{4}$/.test(ano))return alert("A colheita tem quatro algarismos (ou fica vazia).");
  const identMudou=ident&&(nome!==v.nome||produtor!==(v.produtor||"")||ano!==String(v.ano??""));
  const n=Object.keys(campos).length;
  if(!n&&!identMudou)return alert("Nada mudou.");
  if(!confirm("Gravar "+(n?n+" campo(s)":"")+(n&&identMudou?" e ":"")+(identMudou?"a identidade (nome/produtor/colheita)":"")+" deste vinho no catálogo?"))return;
  const b=document.getElementById("mv-guardar");if(b){b.disabled=true;b.textContent="A gravar…";}
  try{
    const r=await post("/vinho",{acao:"editar",id:v.id,campos,identidade:identMudou,nome,produtor,ano});
    alert("Gravado: "+(r.campos||0)+" corrigido(s)"+(r.apagados?", "+r.apagados+" apagado(s)":"")+(identMudou?" e a identidade":"")+". Fica no histórico.");
    EDITAR=false;await abrirVinho(v.id);carregarCatalogo();
  }catch(e){alert("Não gravou: "+e.message);if(b){b.disabled=false;b.textContent="Guardar";}}
}
const idLink=id=>'<a href="#" onclick="abrirVinho('+Number(id)+');return false" title="Abrir a ficha do vinho">#'+esc(id)+'</a>';
// "🔗 É o mesmo que…": procura o outro vinho na lista (a do separador
// Informação) e passa pela mesma "corresponde" dos Duplicados.
function mesmoQue(){MESMO=!MESMO;pintarVinho();if(MESMO)setTimeout(()=>{const q=document.getElementById("mv-mesmo-q");if(q)q.focus();},0);}
function mesmoProcurar(){
  const q=semAc(document.getElementById("mv-mesmo-q").value).split(/\\s+/).filter(Boolean),box=document.getElementById("mv-mesmo-l");
  if(!q.length){box.innerHTML="";return;}
  const cor=String((VINHO.ficha||{}).tipo||"").toLowerCase();
  const l=CAT.filter(x=>x.id!==VINHO.id&&q.every(p=>semAc([x.nome,x.produtor,x.ano,x.regiao].join(" ")).includes(p)))
    .sort((a,b)=>(String(b.tipo||"").toLowerCase()===cor)-(String(a.tipo||"").toLowerCase()===cor)||(b.campos||0)-(a.campos||0)).slice(0,10);
  box.innerHTML=l.length?'<table>'+l.map(x=>'<tr><td>'+idLink(x.id)+' <b>'+esc(x.nome)+'</b>'+(x.tipo?' <i class="nota">'+esc(String(x.tipo).toLowerCase())+'</i>':'')+' · '+(x.ano?esc(x.ano):'sem colheita')+
    '<br><span class="nota">'+esc(x.produtor||"(sem produtor)")+' · '+esc(x.campos||0)+' campos</span></td><td style="width:110px;text-align:right"><button class="prim" onclick="mesmoE('+Number(x.id)+')">É este</button></td></tr>').join("")+'</table>'
    :'<p class="nota">Nenhum com esta procura.</p>';
}
async function mesmoE(alvo){
  const r=await dupE(VINHO.id,alvo);
  if(r)await abrirVinho(r.id);
}

// ── Onde procurar ── (um visto por sítio; por omissão, todos)
const SITIOS_P=[["vivino","Vivino"],["garrafeira_nacional","Garrafeira Nacional"],["granvine","Granvine"],["vinha","Vinha.pt"]];
function sitiosHTML(p){
  document.getElementById(p+"-sitios").innerHTML='<span class="rot">Onde procurar:</span>'+
    SITIOS_P.map(([id,n])=>'<label><input type="checkbox" class="sitio-'+p+'" value="'+id+'" checked> '+esc(n)+'</label>').join("")+
    ' <a href="#" onclick="sitiosTodos(\\''+p+'\\',true);return false">todos</a> · <a href="#" onclick="sitiosTodos(\\''+p+'\\',false);return false">nenhum</a>';
  sitiosSincronizar(p);
}
function sitiosTodos(p,on){document.querySelectorAll(".sitio-"+p).forEach(c=>c.checked=on);}
function sitiosMarcar(p,ids){document.querySelectorAll(".sitio-"+p).forEach(c=>c.checked=ids.includes(c.value));sitiosSincronizar(p);}
// "Só preços" não abre o Vivino: o visto dele fica apagado (e não conta).
function sitiosSincronizar(p){
  const precos=document.getElementById(p==="cat"?"pesquisa":"novo-pesquisa").value==="precos";
  const c=document.querySelector(".sitio-"+p+'[value="vivino"]');
  if(c){c.disabled=precos;c.closest("label").classList.toggle("off",precos);c.closest("label").title=precos?"«Só preços» não abre o Vivino":"";}
}
const sitiosEscolhidos=p=>[...document.querySelectorAll(".sitio-"+p+":checked:not(:disabled)")].map(c=>c.value);

// ── Registo ──
function comecar(ir){
  visto=0;document.getElementById("log").textContent="";clearInterval(timer);timer=setInterval(seguir,1000);seguir();
  if(ir){abrirTab("info");document.getElementById("c-registo").scrollIntoView({behavior:"smooth",block:"start"});}
}
async function seguir(){
  const r=await fetch("/estado?desde="+visto).then(r=>r.json()).catch(()=>null);
  if(!r)return;
  const log=document.getElementById("log");
  if(r.linhas.length){log.textContent+=r.linhas.join("\\n")+"\\n";log.scrollTop=log.scrollHeight;}
  visto=r.total;
  const nomes={simular:"Simulação",enriquecer:"Enriquecer",gravar:"Gravar simulação",novo:"Vinho novo (simulação)"};
  document.getElementById("estado").innerHTML=r.fim==null?"⏳ "+nomes[r.modo]+(r.aParar?" a parar…":" a correr…")
    :r.parado?'<b class="ok">⏹ '+nomes[r.modo]+' parada a pedido.</b>'+(r.modo==="enriquecer"?" Os vinhos já tratados ficaram gravados.":" A simulação ficou com os vinhos já tratados.")
    :(r.codigo===0?'<b class="ok">✓ '+nomes[r.modo]+' terminou.</b>':'<b class="er">✗ '+nomes[r.modo]+' terminou com erro ('+r.codigo+').</b>');
  progresso(r);
  // Só os botões que põem o script a correr; o separador diz que está a correr.
  document.querySelectorAll("button.corre").forEach(b=>b.disabled=r.fim==null);
  document.getElementById("tab-corre").textContent=r.fim==null?" ⏳":"";
  if(r.fim!=null){clearInterval(timer);timer=null;carregarCatalogo();if(r.modo!=="enriquecer")listarSims(r.modo==="simular"||r.modo==="novo");}
}
// A barra: quantos vinhos já foram tratados (o script escreve "[3/20] …"
// antes de cada um) e quanto falta, pela média dos que já passaram. Uma
// hibernação a meio conta no tempo — o script retoma onde estava.
function progresso(r){
  const box=document.getElementById("prog"),p=r.progresso;
  if(!p){box.hidden=true;return;}
  box.hidden=false;
  // A correr, o vinho do "[i/n]" ainda está a ser tratado; no fim, já foi.
  const feitos=r.fim!=null?p.i:p.i-1;
  document.getElementById("prog-b").style.width=Math.round(100*feitos/p.n)+"%";
  let t=feitos+" de "+p.n+" tratado"+(p.n===1?"":"s");
  if(r.fim==null){
    t+=" · a tratar: "+esc(p.nome);
    const gasto=(new Date(p.em)-new Date(r.inicio))/1000;
    if(feitos>0){const min=Math.round(gasto/feitos*(p.n-feitos)/60);t+=min<1?" · falta menos de 1 min":" · faltam ~"+min+" min";}
    if(r.aParar)t+=" · <b>para no fim deste vinho</b>";
  }
  document.getElementById("prog-t").innerHTML=t;
  const b=document.getElementById("btn-parar");
  b.hidden=r.fim!=null||!r.podeParar;b.disabled=!!r.aParar;
}
async function parar(){
  if(!confirm("Parar no fim do vinho que está a tratar? Numa simulação, fica guardada com os vinhos já tratados."))return;
  try{await post("/parar",{});seguir();}catch(e){alert(e.message);}
}

// ── Simulações ──
async function listarSims(abrirPrimeira){
  const l=await fetch("/simulacoes").then(r=>r.json());const s=document.getElementById("sims");
  const atual=abrirPrimeira?l[0]:(s.value||l[0]);
  s.innerHTML=l.length?l.map(n=>'<option'+(n===atual?' selected':'')+'>'+esc(n)+'</option>').join(""):'<option value="">(ainda não há simulações)</option>';
  abrirSim();
}
function valor(c,x){
  if(x==null)return"<i>vazio</i>";
  if(Array.isArray(x))return esc(x.join(", "));
  if(typeof x==="object")return Object.entries(x).map(([k,o])=>esc(k.replace("_"," "))+" "+(o&&o.url?'<a href="'+esc(o.url)+'" target="_blank">'+esc(o.preco)+" €</a>":esc(o&&o.preco))+(o&&o.colheita?" ("+esc(o.colheita)+")":"")+(o&&o.retirado?" (retirada)":"")).join("<br>");
  const t=String(x);return /^https?:/.test(t)?'<a href="'+esc(t)+'" target="_blank">'+esc(t.replace(/^https?:\\/\\/(www\\.)?/,""))+'</a>':esc(t)+(c==="preco_medio"?" €":"");
}
async function abrirSim(){
  const n=document.getElementById("sims").value;const t=document.getElementById("tabela");
  if(!n){t.innerHTML="";document.getElementById("btn-gravar").disabled=true;return;}
  sim=await fetch("/simulacao?nome="+encodeURIComponent(n)).then(r=>r.json());simNome=n;
  const rows=[];
  (sim.vinhos||[]).forEach((v,i)=>{
    rows.push('<tr class="vinho'+(v.aplicar===false?' off':'')+'" id="v'+i+'"><td><input type="checkbox" data-v="'+i+'"'+(v.aplicar!==false?" checked":"")+' onchange="marca(this)"></td><td colspan="3">'+(v.id?idLink(v.id):'<span class="tag">novo</span>')+" "+esc(v.nome)+(v.produtor&&!v.id?' <span class="nota">· '+esc(v.produtor)+'</span>':"")+(v.ano?" "+esc(v.ano):"")+' <span class="tag">'+esc(v.estado)+'</span>'+(v.pagina?' <span class="nota">página: “'+esc(v.pagina)+'”</span>':"")+(!(v.alteracoes||[]).length?' <span class="nota">'+(v.id?"— nada a mudar; só regista a verificação":"— não se encontrou nada: é criado só com o que escreveste")+'</span>':"")+'</td></tr>');
    (v.alteracoes||[]).forEach((a,j)=>{
      // Comparado com a BD de agora (o servidor): "ja" — já lá está, não há
      // nada a fazer; "mudou" — foi corrigido depois de simular: mostra-se
      // o valor de AGORA → o da simulação, desmarcado, e decide-se.
      const ja=a.desde==="ja",mudou=a.desde==="mudou",liga=a.aplicar!==false&&!ja&&!mudou;
      rows.push('<tr class="alt'+(ja?' dim':liga?'':' off')+'"><td style="padding-left:22px"><input type="checkbox" data-v="'+i+'" data-c="'+j+'" data-campo="'+esc(a.campo)+'" data-o="'+esc(a.origem)+'"'+(ja?' data-ja="1" disabled':mudou?' data-mudou="1"':'')+(liga?" checked":"")+' onchange="marca(this)"></td><td>'+esc(a.campo)+(a.identidade?' <span class="tag" title="Faz parte da identidade do vinho (a chave). Só preenche um produtor vazio.">identidade</span>':'')+'</td><td>'+
        (ja?valor(a.campo,a.depois)+' <span class="tag">já está assim na BD</span>'
          :'<span class="antes">'+valor(a.campo,mudou?a.agora:a.antes)+'</span><span class="seta">→</span>'+valor(a.campo,a.depois)+
           (mudou?'<br><span class="tag mudou">mudou desde a simulação</span> <span class="nota">na simulação era: '+valor(a.campo,a.antes)+'</span>':''))+
        '</td><td class="nota">'+esc(a.origem)+'</td></tr>');
    });
  });
  t.innerHTML=rows.length?'<table><tr><th></th><th>Campo</th><th>Antes → depois</th><th>Origem</th></tr>'+rows.join("")+'</table>':'<p class="nota">Simulação vazia.</p>';
  document.getElementById("btn-gravar").disabled=!rows.length||!!sim.revista;
  if(sim.revista)t.insertAdjacentHTML("afterbegin",'<p class="nota">Esta simulação já foi gravada ('+esc(sim.revista)+').</p>');
  else if(sim.agora_erro)t.insertAdjacentHTML("afterbegin",'<p class="nota"><b>Não consegui reler a BD</b> ('+esc(sim.agora_erro)+'): o "antes" é o do dia da simulação.</p>');
  else{const n=(sim.vinhos||[]).reduce((s,v)=>s+(v.alteracoes||[]).filter(a=>a.desde==="mudou").length,0);
    if(n)t.insertAdjacentHTML("afterbegin",'<p class="nota"><b>'+n+' campo(s) mudaram na BD desde a simulação</b> — ficam desmarcados, com o valor de agora à esquerda. Marca os que queres trocar pelo da simulação.</p>');}
  // Um link desmarcado leva atrás o que se leu na página dele (como no marca()).
  document.querySelectorAll('#tabela input[data-campo="vivino_url"]:not(:checked):not([data-ja])').forEach(el=>marca(el));
}
function marca(el){el.closest("tr").classList.toggle("off",!el.checked);
  if(el.dataset.c==null)document.querySelectorAll('input[data-v="'+el.dataset.v+'"][data-c]:not([data-ja])').forEach(c=>{c.disabled=!el.checked;c.closest("tr").classList.toggle("dim",!el.checked);});
  // Sem o link novo, o que se leu na página dele também não entra (o script faz o mesmo).
  if(el.dataset.campo==="vivino_url")document.querySelectorAll('input[data-v="'+el.dataset.v+'"][data-o^="vivino-"]:not([data-ja])').forEach(c=>{
    if(c!==el){c.checked=el.checked&&!c.dataset.mudou;c.disabled=!el.checked;c.closest("tr").classList.toggle("off",!c.checked);}});}
async function gravar(){
  const escolhas={};
  document.querySelectorAll("#tabela input[type=checkbox]").forEach(c=>{const i=c.dataset.v;escolhas[i]=escolhas[i]||{campos:{}};
    if(c.dataset.c==null)escolhas[i].vinho=c.checked;else escolhas[i].campos[c.dataset.c]=c.checked;});
  const n=Object.values(escolhas).filter(e=>e.vinho!==false).length;
  if(!confirm("Gravar "+n+" vinho(s) desta simulação no catálogo?"))return;
  try{await post("/gravar",{nome:simNome,escolhas});comecar(true);}catch(e){alert(e.message);}
}

// ── As garrafeiras × o catálogo ──
let GARR=null;
const GARR_CASO={formato_invalido:"sem o nº do vinho",outro_vinho:"outro vinho",vazio:"sem link"};
const GARR_CONTA={mesmo_vinho:"com o mesmo vinho do catálogo",catalogo_sem_link:"sem link no catálogo",sem_catalogo:"fora do catálogo",cor_diferente:"cor diferente da do catálogo (não se toca)"};
function lnk(u){return u?'<a href="'+esc(u)+'" target="_blank" rel="noopener">'+esc(u)+'</a>':'<span class="nota">(vazio)</span>';}
async function garrProcurar(){
  document.getElementById("garr-lista").innerHTML='<p class="nota">A comparar…</p>';
  try{GARR=await post("/garrafeiras",{});garrPintar();}
  catch(e){document.getElementById("garr-lista").innerHTML='<p class="nota">Não consegui: '+esc(e.message)+'</p>';}
}
function garrPintar(){
  const L=GARR.linhas||[],P=GARR.por_confirmar||[],C=GARR.contagens||{};
  const ficam=Object.entries(GARR_CONTA).filter(([k])=>C[k]).map(([k,t])=>C[k]+" "+t).join(" · ");
  let h=L.length?'<table><tr><th></th><th>Vinho</th><th>Garrafeira</th><th>Agora → catálogo</th></tr>'+L.map(x=>
    '<tr><td><input type="checkbox" class="garr-c" data-id="'+x.vinho_id+'" checked onchange="garrBotao()"></td>'+
    '<td><b>'+esc(x.nome)+'</b>'+(x.ano?" "+esc(x.ano):"")+'<br><span class="tag">'+esc(GARR_CASO[x.caso]||x.caso)+'</span></td>'+
    '<td>'+esc(x.garrafeira)+'<br><span class="nota">'+esc(x.dono)+'</span></td>'+
    '<td><span class="antes">'+lnk(x.antes)+'</span><br>→ '+lnk(x.depois)+'<br><span class="nota">catálogo '+idLink(x.catalogo_id)+' · '+esc(x.catalogo_origem||"")+'</span></td></tr>').join("")+'</table>'
    :'<p class="nota">Nada a corrigir.</p>';
  if(P.length)h+='<p class="nota" style="margin-top:12px"><b>Por confirmar</b> — o link da garrafeira parece errado, mas o do catálogo ainda não foi confirmado. Abre os dois: se o do catálogo for o certo, marca <b>usar o do catálogo</b> e vai com «Corrigir os marcados». Na dúvida, verifica primeiro o vinho do catálogo no Vivino:</p><table>'+P.map(x=>
    '<tr><td>'+(x.catalogo_url?'<label class="nota" style="white-space:nowrap"><input type="checkbox" class="garr-f" data-id="'+x.vinho_id+'" onchange="garrBotao()"> usar o do catálogo</label>':'')+'</td>'+
    '<td><b>'+esc(x.nome)+'</b>'+(x.ano?" "+esc(x.ano):"")+'<br><span class="nota">'+esc(x.garrafeira)+' · '+esc(x.dono)+'</span></td><td><span class="antes">'+lnk(x.antes)+'</span><br>→ catálogo '+idLink(x.catalogo_id)+': '+lnk(x.catalogo_url)+'</td></tr>').join("")+
    '</table><button style="margin-top:6px" onclick="garrParaCatalogo()">Escolher estes para verificar no Vivino</button>';
  if(ficam)h+='<p class="nota">Ficam como estão: '+esc(ficam)+'.</p>';
  document.getElementById("garr-lista").innerHTML=h;
  document.getElementById("garr-n").textContent=L.length+" a corrigir"+(P.length?" · "+P.length+" por confirmar":"");
  garrBotao();
}
function garrBotao(){document.getElementById("btn-garr").disabled=!document.querySelectorAll(".garr-c:checked,.garr-f:checked").length;}
// Os "Por confirmar" passam para a escolha lá em cima, já só com o Vivino marcado.
function garrParaCatalogo(){
  for(const x of GARR.por_confirmar||[]){if(ESC.size>=50)break;ESC.add(x.catalogo_id);}
  document.getElementById("cat-so").checked=true;document.getElementById("pesquisa").value="completo";sitiosMarcar("cat",["vivino"]);
  pintarCatalogo();document.getElementById("c-escolher").scrollIntoView({behavior:"smooth",block:"start"});
  alert("Ficaram escolhidos lá em cima, só com o Vivino marcado. Simula-os (ou enriquece) e volta aqui a comparar.");
}
async function garrCorrigir(){
  const ids=[...document.querySelectorAll(".garr-c:checked")].map(c=>+c.dataset.id);
  const forcar=[...document.querySelectorAll(".garr-f:checked")].map(c=>+c.dataset.id);
  const n=ids.length+forcar.length;
  if(!n)return alert("Marca pelo menos um vinho.");
  if(!confirm("Trocar o link do Vivino de "+n+" vinho(s) nas garrafeiras pelo do catálogo?"+(forcar.length?" ("+forcar.length+" por confirmar, confirmados por ti.)":"")))return;
  try{const r=await post("/garrafeiras",{ids,forcar,aplicar:true});alert(r.aplicados+" corrigido(s). Fica registado na Garrafeira (sync_log).");await garrProcurar();}
  catch(e){alert(e.message);}
}
let FICH=null;
const FICH_CAMPO={estilo:"Estilo",mencao:"Menção",classificacao:"Classificação",regiao:"Região",sub_regiao:"Sub-região",pais:"País",teor:"Teor",estagio_meses:"Estágio (meses)",estagio_texto:"Estágio",castas:"Castas",vivino_nota:"Nota Vivino (colheita)",vivino_avaliacoes:"Avaliações (colheita)",vivino_nota_global:"Nota Vivino (todas)",vivino_avaliacoes_global:"Avaliações (todas)",imagem_url:"Imagem",preco_medio:"Preço de referência",beber_de:"Beber de",beber_ate:"Beber até",notas_prova:"Notas de prova",harmonizacao:"Harmonização",ai_resumo:"Resumo"};
const FICH_CONTA={outra_colheita:"de outra colheita (não se toca)",cor_diferente:"com cor diferente da do catálogo (não se toca)",sem_catalogo:"fora do catálogo"};
function fichValor(c,v){
  if(v==null||v==="")return '<span class="nota">(vazio)</span>';
  if(Array.isArray(v))v=v.join(", ");
  if(c==="imagem_url")return lnk(String(v));
  const t=String(v);return t.length>90?'<span title="'+esc(t)+'">'+esc(t.slice(0,90))+'…</span>':esc(t);
}
async function fichProcurar(){
  document.getElementById("fich-lista").innerHTML='<p class="nota">A comparar…</p>';
  try{FICH=await post("/fichas",{});fichPintar();}
  catch(e){document.getElementById("fich-lista").innerHTML='<p class="nota">Não consegui: '+esc(e.message)+'</p>';}
}
function fichPintar(){
  const L=FICH.linhas||[],C=FICH.contagens||{};let n=0;
  const ficam=Object.entries(FICH_CONTA).filter(([k])=>C[k]).map(([k,t])=>C[k]+" "+t).join(" · ");
  let h=L.length?'<table><tr><th></th><th>Campo</th><th>Agora</th><th>Catálogo</th></tr>'+L.map(x=>{n+=x.campos.length;
    return '<tr class="vinho"><td><input type="checkbox" checked onchange="fichVinho(this,'+x.vinho_id+')"></td><td colspan="3">'+esc(x.nome)+(x.ano?" "+esc(x.ano):"")+
      ' <span class="nota" style="font-weight:400">· '+esc(x.garrafeira)+' ('+esc(x.dono)+') · catálogo '+idLink(x.catalogo_id)+'</span></td></tr>'+
      x.campos.map(c=>'<tr class="alt"><td><input type="checkbox" class="fich-c" data-v="'+x.vinho_id+'" data-c="'+esc(c.campo)+'" checked onchange="fichMarca(this)"></td>'+
        '<td>'+esc(FICH_CAMPO[c.campo]||c.campo)+'<br><span class="tag">'+(c.caso==="vazio"?"vazio":"mais recente")+'</span></td>'+
        '<td><span class="antes">'+fichValor(c.campo,c.antes)+'</span></td>'+
        '<td>'+fichValor(c.campo,c.depois)+'<br><span class="nota">'+esc(c.origem||"")+(c.em?" · "+esc(String(c.em).slice(0,10)):"")+'</span></td></tr>').join("");}).join("")+'</table>'
    :'<p class="nota">Nada a acertar.</p>';
  if(ficam)h+='<p class="nota">Ficam como estão: '+esc(ficam)+'.</p>';
  if((FICH.erros||[]).length)h='<p class="nota" style="color:var(--er)">Não gravou: '+FICH.erros.map(e=>esc(e.nome)+" ("+esc(e.erro)+")").join("; ")+'</p>'+h;
  document.getElementById("fich-lista").innerHTML=h;
  document.getElementById("fich-n").textContent=n+" campo"+(n===1?"":"s")+" em "+L.length+" vinho"+(L.length===1?"":"s");
  document.getElementById("btn-fich").disabled=!L.length;
}
function fichMarca(el){el.closest("tr").classList.toggle("off",!el.checked);}
function fichVinho(el,id){document.querySelectorAll('.fich-c[data-v="'+id+'"]').forEach(c=>{c.checked=el.checked;c.closest("tr").classList.toggle("off",!el.checked);});el.closest("tr").classList.toggle("off",!el.checked);}
async function fichCorrigir(){
  const por={};document.querySelectorAll(".fich-c:checked").forEach(c=>{(por[c.dataset.v]=por[c.dataset.v]||[]).push(c.dataset.c);});
  const itens=Object.entries(por).map(([v,campos])=>({vinho_id:+v,campos}));
  const n=itens.reduce((a,x)=>a+x.campos.length,0);
  if(!n)return alert("Marca pelo menos um campo.");
  if(!confirm("Trazer do catálogo "+n+" campo(s) em "+itens.length+" vinho(s) das garrafeiras?"))return;
  try{const r=await post("/fichas",{itens,aplicar:true});
    alert(r.aplicados+" campo(s) em "+r.vinhos_aplicados+" vinho(s). Fica registado na Garrafeira (sync_log)."+((r.erros||[]).length?" Não gravou "+r.erros.length+" — ver a lista.":""));
    const erros=r.erros||[];await fichProcurar();if(erros.length){FICH.erros=erros;fichPintar();}}
  catch(e){alert(e.message);}
}

// ── Vinho novo ──
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
  try{await post("/novo",{vinhos,pesquisa:document.getElementById("novo-pesquisa").value,sitios:sitiosEscolhidos("novo")});comecar(true);}catch(e){alert(e.message);}
}

// ── Nomes de vinhos ──
let NOMES=null;const NOMES_OFF=new Set();   // os desmarcados à mão (sobrevivem aos filtros)
const NOMES_MUD={ano:"sai a colheita",produtor:"sai o produtor",produtor_entra:"entra o produtor",cor:"sai a cor"};
const nomesChave=x=>x.fonte+":"+x.id;
async function nomesProcurar(){
  document.getElementById("nomes-lista").innerHTML='<p class="nota">A simular…</p>';
  try{NOMES=await post("/nomes",{});NOMES_OFF.clear();nomesPintar();}
  catch(e){document.getElementById("nomes-lista").innerHTML='<p class="nota">Não consegui: '+esc(e.message)+'</p>';}
}
function nomesMuda(x){return x.novo_nome!==x.nome||String(x.novo_ano??"")!==String(x.ano??"");}
function nomesVisiveis(){
  const so=document.getElementById("nomes-so").checked,onde=document.getElementById("nomes-onde").value,mud=document.getElementById("nomes-mud").value,q=palavras("nomes-q");
  return (NOMES.linhas||[]).filter(x=>(!so||nomesMuda(x))&&(!onde||x.fonte===onde)
    &&(!mud||(mud==="avisos"?(x.avisos||[]).length>0:(x.mudancas||[]).includes(mud)))
    &&(!q.length||(t=>q.every(p=>t.includes(p)))(semAc([x.nome,x.novo_nome,x.produtor,x.garrafeira,x.dono,x.ano,x.fonte==="catalogo"?"catalogo #"+x.id:""].join(" ")))));
}
const nomesMarcados=()=>nomesVisiveis().filter(x=>nomesMuda(x)&&!NOMES_OFF.has(nomesChave(x)));
// Os desmarcados que se veem e a quem a regra tirava o produtor: é isso que se mantém.
const nomesAManter=()=>nomesVisiveis().filter(x=>NOMES_OFF.has(nomesChave(x))&&(x.mudancas||[]).includes("produtor"));
function nomesContar(){
  const todos=NOMES.linhas||[],vis=nomesVisiveis().length,m=nomesMarcados().length;
  document.getElementById("nomes-n").textContent=todos.filter(nomesMuda).length+" a mudar agora · "+todos.length+" com alguma coisa · "+vis+" à vista · "+m+" marcado"+(m===1?"":"s");
  const b=document.getElementById("btn-nomes");b.disabled=!m;b.textContent="Aplicar os marcados"+(m?" ("+m+")":"");
  const k=nomesAManter().length,bm=document.getElementById("btn-nomes-manter");bm.disabled=!k;bm.textContent="Manter o produtor no nome"+(k?" ("+k+")":"");
}
function nomesPintar(){
  if(!NOMES)return;
  const L=nomesVisiveis();
  document.getElementById("nomes-lista").innerHTML=L.length?'<table><tr><th></th><th>Onde</th><th>Agora</th><th>Fica</th></tr>'+L.map(x=>{
    const m=nomesMuda(x),on=m&&!NOMES_OFF.has(nomesChave(x));
    const av=(x.avisos||[]).length?'<br><span class="tag">'+x.avisos.map(esc).join(' · ')+'</span>':'';
    const mud=(x.mudancas||[]).map(k=>'<span class="tag">'+esc(NOMES_MUD[k]||k)+'</span>').join(' ');
    return '<tr'+(on?'':' class="off"')+'><td>'+(m?'<input type="checkbox" class="nomes-c" data-f="'+x.fonte+'" data-id="'+x.id+'"'+(on?' checked':'')+' onchange="nomesMarca(this)">':'')+'</td>'+
      '<td>'+(x.fonte==="catalogo"?'catálogo #'+x.id:esc(x.garrafeira||"garrafeira")+'<br><span class="nota">'+esc(x.dono||"")+'</span>')+'</td>'+
      '<td><span class="antes">'+esc(x.nome)+'</span>'+(x.ano?' · '+esc(x.ano):'')+'<br><span class="nota">'+esc(x.produtor||"(sem produtor)")+' · '+esc(x.tipo||"sem cor")+'</span></td>'+
      '<td><b>'+esc(x.novo_nome)+'</b>'+(x.novo_ano?' · '+esc(x.novo_ano):'')+' '+mud+av+'</td></tr>';}).join("")+'</table>'
    :'<p class="nota">'+((NOMES.linhas||[]).length?"Nenhum com estes filtros.":"Nada a mudar.")+'</p>';
  nomesContar();
}
function nomesMarca(el){const k=el.dataset.f+":"+el.dataset.id;if(el.checked)NOMES_OFF.delete(k);else NOMES_OFF.add(k);el.closest("tr").classList.toggle("off",!el.checked);nomesContar();}
function nomesMarcar(on){for(const x of nomesVisiveis())if(nomesMuda(x)){if(on)NOMES_OFF.delete(nomesChave(x));else NOMES_OFF.add(nomesChave(x));}nomesPintar();}
async function nomesAplicar(){
  // Só os que se veem: o que os filtros escondem não vai, mesmo marcado.
  const itens=nomesMarcados().map(x=>({fonte:x.fonte,id:x.id}));
  if(!itens.length)return alert("Marca pelo menos um vinho.");
  if(!confirm("Aplicar o nome novo a "+itens.length+" vinho(s) — os marcados que se veem? Fica no histórico do catálogo e no registo da Garrafeira."))return;
  try{const r=await post("/nomes",{itens,aplicar:true});const d=r.duplicados||[];
    alert(r.catalogo+" no catálogo e "+r.garrafeiras+" nas garrafeiras."+(d.length?"\\n\\nFicaram por mexer "+d.length+" do catálogo, porque passavam a ser o mesmo vinho e colheita que outro — junta-os nos Duplicados da app:\\n"+d.map(x=>"#"+x.id+" "+x.nome+(x.ano?" "+x.ano:"")+" → #"+x.com).join("\\n"):""));
    await nomesProcurar();}
  catch(e){alert(e.message);}
}
async function nomesManter(){
  const itens=nomesAManter().map(x=>({fonte:x.fonte,id:x.id}));
  if(!itens.length)return alert("Desmarca os vinhos cujo produtor deve ficar no nome (os que o perdiam da frente).");
  const prods=[...new Set(nomesAManter().map(x=>x.produtor||""))].filter(Boolean);
  if(!confirm("Nos vinhos destes produtores, o produtor fica no nome — e entra à frente, se lá não estiver (agora e nos que vierem; a colheita e a cor no fim continuam a sair):\\n\\n"+prods.join("\\n")))return;
  try{const r=await post("/nomes",{acao:"manter",itens});alert(r.marcados+" produtor(es) acrescentado(s) à lista.");await nomesProcurar();if(PROD)prodProcurar();
    const d=document.getElementById("nomes-manter").closest("details");if(d.open)nomesManterListar();}
  catch(e){alert(e.message);}
}
async function nomesManterListar(){
  const el=document.getElementById("nomes-manter");el.innerHTML='<p class="nota">A carregar…</p>';
  try{const L=await post("/nomes",{acao:"listar"});
    el.innerHTML=L.length?L.map(m=>'<div>'+esc(m.produtor)+' <a href="#" data-k="'+esc(m.chave)+'" onclick="nomesManterTirar(this.dataset.k);return false" title="Deixar a regra voltar a tirar este produtor da frente dos nomes">✕</a></div>').join(""):'<p class="nota">Nenhum.</p>';}
  catch(e){el.innerHTML='<p class="nota">Não consegui: '+esc(e.message)+'</p>';}
}
async function nomesManterTirar(k){
  if(!confirm("Tirar da lista? O nome volta a aparecer na simulação."))return;
  try{await post("/nomes",{acao:"tirar",chave:k});await nomesManterListar();await nomesProcurar();if(PROD)prodProcurar();}catch(e){alert(e.message);}
}

// ── Produtores ──
// Três vistas (28/09/2026, o dono: "grafismo esquisito/confuso"): as
// sugestões por decidir, os produtores oficiais (um cartão cada, as grafias
// em pastilhas, "+ grafia" e ✏️ para o nome) e o produtor no nome dos vinhos.
// O resultado de cada ação fica no cartão onde se carregou (PROD_RES) e diz o
// que aconteceu a cada grafia — o "0 vinhos" num alert fazia parecer que nada
// tinha acontecido quando a grafia já era do produtor (a mesma chave).
let PROD=null,PROD_VISTA=null;const PROD_RES={},PROD_ED=new Set(),PROD_GR=new Set();
// As sugestões vêm aos pares; juntam-se em grupos (os três Carlos Alonso
// num só) para se escolher o oficial uma vez. Os pares ficam guardados para
// o "não são o mesmo", que só faz sentido entre dois.
function prodGrupos(pares){
  const pai={},ref=x=>pai[x]===undefined?(pai[x]=x):(pai[x]===x?x:(pai[x]=ref(pai[x])));
  const info={};
  for(const p of pares){for(const s of [p.a,p.b])info[s.produtor]=s;const ra=ref(p.a.produtor),rb=ref(p.b.produtor);if(ra!==rb)pai[ra]=rb;}
  const g={};for(const n of Object.keys(info))(g[ref(n)]=g[ref(n)]||[]).push(info[n]);
  return Object.values(g).map(l=>l.sort((x,y)=>(y.catalogo+y.garrafeiras)-(x.catalogo+x.garrafeiras)))
    .map(l=>({grafias:l,pares:pares.filter(p=>l.some(s=>s.produtor===p.a.produtor))}))
    .sort((a,b)=>a.grafias[0].produtor.localeCompare(b.grafias[0].produtor,"pt"));
}
function prodVista(v){
  PROD_VISTA=v;try{localStorage.setItem("prod_vista",v);}catch(e){}
  document.querySelectorAll("#prod-seg button").forEach(b=>b.classList.toggle("on",b.dataset.v===v));
  for(const x of ["sug","of","nn"])document.getElementById("prod-v-"+x).hidden=x!==v;
}
async function prodProcurar(){
  if(!PROD)document.getElementById("prod-lista").innerHTML='<p class="nota">A procurar…</p>';
  try{
    PROD=await post("/produtores",{acao:"listar"});PROD._grupos=prodGrupos(PROD.sugestoes||[]);
    if(!PROD_VISTA){let v=null;try{v=localStorage.getItem("prod_vista");}catch(e){}
      prodVista(["sug","of","nn"].includes(v)?v:(PROD._grupos.length?"sug":"of"));}
    prodPintar();
  }catch(e){PROD_RES.topo={tipo:"er",html:"Não consegui ler os produtores: "+esc(e.message)};
    document.getElementById("prod-msg").innerHTML=prodResHTML("topo");}
}
const prodN=p=>(+p.catalogo||0)+' no catálogo · '+(+p.garrafeiras||0)+' nas garrafeiras';
function prodPintar(){
  if(!PROD)return;
  const q=palavras("prod-q"),bate=t=>!q.length||q.every(p=>semAc(t).includes(p));
  document.getElementById("prod-n-sug").textContent=PROD._grupos.length;
  document.getElementById("prod-n-of").textContent=(PROD.oficiais||[]).length;
  document.getElementById("prod-n-nn").textContent=(PROD.noNome||[]).length;
  document.getElementById("prod-msg").innerHTML=prodResHTML("topo");
  // As grafias que existem (catálogo e garrafeiras), para o "+ grafia" e a lista do nome sugerirem.
  document.getElementById("prod-grafias").innerHTML=(PROD.grafias||[]).map(g=>'<option value="'+esc(g.produtor)+'">'+
    esc(g.catalogo+' no catálogo · '+g.garrafeiras+' nas garrafeiras'+(g.oficial?' · é de '+g.oficial:''))+'</option>').join("");
  prodPintarSug(bate);prodPintarOf(bate);prodPintarNN(bate);
}
// O resultado de uma ação, no sítio onde se carregou ("topo", "nn" ou "po-<id>").
function prodResHTML(a){
  const r=PROD_RES[a];if(!r)return "";
  if(r.prev)return prodPrevHTML(a,r.prev);
  return '<div class="msg'+(r.tipo==="ok"?'':' '+r.tipo)+'"><div>'+r.html+'</div>'+prodFechaHTML(a)+'</div>';
}
const prodFechaHTML=a=>'<a href="#" class="fecha" title="Fechar" data-a="'+esc(a)+'" onclick="prodFechar(this.dataset.a);return false">✕</a>';
function prodFechar(a){delete PROD_RES[a];prodPintar();}

// ─ Por decidir ─
function prodPintarSug(bate){
  const G=PROD._grupos.map((g,i)=>({g,i})).filter(({g})=>bate(g.grafias.map(s=>s.produtor+" "+(s.oficial||"")).join(" ")));
  document.getElementById("prod-lista").innerHTML=G.length?G.map(({g,i})=>{
    const oficial=(g.grafias.find(s=>s.oficial)||{}).oficial||"";
    const dif=g.pares.map((p,k)=>({p,k})).filter(({p})=>!p.mesmaChave);
    return '<div class="pg" data-i="'+i+'"><div class="pg-tit">'+(dif.length?'Serão o mesmo produtor?'
        :'O mesmo produtor, escrito de maneiras diferentes <span class="tag" title="Dão a mesma chave: para o catálogo já são o mesmo produtor. Só falta escolher como se escreve.">mesma chave</span>')+'</div>'+
      '<table><tr><th class="c">É ele</th><th>Grafia</th><th>Vinhos</th><th class="c">Nome oficial</th></tr>'+
      g.grafias.map((s,j)=>'<tr><td class="c"><input type="checkbox" class="prod-inc" data-p="'+esc(s.produtor)+'" checked onchange="prodGrupoBotao('+i+')"></td>'+
        '<td><b>'+esc(s.produtor)+'</b>'+(s.oficial?'<br><span class="nota">já é do produtor <b>'+esc(s.oficial)+'</b></span>':'')+'</td>'+
        '<td class="nota">'+s.catalogo+' no catálogo · '+s.garrafeiras+' nas garrafeiras</td>'+
        '<td class="c"><input type="radio" name="prod-of-'+i+'" value="'+esc(s.produtor)+'"'+((oficial?s.produtor===oficial:j===0)?' checked':'')+' onchange="prodGrupoBotao('+i+')"></td></tr>').join("")+
      '<tr><td></td><td colspan="2"><input type="text" class="prod-outro" placeholder="…ou escreve outro nome oficial" oninput="prodGrupoOutro('+i+')"></td>'+
        '<td class="c"><input type="radio" name="prod-of-'+i+'" value="__outro" onchange="prodGrupoBotao('+i+')"></td></tr></table>'+
      '<div class="rod"><button class="prim" id="prod-b-'+i+'" onclick="prodJuntar('+i+')">Juntar</button>'+
        dif.map(({p,k})=>'<button onclick="prodDiferentes('+i+','+k+')">'+(dif.length>1?esc(p.a.produtor)+' ≠ '+esc(p.b.produtor):'Não são o mesmo')+'</button>').join("")+'</div></div>';
  }).join(""):'<p class="nota">'+(PROD._grupos.length?"Nenhuma com esta procura.":"Nada por decidir.")+'</p>';
  for(const {i} of G)prodGrupoBotao(i);
}
function prodGrupoEscolha(i){
  const el=document.querySelector('.pg[data-i="'+i+'"]'),r=el.querySelector('input[name="prod-of-'+i+'"]:checked');
  let oficial=r?r.value:"";if(oficial==="__outro")oficial=el.querySelector(".prod-outro").value.trim();
  return {oficial,grafias:[...el.querySelectorAll(".prod-inc:checked")].map(c=>c.dataset.p)};
}
function prodGrupoOutro(i){
  const r=document.querySelector('.pg[data-i="'+i+'"] input[name="prod-of-'+i+'"][value="__outro"]');if(r)r.checked=true;prodGrupoBotao(i);
}
// O botão diz o que vai fazer: "Juntar 2 grafias em «Duorum»".
function prodGrupoBotao(i){
  const b=document.getElementById("prod-b-"+i);if(!b)return;
  const {oficial,grafias}=prodGrupoEscolha(i),n=grafias.filter(x=>x!==oficial).length;
  b.disabled=!oficial||!n;
  b.textContent=!oficial?"Escolhe o nome oficial":!n?"Marca as grafias que são ele":"Juntar "+n+" grafia"+(n===1?"":"s")+" em «"+oficial+"»";
}
async function prodJuntar(i){
  const g=PROD._grupos[i],{oficial,grafias}=prodGrupoEscolha(i);
  if(!oficial||!grafias.filter(x=>x!==oficial).length)return;
  const tot=g.grafias.filter(s=>grafias.includes(s.produtor)&&s.produtor!==oficial).reduce((a,s)=>a+s.catalogo+s.garrafeiras,0);
  if(!confirm('Passar a "'+oficial+'" as grafias: '+grafias.filter(x=>x!==oficial).join(" · ")+'?\\n\\n'+tot+' vinho(s) no catálogo e nas garrafeiras ficam com este nome, agora e em qualquer escrita futura.'))return;
  try{await prodResultado(await post("/produtores",{acao:"definir",oficial,grafias}),"topo");}
  catch(e){PROD_RES.topo={tipo:"er",html:esc(e.message)};prodPintar();}
}
async function prodDiferentes(i,k){
  const p=PROD._grupos[i].pares[k];
  if(!confirm('"'+p.a.produtor+'" e "'+p.b.produtor+'" são produtores diferentes? O par não volta a ser sugerido.'))return;
  try{await post("/produtores",{acao:"diferentes",a:p.a.produtor,b:p.b.produtor});
    PROD_RES.topo={tipo:"ok",html:'«'+esc(p.a.produtor)+'» e «'+esc(p.b.produtor)+'» ficam como produtores diferentes.'};await prodProcurar();}
  catch(e){PROD_RES.topo={tipo:"er",html:esc(e.message)};prodPintar();}
}
// O que a produtor_definir fez, grafia a grafia (db/produtores.sql).
function prodResumo(r){
  const of='«'+esc(r.oficial)+'»',L=[];
  for(const g of r.grafias||[]){
    if(String(g.escrito).toLowerCase()===String(r.oficial).toLowerCase())continue;
    const e='«'+esc(g.escrito)+'»';
    if(g.estado==="nova")L.push(e+' passa a ser '+of+'.');
    else if(g.estado==="de_outro")L.push(e+' era do produtor «'+esc(g.de)+'» e passou para '+of+'.');
    else if(g.estado==="ja_estava")L.push(e+' já estava nas grafias de '+of+'.');
    else L.push(e+' já era tratado como '+of+' — dá a mesma chave'+(g.como&&g.como!==r.oficial?' que «'+esc(g.como)+'»':'')+' (palavras como "Herdade", "Quinta", "Casa", "do", "Vinhos" não contam). Fica agora à vista, nas grafias.');
  }
  const d=r.duplicados||[];
  let h='<b>'+esc(r.oficial)+'</b> ✓'+(L.length?'<ul>'+L.map(x=>'<li>'+x+'</li>').join("")+'</ul>':'')+
    '<div style="margin-top:4px">'+(r.catalogo||r.garrafeiras?'Vinhos corrigidos: <b>'+r.catalogo+'</b> no catálogo e <b>'+r.garrafeiras+'</b> nas garrafeiras.'
      :'Nenhum vinho estava escrito de outra maneira — vale para os que vierem.')+'</div>';
  if(d.length)h+='<div style="margin-top:6px">Ficaram por mexer '+d.length+', porque passavam a ser o mesmo vinho e colheita que outro — junta-os nos <a href="#duplicados">Duplicados</a>:<ul>'+
    d.map(x=>'<li><a href="#" onclick="abrirVinho('+Number(x.id)+');return false">#'+esc(x.id)+' '+esc(x.nome)+(x.ano?' '+esc(x.ano):'')+'</a> → <a href="#" onclick="abrirVinho('+Number(x.com)+');return false">#'+esc(x.com)+'</a></li>').join("")+'</ul></div>';
  return {tipo:d.length?"av":"ok",html:h};
}
function prodResultado(r,alvo){
  PROD_RES[alvo]=prodResumo(r);
  // os nomes dos vinhos mudaram: a lista e os Duplicados voltam a ler
  carregarCatalogo();dupProcurar();
  return prodProcurar();
}

// ─ Produtores oficiais ─
function prodChips(p){
  let h=(p.variantes||[]).map(v=>{
    const es=v.escritos&&v.escritos.length?v.escritos:[v.escrito];
    return '<span class="chip'+(v.oficial?' of':' x')+'" title="'+(v.oficial?'A grafia do nome oficial':'Uma grafia deste produtor')+(es.length>1?' — estas dão a mesma chave':'')+'">'+
      es.map(esc).join('<span class="eq">=</span>')+
      (v.oficial?'':'<a href="#" title="Deixar de trocar esta grafia pelo nome oficial (o que já foi corrigido fica)" data-k="'+esc(v.chave)+'" data-id="'+p.id+'" onclick="prodTirar(this.dataset.k,+this.dataset.id);return false">✕</a>')+'</span>';
  }).join("");
  if(PROD_GR.has(p.id))h+='<input type="text" id="prod-graf-'+p.id+'" list="prod-grafias" placeholder="outra grafia de '+esc(p.nome)+'" onkeydown="if(event.key===\\'Enter\\')prodAcrescentar('+p.id+')">'+
    '<button class="prim" onclick="prodAcrescentar('+p.id+')">Acrescentar</button><button onclick="prodGrafia('+p.id+',false)">Cancelar</button>';
  else h+='<button class="mais" onclick="prodGrafia('+p.id+',true)" title="Outra maneira de escrever este produtor">+ grafia</button>';
  return h;
}
function prodPintarOf(bate){
  const O=(PROD.oficiais||[]).filter(p=>bate([p.nome,p.nome_completo,...(p.variantes||[]).flatMap(v=>v.escritos||[v.escrito])].join(" ")));
  document.getElementById("prod-oficiais").innerHTML=O.length?O.map(p=>{
    const ed=PROD_ED.has(p.id);
    return '<div class="po" id="po-'+p.id+'"><div class="po-cab">'+
      '<div class="po-nome"><b>'+esc(p.nome)+'</b>'+(p.nome_completo&&p.nome_completo!==p.nome?'<i>'+esc(p.nome_completo)+'</i>':'')+'</div>'+
      '<span class="po-n">'+prodN(p)+'</span>'+
      '<label class="nn'+(p.no_nome?' on':'')+'" title="Nos vinhos deste produtor, o nome do produtor aparece sempre no nome do vinho (entra à frente, se faltar)">'+
        '<input type="checkbox"'+(p.no_nome?' checked':'')+' onchange="prodNoNome('+p.id+',this.checked)"> no nome dos vinhos</label>'+
      '<button'+(ed?' class="prim"':'')+' onclick="prodEditar('+p.id+')" title="Mudar o nome oficial ou o nome completo">✏️</button></div>'+
      '<div class="chips">'+prodChips(p)+'</div>'+
      (ed?'<div class="po-edit">'+
        '<span class="rot">Nome oficial</span><input id="prod-nome-'+p.id+'" value="'+esc(p.nome)+'"><button onclick="prodRenomear('+p.id+')">Mudar</button>'+
        '<span class="rot">Nome completo</span><input id="prod-compl-'+p.id+'" value="'+esc(p.nome_completo||"")+'" placeholder="opcional"><button onclick="prodCompleto('+p.id+')">Guardar</button>'+
        '<p class="nota">Mudar o nome oficial muda-o em todos os vinhos deste produtor, no catálogo e nas garrafeiras (o nome antigo fica como grafia). O nome completo ("Quinta Nova de Nossa Senhora do Carmo") só se lê na ficha do vinho: não mexe em vinho nenhum.</p></div>':'')+
      (PROD_RES["po-"+p.id]?'<div class="po-res">'+prodResHTML("po-"+p.id)+'</div>':'')+'</div>';
  }).join(""):'<p class="nota">'+((PROD.oficiais||[]).length?"Nenhum com esta procura.":"Ainda nenhum — junta grafias em «Por decidir».")+'</p>';
}
function prodEditar(id){if(PROD_ED.has(id))PROD_ED.delete(id);else PROD_ED.add(id);prodPintar();const el=document.getElementById("prod-nome-"+id);if(el)el.focus();}
function prodGrafia(id,on){if(on)PROD_GR.add(id);else PROD_GR.delete(id);prodPintar();const el=document.getElementById("prod-graf-"+id);if(el)el.focus();}
async function prodCompleto(id){
  const v=document.getElementById("prod-compl-"+id).value.trim();
  try{await post("/produtores",{acao:"completo",id,completo:v});
    PROD_RES["po-"+id]={tipo:"ok",html:v?"Nome completo guardado.":"Nome completo retirado."};PROD_ED.delete(id);await prodProcurar();}
  catch(e){PROD_RES["po-"+id]={tipo:"er",html:esc(e.message)};prodPintar();}
}
// Mudar o nome oficial (27/09/2026): o antigo fica como grafia, e os vinhos
// dele passam ao novo no catálogo e nas garrafeiras (produtor_renomear).
async function prodRenomear(id){
  const p=(PROD.oficiais||[]).find(x=>x.id===id),nome=document.getElementById("prod-nome-"+id).value.trim();
  if(!p)return;
  if(!nome)return alert("Escreve o nome oficial.");
  if(nome===p.nome)return alert("O nome não mudou.");
  if(!confirm('Mudar o nome oficial "'+p.nome+'" para "'+nome+'"?\\n\\nOs vinhos deste produtor, no catálogo e em todas as garrafeiras, passam a "'+nome+'". "'+p.nome+'" fica como grafia: quem o escrever continua a cair aqui.'))return;
  try{const r=await post("/produtores",{acao:"renomear",id,nome});PROD_ED.delete(id);await prodResultado(r,"po-"+id);}
  catch(e){PROD_RES["po-"+id]={tipo:"er",html:esc(e.message)};prodPintar();}
}
// Acrescentar uma grafia a um oficial que já existe: é a mesma "definir". Só
// se pergunta quando mexe em vinhos ou tira a grafia a outro produtor.
async function prodAcrescentar(id){
  const p=(PROD.oficiais||[]).find(x=>x.id===id),el=document.getElementById("prod-graf-"+id),g=el?el.value.trim():"";
  if(!p)return;
  if(!g)return alert("Escreve (ou escolhe da lista) a outra grafia.");
  const info=(PROD.grafias||[]).find(x=>x.produtor.toLowerCase()===g.toLowerCase());
  if(info&&info.oficial&&info.oficial!==p.nome){
    if(!confirm('"'+g+'" é hoje do produtor "'+info.oficial+'". Passa para "'+p.nome+'"?\\n\\n'+info.catalogo+' vinho(s) no catálogo e '+info.garrafeiras+' nas garrafeiras escritos assim passam a "'+p.nome+'".'))return;
  }else if(info&&!info.oficial&&info.catalogo+info.garrafeiras>0){
    if(!confirm('"'+g+'" é o produtor "'+p.nome+'"?\\n\\n'+info.catalogo+' vinho(s) no catálogo e '+info.garrafeiras+' nas garrafeiras escritos assim passam a "'+p.nome+'", agora e em qualquer escrita futura.'))return;
  }
  try{const r=await post("/produtores",{acao:"definir",oficial:p.nome,grafias:[g]});PROD_GR.delete(id);await prodResultado(r,"po-"+id);}
  catch(e){PROD_RES["po-"+id]={tipo:"er",html:esc(e.message)};prodPintar();}
}
async function prodTirar(chave,id){
  if(!confirm("Deixar de trocar esta grafia pelo nome oficial? O que já foi corrigido fica como está."))return;
  try{await post("/produtores",{acao:"tirar",chave});PROD_RES["po-"+id]={tipo:"ok",html:"Grafia retirada: deixa de ser trocada pelo nome oficial daqui para a frente."};await prodProcurar();}
  catch(e){PROD_RES["po-"+id]={tipo:"er",html:esc(e.message)};prodPintar();}
}

// ─ O produtor no nome dos vinhos ─ (db/nomes-manter.sql + a nome_normal)
// Ligar ou desligar é só a lista: vale logo para os vinhos que vierem. Os
// que já cá estão mudam de nome depois de se ver quais — a simulação só
// desse produtor, com um visto por vinho (a mesma nomes_rever dos Nomes).
function prodPintarNN(bate){
  const L=(PROD.noNome||[]).filter(m=>bate(m.produtor)),of=k=>(PROD.oficiais||[]).find(p=>p.chave===k);
  document.getElementById("prod-nn").innerHTML=prodResHTML("nn")+(L.length?L.map(m=>{const p=of(m.chave);
    // sem nome oficial, os vinhos escritos com a mesma chave
    const n=p||(PROD.grafias||[]).filter(g=>g.chave===m.chave).reduce((a,g)=>({catalogo:a.catalogo+g.catalogo,garrafeiras:a.garrafeiras+g.garrafeiras}),{catalogo:0,garrafeiras:0});
    return '<div class="nn-l"><b>'+esc(m.produtor)+'</b><span class="po-n">'+prodN(n)+'</span>'+
      '<button data-p="'+esc(m.produtor)+'" onclick="prodNoNomeVer(this.dataset.p)">Ver os nomes</button>'+
      '<button data-p="'+esc(m.produtor)+'" data-k="'+esc(m.chave)+'" onclick="prodNoNomeMudar(this.dataset.p,this.dataset.k,false,\\'nn\\')">Tirar</button></div>';}).join("")
    :'<p class="nota">'+((PROD.noNome||[]).length?"Nenhum com esta procura.":"Nenhum ainda.")+'</p>');
}
function prodNoNome(id,ligar){
  const p=(PROD.oficiais||[]).find(x=>x.id===id);if(!p)return;
  return prodNoNomeMudar(p.nome,p.chave,ligar,"po-"+id);
}
async function prodNoNomeAcrescentar(){
  const el=document.getElementById("prod-nn-novo"),nome=el.value.trim();
  if(!nome)return alert("Escreve (ou escolhe da lista) o produtor.");
  el.value="";return prodNoNomeMudar(nome,"",true,"nn");
}
async function prodNoNomeMudar(nome,chave,ligar,alvo){
  if(!ligar&&!confirm('Tirar "'+nome+'" da lista? Nos vinhos dele, a regra volta a tirar o produtor da frente do nome quando o que sobra se aguenta sozinho.'))return prodPintar();
  try{await post("/produtores",ligar?{acao:"no_nome",ligar:true,produtor:nome}:{acao:"no_nome",ligar:false,chave});}
  catch(e){PROD_RES[alvo]={tipo:"er",html:esc(e.message)};return prodPintar();}
  PROD_RES[alvo]={prev:{produtor:nome,ligar,estado:"carregar"}};
  await prodProcurar();
  return prodPrever(alvo);
}
function prodNoNomeVer(nome){PROD_RES.nn={prev:{produtor:nome,so_ver:true,estado:"carregar"}};return prodPrever("nn");}
async function prodPrever(alvo){
  const pv=PROD_RES[alvo]&&PROD_RES[alvo].prev;if(!pv)return;
  pv.estado="carregar";prodPintar();
  try{const r=await post("/nomes",{produtor:pv.produtor});pv.linhas=(r.linhas||[]).filter(nomesMuda);pv.off=new Set();pv.estado="ok";}
  catch(e){pv.estado="erro";pv.erro=e.message;}
  prodPintar();
}
function prodPrevHTML(a,pv){
  const tit=pv.so_ver?'Os vinhos de «'+esc(pv.produtor)+'».':pv.ligar?'«'+esc(pv.produtor)+'» passa a aparecer no nome dos vinhos.':'«'+esc(pv.produtor)+'» saiu da lista.';
  const caixa=(cls,h)=>'<div class="msg'+cls+'"><div>'+tit+' '+h+'</div>'+prodFechaHTML(a)+'</div>';
  if(pv.estado==="carregar")return caixa("",'A ver os nomes dos vinhos dele…');
  if(pv.estado==="erro")return caixa(" er",'Não consegui ver os nomes: '+esc(pv.erro));
  if(pv.feito)return caixa("",pv.feito);
  const L=pv.linhas||[];
  if(!L.length)return caixa("",'Nenhum nome muda'+(pv.ligar||pv.so_ver?' — os vinhos dele já estão como a regra diz.':'.')+(pv.so_ver?'':' Os que vierem já seguem a regra.'));
  const m=L.filter(x=>!pv.off.has(nomesChave(x))).length;
  return caixa(" av",(pv.so_ver?'':'Os vinhos que vierem já seguem a regra; ')+'<b>'+L.length+'</b> que já cá estão mudam de nome — desmarca os que não queres:'+
    '<div class="prev"><table>'+L.map(x=>{const on=!pv.off.has(nomesChave(x));
      return '<tr'+(on?'':' class="off"')+'><td style="width:28px"><input type="checkbox"'+(on?' checked':'')+' data-a="'+esc(a)+'" data-k="'+esc(nomesChave(x))+'" onchange="prodPrevMarca(this)"></td>'+
        '<td class="nota" style="white-space:nowrap">'+(x.fonte==="catalogo"?'<a href="#" onclick="abrirVinho('+Number(x.id)+');return false">catálogo #'+esc(x.id)+'</a>'
          :esc(x.garrafeira||"garrafeira")+(x.dono?' · '+esc(x.dono):''))+'</td>'+
        '<td><span class="antes">'+esc(x.nome)+'</span><span class="seta">→</span><b>'+esc(x.novo_nome)+'</b>'+
          (String(x.novo_ano??"")!==String(x.ano??"")?' · '+esc(x.novo_ano):'')+'</td></tr>';}).join("")+'</table></div>'+
    '<div class="linha"><button class="prim" data-a="'+esc(a)+'" onclick="prodPrevAplicar(this.dataset.a)"'+(m?'':' disabled')+'>Aplicar a '+m+' vinho'+(m===1?'':'s')+'</button>'+
      '<button data-a="'+esc(a)+'" onclick="prodFechar(this.dataset.a)">Agora não</button></div>'+
    '<p class="nota">«Agora não» deixa-os como estão: continuam na simulação dos Nomes de vinhos.</p>');
}
function prodPrevMarca(el){
  const pv=PROD_RES[el.dataset.a].prev;if(el.checked)pv.off.delete(el.dataset.k);else pv.off.add(el.dataset.k);
  el.closest("tr").classList.toggle("off",!el.checked);
  const m=(pv.linhas||[]).filter(x=>!pv.off.has(nomesChave(x))).length,b=el.closest(".msg").querySelector("button.prim");
  b.disabled=!m;b.textContent="Aplicar a "+m+" vinho"+(m===1?"":"s");
}
async function prodPrevAplicar(a){
  const pv=PROD_RES[a]&&PROD_RES[a].prev;if(!pv)return;
  const itens=(pv.linhas||[]).filter(x=>!pv.off.has(nomesChave(x))).map(x=>({fonte:x.fonte,id:x.id}));
  if(!itens.length)return;
  try{const r=await post("/nomes",{itens,aplicar:true,produtor:pv.produtor}),d=r.duplicados||[];
    pv.feito='Nomes mudados: <b>'+r.catalogo+'</b> no catálogo e <b>'+r.garrafeiras+'</b> nas garrafeiras (fica no histórico).'+
      (d.length?' Ficaram por mexer '+d.length+', porque passavam a ser o mesmo vinho e colheita que outro — junta-os nos <a href="#duplicados">Duplicados</a>: '+d.map(x=>'#'+esc(x.id)+' → #'+esc(x.com)).join(", ")+'.':'');
    carregarCatalogo();if(d.length)dupProcurar();if(NOMES)nomesProcurar();}
  catch(e){pv.feito='<span style="color:var(--er)">Não consegui: '+esc(e.message)+'</span>';}
  prodPintar();
}

// ── Duplicados (27/09/2026) ──
// db/parecidos.sql: os nomes a uma letra de outro (qualquer colheita) e os
// pares da mesma colheita. "É este" é a "corresponde": da mesma colheita,
// junta; de outra, este passa a ser essa colheita do outro vinho. Carrega ao
// abrir a página: o número no separador é o alerta.
let DUP=null;
async function dupProcurar(){
  try{DUP=await post("/duplicados",{acao:"listar"});dupPintar();}
  catch(e){document.getElementById("dup-letra").innerHTML='<p class="nota">Não consegui: '+esc(e.message)+'</p>';}
}
function acharVinho(id){
  id=Number(id);
  const c=CAT.find(x=>x.id===id);if(c)return c;
  for(const g of (DUP&&DUP.letra)||[])for(const x of [g.vinho,...g.candidatos])if(Number(x.id)===id)return x;
  for(const p of (DUP&&DUP.colheita)||[])for(const x of [p.a,p.b])if(Number(x.id)===id)return x;
  return {id,nome:"#"+id};
}
function dupVinhoHTML(v){
  const c=CAT.find(x=>x.id===Number(v.id));
  return idLink(v.id)+' <a href="#" class="nm" onclick="abrirVinho('+Number(v.id)+');return false"><b>'+esc(v.nome)+'</b></a>'+(v.tipo?' <i class="nota">'+esc(String(v.tipo).toLowerCase())+'</i>':'')+' · '+(v.ano?esc(v.ano):'sem colheita')+
    '<br><span class="nota">'+esc(v.produtor||"(sem produtor)")+' · '+esc(v.campos||0)+' campos'+(c?' · criado '+esc(dataFmt(c.criado))+(c.criado_por?' '+esc(porTexto(c.criado_por)):''):'')+'</span>';
}
function dupPintar(){
  const L=(DUP&&DUP.letra)||[],C=(DUP&&DUP.colheita)||[],n=L.length+C.length;
  document.getElementById("tab-dup").textContent=n?" ("+n+")":"";
  document.getElementById("dup-n").textContent=n?n+" por decidir":"nada por decidir";
  document.getElementById("dup-letra").innerHTML=L.length?L.map((g,i)=>'<div class="dup-g"><div>'+dupVinhoHTML(g.vinho)+'</div>'+
    '<div class="nota" style="margin:6px 0 2px">…é algum destes?</div><table>'+g.candidatos.map(c=>'<tr><td>'+dupVinhoHTML(c)+
      '<br><span class="tag">'+(c.palavras||[]).map(w=>esc(w.de)+' → '+esc(w.para)).join(" · ")+'</span>'+(c.mesma_colheita?' <span class="tag">mesma colheita</span>':'')+'</td>'+
      '<td style="width:110px;text-align:right"><button class="prim" onclick="dupE('+Number(g.vinho.id)+','+Number(c.id)+')">É este</button></td></tr>').join("")+'</table>'+
    '<div class="linha" style="margin-top:4px"><button onclick="dupNenhum('+i+')">Nenhum destes</button></div></div>').join("")
    :'<p class="nota">Nada — nenhum nome a uma letra de outro.</p>';
  document.getElementById("dup-colheita").innerHTML=C.length?C.map(p=>{const fica=(p.a.campos||0)>=(p.b.campos||0);
    return '<div class="dup-g"><table><tr><td>'+dupVinhoHTML(p.a)+'</td><td>'+dupVinhoHTML(p.b)+'</td></tr></table>'+
      '<div class="linha" style="margin-top:4px"><span class="nota">em comum: '+esc((p.fortes||[]).join(", ")||"a chave")+'</span>'+
      '<button'+(fica?' class="prim"':'')+' onclick="dupE('+Number(p.b.id)+','+Number(p.a.id)+')">São o mesmo — fica o #'+esc(p.a.id)+'</button>'+
      '<button'+(fica?'':' class="prim"')+' onclick="dupE('+Number(p.a.id)+','+Number(p.b.id)+')">São o mesmo — fica o #'+esc(p.b.id)+'</button>'+
      '<button onclick="dupNao('+Number(p.a.id)+','+Number(p.b.id)+')">Não são</button></div></div>';}).join("")
    :'<p class="nota">Nada.</p>';
}
function correspondeTexto(de,al){
  const nm=v=>'"'+v.nome+'"'+(v.produtor?' ('+v.produtor+')':'')+' '+(v.ano||'sem colheita');
  if((de.ano||null)===(al.ano||null))return 'Juntar '+nm(de)+' em '+nm(al)+'?\\n\\nSão a mesma colheita: ficam um só vinho, o #'+al.id+', com o nome dele. O que o #'+de.id+' sabia passa para lá, campo a campo, pela força de cada um. Desfaz-se na app, em Duplicados › Fusões.';
  return nm(de)+' é a colheita '+(de.ano||'sem colheita')+' de '+nm(al)+'?\\n\\nO #'+de.id+' passa a chamar-se "'+al.nome+'"'+(al.produtor?', produtor '+al.produtor:'')+', com a sua colheita ('+(de.ano||'nenhuma')+'). Colheitas diferentes nunca se juntam: são linhas diferentes do mesmo vinho. Se essa colheita já existir no catálogo, junta-se nela.';
}
async function dupE(id,alvo){
  if(!confirm(correspondeTexto(acharVinho(id),acharVinho(alvo))))return null;
  try{const r=await post("/duplicados",{acao:"corresponde",id,alvo});
    alert(r.acao==="fundido"?'Juntos: ficou o #'+r.id+(r.campos?' ('+r.campos+' campo(s) passaram para lá)':'')+'. Fica no histórico.'
      :'Feito: o #'+r.id+' é agora "'+r.nome+'"'+(r.produtor?' ('+r.produtor+')':'')+(r.ano?' '+r.ano:'')+'. Fica no histórico.');
    await Promise.all([dupProcurar(),carregarCatalogo()]);return r;}
  catch(e){alert("Não consegui: "+e.message);return null;}
}
async function dupNenhum(i){
  const g=DUP.letra[i];
  if(!confirm('"'+g.vinho.nome+'" não é nenhum destes? Os pares ficam gravados como diferentes e não voltam.'))return;
  try{await post("/duplicados",{acao:"nao",id:g.vinho.id,outros:g.candidatos.map(c=>c.id)});await dupProcurar();}catch(e){alert(e.message);}
}
async function dupNao(a,b){
  if(!confirm("São vinhos diferentes? O par fica gravado e não volta."))return;
  try{await post("/duplicados",{acao:"nao",id:a,outros:[b]});await dupProcurar();}catch(e){alert(e.message);}
}

// ── Comentários e sugestões (28/09/2026) ──
// db/comentarios.sql: o que as garrafeiras escrevem — sobre um vinho (na
// página dele, na Garrafeira) ou sobre a app (em Definições de lá). Os
// números dos dois separadores carregam ao abrir a página: são o alerta,
// como nos Duplicados. A resposta ao fechar é o que a pessoa lê na Garrafeira.
const COM={vinho:[],sugestao:[]};
const COM_MOTIVO={atributos:"Atributos errados",atualizar:"Atualizar a partir de um site",outro:"Outro problema",melhoria:"Ideia / melhoria",problema:"Algo não funciona"};
const COM_ESTADO={aberto:"por tratar",duvida:"à espera de resposta",resolvido:"tratado",rejeitado:"recusado"};
async function comContar(){
  try{const c=await post("/comentarios",{acao:"contar"});
    for(const t of ["vinho","sugestao"]){const n=Number((c&&c[t])||0);document.getElementById("tab-com-"+t).textContent=n?" ("+n+")":"";}}
  catch(e){}
}
async function comProcurar(tipo){
  const box=document.getElementById("com-"+tipo+"-lista");
  box.innerHTML='<p class="nota">A carregar…</p>';
  try{COM[tipo]=(await post("/comentarios",{acao:"listar",tipo,estado:document.getElementById("com-"+tipo+"-estado").value}))||[];comPintar(tipo);}
  catch(e){box.innerHTML='<p class="nota">Não consegui: '+esc(e.message)+'</p>';}
  comContar();
}
function comCampoNome(k){const c=CAMPOS_ED.find(x=>x[0]===k);return c?c[1]:({nome:"Nome",produtor:"Produtor",ano:"Colheita"})[k]||k;}
function comPintar(tipo){
  const L=COM[tipo]||[],aberto=document.getElementById("com-"+tipo+"-estado").value==="aberto";
  document.getElementById("com-"+tipo+"-conta").textContent=L.length?L.length+(aberto?" por tratar":""):"";
  document.getElementById("com-"+tipo+"-lista").innerHTML=L.length?L.map(comHTML).join(""):'<p class="nota">Nada'+(aberto?" por tratar":"")+'.</p>';
}
function comHTML(c){
  const vinho=c.tipo==="vinho",fechado=c.estado==="resolvido"||c.estado==="rejeitado",id=Number(c.id);
  const motivo='<span class="tag">'+esc(COM_MOTIVO[c.motivo]||c.motivo)+'</span>';
  let h='<div class="dup-g"><div class="linha" style="justify-content:space-between;align-items:flex-start"><div>';
  h+=vinho?(c.vinhoId?idLink(c.vinhoId)+' <a href="#" class="nm" onclick="abrirVinho('+Number(c.vinhoId)+');return false"><b>'+esc(c.nome)+'</b></a>':'<b>'+esc(c.nome)+'</b>')+
      (c.cor?' <i class="nota">'+esc(String(c.cor).toLowerCase())+'</i>':'')+' · '+(c.ano?esc(c.ano):'sem colheita')+
      '<br><span class="nota">'+esc(c.produtor||"(sem produtor)")+'</span> '+motivo
    :motivo;
  h+='</div><span class="tag'+(c.estado==="aberto"?' mudou':'')+'">'+esc(COM_ESTADO[c.estado]||c.estado)+'</span></div>';
  if(c.texto)h+='<p class="com-texto">'+esc(c.texto)+'</p>';
  if(c.link)h+='<p class="nota">🔗 <a href="'+esc(c.link)+'" target="_blank" rel="noopener noreferrer">'+esc(c.link)+'</a></p>';
  // Os campos de que se queixa: o que a pessoa tem, o que o catálogo tinha
  // quando ela escreveu e o de agora (um vinho que ainda não estava no
  // catálogo só tem o de agora).
  if((c.campos||[]).length){
    const cat=c.valoresCatalogo,ag=c.valoresAgora;
    h+='<table class="ficha"><tr><th>Campo</th><th>Na garrafeira de quem escreveu</th><th>'+(cat?'No catálogo, então':'No catálogo, agora')+'</th>'+(cat&&ag?'<th>Agora</th>':'')+'</tr>'+
      c.campos.map(k=>{const mud=cat&&ag&&JSON.stringify(ag[k]??null)!==JSON.stringify(cat[k]??null);
        return '<tr><td class="k">'+esc(comCampoNome(k))+'</td><td>'+valorFicha(k,(c.valoresDeles||{})[k])+'</td><td>'+
          (c.vinhoId?valorFicha(k,cat?cat[k]:ag?ag[k]:null):'<span class="nota">não está no catálogo</span>')+'</td>'+
          (cat&&ag?'<td>'+(mud?valorFicha(k,ag[k]):'<span class="nota">igual</span>')+'</td>':'')+'</tr>';}).join("")+'</table>';
  }
  if(vinho&&c.vinhoId&&c.mesmaColheita===false)h+='<p class="nota">A linha do catálogo é da colheita '+(c.anoCatalogo?esc(c.anoCatalogo):'sem ano')+', não da de quem escreveu.</p>';
  if(vinho&&!c.vinhoId)h+='<p class="nota">Este vinho ainda não está no catálogo.</p>';
  h+='<p class="nota">'+esc(c.quem)+' · '+esc(dataHora(c.quando))+' · '+esc(c.app||"")+'</p>';
  // A conversa: cada pergunta, fecho ou resposta, pela ordem.
  const ROT={duvida:"Perguntaste",resolvido:"Tratado",rejeitado:"Recusado"};
  if((c.mensagens||[]).length)h+='<div class="com-fio">'+c.mensagens.map(m=>'<div class="com-fala'+(m.de==="admin"?' adm':'')+'"><b>'+
    esc(m.de==="admin"?(ROT[m.estado]||"Admin"):"Quem escreveu")+' · '+esc(dataHora(m.quando))+(m.de==="admin"&&m.quem?' · '+esc(m.quem):'')+'</b>'+esc(m.texto||"")+'</div>').join("")+'</div>';
  h+='<div class="linha" style="margin-top:6px">';
  if(vinho&&c.vinhoId)h+='<button onclick="abrirVinho('+Number(c.vinhoId)+')">Abrir a ficha</button>'+
    '<button onclick="comEscolher('+Number(c.vinhoId)+')" title="Marca-o na Informação de vinhos, para o simular ou enriquecer">Escolher para enriquecer</button>';
  h+=fechado?'<button onclick="comResponder('+id+',\\'aberto\\')">Reabrir</button>'
    :'<input id="com-resp-'+id+'" class="com-resp" placeholder="resposta ou pergunta para quem escreveu">'+
     '<button onclick="comResponder('+id+',\\'duvida\\')" title="Pergunta a quem escreveu (o texto da caixa) — fica à espera da resposta dele">❓ Perguntar</button>'+
     '<button class="prim" onclick="comResponder('+id+',\\'resolvido\\')">Tratado ✓</button>'+
     '<button onclick="comResponder('+id+',\\'rejeitado\\')">Recusar</button>';
  return h+'</div></div>';
}
async function comResponder(id,estado){
  const tipo=COM.vinho.some(x=>x.id===id)?"vinho":"sugestao";
  const el=document.getElementById("com-resp-"+id),resposta=el?el.value.trim():"";
  if(estado==="duvida"&&!resposta){if(el)el.focus();return alert("Escreve a pergunta na caixa.");}
  if(estado==="rejeitado"&&!resposta&&!confirm("Recusar sem dizer porquê? Quem escreveu vê só que foi recusado."))return;
  try{await post("/comentarios",{acao:"responder",id,estado,resposta});await comProcurar(tipo);}
  catch(e){alert("Não consegui: "+e.message);}
}
// O vinho do comentário passa para a escolha da Informação de vinhos (como
// os "Por confirmar" das garrafeiras), para o simular ou enriquecer.
function comEscolher(id){
  if(!ESC.has(id)){if(ESC.size>=50)return alert("Até 50 de cada vez.");ESC.add(id);}
  document.getElementById("cat-so").checked=true;
  abrirTab("info");pintarCatalogo();
  document.getElementById("c-escolher").scrollIntoView({behavior:"smooth",block:"start"});
}

filtrosHTML();
ordensHTML();
sitiosHTML("cat");sitiosHTML("novo");
novaLinha();
abrirTab(location.hash.slice(1));
carregarCatalogo();
dupProcurar();
comContar();
listarSims();fetch("/estado").then(r=>r.json()).then(r=>{if(r&&r.fim==null)comecar();});
</script></body></html>`;
