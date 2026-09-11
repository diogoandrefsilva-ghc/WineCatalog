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

/* ── TABS ──────────────────────────────────── */
function itab(tab){
  document.querySelectorAll('#app-sec > .itabs > .it').forEach(b=>b.classList.toggle('on',b.dataset.tab===tab));
  document.querySelectorAll('#app-sec > .tp').forEach(p=>p.classList.remove('on'));
  const el=document.getElementById('t-'+tab);
  if(el)el.classList.add('on');
  try{localStorage.setItem('wc_tab',tab);}catch(e){}
  if(tab==='resumo')wcCarregarResumo();
  if(tab==='catalogo')wcCarregarCatalogo(true);
  if(tab==='duplicados')wcCarregarDuplicados();
}
function restaurarTab(){
  let tab=null;
  try{tab=localStorage.getItem('wc_tab');}catch(e){}
  if(!tab||!document.getElementById('t-'+tab))tab='resumo';
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
  const conta=document.getElementById('cat-conta');
  if(!lista)return;
  if(reset){_wcSaltar=0;lista.innerHTML='<div class="wc-card"><p class="wc-note">A carregar…</p></div>';}
  if(mais)mais.innerHTML='';
  try{
    const d=await catRpc('listar',{p_procura:_wcProcura||null,p_limite:50,p_saltar:_wcSaltar});
    const linhas=(d&&d.linhas)||[];
    _wcTotal=Number((d&&d.total)||0);
    if(reset)lista.innerHTML='';
    if(!linhas.length&&!_wcSaltar){
      lista.innerHTML=`<div class="wc-card"><p class="wc-note">${_wcProcura?'Nada no catálogo com isso.':'O catálogo está vazio.'}</p></div>`;
    }else{
      lista.insertAdjacentHTML('beforeend',linhas.map(wcLinhaHTML).join(''));
    }
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

function wcLinhaHTML(v){
  const sub=[v.produtor,v.regiao].filter(Boolean).join(' · ');
  const castas=Array.isArray(v.castas)?v.castas.join(', '):'';
  return `<div class="cat-row" onclick="wcVerFicha(${v.id})">
    <div class="cat-main">
      <div class="cat-nome">${esc(v.nome||'(sem nome)')}${v.ano?` <span class="cat-ano">${esc(String(v.ano))}</span>`:''}</div>
      <div class="cat-sub">${esc(sub||'—')}${castas?` · <em>${esc(castas)}</em>`:''}</div>
    </div>
    <div class="cat-lado">
      ${v.nota!=null?`<span class="cat-nota">${esc(String(v.nota))}</span>`:''}
      <span class="cat-campos" title="campos preenchidos">${nFmt(v.campos)}</span>
      <span class="forca f${esc(String(v.forca))}" title="força máxima de um campo desta linha">${esc(String(v.forca))}</span>
    </div>
  </div>`;
}

/* ── A FICHA: campo a campo, de onde veio ────── */
async function wcVerFicha(id){
  const m=document.getElementById('modal-ficha');
  const corpo=document.getElementById('ficha-corpo');
  const tit=document.getElementById('ficha-titulo');
  if(!m)return;
  tit.innerHTML='<div class="fi-nome">A carregar…</div>';
  corpo.innerHTML='';
  m.classList.add('on');
  try{
    const v=await catRpc('ver',{p_id:id});
    if(!v){corpo.innerHTML='<p class="wc-note">Essa linha já não existe.</p>';return;}
    tit.innerHTML=`<div class="fi-nome">${esc(v.nome||'(sem nome)')}${v.ano?` <span class="cat-ano">${esc(String(v.ano))}</span>`:''}</div>
      <div class="fi-sub">${esc(v.produtor||'(sem produtor)')}</div>`;
    corpo.innerHTML=wcFichaHTML(v);
  }catch(e){
    corpo.innerHTML=`<p class="wc-note erro">${esc(e.message)}</p>`;
  }
}
function wcFecharFicha(ev){
  if(ev&&ev.target&&ev.target.id!=='modal-ficha')return;
  const m=document.getElementById('modal-ficha');
  if(m)m.classList.remove('on');
}

function wcFichaHTML(v){
  const ficha=v.ficha||{};
  const origens=v.origens||{};
  /* Primeiro os campos pela ordem conhecida, depois os que a lista não
     conhece — um campo novo numa das outras apps aparece na mesma. */
  const conhecidos=WC_CAMPOS.filter(([k])=>k in ficha);
  const extra=Object.keys(ficha).filter(k=>!WC_CAMPOS.some(([c])=>c===k)).map(k=>[k,k]);
  const todos=conhecidos.concat(extra);

  let h='';
  if(!todos.length){
    h+='<p class="wc-note">Esta linha ainda não tem campo nenhum — só a identidade.</p>';
  }else{
    h+=`<div class="wc-card-label">A ficha, campo a campo</div>
    <p class="wc-note">Cada linha diz <strong>de onde veio</strong> e <strong>com que força</strong>. É a força que decide quem ganha quando duas leituras discordam — e é ela que impede um número copiado à pressa de tapar uma pesquisa que se pagou.</p>
    <div class="fi-campos">`;
    for(const [k,lbl] of todos){
      const o=origens[k]||{};
      const f=Number(o.f||0);
      const velho=WC_VOLATEIS.includes(k)&&o.em&&
        (Date.now()-new Date(o.em).getTime())>30*86400000;
      h+=`<div class="fi-campo">
        <div class="fi-k">${esc(lbl)}</div>
        <div class="fi-v">${wcValorHTML(k,ficha[k])}</div>
        <div class="fi-o">
          <span class="og-tag ${wcOrigemCls(o.o,f)}">${esc(wcOrigemTxt(o.o,f))}</span>
          <span class="forca f${esc(String(f))}">${esc(String(f))}</span>
          <span class="fi-em">${esc(dataFmt(o.em))}${velho?' <b title="campo volátil com mais de 30 dias — as apps voltam a pedi-lo à IA">envelhecido</b>':''}</span>
        </div>
      </div>`;
    }
    h+='</div>';
  }

  const fontes=v.fontes||[];
  if(fontes.length){
    h+=`<div class="divi"></div><div class="wc-card-label">Fontes</div>
    <div class="fi-fontes">${fontes.map(f=>
      `<a href="${esc(f.url||'#')}" target="_blank" rel="noopener">${esc(f.titulo||f.url||'fonte')}</a>`).join('')}</div>`;
  }

  h+=`<div class="divi"></div><div class="wc-card-label">Identidade</div>
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
    h+=`<div class="divi"></div><div class="wc-card-label">Linhas fundidas nesta</div>`;
    h+=al.map(a=>`<div class="fi-alias">
      <div>
        <strong>${esc(a.nome||a.chaveDe)}</strong>${a.ano?` <span class="cat-ano">${esc(String(a.ano))}</span>`:''}
        <div class="wc-note">${esc(a.campos)} campos passaram · ${esc(dataFmt(a.quando))}${a.quem?' · '+esc(a.quem):''}</div>
      </div>
      ${isAdmin()?`<button class="btn-n" onclick="wcSeparar('${escJs(a.chaveDe)}',${v.id})">Desfazer</button>`:''}
    </div>`).join('');
  }
  return h;
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
