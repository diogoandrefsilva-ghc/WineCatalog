// =====================================================================
// Verificação dos links do Vivino — SEM IA. Dois motores, o mesmo resultado
// (uma PROPOSTA em `winecatalog.vivino_verificacoes`, que o admin aceita ou
// não em Alertas — este script nunca escreve na ficha de um vinho):
//
//   MOTOR=browser (o de omissão; para correr NO TEU COMPUTADOR — ver
//   batch/README.md). Abre cada página num Chromium a sério (Playwright):
//     1. o link que o catálogo tem. 404, ou o Vivino a mandar para fora de
//        uma página de vinho → `nao_existe`. Abriu → lê o nome, a nota e o
//        nº de avaliações e confere o nome (e a cor) com o do catálogo:
//        bate → `certo`; não bate → `errado`;
//     2. se não ficou `certo`, procura no próprio Vivino (`/search/wines`)
//        e abre o melhor resultado para ler os números.
//   A 25/09/2026 o Vivino recusou este motor a partir do GitHub Actions
//   (HTTP 403 da proteção deles para servidores) — daí correr em casa.
//
//   MOTOR=serper (o do GitHub Actions). Não toca no Vivino: UMA pesquisa
//   Google por vinho (`"nome" produtor site:vivino.com`, pelo Serper) e lê
//   dos resultados o link, a nota e as avaliações que o Google mostra. O
//   link atual confere-se pelo NÚMERO do vinho: se o melhor resultado é o
//   mesmo número → `certo`; outro → `diferente` (o Google aponta para outro
//   link — o atual não foi aberto, por isso não se diz "errado"); nada que
//   bata → `nao_encontrado`. Gasta do limite do Serper: uma por vinho, e
//   uma segunda (sem o produtor) só quando a primeira não chega.
//
// No PC corre-se pelo vinhos.bat (simular / enriquecer / gravar uma
// simulação revista). APLICAR=<ficheiro> grava uma simulação sem abrir
// página nenhuma.
//
// Variáveis: SUPABASE_SERVICE_ROLE_KEY (obrigatória), SEARCH_API_KEY (só
// no motor serper — a chave do serper.dev), MOTOR, MANUAL=true (não
// pergunta se hoje é dia), LIMITE (nº de vinhos; vazio = o das
// Definições), ENSAIO=true (não grava nada), EXECUCAO (o id do run),
// IDS=1,2,3 (só estes vinhos, escolhidos no painel), NOVO=[…] (vinhos novos),
// APLICAR=<ficheiro> (grava uma simulação revista).
// =====================================================================
import { pathToFileURL } from "node:url";

const SB_URL = process.env.SUPABASE_URL || "https://gjweqwfbnkgnibhajldc.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const MANUAL = process.env.MANUAL === "true";
const ENSAIO = process.env.ENSAIO === "true";
const LIMITE = parseInt(process.env.LIMITE || "", 10) || null;
const EXECUCAO = process.env.EXECUCAO || null;
const MOTOR = (process.env.MOTOR || "browser").toLowerCase();
const SERPER_KEY = process.env.SEARCH_API_KEY || "";
const SERPER_URL = process.env.SEARCH_API_URL || "https://google.serper.dev/search";
// As lojas só no motor browser (no PC); LOJAS=false para as saltar.
const LOJAS_LIGADAS = process.env.LOJAS !== "false";
const QUEM = MOTOR === "serper" ? "script Serper (GitHub Actions)" : "script no PC (Vivino e lojas)";

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
// "Aragonês"/"Aragonez" e "Shiraz"/"Syrah" são a mesma palavra: a GN
// escreve "Invisível Aragonês" e o catálogo "Invisível Aragonez", e a
// parecença dava 1 em 3. "75cl" é o tamanho da garrafa, não o nome (a
// Vinha.pt escreve-o em todos os produtos).
const SINONIMOS = { aragones: "aragonez", shiraz: "syrah" };
function palavras(s) {
  return norm(s).split(" ").filter(t => t.length >= 2 && !/^\d+$/.test(t) && !/^\d+(cl|ml|l|lt)$/.test(t))
    .map(t => SINONIMOS[t] || t);
}
function distintivas(s) { return palavras(s).filter(t => !GENERICAS.has(t)); }

// 0..1: que parte das palavras DISTINTIVAS do nome do catálogo aparece no
// texto da página. O produtor ajuda quando o nome sozinho é pobre
// ("Pintas"), mas não chega sozinho — dois vinhos da mesma casa partilham-no.
function parecenca(vinho, texto) {
  const alvo = new Set(palavras(texto));
  // Um nome feito só de palavras genéricas ("Grande Reserva") compara-se
  // com o que tem — é pouco, e por isso o limiar faz o resto.
  let nome = distintivas(vinho.nome).length ? distintivas(vinho.nome) : palavras(vinho.nome);
  const prod = distintivas(vinho.produtor);
  if (!nome.length) return 0;
  // O produtor dentro do NOSSO nome ("Ervideira Invisível Aragonez") não é
  // exigido quando o resto identifica o vinho sozinho — a loja escreve
  // "Invisível Aragonês". O resto tem de ter uma palavra que não seja casta:
  // "Casa Ermelinda Freitas Syrah" sem o produtor era o Syrah de qualquer um.
  const semProd = nome.filter(t => !prod.includes(t));
  const casta = t => CASTAS.some(c => c.split(" ").includes(t));
  if (prod.length && semProd.length < nome.length && semProd.some(t => !casta(t))) {
    const nSem = semProd.filter(t => alvo.has(t)).length / semProd.length;
    const nTodo = nome.filter(t => alvo.has(t)).length / nome.length;
    if (nSem > nTodo) nome = semProd;
  }
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
    // O WooCommerce/Yoast põe tudo dentro de um "@graph".
    const junta = x => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) return x.forEach(junta);
      ld.push(x); if (Array.isArray(x["@graph"])) x["@graph"].forEach(junta); };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { junta(JSON.parse(s.textContent)); } catch {}
    }
    const prod = ld.find(x => /Product/i.test(String(x && x["@type"])));
    // Pares "rótulo → valor" da página: tabelas (th/td ou td/td), listas de
    // definições (dt/dd) e linhas "Castas: …". É onde as lojas e o Vivino
    // escrevem castas, região, teor, estágio. O script é que decide o que
    // cada rótulo quer dizer (`fichaDosPares`).
    const pares = [];
    const limpa = t => (t || "").replace(/\s+/g, " ").trim();
    for (const tr of document.querySelectorAll("tr")) {
      const c = tr.querySelectorAll("th,td");
      if (c.length === 2) pares.push([limpa(c[0].innerText), limpa(c[1].innerText)]);
    }
    for (const dt of document.querySelectorAll("dt")) {
      const dd = dt.nextElementSibling;
      if (dd && dd.tagName === "DD") pares.push([limpa(dt.innerText), limpa(dd.innerText)]);
    }
    for (const l of (document.body?.innerText || "").split(/\n/)) {
      const m = l.match(/^\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .()\/-]{1,40}?)\s*:\s*(.{1,400})$/);
      if (m) pares.push([limpa(m[1]), limpa(m[2])]);
    }
    // No Vivino, a harmonização é uma lista de comidas com link.
    // (o 1.º link da secção é "vinhos por harmonizações com comida" — navegação.)
    const comidas = [...new Set([...document.querySelectorAll('a[href*="food"], [class*="foodPairing"] a, [class*="FoodPairing"] a')]
      .map(a => limpa(a.innerText)).filter(t => t && t.length <= 40 && !/vinho|wine|harmoniza|pairing/i.test(t)))].slice(0, 8);
    // A fotografia da garrafa: a do produto no JSON-LD, senão a do og:image.
    const imgLd = (() => { const i = prod && prod.image; const x = Array.isArray(i) ? i[0] : i;
      return typeof x === "string" ? x : (x && (x.url || x.contentUrl)) || null; })();
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
      // O preço, quando a página o publica em dado estruturado (offers).
      ldPreco: (() => {
        const o = prod && prod.offers; if (!o) return null;
        const x = Array.isArray(o) ? o[0] : o;
        const ps = Array.isArray(x.priceSpecification) ? x.priceSpecification[0] : x.priceSpecification;
        return { preco: x.price ?? x.lowPrice ?? ps?.price ?? null, moeda: x.priceCurrency || ps?.priceCurrency || null };
      })(),
      ldDescricao: typeof prod?.description === "string" ? limpa(prod.description.replace(/<[^>]+>/g, " ")).slice(0, 1500) : null,
      imagem: imgLd || meta("og:image") || null,
      pares: pares.filter(([a, b]) => a && b && a.length <= 60).slice(0, 80),
      comidas,
      // O preço À VISTA, para as lojas sem dado estruturado (só se usa nelas).
      precoTexto: (() => {
        const el = document.querySelector(".product-info-main .price, .summary .price, .current-price, " +
          ".product-prices .price, .product-price, [class*=product] [class*=price]");
        return el ? limpa(el.innerText).slice(0, 80) : null;
      })(),
      metaPreco: meta("product:price:amount") || document.querySelector('[itemprop="price"]')?.getAttribute("content")
        || document.querySelector("[data-price-amount]")?.getAttribute("data-price-amount") || null,
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
    // Milhares só em grupos de TRÊS: "[\d.,\s]*" colava números vizinhos.
    const m = info.texto.match(/\b([1-5][.,]\d)\b[\s\S]{0,60}?(?<![\d.,])(\d{1,3}(?:[.,\u00a0\u202f ]\d{3})+|\d+)\s*(avalia|classifica|ratings?|notes|bewertung)/i);
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
  const cands = links.map(l => {
    // O NOME no link ("…/quintinha-da-francisca-grande-reserva-tinto/w/…")
    // é o que se compara palavra a palavra: o texto do cartão traz região,
    // preço e "avaliações", e contava tudo isso como palavras a mais.
    const slug = (String(l.href).match(/\/([a-z0-9-]+)\/w\/\d+/i) || [])[1] || "";
    const nomeLink = slug.replace(/-/g, " ");
    return {
      vivino_url: urlLimpo(l.href) || l.href,
      texto: l.texto,
      parecenca: Math.round(parecenca(v, `${l.texto} ${nomeLink}`) * 100) / 100,
      cor_bate: corBate(v, `${l.texto} ${nomeLink}`),
      nome_bate: bateNome(v, nomeLink || l.texto),
      a_mais: aMais(v, nomeLink || l.texto),
    };
  }).sort((x, y) => (y.cor_bate - x.cor_bate) || (y.nome_bate - x.nome_bate)
    || (y.parecenca - x.parecenca) || (x.a_mais.length - y.a_mais.length));
  return { url, candidatos: cands.slice(0, 5), detalhe: detalheDe(a) };
}

// As mesmas duas regras do motor Serper, aqui também: a MENÇÃO igual dos
// dois lados, e não mais de uma palavra distintiva a mais no nome da página.
// No 1.º ensaio em casa, "Quintinha da Francisca" casou com "…Grande
// Reserva Tinto" — o motor browser só olhava para a parecença.
function bateNome(v, nome) {
  const t = tituloLimpo(nome);
  return mencaoBate(v, t) && castasBatem(v, t) && aMais(v, t).length <= MAX_A_MAIS;
}

// A CASTA no nome é identidade. Na 1.ª corrida com lojas (25/09/2026),
// "Casa Ermelinda Freitas Syrah Reserva" casou na Granvine com "…Carménère
// Reserva Tinto": faltava UMA palavra distintiva (o Syrah) e sobrava UMA
// (o Carménère), e as duas regras deixavam passar uma de cada. Agora: cada
// casta que o NOSSO nome diz tem de estar no título. (Ao contrário não:
// "Casa de Saima Garrafeira" é o "…Garrafeira Baga Tinto" da loja.)
const CASTAS = [
  "touriga nacional", "touriga franca", "tinta roriz", "tinta barroca", "tinto cao", "tinta cao",
  "tinta amarela", "tinta francisca", "alicante bouschet", "cabernet sauvignon", "cabernet franc",
  "sauvignon blanc", "pinot noir", "pinot gris", "petit verdot", "antao vaz", "fernao pires",
  "arinto", "alvarinho", "loureiro", "avesso", "azal", "trajadura", "encruzado", "baga", "bical",
  "cercial", "sercial", "maria gomes", "aragonez", "aragones", "trincadeira", "castelao",
  "periquita", "alfrocheiro", "jaen", "mencia", "rufete", "bastardo", "sousao", "vinhao",
  "moreto", "tinta miuda", "viosinho", "rabigato", "gouveio", "codega", "malvasia fina",
  "verdelho", "moscatel", "roupeiro", "siria", "tamarez", "syrah", "shiraz", "merlot",
  "chardonnay", "viognier", "semillon", "riesling", "gewurztraminer", "tannat", "carmenere",
  "malbec", "tempranillo", "grenache", "garnacha", "sangiovese", "nebbiolo", "zinfandel",
  "marselan", "tinta grossa", "alvarelhao", "espadeiro", "padeiro", "arinto dos acores",
];
function castasDe(t) {
  const n = ` ${norm(t)} `;
  // A mais comprida primeiro: "touriga nacional" não pode contar como outra.
  return [...CASTAS].sort((a, b) => b.length - a.length).filter(c => n.includes(` ${c} `))
    .map(c => ({ shiraz: "syrah", aragones: "aragonez", "tinta cao": "tinto cao", garnacha: "grenache" }[c] || c));
}
// Dois candidatos que só diferem na CASTA, e o nosso nome não diz qual:
// "Casa Santar Vinha dos Amores" é o Alfrocheiro, o Touriga Nacional ou o
// Encruzado? Não se escolhe à sorte — fica por decidir (`ambiguo`).
function ambiguoPorCasta(v, nomes) {
  if (castasDe(v.nome).length) return false;
  const grupos = new Set(nomes.map(n => castasDe(n).sort().join("+")).filter(Boolean));
  return grupos.size > 1;
}
// …a não ser que o catálogo já saiba a casta deste vinho (a ficha, não o
// nome): o "Casa Santar Vinha dos Amores" tem Touriga Nacional nas castas,
// e é esse o que se escolhe. Devolve os candidatos que ficam, ou null.
function desambiguarPorCasta(v, cands, nomeDe) {
  const minhas = new Set(castasDe((Array.isArray(v.ficha?.castas) ? v.ficha.castas : []).join(" , ")));
  if (!minhas.size) return null;
  const ok = cands.filter(c => { const cs = castasDe(nomeDe(c)); return cs.length && cs.every(x => minhas.has(x)); });
  const grupos = new Set(ok.map(c => castasDe(nomeDe(c)).sort().join("+")));
  return ok.length && grupos.size === 1 ? ok : null;
}
// As palavras a mais que são castas da nossa ficha não contam como a mais.
function aMaisSemAsNossasCastas(v, t) {
  const nossas = new Set(castasDe((Array.isArray(v.ficha?.castas) ? v.ficha.castas : []).join(" , ")).flatMap(c => c.split(" ")));
  return aMais(v, t).filter(w => !nossas.has(w));
}
function castasBatem(v, titulo) {
  const deles = new Set(castasDe(titulo));
  return castasDe(v.nome).every(c => deles.has(c));
}

// ── Um vinho ──────────────────────────────────────────────────────────
async function verificar(page, v) {
  const det = {};
  let estado = null, nomePagina = null, proposta = null;

  if (v.vivino_url && pareceVivino(v.vivino_url) && !/\s/.test(v.vivino_url)) {
    const a = await abrir(page, comAno(v.vivino_url, v.ano));
    det.atual = detalheDe(a);
    if (bloqueio(a.status, a.info)) return { estado: "bloqueado", detalhe: det };
    if (a.status === 404 || !idDoVinho(a.final) || !a.info) {
      estado = "nao_existe";
    } else {
      nomePagina = nomeDe(a.info);
      const txt = `${nomePagina || ""} ${a.info.titulo || ""} ${a.final.replace(/[-/]/g, " ")}`;
      const p = parecenca(v, txt);
      det.atual.parecenca = Math.round(p * 100) / 100;
      if (p >= LIMIAR && corBate(v, txt) && bateNome(v, nomePagina || a.info.titulo || "")) {
        estado = "certo";
        det._preco = precoDaPagina(a.info, a.final, { vivino: true });
        det._ficha = fichaDosPares(a.info, { vivino: true });
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
    // A procura do Vivino passou a mandar para o /explore, que é mais pobre:
    // a "Quinta das Carvalhas Touriga Nacional" deu só o "Quinta dos
    // Carvalhais" (25/09/2026). Sem nada que passe, UMA pesquisa Google pelo
    // Serper, se a chave estiver no .env — gasta uma do limite, só aqui.
    if (!candidatos.some(c => c.cor_bate && c.parecenca >= LIMIAR) && SERPER_KEY) {
      try {
        const q = [String(v.nome || "").replace(/\(.*?\)/g, " "), v.produtor && !norm(v.nome).includes(norm(v.produtor)) ? v.produtor : "", "site:vivino.com"]
          .join(" ").replace(/\s+/g, " ").trim();
        const j = await serper(q);
        const vistos = new Set(candidatos.map(c => idDoVinho(c.vivino_url)));
        const novos = (j.organic || []).filter(r => idDoVinho(r.link) && urlLimpo(r.link) && !vistos.has(idDoVinho(r.link)))
          .map(r => { const nomeLink = (String(urlLimpo(r.link)).match(/\/([a-z0-9-]+)\/w\/\d+/i) || [])[1]?.replace(/-/g, " ") || "";
            const t = `${tituloLimpo(r.title)} ${nomeLink}`;
            vistos.add(idDoVinho(r.link));
            return { vivino_url: urlLimpo(r.link), texto: tituloLimpo(r.title), parecenca: Math.round(parecenca(v, t) * 100) / 100,
                     cor_bate: corBate(v, t), nome_bate: bateNome(v, nomeLink || r.title), a_mais: aMais(v, nomeLink || r.title), serper: true }; });
        det.procura.serper = { q, resultados: novos.length };
        candidatos = candidatos.concat(novos).sort((x, y) => (y.cor_bate - x.cor_bate) || (y.nome_bate - x.nome_bate)
          || (y.parecenca - x.parecenca) || (x.a_mais.length - y.a_mais.length));
      } catch (e) { det.procura.serper = { erro: String(e.message || e).slice(0, 200) }; }
    }
    let melhor = candidatos.find(c => c.cor_bate && c.nome_bate && c.parecenca >= LIMIAR);
    const parecidos = candidatos.filter(c => c.cor_bate && c.parecenca >= LIMIAR);
    const nomeDoLink = c => c.vivino_url.replace(/.*\/([^/]+)\/w\/.*/, "$1").replace(/-/g, " ");
    if (!melhor || ambiguoPorCasta(v, parecidos.map(nomeDoLink))) {
      const r = desambiguarPorCasta(v, parecidos, nomeDoLink);
      melhor = r ? r.find(c => aMaisSemAsNossasCastas(v, nomeDoLink(c)).length <= MAX_A_MAIS) || null : null;
      if (melhor) det.desambiguado = "pela casta da ficha";
      else if (ambiguoPorCasta(v, parecidos.map(nomeDoLink))) det.ambiguo = parecidos.map(c => c.vivino_url);
    }
    if (melhor) {
      await pausa();
      const b = await abrir(page, comAno(melhor.vivino_url, v.ano));
      det.melhor = detalheDe(b);
      if (bloqueio(b.status, b.info)) return { estado: "bloqueado", nome_pagina: nomePagina, candidatos, detalhe: det };
      if (b.info && idDoVinho(b.final)) {
        const nome = nomeDe(b.info);
        const txt = `${nome || ""} ${b.info.titulo || ""} ${b.final.replace(/[-/]/g, " ")}`;
        const p = parecenca(v, txt);
        const nomeOk = det.desambiguado
          ? mencaoBate(v, tituloLimpo(nome || "")) && aMaisSemAsNossasCastas(v, tituloLimpo(nome || b.info.titulo || "")).length <= MAX_A_MAIS
          : bateNome(v, nome || b.info.titulo || "");
        if (p >= LIMIAR && corBate(v, txt) && nomeOk) {
          det._preco = precoDaPagina(b.info, b.final, { vivino: true });
          det._ficha = fichaDosPares(b.info, { vivino: true });
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
  const ficha = det._ficha || null;
  delete det._ficha;
  if (ficha && Object.keys(ficha).length) det.ficha_lida = ficha;
  return { estado, nome_pagina: nomePagina, proposta, candidatos, detalhe: det, vivino_preco: det._preco || null, ficha };
}

function pausa() {
  return new Promise(r => setTimeout(r, PAUSA_MIN + Math.random() * (PAUSA_MAX - PAUSA_MIN)));
}

// ── A ficha que a página diz (castas, região, teor…) ──────────────────
// Dos pares "rótulo → valor" que a `lerPagina` apanhou. Só o que é sobre o
// VINHO (invariante 1), e só para preencher campos VAZIOS do catálogo — o
// que alguém já escreveu não é tapado por uma página (ver `planoDoVinho`).
// A cor (`tipo`) não: é o admin que a diz, antes de procurar.
const ROTULOS = [
  ["castas", /^(castas?|casta\(s\)|uvas?|variedades?|grapes?|grape varieties|varietal)\b/],
  ["sub_regiao", /^sub-?regi/],
  ["regiao", /^(regi[aã]o|region|denomina[cç][aã]o|appellation|origem)\b/],
  ["teor", /^(teor|grau|gradua|[aá]lcool|alcohol|alc\.|volume alco)/],
  ["estagio_texto", /^(est[aá]gio|envelhecimento|amadurecimento|aging|ageing|matura[cç][aã]o)/],
  ["harmonizacao", /^(harmoniza|food pairing|acompanha|sugest[aã]o de harmoniza|gastronomia)/],
  // As notas de prova vêm muitas vezes aos bocados — Cor, Aroma, Sabor (a
  // Vinha.pt), "Nota de prova - Aroma" (a Granvine) — e juntam-se.
  ["prova_parte", /^(nota de prova\s*-\s*)?(cor|aroma|nariz|sabor|boca|paladar|final)\b/],
  ["notas_prova", /^(notas? de prova|tasting notes?|prova)\b/],
  ["pais", /^(pa[ií]s|country)\b/],
  ["produtor", /^(produtor|winery|producer|adega|marca)\b/],
];
// A região que o catálogo usa, de um texto de página. O Vivino escreve a
// hierarquia em inglês, do largo para o estreito ("Portugal / Northern
// Portugal / Duriense", "Portugal / Alentejano / Alentejo"), e na 1.ª corrida
// de vinhos novos a região ficou "Northern Portugal" e "Central Portugal".
// Aceitam-se só regiões portuguesas conhecidas, a primeira que aparecer.
const REGIOES = [
  ["Vinho Verde", /\b(vinho verde|minho)\b/], ["Trás-os-Montes", /\btras os montes|transmontano\b/],
  ["Douro", /\b(douro|duriense|porto)\b/], ["Távora-Varosa", /\btavora\b/], ["Dão", /\bdao\b/],
  ["Bairrada", /\bbairrada\b/], ["Beira Interior", /\bbeira interior\b/], ["Beiras", /\bbeiras?\b|terras do dao/],
  ["Lisboa", /\blisboa|estremadura|colares|bucelas\b/], ["Tejo", /\btejo|ribatejo\b/],
  ["Península de Setúbal", /\bsetubal|palmela\b/], ["Alentejo", /\balentej/], ["Algarve", /\balgarve\b/],
  ["Madeira", /\bmadeira\b/], ["Açores", /\bacores|azores\b/],
];
function regiaoDe(t) {
  // A parte mais específica primeiro: "… / Terras do Dão / Dão".
  for (const parte of String(t).split(/\s*[\/,›>|·]\s*/).reverse()) {
    const n = norm(parte);
    const r = REGIOES.find(([, re]) => re.test(n));
    if (r) return r[0];
  }
  return null;
}
// A fotografia: http(s), com ar de imagem, e não o logótipo da loja. No
// Vivino, só as do `images.vivino.com` (as garrafas recortadas que a app já
// mostrava quando a IA as trazia).
function imagemDe(u, { vivino = false } = {}) {
  if (!u) return null;
  let url = String(u).trim();
  if (url.startsWith("//")) url = "https:" + url;
  if (!/^https?:\/\//i.test(url) || /logo|placeholder|no[-_]?image|default|banner|share/i.test(url)) return null;
  if (vivino && !/images\.vivino\.com/i.test(url)) return null;
  return url;
}
function fichaDosPares(info, { vivino = false } = {}) {
  const f = {}, prova = [];
  for (const [r, val] of info?.pares || []) {
    // Na Granvine cada célula é já "Rótulo: valor" — e uma linha de tabela
    // com duas células dava o PAR ("País: Portugal", "Região: Douro"): o
    // país ficava "Região: Douro". Um rótulo com ":" ou um valor que é
    // outro "Rótulo: valor" não é um par; as linhas soltas apanham-nos.
    if (/:/.test(r) || /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .\/-]{1,35}:\s/.test(String(val))) continue;
    const rot = norm(r);
    const campo = (ROTULOS.find(([, re]) => re.test(r.toLowerCase()) || re.test(rot)) || [])[0];
    if (campo === "prova_parte") {
      const t = String(val).trim();
      const nomeParte = r.replace(/^nota de prova\s*-\s*/i, "").trim();
      if (t && t.length <= 600 && !prova.some(x => x.startsWith(nomeParte + ":"))) prova.push(`${nomeParte}: ${t}`);
      continue;
    }
    if (!campo || f[campo] != null) continue;
    // "…muito rara) Ano da colheita: 2017": o rótulo seguinte colado ao fim.
    const t = String(val).split(/\s(?=[A-ZÀ-Ý][A-Za-zÀ-ÿ ]{2,30}:\s)/)[0].trim();
    if (!t || t.length > (campo === "notas_prova" ? 1500 : 400)) continue;
    if (campo === "castas") {
      const l = t.split(/\s*(?:,|;|\/|\be\b|&|\+|·)\s*/i).map(x => x.replace(/\s*\(?\d+\s*%\)?/g, "").trim())
        .filter(x => x.length >= 3 && x.length <= 40 && !/\d/.test(x));
      // Sinónimos numa casta só: o Vivino escreve "Shiraz/Syrah".
      const SIN = { shiraz: "Syrah", aragones: "Aragonez" };
      const vistos = new Map();
      for (const x of l) { const c = SIN[norm(x)] || x; if (!vistos.has(norm(c))) vistos.set(norm(c), c); }
      if (vistos.size && vistos.size <= 12) f.castas = [...vistos.values()];
    } else if (campo === "teor") {
      const n = numero((t.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*%?/) || [])[1]);
      if (n != null && n >= 5 && n <= 25) f.teor = n;
    } else if (campo === "regiao") {
      const r = regiaoDe(t);
      if (r) f.regiao = r;
    } else if (campo === "notas_prova") {
      if (t.length >= 30) f.notas_prova = t;
    } else {
      f[campo] = t;
    }
  }
  if (f.notas_prova == null && prova.length) f.notas_prova = prova.join(" · ");
  if (f.estagio_texto && f.estagio_meses == null) {
    const m = f.estagio_texto.match(/(\d{1,2})\s*meses/i);
    if (m && +m[1] >= 1 && +m[1] <= 120) f.estagio_meses = +m[1];
  }
  if (vivino && f.harmonizacao == null && info?.comidas?.length) f.harmonizacao = info.comidas.join(", ");
  const img = imagemDe(info?.imagem, { vivino });
  if (img) f.imagem_url = img;
  // A descrição do produto numa LOJA costuma ser a nota de prova; a do
  // Vivino é genérica ("um tinto do Douro…") e fica de fora.
  if (!vivino && f.notas_prova == null && info?.ldDescricao && info.ldDescricao.length >= 80) f.notas_prova = info.ldDescricao;
  return f;
}
// Os campos que a página pode encher, pela ordem da ficha.
const CAMPOS_PAGINA = ["imagem_url", "castas", "regiao", "sub_regiao", "pais", "teor", "estagio_meses", "estagio_texto", "harmonizacao", "notas_prova"];

// O Vivino abre-se na COLHEITA do catálogo (`?year=`): a nota e as
// avaliações são da colheita (campos voláteis — invariante 6). Na 1.ª
// corrida, o Carm sem `?year=` deu 8664 avaliações (o vinho todo) e a Leda
// com `?year=2019` deu 1936 (só aquela). O link GRAVADO continua sem ano.
function comAno(url, ano) {
  const limpo = urlLimpo(url);
  if (!limpo) return url;
  return ano ? `${limpo}?year=${ano}` : limpo;
}

// ── Preço numa página (Vivino ou loja) ───────────────────────────────
// Só em euros, e só um número que pareça um preço de garrafa (1–2000 €).
// No VIVINO a moeda tem de vir dita (EUR): na 1.ª corrida, o link sueco do
// Casa de Saima deu 8,49 — uma garrafa de 60 €. Nas lojas (portuguesas),
// vale também o preço à vista ("45,95 €"), quando não há dado estruturado.
function precoDaPagina(info, url, { vivino = false } = {}) {
  if (!info) return null;
  let preco = null;
  if (info.ldPreco && (vivino ? /^EUR$/i.test(info.ldPreco.moeda || "") : (!info.ldPreco.moeda || /EUR/i.test(info.ldPreco.moeda))))
    preco = numero(info.ldPreco.preco);
  if (preco == null && !vivino) preco = numero(info.metaPreco);
  if (preco == null && !vivino && info.precoTexto) {
    const m = info.precoTexto.match(/(\d{1,4}(?:[.,]\d{2}))\s*€|€\s*(\d{1,4}(?:[.,]\d{2}))/);
    if (m) preco = numero(m[1] || m[2]);
  }
  if (preco == null || preco < 1 || preco > 2000) return null;
  return { preco: Math.round(preco * 100) / 100, url: String(url || "").split(/[?#]/)[0] };
}

// ── As lojas: Garrafeira Nacional, Granvine, Vinha.pt ─────────────────
// A prioridade do preço, decidida pelo dono (25/09/2026, e a Vinha.pt no
// mesmo dia): Garrafeira Nacional → Granvine → Vinha → Vivino. Guardam-se
// TODOS em `precos` (cada um com o link, a colheita e a data), e o
// `preco_medio` fica com o primeiro que houver, com a origem da loja.
//
// Nada disto foi escrito a ver as lojas (a rede de onde foi escrito não lá
// chega). A GN e a Granvine confirmaram-se na 1.ª corrida em casa (Magento,
// `/catalogsearch/result/?q=`); a Vinha.pt na 2.ª (WooCommerce, `?s=…&
// post_type=product` — os outros endereços davam 404). Uma loja nova pode
// levar vários endereços em `procuras` e uma `casa` para o formulário de
// procura da página inicial; o que resultou fica no `detalhe` (`como`).
const LOJAS = [
  { id: "garrafeira_nacional", nome: "Garrafeira Nacional", origem: "loja-garrafeira-nacional",
    procuras: [q => `https://www.garrafeiranacional.com/catalogsearch/result/?q=${encodeURIComponent(q)}`] },
  { id: "granvine", nome: "Granvine", origem: "loja-granvine",
    procuras: [q => `https://granvine.com/pt/catalogsearch/result/?q=${encodeURIComponent(q)}`] },
  { id: "vinha", nome: "Vinha.pt", origem: "loja-vinha", casa: "https://www.vinha.pt/",
    // WooCommerce: confirmado na 1.ª corrida (as outras davam 404).
    procuras: [q => `https://www.vinha.pt/?s=${encodeURIComponent(q)}&post_type=product`] },
];
const PRIORIDADE_PRECO = ["garrafeira_nacional", "granvine", "vinha", "vivino"];
// Garrafas que não são "a" garrafa: outro tamanho, ou mais do que uma.
const NAO_E_GARRAFA = /magnum|jeroboam|\b1[.,]5\s?l\b|\b150\s?cl\b|\b3\s?l\b|\b300\s?cl\b|\b37[.,]5\s?cl\b|\b375\s?ml\b|\b50\s?cl\b|\b500\s?ml\b|\bcaixa\b|\bpack\b|\b\d+\s?x\s?75|\b\d+\s?garrafas\b/i;
function colheitaDe(t) { const m = String(t || "").match(/\b(19[5-9]\d|20[0-4]\d)\b/); return m ? +m[1] : null; }
// Que endereço de procura resultou em cada loja, nesta corrida.
const PROCURA_BOA = {};

// Os produtos de uma página de resultados. Primeiro os seletores das
// plataformas conhecidas (Magento, PrestaShop, WooCommerce, Shopify); sem
// nenhum, qualquer link da mesma loja cujo texto tenha uma palavra
// distintiva do nosso nome — o filtro a sério vem depois (`bateNome`).
async function produtosDaPagina(page, chaves) {
  return await page.evaluate((chaves) => {
    const n = t => (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const limpa = t => (t || "").replace(/\s+/g, " ").trim();
    const vistos = new Map();
    const lixo = /catalogsearch|checkout|customer|wishlist|compare|carrinho|cart|login|conta|account|pesquisa|search|\?s=|#/i;
    const cartoes = ".product-item, li.product, .product-item-info, .product-card, .product-miniature, article.product, .product, .grid-product, .card-wrapper";
    const add = (el, cartao) => {
      const href = (el.href || "").split(/[?#]/)[0];
      if (!href || vistos.has(href) || lixo.test(href) || new URL(href).host !== location.host) return;
      const nomeEl = cartao.querySelector("a.product-item-link, .product-item-name, .product-name, .product-title, .woocommerce-loop-product__title, .card__heading, h2, h3") || el;
      const nome = limpa(nomeEl.innerText || el.innerText || el.getAttribute("title"));
      if (!nome || nome.length > 160) return;
      vistos.set(href, { href, nome, texto: limpa(cartao.innerText).slice(0, 200),
        preco: cartao.querySelector("[data-price-amount]")?.getAttribute("data-price-amount")
          || cartao.querySelector('[itemprop="price"]')?.getAttribute("content") || null });
    };
    const sel = 'a.product-item-link, .product-item a[href], li.product a[href], .product-item-info a[href], .product-card a[href], ' +
      '.product-miniature a[href], .product-title a[href], a.woocommerce-LoopProduct-link, a[href*="/products/"]';
    for (const el of document.querySelectorAll(sel)) add(el, el.closest(cartoes) || el);
    let como = "seletores";
    if (!vistos.size && chaves.length) {
      como = "links";
      for (const el of document.querySelectorAll("main a[href], #content a[href], body a[href]")) {
        // "Termos e Condições", "App para iOS": o rodapé e o menu não são produtos.
        if (el.closest("header, footer, nav, [class*=footer], [class*=menu], [id*=footer]")) continue;
        const t = n(el.innerText);
        if (t.length < 5 || t.length > 150) continue;
        if (chaves.some(k => t.includes(k))) add(el, el.closest(cartoes) || el.parentElement || el);
        if (vistos.size >= 15) break;
      }
    }
    return { itens: [...vistos.values()].slice(0, 15), como };
  }, chaves).catch(() => ({ itens: [], como: "erro" }));
}

// O formulário de procura da página inicial, quando nenhum endereço deu.
async function procurarPeloFormulario(page, loja, q) {
  const a = await abrir(page, loja.casa);
  if (bloqueio(a.status, a.info)) return { bloqueado: true, status: a.status };
  const campo = await page.$('input[type="search"], input[name="q"], input[name="s"], input[name="search"], input[name="search_query"], input[placeholder*="esquis" i], input[placeholder*="rocura" i]');
  if (!campo) return { status: a.status, sem_campo: true };
  await campo.fill(q).catch(() => {});
  await Promise.all([page.waitForLoadState("domcontentloaded").catch(() => {}), campo.press("Enter").catch(() => {})]);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  return { status: 200, url: page.url() };
}

async function lerLoja(page, loja, v) {
  const nome = String(v.nome || "").replace(/\(.*?\)/g, " ").replace(/\b(19|20)\d{2}\b/g, " ").replace(/\s+/g, " ").trim();
  const semCor = nome.replace(/\b(tinto|branco|ros[ée])\b/gi, " ").replace(/\s+/g, " ").trim();
  // Terceira tentativa, só as palavras que identificam o vinho: "Palácio
  // da Bacalhoa" deu zero na GN, que é estrita com palavras a mais.
  const soDistintivas = distintivas(nome).slice(0, 4).join(" ");
  const chaves = distintivas(nome).filter(t => t.length >= 4);
  const det = { loja: loja.id, procuras: [] };
  for (const q of [...new Set([nome, semCor, soDistintivas])].filter(x => x && x.length >= 3)) {
    let itens = [], como = null;
    const ordem = PROCURA_BOA[loja.id] != null ? [PROCURA_BOA[loja.id]] : loja.procuras.map((_, k) => k);
    for (const k of ordem) {
      const url = loja.procuras[k](q);
      const a = await abrir(page, url);
      if (bloqueio(a.status, a.info)) return { bloqueado: true, detalhe: { ...det, http: a.status } };
      const r = await produtosDaPagina(page, chaves);
      // Os primeiros nomes que a loja mostrou: é o que diz porque é que
      // nenhum passou nas regras de nome (a Carvalhas teve 4 e nenhum).
      det.procuras.push({ q, url, http: a.status, itens: r.itens.length, como: r.como,
        nomes: r.itens.slice(0, 6).map(it => it.nome) });
      if (r.itens.length) { itens = r.itens; como = r.como; PROCURA_BOA[loja.id] = k; break; }
      if (ordem.length > 1) await pausa();
    }
    if (!itens.length && loja.casa && PROCURA_BOA[loja.id] == null) {
      const f = await procurarPeloFormulario(page, loja, q);
      if (f.bloqueado) return { bloqueado: true, detalhe: { ...det, http: f.status } };
      if (!f.sem_campo) {
        const r = await produtosDaPagina(page, chaves);
        det.procuras.push({ q, formulario: true, url: f.url, itens: r.itens.length, como: r.como });
        itens = r.itens; como = r.como;
      } else det.procuras.push({ q, formulario: true, sem_campo: true });
    }
    const bons = itens.map(it => ({
      ...it,
      parecenca: parecenca(v, it.nome), cor_bate: corBate(v, it.nome), nome_bate: bateNome(v, it.nome),
      colheita: colheitaDe(it.nome), garrafa: !NAO_E_GARRAFA.test(`${it.nome} ${it.texto}`),
    })).filter(it => it.garrafa && it.cor_bate && it.nome_bate && it.parecenca >= LIMIAR)
      // A mesma colheita primeiro; senão a mais recente — aceite por decisão
      // do dono, com a colheita guardada ao lado do preço.
      .sort((x, y) => (Number(y.colheita === v.ano) - Number(x.colheita === v.ano))
        || (y.parecenca - x.parecenca) || ((y.colheita || 0) - (x.colheita || 0)));
    // Os que só falham pela casta a mais também contam para a ambiguidade.
    const quaseTodos = itens.filter(it => parecenca(v, it.nome) >= LIMIAR && corBate(v, it.nome) && mencaoBate(v, tituloLimpo(it.nome)));
    if (!bons.length && !desambiguarPorCasta(v, quaseTodos, it => it.nome)) continue;
    let b = bons[0];
    if (!b || ambiguoPorCasta(v, quaseTodos.map(it => it.nome))) {
      const r = desambiguarPorCasta(v, quaseTodos, it => it.nome);
      const escolhido = r && r.filter(it => aMaisSemAsNossasCastas(v, tituloLimpo(it.nome)).length <= MAX_A_MAIS
        && !NAO_E_GARRAFA.test(`${it.nome} ${it.texto}`))
        .sort((x, y) => (Number(colheitaDe(y.nome) === v.ano) - Number(colheitaDe(x.nome) === v.ano)) || ((colheitaDe(y.nome) || 0) - (colheitaDe(x.nome) || 0)))[0];
      if (!escolhido) { det.ambiguo = quaseTodos.slice(0, 6).map(it => it.nome); return { detalhe: det }; }
      det.desambiguado = "pela casta da ficha";
      b = { ...escolhido, colheita: colheitaDe(escolhido.nome) };
    }
    await pausa();
    const pg = await abrir(page, b.href);
    if (bloqueio(pg.status, pg.info)) return { bloqueado: true, detalhe: det };
    const pp = precoDaPagina(pg.info, b.href) || (numero(b.preco) ? { preco: numero(b.preco), url: b.href } : null);
    const ficha = fichaDosPares(pg.info);
    det.escolhido = { nome: b.nome, href: b.href, http: pg.status, jsonld: !!pg.info?.ldTem, como,
      ficha_lida: Object.keys(ficha).length ? ficha : undefined,
      // Para afinar a leitura: os primeiros rótulos que a página tem.
      rotulos: (pg.info?.pares || []).slice(0, 25).map(([r]) => r) };
    if (!pp) { det.sem_preco = true; return { detalhe: det, ficha }; }
    return { achado: { preco: pp.preco, url: b.href, colheita: b.colheita, nome: b.nome }, detalhe: det, ficha };
  }
  return { detalhe: det };
}

// ── Motor Serper: o Google em vez do Vivino ───────────────────────────
// A nota e as avaliações vêm do que o Google mostra do resultado: as
// estrelas (`rating`/`ratingCount` do Serper) quando as há, senão o excerto
// ("Classificação: 4,1 · 1234 avaliações" / "Rating: 4.1 - 1,234 votes").
// O que não se lê fica de fora da proposta — nunca um palpite.
function numerosDoResultado(r) {
  let nota = numero(r.rating), aval = inteiro(r.ratingCount);
  const t = `${r.snippet || ""} ${(r.attributes && JSON.stringify(r.attributes)) || ""}`;
  if (nota == null) {
    const m = t.match(/(?:rating|classifica\w*|avalia\w*|nota)\s*[:\-–]?\s*([1-5][.,]\d)/i);
    if (m) nota = numero(m[1]);
  }
  // "3,9 · 1 570 avaliações": a nota solta, logo antes da contagem.
  if (nota == null) {
    const m = t.match(/(?:^|[^\d])([1-5][.,]\d)\s*[·\-–(|]\s*\d[\d.,\s\u00a0\u202f]*\s*(?:votes|ratings|avalia|classifica|notas)/i);
    if (m) nota = numero(m[1]);
  }
  if (aval == null) {
    // Separadores de milhares só entre grupos de TRÊS dígitos: "2017 4249
    // avaliações" (o ano e a contagem lado a lado) deu 20174249 na 1.ª corrida.
    const m = t.match(/(?<![\d.,])(\d{1,3}(?:[.,\u00a0\u202f ]\d{3})+|\d+)\s*(votes|ratings|avalia[çc][õo]es|classifica[çc][õo]es|notas)/i);
    if (m) aval = inteiro(m[1]);
  }
  if (nota != null && (nota < 1 || nota > 5)) nota = null;
  return { nota, aval };
}

async function serper(q) {
  const r = await fetch(SERPER_URL, {
    method: "POST",
    headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q, gl: "pt", hl: "pt-pt", num: 10 }),
  });
  const tx = await r.text();
  if (!r.ok) {
    const e = new Error(`Serper HTTP ${r.status}: ${tx.slice(0, 200)}`);
    e.fatal = r.status === 401 || r.status === 403 || r.status === 429;
    throw e;
  }
  return JSON.parse(tx);
}

// O título que o Google mostra de uma página do Vivino, sem o que é do
// site ("| Vivino Español", "- Vivino") nem a colheita à frente.
function tituloLimpo(t) {
  return String(t || "").replace(/\s*[|\-–]\s*Vivino.*$/i, "").replace(/^\s*(?:\d{4}|N\.?V\.?)\s+/i, "")
    .replace(/\s*(?:\.\.\.|…)\s*$/, "").trim();
}
// Palavras DISTINTIVAS do título que não estão no nome nem no produtor do
// catálogo. É a outra metade da `parecenca`: esta diz se o nome do
// catálogo está no título; aquela diz se o título é de um vinho MAIOR.
// Na 1.ª corrida, "Quinta do Crasto" casou com "Quinta do Crasto Etiqueta
// Negra", "Quinta Nova" com "…Carmo TN Touriga Nacional" e "Post" com
// "Post Reserve Cabernet Sauvignon" — todos a 100% de parecença.
function aMais(v, titulo) {
  const nossas = new Set([...palavras(v.nome), ...palavras(v.produtor)]);
  return distintivas(titulo).filter(t => !nossas.has(t));
}
const MAX_A_MAIS = 1;

// A MENÇÃO separa vinhos da mesma casa, e está na lista das genéricas
// (sozinha não identifica nada): na 2.ª corrida, "Carm Grande Reserva
// Branco" casou com "CARM Reserva Branco". Tem de ser a MESMA dos dois
// lados — incluindo nenhuma: "Herdade dos Grous" não é o "…Grous Reserva".
function mencao(t) {
  const n = ` ${norm(t)} `;
  if (/ (grande|gran) (reserva|reserve) | grande escolha /.test(n)) return "grande reserva";
  if (/ garrafeira /.test(n)) return "garrafeira";
  if (/ colheita seleccionada | colheita selecionada /.test(n)) return "colheita selecionada";
  if (/ (reserva|reserve) /.test(n)) return "reserva";
  return "";
}
function mencaoBate(v, titulo) { return mencao(v.nome) === mencao(titulo); }

async function verificarSerper(v) {
  const nome = String(v.nome || "").replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
  const prod = v.produtor && !norm(nome).includes(norm(v.produtor))
    ? String(v.produtor).replace(/\(.*?\)/g, " ").trim() : "";
  // Sem aspas: o Vivino escreve os nomes à sua maneira ("Tapada do Chaves
  // Reserva Tinto" para o nosso "…Tinto Reserva") e a frase exata não os
  // achava. Com o produtor primeiro; sem ele, só se a primeira não bastar —
  // o Vivino nem sempre o põe no título ("Rui Roboredo Madeira" deu zero).
  const consultas = [`${nome}${prod ? " " + prod : ""} site:vivino.com`];
  if (prod) consultas.push(`${nome} site:vivino.com`);
  // …e sem a cor no nome: o Vivino escreve "Tapada do Chaves Reserva Tinto"
  // e o nosso "Tapada do Chaves Tinto Reserva" não deu nada na 2.ª corrida.
  const semCor = nome.replace(/\b(tinto|branco|ros[ée])\b/gi, " ").replace(/\s+/g, " ").trim();
  if (semCor && semCor !== nome && consultas.length < 2) consultas.push(`${semCor} site:vivino.com`);
  const det = { motor: "serper", consultas: [] };

  const atualId = idDoVinho(v.vivino_url);
  const atualValido = !!(v.vivino_url && pareceVivino(v.vivino_url) && !/\s/.test(v.vivino_url) && atualId);
  let resultados = [], candidatos = [], bons = [];
  for (const q of consultas) {
    const j = await serper(q);
    const rs = (j.organic || []).filter(r => idDoVinho(r.link) && urlLimpo(r.link));
    det.consultas.push({ q, resultados: rs.length });
    resultados = resultados.concat(rs);
    // Um candidato por NÚMERO de vinho — o mesmo vinho vem várias vezes, uma
    // por língua do Vivino — com os números juntos de todas as versões.
    const porId = new Map();
    for (const r of resultados) {
      const id = idDoVinho(r.link);
      const tit = tituloLimpo(r.title);
      const txt = `${tit} ${r.link.replace(/[-/]/g, " ")}`;
      const { nota, aval } = numerosDoResultado(r);
      const c = porId.get(id) || { vivino_url: urlLimpo(r.link), texto: tit || r.link, notas: [], avals: [],
        parecenca: 0, cor_bate: false, a_mais: null, mencao_bate: false };
      if (mencaoBate(v, tit)) c.mencao_bate = true;
      const p = Math.round(parecenca(v, txt) * 100) / 100;
      if (p > c.parecenca || c.a_mais == null) {
        c.parecenca = Math.max(c.parecenca, p); c.cor_bate = corBate(v, txt);
        const am = aMais(v, tit);
        if (c.a_mais == null || am.length < c.a_mais.length) { c.a_mais = am; c.texto = tit || c.texto; }
      }
      if (nota != null) c.notas.push(nota);
      if (aval != null) c.avals.push(aval);
      porId.set(id, c);
    }
    const moda = xs => xs.length ? [...xs].sort((a, b) => xs.filter(x => x === b).length - xs.filter(x => x === a).length)[0] : null;
    candidatos = [...porId.values()].map(c => ({
      vivino_url: c.vivino_url, texto: c.texto, parecenca: c.parecenca, cor_bate: c.cor_bate,
      a_mais: c.a_mais || [], mencao_bate: c.mencao_bate, nota: moda(c.notas), avaliacoes: moda(c.avals),
    // A parecença primeiro: faltar uma palavra do NOSSO nome ("Syrah") é
    // pior do que o título ter uma a mais ("Signature"). Na 2.ª corrida, a
    // ordem ao contrário escolheu o "Aldeias de Juromenha Reserva" (sem o
    // Syrah) em vez do "Signature Reserva Syrah".
    })).sort((x, y) => (y.cor_bate - x.cor_bate) || (y.mencao_bate - x.mencao_bate)
      || (y.parecenca - x.parecenca) || (x.a_mais.length - y.a_mais.length));
    bons = candidatos.filter(c => c.cor_bate && c.mencao_bate && c.parecenca >= LIMIAR && c.a_mais.length <= MAX_A_MAIS);
    if (bons.length) break;
  }

  // Entre resultados igualmente bons, o do link atual primeiro: não se
  // propõe trocar um link por outro que o Google considera equivalente.
  const melhor = bons.find(c => idDoVinho(c.vivino_url) === atualId
    && c.parecenca === bons[0].parecenca && c.a_mais.length === bons[0].a_mais.length) || bons[0];

  let estado, proposta = null;
  if (melhor) {
    proposta = { vivino_url: melhor.vivino_url, nome: melhor.texto, confianca: melhor.parecenca };
    if (melhor.nota != null) proposta.vivino_nota = melhor.nota;
    if (melhor.avaliacoes != null) proposta.vivino_avaliacoes = melhor.avaliacoes;
    if (atualValido && idDoVinho(melhor.vivino_url) === atualId) estado = "certo";
    else estado = v.vivino_url ? "diferente" : "sem_link";
  } else if (v.vivino_url && !atualValido && !/\/wines\/\d+/.test(v.vivino_url)) {
    // Um link num formato que o Vivino não usa (sem /w/<nº>, /Wines/…,
    // texto lá dentro) não abre nunca; sem alternativa, propõe-se apagá-lo.
    // Um /wines/<nº> fica de fora: é o número de uma colheita e PODE abrir —
    // sem o abrir, não se propõe apagar nada.
    estado = "nao_existe"; proposta = { vivino_url: null };
  } else {
    estado = "nao_encontrado";
  }
  det.pesquisas = det.consultas.length;
  // O nome que o Google mostra para o link ATUAL, quando ele aparece.
  const doAtual = atualId && resultados.find(r => idDoVinho(r.link) === atualId);
  return { estado, nome_pagina: doAtual ? tituloLimpo(doAtual.title) : null, proposta,
           candidatos: candidatos.slice(0, 5), detalhe: det };
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  if (!SB_KEY) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY.");
  if (process.env.APLICAR) return aplicarSimulacao(process.env.APLICAR);
  if (MOTOR === "serper" && !SERPER_KEY) throw new Error("Falta SEARCH_API_KEY (a chave do Serper).");
  if (!["serper", "browser"].includes(MOTOR)) throw new Error(`MOTOR desconhecido: ${MOTOR}`);
  let plano;
  if (process.env.NOVO) {
    // "Vinho novo" do painel: os vinhos vêm escritos pelo admin, não da fila.
    plano = { vinhos: await vinhosNovos(JSON.parse(process.env.NOVO)), motivo: "vinho novo" };
  } else if (process.env.IDS) {
    // Escolhidos à mão na lista do catálogo do painel (até 50).
    const ids = process.env.IDS.split(",").map(x => parseInt(x, 10)).filter(Number.isFinite).slice(0, 50);
    plano = { vinhos: await rpc("vivino_estes", { p_ids: ids }), motivo: "escolhidos no painel" };
  } else {
    plano = await rpc("vivino_a_tratar", { p_manual: MANUAL, p_limite: LIMITE });
    if (!plano?.correr) { console.log(`Hoje não: ${plano?.motivo}`); return; }
  }
  console.log(`A tratar ${plano.vinhos.length} vinho(s) — ${plano.motivo} · motor ${MOTOR}${ENSAIO ? " (ENSAIO, não grava)" : ""}`);

  // O Playwright só se carrega no motor que o usa: no Actions (Serper) nem
  // sequer está instalado.
  let browser = null, page = null;
  if (MOTOR === "browser") {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      locale: "pt-PT",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
    });
    page = await ctx.newPage();
  }
  const resumo = {};
  const simulacao = [];
  const lojasBloqueadas = new Set();
  let bloqueios = 0;
  try {
    for (const [i, v] of plano.vinhos.entries()) {
      if (i > 0) await (MOTOR === "serper" ? new Promise(r => setTimeout(r, 700)) : pausa());
      let res;
      try { res = MOTOR === "serper" ? await verificarSerper(v) : await verificar(page, v); }
      catch (e) {
        res = { estado: "erro", detalhe: { motor: MOTOR, erro: String(e.message || e).slice(0, 300) } };
        if (e.fatal) {
          console.log(`#${v.id} ${v.nome} → erro: ${e.message}`);
          console.log("O Serper recusou (chave, ou limite gasto) — paro aqui.");
          if (!ENSAIO && v.id) await rpc("vivino_gravar", { p_vinho_id: v.id, p_res: res, p_execucao: EXECUCAO });
          break;
        }
      }
      if (res.detalhe && !res.detalhe.motor) res.detalhe.motor = MOTOR;
      resumo[res.estado] = (resumo[res.estado] || 0) + 1;
      if (res.detalhe?.pesquisas) resumo.pesquisas_serper = (resumo.pesquisas_serper || 0) + res.detalhe.pesquisas;
      const p = res.proposta;
      console.log(`${v.id ? "#" + v.id : "NOVO"} ${v.nome}${v.ano && !String(v.nome).includes(String(v.ano)) ? " " + v.ano : ""} → ${res.estado}` +
        (res.nome_pagina ? ` · página: "${res.nome_pagina}"` : "") +
        (p ? ` · proposta: ${p.vivino_url ?? "apagar o link"} ${p.vivino_nota ?? ""} ${p.vivino_avaliacoes ?? ""}` : ""));
      // ── As lojas (só no PC: o motor Serper não abre páginas) ──
      const hoje = new Date().toISOString().slice(0, 10);
      const precos = { ...(v.precos && typeof v.precos === "object" ? v.precos : {}) };
      let precosMudaram = false;
      // O que cada página diz da ficha, pela ordem da prioridade das fontes.
      const fichas = [];
      if (MOTOR === "browser" && LOJAS_LIGADAS && res.estado !== "bloqueado") {
        res.detalhe = res.detalhe || {};
        res.detalhe.lojas = [];
        for (const loja of LOJAS) {
          if (lojasBloqueadas.has(loja.id)) continue;
          await pausa();
          let r;
          try { r = await lerLoja(page, loja, v); }
          catch (e) { r = { detalhe: { loja: loja.id, erro: String(e.message || e).slice(0, 200) } }; }
          res.detalhe.lojas.push(r.detalhe);
          if (r.ficha && Object.keys(r.ficha).length)
            fichas.push({ origem: loja.origem, ficha: r.ficha, fonte: { url: r.detalhe?.escolhido?.href, titulo: loja.nome } });
          if (r.bloqueado) { lojasBloqueadas.add(loja.id); console.log(`   ${loja.nome}: recusou as páginas — salto-a no resto da corrida.`); continue; }
          if (r.achado) {
            precos[loja.id] = { ...r.achado, em: hoje };
            precosMudaram = true;
            console.log(`   ${loja.nome}: ${r.achado.preco.toFixed(2)} €${r.achado.colheita ? ` (colheita ${r.achado.colheita})` : ""} — "${r.achado.nome}"`);
          } else {
            console.log(`   ${loja.nome}: ${r.detalhe?.sem_preco ? "encontrou o vinho mas não leu o preço" : "não encontrou"}`);
          }
        }
      }
      if (res.vivino_preco) {
        precos.vivino = { ...res.vivino_preco, em: hoje };
        precosMudaram = true;
        console.log(`   Vivino: ${res.vivino_preco.preco.toFixed(2)} €`);
      }
      // O preço do Vivino tem de estar perto do das lojas (metade a dobro):
      // o 8,49 € de um Garrafeira de 60 € não era da mesma garrafa. Vale
      // também para um preço do Vivino gravado numa corrida anterior.
      const daLoja = PRIORIDADE_PRECO.filter(k => k !== "vivino").map(k => precos[k]).find(x => x && numero(x.preco) != null);
      if (precos.vivino && daLoja) {
        const r = numero(precos.vivino.preco) / numero(daLoja.preco);
        if (!(r >= 0.5 && r <= 2)) {
          console.log(`   Vivino: ${precos.vivino.preco} € posto de lado — longe de mais das lojas (${daLoja.preco} €)`);
          delete precos.vivino;
          precosMudaram = true;
        }
      }
      if (res.ficha && Object.keys(res.ficha).length)
        fichas.push({ origem: MOTOR === "serper" ? "vivino-serper" : "vivino-pagina", ficha: res.ficha,
                      fonte: { url: res.proposta?.vivino_url || v.vivino_url, titulo: "Vivino" } });
      const escolha = PRIORIDADE_PRECO.find(k => precos[k] && numero(precos[k].preco) != null);

      const pl = planoDoVinho(v, res, precos, precosMudaram, escolha, fichas);
      for (const a of pl.alteracoes)
        console.log(`   ${ENSAIO ? "(simulação)" : "→"} ${a.campo}: ${mostra(a.antes)} → ${mostra(a.depois)}`);
      if (ENSAIO) simulacao.push(pl);
      else {
        try { await aplicarPlano(pl); }
        catch (e) {
          // Um vinho que não se consegue gravar (fundido entretanto, a rede)
          // não pode parar os outros.
          console.log(`   ✗ não gravou: ${String(e.message || e).slice(0, 200)}`);
          resumo.erros_a_gravar = (resumo.erros_a_gravar || 0) + 1;
        }
      }
      bloqueios = res.estado === "bloqueado" ? bloqueios + 1 : 0;
      if (bloqueios >= MAX_BLOQUEIOS) { console.log("O Vivino está a recusar as páginas — paro aqui."); break; }
    }
  } finally {
    if (browser) await browser.close();
  }
  console.log("Resumo:", JSON.stringify(resumo));
  if (ENSAIO && simulacao.length) {
    const fich = await gravarSimulacao(simulacao);
    console.log(`\nSimulação guardada em: ${fich}`);
    console.log(`Para gravar: no painel (vinhos.bat), escolhe esta simulação, desmarca o que não quiseres e carrega em "Gravar selecionados".`);
  }
}

// ── Vinho novo (o painel do vinhos.bat) ──────────────────────────────
// O admin escreve nome, produtor, ano e cor. Se o catálogo já o tiver (a
// mesma `achar` da `criar`), trata-se como um enriquecimento dessa linha —
// nunca nasce uma segunda. Senão, vai sem id: só ganha um ao gravar.
async function vinhosNovos(lista) {
  const out = [];
  for (const x of (Array.isArray(lista) ? lista : [lista]).slice(0, 20)) {
    const novo = { nome: String(x.nome || "").trim(), produtor: String(x.produtor || "").trim(),
                   ano: parseInt(x.ano, 10) || null, tipo: x.tipo || null };
    if (!novo.nome) continue;
    const ja = await rpc("vivino_achar", { p_nome: novo.nome, p_produtor: novo.produtor, p_ano: novo.ano });
    if (ja) {
      console.log(`"${novo.nome}" já existe no catálogo (#${ja.id}) — enriqueço essa linha.`);
      out.push({ ...ja, tipo: ja.tipo || novo.tipo, novo });
    } else {
      out.push({ id: null, nome: novo.nome, produtor: novo.produtor, ano: novo.ano, tipo: novo.tipo,
                 vivino_url: null, precos: null, ficha: {}, novo });
    }
  }
  return out;
}

// ── O que se grava de um vinho — uma PLANTA, e não chamadas soltas ──────
// A mesma planta serve os dois caminhos: gravar já (Enriquecer) ou ir para
// o ficheiro da simulação, que o dono revê e manda gravar depois — sem
// voltar a abrir página nenhuma, e exatamente o que viu.
function planoDoVinho(v, res, precos, precosMudaram, escolha, fichas = []) {
  const origemVivino = MOTOR === "serper" ? "vivino-serper" : "vivino-pagina";
  const alteracoes = [], fontes = {};
  const junta = (campo, antes, depois, origem) => {
    if (depois == null || JSON.stringify(antes ?? null) === JSON.stringify(depois)) return;
    alteracoes.push({ campo, antes: antes ?? null, depois, origem, aplicar: true });
  };
  const vazio = x => x == null || x === "" || (Array.isArray(x) && !x.length) || (typeof x === "object" && !Array.isArray(x) && !Object.keys(x).length);
  const atual = v.ficha || {};
  // A cor que o admin escolheu no painel, num vinho que já existia sem ela.
  if (v.novo && v.id && v.novo.tipo && vazio(atual.tipo)) junta("tipo", null, v.novo.tipo, "catalogo-admin");
  let aplicado = false;
  if (res.proposta && res.proposta.vivino_url) {
    aplicado = true;
    junta("vivino_url", v.vivino_url, res.proposta.vivino_url, origemVivino);
    junta("vivino_nota", v.vivino_nota, res.proposta.vivino_nota, origemVivino);
    // Um salto de 5× (e de mais de mil) não é gente a avaliar de ontem para
    // hoje: é outro número da página (o Casa Santar ficou com 43974).
    const antes = Number(v.vivino_avaliacoes), depois = Number(res.proposta.vivino_avaliacoes);
    if (!(antes > 0 && depois > antes * 5 && depois - antes > 1000))
      junta("vivino_avaliacoes", v.vivino_avaliacoes, res.proposta.vivino_avaliacoes, origemVivino);
    fontes[origemVivino] = [{ url: res.proposta.vivino_url, titulo: "Vivino" }];
  }
  if (precosMudaram) junta("precos", v.precos, precos, "lojas-script");
  if (escolha) {
    const loja = LOJAS.find(l => l.id === escolha);
    const origem = loja ? loja.origem : origemVivino;
    junta("preco_medio", v.preco_medio, precos[escolha].preco, origem);
    fontes[origem] = (fontes[origem] || []).concat([{ url: precos[escolha].url, titulo: loja ? loja.nome : "Vivino" }]);
  }
  // A ficha (castas, região, teor…): só nos campos VAZIOS — o que já lá
  // está foi escrito por alguém (ou por uma pesquisa) e uma página de loja
  // não lhe passa por cima. Cada campo vem da primeira fonte que o tem.
  for (const campo of CAMPOS_PAGINA) {
    if (!vazio(atual[campo])) continue;
    // A fotografia prefere o Vivino (a garrafa recortada, igual em todos);
    // o resto vem pela ordem das lojas.
    const ordem = campo === "imagem_url" ? [...fichas].sort((a, b) => /^vivino/.test(b.origem) - /^vivino/.test(a.origem)) : fichas;
    const f = ordem.find(x => !vazio(x.ficha[campo]));
    if (!f) continue;
    junta(campo, null, f.ficha[campo], f.origem);
    if (f.fonte?.url && !(fontes[f.origem] || []).some(x => x.url === f.fonte.url))
      fontes[f.origem] = (fontes[f.origem] || []).concat([f.fonte]);
  }
  // Só o que PEDE uma decisão (apagar um link morto, um link que abre outro
  // vinho sem alternativa) fica à espera em Alertas.
  const revisao = aplicado ? "aceite"
    : (res.proposta && res.proposta.vivino_url === null) || res.estado === "errado" ? "pendente"
    : "sem_acao";
  return { aplicar: true, id: v.id, nome: v.nome, ano: v.ano ?? null, estado: res.estado,
           novo: v.novo || undefined, produtor: v.produtor || null,
           pagina: res.nome_pagina || null, alteracoes, fontes, revisao,
           registo: { ...res, url_antes: v.vivino_url || null } };
}

// Grava uma planta: os campos pela `aplicar_fontes` (a regra de força da
// `juntar`; cada campo que muda fica no histórico, com "Repor"), agrupados
// pela origem; depois a verificação.
async function aplicarPlano(pl, quem = QUEM) {
  // Um vinho NOVO nasce aqui, e só aqui: depois de o admin rever a
  // simulação. Se entretanto alguém o criou, usa-se o que já existe.
  if (!pl.id && pl.novo) {
    const r = await rpc("vivino_novo", { p_nome: pl.novo.nome, p_produtor: pl.novo.produtor || "",
      p_ano: pl.novo.ano ?? null, p_tipo: pl.novo.tipo || null, p_quem: quem });
    pl.id = Number(r.id);
    console.log(`   ${r.existia ? "já existia — é o" : "criado:"} #${pl.id}`);
  }
  if (!pl.id) throw new Error("vinho sem id");
  // Um link novo desmarcado na revisão leva atrás o que se leu NA PÁGINA
  // dele (a nota, as avaliações, o preço do Vivino): eram de outro vinho.
  const recusouLink = (pl.alteracoes || []).some(a => a.campo === "vivino_url" && a.aplicar === false);
  const doVivino = a => /^vivino-/.test(a.origem);
  const porOrigem = {};
  for (const a of pl.alteracoes || []) {
    if (a.aplicar === false) continue;
    if (recusouLink && doVivino(a)) continue;
    let depois = a.depois;
    if (recusouLink && a.campo === "precos" && depois && depois.vivino) {
      depois = { ...depois }; delete depois.vivino;
      if (!Object.keys(depois).length) continue;
    }
    (porOrigem[a.origem] = porOrigem[a.origem] || {})[a.campo] = depois;
  }
  for (const [origem, campos] of Object.entries(porOrigem)) {
    const r = await rpc("aplicar_fontes", { p_vinho_id: pl.id, p_campos: campos, p_origem: origem,
      p_quem: quem, p_fontes: (pl.fontes || {})[origem] || [] });
    if (r.ficou.length)
      console.log(`   ! não entrou (o que lá está é mais forte): ${r.ficou.map(f => `${f.campo} [${f.origem}]`).join(", ")}`);
  }
  // E a verificação fica registada sem ação, e não como "aceite".
  await rpc("vivino_gravar", { p_vinho_id: pl.id, p_res: pl.registo, p_execucao: EXECUCAO,
    p_revisao: recusouLink && pl.revisao === "aceite" ? "sem_acao" : pl.revisao });
  return Object.values(porOrigem).reduce((n, c) => n + Object.keys(c).length, 0);
}

function mostra(x) {
  if (x == null) return "vazio";
  if (Array.isArray(x)) return x.join(", ");
  if (typeof x === "object") return Object.entries(x).map(([k, o]) => `${k} ${o?.preco ?? "?"}€`).join(", ");
  if (typeof x === "string" && x.length > 90) return x.slice(0, 87) + "…";
  return String(x);
}

async function gravarSimulacao(vinhos) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const d = new Date(), z = n => String(n).padStart(2, "0");
  const nome = `simulacao-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.json`;
  await mkdir("simulacoes", { recursive: true });
  const corpo = {
    _leia_me: "Cada vinho tem \"aplicar\": true. Põe false no vinho que não queres gravar, ou numa alteração só. " +
      "Revê-se e grava-se no painel (vinhos.bat › Simulações). Nada disto foi gravado ainda.",
    criado: d.toISOString(), motor: MOTOR, vinhos,
  };
  await writeFile(`simulacoes/${nome}`, JSON.stringify(corpo, null, 2), "utf8");
  return `simulacoes/${nome}`;
}

// ── Gravar uma simulação já revista (o painel do vinhos.bat) ──────────
async function aplicarSimulacao(fich) {
  const { readFile } = await import("node:fs/promises");
  const sim = JSON.parse(await readFile(fich, "utf8"));
  const vinhos = (sim.vinhos || []).filter(p => p && p.aplicar !== false);
  console.log(`A gravar ${vinhos.length} vinho(s) da simulação ${fich} (${(sim.vinhos || []).length - vinhos.length} desligado(s))`);
  let ok = 0, falhou = 0;
  for (const pl of vinhos) {
    try {
      const n = await aplicarPlano(pl, "script no PC (simulação revista)");
      console.log(`#${pl.id} ${pl.nome} → ${n ? n + " campo(s)" : "só a verificação"}`);
      ok++;
    } catch (e) {
      console.log(`${pl.id ? "#" + pl.id : "NOVO"} ${pl.nome} → ✗ ${String(e.message || e).slice(0, 200)}`);
      falhou++;
    }
  }
  console.log(`Gravados: ${ok} · falharam: ${falhou}`);
}

export { desambiguarPorCasta, aMaisSemAsNossasCastas, ambiguoPorCasta, palavras, lerPagina as lerPaginaExport, regiaoDe, imagemDe, castasDe, castasBatem, bateNome, fichaDosPares, planoDoVinho, comAno, lerLoja, precoDaPagina, colheitaDe, tituloLimpo, aMais, mencao, parecenca, corBate, urlLimpo, idDoVinho, numerosDe, nomeDe, bloqueio, verificar,
         verificarSerper, numerosDoResultado };

// Corre só quando é chamado diretamente (o teste importa as funções).
// `pathToFileURL` e não "file://" à mão: no Windows o caminho é C:\…
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}
