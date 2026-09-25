// =====================================================================
// Verificação dos links do Vivino — o batch da noite (GitHub Actions)
//
// SEM IA E SEM SERPER. Abre cada página num Chromium a sério (Playwright),
// lê o que lá está escrito e compara com o catálogo por regras de código.
// Não escreve na ficha de vinho nenhum: deixa uma PROPOSTA em
// `winecatalog.vivino_verificacoes`, e é o admin que a aceita no separador
// Alertas (ver db/vivino.sql e o CLAUDE.md, "Links do Vivino").
//
// Por vinho:
//   1. abre o link que o catálogo tem. 404, ou o Vivino a mandar para fora
//      de uma página de vinho → `nao_existe`. Abriu → lê o nome, a nota e o
//      nº de avaliações, e confere o nome (e a cor) com o do catálogo:
//      bate → `certo`; não bate → `errado`;
//   2. se não ficou `certo` (ou não havia link), procura no próprio Vivino
//      (`/search/wines?q=…`), dá nota a cada resultado pelo nome e abre o
//      melhor para ler os números. É isso que vai na proposta.
//
// Variáveis: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (secret do repo),
// MANUAL=true (corrida à mão: não pergunta se hoje é dia), LIMITE (nº de
// vinhos, vazio = o das Definições), ENSAIO=true (não grava nada),
// EXECUCAO (o id do run, para se ir do Alerta ao log).
// =====================================================================
import { chromium } from "playwright";

const SB_URL = process.env.SUPABASE_URL || "https://gjweqwfbnkgnibhajldc.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const MANUAL = process.env.MANUAL === "true";
const ENSAIO = process.env.ENSAIO === "true";
const LIMITE = parseInt(process.env.LIMITE || "", 10) || null;
const EXECUCAO = process.env.EXECUCAO || null;

// Entre páginas: devagar de propósito. São poucas dezenas por noite.
const PAUSA_MIN = +(process.env.PAUSA_MIN ?? 4000), PAUSA_MAX = +(process.env.PAUSA_MAX ?? 7000);
// Duas recusas seguidas = o Vivino não nos quer hoje. Parar em vez de insistir.
const MAX_BLOQUEIOS = 2;

// ── Supabase ──────────────────────────────────────────────────────────
async function rpc(fn, args) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      "Content-Profile": "winecatalog", "Accept-Profile": "winecatalog",
    },
    body: JSON.stringify(args || {}),
  });
  const tx = await r.text();
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${tx.slice(0, 300)}`);
  return tx ? JSON.parse(tx) : null;
}

// ── Comparar nomes ────────────────────────────────────────────────────
// Palavras que não identificam um vinho: a cor, a região, a gama. Um par
// que só partilhe estas não é o mesmo vinho (é a mesma lição do
// `generico()` dos Duplicados).
const GENERICAS = new Set((
  "de da do das dos e the and y vinho vinhos wine wines vin vino " +
  "tinto tinta red branco white rose rosado blanc " +
  "douro alentejo alentejano dao bairrada tejo lisboa setubal peninsula verde doc vr " +
  "reserva grande colheita selecionada seleccionada garrafeira superior especial " +
  "quinta herdade casa adega monte vinhas velhas old vines"
).split(" "));
function norm(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function palavras(s) {
  return norm(s).split(" ").filter(t => t.length >= 2 && !/^\d+$/.test(t));
}
function distintivas(s) { return palavras(s).filter(t => !GENERICAS.has(t)); }

// 0..1: que parte das palavras DISTINTIVAS do nome do catálogo aparece no
// texto da página. O produtor ajuda quando o nome sozinho é pobre
// ("Pintas"), mas não chega sozinho — dois vinhos da mesma casa partilham-no.
function parecenca(vinho, texto) {
  const alvo = new Set(palavras(texto));
  // Um nome feito só de palavras genéricas ("Grande Reserva") compara-se
  // com o que tem — é pouco, e por isso o limiar faz o resto.
  const nome = distintivas(vinho.nome).length ? distintivas(vinho.nome) : palavras(vinho.nome);
  const prod = distintivas(vinho.produtor);
  if (!nome.length) return 0;
  const n = nome.filter(t => alvo.has(t)).length / nome.length;
  const p = prod.length ? prod.filter(t => alvo.has(t)).length / prod.length : 0;
  return Math.min(1, n * 0.85 + p * 0.15);
}
function corDoTexto(texto) {
  const t = ` ${norm(texto)} `;
  if (/ (branco|white|blanc) /.test(t)) return "Branco";
  if (/ (rose|rosado) /.test(t)) return "Rosé";
  if (/ (tinto|red|rouge) /.test(t)) return "Tinto";
  return null;
}
function corBate(vinho, texto) {
  const c = corDoTexto(texto);
  return !c || !vinho.tipo || c === vinho.tipo;
}
const LIMIAR = 0.7;

// ── URLs ──────────────────────────────────────────────────────────────
function idDoVinho(url) {
  const m = String(url || "").match(/\/w\/(\d+)/);
  return m ? m[1] : null;
}
// O link que se propõe é o do VINHO (/w/<nº>), sem país, língua, ?year=
// nem os ?srsltid do Google: é o que não muda e abre em qualquer sítio.
function urlLimpo(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/([a-z0-9-]+)\/w\/(\d+)/i);
    if (!m) return null;
    return `https://www.vivino.com/${m[1].toLowerCase()}/w/${m[2]}`;
  } catch { return null; }
}
function pareceVivino(url) {
  try { return /(^|\.)vivino\.com$/.test(new URL(url).hostname); } catch { return false; }
}

// ── Ler uma página de vinho ───────────────────────────────────────────
function numero(s) {
  if (s == null) return null;
  const x = Number(String(s).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(x) ? x : null;
}
function inteiro(s) {
  if (s == null) return null;
  const x = parseInt(String(s).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(x) ? x : null;
}

async function lerPagina(page) {
  return await page.evaluate(() => {
    const meta = n => document.querySelector(`meta[property="${n}"],meta[name="${n}"]`)?.content || null;
    const ld = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { const j = JSON.parse(s.textContent); (Array.isArray(j) ? j : [j]).forEach(x => ld.push(x)); } catch {}
    }
    const prod = ld.find(x => /Product/i.test(String(x && x["@type"])));
    const h1 = document.querySelector("h1")?.innerText || null;
    return {
      titulo: document.title || null,
      ogTitulo: meta("og:title"),
      ogUrl: meta("og:url"),
      canonico: document.querySelector('link[rel="canonical"]')?.href || null,
      h1,
      ldNome: prod?.name || null,
      ldNota: prod?.aggregateRating?.ratingValue ?? null,
      ldAval: prod?.aggregateRating?.ratingCount ?? prod?.aggregateRating?.reviewCount ?? null,
      ldTem: ld.length > 0,
      texto: (document.body?.innerText || "").slice(0, 4000),
    };
  });
}

// Nota e avaliações: o JSON-LD primeiro (é dado estruturado, feito para
// ser lido por máquinas); se não houver, o texto visível ("4,2 · 1.234
// avaliações"). O que não se consegue ler fica null — nunca um palpite.
function numerosDe(info) {
  let nota = numero(info.ldNota), aval = inteiro(info.ldAval);
  if (nota == null || aval == null) {
    const m = info.texto.match(/\b([1-5][.,]\d)\b[\s\S]{0,60}?([\d][\d.,\s]*)\s*(avalia|classifica|ratings?|notes|bewertung)/i);
    if (m) {
      if (nota == null) nota = numero(m[1]);
      if (aval == null) aval = inteiro(m[2]);
    }
  }
  if (nota != null && (nota < 1 || nota > 5)) nota = null;
  return { nota, aval };
}
function nomeDe(info) {
  const limpa = s => s ? s.replace(/\s*[|–-]\s*Vivino.*$/i, "").trim() : null;
  return info.ldNome || limpa(info.ogTitulo) || info.h1 || limpa(info.titulo);
}
function bloqueio(status, info) {
  if (status === 403 || status === 429) return true;
  const t = `${info?.titulo || ""} ${info?.texto?.slice(0, 500) || ""}`;
  return /just a moment|attention required|access denied|captcha|verify you are human|unusual traffic/i.test(t);
}

async function abrir(page, url) {
  let resp = null, erro = null;
  try {
    resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  } catch (e) { erro = String(e.message || e).slice(0, 200); }
  const status = resp ? resp.status() : null;
  const final = page.url();
  let info = null;
  try { info = await lerPagina(page); } catch (e) { erro = erro || String(e.message || e).slice(0, 200); }
  return { status, final, info, erro };
}

function detalheDe(a) {
  return {
    http: a.status, url_final: a.final, erro: a.erro,
    titulo: a.info?.titulo || null, og: a.info?.ogTitulo || null,
    jsonld: !!a.info?.ldTem,
    // Só quando não se leu nome nenhum: é o que diz se a página mudou.
    trecho: a.info && !nomeDe(a.info) ? a.info.texto.slice(0, 300) : undefined,
  };
}

// ── Procurar no Vivino ────────────────────────────────────────────────
async function procurar(page, v) {
  const q = [v.nome, v.produtor && !norm(v.nome).includes(norm(v.produtor)) ? v.produtor : ""]
    .join(" ").replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
  const url = `https://www.vivino.com/search/wines?q=${encodeURIComponent(q)}`;
  const a = await abrir(page, url);
  if (bloqueio(a.status, a.info)) return { bloqueado: true, url, detalhe: detalheDe(a) };
  const links = await page.evaluate(() => {
    const vistos = new Map();
    for (const el of document.querySelectorAll('a[href*="/w/"]')) {
      const href = el.href;
      const m = href.match(/\/w\/(\d+)/);
      if (!m || vistos.has(m[1])) continue;
      // O texto do cartão inteiro, não só do link: o produtor e a região
      // costumam estar ao lado, fora do <a>.
      const cartao = el.closest("[class*=card], [class*=Card], li, article") || el;
      vistos.set(m[1], { href, texto: (cartao.innerText || el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200) });
    }
    return [...vistos.values()].slice(0, 10);
  }).catch(() => []);
  const cands = links.map(l => ({
    vivino_url: urlLimpo(l.href) || l.href,
    texto: l.texto,
    parecenca: Math.round(parecenca(v, `${l.texto} ${l.href.replace(/[-/]/g, " ")}`) * 100) / 100,
    cor_bate: corBate(v, `${l.texto} ${l.href.replace(/[-/]/g, " ")}`),
  })).sort((x, y) => (y.cor_bate - x.cor_bate) || (y.parecenca - x.parecenca));
  return { url, candidatos: cands.slice(0, 5), detalhe: detalheDe(a) };
}

// ── Um vinho ──────────────────────────────────────────────────────────
async function verificar(page, v) {
  const det = {};
  let estado = null, nomePagina = null, proposta = null;

  if (v.vivino_url && pareceVivino(v.vivino_url) && !/\s/.test(v.vivino_url)) {
    const a = await abrir(page, v.vivino_url);
    det.atual = detalheDe(a);
    if (bloqueio(a.status, a.info)) return { estado: "bloqueado", detalhe: det };
    if (a.status === 404 || !idDoVinho(a.final) || !a.info) {
      estado = "nao_existe";
    } else {
      nomePagina = nomeDe(a.info);
      const txt = `${nomePagina || ""} ${a.info.titulo || ""} ${a.final.replace(/[-/]/g, " ")}`;
      const p = parecenca(v, txt);
      det.atual.parecenca = Math.round(p * 100) / 100;
      if (p >= LIMIAR && corBate(v, txt)) {
        estado = "certo";
        const { nota, aval } = numerosDe(a.info);
        proposta = { vivino_url: urlLimpo(a.info.canonico || a.info.ogUrl || a.final) || urlLimpo(a.final),
                     vivino_nota: nota, vivino_avaliacoes: aval, nome: nomePagina, confianca: det.atual.parecenca };
        // O que não se leu não entra na proposta: ficava a apagar um número
        // que o catálogo tem só porque a página o escondeu.
        if (nota == null) delete proposta.vivino_nota;
        if (aval == null) delete proposta.vivino_avaliacoes;
      } else {
        estado = "errado";
      }
    }
  } else {
    estado = v.vivino_url ? "nao_existe" : "sem_link";
    if (v.vivino_url) det.atual = { motivo: "não é um endereço do Vivino que se possa abrir" };
  }

  let candidatos = null;
  if (estado !== "certo") {
    await pausa();
    const r = await procurar(page, v);
    det.procura = { url: r.url, ...r.detalhe };
    if (r.bloqueado) return { estado: "bloqueado", nome_pagina: nomePagina, detalhe: det };
    candidatos = r.candidatos;
    const melhor = candidatos.find(c => c.cor_bate && c.parecenca >= LIMIAR);
    if (melhor) {
      await pausa();
      const b = await abrir(page, melhor.vivino_url);
      det.melhor = detalheDe(b);
      if (bloqueio(b.status, b.info)) return { estado: "bloqueado", nome_pagina: nomePagina, candidatos, detalhe: det };
      if (b.info && idDoVinho(b.final)) {
        const nome = nomeDe(b.info);
        const txt = `${nome || ""} ${b.info.titulo || ""} ${b.final.replace(/[-/]/g, " ")}`;
        const p = parecenca(v, txt);
        if (p >= LIMIAR && corBate(v, txt)) {
          const { nota, aval } = numerosDe(b.info);
          proposta = { vivino_url: urlLimpo(b.info.canonico || b.final) || melhor.vivino_url,
                       vivino_nota: nota, vivino_avaliacoes: aval, nome, confianca: Math.round(p * 100) / 100 };
          if (nota == null) delete proposta.vivino_nota;
          if (aval == null) delete proposta.vivino_avaliacoes;
        }
      }
    }
    // Link morto e nada encontrado: propõe-se APAGAR o link (vivino_url a
    // null). Continua a ser uma proposta — o admin é que decide.
    if (!proposta && estado === "nao_existe") proposta = { vivino_url: null };
  }
  return { estado, nome_pagina: nomePagina, proposta, candidatos, detalhe: det };
}

function pausa() {
  return new Promise(r => setTimeout(r, PAUSA_MIN + Math.random() * (PAUSA_MAX - PAUSA_MIN)));
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  if (!SB_KEY) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY (secret do repo).");
  const plano = await rpc("vivino_a_tratar", { p_manual: MANUAL, p_limite: LIMITE });
  if (!plano?.correr) { console.log(`Hoje não: ${plano?.motivo}`); return; }
  console.log(`A tratar ${plano.vinhos.length} vinho(s) — ${plano.motivo}${ENSAIO ? " (ENSAIO, não grava)" : ""}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    locale: "pt-PT",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  const resumo = {};
  let bloqueios = 0;
  try {
    for (const [i, v] of plano.vinhos.entries()) {
      if (i > 0) await pausa();
      let res;
      try { res = await verificar(page, v); }
      catch (e) { res = { estado: "erro", detalhe: { erro: String(e.message || e).slice(0, 300) } }; }
      resumo[res.estado] = (resumo[res.estado] || 0) + 1;
      const p = res.proposta;
      console.log(`#${v.id} ${v.nome}${v.ano ? " " + v.ano : ""} → ${res.estado}` +
        (res.nome_pagina ? ` · página: "${res.nome_pagina}"` : "") +
        (p ? ` · proposta: ${p.vivino_url ?? "apagar o link"} ${p.vivino_nota ?? ""} ${p.vivino_avaliacoes ?? ""}` : ""));
      if (!ENSAIO) await rpc("vivino_gravar", { p_vinho_id: v.id, p_res: res, p_execucao: EXECUCAO });
      bloqueios = res.estado === "bloqueado" ? bloqueios + 1 : 0;
      if (bloqueios >= MAX_BLOQUEIOS) { console.log("O Vivino está a recusar as páginas — paro por hoje."); break; }
    }
  } finally {
    await browser.close();
  }
  console.log("Resumo:", JSON.stringify(resumo));
}

export { parecenca, corBate, urlLimpo, idDoVinho, numerosDe, nomeDe, bloqueio, verificar };

// Corre só quando é chamado diretamente (o teste importa as funções).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
