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
// é quem é dono dele.
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
const SYNC_TIMEOUT_MS = 10_000;

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
const ESTAVEIS = ["gemini-flash-latest", "gemini-flash-lite-latest"];
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
  imagem_url: "imagemUrl", preco_medio: "precoMedio",
  beber_de: "beberDe", beber_ate: "beberAte", notas_prova: "notasProva",
  harmonizacao: "harmonizacao", ai_resumo: "resumo",
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
function normalizar(raw: any, campos: string[] | null): Record<string, unknown> {
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
    // Exige-se o domínio do Vivino, não basta ser um http qualquer: reduz o
    // risco de o link vir de uma loja por engano. Não chega para apanhar um
    // homónimo — isso é a regra 2 do prompt — mas apanha o resto.
    vivino_url: /^https?:\/\/([a-z0-9-]+\.)*vivino\.com\//i.test(String(raw.vivinoUrl ?? "").trim())
      ? texto(raw.vivinoUrl, 300) : "",
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
  // Pediram-se só alguns campos: o resto sai daqui mesmo que o modelo o
  // tenha mandado à mesma. Sem isto, pedir "só o preço" acabava a
  // reescrever a região com um palpite de passagem.
  if (campos && campos.length) {
    Object.keys(out).forEach((k) => { if (!campos.includes(k)) delete out[k]; });
  }
  return out;
}

type UsageMetadata = { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
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

/* Estimativa GROSSEIRA, como nas irmãs: os TOKENS são facto (vêm da API),
   o euro é um número redondo para dar ordem de grandeza. A pesquisa Google
   é faturada à parte, por pedido. Calibra pela fatura real no dia em que
   isto passar de curiosidade a orçamento. */
const CUSTO_PESQUISA_EUR = 0.01;

/* ── A REGRA DO VIVINO, e porque tem DUAS versões ──
   Espelho da mesma correção em `vinho-info.ts` (Garrafeira) — ver o
   comentário grande lá para o porquê e para o teste que a validou (Villa
   Platanus 2022: com o ano a fazer parte da identidade da página do
   Vivino, nota/avaliações/link vinham sempre vazios; sem essa exigência,
   vieram certos e estáveis em três tentativas seguidas). O Vivino é do
   VINHO, não da colheita — a nota que mostra por omissão é uma média entre
   colheitas.

   Duas versões, e quem escolhe é `colheitaEspecifica` (vem do ecrã de
   escolha de campos, nunca por omissão): a ESTRITA exige o ano, para
   quando a pergunta é mesmo sobre ESTA colheita; a RELAXADA (o novo
   default) não exige, e diz ao modelo onde ler cada número. */
const regraVivino = (colheitaEspecifica: boolean) => colheitaEspecifica
  ? `Vivino: "vivinoNota", "vivinoAvaliacoes" e "vivinoUrl" têm de vir da MESMA
   página do Vivino e do vinho certo — confirma produtor, ano e região antes
   de aceitar. Em dúvida, deixa os três vazios.`
  : `A página do Vivino é do VINHO, não de uma colheita específica: o ANO NÃO
   faz parte da identidade da página, e a nota que lá aparece é uma média
   entre colheitas. Para confirmares que é a página certa, basta o nome (já
   desambiguado na regra anterior) e o produtor baterem certo — não deixes
   "vivinoNota"/"vivinoAvaliacoes"/"vivinoUrl" vazios só por causa do ano. A
   nota é o número entre 1.0 e 5.0 ao lado das estrelas; as avaliações vêm
   logo a seguir, entre parêntesis — não uses números de outra zona da
   página. Mesmo sem confirmares a nota, mantém o link se tiveres a certeza
   da página.`;
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
  nome: string, produtor: string, ano: number | null, regiao: string, tipo: string, castas: string[],
  hoje: string, campos: string[] | null, colheitaEspecifica: boolean,
) => `
És um enólogo a preencher a ficha de um vinho para um catálogo de referência.
Usa PESQUISA WEB (grounding search) para confirmar os dados — não respondas de memória.

VINHO A IDENTIFICAR:
  Nome: ${nome}
${ano ? `  Ano (colheita): ${ano}\n` : ""}${produtor ? `  Produtor: ${produtor}\n` : ""}${regiao ? `  Região indicada: ${regiao}\n` : ""}${tipo ? `  Cor: ${tipo}\n` : ""}${castas.length ? `  Castas conhecidas: ${castas.join(", ")}\n` : ""}
Hoje é ${hoje}.
${campos && campos.length ? `
SÓ INTERESSAM ESTES CAMPOS: ${campos.map((k) => CAMPOS[k]).filter(Boolean).join(", ")}.
Concentra a pesquisa NELES e deixa os outros fora da resposta.
` : ""}
REGRAS:
1. NÃO INVENTES. Um campo que não confirmes fica FORA do JSON (ou null).
   Este catálogo é lido por outras aplicações — um palpite aqui propaga-se.
2. ${regraCuvee}
3. ${regraVivino(colheitaEspecifica)}
4. "imagemUrl" tem de ser link DIRETO de imagem (.jpg/.jpeg/.png/.webp/.avif),
   nunca o link da página.
5. Se houver dúvida de homónimo, prioriza ano + produtor + região e diz o que
   ficou por confirmar no "aviso".
6. Castas separadas por nome (nunca "blend"/"lote"/"várias castas").
7. "precoMedio" é o preço de RETALHO em euros, garrafa de 0,75 L.
8. "beberDe"/"beberAte" são anos.

Responde SÓ com este JSON, sem texto à volta e sem blocos de código:
{
  "encontrado": true,
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
  "vivinoNota": 4.1,
  "vivinoAvaliacoes": 1234,
  "vivinoUrl": "",
  "imagemUrl": "",
  "precoMedio": 18.5,
  "beberDe": 2026,
  "beberAte": 2034,
  "notasProva": "duas ou três frases sobre aroma, boca e final",
  "harmonizacao": "com que pratos",
  "resumo": "duas ou três frases sobre o vinho e o produtor",
  "aviso": "vazio, ou o que ficou por confirmar"
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
   fazia à resposta automática. */
async function processarPesquisa(
  pesquisaId: number, vinhoId: number, quem: string, campos: string[] | null,
  respostaManual: string | null = null, colheitaEspecifica: boolean = false,
  pistas: string[] = ["produtor", "ano", "regiao"],
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

    let parsed: any;
    let usage: UsageMetadata | null = null;
    let fontes: { titulo: string; url: string }[] = [];

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
      /* PISTAS: o que já se sabe do vinho, para ajudar a IA a não o
         confundir com um homónimo (produtor, ano, região, cor, castas) —
         a app só as manda quando quem procura as deixou marcadas
         (`wcPistas…`), e só entram no prompt quando o catálogo já as tem.
         Nunca são pedidas de volta só por virem daqui — isso é o que a
         lista `campos` decide. */
      const identProdutor = pistas.includes("produtor") ? antes.produtor : "";
      const identAno = pistas.includes("ano") ? antes.ano : null;
      const identRegiao = pistas.includes("regiao") ? String(antes.ficha.regiao ?? "") : "";
      const identTipo = pistas.includes("tipo") ? String(antes.ficha.tipo ?? "") : "";
      const identCastas = pistas.includes("castas") && Array.isArray(antes.ficha.castas)
        ? (antes.ficha.castas as unknown[]).map((c) => String(c)) : [];
      const texto0 = promptFicha(
        antes.nome, identProdutor, identAno, identRegiao, identTipo, identCastas,
        new Date().toISOString().slice(0, 10), campos, colheitaEspecifica,
      );

      /* O `google_search` está SEMPRE ligado — é a razão de esta função
         existir. Por isso NÃO há aqui variante com `thinkingBudget:0`: a API
         recusa as duas juntas com 400 ("Request contains an invalid
         argument"), e a pesquisa precisa mesmo de pensar para decidir o que
         pesquisar. Era a primeira variante tentada nas funções irmãs e só
         deitava fora uma ida ao Gemini de cada vez, sem nada no ecrã a
         dizê-lo. */
      const chamarGemini = (m: string) =>
        fetch(`${GAPI}/models/${m}:generateContent?key=${GEMINI_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: texto0 }] }],
            generationConfig: { temperature: 0 },
            tools: [{ google_search: {} }],
          }),
        });

      const transitorio = (st: number) => st === 429 || st === 500 || st === 503;
      const candidatos = await candidatosModelo(ctrl.signal);
      if (ctrl.signal.aborted) throw new DOMException("timeout", "AbortError");
      console.log("CATALOGO-INFO candidatos:", candidatos.join(", "));
      let g: Response | null = null;

      for (let ci = 0; ci < candidatos.length && !ctrl.signal.aborted; ci++) {
        model = candidatos[ci];
        g = await chamarGemini(model);
        console.log("CATALOGO-INFO tentativa:", model, "->", g.status);
        if (g.ok) break;
        if (g.status === 404) { _models = null; continue; }
        if (!transitorio(g.status)) break;
      }

      if (!g || !g.ok) {
        const status = g?.status ?? 502;
        const detail = g ? await g.text() : "";
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

      const gd = await g.json();
      usage = usageMetadata(gd);
      const bruto = (gd?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
      parsed = extrairJson(bruto);
      fontes = fontesGrounding(gd);
    }

    const ficha = normalizar(parsed, campos);
    const aviso = texto(parsed?.aviso, 300);
    // A pesquisa manual não tem forma de citar fontes de verdade (não há
    // `groundingMetadata` nenhum a colar aqui) — inventar uma era pior do
    // que não ter nenhuma.
    const chamadasGemini = respostaManual !== null ? 0 : 1;
    const custoEstimado = respostaManual !== null ? 0 : CUSTO_PESQUISA_EUR;

    if (!Object.keys(ficha).length) {
      await registar("ok", { passo: "sem_campos", modelo: model, vinho_id: vinhoId, campos: 0,
        ...(usage ? { usageMetadata: usage } : {}), chamadas_gemini: chamadasGemini,
        custo_estimado_eur: custoEstimado, manual: respostaManual !== null }, quem);
      await fechar(pesquisaId, {
        estado: "concluido",
        resultado: { modelo: model, campos: 0, aviso: aviso || null, propostas: [], fontes },
      });
      return;
    }

    // A escrita passa pela `juntar` como qualquer outra: é ela que decide,
    // campo a campo, se isto ganha ao que já lá estava. Uma pesquisa não
    // tem direito de passagem só por ter sido pedida à mão — e a manual
    // entra com a MESMA origem `catalogo-pesquisa` (força 3) da automática:
    // o que muda é como se chegou ao JSON, não a confiança que ele merece.
    await rpc("juntar", {
      p_nome: antes.nome, p_produtor: antes.produtor, p_ano: antes.ano,
      p_ficha: ficha, p_origem: "catalogo-pesquisa", p_fontes: fontes,
    }, undefined, ctrl.signal);

    /* E AGORA O QUE DÁ SENTIDO AO ECRÃ: dizer o que entrou e o que NÃO
       entrou, e porquê. Sem isto, o admin manda pesquisar, vê metade dos
       campos na mesma e fica sem saber se a pesquisa falhou ou se a base
       recusou — que são coisas muito diferentes. A recusa é o sistema a
       funcionar (alguém com a garrafa na mão sabe melhor), mas só se
       souber que aconteceu. */
    const depois = await lerVinho(vinhoId, ctrl.signal);
    const propostas = Object.keys(ficha).map((k) => {
      const origemDepois = String(depois?.origens?.[k]?.o ?? "");
      const entrou = origemDepois === "catalogo-pesquisa";
      return {
        campo: k,
        valor: ficha[k],
        entrou,
        // quem ganhou, quando não foi esta pesquisa
        ganhou: entrou ? null : (String(antes.origens?.[k]?.o ?? "") || null),
        forca: entrou ? null : Number(antes.origens?.[k]?.f ?? 0),
      };
    });
    const entraram = propostas.filter((p) => p.entrou).length;

    console.log("CATALOGO-INFO ok:", entraram, "de", propostas.length, "modelo:", model);
    await registar("ok", {
      modelo: model, vinho_id: vinhoId,
      campos: entraram, propostos: propostas.length,
      ...(usage ? { usageMetadata: usage } : {}),
      chamadas_gemini: chamadasGemini, custo_estimado_eur: custoEstimado,
      manual: respostaManual !== null,
    }, quem);
    await fechar(pesquisaId, {
      estado: "concluido",
      resultado: { modelo: model, campos: entraram, aviso: aviso || null, propostas, fontes },
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

/* Quem é, e se manda aqui. O `sou_admin()` corre com o JWT DA PESSOA (não
   com a service role): quem decide quem é o admin é a base, e é a mesma
   resposta que o ecrã usa para mostrar o botão. */
async function admin(auth: string, signal: AbortSignal): Promise<{ ok: boolean; email: string | null }> {
  if (!auth) return { ok: false, email: null };
  const u = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SRV, Authorization: auth }, signal,
  });
  if (!u.ok) return { ok: false, email: null };
  const email = String((await u.json()).email ?? "").toLowerCase();
  if (!email) return { ok: false, email: null };
  try {
    const d = await rpc("sou_admin", {}, auth, signal);
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

  try {
    const a = await admin(authHeader, ctrl.signal);
    quem = a.email;
    if (!a.ok) {
      await registar("erro", { passo: "autorizacao" }, quem);
      return json({ error: "só o admin do catálogo pode mandar pesquisar" }, 403);
    }

    const body = await req.json().catch(() => ({}) as any);
    const pid = typeof body?.pesquisaId === "number" ? body.pesquisaId : parseInt(String(body?.pesquisaId), 10);
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
    // PISTAS (produtor/ano/regiao/tipo/castas): o que a pessoa deixou
    // marcado no seletor como contexto para desambiguar o vinho. Só entram
    // no prompt automático — a manual gera o seu próprio texto do lado do
    // browser. Sem nada válido, cai no de sempre (produtor+ano+região).
    const PISTAS_VALIDAS = ["produtor", "ano", "regiao", "tipo", "castas"];
    const pistas = Array.isArray(body?.pistas)
      ? [...new Set(body.pistas.map((p: unknown) => String(p)).filter((p: string) => PISTAS_VALIDAS.includes(p)))] as string[]
      : ["produtor", "ano", "regiao"];

    // A linha tem de existir, estar por fazer e ser de quem está a pedir.
    // A autorização já passou (é o admin), mas isto trava o pedido repetido
    // e o pedido a uma linha de outra pessoa numa futura app a dois admins.
    const r = await tabela(`pesquisas?id=eq.${pid}&select=id,vinho_id,quem,estado`, { signal: ctrl.signal });
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
      processarPesquisa(pid, Number(row.vinho_id), quem!, campos && campos.length ? campos as string[] : null, respostaManual, colheitaEspecifica, pistas),
    );
    return json({ estado: "pendente" }, 202);
  } catch (e) {
    const err = e as Error;
    await registar("erro", { passo: "excecao_inicial", erro: String(err.message).slice(0, 500) }, quem);
    return json({ error: err.message }, 500);
  } finally {
    clearTimeout(timer);
  }
});
