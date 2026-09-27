// supabase/functions/catalogo-info/index.ts
// WineCatalog — pesquisa Google a sério para UMA linha do catálogo.
//
// PORQUE É QUE ISTO EXISTE. Até aqui o catálogo só sabia o que as outras
// duas apps lhe escreviam de passagem: a Garrafeira quando alguém procura
// um vinho que TEM em casa, a WineSelection quando alguém lê uma carta.
// Uma linha com metade dos campos vazios ficava assim para sempre, porque
// não havia sítio nenhum onde se pudesse dizer "vai procurar isto". O ecrã
// do catálogo mostrava o buraco e não deixava tapá-lo.
//
// SEM FALLBACK "SEM PESQUISA", como na `verificar-vinhos` da WineSelection
// e pela mesma razão: uma resposta de memória do modelo tem força 0 e não
// entra no catálogo (ver `winecatalog.forca`). Gastar uma ida ao Gemini
// para produzir uma coisa que a base recusa à entrada seria só arranjar
// maneira de parecer que se fez alguma coisa. Falha limpa em vez disso.
//
// SÓ O ADMIN DO CATÁLOGO. Não é avareza: esta é a única função do projeto
// que escreve no catálogo por iniciativa de uma PESSOA (as outras escrevem
// de passagem, a reboque de um trabalho que a pessoa já pediu para si).
// Quem lê o catálogo é toda a gente aprovada; quem o manda mexer, e gastar,
// é quem é dono dele. Desde 26/09/2026 a app pede `rever:true`: isto só
// PROPÕE, e é o admin que escolhe o que entra (`winecatalog.pesquisa_aplicar`).
//
// Arquitetura assíncrona igual à `sugerir-vinho`/`verificar-vinhos`
// (EdgeRuntime.waitUntil + polling do browser) — a linha de trabalho é
// `winecatalog.pesquisas`, criada ANTES por `winecatalog.pesquisa_criar`
// (é lá que vive a autorização, e é lá que se testa).
//
// A descoberta de modelo, o `extrairJson` e os normalizadores estão
// duplicados das funções irmãs DE PROPÓSITO — cada Edge Function deste
// projeto é auto-contida, mesma convenção da calendario-sporting.
//
// Deploy: supabase functions deploy catalogo-info

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GAPI = "https://generativelanguage.googleapis.com/v1beta";
const PROC_TIMEOUT_MS = 90_000;
const SYNC_TIMEOUT_MS = 20_000; // duas tentativas de 4 s na autorização cabem com folga

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ── Escolha do modelo (mesma estratégia das funções irmãs) ── */
let _models: string[] | null = null;
function rankFlash(names: string[]): string[] {
  const ok = [...new Set(names.filter((n) =>
    n.includes("flash") &&
    !/(lite|8b|image|tts|live|audio|embed|exp|preview|thinking)/.test(n)
  ))];
  const score = (n: string): number => {
    if (n === "gemini-flash-latest") return 100;
    const m = n.match(/^gemini-(\d+(?:\.\d+)?)-flash$/);
    return m ? parseFloat(m[1]) : 0;
  };
  return ok.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}
async function descobrirFlash(signal: AbortSignal): Promise<string[]> {
  if (_models) return _models;
  try {
    const names: string[] = [];
    let page = "";
    for (let i = 0; i < 3; i++) {
      const r = await fetch(
        `${GAPI}/models?pageSize=200${page ? `&pageToken=${page}` : ""}&key=${GEMINI_KEY}`,
        { signal },
      );
      if (!r.ok) break;
      const d = await r.json();
      (d.models ?? []).forEach((m: any) => {
        if ((m.supportedGenerationMethods ?? []).includes("generateContent")) {
          names.push(String(m.name).replace(/^models\//, ""));
        }
      });
      page = d.nextPageToken ?? "";
      if (!page) break;
    }
    const ranked = rankFlash(names);
    if (ranked.length) _models = ranked;
  } catch (_) { /* fica o fallback (inclui abort do timeout) */ }
  return _models ?? [];
}
/* SÓ PONTEIROS ("-latest"), nunca nomes de versão fixos. "gemini-2.5-flash"
   e "gemini-2.0-flash" são exatamente os nomes que a Google reformou:
   respondem 404 "no longer available to new users". Já custaram um deploy
   de emergência à Garrafeira e semanas de avaria calada à WineSelection —
   um nome fixo aqui é uma bomba-relógio que só rebenta no dia em que o
   ponteiro der 429. */
/* O LITE VEM PRIMEIRO, e não é para poupar: é porque o outro NÃO RESPONDE.
   Nas quatro pesquisas que este catálogo fez, o `gemini-flash-latest` devolveu
   200 com o corpo vazio em TODAS — gastou o orçamento a pensar (~5000 tokens
   de pensamento por tentativa) e não escreveu uma letra. O lite, a seguir,
   respondeu sempre à primeira. Enquanto for assim, pô-lo à frente é deitar
   fora uma ida ao Gemini e ~4s em cada pesquisa. Se um dia o flash voltar a
   escrever, isto volta atrás — e o `finishReason` no log é o que o dirá. */
const ESTAVEIS = ["gemini-flash-lite-latest", "gemini-flash-latest"];
async function candidatosModelo(signal: AbortSignal): Promise<string[]> {
  const pinned = Deno.env.get("GEMINI_MODEL");
  const descobertos = await descobrirFlash(signal);
  const vistos = new Set<string>();
  const lista = [...(pinned ? [pinned] : []), ...ESTAVEIS, ...descobertos]
    .filter((m) => (vistos.has(m) ? false : vistos.add(m)));
  return lista.length ? lista : ["gemini-flash-latest"];
}

/* ── Normalizadores ── */
const TIPOS = ["Tinto", "Branco", "Rosé", "Espumante", "Licoroso", "Frisante"];
const ESTILOS = ["", "Maduro", "Verde", "Colheita Tardia", "Palhete"];
const MENCOES = ["", "Reserva", "Grande Reserva", "Garrafeira", "Colheita Selecionada",
  "Vinhas Velhas", "Superior", "Grande Escolha"];
const CLASSIF = ["", "DOC", "Vinho Regional", "Vinho"];

/* Os campos que se podem pedir, com o nome que têm no JSON da resposta.
   Pedir os 20 de uma vez põe o modelo a andar atrás de tudo e a voltar com
   meia dúzia de coisas mornas; pedir três dá três boas — é a mesma lição
   que a `vinho-info` da Garrafeira já tinha pago, e é por isso que o ecrã
   desta app também tem um selector de campos. */
const CAMPOS: Record<string, string> = {
  tipo: "tipo", estilo: "estilo", regiao: "regiao", sub_regiao: "subRegiao",
  pais: "pais", mencao: "mencao", classificacao: "classificacao",
  castas: "castas", teor: "teor", estagio_meses: "estagioMeses",
  estagio_texto: "estagioTexto", vivino_nota: "vivinoNota",
  vivino_avaliacoes: "vivinoAvaliacoes", vivino_url: "vivinoUrl",
  // A nota de TODAS as colheitas (26/09/2026, ver `regraVivino`): até
  // 27/09/2026 a pesquisa não a conhecia, e a média que o Vivino mostra sem
  // ano ia parar à `vivino_nota`, que é a da COLHEITA.
  vivino_nota_global: "vivinoNotaGlobal", vivino_avaliacoes_global: "vivinoAvaliacoesGlobal",
  imagem_url: "imagemUrl", preco_medio: "precoMedio",
  beber_de: "beberDe", beber_ate: "beberAte", notas_prova: "notasProva",
  harmonizacao: "harmonizacao", ai_resumo: "resumo",
  // O PRODUTOR não é campo da FICHA — é IDENTIDADE (faz parte da `chave`,
  // ver catalogo.sql) — mas continua a ser sempre uma opção a pedir, MESMO
  // já preenchido: só pode vir diferente por engano de quem escreveu, e é
  // isso que vale a pena confirmar. Por não ser ficha, nunca passa pela
  // `juntar` — ver `processarPesquisa`, mais abaixo, para o porquê.
  produtor: "produtorConfirmado",
};

const texto = (v: unknown, max: number) =>
  String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
function numero(v: unknown, min: number, max: number, casas = 2): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  if (!isFinite(n) || n < min || n > max) return null;
  return Number(n.toFixed(casas));
}
function anoValido(v: unknown): number | null {
  const n = numero(v, 1900, 2100, 0);
  return n === null ? null : Math.round(n);
}
function daLista(v: unknown, lista: string[]): string {
  const t = texto(v, 40);
  const achado = lista.find((x) => x && x.toLowerCase() === t.toLowerCase());
  return achado ?? "";
}
/* Aspas tipográficas (“ ” ‘ ’) não são JSON válido, e um chat-UI troca-as
   por conta própria ao mostrar texto normal (não costuma acontecer dentro
   de blocos de código) — apanhado com uma resposta manual colada com
   TODAS as aspas assim, que o JSON.parse recusava logo na primeira
   chave. Trocar aqui por retas resolve o caso automático e o manual de
   uma vez, sem arriscar strings verdadeiras: uma aspa tipográfica dentro
   de uma frase vira reta na mesma, mas fica dentro da MESMA string — só
   muda um caracter, nunca a estrutura. */
function normalizarAspas(s: string): string {
  return s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}
function extrairJson(txt: string): any | null {
  const s = normalizarAspas(String(txt || "").trim());
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { /* segue */ }
  const semFences = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(semFences); } catch (_) { /* segue */ }
  const ini = semFences.indexOf("{");
  if (ini < 0) return null;
  let nivel = 0, emString = false, escape = false;
  for (let i = ini; i < semFences.length; i++) {
    const c = semFences[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { emString = !emString; continue; }
    if (emString) continue;
    if (c === "{") nivel++;
    else if (c === "}") {
      nivel--;
      if (nivel === 0) {
        try { return JSON.parse(semFences.slice(ini, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

/* Tudo o que o modelo devolve passa por aqui antes de chegar perto da
   base. Os tipos e os enums validam-se no servidor — nunca se confia
   cegamente no JSON do Gemini, e menos ainda quando o destino é uma tabela
   que outras duas apps leem. */
/* Sem colheita não se pede a janela de consumo (ver `winecatalog.da_colheita`):
   seria a de uma colheita qualquer. Se só se tinha pedido a janela, fica a
   lista como estava — a regra 8 do prompt diz ao modelo que não há. */
function camposSemJanela(campos: string[] | null, ano: number | null): string[] | null {
  if (ano !== null || !campos) return campos;
  const f = campos.filter((k) => k !== "beber_de" && k !== "beber_ate");
  return f.length ? f : campos;
}

/* ── O link do Vivino: só o formato que o Vivino usa ──
   A página de um vinho no Vivino é SEMPRE `/<nome>/w/<nº>` — o número é o
   do vinho e não muda. Um modelo que responda de memória (sem pesquisar —
   é o normal, ver o CLAUDE.md, "De memória ou pesquisado") escreve links
   com ar de verdadeiros que nunca existiram: `/Wines/<nome>`,
   `/Wineries/<x>/Wines/<y>`, `/pt-pt/<nome>` sem número. Até 25/09/2026 só
   se exigia o domínio, e esses entravam no catálogo e partiam ao abrir.
   `/wines/<nº>` também sai: é o número de UMA colheita, não o do vinho.
   Devolve-se o link limpo (sem país, língua, ?year=, ?srsltid) — a MESMA
   regra do `urlLimpo` do `batch/vivino-verificar.mjs`. */
function vivinoLink(u: unknown): string {
  try {
    const url = new URL(String(u ?? "").trim());
    if (!/(^|\.)vivino\.com$/i.test(url.hostname)) return "";
    const m = url.pathname.match(/\/([a-z0-9-]+)\/w\/(\d+)/i);
    return m ? `https://www.vivino.com/${m[1].toLowerCase()}/w/${m[2]}` : "";
  } catch { return ""; }
}

/* Pedir a nota da colheita é pedir também a de todas: vêm da mesma página,
   e é quase sempre a única que o modelo vê. Sem colheita, a da colheita não
   existe — pede-se só a de todas (a mesma regra do script,
   `batch/vivino-verificar.mjs`, "A nota do Vivino são duas"). */
const PAR_VIVINO: Record<string, string> = {
  vivino_nota: "vivino_nota_global", vivino_avaliacoes: "vivino_avaliacoes_global",
};
function camposComGlobal(campos: string[] | null, ano: number | null): string[] | null {
  if (!campos) return campos;
  const out = new Set<string>();
  for (const k of campos) {
    if (k in PAR_VIVINO) {
      out.add(PAR_VIVINO[k]);
      if (ano !== null) out.add(k);
    } else out.add(k);
  }
  return [...out];
}

function normalizar(raw: any, campos: string[] | null, ano: number | null = null): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || raw.encontrado === false) return {};

  const castas = Array.isArray(raw.castas)
    ? [...new Set(
        raw.castas
          .map((c: unknown) => texto(c, 50))
          // "blend"/"lote"/"várias castas" não são castas — são a CONTAGEM
          // delas. Deixá-las entrar criava uma casta fantasma no catálogo,
          // e daí passava às duas apps que o leem.
          .filter((c: string) => c && !/^(blend|lote|v[áa]rias|diversas|field blend|castas?)$/i.test(c))
          .map((c: string) => c.replace(/\s*\(\d+%?\)\s*$/, "").trim()),
      )].slice(0, 12)
    : [];

  const beberDe = anoValido(raw.beberDe);
  let beberAte = anoValido(raw.beberAte);
  // Uma janela ao contrário não é informação, é ruído: fica sem fim.
  if (beberDe !== null && beberAte !== null && beberAte < beberDe) beberAte = null;

  const out: Record<string, unknown> = {
    tipo: daLista(raw.tipo, TIPOS),
    estilo: daLista(raw.estilo, ESTILOS),
    regiao: texto(raw.regiao, 60),
    sub_regiao: texto(raw.subRegiao, 60),
    pais: texto(raw.pais, 40),
    mencao: daLista(raw.mencao, MENCOES),
    classificacao: daLista(raw.classificacao, CLASSIF),
    castas,
    teor: numero(raw.teor, 4, 25, 1),
    estagio_meses: (() => { const n = numero(raw.estagioMeses, 0, 400, 0); return n === null ? null : Math.round(n); })(),
    estagio_texto: texto(raw.estagioTexto, 160),
    vivino_nota: numero(raw.vivinoNota, 1, 5, 2),
    vivino_avaliacoes: (() => { const n = numero(raw.vivinoAvaliacoes, 0, 10_000_000, 0); return n === null ? null : Math.round(n); })(),
    vivino_nota_global: numero(raw.vivinoNotaGlobal, 1, 5, 2),
    vivino_avaliacoes_global: (() => { const n = numero(raw.vivinoAvaliacoesGlobal, 0, 10_000_000, 0); return n === null ? null : Math.round(n); })(),
    // Só `/<nome>/w/<nº>` (ver `vivinoLink`). Não chega para apanhar um
    // homónimo — isso é a regra 2 do prompt — mas apanha os inventados.
    vivino_url: vivinoLink(raw.vivinoUrl),
    // Aqui é mais apertado ainda: exige-se a extensão da imagem. O modelo
    // tende a devolver o link da PÁGINA em vez do da fotografia, e isso dá
    // um <img> partido na ficha — pior do que não ter foto nenhuma.
    imagem_url: /^https?:\/\/\S+\.(jpe?g|png|webp|avif)(\?\S*)?$/i.test(String(raw.imagemUrl ?? "").trim())
      ? texto(raw.imagemUrl, 400) : "",
    preco_medio: numero(raw.precoMedio, 0.5, 100_000, 2),
    beber_de: beberDe,
    beber_ate: beberAte,
    notas_prova: texto(raw.notasProva, 600),
    harmonizacao: texto(raw.harmonizacao, 300),
    ai_resumo: texto(raw.resumo, 900),
  };

  // O que vem vazio sai: um `null` explícito é indistinguível de "o modelo
  // diz que é nulo", e a `juntar` recusa-o de qualquer maneira.
  Object.keys(out).forEach((k) => {
    const v = out[k];
    if (v === null || v === "" || (Array.isArray(v) && !v.length)) delete out[k];
  });
  vivinoDuas(out, ano);
  // Pediram-se só alguns campos: o resto sai daqui mesmo que o modelo o
  // tenha mandado à mesma. Sem isto, pedir "só o preço" acabava a
  // reescrever a região com um palpite de passagem.
  if (campos && campos.length) {
    Object.keys(out).forEach((k) => { if (!campos.includes(k)) delete out[k]; });
  }
  return out;
}

/* AS DUAS NOTAS DO VIVINO, arrumadas depois de lidas (27/09/2026):
   · sem colheita, a nota "da colheita" é a de todas — passa para lá (se lá
     não houver outra) e sai;
   · a mesma nota com as mesmas avaliações nas duas é o modelo a copiar a
     média de todas as colheitas para a da colheita — fica só a de todas;
   · uma colheita com MAIS avaliações do que o vinho todo não existe: a de
     todas fica de fora (a regra do `lerGlobal` do script). */
function vivinoDuas(out: Record<string, unknown>, ano: number | null): void {
  const tem = (k: string) => out[k] !== undefined;
  if (ano === null) {
    if (tem("vivino_nota") && !tem("vivino_nota_global")) {
      out.vivino_nota_global = out.vivino_nota;
      if (tem("vivino_avaliacoes") && !tem("vivino_avaliacoes_global")) out.vivino_avaliacoes_global = out.vivino_avaliacoes;
    }
    delete out.vivino_nota; delete out.vivino_avaliacoes;
    return;
  }
  if (tem("vivino_nota") && tem("vivino_nota_global") &&
      out.vivino_nota === out.vivino_nota_global &&
      (out.vivino_avaliacoes ?? null) === (out.vivino_avaliacoes_global ?? null)) {
    delete out.vivino_nota; delete out.vivino_avaliacoes;
    return;
  }
  if (tem("vivino_avaliacoes") && tem("vivino_avaliacoes_global") &&
      Number(out.vivino_avaliacoes) > Number(out.vivino_avaliacoes_global)) {
    delete out.vivino_nota_global; delete out.vivino_avaliacoes_global;
  }
}

type UsageMetadata = { promptTokenCount: number; candidatesTokenCount: number; thoughtsTokenCount: number; totalTokenCount: number };
// As duas fases do pacote completo somam-se no registo.
function somarUso(a: UsageMetadata | null, b: UsageMetadata | null): UsageMetadata | null {
  if (!a) return b;
  if (!b) return a;
  const out: any = { ...a };
  for (const [k, v] of Object.entries(b)) if (typeof v === "number") out[k] = (Number(out[k]) || 0) + v;
  return out;
}
function usageMetadata(raw: any): UsageMetadata | null {
  const toInt = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  };
  const src = raw?.usageMetadata;
  if (!src || typeof src !== "object") return null;
  const out = {
    promptTokenCount: toInt(src.promptTokenCount),
    candidatesTokenCount: toInt(src.candidatesTokenCount),
    thoughtsTokenCount: toInt(src.thoughtsTokenCount),
    totalTokenCount: toInt(src.totalTokenCount),
  };
  return (out.promptTokenCount || out.candidatesTokenCount || out.totalTokenCount) ? out : null;
}
function fontesGrounding(body: any): { titulo: string; url: string }[] {
  const chunks = body?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const out: { titulo: string; url: string }[] = [];
  const vistos = new Set<string>();
  for (const c of chunks) {
    const url = String(c?.web?.uri ?? "").trim();
    if (!/^https?:\/\//i.test(url) || vistos.has(url)) continue;
    vistos.add(url);
    out.push({ titulo: texto(c?.web?.title ?? url, 120), url: url.slice(0, 400) });
    if (out.length >= 8) break;
  }
  return out;
}

/* O que o Gemini diz sobre a PESQUISA que fez (ou não fez). As fontes vêm a
   zero em todas as pesquisas do projeto (24/09/2026) e só uma resposta real
   diz porquê: sem `groundingMetadata` (não pesquisou), com
   `webSearchQueries` mas sem `groundingChunks` (pesquisou, e as fontes vêm
   noutro sítio ou não vêm), ou com chunks (estávamos a ler mal).
   `toolUsePromptTokenCount` é o que a pesquisa meteu na entrada do modelo.
   A MESMA função está na `verificar-vinhos` da WineSelection. */
function resumoGrounding(gd: any): Record<string, unknown> {
  const gm = gd?.candidates?.[0]?.groundingMetadata;
  return {
    metadata: !!gm,
    chaves: gm && typeof gm === "object" ? Object.keys(gm).slice(0, 12) : [],
    pesquisas: Array.isArray(gm?.webSearchQueries) ? gm.webSearchQueries.slice(0, 8).map((q: unknown) => String(q).slice(0, 120)) : [],
    chunks: Array.isArray(gm?.groundingChunks) ? gm.groundingChunks.length : 0,
    supports: Array.isArray(gm?.groundingSupports) ? gm.groundingSupports.length : 0,
    toolTokens: gd?.usageMetadata?.toolUsePromptTokenCount ?? null,
  };
}

/* HOUVE PESQUISA OU NÃO. Ligar o `google_search` não obriga o modelo a
   pesquisar — ele decide, e nos registos até 24/09/2026 nunca o fez: as
   respostas vinham do que aprendeu no treino. Não se recusa (ver acima),
   mas o resultado passa a dizê-lo (`pesquisaWeb`) e o ecrã oferece ao
   admin a "pesquisa profunda" (ver `serperConsulta`). Ver o CLAUDE.md,
   "De memória ou pesquisado". Mesmo critério na `verificar-vinhos`, na
   `vinho-info` e na `prendas-vinho`. */
function fezPesquisa(gd: any): boolean {
  const gm = gd?.candidates?.[0]?.groundingMetadata;
  return (Array.isArray(gm?.webSearchQueries) && gm.webSearchQueries.length > 0) ||
    (Array.isArray(gm?.groundingChunks) && gm.groundingChunks.length > 0) ||
    Number(gd?.usageMetadata?.toolUsePromptTokenCount ?? 0) > 0;
}

/* A PESQUISA PROFUNDA É SERPER, NÃO GROUNDING (decidido a 25/09/2026).
   Não há parâmetro nenhum na API do Gemini que o OBRIGUE a pesquisar: o
   `google_search` só lhe dá a opção, e mudar o prompt só mexe nas
   probabilidades (a 24/09/2026, com o prompt a pedir "primeiro pesquisa",
   a Garrafeira voltou a responder de memória). A única forma de a pesquisa
   ser garantida é sermos NÓS a fazê-la: o Serper devolve os resultados do
   Google (título, link, resumo), e o Gemini só os lê — sem `google_search`
   e com "responde APENAS com base nisto". Se o Serper não trouxer nada, a
   pesquisa falha limpa e o Gemini nem é chamado: pagar para ele adivinhar
   era exatamente o que isto veio evitar.
   A chave (`SEARCH_API_KEY`) é a mesma que o "modo grátis" da `vinho-info`
   da Garrafeira já usava — os segredos do Supabase são do projeto, não de
   cada função. Custa ~1 $ por 1000 consultas (depois das 2500 grátis) e
   cada profunda faz DUAS: uma geral (lojas, produtor) e uma ao Vivino. */
const SEARCH_API_KEY = Deno.env.get("SEARCH_API_KEY") ?? "";
const SEARCH_API_URL = Deno.env.get("SEARCH_API_URL") || "https://google.serper.dev/search";
const CUSTO_SERPER_EUR = 0.001; // por consulta, grosseiro como os outros
/* OS SITES DE CONFIANÇA (27/09/2026). Até aqui entravam como
   ` (site:a OR site:b)` colados à consulta GERAL — o que não dava
   prioridade nenhuma: RESTRINGIA a consulta a eles (se não tivessem o
   vinho, a consulta geral voltava vazia), e um nome escrito sem domínio
   ("Garrafeira Nacional") partia a consulta toda (`site:Garrafeira
   Nacional`). E nada dizia, no fim, se algum resultado tinha vindo deles.
   Agora: a consulta geral é sempre livre; os domínios a sério (sem o
   Vivino, que tem a consulta própria) têm uma consulta SÓ deles, a mais;
   os resultados deles vão à frente, marcados, na base de evidência; e o
   resultado da pesquisa diz quantos vieram de cada um (`confianca`). Um
   nome sem domínio fica só no texto do prompt. */
function dominioDe(s: string): string {
  const d = s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : "";
}
const doSite = (url: string, dominio: string): boolean => {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === dominio || h.endsWith("." + dominio);
  } catch { return false; }
};
/* De que colheita são os números de um resultado do Vivino: sem `year=`
   no endereço são os de TODAS as colheitas; com o nosso ano, os da
   colheita; com outro ano, não servem. A regra do motor Serper do script. */
function vivinoDeQue(url: string, ano: number | null): string {
  try {
    const u = new URL(url);
    if (!/(^|\.)vivino\.com$/i.test(u.hostname)) return "";
    const y = Number(u.searchParams.get("year"));
    if (!y) return "página do Vivino SEM ano escolhido: a nota e as avaliações são as de TODAS as colheitas (vivinoNotaGlobal/vivinoAvaliacoesGlobal)";
    if (ano !== null && y === ano) return `página do Vivino da colheita ${y}: a nota e as avaliações são as DESTA colheita (vivinoNota/vivinoAvaliacoes)`;
    return `página do Vivino da colheita ${y}, que NÃO é a nossa: não uses a nota nem as avaliações daqui`;
  } catch { return ""; }
}
/* Uma consulta ao Serper: os resultados orgânicos, já limpos. */
type Resultado = { url: string; titulo: string; snippet: string; rating: unknown; ratingCount: unknown };
async function serperConsulta(q: string, signal: AbortSignal): Promise<Resultado[]> {
  if (!SEARCH_API_KEY) throw new Error("a pesquisa externa não está configurada (falta SEARCH_API_KEY)");
  const r = await fetch(SEARCH_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": SEARCH_API_KEY },
    body: JSON.stringify({ q, gl: "pt", hl: "pt", num: 8 }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  });
  if (!r.ok) throw new Error(`a pesquisa externa respondeu ${r.status}`);
  const d = await r.json();
  return (Array.isArray(d?.organic) ? d.organic : [])
    .map((x: any) => ({
      url: String(x?.link || "").trim(), titulo: String(x?.title || "").trim(),
      snippet: String(x?.snippet || "").replace(/\s+/g, " ").trim(),
      rating: x?.rating, ratingCount: x?.ratingCount,
    }))
    .filter((x: Resultado) => /^https?:\/\//i.test(x.url));
}

/* ── AS PÁGINAS DOS SITES (27/09/2026, o dono das apps) ──
   "Encontrei o vinho num site, dou o link e preenchem-se os atributos a
   partir daí." Até aqui um link de uma loja colado nos sites de confiança
   era reduzido ao domínio, e de um site só se lia o resumo que o Google
   mostra em cada resultado (duas linhas — quase nunca as castas, o teor ou
   o estágio). Agora a página ABRE-SE: a que se colou, tal e qual, e — de
   cada domínio escrito sem página — a primeira que a procura só nesse
   site devolver. Do HTML tira-se o que a loja declara do produto para os
   motores de busca (o JSON-LD: nome, marca, preço, imagem, descrição), as
   etiquetas `og:`, e o texto da zona principal sem menus nem rodapé. Lê-o
   o Gemini, com a regra de sempre (o que lá não estiver fica fora do JSON)
   e mais uma: dizer, campo a campo, de que página ou resultado o tirou
   (`deOnde`) — é o que a revisão mostra ao lado de cada valor.
   `soSites` ("Usar só a informação destes sites"): sem a consulta geral,
   sem a do Vivino (a não ser que o Vivino seja um dos sites) e sem o
   grounding. O que as páginas não disserem fica vazio, e um campo que a IA
   não diga de onde veio sai.
   O que NÃO se faz: abrir o Vivino daqui. A proteção dele recusa
   servidores (403 na 1.ª corrida no GitHub Actions) e isso não se contorna
   — ver o CLAUDE.md, "Links do Vivino"; do Vivino fica o que o Google
   mostra. Uma loja que recuse (403, desafio anti-bots) também não se
   contorna: fica o resumo do Google, se houver, e o ecrã diz que recusou.
   Um endereço escrito por alguém é aberto por um servidor: só http(s),
   só nomes públicos (nada de IPs, portas nem "localhost"), redireções
   conferidas uma a uma, 1,5 MB no máximo. A MESMA leitura está na
   `vinho-info` da Garrafeira — mexer numa é mexer na outra. */
const PAGINA_TIMEOUT_MS = 10_000;
const PAGINA_MAX_BYTES = 1_500_000;
const PAGINA_MAX_TEXTO = 6_000;
const EVIDENCIA_PAGINAS_MAX = 20_000;
const UA_PAGINA = "Mozilla/5.0 (compatible; WineCatalog/1.0)";
const RECUSA = /just a moment|attention required|access denied|captcha|verify you are human|unusual traffic|verifica[çc][ãa]o de seguran[çc]a/i;

function hostPublico(u: URL): boolean {
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.port || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(h) && !/(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(h);
}
const siteDe = (url: string): string => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
};
/* O endereço de uma PÁGINA (com caminho) — só o domínio não é uma página. */
function paginaDe(s: string): string {
  let t = String(s ?? "").trim();
  if (!/^https?:\/\//i.test(t)) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S/i.test(t)) return "";
    t = "https://" + t;
  }
  try {
    const u = new URL(t);
    if (!hostPublico(u) || u.pathname.replace(/\/+$/, "") === "") return "";
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|srsltid$|gclid$|fbclid$)/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch { return ""; }
}
/* O resultado de uma procura num site que tem ar de ser a página de UM
   produto (não a procura, uma categoria ou a página inicial). */
function paginaDoResultado(rows: Resultado[], dominio: string): Resultado | null {
  return rows.find((x) => {
    if (!doSite(x.url, dominio)) return false;
    try {
      const u = new URL(x.url);
      return u.pathname.replace(/\/+$/, "") !== "" &&
        !/catalogsearch|\/search\b|\/pesquisa\b|\/categor|\/tag\/|\/marcas?\/?$|\/brands?\/?$/i.test(u.pathname) &&
        !u.searchParams.has("s") && !u.searchParams.has("q");
    } catch { return false; }
  }) ?? null;
}

const ENT: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", euro: "€", ordm: "º", ordf: "ª",
  deg: "°", middot: "·", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", reg: "®", copy: "©", trade: "™", times: "×",
};
const ACENTO: Record<string, string> = { acute: "\u0301", grave: "\u0300", circ: "\u0302", tilde: "\u0303", uml: "\u0308", cedil: "\u0327" };
function entidades(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    if (e in ENT) return ENT[e];
    const a = e.match(/^([a-z])(acute|grave|circ|tilde|uml|cedil)$/i);
    return a ? (a[1] + ACENTO[a[2].toLowerCase()]).normalize("NFC") : m;
  });
}
const semTags = (s: string) => entidades(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
function metaDe(html: string, nome: string): string {
  const tag = html.match(new RegExp(`<meta[^>]+(?:property|name|itemprop)\\s*=\\s*["']${nome}["'][^>]*>`, "i"))?.[0];
  if (!tag) return "";
  const m = tag.match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  return m ? texto(entidades(m[1] ?? m[2] ?? ""), 400) : "";
}
/* O que a loja declara do produto (JSON-LD `Product`, dentro ou fora de um
   `@graph`). A classificação que lá vier é a dos CLIENTES DA LOJA, nunca a
   do Vivino — e diz-se isso ao modelo. */
function produtoDaPagina(html: string): string {
  const ld: any[] = [];
  const junta = (x: any) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(junta); return; }
    ld.push(x);
    if (Array.isArray(x["@graph"])) x["@graph"].forEach(junta);
  };
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { junta(JSON.parse(m[1].trim())); } catch { /* um JSON-LD partido não deita a página abaixo */ }
  }
  const p = ld.find((x) => /Product|Wine/i.test(String(x?.["@type"] ?? "")));
  if (!p) return "";
  const um = (v: any) => (Array.isArray(v) ? v[0] : v);
  const t = (v: unknown, n: number) => texto(semTags(String(v ?? "")), n);
  const linhas: string[] = [];
  if (p.name) linhas.push(`nome: ${t(p.name, 200)}`);
  const marca = um(p.brand ?? p.manufacturer);
  const marcaN = typeof marca === "string" ? marca : marca?.name;
  if (marcaN) linhas.push(`marca/produtor: ${t(marcaN, 120)}`);
  const of = um(p.offers);
  if (of && typeof of === "object") {
    const ps = um(of.priceSpecification);
    const preco = of.price ?? of.lowPrice ?? ps?.price;
    if (preco != null && preco !== "") linhas.push(`preço: ${t(preco, 20)} ${t(of.priceCurrency ?? ps?.priceCurrency ?? "", 5)}`.trim());
  }
  const img = um(p.image);
  const imgU = typeof img === "string" ? img : img?.url ?? img?.contentUrl;
  if (imgU) linhas.push(`imagem: ${t(imgU, 400)}`);
  const ar = p.aggregateRating;
  if (ar?.ratingValue != null) {
    linhas.push(`avaliação dos clientes DESTA loja (não é o Vivino): ${t(ar.ratingValue, 10)}${(ar.ratingCount ?? ar.reviewCount) != null ? ` (${t(ar.ratingCount ?? ar.reviewCount, 12)})` : ""}`);
  }
  for (const ap of (Array.isArray(p.additionalProperty) ? p.additionalProperty : []).slice(0, 20)) {
    if (ap?.name && ap?.value != null) linhas.push(`${t(ap.name, 60)}: ${t(ap.value, 200)}`);
  }
  if (p.description) linhas.push(`descrição: ${t(p.description, 1500)}`);
  return linhas.join("\n");
}
/* O texto da zona principal (o `<main>`, se houver), sem menus, rodapé,
   scripts nem botões. As tabelas ficam "rótulo | valor" numa linha — é
   onde as lojas escrevem as castas, a região, o teor e o estágio. */
function textoDaPagina(html: string): string {
  let h = html;
  const main = h.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main && main[1].length > 500) h = main[1];
  else {
    const b = h.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
    h = (b ? b[1] : h).replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, " ");
  }
  h = h.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|aside|select|button)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[hd]>/gi, " | ")
    .replace(/<\/dt>/gi, ": ")
    .replace(/<\/(p|div|li|h[1-6]|section|article|tr|ul|ol|table|dd|dl|figcaption|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const linhas: string[] = [];
  for (const bruta of entidades(h).split("\n")) {
    const l = bruta.replace(/[ \t\u00a0]+/g, " ").replace(/^[\s|]+|[\s|]+$/g, "");
    if (!l || l === linhas[linhas.length - 1]) continue;
    linhas.push(l);
  }
  return linhas.join("\n").slice(0, PAGINA_MAX_TEXTO);
}
async function lerAte(r: Response, max: number): Promise<Uint8Array> {
  const rd = r.body?.getReader();
  if (!rd) return new Uint8Array();
  const partes: Uint8Array[] = [];
  let n = 0;
  while (n < max) {
    const { done, value } = await rd.read();
    if (done || !value) break;
    partes.push(value);
    n += value.length;
  }
  if (n >= max) await rd.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(n, max));
  let o = 0;
  for (const p of partes) {
    const c = p.subarray(0, out.length - o);
    out.set(c, o);
    o += c.length;
    if (o >= out.length) break;
  }
  return out;
}
type Pagina = {
  url: string; site: string; dada: boolean;
  estado: "lida" | "recusada" | "vazia" | "erro";
  http?: number; titulo?: string; motivo?: string; texto?: string;
};
async function abrirPagina(url0: string, dada: boolean, signal: AbortSignal): Promise<Pagina> {
  let url = url0;
  const base = (): Pagina => ({ url, site: siteDe(url) || siteDe(url0), dada, estado: "erro" });
  try {
    const sinal = AbortSignal.any([signal, AbortSignal.timeout(PAGINA_TIMEOUT_MS)]);
    let r: Response | null = null;
    for (let i = 0; i < 5; i++) {
      const u = new URL(url);
      if (!hostPublico(u)) return { ...base(), motivo: "endereço não permitido" };
      r = await fetch(u, {
        redirect: "manual", signal: sinal,
        headers: { "User-Agent": UA_PAGINA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.5" },
      });
      const loc = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
      if (!loc) break;
      await r.body?.cancel().catch(() => {});
      url = new URL(loc, url).toString();
      r = null;
    }
    if (!r) return { ...base(), motivo: "redireções a mais" };
    const tipo = r.headers.get("content-type") ?? "";
    if (r.status === 403 || r.status === 429 || r.status === 503) {
      await r.body?.cancel().catch(() => {});
      return { ...base(), estado: "recusada", http: r.status, motivo: `HTTP ${r.status}` };
    }
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      return { ...base(), http: r.status, motivo: `HTTP ${r.status}` };
    }
    if (tipo && !/html|xml/i.test(tipo)) {
      await r.body?.cancel().catch(() => {});
      return { ...base(), http: r.status, motivo: `não é uma página (${tipo.split(";")[0]})` };
    }
    const bytes = await lerAte(r, PAGINA_MAX_BYTES);
    // O charset do cabeçalho, senão o do <meta>, senão UTF-8.
    const ascii = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
    const cs = (tipo.match(/charset=["']?([\w-]+)/i) ?? ascii.match(/<meta[^>]+charset=["']?([\w-]+)/i) ?? [])[1] ?? "utf-8";
    let html: string;
    try { html = new TextDecoder(cs).decode(bytes); } catch { html = new TextDecoder().decode(bytes); }
    const titulo = texto(semTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1] ?? ""), 160);
    const corpo = textoDaPagina(html);
    const recusa = `${titulo} ${corpo.slice(0, 500)}`.match(RECUSA);
    if (recusa) return { ...base(), estado: "recusada", http: r.status, titulo, motivo: `a página diz "${recusa[0]}"` };
    const produto = produtoDaPagina(html);
    const meta = [["título", "og:title"], ["imagem", "og:image"], ["preço", "product:price:amount"],
      ["moeda", "product:price:currency"], ["preço", "price"], ["descrição", "og:description"]]
      .map(([rot, n]) => [rot, metaDe(html, n)]).filter(([, v]) => v).map(([rot, v]) => `${rot}: ${v}`);
    const partes = [
      titulo ? `Título da página: ${titulo}` : "",
      produto ? `DADOS DO PRODUTO (o que a página declara aos motores de busca):\n${produto}` : "",
      meta.length ? `ETIQUETAS DA PÁGINA:\n${meta.join("\n")}` : "",
      corpo ? `TEXTO DA PÁGINA:\n${corpo}` : "",
    ].filter(Boolean);
    if (!produto && corpo.length < 200) {
      return { ...base(), estado: "vazia", http: r.status, titulo, motivo: "a página quase não tem texto (é montada em JavaScript?)" };
    }
    return { ...base(), estado: "lida", http: r.status, titulo, texto: partes.join("\n\n") };
  } catch (e) {
    if (signal.aborted) throw e;
    const err = e as Error;
    return { ...base(), motivo: err.name === "TimeoutError" ? "não respondeu a tempo" : String(err.message).slice(0, 120) };
  }
}
/* O que o ecrã e o registo dizem de cada página (sem o texto). */
type PaginaRes = { site: string; url?: string; dada?: boolean; estado: string; http?: number; titulo?: string; motivo?: string };
const paginaRes = (p: Pagina): PaginaRes => ({
  site: p.site, url: p.url, dada: p.dada, estado: p.estado,
  ...(p.http ? { http: p.http } : {}), ...(p.titulo ? { titulo: p.titulo } : {}), ...(p.motivo ? { motivo: p.motivo } : {}),
});

/* A base de evidência: as páginas abertas primeiro, depois os resultados
   da pesquisa (os dos sites de confiança à frente) — tudo numerado de
   seguida, que é o número que o modelo devolve em `deOnde`. */
type Origem = { url: string; site: string; titulo: string; pagina?: boolean; dada?: boolean; google?: boolean };
function montarEvidencia(paginas: Pagina[], resultados: Resultado[], ano: number | null, dominios: string[]) {
  const lista: Origem[] = [];
  const blocos: string[] = [];
  let resto = EVIDENCIA_PAGINAS_MAX;
  for (const p of paginas) {
    if (p.estado !== "lida" || !p.texto || resto <= 0) continue;
    lista.push({ url: p.url, site: p.site, titulo: p.titulo || p.site, pagina: true, ...(p.dada ? { dada: true } : {}) });
    const b = `[${lista.length}] PÁGINA ABERTA de ${p.site}${p.dada
      ? " (indicada por quem pesquisa como sendo a deste vinho)"
      : ` (a primeira que a procura só em ${p.site} devolveu — confirma que é deste vinho)`}\nURL: ${p.url}\n${p.texto}`;
    blocos.push(b.slice(0, resto));
    resto -= b.length;
  }
  const vistos = new Set(lista.map((x) => x.url));
  // Um resultado sem resumo nem estrelas (a página de procura da loja, por
  // exemplo) não diz nada — fica de fora.
  const rs = resultados.filter((x) => (x.snippet || x.rating != null) && !vistos.has(x.url) && (vistos.add(x.url), true));
  const deConfianca = (x: Resultado) => dominios.find((d) => doSite(x.url, d)) ?? "";
  // Os dos sites de confiança à frente — é a eles que a regra manda ir primeiro.
  rs.sort((a, b) => Number(!deConfianca(a)) - Number(!deConfianca(b)));
  const textoRs: string[] = [];
  for (const x of rs) {
    lista.push({ url: x.url, site: siteDe(x.url), titulo: x.titulo || siteDe(x.url) });
    const viv = vivinoDeQue(x.url, ano);
    textoRs.push(`[${lista.length}] RESULTADO DA PESQUISA${deConfianca(x) ? " ★ FONTE DE CONFIANÇA" : ""} ${x.titulo}\nURL: ${x.url}\n` +
      (viv ? `(${viv})\n` : "") + `Resumo: ${x.snippet}` +
      (x.rating != null ? `\nEstrelas no Google: ${x.rating}${x.ratingCount != null ? ` (${x.ratingCount} avaliações)` : ""}` : ""));
  }
  const confianca: Record<string, number> = Object.fromEntries(dominios.map((d) => [d, lista.filter((o) => doSite(o.url, d)).length]));
  const texto_ = [...blocos, textoRs.join("\n\n").slice(0, 9000)].filter(Boolean).join("\n\n");
  return {
    texto: texto_,
    lista,
    fontes: lista.slice(0, 8).map((o) => ({ titulo: o.titulo.slice(0, 120), url: o.url.slice(0, 400) })),
    confianca,
  };
}
/* `deOnde` → de que página/resultado veio cada campo (as chaves da ficha).
   O modelo devolve o número; aceita-se também o endereço. */
const CAMPO_DO_JSON: Record<string, string> = Object.fromEntries(Object.entries(CAMPOS).map(([k, j]) => [j, k]));
function origemDosCampos(deOnde: unknown, lista: Origem[], ficha: Record<string, unknown>, ano: number | null): Record<string, Origem> {
  const out: Record<string, Origem> = {};
  if (!deOnde || typeof deOnde !== "object" || Array.isArray(deOnde)) return out;
  for (const [kj, bruto] of Object.entries(deOnde as Record<string, unknown>)) {
    const k = CAMPO_DO_JSON[kj] ?? (kj in CAMPOS ? kj : "");
    if (!k) continue;
    const n = Array.isArray(bruto) ? bruto[0] : bruto;
    const s = String(n ?? "").trim();
    const o = /^https?:\/\//i.test(s)
      ? lista.find((x) => x.url === s || s.startsWith(x.url))
      : lista[parseInt(s.replace(/\D+/g, " ").trim().split(" ")[0], 10) - 1];
    if (o) out[k] = o;
  }
  // Sem colheita, a nota "da colheita" passou a ser a de todas (`vivinoDuas`).
  if (ano === null) {
    if (out.vivino_nota && !out.vivino_nota_global) out.vivino_nota_global = out.vivino_nota;
    if (out.vivino_avaliacoes && !out.vivino_avaliacoes_global) out.vivino_avaliacoes_global = out.vivino_avaliacoes;
  }
  for (const k of Object.keys(out)) if (k !== "produtor" && !(k in ficha)) delete out[k];
  return out;
}
/* Numa frase, o que se passou com uma página (para o erro do "só estes sites"). */
function paginaEmFrase(p: PaginaRes): string {
  if (p.estado === "nao_encontrada") return `${p.site}: o vinho não apareceu na procura deste site`;
  if (p.estado === "sem_pesquisa") return `${p.site}: sem a pesquisa externa não há como procurar dentro do site — cola o link da página`;
  if (p.estado === "recusada") return `${p.site}: a página recusou a leitura (${p.motivo || "bloqueio"})`;
  if (p.estado === "vazia") return `${p.site}: ${p.motivo || "a página não tem texto"}`;
  if (p.estado === "erro") return p.url ? `${p.site}: não abriu (${p.motivo || "erro"})` : `${p.site}: ${p.motivo || "erro"}`;
  return `${p.site}: lida`;
}

/* Estimativa GROSSEIRA, como nas irmãs: os TOKENS são facto (vêm da API),
   o euro é um número redondo para dar ordem de grandeza. A pesquisa Google
   é faturada à parte, por pedido. Calibra pela fatura real no dia em que
   isto passar de curiosidade a orçamento. */
const CUSTO_PESQUISA_EUR = 0.01;
const CUSTO_GEMINI_SO_EUR = 0.002; // a profunda: o Gemini só lê, não pesquisa

/* ── A REGRA DO VIVINO: a página é do vinho, as notas são DUAS ──
   Espelho da mesma lição da `vinho-info.ts` (Garrafeira): a página do
   Vivino é do VINHO, não da colheita — o ano não faz parte da identidade
   dela (Villa Platanus 2022: exigir o ano deixava nota, avaliações e link
   sempre vazios). Mas as NOTAS são duas desde 26/09/2026 (ver o CLAUDE.md,
   "A nota do Vivino são duas"): a de todas as colheitas (a página sem ano)
   e a de UMA (`?year=`). Até 27/09/2026 esta regra dizia ao modelo que "a
   nota que lá aparece é uma média entre colheitas" e pedia-a na
   `vivinoNota` — que é a da COLHEITA: o Quinta do Carmo 2022 ficou com
   13 543 avaliações "da colheita". A escolha "tem de ser esta colheita"
   (`colheitaEspecifica`) deixou de ser sobre o Vivino (as duas notas já
   vêm separadas) e passou a ser sobre o resto da ficha (`regraColheita`).
   A MESMA regra está no `app.js` (`wcManualRegraVivino`), para os prompts
   manuais — mexer numa é mexer na outra. */
const regraVivino = (ano: number | null) => `O Vivino tem DUAS notas, e não se misturam:
   · "vivinoNotaGlobal"/"vivinoAvaliacoesGlobal" — a de TODAS as colheitas: a
     que a página do vinho mostra sem ano escolhido (…/w/<nº>, sem "?year=").
${ano
  ? `   · "vivinoNota"/"vivinoAvaliacoes" — SÓ a da colheita ${ano}: a da página com
     "?year=${ano}", ou a dessa colheita na lista de colheitas. Se só vires a de
     todas as colheitas, deixa estas duas vazias — nunca copies a de todas para aqui.`
  : `   · "vivinoNota"/"vivinoAvaliacoes" ficam de fora: este vinho não tem colheita, e
     a única nota que serve é a de todas as colheitas.`}
   A nota é o número entre 1.0 e 5.0 ao lado das estrelas; as avaliações vêm logo
   a seguir, entre parêntesis — não uses números de outra zona da página. Uma
   colheita nunca tem mais avaliações do que o vinho todo.
   "vivinoUrl" é a página do VINHO (…/<nome>/w/<nº>), a mesma para todas as
   colheitas: o ano não faz parte da identidade dela — basta o nome (já
   desambiguado na regra anterior) e o produtor baterem certo. Mantém o link se
   tiveres a certeza da página, mesmo sem nota.`;
/* "Tem de ser exatamente a colheita X" (o visto no ecrã). */
const regraColheita = (ano: number | null) => ano
  ? `O que responderes tem de ser da colheita ${ano}: teor, estágio, preço, notas de
   prova e janela de uma colheita diferente ficam fora do JSON.`
  : "";
/* Villa Platanus voltou a mostrar isto nos testes: o mesmo produtor tinha
   "Reserva" e "Terroir Blend" — escolher a cuvée errada é um erro tão real
   como não encontrar nada. */
const regraCuvee = `Se o produtor tiver mais do que um vinho com este nome
   (variantes de gama: Reserva, Grande Reserva, Colheita, Terroir, etc.) e
   não se souber qual, prefere a versão SEM qualificador extra; se essa não
   existir, escolhe a que tiver mais avaliações no Vivino (a principal da
   gama, normalmente) e diz no "aviso" que outras versões encontraste e
   qual escolheste.`;

const promptFicha = (
  nome: string, produtor: string, ano: number | null, regiao: string, tipo: string, notas: string, sites: string[],
  hoje: string, campos: string[] | null, colheitaEspecifica: boolean, evidencia = "", soSites = false,
) => `
És um enólogo a preencher a ficha de um vinho para um catálogo de referência.
${evidencia
  ? `Responde APENAS com base na BASE DE EVIDÊNCIA abaixo (páginas abertas e
resultados de uma pesquisa Google já feita). Não uses o que sabes de memória:
o que não estiver aqui fica fora do JSON.`
  : "Usa PESQUISA WEB (grounding search) para confirmar os dados — não respondas de memória."}

VINHO A IDENTIFICAR:
  Nome: ${nome}
${ano ? `  Ano (colheita): ${ano}\n` : ""}${produtor ? `  Produtor: ${produtor}\n` : ""}${regiao ? `  Região indicada: ${regiao}\n` : ""}${tipo ? `  Cor: ${tipo}\n` : ""}${notas ? `  Notas de quem procura: ${notas}\n` : ""}
Hoje é ${hoje}.
${campos && campos.length ? `
SÓ INTERESSAM ESTES CAMPOS: ${campos.map((k) => CAMPOS[k]).filter(Boolean).join(", ")}.
Concentra a pesquisa NELES e deixa os outros fora da resposta.
` : ""}
${soSites ? `
SÓ ESTES SITES: quem pesquisa quer APENAS o que dizem ${sites.join(", ")} — a base de
evidência abaixo é só deles. Não completes com o que sabes nem com mais nada: o que
estas páginas e resultados não disserem fica fora do JSON.
` : sites.length ? `
FONTES DE CONFIANÇA: dá prioridade a informação vinda de ${sites.join(", ")}. Só uses outra fonte se estas não tiverem a resposta.${evidencia ? ` Na base de evidência, as páginas destes sites vêm primeiro, e os resultados deles vêm marcados com ★ FONTE DE CONFIANÇA.` : ""}
` : ""}${evidencia ? `
BASE DE EVIDÊNCIA:
${evidencia}
` : ""}
REGRAS:
1. NÃO INVENTES. Um campo que não confirmes fica FORA do JSON (ou null).
   Este catálogo é lido por outras aplicações — um palpite aqui propaga-se.
2. ${regraCuvee}
3. ${regraVivino(ano)}
4. "imagemUrl" tem de ser link DIRETO de imagem (.jpg/.jpeg/.png/.webp/.avif),
   nunca o link da página.
5. Se houver dúvida de homónimo, prioriza ano + produtor + região e diz o que
   ficou por confirmar no "aviso".
6. Castas separadas por nome (nunca "blend"/"lote"/"várias castas").
7. "precoMedio" é o preço de RETALHO em euros, garrafa de 0,75 L.
8. ${ano ? `"beberDe"/"beberAte" são anos (a janela DESTA colheita).` : `Este vinho não tem colheita: NÃO há janela de consumo — deixa "beberDe"/"beberAte" de fora.`}
9. "produtorConfirmado" é o produtor tal como consta no rótulo ou numa loja
   oficial — usa o que vier em "Produtor" acima se estiver certo, ou
   corrige-o; deixa vazio se não tiveres a certeza, nunca inventes um nome.
${colheitaEspecifica && ano ? `10. ${regraColheita(ano)}
` : ""}${evidencia ? `${colheitaEspecifica && ano ? 11 : 10}. Uma PÁGINA ABERTA de OUTRO vinho (outro nome, outra gama, outra cor) não
   serve: ignora-a. O preço de uma página é o do produto DELA (o de "DADOS DO
   PRODUTO", se houver), nunca o de produtos relacionados ou sugeridos, nem o de
   uma caixa ou de uma garrafa grande. A avaliação dos clientes de uma loja NÃO é
   a nota do Vivino.
${colheitaEspecifica && ano ? 12 : 11}. "deOnde" diz, para CADA campo que preencheres (produtorConfirmado incluído),
   o número [n] da página ou do resultado de onde o tiraste — ex.: "castas": 1,
   "precoMedio": 3.${soSites ? " Um campo sem número em \"deOnde\" é deitado fora." : ""}
` : ""}
Responde SÓ com este JSON, sem texto à volta e sem blocos de código:
{
  "encontrado": true,
  "produtorConfirmado": "${produtor || "(o produtor deste vinho)"}",
  "tipo": "um de: ${TIPOS.join(" | ")}",
  "estilo": "vazio, ou um de: Maduro | Verde | Colheita Tardia | Palhete",
  "regiao": "região vitivinícola (Douro, Alentejo, Bairrada, Dão, Tejo, …)",
  "subRegiao": "",
  "pais": "Portugal",
  "mencao": "vazio, ou um de: ${MENCOES.filter(Boolean).join(" | ")}",
  "classificacao": "vazio, ou um de: DOC | Vinho Regional | Vinho",
  "castas": ["Touriga Nacional", "Touriga Franca"],
  "teor": 14.5,
  "estagioMeses": 18,
  "estagioTexto": "18 meses em barrica de carvalho francês",
${ano ? `  "vivinoNota": 4.2,
  "vivinoAvaliacoes": 312,
` : ""}  "vivinoNotaGlobal": 4.1,
  "vivinoAvaliacoesGlobal": 5234,
  "vivinoUrl": "",
  "imagemUrl": "",
  "precoMedio": 18.5,
${ano ? `  "beberDe": 2026,
  "beberAte": 2034,
` : ""}  "notasProva": "duas ou três frases sobre aroma, boca e final",
  "harmonizacao": "com que pratos",
  "resumo": "duas ou três frases sobre o vinho e o produtor",
${evidencia ? `  "deOnde": {"castas": 1, "teor": 1, "precoMedio": 2},
` : ""}  "aviso": "vazio, ou o que ficou por confirmar"
}

Se não conseguires identificar o vinho de todo, responde
{"encontrado": false, "aviso": "porquê"}.`;

/* ── Falar com a base ── */
async function rpc(fn: string, corpo: Record<string, unknown>, auth?: string, signal?: AbortSignal): Promise<any> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SB_SRV,
      Authorization: auth || ("Bearer " + SB_SRV),
      "Content-Type": "application/json",
      "Content-Profile": "winecatalog", "Accept-Profile": "winecatalog",
    },
    body: JSON.stringify(corpo),
    ...(signal ? { signal } : {}),
  });
  if (!r.ok) throw new Error(`winecatalog ${fn} ${r.status}`);
  return await r.json();
}
async function tabela(path: string, opt: RequestInit = {}): Promise<Response> {
  return await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opt,
    headers: {
      apikey: SB_SRV, Authorization: "Bearer " + SB_SRV,
      "Content-Type": "application/json",
      "Content-Profile": "winecatalog", "Accept-Profile": "winecatalog",
      ...(opt.headers ?? {}),
    },
  });
}

async function registar(estado: string, detalhe: Record<string, unknown>, quem: string | null): Promise<void> {
  try {
    const r = await tabela("sync_log", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ origem: "function", acao: "catalogo_info", estado, quem, detalhe }),
    });
    if (!r.ok) console.log("CATALOGO-INFO sync_log falhou:", r.status);
  } catch (e) {
    console.log("CATALOGO-INFO sync_log erro:", String((e as Error).message).slice(0, 200));
  }
  await registarIaUso("catalogo-info", estado, detalhe, quem);
}

/* Espelho em `ia_uso.registos` — schema à parte, no MESMO projeto Supabase,
   partilhado pelas cinco apps (ver CLAUDE.md "O registo central de acessos
   ao Gemini"). É o MESMO `detalhe` de cima, só com tokens/modelo/custo
   promovidos a colunas, para uma tabela que soma o gasto do Gemini ao todo
   em vez de app a app. Nunca deita a chamada principal abaixo por isto
   falhar — a mesma regra do `registar()` local, aqui à parte porque este
   POST vai para outro schema (`Content-Profile: ia_uso`, não `winecatalog`). */
async function registarIaUso(funcao: string, estado: string, detalhe: Record<string, unknown>, quem: string | null): Promise<void> {
  try {
    const usage = (detalhe.usageMetadata ?? null) as
      | { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number }
      | null;
    const pesquisa = detalhe.pesquisa as unknown;
    await fetch(`${SB_URL}/rest/v1/registos`, {
      method: "POST",
      headers: {
        apikey: SB_SRV, Authorization: "Bearer " + SB_SRV,
        "Content-Type": "application/json", "Content-Profile": "ia_uso",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        app: "winecatalog", funcao,
        estado: estado === "pedido" || estado === "erro" ? estado : "ok",
        modelo: (detalhe.modelo as string | undefined) ?? null,
        pesquisa_web: typeof pesquisa === "boolean" ? pesquisa : (typeof pesquisa === "string" ? pesquisa.length > 0 : null),
        tokens_entrada: usage?.promptTokenCount ?? null,
        tokens_saida: usage?.candidatesTokenCount ?? null,
        tokens_pensamento: usage?.thoughtsTokenCount ?? null,
        tokens_total: usage?.totalTokenCount ?? null,
        custo_estimado_eur: (detalhe.custo_estimado_eur as number | undefined) ?? null,
        duracao_ms: (detalhe.ms as number | undefined) ?? null,
        quem,
        erro: estado === "erro"
          ? (String((detalhe.erro as string | undefined) ?? (detalhe.passo as string | undefined) ?? "").slice(0, 500) || null)
          : null,
        detalhe,
      }),
    });
  } catch (_e) {
    // nunca deita a chamada principal abaixo
  }
}

/* Fecha SEMPRE a linha de trabalho. Uma pesquisa presa em 'pendente' deixa
   o ecrã do outro lado a rodar para sempre — e o botão bloqueado por cinco
   minutos (ver `pesquisa_criar`). */
async function fechar(id: number, patch: Record<string, unknown>): Promise<void> {
  try {
    const r = await tabela(`pesquisas?id=eq.${id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ ...patch, fechado_em: new Date().toISOString() }),
    });
    if (!r.ok) console.log("CATALOGO-INFO fechar falhou:", r.status);
  } catch (e) {
    console.log("CATALOGO-INFO fechar erro:", String((e as Error).message).slice(0, 200));
  }
}

type Linha = {
  id: number; nome: string; produtor: string; ano: number | null;
  ficha: Record<string, unknown>; origens: Record<string, any>;
};
async function lerVinho(id: number, signal?: AbortSignal): Promise<Linha | null> {
  const r = await tabela(`vinhos?id=eq.${id}&select=id,nome,produtor,ano,ficha,origens`,
    signal ? { signal } : {});
  if (!r.ok) return null;
  const rows = await r.json();
  const v = rows?.[0];
  if (!v) return null;
  return {
    id: v.id, nome: String(v.nome ?? ""), produtor: String(v.produtor ?? ""),
    ano: typeof v.ano === "number" ? v.ano : null,
    ficha: (v.ficha && typeof v.ficha === "object") ? v.ficha : {},
    origens: (v.origens && typeof v.origens === "object") ? v.origens : {},
  };
}

/* O trabalho a sério — via EdgeRuntime.waitUntil.

   `respostaManual`, quando vem preenchido, é a PESQUISA MANUAL: o admin já
   colou o prompt no Gemini dele e trouxe a resposta — não se chama a API
   nenhuma, só se faz `extrairJson`/`normalizar` no texto que veio e segue-se
   dali para a frente EXATAMENTE como a automática (mesma `juntar`, força 3,
   mesmo relatório do que entrou e porquê). Zero chamadas ao Gemini, zero
   custo — só o trabalho de ler e validar, que é o mesmo trabalho que já se
   fazia à resposta automática.

   `rever` (26/09/2026) é o modo REVER ANTES DE GRAVAR, o mesmo desenho da
   Garrafeira: não se chama a `juntar`. A pesquisa fecha com as PROPOSTAS
   (o valor encontrado e o que o catálogo tinha nesse momento, com a origem)
   e o admin escolhe no ecrã o que entra — pela
   `winecatalog.pesquisa_aplicar`, que lê os valores DAQUI, da linha da
   pesquisa, e nunca do browser. Sem `rever` fica o comportamento antigo
   (grava pela força e relata): é o que uma app ainda em cache chama, e
   deixa o deploy desta função não depender do da página. */
async function processarPesquisa(
  pesquisaId: number, vinhoId: number, quem: string, campos: string[] | null,
  respostaManual: string | null = null, colheitaEspecifica: boolean = false,
  notas: string = "", sites: string[] = [], profunda: boolean = false,
  vivinoDado: string = "", rever: boolean = false,
  // As páginas coladas nos sites (ver "AS PÁGINAS DOS SITES") e o visto
  // "Usar só a informação destes sites".
  paginasDadas: string[] = [], soSites: boolean = false,
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROC_TIMEOUT_MS);
  let model = respostaManual !== null ? "manual (colado)" : "gemini-flash-latest";

  try {
    const antes = await lerVinho(vinhoId, ctrl.signal);
    if (!antes) {
      await fechar(pesquisaId, { estado: "erro", erro: "a linha do catálogo desapareceu" });
      return;
    }
    // A nota da colheita traz a de todas; sem colheita, só a de todas.
    campos = camposComGlobal(campos, antes.ano);
    // Os sites de confiança que são domínios (ver `dominioDe`); o que
    // aconteceu com eles vai para o resultado e para o registo.
    const dominios = [...new Set(sites.map(dominioDe).filter(Boolean))];
    let confianca: Record<string, number> | null = null;
    let consultasFeitas: string[] = [];

    let parsed: any;
    let usage: UsageMetadata | null = null;
    let fontes: { titulo: string; url: string }[] = [];
    let grounding: Record<string, unknown> | null = null;
    // null na manual (não há como saber); true/false na automática.
    let pesquisaWeb: boolean | null = null;
    let serperConsultas = 0; // as consultas ao Serper do pacote completo
    let usouGround = false;  // houve (também) a fase com grounding
    // De onde veio cada campo: a lista numerada da base de evidência, e os
    // campos (chaves do JSON) que só o grounding trouxe.
    let lista: Origem[] = [];
    const doGround = new Set<string>();
    let paginasRes: PaginaRes[] = [];
    let paginasLidas = 0;       // quantas páginas se abriram e leram
    let leuEvidencia = false;   // houve a fase em que o Gemini só lê

    if (respostaManual !== null) {
      parsed = extrairJson(respostaManual);
      if (!parsed) {
        await registar("erro", { passo: "manual_json", vinho_id: vinhoId }, quem);
        await fechar(pesquisaId, {
          estado: "erro",
          erro: "não consegui ler a resposta colada como JSON — confirma que colaste o texto todo, incluindo as chavetas { }.",
        });
        return;
      }
    } else {
      /* `notas`/`sites`: contexto LIVRE escrito por quem manda pesquisar
         (duas caixas de texto na app, não campos fechados) — ajuda a não
         confundir este vinho com um homónimo e a dar prioridade a fontes de
         confiança. Nunca entram na lista `campos` (o que se pede de volta);
         só no texto do prompt. */
      /* O PACOTE COMPLETO (27/09/2026, o dono das apps): primeiro a pesquisa
         NOSSA (Serper: uma consulta geral e uma ao Vivino, e o Gemini só a
         ler os resultados, sem `google_search` e com JSON direto) e depois,
         SÓ pelos campos que ela não trouxe, o grounding. Tudo de seguida,
         uma pesquisa só para quem a pediu. Quem chega aqui é sempre o admin
         do catálogo, que tem sempre o pacote completo. Sem Serper (chave em
         falta, erro, nada encontrado), faz-se só o grounding. */
      /* E OS SITES (27/09/2026): cada domínio escrito sem página tem uma
         procura SÓ nele, e a primeira página de produto que ela devolver
         abre-se; as páginas coladas abrem-se tal e qual, logo à partida (ver
         "AS PÁGINAS DOS SITES"). Com o `soSites`, só isto — nem a consulta
         geral, nem a do Vivino se o Vivino não for um dos sites. */
      let evidencia = "";
      const ehVivino = (d: string) => doSite(`https://${d}/`, "vivino.com");
      const dadas = paginasDadas.filter((u) => !doSite(u, "vivino.com"));
      const sig = ctrl.signal;
      const abrirDadas = Promise.all(dadas.map((u) => abrirPagina(u, true, sig)));
      const comPagina = dadas.map(siteDe);
      const procurarEm = dominios.filter((d) => !ehVivino(d) && !comPagina.some((sd) => doSite(`https://${sd}/`, d)));
      const quem_ = [antes.nome, antes.produtor, antes.ano ?? ""].filter(Boolean).join(" ");
      const consultas: { q: string; dominio?: string }[] = [];
      if (!soSites) consultas.push({ q: `${quem_} vinho preço` });
      if (!soSites || !!vivinoDado || dominios.some(ehVivino)) {
        consultas.push({ q: `"${antes.nome.replace(/"/g, "")}" ${antes.produtor} site:vivino.com`.replace(/\s+/g, " "), dominio: "vivino.com" });
      }
      for (const d of procurarEm) consultas.push({ q: `${quem_} site:${d}`, dominio: d });
      const resultados: Resultado[] = [];
      const achadas: string[] = [];
      if (SEARCH_API_KEY && consultas.length) {
        const rs = await Promise.allSettled(consultas.map((c) => serperConsulta(c.q, sig)));
        if (sig.aborted) throw new DOMException("timeout", "AbortError");
        serperConsultas = consultas.length;
        consultasFeitas = consultas.map((c) => c.q);
        rs.forEach((r, i) => {
          const d = consultas[i].dominio;
          if (r.status !== "fulfilled") {
            if (d && d !== "vivino.com") paginasRes.push({ site: d, estado: "erro", motivo: "a procura neste site falhou" });
            return;
          }
          // Com o `soSites`, um resultado de fora dos sites (o Google às
          // vezes junta um) não entra.
          const rows = soSites && d ? r.value.filter((x) => doSite(x.url, d)) : r.value;
          resultados.push(...rows);
          if (d && d !== "vivino.com") {
            const pr = paginaDoResultado(rows, d);
            if (pr) achadas.push(pr.url);
            else paginasRes.push({ site: d, estado: "nao_encontrada" });
          }
        });
        const falhou = rs.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
        if (falhou) {
          await registar("erro", { passo: "serper", vinho_id: vinhoId,
            erro: String((falhou.reason as Error)?.message ?? falhou.reason).slice(0, 300) }, quem);
        }
      } else {
        // Sem a chave do Serper não há como procurar dentro de um site.
        procurarEm.forEach((d) => paginasRes.push({ site: d, estado: "sem_pesquisa" }));
      }
      const [abertasDadas, abertasAchadas] = await Promise.all([abrirDadas, Promise.all(achadas.map((u) => abrirPagina(u, false, sig)))]);
      // Uma página colada que não se deixou ler (403, desafio anti-bots,
      // 404): fica o que o Google mostra desse site, se houver pesquisa.
      const semLeitura = [...new Set(abertasDadas.filter((p) => p.estado !== "lida").map((p) => p.site))]
        .filter((d) => d && !procurarEm.includes(d));
      if (SEARCH_API_KEY && semLeitura.length) {
        const qs = semLeitura.map((d) => `${quem_} site:${d}`);
        const rs2 = await Promise.allSettled(qs.map((q) => serperConsulta(q, sig)));
        serperConsultas += qs.length;
        consultasFeitas = [...consultasFeitas, ...qs];
        rs2.forEach((r, i) => { if (r.status === "fulfilled") resultados.push(...r.value.filter((x) => doSite(x.url, semLeitura[i]))); });
      }
      const abertas = [...abertasDadas, ...abertasAchadas];
      paginasRes = [...abertas.map(paginaRes), ...paginasRes];
      paginasLidas = abertas.filter((p) => p.estado === "lida").length;
      const ev = montarEvidencia(abertas, resultados, antes.ano, dominios);
      evidencia = ev.texto;
      lista = ev.lista;
      // Sem pesquisa nem páginas, os sites foram só texto no pedido — e é
      // isso que o ecrã diz quando não há contagem.
      if (dominios.length && (serperConsultas || abertas.length)) confianca = ev.confianca;
      if (evidencia) fontes = ev.fontes;
      if (soSites && !evidencia) {
        const porque = paginasRes.map(paginaEmFrase).join("; ") || "nenhum dos sites é um domínio ou um link";
        await registar("erro", { passo: "so_sites_vazio", vinho_id: vinhoId, sites, paginas: paginasRes,
          ...(serperConsultas ? { serper_consultas: serperConsultas, consultas: consultasFeitas } : {}) }, quem);
        await fechar(pesquisaId, { estado: "erro", erro: `não consegui ler nada dos sites escolhidos — ${porque}.` });
        return;
      }
      const notasPedido = vivinoDado ? `${notas}\nA página do Vivino deste vinho é ${vivinoDado} — usa esta, é a certa.`.trim() : notas;
      const textoDe = (camposP: string[] | null, ev: string) => promptFicha(
        antes.nome, antes.produtor, antes.ano, String(antes.ficha.regiao ?? ""),
        String(antes.ficha.tipo ?? ""), notasPedido, sites,
        new Date().toISOString().slice(0, 10), camposP, colheitaEspecifica, ev, soSites && !!ev,
      );

      /* Com o `google_search` ligado NÃO há variante com `thinkingBudget:0`:
         a API recusa as duas juntas com 400. Com os resultados do Serper é
         ao contrário: sem tool, e pede-se JSON direto. */
      const chamarGemini = (m: string, textoPedido: string, comGround: boolean) =>
        fetch(`${GAPI}/models/${m}:generateContent?key=${GEMINI_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: textoPedido }] }],
            ...(comGround
              ? { generationConfig: { temperature: 0 }, tools: [{ google_search: {} }] }
              : { generationConfig: { temperature: 0, responseMimeType: "application/json" } }),
          }),
        });

      const transitorio = (st: number) => st === 429 || st === 500 || st === 503;
      const candidatos = await candidatosModelo(ctrl.signal);
      if (ctrl.signal.aborted) throw new DOMException("timeout", "AbortError");
      console.log("CATALOGO-INFO candidatos:", candidatos.join(", "));

      /* Uma pergunta ao Gemini, modelo a modelo. O CORPO LÊ-SE DENTRO DO
         CICLO: um 200 COM ZERO TOKENS DE SAÍDA (o modelo gasta o orçamento a
         pensar e não escreve nada) passa ao modelo seguinte, e se nenhum
         escrever é ERRO, nunca "concluído, 0 campos" (20/09/2026). */
      type Resposta = { gd: any; bruto: string } | { falha: Response | null; vazioMotivo: string };
      const perguntar = async (textoPedido: string, comGround: boolean): Promise<Resposta> => {
        let g: Response | null = null;
        let vazioMotivo = "";
        for (let ci = 0; ci < candidatos.length && !ctrl.signal.aborted; ci++) {
          model = candidatos[ci];
          g = await chamarGemini(model, textoPedido, comGround);
          console.log("CATALOGO-INFO tentativa:", model, comGround ? "(grounding)" : "(serper)", "->", g.status);
          if (g.ok) {
            const gd = await g.json();
            const cand = gd?.candidates?.[0];
            const motivo = String(cand?.finishReason ?? "");
            const bruto = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
            usage = somarUso(usage, usageMetadata(gd));
            if (bruto) return { gd, bruto };
            vazioMotivo = motivo || "resposta vazia";
            g = null;
            continue;
          }
          if (g.status === 404) { _models = null; continue; }
          if (!transitorio(g.status)) break;
        }
        return { falha: g, vazioMotivo };
      };

      // Todos os campos que se pediram (ou todos, se não se escolheu), sem a
      // janela quando não há colheita.
      const pedidos = (camposSemJanela(campos, antes.ano) ?? Object.keys(CAMPOS))
        .filter((k) => antes.ano !== null || (k !== "beber_de" && k !== "beber_ate" && !(k in PAR_VIVINO)));
      const vazioV = (x: unknown) => x == null || x === "" || (Array.isArray(x) && !x.length);

      let r: Resposta | null = null;
      if (evidencia) {
        leuEvidencia = true;
        r = await perguntar(textoDe(camposSemJanela(campos, antes.ano), evidencia), false);
        if ("gd" in r) { parsed = extrairJson(r.bruto); pesquisaWeb = true; }
      }
      // O grounding: pelo que o Serper não trouxe, ou por tudo sem Serper.
      // Nunca com o "só estes sites": o que eles não disserem fica vazio.
      const jaTem = parsed ? normalizar(parsed, campos, antes.ano) : {};
      const faltam = pedidos.filter((k) => vazioV((jaTem as any)[k]));
      if (!soSites && (!parsed || faltam.length)) {
        usouGround = true;
        const r2 = await perguntar(textoDe(parsed ? faltam : camposSemJanela(campos, antes.ano), ""), true);
        if ("gd" in r2) {
          const p2 = extrairJson(r2.bruto);
          const fg = fontesGrounding(r2.gd);
          grounding = resumoGrounding(r2.gd);
          console.log("CATALOGO-INFO grounding:", JSON.stringify(grounding));
          if (!parsed) pesquisaWeb = fezPesquisa(r2.gd);
          fontes = [...fontes, ...fg].filter((f, i, a) => a.findIndex((x) => x.url === f.url) === i);
          // O Serper ganha: o grounding só tapa o que ele deixou vazio.
          const cheios = parsed ? Object.fromEntries(Object.entries(parsed).filter(([, v]) => !vazioV(v))) : {};
          for (const [kj, v] of Object.entries(p2 ?? {})) if (!(kj in cheios) && !vazioV(v)) doGround.add(kj);
          parsed = { ...(p2 ?? {}), ...cheios };
        } else if (!parsed) {
          r = r2;
        }
      }

      if (!parsed && r && "falha" in r) {
        const g = r.falha;
        if (g && !g.ok) {
          const status = g.status;
          const detail = await g.text();
          let msg = "";
          try { msg = JSON.parse(detail)?.error?.message ?? ""; } catch (_) { /**/ }
          await registar("erro", { passo: "gemini", status, modelo: model, vinho_id: vinhoId, erro: (msg || detail).slice(0, 800) }, quem);
          await fechar(pesquisaId, {
            estado: "erro",
            erro: transitorio(status)
              ? "o serviço está com muita procura agora — tenta outra vez"
              : `gemini ${status} (${model})${msg ? ": " + msg.slice(0, 200) : ""}`,
          });
          return;
        }
        const vazioMotivo = r.vazioMotivo;
        await registar("erro", {
          passo: vazioMotivo ? "gemini_vazio" : "gemini_sem_resposta",
          modelo: model, vinho_id: vinhoId, finishReason: vazioMotivo || null,
          erro: vazioMotivo ? `resposta vazia (${vazioMotivo})` : "sem resposta do Gemini",
          ...(usage ? { usageMetadata: usage } : {}),
        }, quem);
        await fechar(pesquisaId, {
          estado: "erro",
          erro: vazioMotivo
            ? `o modelo respondeu sem escrever nada (${vazioMotivo}) — gastou o orçamento a pensar. Tenta outra vez, ou usa a pesquisa manual.`
            : "não consegui falar com o Gemini — tenta outra vez",
        });
        return;
      }
    }

    const ficha = normalizar(parsed, campos, antes.ano);
    // O link do Vivino que quem pesquisa colou nos sites de confiança é
    // FACTO (abriu-o), e ganha ao que o modelo escreveu — que, de memória,
    // costuma ser inventado.
    if (vivinoDado && (!campos || campos.includes("vivino_url"))) ficha.vivino_url = vivinoDado;
    // Sem colheita não há janela de consumo: os anos dela seriam os de uma
    // colheita qualquer. O trigger `vinhos_sem_colheita` também a tira, mas
    // assim nem aparece no relatório como se tivesse entrado.
    if (antes.ano === null) { delete ficha.beber_de; delete ficha.beber_ate; }
    /* DE ONDE VEIO CADA CAMPO (27/09/2026): o número que o modelo deu em
       `deOnde` → a página ou o resultado; o que só o grounding trouxe diz-se
       como tal; o link do Vivino colado é o próprio link. Com o "só estes
       sites", um campo sem origem sai — não há como dizer que veio deles. */
    const origem = origemDosCampos(parsed?.deOnde, lista, ficha, antes.ano);
    for (const kj of doGround) {
      const k = CAMPO_DO_JSON[kj];
      if (k && (k in ficha || k === "produtor") && !origem[k]) origem[k] = { url: "", site: "", titulo: "pesquisa Google", google: true };
    }
    if (vivinoDado && ficha.vivino_url === vivinoDado) {
      origem.vivino_url = { url: vivinoDado, site: "vivino.com", titulo: "o link que colaste", dada: true };
    }
    const semFonte: string[] = [];
    if (soSites) {
      for (const k of Object.keys(ficha)) if (!origem[k]) { delete ficha[k]; semFonte.push(k); }
    }
    const aviso = texto(parsed?.aviso, 300);
    // A pesquisa manual não tem forma de citar fontes de verdade (não há
    // `groundingMetadata` nenhum a colar aqui) — inventar uma era pior do
    // que não ter nenhuma.
    const chamadasGemini = respostaManual !== null ? 0 : 1;
    // Com o Serper, o Gemini só lê (e paga-se o Serper, à parte); a fase
    // com grounding custa a pesquisa Google.
    const custoEstimado = respostaManual !== null ? 0
      : (leuEvidencia ? CUSTO_GEMINI_SO_EUR : 0) + serperConsultas * CUSTO_SERPER_EUR
        + (usouGround ? CUSTO_PESQUISA_EUR : 0);
    // A app diz "a pesquisa avançada" quando houve Serper.
    profunda = serperConsultas > 0;
    const serperLog = {
      ...(serperConsultas || paginasLidas ? {
        pesquisa: [serperConsultas ? "serper" : "", paginasLidas ? "paginas" : "", usouGround ? "grounding" : ""].filter(Boolean).join("+"),
        ...(serperConsultas ? { serper_consultas: serperConsultas, consultas: consultasFeitas } : {}),
        ...(paginasLidas ? { paginas_lidas: paginasLidas } : {}),
      } : {}),
      // O que se fez com os sites de confiança: sem isto não havia maneira de
      // saber se tinham servido para alguma coisa.
      ...(sites.length ? { sites, ...(confianca ? { confianca } : {}) } : {}),
      ...(paginasRes.length ? { paginas: paginasRes } : {}),
      ...(soSites ? { so_sites: true, ...(semFonte.length ? { sem_fonte: semFonte } : {}) } : {}),
    };
    const sitesRes = sites.length
      ? { sites, confianca, ...(paginasRes.length ? { paginas: paginasRes } : {}),
          ...(soSites ? { soSites: true, ...(semFonte.length ? { semFonte } : {}) } : {}) }
      : {};

    /* O PRODUTOR não é campo de ficha — não passa pela `juntar` nem pela
       `forca()` que decide os outros. É IDENTIDADE (parte da `chave`), e
       mudar identidade é sempre um passo consciente do admin, pelo
       `editar` com `p_mexer_identidade` (que verifica duplicados) — nunca
       algo que uma pesquisa escreve de passagem. Continua a poder ser
       PEDIDO — é sempre uma das opções, mesmo já preenchido — mas o que
       volta é só uma SUGESTÃO no relatório. */
    const produtorPedido = !campos || campos.includes("produtor");
    const produtorSugerido = produtorPedido && (!soSites || origem.produtor) ? texto(parsed?.produtorConfirmado, 90) : "";
    const produtorMudou = !!produtorSugerido &&
      produtorSugerido.toLowerCase() !== antes.produtor.trim().toLowerCase();

    if (!Object.keys(ficha).length && !produtorMudou) {
      await registar("ok", { passo: "sem_campos", modelo: model, vinho_id: vinhoId, campos: 0,
        fontes: fontes.length, ...(grounding ? { grounding } : {}),
        ...(pesquisaWeb !== null ? { pesquisaWeb } : {}), ...(profunda ? { profunda: true } : {}), ...serperLog,
        ...(usage ? { usageMetadata: usage } : {}), chamadas_gemini: chamadasGemini,
        custo_estimado_eur: custoEstimado, manual: respostaManual !== null }, quem);
      await fechar(pesquisaId, {
        estado: "concluido",
        resultado: { modelo: model, campos: 0, aviso: aviso || null, propostas: [], fontes, pesquisaWeb, profunda, ...sitesRes, ...(rever ? { rever: true } : {}) },
      });
      return;
    }

    /* REVER ANTES DE GRAVAR: não se escreve nada. Cada proposta leva o que
       o catálogo tinha AGORA (`atual`, com a origem e a força) — é o que o
       ecrã mostra ao lado, e é contra isso que a `pesquisa_aplicar` confere
       que nada mudou entretanto. */
    if (rever) {
      const propostas: Record<string, unknown>[] = Object.keys(ficha).map((k) => ({
        campo: k,
        valor: ficha[k],
        atual: antes.ficha?.[k] ?? null,
        origemAtual: String(antes.origens?.[k]?.o ?? "") || null,
        forcaAtual: Number(antes.origens?.[k]?.f ?? 0),
        ...(origem[k] ? { fonte: origem[k] } : {}),
      }));
      if (produtorMudou) {
        propostas.push({
          campo: "produtor", valor: produtorSugerido, identidade: true,
          atual: antes.produtor || null,
          ...(origem.produtor ? { fonte: origem.produtor } : {}),
        });
      }
      console.log("CATALOGO-INFO rever:", propostas.length, "propostas",
                  "modelo:", model, "fontes:", fontes.length);
      await registar("ok", {
        modelo: model, vinho_id: vinhoId,
        // O que a IA trouxe (a vista `consumo` conta isto como itens da IA);
        // o que o admin aceitar fica no `sync_log` da `pesquisa_aplicar`.
        campos: propostas.length, rever: true,
        fontes: fontes.length,
        ...(grounding ? { grounding } : {}),
        ...(pesquisaWeb !== null ? { pesquisaWeb } : {}), ...(profunda ? { profunda: true } : {}), ...serperLog,
        ...(usage ? { usageMetadata: usage } : {}),
        chamadas_gemini: chamadasGemini, custo_estimado_eur: custoEstimado,
        manual: respostaManual !== null,
      }, quem);
      await fechar(pesquisaId, {
        estado: "concluido",
        resultado: { modelo: model, campos: 0, aviso: aviso || null, propostas, fontes, pesquisaWeb, profunda, ...sitesRes, rever: true },
      });
      return;
    }

    // A escrita passa pela `juntar` como qualquer outra: é ela que decide,
    // campo a campo, se isto ganha ao que já lá estava. Uma pesquisa não
    // tem direito de passagem só por ter sido pedida à mão — e a manual
    // entra com a MESMA origem `catalogo-pesquisa` (força 3) da automática:
    // o que muda é como se chegou ao JSON, não a confiança que ele merece.
    // Só se chama se sobrar ALGUM campo de ficha — o produtor nunca vai
    // nesta chamada, é o `editar` que trata dele.
    if (Object.keys(ficha).length) {
      await rpc("juntar", {
        p_nome: antes.nome, p_produtor: antes.produtor, p_ano: antes.ano,
        p_ficha: ficha, p_origem: "catalogo-pesquisa", p_fontes: fontes,
      }, undefined, ctrl.signal);
    }

    /* E AGORA O QUE DÁ SENTIDO AO ECRÃ: dizer o que entrou e o que NÃO
       entrou, e porquê. Sem isto, o admin manda pesquisar, vê metade dos
       campos na mesma e fica sem saber se a pesquisa falhou ou se a base
       recusou — que são coisas muito diferentes. A recusa é o sistema a
       funcionar (alguém com a garrafa na mão sabe melhor), mas só se
       souber que aconteceu. */
    const depois = Object.keys(ficha).length ? await lerVinho(vinhoId, ctrl.signal) : antes;
    const propostas: Record<string, unknown>[] = Object.keys(ficha).map((k) => {
      const origemDepois = String(depois?.origens?.[k]?.o ?? "");
      const entrou = origemDepois === "catalogo-pesquisa";
      return {
        campo: k,
        valor: ficha[k],
        entrou,
        // quem ganhou, quando não foi esta pesquisa
        ganhou: entrou ? null : (String(antes.origens?.[k]?.o ?? "") || null),
        forca: entrou ? null : Number(antes.origens?.[k]?.f ?? 0),
        ...(origem[k] ? { fonte: origem[k] } : {}),
      };
    });
    // O produtor entra à parte — `identidade:true` é o que diz ao ecrã para
    // NUNCA o tratar como um campo normal (nem "entrou", nem "perdeu para
    // outra fonte": não faz sentido nenhum dos dois para uma coisa que não
    // se escreveu).
    if (produtorMudou) {
      propostas.push({
        campo: "produtor", valor: produtorSugerido, entrou: false,
        identidade: true, atual: antes.produtor || null,
      });
    }
    const entraram = propostas.filter((p) => (p as any).entrou).length;

    /* `fontes` são os `groundingChunks` que a pesquisa Google devolveu. Vão
       para o log por uma razão que não é curiosidade: a ZERO, a resposta não
       foi pesquisada — foi escrita de memória, e uma ficha de memória a
       entrar no catálogo com a força de uma pesquisa é exatamente o que a
       invariante 9 proíbe ("uma nota pesquisada e um palpite não podem
       parecer a mesma coisa"). Regista-se primeiro porque não há histórico
       nenhum para comparar: a primeira pesquisa automática a correr até ao
       fim foi a do Meandro, e veio com zero. Decidido a 24/09/2026: sem
       fontes NÃO se recusa (é o que as outras apps fazem, e o que as
       pesquisas trouxeram foi conferido e estava certo). O `grounding` ao
       lado serve para perceber se as fontes se perdem do nosso lado — ver
       `resumoGrounding` e o CLAUDE.md, "ZERO fontes". */
    console.log("CATALOGO-INFO ok:", entraram, "de", propostas.length,
                "modelo:", model, "fontes:", fontes.length);
    await registar("ok", {
      modelo: model, vinho_id: vinhoId,
      campos: entraram, propostos: propostas.length,
      fontes: fontes.length,
      ...(grounding ? { grounding } : {}),
      ...(pesquisaWeb !== null ? { pesquisaWeb } : {}), ...(profunda ? { profunda: true } : {}), ...serperLog,
      ...(usage ? { usageMetadata: usage } : {}),
      chamadas_gemini: chamadasGemini, custo_estimado_eur: custoEstimado,
      manual: respostaManual !== null,
    }, quem);
    await fechar(pesquisaId, {
      estado: "concluido",
      resultado: { modelo: model, campos: entraram, aviso: aviso || null, propostas, fontes, pesquisaWeb, profunda, ...sitesRes },
    });
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError";
    await registar("erro", { passo: timeout ? "timeout" : "excecao", vinho_id: vinhoId, erro: String(err.message).slice(0, 500) }, quem);
    await fechar(pesquisaId, {
      estado: "erro",
      erro: timeout ? "demorou demasiado a pesquisar — tenta outra vez"
                    : (err.message || "erro inesperado"),
    });
  } finally {
    clearTimeout(timer);
  }
}

/* Um pedido nosso que fica pendurado. A 24/09/2026 o primeiro fetch de uma
   instância acabada de arrancar (o /auth/v1/user) nunca chegou ao servidor:
   dez segundos parados, e a pesquisa morreu com um "The signal has been
   aborted" cru, antes de sequer começar. Cada pedido da fase síncrona tem
   por isso o seu tecto curto, e uma segunda tentativa. */
async function fetchCurto(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  for (let tentativa = 0; ; tentativa++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]) });
    } catch (e) {
      if (signal.aborted || tentativa >= 1) throw e;
      console.log("CATALOGO-INFO pedido pendurado, nova tentativa:", url.replace(/\?.*$/, ""));
    }
  }
}

/* Quem é, e se manda aqui. O `sou_admin()` corre com o JWT DA PESSOA (não
   com a service role): quem decide quem é o admin é a base, e é a mesma
   resposta que o ecrã usa para mostrar o botão. */
async function admin(auth: string, signal: AbortSignal): Promise<{ ok: boolean; email: string | null }> {
  if (!auth) return { ok: false, email: null };
  const u = await fetchCurto(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SRV, Authorization: auth },
  }, signal);
  if (!u.ok) return { ok: false, email: null };
  const email = String((await u.json()).email ?? "").toLowerCase();
  if (!email) return { ok: false, email: null };
  try {
    const r = await fetchCurto(`${SB_URL}/rest/v1/rpc/sou_admin`, {
      method: "POST",
      headers: {
        apikey: SB_SRV, Authorization: auth, "Content-Type": "application/json",
        "Content-Profile": "winecatalog", "Accept-Profile": "winecatalog",
      },
      body: "{}",
    }, signal);
    const d = r.ok ? await r.json() : null;
    return { ok: d === true, email };
  } catch (_) {
    return { ok: false, email };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...CORS, "Content-Type": "application/json" },
    });

  const authHeader = req.headers.get("Authorization") ?? "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SYNC_TIMEOUT_MS);
  let quem: string | null = null;
  let pidAberto: number | null = null;

  try {
    // O corpo lê-se antes da autorização só para se saber que linha de
    // trabalho fechar se o que vem a seguir ficar pendurado (ver o `catch`).
    const body = await req.json().catch(() => ({}) as any);
    const pid = typeof body?.pesquisaId === "number" ? body.pesquisaId : parseInt(String(body?.pesquisaId), 10);
    if (Number.isFinite(pid)) pidAberto = pid;

    const a = await admin(authHeader, ctrl.signal);
    quem = a.email;
    if (!a.ok) {
      await registar("erro", { passo: "autorizacao" }, quem);
      return json({ error: "só o admin do catálogo pode mandar pesquisar" }, 403);
    }

    if (!Number.isFinite(pid)) {
      await registar("erro", { passo: "pesquisaId" }, quem);
      return json({ error: "pesquisa inválida" }, 400);
    }
    // Só os campos que a app conhece, e só os que existem. Um nome de campo
    // inventado não pode chegar ao prompt nem ao `normalizar`.
    const campos = Array.isArray(body?.campos)
      ? [...new Set(body.campos.map((c: unknown) => String(c)).filter((c: string) => c in CAMPOS))]
      : null;
    // PESQUISA MANUAL: a resposta que o admin colou, já tirada do assistente
    // de IA que usou (Gemini, ChatGPT, o que for). Presente ou não é o que
    // decide se esta função chama a API ou só lê o que veio — ver o
    // comentário grande no `processarPesquisa`.
    const respostaManual = typeof body?.resposta === "string" && body.resposta.trim()
      ? body.resposta.trim().slice(0, 20_000)
      : null;
    // Por omissão a pesquisa é sobre o vinho em geral (ver a regra do
    // Vivino em `regraVivino`) — só estrita quando o ecrã de campos manda
    // isto explicitamente.
    const colheitaEspecifica = body?.colheitaEspecifica === true;
    // Pesquisa profunda: a pesquisa é nossa, pelo Serper (ver
    // `serperConsulta`). Só o admin chega aqui, por isso não há outra
    // verificação a fazer.
    const profunda = body?.profunda === true && respostaManual === null;
    // Rever antes de gravar (ver `processarPesquisa`): a app de agora manda
    // sempre; sem isto é a app antiga, que conta com a escrita pela força.
    const rever = body?.rever === true;
    /* `notas`/`sites`: contexto LIVRE (duas caixas de texto na app, não
       campos fechados) — ajuda a não confundir este vinho com um homónimo
       e a dar prioridade a fontes de confiança. Só entram no prompt
       automático — a manual gera o seu próprio texto do lado do browser. */
    const notas = texto(body?.notas, 300);
    // Um domínio fica só o domínio (sem "www.", sem caminho); um nome sem
    // domínio ("Garrafeira Nacional") fica como foi escrito — vai para o
    // prompt, mas não pode ir para uma consulta `site:` (ver `dominioDe`).
    const sites: string[] = Array.isArray(body?.sites)
      ? [...new Set(body.sites.map((s: unknown) => dominioDe(texto(s, 300)) || texto(s, 60)).filter(Boolean))].slice(0, 5) as string[]
      : [];
    // Os sites viram só o domínio (acima) — mas um link do Vivino de UM vinho
    // colado ali é a resposta, não uma fonte: guarda-se inteiro, antes de o
    // corte o reduzir a "www.vivino.com".
    const vivinoDado = Array.isArray(body?.sites)
      ? (body.sites as unknown[]).map((s) => vivinoLink(texto(s, 300))).find(Boolean) ?? ""
      : "";
    // E um link de uma PÁGINA de outro site abre-se e lê-se (ver "AS PÁGINAS
    // DOS SITES"); o domínio dela fica nos `sites`, como antes.
    const paginasDadas: string[] = Array.isArray(body?.sites)
      ? [...new Set((body.sites as unknown[]).map((s) => paginaDe(texto(s, 400))).filter(Boolean))].slice(0, 5)
      : [];
    // "Usar só a informação destes sites" — sem sites não quer dizer nada.
    const soSites = body?.soSites === true && respostaManual === null && sites.length > 0;

    // A linha tem de existir, estar por fazer e ser de quem está a pedir.
    // A autorização já passou (é o admin), mas isto trava o pedido repetido
    // e o pedido a uma linha de outra pessoa numa futura app a dois admins.
    const r = await fetchCurto(`${SB_URL}/rest/v1/pesquisas?id=eq.${pid}&select=id,vinho_id,quem,estado`, {
      headers: { apikey: SB_SRV, Authorization: "Bearer " + SB_SRV, "Accept-Profile": "winecatalog" },
    }, ctrl.signal);
    const row = r.ok ? (await r.json())?.[0] : null;
    if (!row) {
      await registar("erro", { passo: "pesquisa_nao_encontrada", pesquisaId: pid }, quem);
      return json({ error: "pesquisa não encontrada" }, 404);
    }
    if (row.estado !== "pendente") {
      return json({ estado: row.estado }, 200);
    }
    if (String(row.quem ?? "").toLowerCase() !== quem) {
      await registar("erro", { passo: "pesquisa_de_outro", pesquisaId: pid }, quem);
      return json({ error: "essa pesquisa não é tua" }, 403);
    }

    // NÃO faz await — a pesquisa Google pode demorar mais do que o browser
    // aguenta, e isto sobrevive ao pedido original terminar.
    EdgeRuntime.waitUntil(
      processarPesquisa(pid, Number(row.vinho_id), quem!, campos && campos.length ? campos as string[] : null, respostaManual, colheitaEspecifica, notas, sites, profunda, vivinoDado, rever, respostaManual === null ? paginasDadas : [], soSites),
    );
    return json({ estado: "pendente" }, 202);
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError" || err.name === "TimeoutError";
    await registar("erro", { passo: "excecao_inicial", erro: String(err.message).slice(0, 500) }, quem);
    // A linha de trabalho já existe (criada pela app antes de chamar isto):
    // deixada em 'pendente', bloqueava a pesquisa seguinte do mesmo vinho
    // durante minutos. Só num tecto de tempo nosso (nunca numa recusa), e só
    // se ainda estiver pendente, fecha-se já para se poder tentar outra vez.
    if (timeout && pidAberto != null) {
      try {
        await tabela(`pesquisas?id=eq.${pidAberto}&estado=eq.pendente`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ estado: "erro", erro: "o servidor demorou a responder — tenta outra vez", fechado_em: new Date().toISOString() }),
        });
      } catch (_) { /* fica para o prazo normal da `pesquisa_criar` */ }
    }
    return json({ error: timeout ? "o servidor demorou a responder — tenta outra vez" : err.message }, timeout ? 504 : 500);
  } finally {
    clearTimeout(timer);
  }
});
