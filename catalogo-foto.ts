// supabase/functions/catalogo-foto/index.ts
// WineCatalog — lê o RÓTULO de uma fotografia para pré-preencher o
// formulário "Vinho novo" (winecatalog.criar).
//
// NÃO ESCREVE NA BASE DE DADOS. Devolve só o que leu, para o admin rever e
// corrigir antes de criar a linha — a mesma cautela do "nada é gravado sem
// confirmação" que já vale para a pesquisa manual desta app e para a
// `vinho-info` da Garrafeira. Uma leitura de rótulo pode falhar (letra
// cortada, reflexo, homónimo) e um erro aqui não pode nascer direto no
// catálogo que as outras duas apps leem.
//
// PORQUE NÃO PESQUISA WEB, ao contrário da `catalogo-info`. Ler um rótulo é
// OCR/visão sobre uma fotografia — não é a mesma pergunta que pesquisar uma
// referência com grounding search. Sem `google_search`, a API aceita
// `responseMimeType:"application/json"` e não há texto à volta para extrair.
//
// SÓ O ADMIN DO CATÁLOGO. Mesma regra da `catalogo-info`: quem lê o
// catálogo é toda a gente aprovada; quem o manda mexer é quem é dono dele.
//
// A DESCOBERTA DE MODELO ESTÁ DUPLICADA de propósito da `catalogo-info.ts`
// (e das outras Edge Functions do projeto) — ver a "confissão" no
// CLAUDE.md, secção "A ficha de um vinho": cada Edge Function deste
// projeto é auto-contida. A regra que fica: mexer na escolha de modelo,
// nos parâmetros da chamada ou no tratamento de erros do Gemini AQUI pede
// o mesmo nas outras cinco no mesmo dia.
//
// Deploy: supabase functions deploy catalogo-foto

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GAPI = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 40_000;
const MAX_BASE64 = 2_400_000; // ~1.8MB de imagem — o rótulo já vem encolhido do browser

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* Mesma estratégia de descoberta das funções irmãs (ver `catalogo-info.ts`
   e a `importar-vinhos.ts` da Garrafeira): só PONTEIROS ("-latest"), nunca
   nomes de versão fixos — esses partiram-se assim que a Google reformou o
   catálogo de modelos ("no longer available to new users"). LITE primeiro:
   ler um rótulo é extração, não um problema que precise de um modelo maior. */
const ESTAVEIS = ["gemini-flash-lite-latest", "gemini-flash-latest"];
let _modelos: string[] | null = null;
async function candidatos(signal: AbortSignal): Promise<string[]> {
  if (_modelos) return _modelos;
  const vistos = new Set(ESTAVEIS);
  const lista = [...ESTAVEIS];
  try {
    const r = await fetch(`${GAPI}/models?pageSize=200&key=${GEMINI_KEY}`, { signal });
    if (r.ok) {
      const d = await r.json();
      (d.models ?? []).forEach((m: any) => {
        const nome = String(m.name).replace(/^models\//, "");
        if (!vistos.has(nome) && (m.supportedGenerationMethods ?? []).includes("generateContent")
            && nome.includes("flash")
            && !/(8b|image|tts|live|audio|embed|exp|preview|thinking|1\.5|2\.0|2\.5)/.test(nome)) {
          vistos.add(nome); lista.push(nome);
        }
      });
    }
  } catch (_) { /* fica só a base */ }
  _modelos = lista.slice(0, 4);
  return _modelos;
}

/* Só os campos que um RÓTULO pode mesmo mostrar — nunca a nota do Vivino,
   o preço de mercado ou notas de prova, que são coisas de uma pesquisa a
   sério (ver "Procurar informação"), não de uma fotografia. */
const TIPOS = ["Tinto", "Branco", "Rosé", "Espumante", "Licoroso", "Frisante"];
const ESTILOS = ["", "Maduro", "Verde", "Colheita Tardia", "Palhete"];
const MENCOES = ["", "Reserva", "Grande Reserva", "Garrafeira", "Colheita Selecionada",
  "Vinhas Velhas", "Superior", "Grande Escolha"];
const CLASSIF = ["", "DOC", "Vinho Regional", "Vinho"];

const texto = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
function numero(v: unknown, min: number, max: number, casas = 1): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return isFinite(n) && n >= min && n <= max ? Number(n.toFixed(casas)) : null;
}
function anoValido(v: unknown): number | null {
  const n = numero(v, 1900, 2100, 0);
  return n === null ? null : Math.round(n);
}
function daLista(v: unknown, lista: string[]): string {
  const t = texto(v, 40);
  return lista.find((x) => x && x.toLowerCase() === t.toLowerCase()) ?? "";
}
function extrairJson(s: string): any | null {
  const t = String(s ?? "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(t); } catch (_) { /* segue */ }
  const ini = t.indexOf("{");
  if (ini < 0) return null;
  let nivel = 0, emString = false, escape = false;
  for (let i = ini; i < t.length; i++) {
    const c = t[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { emString = !emString; continue; }
    if (emString) continue;
    if (c === "{") nivel++;
    else if (c === "}") {
      nivel--;
      if (nivel === 0) { try { return JSON.parse(t.slice(ini, i + 1)); } catch (_) { return null; } }
    }
  }
  return null;
}

const PROMPT = `Lê o RÓTULO de vinho nesta fotografia, como um enólogo a começar uma ficha de catálogo.

Só o que estiver REALMENTE ESCRITO no rótulo (ou visualmente óbvio, como a cor do vidro/vinho).
Não pesquisas nada, não completas de memória: um campo que não vejas fica FORA do JSON (ou
vazio). Um palpite aqui cria uma linha errada num catálogo que outras duas aplicações leem.

Responde SÓ com este JSON, sem texto à volta e sem blocos de código:
{
  "encontrado": true,
  "nome": "nome do vinho, sem o produtor nem a colheita",
  "produtor": "produtor/marca/quinta",
  "ano": 2019,
  "tipo": "vazio, ou um de: ${TIPOS.join(" | ")}",
  "estilo": "vazio, ou um de: ${ESTILOS.filter(Boolean).join(" | ")}",
  "regiao": "região vitivinícola, se estiver escrita",
  "subRegiao": "",
  "mencao": "vazio, ou um de: ${MENCOES.filter(Boolean).join(" | ")}",
  "classificacao": "vazio, ou um de: ${CLASSIF.filter(Boolean).join(" | ")}",
  "castas": ["só se estiverem escritas no rótulo"],
  "teor": 13.5,
  "aviso": "vazio, ou o que ficou por confirmar (rótulo cortado, letra ilegível, homónimo, etc.)"
}

Se esta fotografia não mostrar um rótulo de vinho legível, responde
{"encontrado": false, "aviso": "porquê"}.`;

async function admin(auth: string, signal: AbortSignal): Promise<{ ok: boolean; email: string | null }> {
  if (!auth) return { ok: false, email: null };
  const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_SRV, Authorization: auth }, signal });
  if (!u.ok) return { ok: false, email: null };
  const email = String((await u.json()).email ?? "").toLowerCase();
  if (!email) return { ok: false, email: null };
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/sou_admin`, {
      method: "POST",
      headers: { apikey: SB_SRV, Authorization: auth, "Content-Type": "application/json",
                 "Content-Profile": "winecatalog", "Accept-Profile": "winecatalog" },
      body: "{}", signal,
    });
    return { ok: r.ok && (await r.json()) === true, email };
  } catch (_) { return { ok: false, email }; }
}

async function registar(estado: string, detalhe: Record<string, unknown>, quem: string | null): Promise<void> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/sync_log`, {
      method: "POST",
      headers: { apikey: SB_SRV, Authorization: "Bearer " + SB_SRV, "Content-Type": "application/json",
                 "Content-Profile": "winecatalog", "Accept-Profile": "winecatalog", Prefer: "return=minimal" },
      body: JSON.stringify({ origem: "function", acao: "catalogo_foto", estado, quem, detalhe }),
    });
    if (!r.ok) console.log("CATALOGO-FOTO sync_log falhou:", r.status);
  } catch (e) {
    console.log("CATALOGO-FOTO sync_log erro:", String((e as Error).message).slice(0, 200));
  }
  await registarIaUso("catalogo-foto", estado, detalhe, quem);
}

/* Espelho em `ia_uso.registos` — schema à parte, no MESMO projeto Supabase,
   partilhado pelas cinco apps (ver CLAUDE.md "O registo central de acessos
   ao Gemini"). Mesmo `detalhe` de cima, com tokens/modelo/custo também em
   colunas. Nunca deita a chamada principal abaixo por isto falhar. */
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  const authHeader = req.headers.get("Authorization") ?? "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const inicio = Date.now();
  let quem: string | null = null;

  try {
    const a = await admin(authHeader, ctrl.signal);
    quem = a.email;
    if (!a.ok) {
      await registar("erro", { passo: "autorizacao" }, quem);
      return json({ error: "só o admin do catálogo pode ler rótulos" }, 403);
    }

    const body = await req.json().catch(() => ({}) as any);
    const mime = String(body?.imagem?.mime ?? "").toLowerCase();
    const data = String(body?.imagem?.data ?? "").replace(/\s/g, "");
    if (!/^image\/(jpeg|png|webp)$/.test(mime) || data.length < 100 || data.length > MAX_BASE64
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      return json({ error: "imagem inválida ou demasiado grande" }, 400);
    }

    const transitorio = (st: number) => st === 429 || st === 500 || st === 503;
    const listaModelos = await candidatos(ctrl.signal);
    let g: Response | null = null;
    let model = listaModelos[0];

    let gd: any = null;
    let bruto = "";
    let vazioMotivo = "";
    for (let i = 0; i < listaModelos.length && !ctrl.signal.aborted; i++) {
      model = listaModelos[i];
      g = await fetch(`${GAPI}/models/${model}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data } }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
      });
      /* Um 200 com o corpo VAZIO não é resposta — é o modelo a gastar o
         orçamento a pensar e a não escrever nada. Lê-se o corpo AQUI para
         se poder passar ao modelo seguinte; ler só depois do ciclo fazia
         desta avaria o fim da linha. Ver CLAUDE.md, "O 200 vazio". */
      if (g.ok) {
        gd = await g.json();
        const cand = gd?.candidates?.[0];
        vazioMotivo = String(cand?.finishReason ?? "") || "resposta vazia";
        bruto = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
        console.log("CATALOGO-FOTO resposta:", model, "finishReason:", vazioMotivo,
                    "texto:", bruto.length, "tokens saída:", gd?.usageMetadata?.candidatesTokenCount ?? 0);
        if (bruto) break;
        g = null;
        continue;
      }
      if (g.status === 404) { _modelos = null; continue; }
      if (!transitorio(g.status)) break;
    }

    if (g && !g.ok) {
      const status = g?.status ?? 502;
      const detail = g ? await g.text() : "";
      let msg = "";
      try { msg = JSON.parse(detail)?.error?.message ?? ""; } catch (_) { /**/ }
      await registar("erro", { status, modelo: model, erro: (msg || detail).slice(0, 400), ms: Date.now() - inicio }, quem);
      return json({
        error: transitorio(status)
          ? "o serviço está com muita procura agora — tenta outra vez"
          : `gemini ${status} (${model})${msg ? ": " + msg.slice(0, 200) : ""}`,
      }, 502);
    }

    /* Nenhum modelo escreveu uma letra. NÃO é "não consegui ler o rótulo" —
       é não ter havido resposta, e dizer a primeira escondia a avaria. */
    if (!bruto) {
      await registar("erro", {
        passo: "gemini_vazio", modelo: model, finishReason: vazioMotivo || null,
        ms: Date.now() - inicio,
        ...(gd?.usageMetadata ? { usageMetadata: gd.usageMetadata } : {}),
      }, quem);
      return json({
        error: `o modelo não devolveu resposta (${vazioMotivo || "vazia"}) — tenta outra vez`,
      }, 502);
    }

    const parsed = extrairJson(bruto);

    if (!parsed || parsed.encontrado === false) {
      const aviso = texto(parsed?.aviso, 300) || "não consegui ler um rótulo de vinho nesta foto";
      await registar("ok", {
        modelo: model, encontrado: false, ms: Date.now() - inicio,
        ...(gd?.usageMetadata ? { usageMetadata: gd.usageMetadata } : {}),
      }, quem);
      return json({ encontrado: false, aviso });
    }

    const castas = Array.isArray(parsed.castas)
      ? [...new Set(parsed.castas.map((c: unknown) => texto(c, 50)).filter(Boolean))].slice(0, 12)
      : [];
    const campos: Record<string, unknown> = {
      tipo: daLista(parsed.tipo, TIPOS),
      estilo: daLista(parsed.estilo, ESTILOS),
      regiao: texto(parsed.regiao, 60),
      sub_regiao: texto(parsed.subRegiao, 60),
      mencao: daLista(parsed.mencao, MENCOES),
      classificacao: daLista(parsed.classificacao, CLASSIF),
      castas,
      teor: numero(parsed.teor, 4, 25, 1),
    };
    Object.keys(campos).forEach((k) => {
      const v = campos[k];
      if (v === null || v === "" || (Array.isArray(v) && !v.length)) delete campos[k];
    });

    await registar("ok", {
      modelo: model, campos: Object.keys(campos).length, ms: Date.now() - inicio,
      ...(gd?.usageMetadata ? { usageMetadata: gd.usageMetadata } : {}),
    }, quem);
    return json({
      encontrado: true,
      nome: texto(parsed.nome, 160),
      produtor: texto(parsed.produtor, 90),
      ano: anoValido(parsed.ano),
      campos,
      aviso: texto(parsed.aviso, 300),
    });
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError";
    await registar("erro", { passo: timeout ? "timeout" : "excecao", erro: String(err.message).slice(0, 400), ms: Date.now() - inicio }, quem);
    return json({ error: timeout ? "demorou demasiado a ler a imagem — tenta outra vez" : err.message }, 500);
  } finally {
    clearTimeout(timer);
  }
});
