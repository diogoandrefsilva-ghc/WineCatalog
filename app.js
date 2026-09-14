/* ── SESSÃO SUPABASE (mesmo projeto das outras apps; schema `winecatalog`) ──
   Mesmo padrão do Goals/FestasBV/Garrafeira/WineSelection: sessão em
   localStorage, refresh automático do access token (expira em ~1h), e
   Accept/Content-Profile a escolher o schema — NUNCA no URL.

   Um schema só, `winecatalog`, mas com duas metades que se tratam de
   maneira diferente:
     · quem entra (allowed_users, access_requests) — REST normal, com RLS
       e policies por trás;
     · o CATÁLOGO (vinhos, alias, distintos) — SÓ por RPC, e só pelas
       funções SECURITY DEFINER: tem RLS com ZERO policies E nenhum GRANT
       a quem tem login, e é assim que fica. Ver db/catalogo.sql.

   A chave aqui em baixo é a `anon`, pública POR DESIGN (protegida por RLS
   + login). Não é bug nem risco — não a "corrijas" nem a escondas. */
const SB_URL='https://gjweqwfbnkgnibhajldc.supabase.co';
const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdqd2Vxd2ZibmtnbmliaGFqbGRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMDk4NzUsImV4cCI6MjA5NjY4NTg3NX0.h6st-RayGhQdsqH7E2Ko-rPWk2QZUpTevO6cbjvlSnk';

/* O DONO DA CONTA SUPABASE — fixo, e NÃO é a mesma coisa que o admin do
   catálogo. O admin passa (winecatalog.definir_admin); a conta não, porque
   continua a ser de quem a paga. Atrás disto fica só o que mexe na CONTA:
   a password temporária. Mesma distinção que a Garrafeira faz. */
const SUPABASE_DONO_EMAIL='diogo.andre.f.silva@gmail.com';
const SESSION_KEY='wc_sb_session';
let _sbSession=null;
/* Quem manda no catálogo vem da BD (winecatalog.sou_admin), nunca de uma
   constante aqui: a UI só decide que botões mostrar, quem DECIDE é sempre
   o servidor — todas as funções de escrita voltam a confirmar. */
let _souAdmin=false;
let _wcAdminEmail='';

function sbHeaders(extra={}){
  return Object.assign({
    'Content-Type':'application/json',
    'apikey':SB_KEY,
    'Authorization':`Bearer ${_sbSession?.access_token||SB_KEY}`,
    'Accept-Profile':'winecatalog',
    'Content-Profile':'winecatalog'
  },extra);
}
function sbSaveSession(s){
  _sbSession=s;
  localStorage.setItem(SESSION_KEY,JSON.stringify(s));
}
let _refreshing=null;
async function sbRefresh(){
  if(!_sbSession||!_sbSession.refresh_token)return false;
  if(_refreshing)return _refreshing;
  _refreshing=(async()=>{
    try{
      const r=await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`,{
        method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({refresh_token:_sbSession.refresh_token})
      });
      if(!r.ok)return false;
      const d=await r.json();
      sbSaveSession({
        access_token:d.access_token,
        refresh_token:d.refresh_token||_sbSession.refresh_token,
        expires_at:d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600),
        user:d.user||_sbSession.user
      });
      return true;
    }catch(e){return false;}
  })();
  const ok=await _refreshing;
  _refreshing=null;
  return ok;
}
function tokenQuaseExpirado(){
  if(!_sbSession)return false;
  if(!_sbSession.expires_at)return true;
  return (_sbSession.expires_at-Date.now()/1000)<120;
}
async function sbEnsureFresh(){
  if(_sbSession&&_sbSession.refresh_token&&tokenQuaseExpirado())await sbRefresh();
}
async function sbFetch(url,opt){
  await sbEnsureFresh();
  opt=opt||{};
  opt.headers=Object.assign({},opt.headers,{'Authorization':`Bearer ${_sbSession?.access_token||SB_KEY}`});
  let r=await fetch(url,opt);
  if(r.status===401&&_sbSession&&_sbSession.refresh_token){
    if(await sbRefresh()){
      opt.headers=Object.assign({},opt.headers,{'Authorization':`Bearer ${_sbSession.access_token}`});
      r=await fetch(url,opt);
    }
  }
  return r;
}
async function sbReq(method,path,body,extra){
  const opt={method,headers:sbHeaders(extra||{})};
  if(body!==undefined)opt.body=JSON.stringify(body);
  const r=await sbFetch(`${SB_URL}/rest/v1/${path}`,opt);
  if(!r.ok){let m='HTTP '+r.status;try{const j=await r.json();m=j.message||m;}catch(_){}throw new Error(m);}
  const tx=await r.text();
  return tx?JSON.parse(tx):null;
}

/* ── RPC AO CATÁLOGO ──────────────────────────
   Tudo o que esta app lê ou escreve no catálogo passa por aqui.

   Já não há troca de schema nenhuma: o catálogo mudou-se para o
   `winecatalog` (setembro de 2026, ver db/migracao-catalogo-para-winecatalog.sql)
   e por isso os headers são os mesmos do resto da app — o `sbHeaders()`
   seco. Isto era, até aí, a única coisa nesta app que falava com dois
   schemas. */
async function catRpc(fn,args){
  const r=await sbFetch(`${SB_URL}/rest/v1/rpc/${fn}`,{
    method:'POST',
    headers:sbHeaders(),
    body:JSON.stringify(args||{})
  });
  const tx=await r.text();
  if(!r.ok){
    let m='HTTP '+r.status;
    try{m=JSON.parse(tx).message||m;}catch(_){}
    /* A migração por correr é o erro mais provável no primeiro dia, e o
       "404 schema cache" não o diz a ninguém. */
    if(/does not exist|schema cache/i.test(m))
      m='Falta correr db/catalogo.sql no Supabase (ver db/README.md).';
    throw new Error(m);
  }
  return tx?JSON.parse(tx):null;
}

function isAdmin(){return !!_souAdmin;}
function souDono(){
  return !!(_sbSession&&_sbSession.user&&
    String(_sbSession.user.email||'').toLowerCase()===SUPABASE_DONO_EMAIL.toLowerCase());
}

/* ── ESCAPES ───────────────────────────────────
   `esc` para conteúdo, `escJs` para o que vai dentro de onclick="…('…')".
   Há vinhos com plica no nome ("Clefs D'or") e sem o segundo a app parte
   no vinho errado, em silêncio. */
function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escJs(s){
  return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\r?\n/g,' ');
}

/* ── TOAST ─────────────────────────────────── */
let _toastTimer=null;
function toast(msg,erro){
  const t=document.getElementById('toast');
  if(!t)return;
  t.textContent=msg;
  t.classList.toggle('erro',!!erro);
  t.classList.add('on');
  clearTimeout(_toastTimer);
  _toastTimer=setTimeout(()=>t.classList.remove('on'),3200);
}

/* ── MODAIS ────────────────────────────────────
   A app começou com um modal só (a ficha), aberto e fechado à mão. Agora
   são quatro e há dois empilhados (a ficha por baixo, o editar por cima),
   por isso vale um par de funções — mesmos nomes da Garrafeira, que é onde
   este desenho já existe. */
function abrirModal(id){const m=document.getElementById(id);if(m)m.classList.add('on');wcFabSincronizar();}
function fecharModal(id){const m=document.getElementById(id);if(m)m.classList.remove('on');wcFabSincronizar();}
/* Fechar pelo fundo escuro só quando se carrega MESMO no fundo — não num
   filho que por acaso deixou passar o clique. */
function fecharFundo(ev,id){if(ev&&ev.target&&ev.target.id===id)fecharModal(id);}

/* ── TABS ──────────────────────────────────── */
function itab(tab){
  document.querySelectorAll('#app-sec > .itabs > .it').forEach(b=>b.classList.toggle('on',b.dataset.tab===tab));
  document.querySelectorAll('#app-sec > .tp').forEach(p=>p.classList.remove('on'));
  const el=document.getElementById('t-'+tab);
  if(el)el.classList.add('on');
  try{localStorage.setItem('wc_tab',tab);}catch(e){}
  wcFabSincronizar();
  if(tab==='resumo')wcCarregarResumo();
  if(tab==='catalogo')wcCarregarCatalogo(true);
  if(tab==='duplicados')wcCarregarDuplicados();
  if(tab==='alertas')wcCarregarReportes('aberto');
}
function restaurarTab(){
  let tab=null;
  try{tab=localStorage.getItem('wc_tab');}catch(e){}
  if(!tab||!document.getElementById('t-'+tab))tab='resumo';
  /* O painel dos alertas existe no HTML para toda a gente (é o botão que
     está escondido), por isso quem deixou de ser admin voltava a cair nele
     e apanhava um "só o admin vê os alertas" à entrada. */
  if(tab==='alertas'&&!isAdmin())tab='resumo';
  itab(tab);
}

/* ── FORMATAÇÃO ────────────────────────────── */
function nFmt(n){
  if(n==null||n==='')return '—';
  const x=Number(n);
  if(!isFinite(x))return '—';
  return x.toLocaleString('pt-PT');
}
function eurFmt(n){
  const x=Number(n||0);
  if(!isFinite(x))return '0,00 €';
  return x.toLocaleString('pt-PT',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
}
function dataFmt(s){
  if(!s)return '—';
  const d=new Date(s);
  if(isNaN(d))return '—';
  return d.toLocaleDateString('pt-PT',{day:'2-digit',month:'short',year:'numeric'});
}
function haQuanto(s){
  if(!s)return '';
  const d=new Date(s);
  if(isNaN(d))return '';
  const dias=Math.floor((Date.now()-d.getTime())/86400000);
  if(dias<=0)return 'hoje';
  if(dias===1)return 'ontem';
  if(dias<30)return `há ${dias} dias`;
  if(dias<365){const m=Math.floor(dias/30);return `há ${m} ${m===1?'mês':'meses'}`;}
  const a=Math.floor(dias/365);
  return `há ${a} ${a===1?'ano':'anos'}`;
}

/* ── DE ONDE VEIO CADA CAMPO ───────────────────
   É o ponto do ecrã do catálogo, e a razão de esta app existir: `origens`
   guarda {campo:{o,f,em}} desde o primeiro dia e nunca ninguém o viu.
   Sem isto não há como responder à pergunta que decide se se confia num
   número — "de onde é que isto veio?".

   Os nomes das origens são os que a `winecatalog.forca()` conhece. Se lá
   aparecer um que não está aqui, mostra-se o nome cru em vez de inventar
   uma legenda: um campo sem explicação é melhor do que uma explicação
   errada. */
const WC_ORIGENS={
  'garrafeira':      {txt:'garrafeira (garrafa na mão)', cls:'og-forte'},
  'garrafeira-bruto':{txt:'garrafeira (escrito à pressa)', cls:'og-fraca'},
  'ws-verificacao':  {txt:'verificação com pesquisa Google', cls:'og-forte'},
  'ws-sugestao':     {txt:'sugestão da carta (com pesquisa)', cls:'og-media'},
  'vinho-info-premium':{txt:'procura da Garrafeira (grounding)', cls:'og-media'},
  'vinho-info-gratis': {txt:'procura da Garrafeira (pesquisa + extração)', cls:'og-media'}
};
/* A força entra na LEGENDA, e não é cosmética: `garrafeira` aparece a 3 e
   a 2, e são coisas diferentes. Quem tem a garrafa na mão sabe melhor do
   que ninguém o que está no RÓTULO (castas, cor, teor, região) — isso vale
   3. Mas a nota do Vivino e o preço ninguém os sabe por ter a garrafa na
   mão: leem-se num site, e quem os escreveu na sua garrafeira copiou de
   algum lado — valem 2, abaixo de uma pesquisa a sério. Chamar "garrafa na
   mão" às duas era apagar no ecrã exatamente a distinção que levou semanas
   a aparecer no SQL. */
function wcOrigemTxt(o,f){
  if(o==='garrafeira'&&Number(f)===2)return 'garrafeira (nota/preço copiados)';
  const d=WC_ORIGENS[o];
  return d?d.txt:(o||'(sem origem)');
}
function wcOrigemCls(o,f){
  if(o==='garrafeira'&&Number(f)===2)return 'og-media';
  const d=WC_ORIGENS[o];
  if(d)return d.cls;
  return Number(f)>=3?'og-forte':(Number(f)>=2?'og-media':'og-fraca');
}

/* Os campos da ficha por nome legível, e pela ordem por que fazem sentido
   ler um vinho. O que não estiver aqui aparece na mesma, com a chave crua
   — um campo novo numa das outras apps não pode desaparecer deste ecrã só
   porque ninguém veio cá acrescentá-lo à lista. */
const WC_CAMPOS=[
  ['tipo','Tipo'],['estilo','Estilo'],['mencao','Menção'],
  ['classificacao','Classificação'],['castas','Castas'],
  ['regiao','Região'],['sub_regiao','Sub-região'],['pais','País'],
  ['teor','Teor alcoólico'],['estagio_meses','Estágio (meses)'],
  ['estagio_texto','Estágio'],
  ['vivino_nota','Nota Vivino'],['vivino_avaliacoes','Avaliações Vivino'],
  ['vivino_url','Vivino'],['preco_medio','Preço de mercado'],
  ['beber_de','Beber de'],['beber_ate','Beber até'],
  ['notas_prova','Notas de prova'],['harmonizacao','Harmonização'],
  ['ai_resumo','Resumo'],['imagem_url','Imagem']
];
/* Nome do campo no JSON que se pede ao Gemini — a mesma tabela do `CAMPOS`
   em catalogo-info.ts. Só serve à PESQUISA MANUAL (`wcManualPrompt`), para
   escrever no prompt os nomes que o `normalizar()` do lado do servidor
   sabe ler; se um dia mudares os nomes lá, muda aqui no mesmo commit. */
const WC_CAMPOS_JSON={
  tipo:'tipo',estilo:'estilo',regiao:'regiao',sub_regiao:'subRegiao',pais:'pais',
  mencao:'mencao',classificacao:'classificacao',castas:'castas',teor:'teor',
  estagio_meses:'estagioMeses',estagio_texto:'estagioTexto',vivino_nota:'vivinoNota',
  vivino_avaliacoes:'vivinoAvaliacoes',vivino_url:'vivinoUrl',imagem_url:'imagemUrl',
  preco_medio:'precoMedio',beber_de:'beberDe',beber_ate:'beberAte',notas_prova:'notasProva',
  harmonizacao:'harmonizacao',ai_resumo:'resumo',
  /* O PRODUTOR não é campo da ficha — é IDENTIDADE (faz parte da `chave`) —
     mas continua a ser sempre uma das opções que se pode pedir à pesquisa,
     mesmo já preenchido: só pode vir DIFERENTE por engano de quem escreveu.
     O que a pesquisa devolve nunca escreve sozinho (ver `catalogo-info.ts`,
     `processarPesquisa`) — aparece à parte no resultado, para aplicar em
     Editar com o interruptor de identidade. */
  produtor:'produtorConfirmado'
};
/* Total de campos que se podem PEDIR à pesquisa — os da ficha (WC_CAMPOS)
   mais o Produtor, que não está lá por não ser campo de ficha. Usa-se para
   decidir quando "todos estão marcados" (e por isso não vale a pena escrever
   "SÓ INTERESSAM ESTES CAMPOS" no prompt manual). */
const WC_PROC_TOTAL=WC_CAMPOS.length+1;
/* Os que envelhecem (winecatalog.volatil). A lista está repetida do SQL de
   propósito e SÓ para efeitos de ECRÃ — quem decide se um campo expirou é
   sempre a BD, na `procurar`. Aqui serve só para pôr um aviso ao lado de
   um preço de há oito meses, que é coisa que quem olha quer saber. */
const WC_VOLATEIS=['vivino_nota','vivino_avaliacoes','vivino_url','preco_medio','imagem_url'];

function wcValorHTML(k,v){
  if(v==null)return '—';
  if(Array.isArray(v))return esc(v.join(', '));
  if(typeof v==='object')return esc(JSON.stringify(v));
  const s=String(v);
  if(/^https?:\/\//i.test(s))
    return `<a href="${esc(s)}" target="_blank" rel="noopener">${esc(s.replace(/^https?:\/\/(www\.)?/,'').slice(0,42))}…</a>`;
  if(k==='preco_medio')return esc(eurFmt(v));
  if(k==='teor')return esc(s)+' %';
  return esc(s);
}

/* ══════════════════════════════════════════════
   RESUMO — quanto é que isto está a poupar

   É a pergunta que deu origem ao catálogo e que não se via em lado
   nenhum. Duas metades: o que as outras duas apps gastaram (a vista
   `winecatalog.consumo`) e o que o catálogo tem lá dentro
   (`winecatalog.resumo`).
   ══════════════════════════════════════════════ */
let _wcDias=null;   // null = desde sempre

async function wcCarregarResumo(){
  const box=document.getElementById('resumo-box');
  if(!box)return;
  box.innerHTML='<div class="wc-card"><p class="wc-note">A carregar…</p></div>';
  try{
    const [consumo,cat]=await Promise.all([
      catRpc('consumo_resumo',{p_dias:_wcDias}),
      catRpc('resumo',{})
    ]);
    box.innerHTML=wcResumoHTML(consumo,cat);
  }catch(e){
    box.innerHTML=`<div class="wc-card"><p class="wc-note erro">${esc(e.message)}</p></div>`;
  }
}
function wcPeriodo(d){_wcDias=d;wcCarregarResumo();}

function wcResumoHTML(c,cat){
  const t=(c&&c.total)||{};
  const pedidos=Number(t.pedidos||0);
  const doCat=Number(t.pedidosCatalogo||0);
  const pct=pedidos?Math.round(doCat*100/pedidos):0;
  const periodos=[[null,'Sempre'],[30,'30 dias'],[90,'90 dias']];

  let h=`<div class="wc-card">
    <div class="per-row">
      ${periodos.map(([d,l])=>
        `<button class="per ${_wcDias===d?'on':''}" onclick="wcPeriodo(${d===null?'null':d})">${l}</button>`).join('')}
    </div>

    <div class="kpi-grid">
      <div class="kpi">
        <div class="kpi-n">${nFmt(doCat)}</div>
        <div class="kpi-l">pedidos servidos pelo catálogo</div>
        <div class="kpi-s">${pct}% de ${nFmt(pedidos)} — sem uma ida à IA</div>
      </div>
      <div class="kpi">
        <div class="kpi-n">${esc(eurFmt(t.custo))}</div>
        <div class="kpi-l">gasto estimado</div>
        <div class="kpi-s">${nFmt(t.tokens)} tokens</div>
      </div>
    </div>

    <div class="poupanca">
      <span class="poup-n">≈ ${esc(eurFmt(t.poupado))}</span> poupados
      <span class="poup-s">— os ${nFmt(doCat)} pedidos acima, ao custo médio de um que foi mesmo à IA</span>
    </div>

    <!-- Esta nota não é um detalhe legal: é a diferença entre um número em
         que se pode confiar e um que se está a inventar. -->
    <p class="wc-note aviso-euro">
      <strong>Os tokens são facto</strong> — vêm da API do Gemini.
      <strong>O euro é uma estimativa grosseira</strong>, não um preço publicado:
      sai de constantes escritas à mão nas Edge Functions, e a pesquisa Google é
      faturada <em>à parte, por pedido</em>. A poupança é uma estimativa em cima
      dessa — o número que é facto, e o que interessa ver a crescer, é a contagem
      de pedidos servidos sem IA nenhuma.
    </p>
  </div>`;

  /* Por ação, e com a UNIDADE à frente: campos, notas e vinhos não são a
     mesma coisa e somá-los era inventar um número. */
  const pa=(c&&c.porAcao)||[];
  h+=`<div class="wc-card">
    <h3>Por app</h3>
    <p class="wc-note">Cada linha conta na sua unidade — campos, notas e vinhos não se somam uns aos outros.</p>
    ${pa.length?`<div class="tbl">
      <div class="tbl-h"><span>Ação</span><span>Pedidos</span><span>Do catálogo</span><span>Da IA</span><span>Custo</span></div>
      ${pa.map(a=>`<div class="tbl-r">
        <span class="tb-acao"><strong>${esc(a.acao)}</strong><em>${esc(a.app)}</em></span>
        <span>${nFmt(a.pedidos)}${Number(a.erros)?` <span class="erro-n" title="pedidos com erro">(${nFmt(a.erros)} erro)</span>`:''}</span>
        <span class="tb-cat">${nFmt(a.itensCatalogo)} <em>${esc(a.unidade)}</em></span>
        <span>${nFmt(a.itensIA)} <em>${esc(a.unidade)}</em></span>
        <span>${esc(eurFmt(a.custo))}</span>
      </div>`).join('')}
    </div>`:'<p class="wc-note">Ainda não há registos.</p>'}
  </div>`;

  /* A última chamada de cada app. Um log limpo numa app que NÃO CORRE não
     é saúde, é desuso — foi assim que a WineSelection ficou semanas com
     duas avarias que a Garrafeira já tinha corrigido, e ninguém deu por
     nada. Esta linha existe para isso se ver. */
  const u=(c&&c.ultima)||[];
  if(u.length){
    h+=`<div class="wc-card">
      <h3>Sinal de vida</h3>
      <p class="wc-note">A última vez que cada app chamou a IA. Uma app calada há muito tempo não está bem — está parada, e uma avaria dela não aparece em log nenhum.</p>
      ${u.map(x=>{
        const d=new Date(x.quando);
        const dias=isNaN(d)?999:Math.floor((Date.now()-d.getTime())/86400000);
        return `<div class="vida ${dias>30?'fria':''}">
          <span>${esc(x.app)} <em>${esc(x.acao)}</em></span>
          <span>${esc(haQuanto(x.quando))} <em>${esc(dataFmt(x.quando))}</em></span>
        </div>`;
      }).join('')}
    </div>`;
  }

  /* O tamanho do catálogo, e de onde veio cada campo. */
  if(cat){
    const og=(cat.origens||[]).slice().sort((a,b)=>(b.forca-a.forca)||(b.campos-a.campos));
    const totalC=Number(cat.campos||0);
    h+=`<div class="wc-card">
      <h3>O catálogo</h3>
      <div class="mini-grid">
        <div><strong>${nFmt(cat.linhas)}</strong><span>linhas</span></div>
        <div><strong>${nFmt(cat.distintos)}</strong><span>vinhos distintos</span></div>
        <div><strong>${nFmt(cat.campos)}</strong><span>campos</span></div>
        <div><strong>${esc(String(cat.mediaCampos??'—'))}</strong><span>média por linha</span></div>
      </div>
      <p class="wc-note" style="margin-top:12px">
        ${Number(cat.semAno)?`${nFmt(cat.semAno)} linhas sem colheita · `:''}
        ${nFmt(cat.volateisVelhos)} campos voláteis com mais de 30 dias (nota e preço, que as apps voltam a pedir à IA)
        ${Number(cat.fusoes)?` · ${nFmt(cat.fusoes)} fusões feitas`:''}
        ${Number(cat.distintosMarcados)?` · ${nFmt(cat.distintosMarcados)} pares marcados como distintos`:''}
      </p>

      <div class="divi"></div>
      <div class="wc-card-label">De onde vieram os campos</div>
      <p class="wc-note">
        É aqui que se vê se as pesquisas a sério já estão a entrar, ou se está
        tudo a ser escrito à mão. Durante semanas <em>todos</em> os campos
        estavam a força 3, vindos de garrafeiras — e nenhuma pesquisa conseguia
        entrar, porque 3 tapa 2.
      </p>
      ${og.length?og.map(o=>{
        const pc=totalC?Math.round(o.campos*100/totalC):0;
        return `<div class="og-row">
          <div class="og-top">
            <span class="og-nome ${wcOrigemCls(o.origem,o.forca)}">${esc(wcOrigemTxt(o.origem,o.forca))}</span>
            <span class="og-n">${nFmt(o.campos)} <em>força ${esc(String(o.forca))}</em></span>
          </div>
          <div class="og-bar"><i class="${wcOrigemCls(o.origem,o.forca)}" style="width:${pc}%"></i></div>
        </div>`;
      }).join(''):'<p class="wc-note">Catálogo vazio.</p>'}
    </div>`;
  }
  return h;
}

/* ══════════════════════════════════════════════
   CATÁLOGO — ver e procurar o que já se sabe

   O primeiro ecrã que alguma vez mostrou uma linha do catálogo.
   ══════════════════════════════════════════════ */
let _wcProcura='';
let _wcSaltar=0;
let _wcTotal=0;
let _wcTimer=null;
let _wcLinhas=[];

/* ── A CAMADA DE FILTROS ──

   Os filtros vão INTEIROS ao SQL a cada pedido, e não se aplicam aqui no
   browser: a lista é paginada (50 de cada vez), e filtrar do lado de cá
   filtrava só a página que por acaso já tinha vindo — o utilizador via
   "3 tintos do Douro" quando havia trinta.

   As CONTAGENS que cada cartão mostra vêm do mesmo pedido (`facetas`), e
   são contadas com os OUTROS grupos aplicados mas não o próprio: é o que
   faz "Branco 7" continuar a aparecer quando já se escolheu Tinto. */
const WC_FAIXAS=[['<15','menos de 15 €'],['15-30','15 – 30 €'],['30-60','30 – 60 €'],['60+','60 € ou mais']];
const WC_GRUPOS=[['tipos','Tipo'],['regioes','Região'],['castas','Castas'],['precos','Preço médio']];
let _wcFiltros={tipos:[],regioes:[],castas:[],precos:[]};
let _wcFacetas=null;
let _wcPainel=true;
let _wcModo='lista';
/* Só as castas têm duas leituras possíveis: escolher Touriga Nacional e
   Syrah pode querer dizer "qualquer um dos dois" (o costume, e o que
   estava) ou "os lotes que levam as duas". Um vinho tem UM tipo e UMA
   região — ali a pergunta não se põe, e por isso o visto não aparece. */
let _wcCastasTodas=false;
try{
  _wcPainel=localStorage.getItem('wc_painel')!=='0';
  _wcModo=localStorage.getItem('wc_modo')==='grelha'?'grelha':'lista';
  _wcCastasTodas=localStorage.getItem('wc_castas_todas')==='1';
}catch(e){}

function wcNFiltros(){
  return _wcFiltros.tipos.length+_wcFiltros.regioes.length+
         _wcFiltros.castas.length+_wcFiltros.precos.length+(_wcProcura?1:0);
}
function wcFiltrosAtivos(){
  const faixa=id=>(WC_FAIXAS.find(f=>f[0]===id)||[id,id])[1];
  /* Com o painel fechado esta barra é a única coisa que diz o que está
     ligado — e "Touriga Nacional · Syrah" mente sobre metade dos
     resultados quando o visto está em "todas em simultâneo". */
  const cas=(_wcCastasTodas&&_wcFiltros.castas.length>1)
    ? [_wcFiltros.castas.join(' + ')] : _wcFiltros.castas;
  const l=[].concat(_wcFiltros.tipos,_wcFiltros.regioes,cas,
                    _wcFiltros.precos.map(faixa));
  if(_wcProcura)l.unshift('“'+_wcProcura+'”');
  return l;
}
function wcArg(g){return _wcFiltros[g].length?_wcFiltros[g]:null;}

/* O invólucro só se reescreve quando o painel abre ou fecha — a caixa de
   procura não pode ser reposta a cada tecla, ou perde-se o cursor. O que
   se repinta a cada pedido são as contagens (`wcPintarGrupos`). */
function wcShellFiltros(){
  const el=document.getElementById('cat-filtros');
  if(!el)return;
  const n=wcNFiltros();
  /* "+ Vinho novo" mudou-se daqui para o FAB (ver `wcFabAcao`) — ganhou
     companhia ("Atualizar informação") e não fazia sentido um botão de
     texto ao lado de um "+" flutuante a fazer a mesma coisa. */
  if(!_wcPainel){
    el.innerHTML=`<button class="cf-min" onclick="wcAlternarPainel()">
      <span class="cf-min-tx">🔍 ${n?esc(wcFiltrosAtivos().join(' · ')):'Procurar e filtrar'}</span>
      <span class="cf-min-lado"><span class="cf-n${n?' on':''}">${n}</span><span class="cf-seta">▼</span></span>
    </button>`;
    return;
  }
  el.innerHTML=`<div class="wc-card cf">
    <div class="cf-cab">
      <div class="wc-card-label" style="margin:0">Filtrar</div>
      <button class="cf-min-btn" onclick="wcAlternarPainel()">Minimizar ▲</button>
    </div>
    <div class="cf-procura">
      <span>🔍</span>
      <input type="text" id="cat-procura" value="${esc(_wcProcura)}"
             placeholder="nome, produtor, região ou casta…"
             oninput="wcProcuraMudou()" autocomplete="off">
    </div>
    <div id="cat-grupos"></div>
    <div class="cf-fim">
      <span class="wc-note" id="cat-conta" style="margin:0"></span>
      <span class="cf-fim-b">
        <button class="cf-limpar" onclick="wcLimparFiltros()">Limpar filtros</button>
      </span>
    </div>
  </div>`;
  wcPintarGrupos();
}

function wcPintarGrupos(){
  const el=document.getElementById('cat-grupos');
  if(!el)return;
  const f=_wcFacetas||{};
  el.innerHTML=WC_GRUPOS.map(([g,titulo])=>{
    let ops=(f[g]||[]).slice();
    /* Uma opção escolhida nunca desaparece da lista, mesmo que as facetas
       já não a devolvam — senão não havia como a desmarcar. */
    _wcFiltros[g].forEach(v=>{if(!ops.some(o=>o.v===v))ops.push({v,n:0});});
    if(g==='precos')ops.sort((a,b)=>WC_FAIXAS.findIndex(x=>x[0]===a.v)-WC_FAIXAS.findIndex(x=>x[0]===b.v));
    if(!ops.length)return '';
    const visto=g!=='castas'?`<div class="cf-tit">${esc(titulo)}</div>`:
      `<div class="cf-tit-l">
         <div class="cf-tit">${esc(titulo)}</div>
         <button class="cf-modo${_wcCastasTodas?' on':''}" onclick="wcCastasModo()"
                 title="${_wcCastasTodas
                   ?'A mostrar só os vinhos que levam TODAS as castas escolhidas'
                   :'A mostrar os vinhos que levam QUALQUER UMA das castas escolhidas'}">
           <i class="cf-visto">✓</i> todas em simultâneo
         </button>
       </div>`;
    return `<div class="cf-grupo">
      ${visto}
      <div class="cf-ops">${ops.map(o=>{
        const on=_wcFiltros[g].includes(o.v);
        const lbl=g==='precos'?(WC_FAIXAS.find(x=>x[0]===o.v)||[o.v,o.v])[1]:o.v;
        const cor=g==='tipos'?(WC_VIDRO[o.v]||'#8a7a7d'):null;
        return `<button class="cf-op${on?' on':''}" onclick="wcFiltroToggle('${escJs(g)}','${escJs(o.v)}')">
          <span class="cf-op-tx">${cor?`<i class="cf-ponto" style="background:${esc(cor)}"></i>`:''}${esc(lbl)}</span>
          <span class="cf-conta">${nFmt(o.n)}</span>
        </button>`;
      }).join('')}</div>
    </div>`;
  }).join('');
}

function wcFiltroToggle(g,v){
  const l=_wcFiltros[g];
  const i=l.indexOf(v);
  if(i<0)l.push(v);else l.splice(i,1);
  wcPintarGrupos();
  wcCarregarCatalogo(true);
}
/* Trocar de regra sem castas escolhidas não muda lista nenhuma, mas o
   estado grava-se à mesma: quem liga o visto antes de escolher espera
   que ele lá esteja quando escolher. */
function wcCastasModo(){
  _wcCastasTodas=!_wcCastasTodas;
  try{localStorage.setItem('wc_castas_todas',_wcCastasTodas?'1':'0');}catch(e){}
  wcPintarGrupos();
  if(_wcFiltros.castas.length>1)wcCarregarCatalogo(true);
}
function wcLimparFiltros(){
  _wcFiltros={tipos:[],regioes:[],castas:[],precos:[]};
  _wcProcura='';
  /* "Limpar filtros" tem de devolver o ecrã ao estado de partida: um visto
     que sobrevivesse à limpeza era uma regra escondida a filtrar por baixo
     na próxima escolha. */
  _wcCastasTodas=false;
  try{localStorage.setItem('wc_castas_todas','0');}catch(e){}
  const c=document.getElementById('cat-procura');
  if(c)c.value='';
  wcPintarGrupos();
  wcCarregarCatalogo(true);
}
function wcAlternarPainel(){
  _wcPainel=!_wcPainel;
  try{localStorage.setItem('wc_painel',_wcPainel?'1':'0');}catch(e){}
  wcShellFiltros();
  wcPintarBarra();
}
function wcVerModo(m){
  _wcModo=m;
  try{localStorage.setItem('wc_modo',m);}catch(e){}
  wcPintarLista();
  wcPintarBarra();
}

function wcPintarBarra(){
  const el=document.getElementById('cat-barra');
  if(!el)return;
  const bt=(m,txt)=>`<button class="cm${_wcModo===m?' on':''}" onclick="wcVerModo('${m}')">${txt}</button>`;
  el.innerHTML=`<div class="cat-barra">
    <span class="cat-barra-n"><strong>${nFmt(_wcTotal)}</strong> ${_wcTotal===1?'vinho':'vinhos'}</span>
    <span class="cat-modo">${bt('lista','☰ Lista')}${bt('grelha','▦ Grelha')}</span>
  </div>`;
}

function wcProcuraMudou(){
  clearTimeout(_wcTimer);
  _wcTimer=setTimeout(()=>{
    const v=(document.getElementById('cat-procura')||{}).value||'';
    if(v.trim()===_wcProcura)return;
    _wcProcura=v.trim();
    wcCarregarCatalogo(true);
  },280);
}

async function wcCarregarCatalogo(reset){
  const lista=document.getElementById('cat-lista');
  const mais=document.getElementById('cat-mais');
  if(!lista)return;
  const painel=document.getElementById('cat-filtros');
  if(painel&&!painel.innerHTML)wcShellFiltros();
  if(reset){_wcSaltar=0;_wcLinhas=[];lista.innerHTML='<div class="wc-card"><p class="wc-note">A carregar…</p></div>';}
  if(mais)mais.innerHTML='';
  try{
    const d=await catRpc('listar',{
      p_procura:_wcProcura||null,p_limite:50,p_saltar:_wcSaltar,
      p_tipos:wcArg('tipos'),p_regioes:wcArg('regioes'),
      p_castas:wcArg('castas'),p_castas_todas:_wcCastasTodas,
      p_precos:wcArg('precos')
    });
    const linhas=(d&&d.linhas)||[];
    _wcTotal=Number((d&&d.total)||0);
    _wcFacetas=(d&&d.facetas)||null;
    _wcLinhas=reset?linhas:_wcLinhas.concat(linhas);
    wcPintarGrupos();
    wcPintarBarra();
    wcPintarLista();
    const conta=document.getElementById('cat-conta');
    if(conta)conta.textContent=_wcTotal
      ? `${nFmt(_wcTotal)} ${_wcTotal===1?'vinho':'vinhos'}${_wcProcura?' encontrados':' no catálogo'}`
      : '';
    const vistos=_wcSaltar+linhas.length;
    if(mais&&vistos<_wcTotal){
      mais.innerHTML=`<button class="btn-n larg" onclick="wcMais()">Mostrar mais (${nFmt(_wcTotal-vistos)})</button>`;
    }
  }catch(e){
    lista.innerHTML=`<div class="wc-card"><p class="wc-note erro">${esc(e.message)}</p></div>`;
  }
}
function wcMais(){_wcSaltar+=50;wcCarregarCatalogo(false);}

function wcPintarLista(){
  const lista=document.getElementById('cat-lista');
  if(!lista)return;
  if(!_wcLinhas.length){
    lista.innerHTML=`<div class="wc-card"><p class="wc-note">${
      wcNFiltros()?'Nenhum vinho com estes filtros.':'O catálogo está vazio.'}</p></div>`;
    return;
  }
  lista.innerHTML=_wcModo==='grelha'
    ? `<div class="cat-grelha">${_wcLinhas.map(wcCartaoHTML).join('')}</div>`
    : _wcLinhas.map(wcLinhaHTML).join('');
}

/* A garrafa da linha: a FOTOGRAFIA quando o catálogo já a tem, e a mesma
   garrafa desenhada da ficha quando não tem — nunca um quadrado vazio. A
   cor do desenho sai do `tipo`, que é o que o `resumo_linha` já devolve. */
function wcMiniGarrafa(v,cls){
  const img=String(v.imagem||'').trim();
  return `<div class="${cls}">${wcGarrafaSVG(v.tipo,v.ano)}${
    img?`<img src="${esc(img)}" alt="" loading="lazy" onerror="this.remove()">`:''}</div>`;
}
function wcPrecoTxt(p){
  const n=Number(p);
  return (p==null||isNaN(n))?'':eurFmt(n);
}

/* O que fica na linha: a garrafa, quem é o vinho, e os dois números por
   que se escolhe um — a nota e o preço. O número de campos e a bola da
   força saíram daqui de propósito: são sobre a QUALIDADE DO REGISTO, não
   sobre o vinho, e essa conversa é da ficha (secção "Proveniência"). */
function wcLinhaHTML(v){
  const sub=[v.produtor,v.regiao].filter(Boolean).join(' · ');
  const castas=Array.isArray(v.castas)?v.castas.join(', '):'';
  const cor=WC_VIDRO[v.tipo]||'#8a7a7d';
  const preco=wcPrecoTxt(v.preco);
  return `<div class="cat-row" onclick="wcVerFicha(${v.id})">
    ${wcMiniGarrafa(v,'cat-g')}
    <div class="cat-main">
      <div class="cat-nome">${esc(v.nome||'(sem nome)')}${v.ano?` <span class="cat-ano">${esc(String(v.ano))}</span>`:''}</div>
      <div class="cat-sub">${v.tipo?`<i class="cf-ponto" style="background:${esc(cor)}"></i>`:''}${esc(sub||'—')}</div>
      ${castas?`<div class="cat-castas">${esc(castas)}</div>`:''}
    </div>
    <div class="cat-lado">
      ${v.nota!=null?`<span class="cat-nota">★ ${esc(String(v.nota))}</span>`:''}
      ${preco?`<span class="cat-preco">${esc(preco)}</span>`:''}
    </div>
  </div>`;
}

function wcCartaoHTML(v){
  const sub=[v.produtor,v.regiao].filter(Boolean).join(' · ');
  const preco=wcPrecoTxt(v.preco);
  return `<div class="cat-cartao" onclick="wcVerFicha(${v.id})">
    ${wcMiniGarrafa(v,'cat-g gr')}
    <div class="cat-nome">${esc(v.nome||'(sem nome)')}</div>
    <div class="cat-sub">${esc(sub||'—')}${v.ano?' · '+esc(String(v.ano)):''}</div>
    <div class="cat-cartao-n">
      ${v.nota!=null?`<span class="cat-nota">★ ${esc(String(v.nota))}</span>`:''}
      ${preco?`<span class="cat-preco">${esc(preco)}</span>`:''}
    </div>
  </div>`;
}

/* ══════════════════════════════════════════════
   A FICHA DE UM VINHO

   O desenho é o da Garrafeira, de propósito: a mesma capa bordô com a
   garrafa, os mesmos crachás, as mesmas secções com filete, os mesmos dois
   botões. Quem anda nas duas apps não tem de aprender dois ecrãs para a
   mesma coisa — e a diferença que interessa é a que fica por baixo, não a
   moldura.

   O QUE É DIFERENTE, E TEM DE SER: cada campo diz DE ONDE VEIO e COM QUE
   FORÇA. Na Garrafeira isso não faz sentido (a ficha é de quem a escreveu);
   aqui é a razão de a app existir. Por isso a linha da ficha é a mesma
   linha de duas colunas da Garrafeira, com a proveniência por baixo do
   valor em vez de nada.

   O que NÃO veio de lá: o cabeçalho que encolhe ao rolar (`modal.pagina`,
   `pgCabecalho`). São umas boas duzentas linhas de CSS e de JS presas ao
   scroll para resolver um problema que aqui não existe — lá a ficha é uma
   PÁGINA cheia de garrafas, prateleiras e consumos; aqui cabe quase sempre
   num ecrã. Copiá-lo era trazer a manutenção sem o problema.
   ══════════════════════════════════════════════ */

/* A garrafa desenhada, igualzinha à da Garrafeira (mesmo SVG, mesmas cores
   de vidro) — é o que dá a mesma cara às duas apps quando não há
   fotografia. Aqui a cor sai da FICHA e não de uma coluna, que é onde o
   `tipo` vive neste schema. */
const WC_VIDRO={Tinto:'#5e1226',Branco:'#8b9a45','Rosé':'#cd7d95',
  Espumante:'#3a5140',Licoroso:'#7b4213',Frisante:'#7d9b6e'};
function wcGarrafaSVG(tipo,ano){
  const c=WC_VIDRO[tipo]||WC_VIDRO.Tinto;
  const cap=(tipo==='Espumante'||tipo==='Licoroso')?'#a9832f':'#33202a';
  return `<svg viewBox="0 0 40 74" aria-hidden="true" focusable="false">
    <rect x="14.5" y="1" width="11" height="8" rx="2" fill="${cap}"/>
    <path d="M15.5 4h9v11.5q0 3.5 4.6 7Q33 27 33 34.5V64q0 6-6 6H13q-6 0-6-6V34.5q0-7.5 3.9-12Q15.5 19 15.5 15.5z" fill="${c}"/>
    <rect x="17" y="6" width="2.4" height="12" rx="1.2" fill="#fff" opacity=".22"/>
    <rect x="9.5" y="43" width="21" height="17" rx="2" fill="#f8f2e6"/>
    <rect x="9.5" y="43" width="21" height="3" fill="${c}" opacity=".6"/>
    <text x="20" y="56" text-anchor="middle" font-family="Playfair Display,Georgia,serif" font-size="9.5"
      fill="#4e1228">${esc(ano||'')}</text>
  </svg>`;
}

/* A janela de consumo em palavras, como na Garrafeira. Mesma ideia, menos
   máquina: lá o crachá enche-se conforme a posição dentro da janela, e isso
   vive preso a uma variável CSS que não vale a pena trazer para aqui. */
function wcJanelaTxt(de,ate){
  const a=new Date().getFullYear();
  if(!de&&!ate)return '';
  if(de&&a<de)return 'Ainda cedo';
  if(ate&&a>ate)return 'Já passou o ponto';
  return 'No ponto';
}

let _wcFicha=null;     // a linha aberta — usada pelo Editar e pelo Procurar

async function wcVerFicha(id){
  const m=document.getElementById('modal-ficha');
  const corpo=document.getElementById('ficha-corpo');
  if(!m)return;
  corpo.innerHTML='<div class="fi-espera"><p class="wc-note">A carregar…</p></div>';
  m.classList.add('on');
  wcFabSincronizar();   // a ficha não passa pelo `abrirModal`, mas tapa o FAB na mesma
  try{
    const v=await catRpc('ver',{p_id:id});
    if(!v){_wcFicha=null;corpo.innerHTML='<p class="wc-note">Essa linha já não existe.</p>';return;}
    _wcFicha=v;
    corpo.innerHTML=wcFichaHTML(v);
  }catch(e){
    _wcFicha=null;
    corpo.innerHTML=`<p class="wc-note erro">${esc(e.message)}</p>`;
  }
}
/* Depois de editar ou de pesquisar, o ecrã tem de mostrar o que ficou lá —
   não o que estava quando abriu. */
async function wcRefrescarFicha(){
  if(_wcFicha&&_wcFicha.id)await wcVerFicha(_wcFicha.id);
}
function wcFecharFicha(ev){
  if(ev&&ev.target&&ev.target.id!=='modal-ficha')return;
  const m=document.getElementById('modal-ficha');
  if(m)m.classList.remove('on');
  wcFabSincronizar();
  wcProcPararPolling();
}

function wcLinhaFicha(k,lbl,ficha,origens){
  const o=origens[k]||{};
  const f=Number(o.f||0);
  const velho=WC_VOLATEIS.includes(k)&&o.em&&
    (Date.now()-new Date(o.em).getTime())>30*86400000;
  return `<div class="fi-campo">
    <div class="fi-k">${esc(lbl)}</div>
    <div class="fi-c">
      <div class="fi-v">${wcValorHTML(k,ficha[k])}${
        velho?' <span class="fi-velho" title="campo volátil com mais de 30 dias — as apps voltam a pedi-lo à IA">envelhecido</span>':''}</div>
    </div>
  </div>`;
}

/* ── PROVENIÊNCIA ──

   De onde veio cada campo continua a ser a razão de a app existir, mas
   deixou de estar POR BAIXO DE CADA VALOR: era uma etiqueta, uma bola e
   uma data a repetir-se dezanove vezes, e o vinho desaparecia debaixo do
   registo. Agora é uma secção no fim — três números que se leem de
   relance, e o campo a campo por baixo de um botão para quem o quer. */
let _wcProvAberta=false;
try{_wcProvAberta=localStorage.getItem('wc_prov')==='1';}catch(e){}

function wcAlternarProv(){
  _wcProvAberta=!_wcProvAberta;
  try{localStorage.setItem('wc_prov',_wcProvAberta?'1':'0');}catch(e){}
  const d=document.getElementById('pv-det');
  const b=document.getElementById('pv-btn');
  if(d)d.style.display=_wcProvAberta?'block':'none';
  if(b)b.innerHTML=`<span>${_wcProvAberta?'Esconder campo a campo':'Ver campo a campo'}</span><span>${_wcProvAberta?'▲':'▼'}</span>`;
}

function wcProvenienciaHTML(v){
  const ficha=v.ficha||{};
  const origens=v.origens||{};
  const nome={};
  WC_CAMPOS.forEach(([k,l])=>{nome[k]=l;});
  const chaves=WC_CAMPOS.map(([k])=>k).filter(k=>k in origens)
    .concat(Object.keys(origens).filter(k=>!WC_CAMPOS.some(([c])=>c===k)));
  if(!chaves.length)return '';

  let forte=0,media=0,fraca=0;
  chaves.forEach(k=>{
    const f=Number((origens[k]||{}).f||0);
    if(f>=3)forte++;else if(f===2)media++;else fraca++;
  });

  const linhas=chaves.map(k=>{
    const o=origens[k]||{};
    const f=Number(o.f||0);
    const velho=WC_VOLATEIS.includes(k)&&o.em&&
      (Date.now()-new Date(o.em).getTime())>30*86400000;
    return `<div class="pv-linha">
      <span class="pv-campo">${esc(nome[k]||k)}</span>
      <span class="og-tag ${wcOrigemCls(o.o,f)}">${esc(wcOrigemTxt(o.o,f))}</span>
      <span class="forca f${esc(String(f))}">${esc(String(f))}</span>
      <span class="pv-em">${esc(dataFmt(o.em))}${velho?' <b>envelhecido</b>':''}</span>
    </div>`;
  }).join('');

  return `<div class="msec">Proveniência</div>
  <p class="wc-note">Cada campo diz <strong>de onde veio</strong> e <strong>com que força</strong>. É a força que decide quem ganha quando duas leituras discordam — e é ela que impede um número copiado à pressa de tapar uma pesquisa que se pagou.</p>
  <div class="pv-grid">
    <div class="pv-n forte"><strong>${nFmt(forte)}</strong><span>pesquisa ou rótulo</span></div>
    <div class="pv-n media"><strong>${nFmt(media)}</strong><span>copiados na garrafeira</span></div>
    <div class="pv-n fraca"><strong>${nFmt(fraca)}</strong><span>palpite</span></div>
  </div>
  <button class="pv-btn" id="pv-btn" onclick="wcAlternarProv()">
    <span>${_wcProvAberta?'Esconder campo a campo':'Ver campo a campo'}</span><span>${_wcProvAberta?'▲':'▼'}</span>
  </button>
  <div class="pv-det" id="pv-det" style="display:${_wcProvAberta?'block':'none'}">${linhas}</div>`;
}

function wcFichaHTML(v){
  const ficha=v.ficha||{};
  const origens=v.origens||{};
  const tipo=String(ficha.tipo||'');
  const castas=Array.isArray(ficha.castas)?ficha.castas:[];
  const img=String(ficha.imagem_url||'').trim();
  const origem=[v.produtor,ficha.regiao,ficha.sub_regiao].filter(Boolean).map(esc).join(' · ');
  const jan=wcJanelaTxt(ficha.beber_de,ficha.beber_ate);
  const nota=ficha.vivino_nota;

  let h=`<div class="mhero">
    <button class="mx" onclick="wcFecharFicha()" aria-label="Fechar">✕</button>
    <div class="mhero-in">
      <div class="mhero-g">
        ${wcGarrafaSVG(tipo,v.ano)}${img?`<img src="${esc(img)}" alt="" onerror="this.remove()">`:''}
      </div>
      <div class="mhero-tx">
        <div class="mhero-k">${esc([tipo,ficha.estilo,ficha.classificacao].filter(Boolean).join(' · '))||'&nbsp;'}</div>
        <h3>${esc(v.nome||'(sem nome)')}</h3>
        <div class="mhero-s"><span class="mhero-o">${origem||'<em>sem produtor nem região</em>'}${origem&&v.ano?' · ':''}</span>${v.ano?`<b>${esc(String(v.ano))}</b>`:''}</div>
        ${nota!=null?`<span class="mhero-n">★ ${esc(Number(nota).toFixed(2))} Vivino${ficha.vivino_avaliacoes?` · ${esc(nFmt(ficha.vivino_avaliacoes))}`:''}</span>`:''}
        ${jan?`<span class="mhero-n">${esc(jan)}</span>`:''}
      </div>
    </div>
  </div>

  <div class="vc-badges">
    ${ficha.mencao?`<span class="bdg men">${esc(ficha.mencao)}</span>`:''}
    ${castas.map(c=>`<span class="bdg cas">🍇 ${esc(c)}</span>`).join('')}
  </div>`;

  /* Os dois botões da Garrafeira, com o mesmo aspeto e a mesma ordem. Só
     para o admin: pesquisar gasta, e editar escreve numa tabela que as
     outras duas apps leem — quem lê o catálogo é toda a gente aprovada,
     quem o manda mexer é quem é dono dele. */
  if(isAdmin()){
    h+=`<div class="macoes">
      <button class="btn-prim auto" onclick="wcAbrirProcurar()">🔎 Procurar informação</button>
      <button class="btn-n" onclick="wcAbrirEditar()">✏️ Editar</button>
    </div>`;
  }
  h+=`<div id="proc-caixa"></div>`;

  /* ── A FICHA ── */
  const conhecidos=WC_CAMPOS.filter(([k])=>k in ficha);
  const extra=Object.keys(ficha).filter(k=>!WC_CAMPOS.some(([c])=>c===k)).map(k=>[k,k]);
  const todos=conhecidos.concat(extra);

  h+='<div class="msec">Ficha</div>';
  if(!todos.length){
    h+='<p class="wc-note">Esta linha ainda não tem campo nenhum — só a identidade.'+
       (isAdmin()?' Manda pesquisar ou preenche-a à mão.':'')+'</p>';
  }else{
    h+=`<div class="fi-campos">`;
    for(const [k,lbl] of todos)h+=wcLinhaFicha(k,lbl,ficha,origens);
    h+='</div>';
  }

  if(ficha.ai_resumo){
    h+=`<div class="msec">O que se sabe</div>
      <div class="wc-note" style="font-size:12.5px">${esc(ficha.ai_resumo)}</div>`;
  }

  const fontes=v.fontes||[];
  if(fontes.length){
    h+=`<div class="msec">Fontes</div>
    <div class="fi-fontes">${fontes.map(f=>
      `<a href="${esc(f.url||'#')}" target="_blank" rel="noopener">${esc(f.titulo||f.url||'fonte')}</a>`).join('')}</div>`;
  }

  h+=wcProvenienciaHTML(v);

  h+=`<div class="msec">Identidade</div>
  <p class="wc-note">
    É isto que decide se dois vinhos são o mesmo vinho. A chave vive
    <strong>só no SQL</strong> (<code>winecatalog.chave</code>) — nenhuma app a
    calcula, de propósito: duas cópias um dia divergem e o catálogo parte-se em
    dois em silêncio.
  </p>
  <div class="fi-chaves">
    <div><span>chave</span><code>${esc(v.chave||'')}</code></div>
    <div><span>sem ano</span><code>${esc(v.chaveBase||'')}</code></div>
    <div><span>só o nome</span><code>${esc(v.chaveNome||'— (o nome sozinho não distingue nada)')}</code></div>
  </div>
  <p class="wc-note" style="margin-top:8px">
    Escrita ${nFmt(v.vezes)}×, última vez que respondeu a uma pergunta ${esc(haQuanto(v.vistoEm))}
    · atualizada ${esc(dataFmt(v.atualizadoEm))}
  </p>`;

  /* Se esta linha é o resultado de fusões, quem a abre tem direito a
     saber — e a desfazê-las. */
  const al=v.aliases||[];
  if(al.length){
    h+=`<div class="msec">Linhas fundidas nesta</div>`;
    h+=al.map(a=>`<div class="fi-alias">
      <div>
        <strong>${esc(a.nome||a.chaveDe)}</strong>${a.ano?` <span class="cat-ano">${esc(String(a.ano))}</span>`:''}
        <div class="wc-note">${esc(a.campos)} campos passaram · ${esc(dataFmt(a.quando))}${a.quem?' · '+esc(a.quem):''}</div>
      </div>
      ${isAdmin()?`<button class="btn-n" onclick="wcSeparar('${escJs(a.chaveDe)}',${v.id})">Desfazer</button>`:''}
    </div>`).join('');
  }

  h+=`<div class="macoes fim"><button class="btn-n larg" onclick="wcFecharFicha()">Fechar</button></div>`;
  return h;
}


/* ══════════════════════════════════════════════
   EDITAR — a correção à mão

   A força 4 do `catalogo-admin` é o que faz este botão valer alguma coisa
   (ver `winecatalog.forca`): a 3 empatava com a garrafeira e a escrita
   seguinte de qualquer pessoa desfazia a correção em silêncio.

   DUAS COISAS QUE O ECRÃ TEM DE DIZER, e diz:
   · apagar um campo NÃO o fixa — deixa-o livre para a próxima escrita o
     voltar a preencher, com o mesmo valor errado se ele vier de uma
     garrafeira que o tem escrito. Para fixar, corrige-se;
   · a nota do Vivino e o preço ficam a 3 e não a 4, porque ninguém os sabe
     por ser admin. Uma pesquisa a sério fresca ainda os há de actualizar.
   ══════════════════════════════════════════════ */
const WC_TIPOS=['','Tinto','Branco','Rosé','Espumante','Licoroso','Frisante'];
const WC_ESTILOS=['','Maduro','Verde','Colheita Tardia','Palhete'];
const WC_MENCOES=['','Reserva','Grande Reserva','Garrafeira','Colheita Selecionada',
  'Vinhas Velhas','Superior','Grande Escolha'];
const WC_CLASSIF=['','DOC','Vinho Regional','Vinho'];

/* [chave, rótulo, tipo de campo, opções]. A ORDEM é a de `WC_CAMPOS` (a
   ordem por que faz sentido ler um vinho) e não a do alfabeto. */
const WC_EDIT=[
  ['tipo','Tipo','sel',WC_TIPOS],
  ['estilo','Estilo','sel',WC_ESTILOS],
  ['mencao','Menção','sel',WC_MENCOES],
  ['classificacao','Classificação','sel',WC_CLASSIF],
  ['castas','Castas','lista'],
  ['regiao','Região','txt'],
  ['sub_regiao','Sub-região','txt'],
  ['pais','País','txt'],
  ['teor','Teor alcoólico (%)','num'],
  ['estagio_meses','Estágio (meses)','int'],
  ['estagio_texto','Estágio','txt'],
  ['vivino_nota','Nota Vivino (0-5)','num'],
  ['vivino_avaliacoes','Avaliações Vivino','int'],
  ['vivino_url','URL do Vivino','txt'],
  ['preco_medio','Preço de mercado (€)','num'],
  ['imagem_url','Imagem (URL direto)','txt'],
  ['beber_de','Beber de (ano)','int'],
  ['beber_ate','Beber até (ano)','int'],
  ['notas_prova','Notas de prova','area'],
  ['harmonizacao','Harmonização','area'],
  ['ai_resumo','Resumo','area']
];

function wcValorEdit(k,v){
  if(v==null)return '';
  if(Array.isArray(v))return v.join(', ');
  return String(v);
}
/* Um campo de "Editar" (rótulo/nota/etc.) — partilhado com "Vinho novo"
   (`wcAbrirNovo`), que é o mesmo formulário a começar vazio em vez de a
   partir do que já lá está. O `prefixo` dos ids é o que separa os dois
   modais no DOM (`ed-`/`nv-`) sem duplicar este bloco. */
function wcCampoEditHTML(prefixo,k,lbl,tp,ops,val,marca){
  let h=`<div class="ed-campo">
    <label for="${prefixo}${esc(k)}">${esc(lbl)}${marca||''}</label>`;
  if(tp==='sel'){
    h+=`<select id="${prefixo}${esc(k)}">${ops.map(op=>
      `<option value="${esc(op)}"${String(val)===op?' selected':''}>${esc(op||'— vazio —')}</option>`).join('')}</select>`;
  }else if(tp==='area'){
    h+=`<textarea id="${prefixo}${esc(k)}" rows="3">${esc(val)}</textarea>`;
  }else{
    const ph=tp==='lista'?'separadas por vírgula':'';
    h+=`<input type="text" id="${prefixo}${esc(k)}" value="${esc(val)}" placeholder="${esc(ph)}"
           inputmode="${tp==='num'||tp==='int'?'decimal':'text'}">`;
  }
  h+='</div>';
  return h;
}
function wcCamposEditHTML(prefixo,ficha,origens){
  ficha=ficha||{};origens=origens||{};
  return WC_EDIT.map(([k,lbl,tp,ops])=>{
    const o=origens[k]||{}, f=Number(o.f||0);
    const val=wcValorEdit(k,ficha[k]);
    const marca=(k in ficha)
      ? `<span class="ed-de"><span class="og-tag ${wcOrigemCls(o.o,f)}">${esc(wcOrigemTxt(o.o,f))}</span><span class="forca f${esc(String(f))}">${esc(String(f))}</span></span>`
      : '';
    return wcCampoEditHTML(prefixo,k,lbl,tp,ops,val,marca);
  }).join('');
}
/* O que vai para a base a partir de um formulário destes: `null` quando o
   campo ficou vazio (a `editar`/`criar` leem isso como "não escrevas nada"
   ou "apaga", conforme o caso) e o valor com o TIPO certo quando não. Um
   número guardado como texto quebrava a comparação da Garrafeira (13.5 vs.
   "13.5") — ver o comentário grande onde isto vivia antes de ganhar um
   `prefixo`. */
function wcLerCampos(prefixo){
  const out={};
  for(const [k,,tp] of WC_EDIT){
    const el=document.getElementById(prefixo+k);
    if(!el)continue;
    const cru=String(el.value||'').trim();
    if(cru===''){out[k]=null;continue;}
    if(tp==='lista'){
      const l=cru.split(',').map(x=>x.trim()).filter(Boolean);
      out[k]=l.length?l:null;
    }else if(tp==='num'||tp==='int'){
      const n=parseFloat(cru.replace(',','.'));
      if(!isFinite(n)){out[k]=null;continue;}
      out[k]=tp==='int'?Math.round(n):n;
    }else out[k]=cru;
  }
  return out;
}
function wcAbrirEditar(){
  if(!_wcFicha||!isAdmin())return;
  const v=_wcFicha, ficha=v.ficha||{}, origens=v.origens||{};
  const box=document.getElementById('editar-corpo');
  if(!box)return;
  let h=`<p class="wc-note">O que corrigires aqui fica com <strong>força 4</strong> nos campos de
    rótulo (castas, cor, teor, região) — ninguém lhes passa por cima. A <strong>nota do Vivino,
    o preço e a imagem</strong> ficam a 3: ninguém os sabe por ser admin do catálogo, e uma
    pesquisa a sério fresca ainda os deve poder actualizar.</p>
  <p class="wc-note"><strong>Esvaziar um campo apaga-o</strong> — e apagar não o fixa: fica livre
    para a próxima escrita de qualquer garrafeira o voltar a preencher. Para travar um valor
    errado, corrige-o em vez de o apagares.</p>
  <div class="divi"></div>
  ${wcCamposEditHTML('ed-',ficha,origens)}`;

  /* A identidade fica atrás de um interruptor, e não por timidez: mexer no
     nome muda a CHAVE, que é o que faz duas linhas serem a mesma. Aberto
     por omissão, um engano de dedo aqui partia um vinho em dois. */
  h+=`<div class="divi"></div>
  <label class="ed-check"><input type="checkbox" id="ed-ident" onchange="wcEdIdent()">
    Mexer na identidade (nome, produtor, colheita)</label>
  <p class="wc-note">Isto muda a <strong>chave</strong> — o que faz duas linhas serem o mesmo
    vinho. Se a chave nova já for de outra linha, a base recusa e manda-te juntá-las em
    Duplicados, que é reversível.</p>
  <div id="ed-ident-box" class="ed-oculto">
    <div class="ed-campo"><label for="ed-nome">Nome</label>
      <input type="text" id="ed-nome" value="${esc(v.nome||'')}"></div>
    <div class="ed-campo"><label for="ed-produtor">Produtor</label>
      <input type="text" id="ed-produtor" value="${esc(v.produtor||'')}"></div>
    <div class="ed-campo"><label for="ed-ano">Colheita (vazio = sem colheita)</label>
      <input type="text" id="ed-ano" inputmode="numeric" value="${esc(v.ano==null?'':String(v.ano))}"></div>
  </div>
  <div class="macoes fim">
    <button class="btn-n" onclick="fecharModal('modal-editar')">Cancelar</button>
    <button class="btn-prim auto" id="ed-guardar" onclick="wcGuardarEdicao()">Guardar</button>
  </div>`;
  box.innerHTML=h;
  document.getElementById('editar-titulo').textContent=v.nome||'(sem nome)';
  abrirModal('modal-editar');
}
function wcEdIdent(){
  const on=document.getElementById('ed-ident').checked;
  document.getElementById('ed-ident-box').classList.toggle('ed-oculto',!on);
}

async function wcGuardarEdicao(){
  if(!_wcFicha)return;
  const b=document.getElementById('ed-guardar');
  const ident=!!(document.getElementById('ed-ident')||{}).checked;
  const args={p_id:_wcFicha.id,p_campos:wcLerCampos('ed-')};
  if(ident){
    const ano=String((document.getElementById('ed-ano')||{}).value||'').trim();
    args.p_nome=String((document.getElementById('ed-nome')||{}).value||'').trim();
    args.p_produtor=String((document.getElementById('ed-produtor')||{}).value||'').trim();
    args.p_ano=ano===''?null:(parseInt(ano,10)||null);
    args.p_mexer_identidade=true;
  }
  if(b){b.disabled=true;b.textContent='A guardar…';}
  try{
    const r=await catRpc('editar',args);
    const n=(r&&r.campos)||0, ap=(r&&r.apagados)||0;
    toast(n+ap?`Guardado ✓ ${n} corrigidos${ap?`, ${ap} apagados`:''}`:'Nada mudou');
    fecharModal('modal-editar');
    await wcRefrescarFicha();
    wcCarregarCatalogo(true);
  }catch(e){
    toast('Erro: '+e.message,1);
    if(b){b.disabled=false;b.textContent='Guardar';}
  }
}


/* ══════════════════════════════════════════════
   VINHO NOVO — um vinho que ninguém tem, do zero

   A outra metade do §4.4 do documento de arranque (ver o CLAUDE.md, "O que
   falta"): a `catalogo-info` já sabia pesquisar UMA linha que já existe;
   isto é o que faz essa linha nascer. Só a identidade é obrigatória — o
   resto é o MESMO formulário do "Editar" (`wcCamposEditHTML`), a começar
   vazio, porque um vinho novo pode já vir com o que se leu no rótulo ou o
   que o admin já sabe de cor. O que faltar fica para "Procurar informação"
   tratar a seguir, assim que a ficha abrir.

   DUAS PORTAS PARA O MESMO FORMULÁRIO: escrever à mão, ou carregar uma
   fotografia do rótulo (`wcNovoFoto`) que o PRÉ-preenche — nunca escreve
   sozinha. A leitura é só visão (a Edge Function `catalogo-foto` nunca
   pesquisa a internet, só lê o que está impresso), por isso só entra o que
   um rótulo pode mesmo mostrar: cor, castas, região, teor, menção — nunca
   a nota do Vivino nem o preço, que são coisa de pesquisa a sério.
   ══════════════════════════════════════════════ */
const FN_CATALOGO_FOTO=SB_URL+'/functions/v1/catalogo-foto';

function wcAbrirNovo(){
  if(!isAdmin())return;
  const box=document.getElementById('novo-corpo');
  if(!box)return;
  box.innerHTML=`<p class="wc-note">Só o <strong>nome</strong> é obrigatório. O resto fica para
      <strong>Procurar informação</strong> tratar a seguir — ou preenche à mão o que já souberes,
      por exemplo lido no rótulo.</p>
    <div class="ed-campo"><label for="nv-nome">Nome *</label>
      <input type="text" id="nv-nome" placeholder="ex.: Quinta do Crasto Reserva"></div>
    <div class="ed-campo"><label for="nv-produtor">Produtor</label>
      <input type="text" id="nv-produtor"></div>
    <div class="ed-campo"><label for="nv-ano">Colheita (ano, vazio se não tiver)</label>
      <input type="text" id="nv-ano" inputmode="numeric"></div>

    <div class="divi"></div>
    <p class="wc-note">Duas portas para encher o resto — com o nome (e produtor/ano, se
      souberes) já dá para as duas.</p>
    <label class="btn-n larg" style="text-align:center;cursor:pointer;display:block">
      📷 Ler o rótulo de uma fotografia
      <input type="file" accept="image/*" id="nv-foto" style="display:none" onchange="wcNovoFoto(this)">
    </label>
    <p class="wc-note" id="nv-foto-status"></p>
    <button class="btn-n larg" id="nv-procurar" onclick="wcNovoProcurar()">🔎 Procurar informação</button>

    <div class="divi"></div>
    ${wcCamposEditHTML('nv-',{},{})}

    <div class="macoes fim">
      <button class="btn-n" onclick="fecharModal('modal-novo')">Cancelar</button>
      <button class="btn-prim auto" id="nv-criar" onclick="wcCriarVinho()">Criar vinho</button>
    </div>`;
  abrirModal('modal-novo');
  const nomeEl=document.getElementById('nv-nome');
  if(nomeEl)nomeEl.focus();
}

/* Reduz a foto no browser antes de enviar — o mesmo truque da Garrafeira
   (`encolherImagem`): o rótulo lê-se perfeitamente a 1000px no lado maior,
   e uma foto de telemóvel são vários MB que não vale a pena mandar
   inteiros. `imageOrientation:'from-image'` trata do EXIF, senão uma foto
   tirada na vertical chegava deitada à Edge Function. */
function wcEncolherImagem(file){
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file);
    const acabou=(img)=>{
      const lado=Math.max(img.width,img.height);
      const escala=lado>1000?1000/lado:1;
      const w=Math.max(1,Math.round(img.width*escala)), h=Math.max(1,Math.round(img.height*escala));
      const c=document.createElement('canvas');
      c.width=w;c.height=h;
      c.getContext('2d').drawImage(img,0,0,w,h);
      URL.revokeObjectURL(url);
      c.toBlob(blob=>{
        if(!blob){reject(new Error('não consegui preparar a imagem'));return;}
        const fr=new FileReader();
        fr.onload=()=>resolve(String(fr.result).split(',')[1]||'');
        fr.onerror=()=>reject(new Error('não consegui ler a imagem'));
        fr.readAsDataURL(blob);
      },'image/jpeg',0.85);
    };
    if('createImageBitmap' in window){
      createImageBitmap(file,{imageOrientation:'from-image'}).then(acabou).catch(()=>{
        const img=new Image();
        img.onload=()=>acabou(img);
        img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('não consegui abrir essa imagem'));};
        img.src=url;
      });
    }else{
      const img=new Image();
      img.onload=()=>acabou(img);
      img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('não consegui abrir essa imagem'));};
      img.src=url;
    }
  });
}

async function wcNovoFoto(input){
  const file=input.files&&input.files[0];
  if(!file)return;
  const status=document.getElementById('nv-foto-status');
  if(status){status.textContent='A ler o rótulo…';status.classList.remove('erro');}
  try{
    const data=await wcEncolherImagem(file);
    const r=await fetch(FN_CATALOGO_FOTO,{
      method:'POST',
      headers:{'Content-Type':'application/json',apikey:SB_KEY,
               Authorization:'Bearer '+(_sbSession&&_sbSession.access_token)},
      body:JSON.stringify({imagem:{mime:'image/jpeg',data}})
    });
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||('a função respondeu '+r.status));
    if(d.encontrado===false){
      if(status){status.textContent=d.aviso||'Não consegui ler um rótulo nesta foto.';status.classList.add('erro');}
      return;
    }
    if(d.nome)document.getElementById('nv-nome').value=d.nome;
    if(d.produtor)document.getElementById('nv-produtor').value=d.produtor;
    if(d.ano)document.getElementById('nv-ano').value=String(d.ano);
    const campos=d.campos||{};
    for(const [k,,tp] of WC_EDIT){
      if(!(k in campos))continue;
      const el=document.getElementById('nv-'+k);
      if(!el)continue;
      el.value=(tp==='lista'&&Array.isArray(campos[k]))?campos[k].join(', '):String(campos[k]);
    }
    if(status)status.textContent=d.aviso?('Lido do rótulo — '+d.aviso):'Lido do rótulo ✓ — confirma os campos antes de criar.';
  }catch(e){
    if(status){status.textContent='Erro: '+e.message;status.classList.add('erro');}
  }finally{
    input.value='';
  }
}

/* Nome/produtor/ano lidos uma vez só — partilhado entre "Criar vinho" e
   "Procurar informação" (`wcNovoProcurar`), que também precisa da
   identidade para poder criar a linha antes de mandar pesquisar. */
function wcNovoIdentidade(){
  const nome=String((document.getElementById('nv-nome')||{}).value||'').trim();
  const produtor=String((document.getElementById('nv-produtor')||{}).value||'').trim();
  const anoTxt=String((document.getElementById('nv-ano')||{}).value||'').trim();
  const ano=anoTxt===''?null:(parseInt(anoTxt,10)||null);
  return {nome,produtor,ano};
}
async function wcCriarVinho(){
  if(!isAdmin())return;
  const {nome,produtor,ano}=wcNovoIdentidade();
  if(!nome){toast('Falta o nome.',1);return;}
  const b=document.getElementById('nv-criar');
  if(b){b.disabled=true;b.textContent='A criar…';}
  try{
    const r=await catRpc('criar',{p_nome:nome,p_produtor:produtor,p_ano:ano,p_campos:wcLerCampos('nv-')});
    fecharModal('modal-novo');
    toast('Vinho criado ✓');
    wcCarregarCatalogo(true);
    if(r&&r.id)await wcVerFicha(r.id);
  }catch(e){
    toast('Erro: '+e.message,1);
    if(b){b.disabled=false;b.textContent='Criar vinho';}
  }
}

/* "🔎 Procurar informação" na própria "Vinho novo": em vez de obrigar a
   criar a linha primeiro e só depois ir buscá-la à lista para abrir a
   ficha e mandar pesquisar, cria-se a linha (com o que já estiver
   preenchido, rótulo lido incluído) e entra-se DIRETO no mesmo ecrã de
   pesquisa de uma ficha existente (`wcAbrirProcurar`) — que já bifurca em
   automática e manual. Nenhum código novo de pesquisa: é a MESMA porta,
   só que a linha nasce um instante antes de se bater a ela. */
async function wcNovoProcurar(){
  if(!isAdmin())return;
  const {nome,produtor,ano}=wcNovoIdentidade();
  if(!nome){toast('Falta o nome.',1);return;}
  const b=document.getElementById('nv-procurar');
  if(b){b.disabled=true;b.textContent='A criar…';}
  try{
    const r=await catRpc('criar',{p_nome:nome,p_produtor:produtor,p_ano:ano,p_campos:wcLerCampos('nv-')});
    fecharModal('modal-novo');
    wcCarregarCatalogo(true);
    if(r&&r.id){
      await wcVerFicha(r.id);
      wcAbrirProcurar();
    }
  }catch(e){
    toast('Erro: '+e.message,1);
    if(b){b.disabled=false;b.textContent='🔎 Procurar informação';}
  }
}


/* ══════════════════════════════════════════════
   PROCURAR INFORMAÇÃO — a pesquisa Google a sério

   Mesmo fluxo da Garrafeira: escolhem-se os campos, manda-se pesquisar, e
   espera-se. Pedir os 21 de uma vez põe o modelo a andar atrás de tudo e a
   voltar com meia dúzia de coisas mornas — pedir três dá três boas. É a
   lição que a `vinho-info` já tinha pago, e é por isso que este ecrã abre
   com os campos VAZIOS escolhidos e os outros não.

   O RESULTADO DIZ O QUE **NÃO** ENTROU, e isso é metade do ponto. A
   `winecatalog.juntar` recusa um campo quando o que já lá estava veio de
   uma fonte mais forte — o que é o sistema a funcionar (quem tem a garrafa
   na mão sabe melhor), mas sem isto no ecrã o admin mandava pesquisar, via
   metade dos campos na mesma e ficava sem saber se a pesquisa falhou ou se
   a base recusou. São coisas muito diferentes.
   ══════════════════════════════════════════════ */
const FN_CATALOGO_INFO=SB_URL+'/functions/v1/catalogo-info';
let _wcProcTimer=null, _wcProcId=null, _wcProcAte=0;

/* CONTEXTO LIVRE: duas caixas de texto em vez de campos fechados — mais
   flexível para o que ajuda a desambiguar ("grande reserva", "edição
   limitada", um produtor parecido com outro) do que um conjunto fixo de
   checkboxes alguma vez cobre. Nenhuma das duas é pedida de volta à IA —
   servem só de contexto (`processarPesquisa` em `catalogo-info.ts` lê-as
   do lado do servidor; `wcManualPrompt` espelha isto do lado do browser). */
function wcContextoHTML(){
  return `<div class="ed-campo">
      <label>Notas para ajudar a identificar o vinho (opcional)</label>
      <textarea id="pr-notas" rows="2" maxlength="300"
        placeholder="ex.: vinho tinto, grande reserva, da casa Ferreirinha, edição limitada"></textarea>
      <p class="wc-note" style="margin-top:5px">Não é pedido à IA — é só contexto para não
        confundir este vinho com um homónimo.</p>
    </div>
    <div class="ed-campo">
      <label>Sites de confiança (opcional)</label>
      <textarea id="pr-sites" rows="1" placeholder="ex.: vivino.com, wine-searcher.com"></textarea>
      <p class="wc-note" style="margin-top:5px">Um ou mais, separados por vírgula — a pesquisa dá
        prioridade a estes.</p>
    </div>`;
}
function wcContextoLer(){
  const notas=(document.getElementById('pr-notas')?.value||'').trim().slice(0,300);
  const sites=(document.getElementById('pr-sites')?.value||'')
    .split(/[,\n]/).map(s=>s.trim().replace(/^https?:\/\//i,'').replace(/\/.*$/,'')).filter(Boolean).slice(0,5);
  return {notas,sites};
}

function wcAbrirProcurar(){
  if(!_wcFicha||!isAdmin())return;
  const ficha=_wcFicha.ficha||{}, origens=_wcFicha.origens||{};
  const box=document.getElementById('procurar-corpo');
  if(!box)return;
  let h=`<p class="wc-note">Uma pesquisa Google a sério, com fontes, para este vinho. Vale
    <strong>força 3</strong> — entra por cima de estimativas e de cópias de garrafeira, e perde
    para o que tenhas corrigido à mão.</p>
  <p class="wc-note">Escolhe <strong>poucos campos</strong>. Pedir os vinte de uma vez põe o
    modelo a andar atrás de tudo e a voltar com meia dúzia de coisas mornas.</p>
  ${wcContextoHTML()}
  <label class="ed-check"><input type="checkbox" id="pr-colheita-esp">
    Tem de ser exatamente a colheita ${esc(String(_wcFicha.ano||''))}</label>
  <p class="wc-note">Por omissão a pesquisa é sobre o vinho em geral — a nota do Vivino, por
    exemplo, é uma média entre colheitas. Liga só se precisares mesmo dos factos desta colheita
    específica.</p>
  <div class="pr-acoes">
    <button class="btn-n" onclick="wcProcTodos(true)">Todos</button>
    <button class="btn-n" onclick="wcProcTodos(false)">Nenhum</button>
    <button class="btn-n" onclick="wcProcVazios()">Só os que faltam</button>
    <span class="wc-note" id="pr-conta"></span>
  </div>
  <div class="pr-campos">`;
  /* O PRODUTOR fica de fora do WC_EDIT (não é campo da ficha, é identidade —
     ver `WC_CAMPOS_JSON`), mas é sempre uma opção aqui, MESMO já preenchido:
     só uma leitura errada o faz vir diferente, e é exatamente isso que vale
     a pena confirmar. Nunca escreve sozinho — a pesquisa devolve-o como
     sugestão à parte, para aplicar em Editar. */
  const temProdutor=!!_wcFicha.produtor;
  h+=`<label class="pr-campo">
    <input type="checkbox" value="produtor"${temProdutor?'':' checked'} onchange="wcProcContar()">
    <span class="pr-nome">Produtor</span>
    ${temProdutor?`<span class="pr-falta">atual: ${esc(_wcFicha.produtor)}</span>`:'<span class="pr-falta">vazio</span>'}
  </label>`;
  for(const [k,lbl] of WC_EDIT.map(([k,l])=>[k,l])){
    const tem=k in ficha;
    const o=origens[k]||{}, f=Number(o.f||0);
    h+=`<label class="pr-campo">
      <input type="checkbox" value="${esc(k)}"${tem?'':' checked'} onchange="wcProcContar()">
      <span class="pr-nome">${esc(lbl)}</span>
      ${tem?`<span class="og-tag ${wcOrigemCls(o.o,f)}">${esc(wcOrigemTxt(o.o,f))}</span><span class="forca f${esc(String(f))}">${esc(String(f))}</span>`
           :'<span class="pr-falta">vazio</span>'}
    </label>`;
  }
  h+=`</div>
  <div class="macoes fim">
    <button class="btn-n" onclick="fecharModal('modal-procurar')">Cancelar</button>
    <button class="btn-prim auto" id="pr-ir" onclick="wcProcurarArrancar()">🔎 Pesquisar</button>
  </div>
  <button class="btn-n larg" onclick="wcProcurarManual()">✍️ Pesquisa manual — grátis, colar a resposta de um assistente de IA</button>`;
  box.innerHTML=h;
  document.getElementById('procurar-titulo').textContent=_wcFicha.nome||'(sem nome)';
  wcProcContar();
  abrirModal('modal-procurar');
}
function wcProcCaixas(){return [...document.querySelectorAll('#procurar-corpo .pr-campo input')];}
function wcProcTodos(on){wcProcCaixas().forEach(c=>c.checked=on);wcProcContar();}
function wcProcVazios(){
  const ficha=(_wcFicha&&_wcFicha.ficha)||{};
  wcProcCaixas().forEach(c=>c.checked=c.value==='produtor'?!(_wcFicha&&_wcFicha.produtor):!(c.value in ficha));
  wcProcContar();
}
function wcProcContar(){
  const n=wcProcCaixas().filter(c=>c.checked).length;
  const el=document.getElementById('pr-conta');
  const ir=document.getElementById('pr-ir');
  if(el)el.textContent=n?`${n} campo${n>1?'s':''}`:'nenhum campo escolhido';
  if(ir)ir.disabled=!n;
}

async function wcProcurarArrancar(){
  if(!_wcFicha)return;
  const campos=wcProcCaixas().filter(c=>c.checked).map(c=>c.value);
  if(!campos.length)return;
  const b=document.getElementById('pr-ir');
  if(b){b.disabled=true;b.textContent='A arrancar…';}
  try{
    const p=await catRpc('pesquisa_criar',{p_vinho_id:_wcFicha.id});
    fecharModal('modal-procurar');
    wcProcEspera();
    /* `jaAndava` é uma pesquisa que já estava a correr para este vinho — e
       nesse caso NÃO se chama outra vez a função, que era pagar duas vezes
       o mesmo trabalho. Sonda-se a que já lá está. */
    if(!p.jaAndava){
      const colheitaEspecifica=!!document.getElementById('pr-colheita-esp')?.checked;
      const ctx=wcContextoLer();
      const r=await fetch(FN_CATALOGO_INFO,{
        method:'POST',
        headers:{'Content-Type':'application/json',apikey:SB_KEY,
                 Authorization:'Bearer '+(_sbSession&&_sbSession.access_token)},
        body:JSON.stringify({pesquisaId:p.id,campos,colheitaEspecifica,notas:ctx.notas,sites:ctx.sites})
      });
      if(!r.ok&&r.status!==202){
        let msg='';try{msg=(await r.json()).error||'';}catch(_){}
        throw new Error(msg||('a função respondeu '+r.status));
      }
    }
    wcProcIniciarPolling(p.id);
  }catch(e){
    wcProcErro(e.message);
    if(b){b.disabled=false;b.textContent='🔎 Pesquisar';}
  }
}

function wcProcCaixa(){return document.getElementById('proc-caixa');}
function wcProcEspera(){
  const c=wcProcCaixa();
  if(c)c.innerHTML=`<div class="pr-espera">
    <div class="wc-spin escuro"></div>
    <div><strong>A pesquisar…</strong>
      <div class="wc-note">Pesquisa Google a sério — pode levar um minuto. Podes fechar isto,
        que o trabalho continua do lado do servidor.</div></div>
  </div>`;
}
function wcProcErro(msg){
  const c=wcProcCaixa();
  if(c)c.innerHTML=`<div class="pr-espera erro"><div>⚠️</div>
    <div><strong>A pesquisa falhou</strong><div class="wc-note">${esc(msg||'erro desconhecido')}</div></div></div>`;
}
function wcProcPararPolling(){
  if(_wcProcTimer){clearInterval(_wcProcTimer);_wcProcTimer=null;}
  _wcProcId=null;
}
function wcProcIniciarPolling(id){
  wcProcPararPolling();
  _wcProcId=id;
  _wcProcAte=Date.now()+3*60*1000;   // o mesmo limite da WineSelection
  _wcProcTimer=setInterval(wcProcPollTick,3000);
  wcProcPollTick();
}
async function wcProcPollTick(){
  if(!_wcProcId)return;
  if(Date.now()>_wcProcAte){
    wcProcPararPolling();
    wcProcErro('demorou demasiado — o resultado pode aparecer se recarregares daqui a pouco');
    return;
  }
  try{
    const p=await catRpc('pesquisa_ver',{p_id:_wcProcId});
    if(!p)return;
    if(p.estado==='pendente')return;
    wcProcPararPolling();
    if(p.estado==='erro'){wcProcErro(p.erro);return;}
    const res=p.resultado||{};
    /* A ficha refresca-se PRIMEIRO (o `wcFichaHTML` volta a desenhar a
       caixa vazia) e só depois se escreve o resultado lá dentro. Ao
       contrário, o relatório aparecia e desaparecia logo a seguir. */
    await wcRefrescarFicha();
    const c=wcProcCaixa();
    if(c)c.innerHTML=wcProcResultadoHTML(res);
    wcCarregarCatalogo(true);
  }catch(e){
    wcProcPararPolling();
    wcProcErro(e.message);
  }
}
function wcProcResultadoHTML(res){
  const props=Array.isArray(res.propostas)?res.propostas:[];
  const entraram=props.filter(p=>p.entrou);
  const ident=props.filter(p=>p.identidade&&!p.entrou);
  const fora=props.filter(p=>!p.entrou&&!p.identidade);
  const nome=k=>{if(k==='produtor')return 'Produtor';const c=WC_CAMPOS.find(([x])=>x===k);return c?c[1]:k;};
  let h=`<div class="pr-res">
    <div class="pr-res-cab"><strong>${entraram.length?`${entraram.length} campo${entraram.length>1?'s':''} ${entraram.length>1?'entraram':'entrou'}`:'Nada de novo entrou'}</strong>
      <span class="wc-note">${esc(res.modelo||'')}</span></div>`;
  if(entraram.length){
    h+=`<div class="pr-res-l">${entraram.map(p=>
      `<span class="bdg men">${esc(nome(p.campo))}</span>`).join('')}</div>`;
  }
  if(fora.length){
    /* O importante: POR QUE É QUE não entrou. Sem isto, o admin fica sem
       saber se a pesquisa falhou ou se a base recusou. */
    h+=`<div class="wc-note" style="margin-top:8px">O resto a pesquisa encontrou, mas o catálogo
      já tinha coisa melhor — a fonte de lá é mais forte:</div>
      <div class="pr-res-fora">${fora.map(p=>
        `<div><span class="pr-nome">${esc(nome(p.campo))}</span>
          <span class="wc-note">ficou o de <strong>${esc(wcOrigemTxt(p.ganhou,p.forca))}</strong>
          (força ${esc(String(p.forca||0))})</span></div>`).join('')}</div>`;
  }
  if(ident.length){
    /* O Produtor é IDENTIDADE, não ficha — nunca entra sozinho (mudaria a
       `chave`). Fica só como sugestão; aplicar é sempre um passo consciente
       em Editar, com o interruptor de identidade e a verificação de
       duplicados que ele já faz. */
    h+=`<div class="wc-note" style="margin-top:8px">A pesquisa sugere outro <strong>produtor</strong> —
      isto é identidade, não ficha, por isso não entra sozinho:</div>
      <div class="pr-res-fora">${ident.map(p=>
        `<div><span class="pr-nome">Produtor</span>
          <span class="wc-note">"${esc(p.atual||'(vazio)')}" → <strong>"${esc(p.valor)}"</strong> —
          usa <strong>Editar</strong> (Mexer na identidade) para aplicar, se estiver certo.</span></div>`).join('')}</div>`;
  }
  if(res.aviso)h+=`<div class="wc-note" style="margin-top:8px">⚠️ ${esc(res.aviso)}</div>`;
  if(!props.length&&!res.aviso){
    h+='<div class="wc-note">A pesquisa não confirmou nenhum dos campos pedidos. Não é um erro: '+
       'é o modelo a não inventar, que é o que se lhe pede.</div>';
  }
  h+='</div>';
  return h;
}

/* ── PESQUISA MANUAL — copiar prompt, colar resposta ──
   Mesmo botão "Procurar informação", um segundo caminho: em vez de a Edge
   Function pagar ao Gemini, o admin copia um prompt pronto, cola-o no
   assistente de IA que preferir (a conta dele, sem custo para o catálogo —
   quanto mais capaz o modelo, melhor costuma ser o resultado) e cola aqui
   a resposta.

   Entra pela MESMA porta que a automática: cria-se a mesma linha em
   `winecatalog.pesquisas` (`pesquisa_criar` — é o que evita duas pessoas a
   mandar pesquisar o mesmo vinho ao mesmo tempo) e chama-se a MESMA Edge
   Function, só que com `resposta` no corpo em vez de a deixar chamar o
   Gemini. Do lado do servidor, `catalogo-info.ts` salta a escolha de
   modelo e a chamada à API, faz `extrairJson`/`normalizar` no que veio
   colado, e segue exactamente o mesmo caminho a partir daí — a MESMA
   `juntar` (força 3, como qualquer pesquisa Google a sério), e o MESMO
   relatório de "o que entrou e porquê". O polling do lado da app
   (`wcProcIniciarPolling`) não sabe a diferença — e não precisa de saber. */
let _wcManualCampos=null;

/* Espelho das duas versões da regra do Vivino em `catalogo-info.ts`
   (`regraVivino`) — ver o comentário grande lá para o porquê. A ESTRITA
   exige o ano; a RELAXADA (o novo default) não, porque a página do Vivino
   é do vinho e não da colheita. */
function wcManualRegraVivino(colheitaEspecifica){
  return colheitaEspecifica
    ? 'Vivino: "vivinoNota", "vivinoAvaliacoes" e "vivinoUrl" têm de vir da MESMA página do Vivino e do vinho certo — confirma produtor, ano e região antes de aceitar. Em dúvida, deixa os três vazios.'
    : 'A página do Vivino é do VINHO, não de uma colheita específica: o ANO NÃO faz parte da identidade da página, e a nota que lá aparece é uma média entre colheitas. Para confirmares que é a página certa, basta o nome (já desambiguado na regra anterior) e o produtor baterem certo — não deixes a nota, as avaliações nem o link vazios só por causa do ano. A nota é o número entre 1.0 e 5.0 ao lado das estrelas; as avaliações vêm logo a seguir, entre parêntesis — não uses números de outra zona da página. Mesmo sem confirmares a nota, mantém o link se tiveres a certeza da página.';
}
const WC_MANUAL_REGRA_CUVEE='Se o produtor tiver mais do que um vinho com este nome (variantes de gama: Reserva, Grande Reserva, Colheita, Terroir, etc.) e não se souber qual, prefere a versão SEM qualificador extra; se essa não existir, escolhe a que tiver mais avaliações no Vivino (a principal da gama, normalmente) e diz no "aviso" que outras versões encontraste e qual escolheste.';

function wcManualPrompt(campos,colheitaEspecifica,notas,sites){
  const v=_wcFicha, ficha=(v&&v.ficha)||{};
  const hoje=new Date().toISOString().slice(0,10);
  const linhas=[`Nome: ${v.nome||''}`];
  if(v.ano)linhas.push(`Ano (colheita): ${v.ano}`);
  if(v.produtor)linhas.push(`Produtor: ${v.produtor}`);
  if(ficha.regiao)linhas.push(`Região indicada: ${ficha.regiao}`);
  if(ficha.tipo)linhas.push(`Cor: ${ficha.tipo}`);
  if(notas)linhas.push(`Notas de quem procura: ${notas}`);
  const so=campos&&campos.length&&campos.length<WC_PROC_TOTAL
    ?`\nSÓ INTERESSAM ESTES CAMPOS: ${campos.map(k=>WC_CAMPOS_JSON[k]||k).join(', ')}.\nConcentra-te neles e deixa os outros fora da resposta.\n`:'';
  const sitesTxt=sites&&sites.length
    ?`\nFONTES DE CONFIANÇA: dá prioridade a informação vinda de ${sites.join(', ')}. Só uses outra fonte se estas não tiverem a resposta.\n`:'';
  return `Usa a tua pesquisa na internet para preencheres a ficha deste vinho, como faria um enólogo a construir um catálogo de referência.

VINHO A IDENTIFICAR:
  ${linhas.join('\n  ')}
Hoje é ${hoje}.
${sitesTxt}${so}
REGRAS, e são a sério:
1. NÃO INVENTES. Um campo que não confirmes por pesquisa fica FORA do JSON (ou null) — este catálogo é lido por outras aplicações, e um palpite aqui propaga-se.
2. ${WC_MANUAL_REGRA_CUVEE}
3. ${wcManualRegraVivino(colheitaEspecifica)}
4. "imagemUrl" é o link DIRETO de uma fotografia (acaba em .jpg/.jpeg/.png/.webp/.avif), nunca o link da página.
5. Se houver dúvida de homónimo, prioriza ano + produtor + região e diz o que ficou por confirmar em "aviso".
6. Castas separadas por nome (nunca "blend"/"lote"/"várias castas").
7. "precoMedio" é o preço de retalho em euros, garrafa de 0,75L.
8. "beberDe"/"beberAte" são anos.
9. "produtorConfirmado" é o produtor tal como consta no rótulo ou numa loja oficial — usa o que vier em "Produtor" acima se estiver certo, ou corrige-o; deixa vazio se não tiveres a certeza, nunca inventes um nome.

Responde SÓ com este JSON, sem texto à volta e sem blocos de código \`\`\`:
{
  "encontrado": true,
  "produtorConfirmado": "${v.produtor||'(o produtor deste vinho)'}",
  "tipo": "um de: ${WC_TIPOS.filter(Boolean).join(' | ')}",
  "estilo": "vazio, ou um de: ${WC_ESTILOS.filter(Boolean).join(' | ')}",
  "regiao": "região vitivinícola",
  "subRegiao": "",
  "pais": "Portugal",
  "mencao": "vazio, ou um de: ${WC_MENCOES.filter(Boolean).join(' | ')}",
  "classificacao": "vazio, ou um de: ${WC_CLASSIF.filter(Boolean).join(' | ')}",
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

Se não conseguires identificar o vinho de todo, responde {"encontrado": false, "aviso": "porquê"}.`;
}

function wcProcurarManual(){
  if(!_wcFicha||!isAdmin())return;
  const campos=wcProcCaixas().filter(c=>c.checked).map(c=>c.value);
  if(!campos.length)return;
  _wcManualCampos=campos.length<WC_PROC_TOTAL?campos:null;
  const colheitaEspecifica=!!document.getElementById('pr-colheita-esp')?.checked;
  const ctx=wcContextoLer();
  const txt=wcManualPrompt(_wcManualCampos,colheitaEspecifica,ctx.notas,ctx.sites);
  const box=document.getElementById('procurar-corpo');
  if(!box)return;
  box.innerHTML=`
    <div class="pr-manual">
      <p class="wc-note">1. Copia o prompt. 2. Cola-o no assistente de IA que preferires (quanto
        mais capaz o modelo, melhor costuma ser o resultado — Gemini, ChatGPT, Claude, o que
        tiveres à mão). 3. Copia a resposta toda (o JSON) e cola-a aqui em baixo. 4. Guarda —
        entra no catálogo com a mesma força 3 de uma pesquisa automática, sem gastar nada.</p>
      <label>Prompt a copiar</label>
      <textarea id="pr-manual-prompt" rows="6" readonly onclick="this.select()">${esc(txt)}</textarea>
      <button class="btn-n larg" onclick="wcManualCopiar()">📋 Copiar prompt</button>
      <label>Resposta (cola aqui)</label>
      <textarea id="pr-manual-resposta" rows="10" placeholder="Cola aqui o JSON que o modelo devolveu…"></textarea>
      <p class="wc-note erro" id="pr-manual-erro"></p>
    </div>
    <div class="macoes fim">
      <button class="btn-n" onclick="wcAbrirProcurar()">‹ Voltar</button>
      <button class="btn-prim auto" id="pr-manual-ir" onclick="wcProcurarManualEnviar()">Guardar no catálogo</button>
    </div>`;
}
async function wcManualCopiar(){
  const ta=document.getElementById('pr-manual-prompt');
  if(!ta)return;
  try{
    await navigator.clipboard.writeText(ta.value);
    toast('Prompt copiado ✓');
  }catch(e){
    ta.focus();ta.select();
    toast('Não deu para copiar sozinho — o texto já está selecionado, usa Ctrl/Cmd+C',1);
  }
}
async function wcProcurarManualEnviar(){
  if(!_wcFicha||!isAdmin())return;
  const texto=(document.getElementById('pr-manual-resposta')||{}).value||'';
  const erroEl=document.getElementById('pr-manual-erro');
  if(!texto.trim()){if(erroEl)erroEl.textContent='Cola primeiro a resposta.';return;}
  if(erroEl)erroEl.textContent='';
  const b=document.getElementById('pr-manual-ir');
  if(b){b.disabled=true;b.textContent='A guardar…';}
  try{
    const p=await catRpc('pesquisa_criar',{p_vinho_id:_wcFicha.id});
    fecharModal('modal-procurar');
    wcProcEspera();
    if(!p.jaAndava){
      const r=await fetch(FN_CATALOGO_INFO,{
        method:'POST',
        headers:{'Content-Type':'application/json',apikey:SB_KEY,
                 Authorization:'Bearer '+(_sbSession&&_sbSession.access_token)},
        body:JSON.stringify({pesquisaId:p.id,campos:_wcManualCampos,resposta:texto})
      });
      if(!r.ok&&r.status!==202){
        let msg='';try{msg=(await r.json()).error||'';}catch(_){}
        throw new Error(msg||('a função respondeu '+r.status));
      }
    }
    wcProcIniciarPolling(p.id);
  }catch(e){
    wcProcErro(e.message);
    if(b){b.disabled=false;b.textContent='Guardar no catálogo';}
  }
}

/* ══════════════════════════════════════════════
   FAB DO CATÁLOGO — "Vinho novo" e "Atualizar informação"

   Mesmo desenho da Garrafeira: um "+" flutuante que abre duas ações, em
   vez de um botão de texto perdido no fundo do painel de filtros. "Vinho
   novo" é o que já existia (`wcAbrirNovo`); "Atualizar informação" é a
   pesquisa manual de cima (`wcProcurarManual`), só que para VÁRIOS vinhos
   de uma vez — ver a secção seguinte.
   ══════════════════════════════════════════════ */
/* Quem decide se o "+" se vê: o Catálogo à frente, o admin, e NENHUM modal
   aberto. A última condição é a que faltava — o FAB é `position:fixed` e
   fica no mesmo canto onde todos os modais têm o botão de confirmar, por
   isso enquanto houver um aberto o "+" apanhava-lhe os toques. */
function wcFabSincronizar(){
  const w=document.getElementById('wc-fab-wrap');
  if(!w)return;
  const cat=document.getElementById('t-catalogo');
  const mostra=!!cat&&cat.classList.contains('on')&&isAdmin()&&!document.querySelector('.modal.on');
  w.style.display=mostra?'flex':'none';
  if(!mostra)w.classList.remove('open');
}
function wcFabToggle(){
  const w=document.getElementById('wc-fab-wrap');
  if(w)w.classList.toggle('open');
}
function wcFabFechar(){
  const w=document.getElementById('wc-fab-wrap');
  if(w)w.classList.remove('open');
}
function wcFabAcao(tipo){
  wcFabFechar();
  if(tipo==='novo')wcAbrirNovo();
  if(tipo==='lote')wcAbrirLote();
}

/* ══════════════════════════════════════════════
   ATUALIZAR INFORMAÇÃO EM LOTE — o mesmo prompt manual, para vários vinhos

   A pesquisa manual (acima) já resolvia "copiar um prompt, colar a
   resposta" para UM vinho. Isto é a mesma ideia para até
   `WC_LOTE_MAX_VINHOS` vinhos e até `WC_LOTE_MAX_CAMPOS` campos de cada
   vez — nasceu de rever à mão, num assistente de IA à parte, se o link do
   Vivino/a nota/o preço de vários vinhos ainda batem certo, sem ter de
   abrir um a um.

   NÃO é um caminho de escrita novo: cada vinho da resposta colada entra
   pela EXACTA MESMA porta da pesquisa manual de cima — `pesquisa_criar` +
   `catalogo-info.ts` com `resposta` no corpo — só que chamada uma vez por
   vinho, em vez de uma vez só. Isso quer dizer força 3, `juntar` campo a
   campo, e o Produtor de fora (é identidade, não ficha — por isso não
   está nas opções de campo aqui, só o que já está em `WC_CAMPOS`). Um
   atalho que escrevesse direto na `ficha` a partir do JSON colado, sem
   passar por ali, era a porta dos fundos que a app inteira evita.

   O "id" de cada vinho viaja no prompt e tem de voltar na resposta — é
   como se sabe a que vinho corresponde cada objeto sem depender da ordem
   (um modelo que reordene, ou que só responda a alguns, não desalinha os
   restantes). */
const WC_LOTE_MAX_VINHOS=10, WC_LOTE_MAX_CAMPOS=5;
let _wcLoteVinhos=new Map();   // id -> {id,nome,produtor,ano}
let _wcLoteCampos=[];          // até WC_LOTE_MAX_CAMPOS chaves de WC_CAMPOS
let _wcLoteBuscaSeq=0;

function wcAbrirLote(){
  if(!isAdmin())return;
  _wcLoteVinhos=new Map();
  _wcLoteCampos=[];
  wcLotePassoVinhos();
  abrirModal('modal-lote');
}

/* O modal rola por dentro; sem isto, mudar de passo deixava o ecrã na
   mesma altura — e como o passo 2 é comprido, o passo 3 aparecia já
   passado o prompt, com ar de "não aconteceu nada". */
function wcLoteTopo(){
  const m=document.getElementById('modal-lote');
  if(m)m.scrollTop=0;
}
function wcLotePassos(n){
  return `<div class="lote-passos">${['Vinhos','Campos','Prompt'].map((p,i)=>{
    const cls=i+1===n?' on':(i+1<n?' feito':'');
    return `<span class="lote-passo${cls}"><i>${i+1<n?'✓':i+1}</i>${esc(p)}</span>`;
  }).join('')}</div>`;
}

/* ── Passo 1: escolher os vinhos ── */
function wcLotePassoVinhos(){
  const box=document.getElementById('lote-corpo');
  if(!box)return;
  box.innerHTML=`
    ${wcLotePassos(1)}
    <p class="wc-note">Até <strong>${WC_LOTE_MAX_VINHOS} vinhos</strong> e, no passo a seguir,
      até ${WC_LOTE_MAX_CAMPOS} campos. Sai um prompt só, para colares num assistente de IA à
      tua escolha; a resposta aplica-se aqui, vinho a vinho.</p>
    <div class="ed-campo">
      <label>Procurar vinhos</label>
      <input type="text" id="lote-procura" placeholder="nome, produtor ou região…"
             oninput="wcLoteBuscar()" autocomplete="off">
    </div>
    <div id="lote-selecionados"></div>
    <div id="lote-resultados" class="lote-resultados">
      <p class="lote-vazio">Escreve para procurar.</p>
    </div>
    <div class="macoes fim">
      <button class="btn-n" onclick="fecharModal('modal-lote')">Cancelar</button>
      <button class="btn-prim auto" id="lote-seguinte" onclick="wcLotePassoCampos()" disabled>Seguinte ›</button>
    </div>`;
  wcLotePintarSelecionados();
  wcLoteTopo();
}
function wcLotePintarSelecionados(){
  const el=document.getElementById('lote-selecionados');
  const btn=document.getElementById('lote-seguinte');
  if(btn)btn.disabled=!_wcLoteVinhos.size;
  if(!el)return;
  if(!_wcLoteVinhos.size){el.innerHTML='';return;}
  el.innerHTML=`
    <div class="lote-sel-cab">
      <span>Escolhidos</span>
      <span class="lote-cont">${_wcLoteVinhos.size}/${WC_LOTE_MAX_VINHOS}</span>
    </div>
    <div class="lote-chips">${[..._wcLoteVinhos.values()].map(v=>
      `<span class="lote-chip"><span>${esc(v.nome||'(sem nome)')}</span>${
        v.ano?`<em>${esc(String(v.ano))}</em>`:''}
        <button onclick="wcLoteRemover(${v.id})" aria-label="Remover">✕</button></span>`).join('')}
    </div>`;
}
function wcLoteRemover(id){
  _wcLoteVinhos.delete(id);
  wcLotePintarSelecionados();
  wcLoteRepintarResultados();
}
let _wcLoteUltimaLista=[];
/* Repintar por cima da ÚLTIMA lista já pedida — marcar/desmarcar uma
   checkbox não é motivo para voltar a perguntar ao servidor a mesma
   procura que já tínhamos. */
function wcLoteRepintarResultados(){
  const el=document.getElementById('lote-resultados');
  if(!el||!_wcLoteUltimaLista.length)return;
  el.innerHTML=_wcLoteUltimaLista.map(v=>{
    const on=_wcLoteVinhos.has(v.id);
    const cheio=!on&&_wcLoteVinhos.size>=WC_LOTE_MAX_VINHOS;
    /* Sem produtor (acontece), a região diz mais do que um travessão. */
    const sub=[v.produtor||v.regiao,v.ano?String(v.ano):''].filter(Boolean).join(' · ');
    return `<label class="lote-v${on?' on':''}${cheio?' cheio':''}">
      <input type="checkbox" ${on?'checked':''} ${cheio?'disabled':''}
        onchange="wcLoteToggleVinho(${v.id},'${escJs(v.nome||'')}','${escJs(v.produtor||'')}',${v.ano||'null'})">
      <span class="lote-v-tx">
        <span class="lote-v-nome">${esc(v.nome||'(sem nome)')}</span>
        <span class="lote-v-sub">${esc(sub||'sem produtor')}</span>
      </span>
    </label>`;
  }).join('');
}
async function wcLoteBuscar(){
  const q=(document.getElementById('lote-procura')||{}).value||'';
  const el=document.getElementById('lote-resultados');
  if(!el)return;
  if(!q.trim()){
    _wcLoteUltimaLista=[];
    el.innerHTML='<p class="lote-vazio">Escreve para procurar.</p>';
    return;
  }
  const seq=++_wcLoteBuscaSeq;
  el.innerHTML='<p class="lote-vazio">A procurar…</p>';
  try{
    const d=await catRpc('listar',{p_procura:q,p_limite:15,p_saltar:0});
    if(seq!==_wcLoteBuscaSeq)return;   // uma procura mais recente já respondeu primeiro
    _wcLoteUltimaLista=(d&&d.linhas)||[];
    if(!_wcLoteUltimaLista.length){el.innerHTML='<p class="lote-vazio">Nenhum vinho encontrado.</p>';return;}
    wcLoteRepintarResultados();
  }catch(e){
    if(seq!==_wcLoteBuscaSeq)return;
    el.innerHTML=`<p class="lote-vazio erro">${esc(e.message)}</p>`;
  }
}
function wcLoteToggleVinho(id,nome,produtor,ano){
  if(_wcLoteVinhos.has(id)){
    _wcLoteVinhos.delete(id);
  }else{
    if(_wcLoteVinhos.size>=WC_LOTE_MAX_VINHOS){
      toast('Já tens '+WC_LOTE_MAX_VINHOS+' vinhos — tira um para escolheres outro',1);
      wcLoteRepintarResultados();
      return;
    }
    _wcLoteVinhos.set(id,{id,nome,produtor,ano});
  }
  wcLotePintarSelecionados();
  wcLoteRepintarResultados();
}

/* ── Passo 2: escolher os campos — qualquer um de WC_CAMPOS, até
   WC_LOTE_MAX_CAMPOS. O Produtor fica de fora de propósito: é IDENTIDADE
   (ver `WC_CAMPOS_JSON`), não ficha, e nunca devia entrar por aqui. ── */
function wcLotePassoCampos(){
  if(!_wcLoteVinhos.size)return;
  const box=document.getElementById('lote-corpo');
  if(!box)return;
  const n=_wcLoteVinhos.size;
  box.innerHTML=`
    ${wcLotePassos(2)}
    <p class="wc-note">${n} vinho${n>1?'s':''} escolhido${n>1?'s':''}. Agora até
      <strong>${WC_LOTE_MAX_CAMPOS} campos</strong> — poucos, e o prompt sai mais preciso.
      O ponto dourado marca os que <strong>envelhecem</strong> (nota, preço, links): os
      outros raramente precisam de uma segunda volta.</p>
    <div class="lote-sel-cab">
      <span>Campos</span>
      <span class="lote-cont" id="lote-conta-campos"></span>
    </div>
    <div class="lote-campos" id="lote-campos">${WC_CAMPOS.map(([k,lbl])=>{
      const on=_wcLoteCampos.includes(k);
      /* "Vivino" e "Imagem" chegam de `WC_CAMPOS` com o nome que fazem na
         ficha, onde o valor ao lado diz que são links. Numa lista de
         escolha, "Vivino" ao lado de "Nota Vivino" não se percebe — daí o
         sufixo, por regra e não por uma segunda lista de nomes a divergir
         da primeira. */
      const nome=/_url$/.test(k)?lbl+' (link)':lbl;
      return `<label class="lote-c${on?' on':''}">
        <input type="checkbox" value="${esc(k)}"${on?' checked':''}
          onchange="wcLoteToggleCampo('${escJs(k)}')">
        <span>${esc(nome)}</span>
        ${WC_VOLATEIS.includes(k)?'<i title="envelhece"></i>':''}
      </label>`;
    }).join('')}</div>
    <div class="macoes fim">
      <button class="btn-n" onclick="wcLotePassoVinhos()">‹ Voltar</button>
      <button class="btn-prim auto" id="lote-gerar" onclick="wcLoteGerarPrompt()">Gerar prompt ›</button>
    </div>`;
  wcLotePintarContaCampos();
  wcLoteTopo();
}
function wcLoteToggleCampo(k){
  const cx=document.querySelector('#lote-campos input[value="'+CSS.escape(k)+'"]');
  const i=_wcLoteCampos.indexOf(k);
  if(i>=0){
    _wcLoteCampos.splice(i,1);
  }else{
    if(_wcLoteCampos.length>=WC_LOTE_MAX_CAMPOS){
      toast('Já tens '+WC_LOTE_MAX_CAMPOS+' campos — tira um para escolheres outro',1);
      if(cx)cx.checked=false;
      return;
    }
    _wcLoteCampos.push(k);
  }
  if(cx&&cx.parentElement)cx.parentElement.classList.toggle('on',_wcLoteCampos.includes(k));
  wcLotePintarContaCampos();
}
function wcLotePintarContaCampos(){
  const el=document.getElementById('lote-conta-campos');
  const btn=document.getElementById('lote-gerar');
  const n=_wcLoteCampos.length;
  if(el)el.textContent=`${n}/${WC_LOTE_MAX_CAMPOS}`;
  if(btn)btn.disabled=!n;
}

/* ── Passo 3: gerar o prompt, copiar, colar a resposta ──
   As regras reaproveitam AS MESMAS da pesquisa manual de um vinho só —
   `WC_MANUAL_REGRA_CUVEE` e `wcManualRegraVivino` — só acrescentadas
   quando fazem sentido para os campos escolhidos. Duas cópias da regra do
   Vivino a divergirem era exactamente o erro que este ficheiro avisa para
   não repetir. */
function wcLoteCampoExemplo(k){
  const EX={
    tipo:`"um de: ${WC_TIPOS.filter(Boolean).join(' | ')}"`,
    estilo:`"vazio, ou um de: ${WC_ESTILOS.filter(Boolean).join(' | ')}"`,
    mencao:`"vazio, ou um de: ${WC_MENCOES.filter(Boolean).join(' | ')}"`,
    classificacao:`"vazio, ou um de: ${WC_CLASSIF.filter(Boolean).join(' | ')}"`,
    regiao:'"região vitivinícola"', sub_regiao:'""', pais:'"Portugal"',
    castas:'["Touriga Nacional", "Touriga Franca"]',
    teor:'14.5', estagio_meses:'18',
    estagio_texto:'"18 meses em barrica de carvalho francês"',
    vivino_nota:'4.1', vivino_avaliacoes:'1234', vivino_url:'""', imagem_url:'""',
    preco_medio:'18.5', beber_de:'2026', beber_ate:'2034',
    notas_prova:'"duas ou três frases sobre aroma, boca e final"',
    harmonizacao:'"com que pratos"',
    ai_resumo:'"duas ou três frases sobre o vinho e o produtor"',
  };
  return k in EX?EX[k]:'null';
}
function wcLoteRegras(campos){
  const r=[
    'NÃO INVENTES. Um campo que não confirmes por pesquisa fica FORA do objeto desse vinho '+
      '(ou null) — este catálogo é lido por outras aplicações, e um palpite aqui propaga-se '+
      'para as duas.',
    WC_MANUAL_REGRA_CUVEE,
  ];
  if(campos.some(k=>k.startsWith('vivino_')))r.push(wcManualRegraVivino(false));
  if(campos.includes('castas'))
    r.push('Castas separadas por nome (nunca "blend"/"lote"/"várias castas").');
  if(campos.includes('imagem_url'))
    r.push('"imagemUrl" é o link DIRETO de uma fotografia (acaba em .jpg/.jpeg/.png/.webp/.avif), nunca o link da página.');
  if(campos.includes('preco_medio'))
    r.push('"precoMedio" é o preço de retalho em euros, garrafa de 0,75L.');
  if(campos.includes('beber_de')||campos.includes('beber_ate'))
    r.push('"beberDe"/"beberAte" são anos.');
  r.push('O "id" de cada resultado tem de ser EXATAMENTE o "id" da lista de entrada — é assim '+
    'que sei a que vinho corresponde cada objeto, nunca pela posição na lista.');
  r.push('Se não conseguires identificar um vinho de todo, o objeto dele fica só '+
    '{"id": <id>, "encontrado": false, "aviso": "porquê"} — sem inventar os outros campos.');
  return r;
}
function wcLotePrompt(vinhos,campos){
  const hoje=new Date().toISOString().slice(0,10);
  const nomesCampos=campos.map(k=>WC_CAMPOS_JSON[k]||k);
  const linhas=vinhos.map(v=>
    `- id: ${v.id} | nome: ${v.nome||'(sem nome)'} | produtor: ${v.produtor||'(desconhecido)'}`+
    (v.ano?` | ano: ${v.ano}`:'')).join('\n');
  const camposObj=campos.map(k=>`      "${WC_CAMPOS_JSON[k]||k}": ${wcLoteCampoExemplo(k)}`).join(',\n');
  const regras=wcLoteRegras(campos).map((r,i)=>`${i+1}. ${r}`).join('\n');
  return `Usa a tua pesquisa na internet para preencheres, PARA CADA VINHO da lista abaixo, só os campos pedidos — como faria um enólogo a atualizar um catálogo de referência.

Hoje é ${hoje}.
CAMPOS A PEDIR (só estes, para todos os vinhos): ${nomesCampos.join(', ')}.

VINHOS A IDENTIFICAR:
${linhas}

REGRAS, e são a sério:
${regras}

Responde SÓ com este JSON, sem texto à volta e sem blocos de código \`\`\`, com exatamente ${vinhos.length} objeto${vinhos.length>1?'s':''} em "resultados" (um por vinho, pela mesma ordem):
{
  "resultados": [
    {
      "id": ${vinhos[0].id},
      "encontrado": true,
${camposObj},
      "aviso": "vazio, ou o que ficou por confirmar"
    }
  ]
}`;
}
function wcLoteGerarPrompt(){
  if(!_wcLoteVinhos.size||!_wcLoteCampos.length)return;
  const box=document.getElementById('lote-corpo');
  if(!box)return;
  const vinhos=[..._wcLoteVinhos.values()];
  const txt=wcLotePrompt(vinhos,_wcLoteCampos);
  box.innerHTML=`
    ${wcLotePassos(3)}
    <div class="pr-manual">
      <ol class="lote-ol">
        <li>Copia o prompt.</li>
        <li>Cola-o num assistente de IA <strong>com pesquisa na internet ligada</strong> —
          quanto mais capaz o modelo, melhor costuma ser o resultado.</li>
        <li>Copia a resposta toda (o JSON) e cola-a aqui em baixo.</li>
        <li>Guarda: cada vinho entra pelo mesmo caminho de uma pesquisa manual
          (<strong>força 3</strong>), um a um.</li>
      </ol>
      <label>Prompt a copiar</label>
      <textarea id="lote-prompt" rows="6" readonly onclick="this.select()">${esc(txt)}</textarea>
      <button class="btn-n larg" onclick="wcLoteCopiar()">📋 Copiar prompt</button>
      <label>Resposta (cola aqui)</label>
      <textarea id="lote-resposta" rows="12" placeholder="Cola aqui o JSON que o modelo devolveu…"></textarea>
      <p class="wc-note erro" id="lote-erro"></p>
    </div>
    <div id="lote-progresso"></div>
    <div class="macoes fim">
      <button class="btn-n" onclick="wcLotePassoCampos()">‹ Voltar</button>
      <button class="btn-prim auto" id="lote-enviar" onclick="wcLoteEnviar()">Guardar no catálogo</button>
    </div>`;
  wcLoteTopo();
}
async function wcLoteCopiar(){
  const ta=document.getElementById('lote-prompt');
  if(!ta)return;
  try{
    await navigator.clipboard.writeText(ta.value);
    toast('Prompt copiado ✓');
  }catch(e){
    ta.focus();ta.select();
    toast('Não deu para copiar sozinho — o texto já está selecionado, usa Ctrl/Cmd+C',1);
  }
}

/* ── Aplicar a resposta, vinho a vinho ── */
function wcLoteExtrairJson(txt){
  if(!txt)return null;
  const s=String(txt).trim().replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();
  const ini=s.indexOf('{'), fim=s.lastIndexOf('}');
  if(ini<0||fim<ini)return null;
  try{return JSON.parse(s.slice(ini,fim+1));}catch(e){return null;}
}
/* A resposta colada nunca chama o Gemini, mas passa sempre pelo mesmo
   `EdgeRuntime.waitUntil` do lado do servidor (ver `catalogo-info.ts`) —
   o 202 é imediato, o resultado não. 30s chega de sobra para um JSON só de
   ler e validar. */
async function wcLotePesquisaVer(id){
  const ate=Date.now()+30000;
  while(Date.now()<ate){
    const p=await catRpc('pesquisa_ver',{p_id:id});
    if(p&&p.estado&&p.estado!=='pendente')return p;
    await new Promise(res=>setTimeout(res,1200));
  }
  throw new Error('demorou demasiado a responder');
}
async function wcLoteEnviar(){
  if(!_wcLoteVinhos.size||!_wcLoteCampos.length)return;
  const erroEl=document.getElementById('lote-erro');
  const texto=(document.getElementById('lote-resposta')||{}).value||'';
  const dados=wcLoteExtrairJson(texto);
  const lista=dados&&Array.isArray(dados.resultados)?dados.resultados:null;
  if(!lista){
    if(erroEl)erroEl.textContent='Não consegui ler a resposta colada como JSON — confirma que '+
      'colaste o texto todo, incluindo as chavetas { } e "resultados".';
    return;
  }
  if(erroEl)erroEl.textContent='';
  const btn=document.getElementById('lote-enviar');
  if(btn){btn.disabled=true;btn.textContent='A guardar…';}
  const progEl=document.getElementById('lote-progresso');
  const porId=new Map(lista.map(r=>[Number(r&&r.id),r]));
  const linhas=[..._wcLoteVinhos.values()].map(v=>({v,msg:'na fila'}));
  const pinta=()=>{
    if(!progEl)return;
    progEl.innerHTML=`<div class="pr-manual"><label>Progresso</label>${linhas.map(l=>
      `<div class="lote-prog-l"><span>${esc(l.v.nome||'(sem nome)')}</span>`+
      `<span class="wc-note">${esc(l.msg||'')}</span></div>`).join('')}</div>`;
  };
  pinta();
  for(const l of linhas){
    const r=porId.get(l.v.id);
    if(!r){l.msg='não veio na resposta colada';pinta();continue;}
    if(r.encontrado===false){l.msg='não encontrado: '+(r.aviso||'sem razão indicada');pinta();continue;}
    l.msg='a guardar…';pinta();
    try{
      const respostaObj={encontrado:true};
      for(const k of _wcLoteCampos){
        const jk=WC_CAMPOS_JSON[k]||k;
        if(r[jk]!==undefined)respostaObj[jk]=r[jk];
      }
      const p=await catRpc('pesquisa_criar',{p_vinho_id:l.v.id});
      if(!p.jaAndava){
        const resp=await fetch(FN_CATALOGO_INFO,{
          method:'POST',
          headers:{'Content-Type':'application/json',apikey:SB_KEY,
                   Authorization:'Bearer '+(_sbSession&&_sbSession.access_token)},
          body:JSON.stringify({pesquisaId:p.id,campos:_wcLoteCampos,resposta:JSON.stringify(respostaObj)})
        });
        if(!resp.ok&&resp.status!==202){
          let msg='';try{msg=(await resp.json()).error||'';}catch(_){}
          throw new Error(msg||('a função respondeu '+resp.status));
        }
      }
      const res=await wcLotePesquisaVer(p.id);
      if(res.estado==='erro'){
        l.msg=res.erro||'erro desconhecido';
      }else{
        const props=(res.resultado&&res.resultado.propostas)||[];
        const entraram=props.filter(x=>x.entrou).length;
        l.msg=entraram?`${entraram} campo${entraram>1?'s':''} ${entraram>1?'entraram':'entrou'}`:'nada de novo entrou';
      }
    }catch(e){
      l.msg=e.message;
    }
    pinta();
  }
  if(btn){btn.disabled=false;btn.textContent='Guardar no catálogo';}
  wcCarregarCatalogo(true);
}

/* ══════════════════════════════════════════════
   DUPLICADOS — a fusão manual

   A regra que segura este ecrã: a SEMELHANÇA SUGERE, NUNCA DECIDE. Uma
   varredura automática por tokens devolveu 29 pares em 162 linhas, e lá
   dentro havia duplicados a sério E falsos positivos perigosos
   (`nacional-touriga-vallado` com `esporao-nacional-touriga` — dois
   produtores diferentes a partilhar o nome de uma casta).

   Por isso: os números de cada par vão para o ecrã COM o par, os dois
   lados mostram-se inteiros, e é preciso escolher qual fica.
   ══════════════════════════════════════════════ */
async function wcCarregarDuplicados(){
  const box=document.getElementById('dup-lista');
  if(!box)return;
  box.innerHTML='<div class="wc-card"><p class="wc-note">A procurar pares…</p></div>';
  try{
    const pares=await catRpc('candidatos',{p_limite:40});
    if(!pares||!pares.length){
      box.innerHTML='<div class="wc-card"><p class="wc-note">Nenhum par suspeito. Ou está tudo arrumado, ou os que restam já foram marcados como distintos.</p></div>';
      return;
    }
    box.innerHTML=pares.map(wcParHTML).join('');
  }catch(e){
    box.innerHTML=`<div class="wc-card"><p class="wc-note erro">${esc(e.message)}</p></div>`;
  }
}

function wcLadoHTML(v,outro,podeDecidir){
  const sub=[v.produtor,v.regiao].filter(Boolean).join(' · ');
  const castas=Array.isArray(v.castas)?v.castas.join(', '):'';
  return `<div class="par-lado">
    <div class="par-nome" onclick="wcVerFicha(${v.id})">${esc(v.nome||'(sem nome)')}${v.ano?` <span class="cat-ano">${esc(String(v.ano))}</span>`:''}</div>
    <div class="par-sub">${esc(sub||'—')}</div>
    ${castas?`<div class="par-sub"><em>${esc(castas)}</em></div>`:''}
    <div class="par-meta">
      <span>${nFmt(v.campos)} campos</span>
      <span class="forca f${esc(String(v.forca))}">${esc(String(v.forca))}</span>
      ${v.nota!=null?`<span class="cat-nota">${esc(String(v.nota))}</span>`:''}
    </div>
    <div class="par-chave"><code>${esc(v.chave)}</code></div>
    ${podeDecidir?`<button class="btn-n larg" onclick="wcFundir(${outro.id},${v.id})">Ficar com esta</button>`:''}
  </div>`;
}

function wcParHTML(p){
  const a=p.a,b=p.b;
  const adm=isAdmin();
  /* O que os aproximou, por palavras. Dizer "2 palavras em comum" não
     ajudava ninguém a decidir — e, pior, escondia os pares que só tinham
     em comum "grande reserva". Agora vê-se a palavra, e a decisão é de um
     segundo. */
  const fortes=Array.isArray(p.fortes)?p.fortes:[];
  return `<div class="wc-card par">
    <div class="par-cab">
      <span class="par-sim">${Math.round(Number(p.sobreposicao||0)*100)}% parecidos</span>
      <span class="wc-note">${fortes.length
        ?`em comum: ${fortes.map(f=>`<strong>${esc(f)}</strong>`).join(', ')}`
        :`${esc(String(p.comuns))} palavras em comum`}${a.ano?` · colheita ${esc(String(a.ano))}`:' · sem colheita'}</span>
    </div>
    <div class="par-grid">
      ${wcLadoHTML(a,b,adm)}
      ${wcLadoHTML(b,a,adm)}
    </div>
    ${adm?`<div class="par-acoes">
      <button class="btn-n" onclick="wcNaoSao(${a.id},${b.id})">Não são o mesmo</button>
      <span class="wc-note">“Ficar com esta” funde a outra nesta — e dá para desfazer.</span>
    </div>`:`<p class="wc-note">Só o admin do catálogo pode decidir isto.</p>`}
  </div>`;
}

async function wcFundir(idDe,idPara){
  if(!confirm('Fundir as duas linhas numa só?\n\nOs campos da outra passam para esta (respeitando a força de cada um), a outra fica estacionada — não se apaga — e isto dá para desfazer.'))return;
  try{
    const r=await catRpc('fundir',{p_id_de:idDe,p_id_para:idPara});
    toast(`Fundidas ✓ ${(r&&r.campos)||0} campos passaram`);
    wcCarregarDuplicados();
  }catch(e){toast('Erro: '+e.message,1);}
}

/* O "não são" tem de ficar GRAVADO. Senão a lista volta a propor o mesmo
   par todas as semanas, e uma lista que insiste em erros deixa de se ler —
   é o caminho para alguém carregar em "são o mesmo" sem olhar e juntar um
   Vallado a um Esporão. */
async function wcNaoSao(idA,idB){
  try{
    await catRpc('marcar_distintos',{p_id_a:idA,p_id_b:idB});
    toast('Marcado — não volta a aparecer');
    wcCarregarDuplicados();
  }catch(e){toast('Erro: '+e.message,1);}
}

async function wcSeparar(chaveDe,idPara){
  if(!confirm('Desfazer esta fusão?\n\nA linha volta ao catálogo e os campos são repostos — menos os que outra pesquisa tenha atualizado entretanto, que ficam como estão.'))return;
  try{
    const r=await catRpc('separar',{p_chave_de:chaveDe});
    const m=(r&&r.mantidos)?` (${r.mantidos} ficaram: foram reescritos depois da fusão)`:'';
    toast(`Desfeita ✓ ${(r&&r.repostos)||0} campos repostos${m}`);
    wcFecharFicha();
    wcCarregarDuplicados();
  }catch(e){toast('Erro: '+e.message,1);}
}

/* Desfazer um "não são" também tem de existir: também é uma decisão, e
   também se erra. */
async function wcVerDistintos(){
  const box=document.getElementById('dup-lista');
  if(!box)return;
  box.innerHTML='<div class="wc-card"><p class="wc-note">A carregar…</p></div>';
  try{
    const ds=await catRpc('listar_distintos',{});
    if(!ds||!ds.length){
      box.innerHTML='<div class="wc-card"><p class="wc-note">Nenhum par marcado como distinto ainda.</p><button class="btn-n" onclick="wcCarregarDuplicados()">Voltar aos pares</button></div>';
      return;
    }
    box.innerHTML=`<div class="wc-card">
      <h3>Pares marcados como distintos</h3>
      <p class="wc-note">Estes não voltam a aparecer na lista. Se algum foi um engano, desfaz-se aqui.</p>
      ${ds.map(d=>`<div class="fi-alias">
        <div>
          <strong>${esc(d.nomeA||d.chaveA)}</strong> ≠ <strong>${esc(d.nomeB||d.chaveB)}</strong>
          <div class="wc-note">${esc(dataFmt(d.quando))}${d.quem?' · '+esc(d.quem):''}</div>
        </div>
        ${isAdmin()?`<button class="btn-n" onclick="wcDesmarcar('${escJs(d.chaveA)}','${escJs(d.chaveB)}')">Desfazer</button>`:''}
      </div>`).join('')}
      <button class="btn-n larg" style="margin-top:12px" onclick="wcCarregarDuplicados()">Voltar aos pares</button>
    </div>`;
  }catch(e){
    box.innerHTML=`<div class="wc-card"><p class="wc-note erro">${esc(e.message)}</p></div>`;
  }
}
async function wcDesmarcar(a,b){
  try{
    await catRpc('desmarcar_distintos',{p_chave_a:a,p_chave_b:b});
    toast('Desfeito ✓');
    wcVerDistintos();
  }catch(e){toast('Erro: '+e.message,1);}
}


/* ══════════════════════════════════════════════
   ALERTAS — o catálogo a ouvir de volta

   Até aqui esta relação era de sentido único: as duas apps escreviam no
   catálogo e nunca ouviam nada. Isso deixava a avaria mais chata de todas
   sem sítio nenhum onde aparecer — o mesmo vinho com números diferentes nos
   dois lados, e ninguém a saber qual está certo.

   Cada alerta guarda os DOIS valores como estavam no momento em que foi
   feito, e o ecrã mostra ao lado o que está lá AGORA. É essa terceira
   coluna que faz um alerta de há três semanas continuar a servir para
   alguma coisa: vê-se logo se já foi corrigido por outra via.

   "Rejeitar" existe e não é falta de educação: metade dos alertas hão de
   ser o catálogo a ter razão, e uma lista onde só se pode concordar é uma
   lista que se deixa de abrir.
   ══════════════════════════════════════════════ */
let _wcRepEstado='aberto';

async function wcContarAlertas(){
  const el=document.getElementById('alertas-n');
  if(!el)return;
  try{
    const n=await catRpc('contar_reportes',{});
    el.textContent=Number(n)>0?String(n):'';
    el.classList.toggle('on',Number(n)>0);
  }catch(e){el.textContent='';}
}

async function wcCarregarReportes(estado){
  _wcRepEstado=estado||'aberto';
  const box=document.getElementById('rep-lista');
  if(!box)return;
  box.innerHTML='<div class="wc-card"><p class="wc-note">A carregar…</p></div>';
  try{
    const l=await catRpc('listar_reportes',{p_estado:_wcRepEstado});
    if(!Array.isArray(l)||!l.length){
      box.innerHTML=`<div class="wc-card"><p class="wc-note">${
        _wcRepEstado==='aberto'?'Nada por tratar. ':'Ainda não chegou alerta nenhum. '
      }Os alertas chegam de dentro da Garrafeira, do botão ao lado de um campo que não bate certo com o catálogo.</p></div>`;
      return;
    }
    box.innerHTML=l.map(wcReporteHTML).join('');
  }catch(e){
    box.innerHTML=`<div class="wc-card"><p class="wc-note erro">${esc(e.message)}</p></div>`;
  }
  wcContarAlertas();
}

function wcReporteHTML(r){
  const nome=(()=>{const c=WC_CAMPOS.find(([x])=>x===r.campo);return c?c[1]:r.campo;})();
  const v=x=>(x==null?'<em>vazio</em>':esc(Array.isArray(x)?x.join(', '):String(x)));
  /* O valor de AGORA só aparece quando é DIFERENTE do que estava então —
     senão era repetir a mesma coisa três vezes e fazer o cartão parecer
     mais complicado do que é. */
  const mudou=JSON.stringify(r.valorAgora??null)!==JSON.stringify(r.valorCatalogo??null);
  const f=Number(r.forcaAgora||0);
  return `<div class="wc-card rep">
    <div class="rep-cab">
      <div>
        <div class="cat-nome">${esc(r.nome||'')}${r.ano?` <span class="cat-ano">${esc(String(r.ano))}</span>`:''}</div>
        <div class="cat-sub">${esc(r.produtor||'—')} · campo <strong>${esc(nome)}</strong></div>
      </div>
      <span class="rep-est ${esc(r.estado)}">${esc(r.estado)}</span>
    </div>
    <div class="rep-vals">
      <div><span>no catálogo</span><b>${v(r.valorCatalogo)}</b></div>
      <div class="deles"><span>na garrafeira de quem avisou</span><b>${v(r.valorDeles)}</b></div>
      ${mudou?`<div class="agora"><span>agora</span><b>${v(r.valorAgora)}</b>
        <span class="og-tag ${wcOrigemCls(r.origemAgora,f)}">${esc(wcOrigemTxt(r.origemAgora,f))}</span></div>`:''}
    </div>
    ${r.nota?`<p class="wc-note rep-nota">“${esc(r.nota)}”</p>`:''}
    <p class="wc-note">${esc(r.quem||'')} · ${esc(dataFmt(r.quando))} · ${esc(r.app||'')}</p>
    ${r.resposta?`<p class="wc-note">Resposta: ${esc(r.resposta)}</p>`:''}
    <div class="rep-acoes">
      ${r.vinhoId?`<button class="btn-n" onclick="wcVerFicha(${r.vinhoId})">Abrir a ficha</button>`:
        '<span class="wc-note">Este vinho já não existe no catálogo.</span>'}
      ${r.estado==='aberto'?`
        <button class="btn-n" onclick="wcResolverReporte(${r.id},'resolvido')">Corrigido ✓</button>
        <button class="btn-n" onclick="wcResolverReporte(${r.id},'rejeitado')">O catálogo está certo</button>`
      :`<button class="btn-n" onclick="wcResolverReporte(${r.id},'aberto')">Reabrir</button>`}
    </div>
  </div>`;
}

async function wcResolverReporte(id,estado){
  let resposta=null;
  if(estado==='rejeitado'){
    resposta=prompt('Porquê? (fica guardado com o alerta; deixa vazio se não quiseres explicar)');
    if(resposta===null)return;
  }
  try{
    await catRpc('resolver_reporte',{p_id:id,p_estado:estado,p_resposta:resposta||null});
    toast(estado==='aberto'?'Reaberto':'Tratado ✓');
    wcCarregarReportes(_wcRepEstado);
  }catch(e){toast('Erro: '+e.message,1);}
}

/* ══════════════════════════════════════════════
   UTILIZADORES (admin do catálogo)
   ══════════════════════════════════════════════ */
async function sbRenderPedidos(){
  const box=document.getElementById('adm-pedidos-list');
  if(!box)return;
  try{
    const reqs=await sbReq('GET','access_requests?select=email,requested_at&order=requested_at.asc');
    if(!reqs||!reqs.length){box.innerHTML='<div class="wc-note">Sem pedidos pendentes.</div>';return;}
    box.innerHTML=reqs.map(r=>`
      <div class="ua-row">
        <span>${esc(r.email)}</span>
        <button class="jdel ok" title="Aprovar" onclick="sbAprovarAcesso('${escJs(r.email)}')">✓</button>
        <button class="jdel" title="Recusar" onclick="sbRecusarAcesso('${escJs(r.email)}')">✕</button>
      </div>`).join('');
  }catch(e){box.innerHTML='<div class="wc-note erro">Erro a carregar pedidos.</div>';}
}
async function sbAprovarAcesso(email){
  try{
    await sbReq('POST','allowed_users',{email},{Prefer:'resolution=merge-duplicates'});
    await sbReq('DELETE',`access_requests?email=eq.${encodeURIComponent(email)}`);
    toast('Acesso aprovado ✓');
    sbRenderPedidos();sbRenderUtilizadores();
  }catch(e){toast('Erro: '+e.message,1);}
}
async function sbRecusarAcesso(email){
  try{
    await sbReq('DELETE',`access_requests?email=eq.${encodeURIComponent(email)}`);
    toast('Pedido removido');
    sbRenderPedidos();
  }catch(e){toast('Erro: '+e.message,1);}
}
async function sbRemoverAcesso(email){
  if(!confirm(`Tirar o acesso a ${email}?`))return;
  try{
    await sbReq('DELETE',`allowed_users?email=eq.${encodeURIComponent(email)}`);
    toast('Acesso removido');
    sbRenderUtilizadores();
  }catch(e){toast('Erro: '+e.message,1);}
}

/* A lista dos que têm acesso alimenta três sítios: o painel, o selector da
   password temporária e o de passar o admin. Uma leitura só. */
let _wcUsers=[];
async function sbRenderUtilizadores(){
  const box=document.getElementById('adm-users-list');
  try{
    _wcUsers=await sbReq('GET','allowed_users?select=email&order=email.asc')||[];
  }catch(e){_wcUsers=[];}
  if(box){
    box.innerHTML=_wcUsers.length
      ?_wcUsers.map(u=>`<div class="ua-row">
          <span>${esc(u.email)}${_wcAdminEmail&&u.email.toLowerCase()===_wcAdminEmail?' <em class="ua-adm">admin</em>':''}</span>
          <button class="jdel" title="Tirar acesso" onclick="sbRemoverAcesso('${escJs(u.email)}')">✕</button>
        </div>`).join('')
      :'<div class="wc-note">Ainda ninguém, além do admin.</div>';
  }
  const outros=_wcUsers.filter(u=>u.email.toLowerCase()!==SUPABASE_DONO_EMAIL.toLowerCase());
  const sel=document.getElementById('adm-pt-email');
  if(sel)sel.innerHTML=outros.length
    ?outros.map(u=>`<option value="${esc(u.email)}">${esc(u.email)}</option>`).join('')
    :'<option value="">(sem outros utilizadores)</option>';
  const sel2=document.getElementById('adm-novo-admin');
  if(sel2){
    const cand=_wcUsers.filter(u=>u.email.toLowerCase()!==_wcAdminEmail);
    sel2.innerHTML=cand.length
      ?cand.map(u=>`<option value="${esc(u.email)}">${esc(u.email)}</option>`).join('')
      :'<option value="">(aprova alguém primeiro)</option>';
  }
}

async function wcPassarAdmin(){
  const sel=document.getElementById('adm-novo-admin');
  const email=sel&&sel.value;
  if(!email){toast('Escolhe um utilizador',1);return;}
  if(!confirm(`Passar o catálogo a ${email}?\n\nDeixas de poder aprovar utilizadores e decidir fusões. A conta Supabase continua a ser tua.`))return;
  try{
    await catRpc('definir_admin',{p_email:email});
    toast('Catálogo passado ✓');
    await sbAposLogin();
  }catch(e){toast('Erro: '+e.message,1);}
}

/* A password temporária mexe em `auth.users` — a CONTA, não a app. Fica
   atrás do dono da conta e não do admin do catálogo, e a função no
   servidor volta a confirmar isso (o botão escondido não é segurança). */
async function admGerarPassTemp(){
  const sel=document.getElementById('adm-pt-email');
  const out=document.getElementById('adm-pt-out');
  const email=sel&&sel.value;
  if(!email){toast('Escolhe um utilizador',1);return;}
  const pass='catalogo-'+Math.floor(1000+Math.random()*9000);
  const btn=document.getElementById('adm-pt-btn');
  btn.disabled=true;btn.textContent='A gerar…';
  try{
    const r=await sbFetch(`${SB_URL}/rest/v1/rpc/admin_pass_temp`,{
      method:'POST',headers:sbHeaders(),body:JSON.stringify({p_email:email,p_password:pass})
    });
    const tx=await r.text();
    if(!r.ok){
      let msg=tx;try{msg=JSON.parse(tx).message||msg;}catch(_){}
      out.innerHTML=/does not exist|schema cache/i.test(msg)
        ?'<p class="wc-note erro">Falta correr db/admin_pass_temp.sql no Supabase.</p>'
        :`<p class="wc-note erro">Erro: ${esc(msg)}</p>`;
      return;
    }
    out.innerHTML=`<p class="wc-note ok">Password para <strong>${esc(email)}</strong>: <code>${esc(pass)}</code><br>Dita-a por telefone — a pessoa troca-a em Definições.</p>`;
  }catch(e){
    out.innerHTML='<p class="wc-note erro">Erro de ligação.</p>';
  }finally{
    btn.disabled=false;btn.textContent='Gerar';
  }
}

/* ══════════════════════════════════════════════
   AUTH (Supabase) — mesmo padrão das outras apps
   ══════════════════════════════════════════════ */
function sbRedirectUrl(){return window.location.href.split('#')[0].split('?')[0];}
function sbLimparHash(){window.history.replaceState({},document.title,window.location.pathname);}
function sbAuthStatus(id,txt,cor){
  const s=document.getElementById(id);if(!s)return;
  s.style.display='block';s.textContent=txt;s.style.color=cor||'var(--mu)';
}
function sbLinkFalhou(motivo){
  sbLimparHash();sbMostrarLogin();
  sbAuthStatus('login-status','O link já expirou ou já tinha sido aberto'+(motivo?' ('+motivo+')':'')+'. Escreve antes o código de 6 dígitos que vem no mesmo email.','var(--dg)');
  sbMostrarCaixaCodigo();
}
async function sbTratarHashAuth(){
  const hs=new URLSearchParams((window.location.hash||'').substring(1));
  const qs=new URLSearchParams(window.location.search||'');
  const g=k=>hs.get(k)||qs.get(k);
  const recovery=g('type')==='recovery';

  if(g('error')||g('error_code')){
    const cod=(g('error_code')||'')+' '+(g('error_description')||'');
    if(/expired|invalid|used/i.test(cod)){sbLinkFalhou(g('error_code')||'');return true;}
    sbLimparHash();sbMostrarLogin();
    sbAuthStatus('login-status',g('error_description')||'Não foi possível concluir a autenticação.','var(--dg)');
    return true;
  }

  const token_hash=g('token_hash');
  if(token_hash){
    const r=await fetch(`${SB_URL}/auth/v1/verify`,{
      method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({type:g('type')||'recovery',token_hash})
    });
    if(!r.ok){
      let d={};try{d=await r.json();}catch(_){}
      sbLinkFalhou(d.error_code||d.msg||('HTTP '+r.status));return true;
    }
    sbGuardarSessaoDeVerify(await r.json());
    sbLimparHash();
    if(recovery){sbMostrarNovaPass();return true;}
    await sbAposLogin();
    return true;
  }

  const access_token=g('access_token');
  if(!access_token)return false;
  const refresh_token=g('refresh_token');
  const expires_at=parseInt(g('expires_at'))||Math.floor(Date.now()/1000)+(parseInt(g('expires_in'))||3600);
  const r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${access_token}`}});
  if(!r.ok){sbLinkFalhou('HTTP '+r.status);return true;}
  const u=await r.json();
  sbSaveSession({access_token,refresh_token,expires_at,user:u});
  sbLimparHash();
  if(recovery){sbMostrarNovaPass();return true;}
  await sbAposLogin();
  return true;
}
function sbGuardarSessaoDeVerify(d){
  sbSaveSession({
    access_token:d.access_token,
    refresh_token:d.refresh_token,
    expires_at:d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600),
    user:d.user
  });
}
async function sbInit(){
  try{
    if(await sbTratarHashAuth())return;
  }catch(e){
    if(window.location.hash.length>1||window.location.search.length>1){
      sbLimparHash();sbMostrarLogin();
      sbAuthStatus('login-status','Não foi possível validar o link — sem ligação. Tenta outra vez.','var(--dg)');
      return;
    }
  }
  const stored=localStorage.getItem(SESSION_KEY);
  if(stored){
    try{
      const s=JSON.parse(stored);
      _sbSession=s;
      if(tokenQuaseExpirado())await sbRefresh();
      let r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${_sbSession.access_token}`}});
      if(!r.ok&&_sbSession.refresh_token){
        if(await sbRefresh())
          r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${_sbSession.access_token}`}});
      }
      if(r.ok){const u=await r.json();sbSaveSession({..._sbSession,user:u});await sbAposLogin();return;}
    }catch(e){}
    _sbSession=null;
    localStorage.removeItem(SESSION_KEY);
  }
  sbMostrarLogin();
}
function sbMostrarLogin(){
  document.getElementById('page-login').style.display='flex';
  document.getElementById('page-sem-acesso').style.display='none';
  document.getElementById('page-nova-pass').style.display='none';
  if(window.wcEsconderSplash)window.wcEsconderSplash();
}
async function sbAposLogin(){
  document.getElementById('page-login').style.display='none';
  document.getElementById('page-nova-pass').style.display='none';
  const email=_sbSession.user.email;

  /* Quem manda vem SEMPRE do servidor. A UI só decide que botões mostrar;
     as funções de escrita voltam todas a confirmar, por isso um `false`
     aqui nunca é a única coisa entre alguém e uma fusão. */
  _souAdmin=false;_wcAdminEmail='';
  try{_souAdmin=!!(await catRpc('sou_admin',{}));}catch(e){}

  let data=null;
  try{
    const r=await sbFetch(`${SB_URL}/rest/v1/allowed_users?email=eq.${encodeURIComponent(email)}&select=email`,{headers:sbHeaders()});
    if(r.ok)data=await r.json();
  }catch(e){}

  /* O admin entra sempre, mesmo sem linha em `allowed_users` — igual à
     `is_allowed()` do lado do SQL. Sem isto, apagar a própria linha
     trancava a app e não havia ninguém com direito a destrancá-la. */
  const temLinha=Array.isArray(data)&&data.length>0;
  if(!temLinha&&!_souAdmin){
    document.getElementById('page-sem-acesso').style.display='flex';
    document.getElementById('sem-acesso-email').textContent=`Sessão iniciada como ${email}. Esta conta não tem acesso ao catálogo.`;
    if(window.wcEsconderSplash)window.wcEsconderSplash();
    return;
  }
  document.getElementById('page-sem-acesso').style.display='none';

  const contaEmailEl=document.getElementById('conta-email');
  if(contaEmailEl)contaEmailEl.textContent=`Sessão iniciada como ${email}`;
  const papel=document.getElementById('conta-papel');
  if(papel){
    const ps=[];
    if(_souAdmin)ps.push('admin do catálogo');
    if(souDono())ps.push('dono da conta Supabase');
    papel.textContent=ps.length?'Papel: '+ps.join(' · '):'Acesso de leitura ao catálogo.';
  }

  document.getElementById('fcard-utilizadores').style.display=_souAdmin?'':'none';
  document.getElementById('fcard-admin').style.display=_souAdmin?'':'none';
  document.querySelectorAll('.admin-only').forEach(el=>{el.style.display=_souAdmin?'':'none';});
  if(_souAdmin)wcContarAlertas();
  /* A password temporária é do DONO DA CONTA, não do admin do catálogo:
     mexe em auth.users, e a conta continua a ser de quem a paga mesmo
     depois de o catálogo mudar de mãos. */
  document.getElementById('fcard-passtemp').style.display=souDono()?'':'none';

  if(_souAdmin){
    /* Quem está a ver É o admin (foi o servidor que o disse) — daí o email
       dele servir de resposta a "quem manda". Não há função que o diga a
       quem não é: a `winecatalog.admin_email()` está revogada a
       `authenticated` de propósito, que a lista de quem entra já chega. */
    _wcAdminEmail=String(email||'').toLowerCase();
    sbRenderPedidos();
    await sbRenderUtilizadores();
    const at=document.getElementById('admin-atual');
    if(at)at.textContent=`Agora é ${email}.`;
  }
  restaurarTab();
  if(window.wcEsconderSplash)window.wcEsconderSplash();
}
async function sbLoginGoogle(){
  window.location.href=`${SB_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(sbRedirectUrl())}`;
}
async function sbRecuperarPassword(){
  const email=document.getElementById('login-email').value.trim();
  if(!email||!email.includes('@')){
    sbAuthStatus('login-status','Escreve primeiro o teu email aqui em cima e volta a tocar.','var(--dg)');
    document.getElementById('login-email').focus();return;
  }
  sbAuthStatus('login-status','A enviar email…');
  try{
    const r=await fetch(`${SB_URL}/auth/v1/recover?redirect_to=${encodeURIComponent(sbRedirectUrl())}`,{
      method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({email})
    });
    if(r.status===429){sbAuthStatus('login-status','Já foi pedido um email há pouco. Espera uns minutos e tenta outra vez.','var(--dg)');return;}
    if(!r.ok){
      let d={};try{d=await r.json();}catch(_){}
      sbAuthStatus('login-status',d.error_description||d.msg||d.message||'Não foi possível enviar o email.','var(--dg)');return;
    }
    sbAuthStatus('login-status','Se houver conta com esse email, chega já o link e o código para definires uma password nova. Vê também o spam.','var(--vd)');
    sbMostrarCaixaCodigo();
  }catch(e){sbAuthStatus('login-status','Erro de ligação.','var(--dg)');}
}
function sbMostrarCaixaCodigo(){
  const box=document.getElementById('login-codigo');
  if(box)box.style.display='';
}
async function sbVerificarCodigo(){
  const email=document.getElementById('login-email').value.trim();
  const token=document.getElementById('login-cod').value.replace(/\s/g,'');
  if(!email||!email.includes('@')){
    sbAuthStatus('login-status','Escreve também o teu email aqui em cima — o código é confirmado com ele.','var(--dg)');
    document.getElementById('login-email').focus();return;
  }
  if(!token){sbAuthStatus('login-status','Escreve o código que veio no email.','var(--dg)');return;}
  const btn=document.getElementById('btn-login-cod');
  btn.disabled=true;btn.textContent='A confirmar…';
  try{
    const r=await fetch(`${SB_URL}/auth/v1/verify`,{
      method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({type:'recovery',email,token})
    });
    if(!r.ok){
      let d={};try{d=await r.json();}catch(_){}
      const msg=d.error_description||d.msg||d.message||'';
      sbAuthStatus('login-status',(!msg||/expired|invalid|token/i.test(msg))
        ?'Código errado ou já expirado. Confirma os dígitos ou pede outro email.':msg,'var(--dg)');
      btn.disabled=false;btn.textContent='Confirmar código';return;
    }
    sbGuardarSessaoDeVerify(await r.json());
    document.getElementById('login-cod').value='';
    btn.disabled=false;btn.textContent='Confirmar código';
    sbMostrarNovaPass();
  }catch(e){
    sbAuthStatus('login-status','Erro de ligação.','var(--dg)');
    btn.disabled=false;btn.textContent='Confirmar código';
  }
}
function sbMostrarNovaPass(){
  document.getElementById('page-login').style.display='none';
  document.getElementById('page-sem-acesso').style.display='none';
  document.getElementById('page-nova-pass').style.display='flex';
  const sub=document.getElementById('nova-pass-sub');
  if(sub&&_sbSession&&_sbSession.user)sub.textContent=`Escolhe uma password nova para ${_sbSession.user.email}.`;
  if(window.wcEsconderSplash)window.wcEsconderSplash();
}
function sbValidarPass(p1,p2){
  if(p1.length<6)return 'A password tem de ter pelo menos 6 caracteres.';
  if(p1!==p2)return 'As duas passwords não são iguais.';
  return '';
}
async function sbTrocarPassword(password){
  let r;
  try{
    r=await sbFetch(`${SB_URL}/auth/v1/user`,{
      method:'PUT',
      headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({password})
    });
  }catch(e){return 'Erro de ligação — tenta outra vez.';}
  if(r.ok)return '';
  let d={};try{d=await r.json();}catch(_){}
  const msg=d.error_description||d.msg||d.message||('HTTP '+r.status);
  if(/should be different/i.test(msg))return 'Essa já é a password atual — escolhe outra.';
  if(r.status===401||r.status===403)return 'A sessão do link já expirou. Pede outro email de recuperação.';
  return msg;
}
async function sbDefinirNovaPassword(){
  const p1=document.getElementById('nova-pass-1').value;
  const p2=document.getElementById('nova-pass-2').value;
  const erro=sbValidarPass(p1,p2);
  if(erro){sbAuthStatus('nova-pass-status',erro,'var(--dg)');return;}
  const btn=document.getElementById('btn-nova-pass');
  btn.disabled=true;btn.textContent='A guardar…';
  const falha=await sbTrocarPassword(p1);
  if(falha){
    sbAuthStatus('nova-pass-status',falha,'var(--dg)');
    btn.disabled=false;btn.textContent='Guardar password';return;
  }
  document.getElementById('nova-pass-1').value='';
  document.getElementById('nova-pass-2').value='';
  document.getElementById('nova-pass-campos').style.display='none';
  document.getElementById('btn-nova-pass-entrar').style.display='';
  sbAuthStatus('nova-pass-status','Password alterada ✓ Se abriste este link fora da app, volta a abrir a app instalada e entra com o email e a password nova.','var(--vd)');
}
function toggleAdmPass(){
  const box=document.getElementById('adm-pass-box');
  if(!box)return;
  box.style.display=box.style.display==='none'?'':'none';
  const st=document.getElementById('adm-pass-status');
  if(st)st.textContent='';
}
async function sbAlterarPassword(){
  const st=document.getElementById('adm-pass-status');
  const p1=document.getElementById('adm-pass-1').value;
  const p2=document.getElementById('adm-pass-2').value;
  const erro=sbValidarPass(p1,p2);
  if(erro){st.style.color='var(--dg)';st.textContent=erro;return;}
  st.style.color='var(--mu)';st.textContent='A guardar…';
  const falha=await sbTrocarPassword(p1);
  if(falha){st.style.color='var(--dg)';st.textContent=falha;return;}
  document.getElementById('adm-pass-1').value='';
  document.getElementById('adm-pass-2').value='';
  st.style.color='var(--vd)';st.textContent='Password alterada ✓';
  toast('Password alterada ✓');
}
async function sbLoginEmail(){
  const email=document.getElementById('login-email').value.trim();
  const password=document.getElementById('login-password').value;
  const status=document.getElementById('login-status');
  status.style.display='block';status.textContent='A entrar…';status.style.color='var(--mu)';
  try{
    const r=await fetch(`${SB_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const d=await r.json();
    if(!r.ok){status.style.color='var(--dg)';status.textContent=d.error_description||d.msg||'Erro ao entrar.';return;}
    sbSaveSession({access_token:d.access_token,refresh_token:d.refresh_token,expires_at:d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600),user:d.user});
    await sbAposLogin();
  }catch(e){status.style.color='var(--dg)';status.textContent='Erro de ligação.';}
}
async function sbRegistarEmail(){
  const email=document.getElementById('login-email').value.trim();
  const password=document.getElementById('login-password').value;
  const status=document.getElementById('login-status');
  status.style.display='block';status.textContent='A criar conta…';status.style.color='var(--mu)';
  try{
    const r=await fetch(`${SB_URL}/auth/v1/signup`,{method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const d=await r.json();
    if(!r.ok){status.style.color='var(--dg)';status.textContent=d.error_description||d.msg||'Erro ao criar conta.';return;}
    /* O login (auth.users) é partilhado por todo o projeto Supabase. Email
       já registado noutra app: o GoTrue devolve 200 sem enviar confirmação,
       mas com identities:[]. */
    if(d.user&&Array.isArray(d.user.identities)&&d.user.identities.length===0){
      status.style.color='var(--dg)';status.textContent='Esta conta já existe (ex.: já criaste login na Garrafeira ou na WineSelection). Não é preciso criar de novo — carrega em "Entrar" com o mesmo email e password.';
      return;
    }
    status.style.color='var(--vd)';status.textContent='Conta criada! Confirma o email e volta a entrar.';
  }catch(e){status.style.color='var(--dg)';status.textContent='Erro de ligação.';}
}
async function sbSolicitarAcesso(){
  if(!_sbSession)return;
  const btn=document.getElementById('btn-solicitar');
  const btnV=document.getElementById('btn-verificar');
  const status=document.getElementById('solicitar-status');
  btn.disabled=true;btn.textContent='A enviar…';
  try{
    const r=await sbFetch(`${SB_URL}/rest/v1/access_requests`,{
      method:'POST',
      headers:sbHeaders({'Prefer':'return=minimal'}),
      body:JSON.stringify({email:_sbSession.user.email})
    });
    if(r.ok||r.status===409){
      status.style.display='block';status.style.color='var(--vd)';
      status.textContent=r.status===409?'✓ O pedido já estava registado. Aguarda aprovação.':'✓ Pedido enviado! Aguarda aprovação.';
      btn.style.display='none';
      btnV.style.display='';
      return;
    }
    let msg='HTTP '+r.status;
    try{const j=await r.json();msg=j.message||msg;}catch(_){}
    if(r.status===401)msg='Sessão expirada — sai e volta a entrar.';
    status.style.display='block';status.style.color='var(--dg)';
    status.textContent='Erro ao enviar pedido: '+msg;
    btn.disabled=false;btn.textContent='Solicitar acesso';
  }catch(e){
    status.style.display='block';status.style.color='var(--dg)';
    status.textContent='Erro de ligação — tenta novamente.';
    btn.disabled=false;btn.textContent='Solicitar acesso';
  }
}
async function sbVerificarAcesso(){
  const btn=document.getElementById('btn-verificar');
  const status=document.getElementById('solicitar-status');
  btn.disabled=true;btn.textContent='A verificar…';
  await sbAposLogin();
  btn.disabled=false;btn.textContent='🔄 Verificar acesso';
  status.style.display='block';status.style.color='var(--mu)';
  status.textContent='Acesso ainda não aprovado. Tenta mais tarde.';
}
function sbLogout(){
  localStorage.removeItem(SESSION_KEY);
  _sbSession=null;
  window.location.reload();
}

/* ── INIT ──────────────────────────────────── */
document.addEventListener('DOMContentLoaded',()=>{sbInit();});
document.addEventListener('keydown',(e)=>{if(e.key==='Escape')wcFecharFicha();});
