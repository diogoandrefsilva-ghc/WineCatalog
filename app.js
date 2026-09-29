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
  if(tab==='cfg'){wcCarregarNumeros();if(isAdmin())wcVivinoConfig();}
  if(tab==='catalogo')wcCarregarCatalogo(true);
  if(tab==='duplicados')wcCarregarDuplicados();
  if(tab==='alertas'){wcCarregarReportes('aberto');wcComentarios('vinho','aberto');wcComentarios('sugestao','aberto');
    wcVivinoLista('pendente');wcHistorico(null,'hist-lista');}
}
function restaurarTab(){
  let tab=null;
  try{tab=localStorage.getItem('wc_tab');}catch(e){}
  /* "#alertas" no endereço (o toque numa notificação de um comentário, ou o
     "Abrir no WineCatalog" da Garrafeira) manda sobre o separador guardado. */
  if(location.hash==='#alertas'){
    tab='alertas';
    history.replaceState(null,'',location.pathname+location.search);
  }
  if(!tab||!document.getElementById('t-'+tab))tab='catalogo';
  /* O painel dos alertas existe no HTML para toda a gente (é o botão que
     está escondido), por isso quem deixou de ser admin voltava a cair nele
     e apanhava um "só o admin vê os alertas" à entrada. */
  if(tab==='alertas'&&!isAdmin())tab='catalogo';
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
  'garrafeira-desejo':{txt:'wishlist de uma garrafeira', cls:'og-fraca'},
  'prenda':          {txt:'prenda de anos (AnniversaryGifts)', cls:'og-fraca'},
  'ws-verificacao':  {txt:'verificação com pesquisa Google', cls:'og-forte'},
  'ws-sugestao':     {txt:'sugestão da carta (com pesquisa)', cls:'og-media'},
  'vinho-info-premium':{txt:'procura da Garrafeira (grounding)', cls:'og-media'},
  'vinho-info-gratis': {txt:'procura da Garrafeira (pesquisa + extração)', cls:'og-media'},
  'catalogo-admin':  {txt:'correção à mão (admin)', cls:'og-forte'},
  'catalogo-pesquisa':{txt:'pesquisa do catálogo', cls:'og-forte'},
  /* O script dos links e dos preços (batch/vivino-verificar.mjs) */
  'vivino-pagina':   {txt:'página do Vivino (script)', cls:'og-forte'},
  'vivino-serper':   {txt:'Google → Vivino (script Serper)', cls:'og-media'},
  'loja-garrafeira-nacional':{txt:'Garrafeira Nacional (loja)', cls:'og-forte'},
  'loja-granvine':   {txt:'Granvine (loja)', cls:'og-forte'},
  'loja-vinha':      {txt:'Vinha.pt (loja)', cls:'og-forte'},
  'lojas-script':    {txt:'lojas e Vivino (script)', cls:'og-forte'},
  /* Um valor posto de volta à mão depois de um erro, sem se saber de onde
     tinha vindo: força 0, a próxima fonte a sério passa-lhe por cima. */
  'reposto':         {txt:'reposto à mão (origem perdida)', cls:'og-fraca'}
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
  ['vivino_nota','Nota Vivino (colheita)'],['vivino_avaliacoes','Avaliações Vivino (colheita)'],
  ['vivino_url','Vivino'],['preco_medio','Preço de referência'],
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
  vivino_nota_global:'vivinoNotaGlobal',vivino_avaliacoes_global:'vivinoAvaliacoesGlobal',
  preco_medio:'precoMedio',beber_de:'beberDe',beber_ate:'beberAte',notas_prova:'notasProva',
  harmonizacao:'harmonizacao',ai_resumo:'resumo',
  /* O PRODUTOR não é campo da ficha — é IDENTIDADE (faz parte da `chave`) —
     mas continua a ser sempre uma das opções que se pode pedir à pesquisa,
     mesmo já preenchido: só pode vir DIFERENTE por engano de quem escreveu.
     O que a pesquisa devolve nunca escreve sozinho — como tudo o resto, é
     uma linha da revisão; marcada, vai pela `editar` com o interruptor de
     identidade, que recusa se passar a ser a mesma linha que outra. */
  produtor:'produtorConfirmado'
};
/* Os que envelhecem (winecatalog.volatil). A lista está repetida do SQL de
   propósito e SÓ para efeitos de ECRÃ — quem decide se um campo expirou é
   sempre a BD, na `procurar`. Aqui serve só para pôr um aviso ao lado de
   um preço de há oito meses, que é coisa que quem olha quer saber. */
const WC_VOLATEIS=['vivino_nota','vivino_avaliacoes','vivino_url','vivino_nota_global','vivino_avaliacoes_global',
  'preco_medio','imagem_url','precos'];
/* Campos que NÃO entram em WC_CAMPOS e aparecem na ficha com este nome: o
   `precos` (só o script o escreve; nenhuma pesquisa sabe o que é) e as
   duas notas de todas as colheitas (ver WC_VIVINO_GLOBAL). */
const WC_ROTULOS_EXTRA={precos:'Preços nas lojas',
  vivino_nota_global:'Nota Vivino (todas as colheitas)',
  vivino_avaliacoes_global:'Avaliações Vivino (todas as colheitas)'};
/* A NOTA DO VIVINO SÃO DUAS (26/09/2026, pedido do dono). `vivino_nota`/
   `vivino_avaliacoes` são as da COLHEITA (o script abre a página com
   `?year=`); estas são as de TODAS as colheitas (a página sem ano). Um 4,5
   com 40 avaliações de 2019 e um 4,2 com 5000 do vinho todo respondem a
   perguntas diferentes. Ficam fora de `WC_CAMPOS` só por causa da ORDEM da
   ficha (ver `WC_FICHA`, logo abaixo). Desde 27/09/2026 as pesquisas também
   as pedem (`vivinoNotaGlobal`/`vivinoAvaliacoesGlobal`): até aí não as
   conheciam, e a média de todas as colheitas ia parar à nota da COLHEITA. */
const WC_VIVINO_GLOBAL=['vivino_nota_global','vivino_avaliacoes_global'];
/* A ordem da FICHA: a de `WC_CAMPOS`, com a nota de todas as colheitas logo
   a seguir à da colheita — lida ao lado dela, e não perdida no fim. */
const WC_FICHA=WC_CAMPOS.flatMap(c=>c[0]==='vivino_avaliacoes'
  ?[c].concat(WC_VIVINO_GLOBAL.map(k=>[k,WC_ROTULOS_EXTRA[k]])):[c]);
/* Total de campos que se podem PEDIR à pesquisa — os da ficha (`WC_FICHA`:
   os de WC_CAMPOS e as duas notas de todas as colheitas) mais o Produtor, que não está lá por não ser campo de ficha. Usa-se para
   decidir quando "todos estão marcados" (e por isso não vale a pena escrever
   "SÓ INTERESSAM ESTES CAMPOS" no prompt manual). */
const WC_PROC_TOTAL=WC_FICHA.length+1;
/* QUAL DAS DUAS SE MOSTRA num cartão — a mesma regra do `notaVivino` da
   Garrafeira (mexer numa é mexer na outra, no mesmo dia):
   · a da colheita, se tiver pelo menos 100 avaliações;
   · senão a que tiver MAIS avaliações — que é quase sempre a de todas as
     colheitas (o vinho todo não pode ter menos do que um dos anos dele);
     em empate, a de todas. É isto que resolve o caso de nenhuma chegar às
     100: ganha a que mais gente avaliou.
   Uma nota sem contagem conta como zero avaliações; só uma das duas, é essa.
   Nunca uma média das duas: era um número que ninguém encontra no Vivino. */
const WC_VIVINO_MIN_AVAL=100;
function wcNotaVivino(nota,aval,notaG,avalG){
  const n=x=>{if(x==null||x==='')return null;const v=Number(x);return isFinite(v)?v:null;};
  const c=n(nota)!=null?{nota:n(nota),aval:n(aval),de:'colheita'}:null;
  const g=n(notaG)!=null?{nota:n(notaG),aval:n(avalG),de:'global'}:null;
  if(!c||!g)return c||g;
  if((c.aval||0)>=WC_VIVINO_MIN_AVAL)return c;
  return (c.aval||0)>(g.aval||0)?c:g;
}
/* A mesma escolha a partir de uma FICHA (a ficha aberta, a revisão). */
function wcNotaVivinoFicha(f){
  f=f||{};
  return wcNotaVivino(f.vivino_nota,f.vivino_avaliacoes,f.vivino_nota_global,f.vivino_avaliacoes_global);
}
/* O porquê, para o `title` do crachá. */
function wcNotaVivinoTitulo(nv,ano){
  if(!nv)return '';
  const q=nv.aval!=null?` · ${nFmt(nv.aval)} avaliações`:'';
  return nv.de==='global'?`Nota do Vivino de todas as colheitas${q}`
    :`Nota do Vivino${ano?' da colheita '+ano:''}${q}`;
}
/* A nota de uma LINHA da lista (`resumo_linha`): a estrela e, quando é a de
   todas as colheitas, a palavra "todas" — a da colheita é o normal e não
   leva nada (até 26/09/2026 era a única, e muita veio de pesquisas sem
   colheita; chamar-lhe "da colheita" no cartão era dizer o que não se sabe). */
function wcNotaLinhaHTML(v,cls){
  const nv=wcNotaVivino(v.nota,v.aval,v.notaGlobal,v.avalGlobal);
  if(!nv)return '';
  return `<span class="${cls||'cat-nota'}" title="${esc(wcNotaVivinoTitulo(nv,v.ano))}">★ ${esc(String(nv.nota))}${
    nv.de==='global'?' <small class="nota-de">todas</small>':''}</span>`;
}
const WC_LOJAS_NOMES={garrafeira_nacional:'Garrafeira Nacional',granvine:'Granvine',vinha:'Vinha.pt',
  vivino:'Vivino'};

function wcValorHTML(k,v){
  if(v==null)return '—';
  if(k==='precos'&&typeof v==='object'&&!Array.isArray(v)){
    /* Pela ordem da prioridade do preço de mercado: GN → Granvine → Vinha →
       Vivino (a do script, `PRIORIDADE_PRECO`). */
    return WC_PRECO_PRIORIDADE.filter(l=>v[l]&&v[l].preco!=null).map(l=>{
      const x=v[l];
      const t=`${esc(WC_LOJAS_NOMES[l]||l)} ${esc(eurFmt(x.preco))}${x.colheita?` (colheita ${esc(String(x.colheita))})`:''}`;
      const a=x.url?`<a href="${esc(x.url)}" target="_blank" rel="noopener">${t}</a>`:t;
      return (x.retirado?`<s>${a}</s> <span class="wc-note">· retirado à mão</span>`:a)+
        (x.em&&!x.retirado?` <span class="wc-note">· ${esc(x.em)}</span>`:'');
    }).join('<br>')||'—';
  }
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
   O CATÁLOGO EM NÚMEROS — tamanho e de onde veio cada campo

   Até 23/09/2026 isto era a metade de baixo de um separador "Resumo" cuja
   metade de cima respondia a "quanto é que o catálogo está a poupar?".
   Essa é uma pergunta de CUSTO e passou para a app AI-API-Control
   (`ia_uso.poupanca_catalogo`, que lê a mesma `winecatalog.consumo`) —
   duas apps a dizer quanto se gastou, com números diferentes, era o erro
   de sempre. Ficou aqui o que é do CATÁLOGO, em Definições.
   ══════════════════════════════════════════════ */
async function wcCarregarNumeros(){
  const box=document.getElementById('numeros-box');
  if(!box)return;
  box.innerHTML='<div class="wc-card"><p class="wc-note">A carregar…</p></div>';
  try{
    box.innerHTML=wcNumerosHTML(await catRpc('resumo',{}));
  }catch(e){
    box.innerHTML=`<div class="wc-card"><p class="wc-note erro">${esc(e.message)}</p></div>`;
  }
}

function wcNumerosHTML(cat){
  let h='';
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
/* Chave, ícone e nome de cada campo da FITA. Os ícones são os mesmos da
   Garrafeira (`F_CAMPOS`), de propósito: quem anda nas duas apps não
   aprende duas maneiras de dizer "Região". */
const WC_GRUPOS=[['tipos','🍷','Tipo'],['regioes','🗺️','Região'],['castas','🍇','Castas'],['precos','💶','Preço de referência']];
let _wcFiltros={tipos:[],regioes:[],castas:[],precos:[]};
let _wcFacetas=null;
/* O PAINEL É PROGRESSIVO, como o da Garrafeira. Era tudo ou nada: aberto,
   os quatro grupos vinham com todas as opções à mostra — dezenas de
   regiões e castas — e quem só queria escrever "crasto" tinha meio ecrã de
   cartões entre a caixa de procura e a resposta. Agora:
     · a PROCURA LIVRE está sempre à vista, fechado ou aberto;
     · o botão "Filtros" abre uma FITA com os quatro campos, e só os
       valores do campo tocado (`_wcCampo`) abrem por baixo.
   O ESTADO (fita aberta ou não) grava-se — é como a pessoa gosta de
   trabalhar; o CAMPO aberto não — é onde ela ia a meio de uma pergunta.
   A chave é nova (`wc_filtros_aberto`) e não a `wc_painel` de antes: essa
   ficava a '1' por omissão em toda a gente, e herdá-la abria a fita a
   quem nunca lhe tinha tocado. */
let _wcPainel=false;
let _wcCampo=null;
let _wcModo='lista';
/* Só as castas têm duas leituras possíveis: escolher Touriga Nacional e
   Syrah pode querer dizer "qualquer um dos dois" (o costume, e o que
   estava) ou "os lotes que levam as duas". Um vinho tem UM tipo e UMA
   região — ali a pergunta não se põe, e por isso o visto não aparece. */
let _wcCastasTodas=false;
try{
  _wcPainel=localStorage.getItem('wc_filtros_aberto')==='1';
  _wcModo=localStorage.getItem('wc_modo')==='grelha'?'grelha':'lista';
  _wcCastasTodas=localStorage.getItem('wc_castas_todas')==='1';
}catch(e){}

// Só os valores escolhidos, sem o texto: é o número do botão "Filtros" —
// o texto já se lê na própria caixa, que nunca se esconde.
function wcNFiltros(){
  return _wcFiltros.tipos.length+_wcFiltros.regioes.length+
         _wcFiltros.castas.length+_wcFiltros.precos.length;
}
function wcRotulo(g,v){
  return g==='precos'?(WC_FAIXAS.find(x=>x[0]===v)||[v,v])[1]:v;
}
function wcArg(g){return _wcFiltros[g].length?_wcFiltros[g]:null;}

/* O invólucro escreve-se UMA vez: a caixa de procura não pode ser reposta
   a cada tecla nem a cada abrir/fechar, ou perde-se o cursor. O que se
   repinta são os contentores vazios (`wcPintarGrupos`). */
function wcShellFiltros(){
  const el=document.getElementById('cat-filtros');
  if(!el)return;
  /* "+ Vinho novo" mudou-se daqui para o FAB (ver `wcFabAcao`) — ganhou
     companhia ("Atualizar informação") e não fazia sentido um botão de
     texto ao lado de um "+" flutuante a fazer a mesma coisa. */
  el.innerHTML=`<div class="wc-card cf" id="cf">
    <div class="cf-linha">
      <div class="cf-procura">
        <span>🔍</span>
        <input type="text" id="cat-procura" value="${esc(_wcProcura)}"
               placeholder="nome, produtor, casta…"
               oninput="wcProcuraMudou()" autocomplete="off">
        <button class="cf-x${_wcProcura?' on':''}" id="cat-procura-x" onclick="wcLimparTexto()" title="Limpar">✕</button>
      </div>
      <button class="cf-toggle" onclick="wcAlternarPainel()">Filtros <span class="cf-n" id="cf-n"></span> <span class="cf-seta">▾</span></button>
    </div>
    <div class="cf-campos" id="cat-campos"></div>
    <div class="cf-dom" id="cat-grupos"></div>
    <div class="cf-activos" id="cat-activos"></div>
  </div>`;
  wcPintarGrupos();
}

function wcPintarGrupos(){
  const cf=document.getElementById('cf');
  if(!cf)return;
  cf.classList.toggle('aberto',_wcPainel);

  /* A FITA. Cada campo leva o número de valores que tem ligados — é o que
     diz, sem abrir nenhum, onde está o filtro que está a cortar a lista. */
  document.getElementById('cat-campos').innerHTML=WC_GRUPOS.map(([g,ico,nome])=>{
    const n=_wcFiltros[g].length;
    return `<button class="cf-campo${n?' ativo':''}${_wcCampo===g?' aberto':''}"
      onclick="wcAbrirCampo('${escJs(g)}')">${ico} ${esc(nome)}${n?`<i class="cf-cn">${n}</i>`:''}</button>`;
  }).join('');

  /* OS VALORES do campo aberto, e só desse. */
  const dom=document.getElementById('cat-grupos');
  const g=_wcPainel?_wcCampo:null;
  if(g){
    const f=_wcFacetas||{};
    let ops=(f[g]||[]).slice();
    /* Uma opção escolhida nunca desaparece da lista, mesmo que as facetas
       já não a devolvam — senão não havia como a desmarcar. */
    _wcFiltros[g].forEach(v=>{if(!ops.some(o=>o.v===v))ops.push({v,n:0});});
    if(g==='precos')ops.sort((a,b)=>WC_FAIXAS.findIndex(x=>x[0]===a.v)-WC_FAIXAS.findIndex(x=>x[0]===b.v));
    const visto=g!=='castas'?'':
      `<div class="cf-tit-l">
         <button class="cf-modo${_wcCastasTodas?' on':''}" onclick="wcCastasModo()"
                 title="${_wcCastasTodas
                   ?'A mostrar só os vinhos que levam TODAS as castas escolhidas'
                   :'A mostrar os vinhos que levam QUALQUER UMA das castas escolhidas'}">
           <i class="cf-visto">✓</i> todas em simultâneo
         </button>
       </div>`;
    dom.innerHTML=visto+(ops.length
      ? `<div class="cf-ops">${ops.map(o=>{
          const on=_wcFiltros[g].includes(o.v);
          const cor=g==='tipos'?(WC_VIDRO[o.v]||'#8a7a7d'):null;
          return `<button class="cf-op${on?' on':''}" onclick="wcFiltroToggle('${escJs(g)}','${escJs(o.v)}')">
            <span class="cf-op-tx">${cor?`<i class="cf-ponto" style="background:${esc(cor)}"></i>`:''}${esc(wcRotulo(g,o.v))}</span>
            <span class="cf-conta">${nFmt(o.n)}</span>
          </button>`;
        }).join('')}</div>`
      : `<p class="wc-note" style="margin:0">Nada a escolher aqui com os filtros que estão ligados.</p>`);
  }else dom.innerHTML='';

  /* AS PASTILHAS DIZEM O QUE NÃO SE VÊ: todos os valores ligados menos os
     do campo aberto, que já se leem nos cartões acesos. O "+" entre duas
     castas só existe em "todas em simultâneo" — sem ele, "Touriga
     Nacional · Syrah" mentia sobre metade dos resultados. */
  const p=[];
  WC_GRUPOS.forEach(([gg,ico])=>{
    if(gg===g)return;
    _wcFiltros[gg].forEach((v,i)=>{
      if(i&&gg==='castas'&&_wcCastasTodas)p.push('<span class="cf-junta">+</span>');
      p.push(`<span class="cf-pill">${ico} ${esc(wcRotulo(gg,v))}
        <button onclick="wcFiltroToggle('${escJs(gg)}','${escJs(v)}')" title="Tirar este filtro">✕</button></span>`);
    });
  });
  if(wcNFiltros()>1)p.push(`<button class="cf-limpar" onclick="wcLimparFiltros()">limpar tudo</button>`);
  document.getElementById('cat-activos').innerHTML=p.join('');

  const n=wcNFiltros(),nEl=document.getElementById('cf-n');
  nEl.textContent=n||'';
  nEl.classList.toggle('on',n>0);
}

// Tocar no campo que já está aberto fecha-o: a fita volta a ser uma linha só.
function wcAbrirCampo(g){
  _wcCampo=(_wcCampo===g)?null:g;
  wcPintarGrupos();
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
/* Os filtros e o texto limpam-se em sítios diferentes, porque vivem em
   sítios diferentes: o ✕ da caixa leva o texto, o "limpar tudo" leva os
   valores escolhidos — e quem acabou de escrever "crasto" não quer perder
   isso por ter tirado o Douro. */
function wcLimparFiltros(){
  _wcFiltros={tipos:[],regioes:[],castas:[],precos:[]};
  /* Um visto que sobrevivesse à limpeza era uma regra escondida a filtrar
     por baixo na próxima escolha. */
  _wcCastasTodas=false;
  try{localStorage.setItem('wc_castas_todas','0');}catch(e){}
  wcPintarGrupos();
  wcCarregarCatalogo(true);
}
function wcLimparTexto(){
  const c=document.getElementById('cat-procura');
  if(c){c.value='';c.focus();}
  clearTimeout(_wcTimer);
  wcProcuraX();
  if(!_wcProcura)return;
  _wcProcura='';
  wcCarregarCatalogo(true);
}
function wcProcuraX(){
  const c=document.getElementById('cat-procura');
  const x=document.getElementById('cat-procura-x');
  if(x)x.classList.toggle('on',!!(c&&c.value));
}
function wcAlternarPainel(){
  _wcPainel=!_wcPainel;
  if(!_wcPainel)_wcCampo=null;
  try{localStorage.setItem('wc_filtros_aberto',_wcPainel?'1':'0');}catch(e){}
  wcPintarGrupos();
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
  wcProcuraX();
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

// A foto de uma moldura carregou: a garrafa desenhada sai de trás, e decide-se
// como a foto cabe lá dentro pela FORMA dela — ver o `.alta` no style.css.
// Mais estreita do que 3:5, ou do que a moldura, é a garrafa recortada rente
// ao vidro → inteira (cortar-lhe os lados era cortar o vidro). Mais larga — a
// foto quadrada da loja, a de um rótulo — enche a altura. A mesma regra do
// `fotoCarregou` da Garrafeira: mexer numa é mexer na outra.
function wcFotoCarregou(img){
  const p=img.parentNode;if(!p)return;
  p.classList.add('com-foto');
  const w=img.naturalWidth,h=img.naturalHeight,bw=img.clientWidth,bh=img.clientHeight;
  if(w&&h)img.classList.toggle('alta',w/h<Math.max(bw&&bh?bw/bh:0,.6));
}
/* A garrafa da linha: a FOTOGRAFIA quando o catálogo já a tem, e a mesma
   garrafa desenhada da ficha quando não tem — nunca um quadrado vazio. A
   cor do desenho sai do `tipo`, que é o que o `resumo_linha` já devolve. */
function wcMiniGarrafa(v,cls){
  const img=String(v.imagem||'').trim();
  return `<div class="${cls}">${wcGarrafaSVG(v.tipo,v.ano)}${
    img?`<img src="${esc(img)}" alt="" loading="lazy" onload="wcFotoCarregou(this)" onerror="this.remove()">`:''}</div>`;
}
function wcPrecoTxt(p){
  const n=Number(p);
  return (p==null||isNaN(n))?'':eurFmt(n);
}

/* O que fica na linha: a garrafa, quem é o vinho, e os dois números por
   que se escolhe um — a nota e o preço. O número de campos e a bola da
   força saíram daqui de propósito: são sobre a QUALIDADE DO REGISTO, não
   sobre o vinho, e essa conversa é da ficha (secção "Proveniência"). */
/* O NOME É O VINHO; a cor e o produtor são campos à parte (fase 4 dos
   nomes) e dizem-se como tal — o mesmo desenho da Garrafeira: a cor em
   itálico logo a seguir ao nome, o produtor em itálico por baixo. */
/* [cor] [região] [ano], por esta ordem (pedido do dono das apps,
   27/09/2026; igual na Garrafeira, `vinhoMetaHTML`). Na LISTA vai colada ao
   nome e quebra com ele quando o nome é comprido — cada pedaço em `nowrap`,
   para a quebra cair ENTRE eles; na GRELHA é a linha de baixo do nome. O
   produtor fica sempre numa linha só dele. */
function wcMetaHTML(v){
  const p=[];
  if(v.tipo)p.push(`<span class="cat-cor">${esc(v.tipo)}</span>`);
  if(v.regiao)p.push(`<span class="cm-reg">${esc(v.regiao)}</span>`);
  if(v.ano)p.push(`<span class="cm-ano">${esc(String(v.ano))}</span>`);
  return p.length?`<span class="cat-meta">${p.join('<span class="cm-sep"> · </span>')}</span>`:'';
}
function wcLinhaHTML(v){
  const castas=Array.isArray(v.castas)?v.castas.join(', '):'';
  const preco=wcPrecoTxt(v.preco);
  return `<div class="cat-row" onclick="wcVerFicha(${v.id})">
    ${wcMiniGarrafa(v,'cat-g')}
    <div class="cat-main">
      <div class="cat-nome">${esc(v.nome||'(sem nome)')} ${wcMetaHTML(v)}</div>
      ${v.produtor?`<div class="cat-prod">${esc(v.produtor)}</div>`:''}
      ${castas?`<div class="cat-castas">${esc(castas)}</div>`:''}
    </div>
    <div class="cat-lado">
      ${wcNotaLinhaHTML(v)}
      ${preco?`<span class="cat-preco">${esc(preco)}</span>`:''}
    </div>
  </div>`;
}

function wcCartaoHTML(v){
  const preco=wcPrecoTxt(v.preco);
  return `<div class="cat-cartao" onclick="wcVerFicha(${v.id})">
    ${wcMiniGarrafa(v,'cat-g gr')}
    <div class="cat-nome">${esc(v.nome||'(sem nome)')}</div>
    <div class="cat-sub">${wcMetaHTML(v)||'—'}</div>
    ${v.produtor?`<div class="cat-prod">${esc(v.produtor)}</div>`:''}
    <div class="cat-cartao-n">
      ${wcNotaLinhaHTML(v)}
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

/* O nome completo de cada produtor oficial ("Quinta Nova" → "Quinta Nova de
   Nossa Senhora do Carmo"): só para se ler na ficha. Pede-se uma vez; se
   falhar, a ficha aparece sem ele. */
let _wcCompletos=null;
async function wcProdCompletos(forcar){
  if(_wcCompletos&&!forcar)return _wcCompletos;
  try{_wcCompletos=(await catRpc('produtores_completos'))||{};}catch(_){_wcCompletos=_wcCompletos||{};}
  return _wcCompletos;
}
async function wcVerFicha(id){
  const m=document.getElementById('modal-ficha');
  const corpo=document.getElementById('ficha-corpo');
  if(!m)return;
  corpo.innerHTML='<div class="fi-espera"><p class="wc-note">A carregar…</p></div>';
  m.classList.add('on');
  wcFabSincronizar();   // a ficha não passa pelo `abrirModal`, mas tapa o FAB na mesma
  try{
    const [v]=await Promise.all([catRpc('ver',{p_id:id}),wcProdCompletos()]);
    if(!v){_wcFicha=null;corpo.innerHTML='<p class="wc-note">Essa linha já não existe.</p>';return;}
    _wcFicha=v;
    if(_wcRev&&_wcRev.vinhoId!==v.id)_wcRev=null;
    corpo.innerHTML=wcFichaHTML(v);
    if(isAdmin()){wcHistorico(v.id,'fi-hist');wcProcRetomar(v.id);}
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
  WC_FICHA.forEach(([k,l])=>{nome[k]=l;});
  const chaves=WC_FICHA.map(([k])=>k).filter(k=>k in origens)
    .concat(Object.keys(origens).filter(k=>!WC_FICHA.some(([c])=>c===k)));
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
  const origem=[v.produtor?`<i class="mhero-p">${esc(v.produtor)}</i>`:'',esc(ficha.regiao||''),esc(ficha.sub_regiao||'')].filter(Boolean).join(' · ');
  const jan=wcJanelaTxt(ficha.beber_de,ficha.beber_ate);
  const nv=wcNotaVivinoFicha(ficha);
  /* A que se mostra leva a colheita ou "todas as colheitas" quando as duas
     existem — com uma só, fica como sempre foi (ver `wcNotaLinhaHTML`). */
  const temDuas=ficha.vivino_nota!=null&&ficha.vivino_nota_global!=null;
  const nvDe=!nv?'':nv.de==='global'?' · todas as colheitas':(temDuas&&v.ano?' · colheita '+v.ano:'');

  let h=`<div class="mhero">
    <button class="mx" onclick="wcFecharFicha()" aria-label="Fechar">✕</button>
    <div class="mhero-in">
      <div class="mhero-g${isAdmin()?' mhero-edit':''}"${isAdmin()?` onclick="wcAbrirEditar()" title="Mudar a imagem"`:''}>
        ${wcGarrafaSVG(tipo,v.ano)}${img?`<img src="${esc(img)}" alt="" onload="wcFotoCarregou(this)" onerror="this.remove()">`:''}
        ${isAdmin()?'<i class="mhero-lapis">✏️</i>':''}
      </div>
      <div class="mhero-tx">
        <div class="mhero-k">${esc([ficha.estilo,ficha.classificacao].filter(Boolean).join(' · '))||'&nbsp;'}</div>
        <h3>${esc(v.nome||'(sem nome)')}${tipo?` <span class="mhero-cor">${esc(tipo)}</span>`:''}</h3>
        <div class="mhero-s"><span class="mhero-o">${origem||'<em>sem produtor nem região</em>'}${origem&&v.ano?' · ':''}</span>${v.ano?`<b>${esc(String(v.ano))}</b>`:''}</div>
        ${v.produtor&&_wcCompletos&&_wcCompletos[v.produtor]?`<div class="mhero-pc">${esc(_wcCompletos[v.produtor])}</div>`:''}
        ${nv?`<span class="mhero-n" title="${esc(wcNotaVivinoTitulo(nv,v.ano))}">★ ${esc(nv.nota.toFixed(2))} Vivino${nv.aval?` · ${esc(nFmt(nv.aval))}`:''}${esc(nvDe)}</span>`:''}
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
      <button class="btn-n" onclick="wcVivinoPedir(${Number(v.id)})" title="Põe este vinho na fila da próxima verificação dos links do Vivino">🍷 Verificar no Vivino</button>
    </div>`;
  }
  h+=`<div id="proc-caixa"></div>`;

  /* ── A FICHA ── */
  const conhecidos=WC_FICHA.filter(([k])=>k in ficha);
  const extra=Object.keys(ficha).filter(k=>!WC_FICHA.some(([c])=>c===k)).map(k=>[k,WC_ROTULOS_EXTRA[k]||k]);
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

  /* O histórico campo a campo (db/historico.sql) — só o admin: o "quem"
     tem emails. Enche-se depois de a ficha estar no ecrã. */
  if(isAdmin())h+=`<div class="msec">Histórico de alterações</div><div id="fi-hist"><p class="wc-note">A carregar…</p></div>`;

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
  /* A imagem vem PRIMEIRO e fora da ordem de `WC_CAMPOS`: é a única que se
     VÊ, e perdida a meio da lista como mais uma caixa de texto ninguém dava
     por ela ("não consigo mexer na imagem?"). Ver `wcImgCampoHTML`. */
  ['imagem_url','Imagem','img'],
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
  ['vivino_nota','Nota Vivino da colheita (0-5)','num'],
  ['vivino_avaliacoes','Avaliações Vivino da colheita','int'],
  ['vivino_nota_global','Nota Vivino de todas as colheitas (0-5)','num'],
  ['vivino_avaliacoes_global','Avaliações Vivino de todas as colheitas','int'],
  ['vivino_url','URL do Vivino','txt'],
  ['preco_medio','Preço de referência (€)','num'],
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
  if(tp==='img')return wcImgCampoHTML(prefixo,k,lbl,val,marca);
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
  wcImgEsquecer(prefixo);
  return WC_EDIT.map(([k,lbl,tp,ops])=>{
    const o=origens[k]||{}, f=Number(o.f||0);
    const val=wcValorEdit(k,ficha[k]);
    const marca=(k in ficha)
      ? `<span class="ed-de"><span class="og-tag ${wcOrigemCls(o.o,f)}">${esc(wcOrigemTxt(o.o,f))}</span><span class="forca f${esc(String(f))}">${esc(String(f))}</span></span>`
      : '';
    return wcCampoEditHTML(prefixo,k,lbl,tp,ops,val,marca)+(k==='beber_ate'
      ?`<p class="wc-note ed-oculto" id="${prefixo}jan-nota">Sem colheita não há <strong>janela de
         consumo</strong>: os anos dela seriam os de uma colheita qualquer.</p>`:'');
  }).join('');
}
/* ── A IMAGEM ──
   Duas maneiras de a mudar, no mesmo sítio: colar um LINK (o que sempre
   houve) ou tirar/carregar uma FOTOGRAFIA do rótulo. A fotografia não sobe
   logo: fica PENDENTE (`_wcImgPend`, por formulário) com uma
   pré-visualização local, e só vai para o bucket quando se carrega em
   Guardar/Criar (`wcSubirImagemPendente`). Subir ao escolher deixava lixo
   pago no bucket a cada "Cancelar".
   O bucket é PÚBLICO (`db/imagens.sql` diz porquê): as outras duas apps
   mostram o `imagem_url` num <img> simples e não têm login aqui. */
const WC_BUCKET='winecatalog-rotulos';
const WC_BUCKET_PUB=SB_URL+'/storage/v1/object/public/'+WC_BUCKET+'/';
let _wcImgPend={};

function wcImgCampoHTML(prefixo,k,lbl,val,marca){
  const id=prefixo+k;
  return `<div class="ed-campo ed-img">
    <label for="${id}">${esc(lbl)}${marca||''}</label>
    <div class="ed-img-l">
      <div class="ed-img-v" id="${id}-v">${wcImgVistaHTML(val)}</div>
      <div class="ed-img-b">
        <label class="btn-n ed-img-foto">📷 Fotografia
          <input type="file" accept="image/*" style="display:none" onchange="wcImgFoto('${escJs(prefixo)}',this)">
        </label>
        <button type="button" class="btn-n" onclick="wcImgLimpar('${escJs(prefixo)}')">Tirar imagem</button>
      </div>
    </div>
    <input type="text" id="${id}" value="${esc(val)}" placeholder="ou cola o link direto de uma imagem (.jpg, .png…)"
           inputmode="url" oninput="wcImgUrlMudou('${escJs(prefixo)}')">
    <p class="wc-note ed-img-nota" id="${id}-n">A fotografia fica <strong>pública</strong> — é a que as três apps mostram. Enquadra só o rótulo.</p>
  </div>`;
}
function wcImgVistaHTML(src){
  src=String(src||'').trim();
  return src?`<img src="${esc(src)}" alt="" onerror="this.parentNode.innerHTML='<span>link sem imagem</span>'">`
            :'<span>sem imagem</span>';
}
function wcImgPintar(prefixo,src,nota){
  const v=document.getElementById(prefixo+'imagem_url-v');
  if(v)v.innerHTML=wcImgVistaHTML(src);
  const n=document.getElementById(prefixo+'imagem_url-n');
  if(n&&nota)n.innerHTML=nota;
}
function wcImgEsquecer(prefixo){
  const p=_wcImgPend[prefixo];
  if(p&&p.url)URL.revokeObjectURL(p.url);
  delete _wcImgPend[prefixo];
}
async function wcImgFoto(prefixo,input,silencioso){
  const file=input&&input.files?input.files[0]:input;
  if(!file)return;
  try{
    const blob=await wcEncolherBlob(file);
    wcImgEsquecer(prefixo);
    const url=URL.createObjectURL(blob);
    _wcImgPend[prefixo]={blob,url};
    const el=document.getElementById(prefixo+'imagem_url');
    if(el)el.value='';
    wcImgPintar(prefixo,url,'Fotografia nova — <strong>sobe quando guardares</strong>, e fica pública.');
  }catch(e){
    if(!silencioso)toast('Erro: '+e.message,1);
  }finally{
    if(input&&input.files)input.value='';
  }
}
function wcImgUrlMudou(prefixo){
  wcImgEsquecer(prefixo);
  const el=document.getElementById(prefixo+'imagem_url');
  wcImgPintar(prefixo,el?el.value:'');
}
function wcImgLimpar(prefixo){
  wcImgEsquecer(prefixo);
  const el=document.getElementById(prefixo+'imagem_url');
  if(el)el.value='';
  wcImgPintar(prefixo,'');
}
/* Sobe a fotografia pendente (se houver) e mete o endereço público na
   caixa, que é de onde o `wcLerCampos` o lê a seguir — o resto do caminho
   de gravação não sabe que houve fotografia nenhuma. O nome é sempre novo:
   um caminho fixo ficava preso à cache do browser e da CDN. */
async function wcSubirImagemPendente(prefixo){
  const p=_wcImgPend[prefixo];
  if(!p)return null;
  const nome=`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}.jpg`;
  const r=await sbFetch(SB_URL+'/storage/v1/object/'+WC_BUCKET+'/'+nome,{
    method:'POST',
    headers:{apikey:SB_KEY,Authorization:'Bearer '+(_sbSession&&_sbSession.access_token),
             'Content-Type':'image/jpeg','Cache-Control':'31536000'},
    body:p.blob
  });
  if(!r.ok){
    const d=await r.json().catch(()=>({}));
    throw new Error('a fotografia não subiu ('+(d.message||d.error||r.status)+')'+
      (r.status===404||/bucket/i.test(d.message||'')?' — já correste o db/imagens.sql?':''));
  }
  const url=WC_BUCKET_PUB+nome;
  const el=document.getElementById(prefixo+'imagem_url');
  if(el)el.value=url;
  wcImgEsquecer(prefixo);
  return nome;
}
/* Tira do bucket uma fotografia que deixou de ser usada — só se for NOSSA
   (um link de uma loja não se apaga, claro) e sem nunca falhar a gravação
   que já correu bem por causa disto. */
async function wcApagarImagemVelha(antes,depois){
  antes=String(antes||'');
  if(!antes.startsWith(WC_BUCKET_PUB)||antes===String(depois||''))return;
  try{
    await sbFetch(SB_URL+'/storage/v1/object/'+WC_BUCKET+'/'+antes.slice(WC_BUCKET_PUB.length),{
      method:'DELETE',
      headers:{apikey:SB_KEY,Authorization:'Bearer '+(_sbSession&&_sbSession.access_token)}
    });
  }catch(e){}
}
async function wcApagarNome(nome){
  if(nome)await wcApagarImagemVelha(WC_BUCKET_PUB+nome,'');
}

/* O que vai para a base a partir de um formulário destes: `null` quando o
   campo ficou vazio (a `editar`/`criar` leem isso como "não escrevas nada"
   ou "apaga", conforme o caso) e o valor com o TIPO certo quando não. Um
   número guardado como texto quebrava a comparação da Garrafeira (13.5 vs.
   "13.5") — ver o comentário grande onde isto vivia antes de ganhar um
   `prefixo`. */
/* A janela de consumo (`beber_de`/`beber_ate`) só existe com colheita: são
   anos de UMA colheita, e sem ela seriam os de uma qualquer. O catálogo
   recusa-a na mesma (trigger `vinhos_sem_colheita`); aqui o campo esconde-se
   e não se manda. */
const WC_JANELA=['beber_de','beber_ate'];
function wcJanelaSincronizar(prefixo,ano){
  const sem=ano==null||String(ano).trim()==='';
  WC_JANELA.forEach(k=>{
    const el=document.getElementById(prefixo+k);
    const c=el&&el.closest('.ed-campo');
    if(c)c.classList.toggle('ed-oculto',sem);
  });
  const n=document.getElementById(prefixo+'jan-nota');
  if(n)n.classList.toggle('ed-oculto',!sem);
}
function wcLerCampos(prefixo,semColheita){
  const out={};
  for(const [k,,tp] of WC_EDIT){
    if(semColheita&&WC_JANELA.includes(k))continue;
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
  <button class="btn-n larg" onclick="wcEditarManual()">✍️ Gerar um prompt para outro assistente (ChatGPT, Claude…) e colar a resposta</button>
  <div class="divi"></div>
  ${wcCamposEditHTML('ed-',ficha,origens)}
  ${wcPrecosEditHTML(ficha.precos,ficha.preco_medio)}`;
  _wcRefAuto=null;

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
      <input type="text" id="ed-ano" inputmode="numeric" value="${esc(v.ano==null?'':String(v.ano))}"
        oninput="wcJanelaSincronizar('ed-',this.value)"></div>
  </div>
  <div class="macoes fim">
    <button class="btn-n" onclick="fecharModal('modal-editar')">Cancelar</button>
    <button class="btn-prim auto" id="ed-guardar" onclick="wcGuardarEdicao()">Guardar</button>
  </div>`;
  box.innerHTML=h;
  document.getElementById('editar-titulo').textContent=v.nome||'(sem nome)';
  wcJanelaSincronizar('ed-',v.ano);
  abrirModal('modal-editar');
}
/* ── AS FONTES DE PREÇO ──
   Os preços das lojas (`ficha.precos`) só o script os escreve, e às vezes
   escreve mal: o Casa de Saima Garrafeira veio a 8,49 € do Vivino, com as
   lojas a 60 €. Aqui retira-se uma fonte — e RETIRAR não é apagar: a
   entrada fica com `retirado:true`. Apagada, a corrida seguinte do script
   lia a mesma página e punha lá o mesmo número; marcada, o script salta-a,
   a Garrafeira (`precos_lojas`) não a vê, e desmarcar devolve-a. */
function wcPrecosEditHTML(precos,medio){
  if(!precos||typeof precos!=='object'||Array.isArray(precos))return '';
  const lojas=WC_PRECO_PRIORIDADE;
  const ks=Object.keys(precos).filter(l=>precos[l]&&precos[l].preco!=null)
    .sort((a,b)=>(lojas.indexOf(a)+1||99)-(lojas.indexOf(b)+1||99));
  if(!ks.length)return '';
  const m=Number(medio);
  return `<div class="divi"></div>
  <div class="ed-campo"><label>Fontes de preço</label>
  <p class="wc-note">Marca as que estão <strong>erradas</strong>. Ficam de fora do preço nas três
    apps e o script deixa de as ler — desmarcar devolve-as.</p>
  ${ks.map(l=>{
    const x=precos[l], pr=Number(x.preco);
    const t=`${esc(WC_LOJAS_NOMES[l]||l)} · ${esc(eurFmt(x.preco))}${x.colheita?` · colheita ${esc(String(x.colheita))}`:''}`;
    return `<label class="ed-check"><input type="checkbox" class="ed-preco-ret" data-loja="${esc(l)}"
        ${x.retirado?'checked':''} onchange="wcPrecoRetirarMudou()">
      Retirar ${x.url?`<a href="${esc(x.url)}" target="_blank" rel="noopener">${t}</a>`:t}${
        isFinite(m)&&m>0&&Math.abs(pr-m)<0.005?' <span class="wc-note">(é o preço de referência)</span>':''}</label>`;
  }).join('')}
  <p class="wc-note ed-oculto" id="ed-preco-aviso"></p></div>`;
}
/* De que fonte veio o preço de referência (`preco_medio`): pela ORIGEM que
   o script lhe carimbou (`loja-granvine` → granvine, `vivino-*` → vivino),
   e, sem essa, pelo valor igual ao de uma loja. `null` = veio de outro lado
   (uma pesquisa, uma correção à mão) e retirar uma loja não lhe mexe. */
const WC_PRECO_PRIORIDADE=['garrafeira_nacional','granvine','vinha','vivino'];
function wcFonteDoPrecoRef(ficha,origens){
  const precos=(ficha||{}).precos||{}, m=Number((ficha||{}).preco_medio);
  if(!(m>0))return null;
  const o=String(((origens||{}).preco_medio||{}).o||'');
  const pelaOrigem=o.startsWith('loja-')?o.slice(5).replace(/-/g,'_'):o.startsWith('vivino-')?'vivino':null;
  if(pelaOrigem&&precos[pelaOrigem])return pelaOrigem;
  if(pelaOrigem||o==='catalogo-admin'||o==='catalogo-pesquisa')return null;
  return WC_PRECO_PRIORIDADE.find(l=>precos[l]&&Math.abs(Number(precos[l].preco)-m)<0.005)||null;
}
/* Retirar a fonte de onde veio o preço de referência deixa-o órfão. Diz-se
   já qual passa a ser — a primeira que sobra pela MESMA ordem do script
   (GN → Granvine → Vinha.pt → Vivino) — e põe-se no campo, à vista, para
   se guardar com o resto. Sem nenhuma, o campo fica vazio e diz-se que o
   vinho fica sem preço de referência. Desmarcar repõe o que lá estava.
   Se o admin escreveu outro valor à mão no campo, não se lhe toca. */
let _wcRefAuto=null;
function wcPrecoRetirarMudou(){
  const v=_wcFicha||{}, ficha=v.ficha||{}, precos=ficha.precos||{};
  const el=document.getElementById('ed-preco_medio');
  const a=document.getElementById('ed-preco-aviso');
  const fonte=wcFonteDoPrecoRef(ficha,v.origens);
  if(!el||!a||!fonte)return;
  const orig=ficha.preco_medio==null?'':String(ficha.preco_medio);
  const atual=String(el.value).trim();
  const meu=atual===orig||(_wcRefAuto!=null&&atual===_wcRefAuto);
  const ret=new Set([...document.querySelectorAll('.ed-preco-ret')].filter(c=>c.checked).map(c=>c.dataset.loja));
  if(!ret.has(fonte)){
    if(meu&&atual!==orig)el.value=orig;
    _wcRefAuto=null;
    a.classList.add('ed-oculto');
    return;
  }
  const nova=WC_PRECO_PRIORIDADE.concat(Object.keys(precos).filter(l=>!WC_PRECO_PRIORIDADE.includes(l)))
    .find(l=>!ret.has(l)&&precos[l]&&!precos[l].retirado&&Number(precos[l].preco)>0);
  const nome=l=>esc(WC_LOJAS_NOMES[l]||l);
  if(!meu){
    a.innerHTML=`O preço de referência vinha de <strong>${nome(fonte)}</strong>, mas escreveste outro à
      mão — fica o teu.`;
  }else if(nova){
    const x=precos[nova];
    _wcRefAuto=String(x.preco);
    el.value=_wcRefAuto;
    a.innerHTML=`O preço de referência vinha de <strong>${nome(fonte)}</strong>. Passa a ser
      <strong>${esc(eurFmt(x.preco))}</strong>, de <strong>${nome(nova)}</strong>${
      x.colheita?` (colheita ${esc(String(x.colheita))})`:''} — a seguinte pela ordem
      Garrafeira Nacional → Granvine → Vinha.pt → Vivino.`;
  }else{
    _wcRefAuto='';
    el.value='';
    a.innerHTML=`O preço de referência vinha de <strong>${nome(fonte)}</strong> e não sobra mais
      nenhuma fonte: o vinho fica <strong>sem preço de referência</strong>.`;
  }
  a.classList.remove('ed-oculto');
}
/* O `precos` inteiro de volta, com a marca posta ou tirada; `undefined`
   quando nada mudou — a `editar` já não escreve o que é igual, mas assim
   nem o manda. */
function wcLerPrecosRetirados(){
  const antes=((_wcFicha||{}).ficha||{}).precos;
  const cs=[...document.querySelectorAll('.ed-preco-ret')];
  if(!antes||!cs.length)return undefined;
  const hoje=new Date().toISOString().slice(0,10);
  const novo=JSON.parse(JSON.stringify(antes));
  let mudou=false;
  cs.forEach(c=>{
    const x=novo[c.dataset.loja];
    if(!x||!!x.retirado===c.checked)return;
    mudou=true;
    if(c.checked){x.retirado=true;x.retirado_em=hoje;}
    else{delete x.retirado;delete x.retirado_em;}
  });
  return mudou?novo:undefined;
}
function wcEdIdent(){
  const on=document.getElementById('ed-ident').checked;
  document.getElementById('ed-ident-box').classList.toggle('ed-oculto',!on);
  wcJanelaSincronizar('ed-',on?(document.getElementById('ed-ano')||{}).value:(_wcFicha||{}).ano);
}

async function wcGuardarEdicao(){
  if(!_wcFicha)return;
  const b=document.getElementById('ed-guardar');
  const ident=!!(document.getElementById('ed-ident')||{}).checked;
  const imgAntes=(_wcFicha.ficha||{}).imagem_url;
  if(b){b.disabled=true;b.textContent='A guardar…';}
  let subida=null;
  try{subida=await wcSubirImagemPendente('ed-');}
  catch(e){toast('Erro: '+e.message,1);if(b){b.disabled=false;b.textContent='Guardar';}return;}
  const anoEd=String((document.getElementById('ed-ano')||{}).value||'').trim();
  const args={p_id:_wcFicha.id,p_campos:wcLerCampos('ed-',ident?anoEd==='':_wcFicha.ano==null)};
  const precosNovos=wcLerPrecosRetirados();
  if(precosNovos)args.p_campos.precos=precosNovos;
  if(ident){
    const ano=anoEd;
    args.p_nome=String((document.getElementById('ed-nome')||{}).value||'').trim();
    args.p_produtor=String((document.getElementById('ed-produtor')||{}).value||'').trim();
    args.p_ano=ano===''?null:(parseInt(ano,10)||null);
    args.p_mexer_identidade=true;
  }
  try{
    const r=await catRpc('editar',args);
    wcApagarImagemVelha(imgAntes,args.p_campos.imagem_url);
    const n=(r&&r.campos)||0, ap=(r&&r.apagados)||0;
    toast(n+ap?`Guardado ✓ ${n} corrigidos${ap?`, ${ap} apagados`:''}`:'Nada mudou');
    fecharModal('modal-editar');
    await wcRefrescarFicha();
    wcCarregarCatalogo(true);
  }catch(e){
    toast('Erro: '+e.message,1);
    wcApagarNome(subida);
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

/* O VINHO NOVO ABRE COMPACTO (27/09/2026, o dono das apps — o mesmo desenho
   da Garrafeira): nome, colheita, cor e o produtor (opcional), e duas
   saídas. "Procurar informação" pergunta primeiro ao catálogo que vinhos
   com este nome já lá estão (`winecatalog.colheitas`) — e aqui, que É o
   catálogo, um candidato quer dizer "este vinho já existe": abre-se a
   ficha dele em vez de nascer um duplicado. "Nenhum destes" (ou nenhum
   candidato) cria a linha e segue para a pesquisa. "Preencher à mão" abre
   o formulário inteiro (`nv-resto`). A leitura do rótulo por fotografia
   fica à vista nas duas. */
function wcAbrirNovo(){
  if(!isAdmin())return;
  const box=document.getElementById('novo-corpo');
  if(!box)return;
  box.innerHTML=`
    <div class="ed-campo"><label for="nv-nome">Nome *</label>
      <input type="text" id="nv-nome" placeholder="ex.: Quinta do Crasto Reserva"></div>
    <div class="ed-campo"><label for="nv-ano">Colheita (ano, vazio se não tiver)</label>
      <input type="text" id="nv-ano" inputmode="numeric" oninput="wcJanelaSincronizar('nv-',this.value)"></div>
    <div class="ed-campo"><label for="nv-cor">Cor *</label>
      <select id="nv-cor"><option value="">— escolhe a cor —</option>${WC_TIPOS.filter(Boolean).map(t=>
        `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select></div>
    <div class="ed-campo"><label for="nv-produtor">Produtor (opcional — ajuda a acertar)</label>
      <input type="text" id="nv-produtor"></div>
    <label class="btn-n larg" style="text-align:center;cursor:pointer;display:block">
      📷 Ler o rótulo de uma fotografia
      <input type="file" accept="image/*" id="nv-foto" style="display:none" onchange="wcNovoFoto(this)">
    </label>
    <p class="wc-note" id="nv-foto-status"></p>

    <div id="nv-botoes" class="macoes fim">
      <button class="btn-n" onclick="wcNovoMao()">✏️ Preencher à mão</button>
      <button class="btn-prim auto" id="nv-procurar" onclick="wcNovoCandidatos()">🔎 Procurar informação</button>
    </div>
    <div id="nv-cand"></div>

    <div id="nv-resto" class="ed-oculto">
      <div class="divi"></div>
      ${wcCamposEditHTML('nv-',{},{})}
      <div class="macoes fim">
        <button class="btn-n" onclick="fecharModal('modal-novo')">Cancelar</button>
        <button class="btn-n" onclick="wcNovoProcurar()">🔎 Criar e procurar informação</button>
        <button class="btn-prim auto" id="nv-criar" onclick="wcCriarVinho()">Criar vinho</button>
      </div>
    </div>`;
  wcJanelaSincronizar('nv-',null);
  abrirModal('modal-novo');
  const nomeEl=document.getElementById('nv-nome');
  if(nomeEl)nomeEl.focus();
}
/* A cor do formulário compacto vai para o campo da ficha (`nv-tipo`), que é
   o que a `criar` lê. */
function wcNovoCor(){
  const c=document.getElementById('nv-cor'), t=document.getElementById('nv-tipo');
  if(c&&t&&c.value)t.value=c.value;
  return c?c.value:'';
}
function wcNovoMao(){
  wcNovoCor();
  document.getElementById('nv-resto')?.classList.remove('ed-oculto');
  const b=document.getElementById('nv-botoes');if(b)b.style.display='none';
  const c=document.getElementById('nv-cand');if(c)c.innerHTML='';
}
let _wcNovoCand=[];
async function wcNovoCandidatos(){
  if(!isAdmin())return;
  const {nome,produtor,ano}=wcNovoIdentidade();
  if(!nome){toast('Falta o nome.',1);return;}
  const cor=wcNovoCor();
  if(!cor){toast('Escolhe primeiro a cor.',1);document.getElementById('nv-cor')?.focus();return;}
  const b=document.getElementById('nv-procurar');
  if(b){b.disabled=true;b.textContent='A ver o catálogo…';}
  let lista=[];
  try{ lista=await catRpc('colheitas',{p_nome:nome,p_produtor:produtor,p_tipo:cor})||[]; }
  catch(e){ lista=[]; }
  if(b){b.disabled=false;b.textContent='🔎 Procurar informação';}
  _wcNovoCand=(lista||[]).filter(c=>!c.tipo||c.tipo.toLowerCase()===cor.toLowerCase())
    .sort((x,y)=>(y.ano===ano)-(x.ano===ano));
  // Nenhum candidato: não há nada a escolher — cria-se e pesquisa-se.
  if(!_wcNovoCand.length){toast('Não está no catálogo — a criar e a pesquisar');return wcNovoProcurar();}
  const L=_wcNovoCand;
  document.getElementById('nv-cand').innerHTML=`
    <p class="wc-note" style="font-size:13.5px;color:var(--tx)"><strong>${L.length===1?'Este vinho já está no catálogo. É o mesmo?':`Encontrei ${L.length} vinhos no catálogo. É algum destes?`}</strong></p>
    <div class="nv-cands">${L.map((c,i)=>{
      const castas=Array.isArray(c.castas)?c.castas.join(', '):(c.castas||'');
      const igual=ano!=null&&c.ano===ano;
      return `<button class="nv-cand${igual?' igual':''}" onclick="wcNovoAbrirCand(${i})"><b>${c.ano!=null?esc(String(c.ano)):'s/ ano'}</b>
        <span>${esc(c.nome)}${c.produtor?' · '+esc(c.produtor):''}</span>
        <i>${castas?esc(castas):'castas por saber'}${c.regiao?' · '+esc(c.regiao):''} · abrir a ficha</i></button>`;}).join('')}</div>
    ${ano!=null&&!L.some(c=>c.ano===ano)?`<p class="wc-note">A colheita ${esc(String(ano))} ainda não está no catálogo — "Nenhum destes" cria-a.</p>`:''}
    <div class="macoes fim"><button class="btn-n" onclick="wcNovoProcurar()">Nenhum destes — criar e pesquisar</button></div>`;
}
async function wcNovoAbrirCand(i){
  const c=_wcNovoCand[i];if(!c)return;
  fecharModal('modal-novo');
  await wcVerFicha(c.id);
}

/* Reduz a foto no browser antes de enviar — o mesmo truque da Garrafeira
   (`encolherImagem`): o rótulo lê-se perfeitamente a 1000px no lado maior,
   e uma foto de telemóvel são vários MB que não vale a pena mandar
   inteiros. `imageOrientation:'from-image'` trata do EXIF, senão uma foto
   tirada na vertical chegava deitada à Edge Function. */
function wcEncolherImagem(file){
  return wcEncolherBlob(file).then(blob=>new Promise((resolve,reject)=>{
    const fr=new FileReader();
    fr.onload=()=>resolve(String(fr.result).split(',')[1]||'');
    fr.onerror=()=>reject(new Error('não consegui ler a imagem'));
    fr.readAsDataURL(blob);
  }));
}
// A mesma redução, mas a devolver o JPEG em si — é o que sobe para o bucket.
function wcEncolherBlob(file){
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
        resolve(blob);
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
    /* A fotografia do rótulo serve também de IMAGEM do vinho, se ainda não
       houver outra — fica pendente como qualquer outra, à vista, e tira-se
       com um toque se apanhou mais do que o rótulo. */
    const imgEl=document.getElementById('nv-imagem_url');
    if(!_wcImgPend['nv-']&&imgEl&&!imgEl.value)wcImgFoto('nv-',file,true);
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
    if(d.ano){document.getElementById('nv-ano').value=String(d.ano);wcJanelaSincronizar('nv-',d.ano);}
    const campos=d.campos||{};
    if(campos.tipo){const c=document.getElementById('nv-cor');if(c)c.value=campos.tipo;}
    for(const [k,,tp] of WC_EDIT){
      if(!(k in campos)||tp==='img')continue;
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
  wcNovoCor();
  const {nome,produtor,ano}=wcNovoIdentidade();
  if(!nome){toast('Falta o nome.',1);return;}
  const b=document.getElementById('nv-criar');
  if(b){b.disabled=true;b.textContent='A criar…';}
  let subida=null;
  try{
    subida=await wcSubirImagemPendente('nv-');
    const r=await catRpc('criar',{p_nome:nome,p_produtor:produtor,p_ano:ano,p_campos:wcLerCampos('nv-',ano==null)});
    fecharModal('modal-novo');
    toast('Vinho criado ✓');
    wcCarregarCatalogo(true);
    if(r&&r.id)await wcVerFicha(r.id);
  }catch(e){
    toast('Erro: '+e.message,1);
    wcApagarNome(subida);
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
  wcNovoCor();
  const {nome,produtor,ano}=wcNovoIdentidade();
  if(!nome){toast('Falta o nome.',1);return;}
  const b=document.getElementById('nv-procurar');
  if(b){b.disabled=true;b.textContent='A criar…';}
  let subida=null;
  try{
    subida=await wcSubirImagemPendente('nv-');
    const r=await catRpc('criar',{p_nome:nome,p_produtor:produtor,p_ano:ano,p_campos:wcLerCampos('nv-',ano==null)});
    fecharModal('modal-novo');
    wcCarregarCatalogo(true);
    if(r&&r.id){
      await wcVerFicha(r.id);
      wcAbrirProcurar();
    }
  }catch(e){
    toast('Erro: '+e.message,1);
    wcApagarNome(subida);
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

   NADA FICA GRAVADO SEM CONFIRMAÇÃO (26/09/2026 — o ecrã da Garrafeira).
   Até aqui a pesquisa gravava sozinha, pela força (`juntar`), e só depois
   dizia o que tinha entrado e o que não — e o dono das apps nunca percebia
   se ficava guardado, se tinha de ir a algum lado, o que mudou, se podia
   recusar. Agora a `catalogo-info` vai com `rever:true`: fecha a pesquisa
   com as PROPOSTAS, e o ecrã mostra campo a campo o que está e o que se
   encontrou, com os VAZIOS já marcados; só o que ficar marcado entra, pela
   `winecatalog.pesquisa_aplicar`. Fechar a janela a meio não perde nada: a
   pesquisa fica à espera na ficha do vinho (`pesquisa_por_rever`).
   ══════════════════════════════════════════════ */
const FN_CATALOGO_INFO=SB_URL+'/functions/v1/catalogo-info';
let _wcProcTimer=null, _wcProcId=null, _wcProcAte=0;
/* A pesquisa que está à espera de revisão: {pesquisaId, vinhoId, res}. */
let _wcRev=null;
/* O último pedido automático — é o que a "pesquisa profunda" repete, com os
   mesmos campos e o mesmo contexto, só que a exigir a pesquisa Google. */
let _wcProcUltimo=null;

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
      <textarea id="pr-sites" rows="2" placeholder="ex.: garrafeiranacional.com, ou o link da página do vinho numa loja"></textarea>
      <p class="wc-note" style="margin-top:5px">Domínios ou links, separados por vírgula. De um
        domínio (ex.: garrafeiranacional.com), a pesquisa procura o vinho só nesse site e lê a
        página que encontrar; um link é lido tal e qual — o do Vivino é usado como o link dele.
        No fim diz de que site veio cada campo.</p>
      <label class="ed-check"><input type="checkbox" id="pr-so-sites"> Usar só a informação destes sites</label>
      <p class="wc-note">Sem a pesquisa geral nem a da IA: o que as páginas destes sites não disserem
        fica vazio.</p>
    </div>`;
}
function wcContextoLer(){
  const notas=(document.getElementById('pr-notas')?.value||'').trim().slice(0,300);
  const sites=(document.getElementById('pr-sites')?.value||'')
    .split(/[,\n]/).map(s=>s.trim()).filter(Boolean).slice(0,5);
  // Inteiros, e não só o domínio: um link colado aqui é uma PÁGINA a ler (e
  // o do Vivino é a resposta — a `catalogo-info` usa-o como vivino_url). O
  // corte ao domínio, para o prompt, faz-se lá.
  const soSites=!!document.getElementById('pr-so-sites')?.checked;
  return {notas,sites,soSites};
}

function wcAbrirProcurar(){
  if(!_wcFicha||!isAdmin())return;
  const ficha=_wcFicha.ficha||{}, origens=_wcFicha.origens||{};
  const box=document.getElementById('procurar-corpo');
  if(!box)return;
  let h=`<p class="wc-note"><strong>Nada fica gravado sem confirmares.</strong> No fim vês, campo a
    campo, o que está no catálogo e o que a pesquisa encontrou — e escolhes o que guardar.</p>
  <p class="wc-note">Escolhe <strong>poucos campos</strong>. Pedir os vinte de uma vez põe o
    modelo a andar atrás de tudo e a voltar com meia dúzia de coisas mornas.</p>
  ${wcContextoHTML()}
  <label class="ed-check"><input type="checkbox" id="pr-colheita-esp">
    Tem de ser exatamente a colheita ${esc(String(_wcFicha.ano||''))}</label>
  <p class="wc-note">Por omissão a pesquisa é sobre o vinho em geral — o preço, o teor ou as notas
    de prova podem vir de outra colheita. Liga só se precisares mesmo dos factos desta colheita.
    A nota do Vivino vem sempre às duas: a da colheita e a de todas as colheitas (pedir a da
    colheita traz também a de todas).</p>
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
     a pena confirmar. Nunca escreve sozinho: na revisão é uma linha como as
     outras, e marcada vai pela `editar` com o interruptor de identidade. */
  const temProdutor=!!_wcFicha.produtor;
  h+=`<label class="pr-campo">
    <input type="checkbox" value="produtor"${temProdutor?'':' checked'} onchange="wcProcContar()">
    <span class="pr-nome">Produtor</span>
    ${temProdutor?`<span class="pr-falta">atual: ${esc(_wcFicha.produtor)}</span>`:'<span class="pr-falta">vazio</span>'}
  </label>`;
  for(const [k,lbl] of WC_EDIT.map(([k,l])=>[k,l])){
    if(_wcFicha.ano==null&&WC_JANELA.includes(k))continue;   // sem colheita não há janela
    // …nem nota da colheita: só a de todas (`camposComGlobal` na catalogo-info)
    if(_wcFicha.ano==null&&(k==='vivino_nota'||k==='vivino_avaliacoes'))continue;
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
`;
  box.innerHTML=h;
  wcProcTitulo('Procurar informação');
  wcProcContar();
  abrirModal('modal-procurar');
  wcProcTopo();
}
/* O título do modal é sempre o vinho; o subtítulo diz em que passo se está. */
function wcProcTitulo(sub){
  const t=document.getElementById('procurar-titulo'), s=document.getElementById('procurar-sub');
  if(t)t.textContent=(_wcFicha&&_wcFicha.nome)||'(sem nome)';
  if(s)s.textContent=sub;
}
function wcProcTopo(){
  const m=document.getElementById('modal-procurar');
  if(m)m.scrollTop=0;
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
  // Lê-se já: a espera a seguir substitui o formulário.
  const colheitaEspecifica=!!document.getElementById('pr-colheita-esp')?.checked;
  const ctx=wcContextoLer();
  if(ctx.soSites&&!ctx.sites.length){
    toast('Escreve pelo menos um site (ou o link da página do vinho) para usar só esses',1);
    if(b){b.disabled=false;b.textContent='🔎 Pesquisar';}
    document.getElementById('pr-sites')?.focus();
    return;
  }
  try{
    const p=await catRpc('pesquisa_criar',{p_vinho_id:_wcFicha.id});
    wcProcEspera(false,false,ctx.soSites);
    /* `jaAndava` é uma pesquisa que já estava a correr para este vinho — e
       nesse caso NÃO se chama outra vez a função, que era pagar duas vezes
       o mesmo trabalho. Sonda-se a que já lá está. */
    if(!p.jaAndava){
      _wcProcUltimo={vinhoId:_wcFicha.id,campos,colheitaEspecifica,notas:ctx.notas,sites:ctx.sites,soSites:ctx.soSites};
      await wcProcChamar(Object.assign({pesquisaId:p.id,rever:true},_wcProcUltimo,{vinhoId:undefined}));
    }
    wcProcIniciarPolling(p.id);
  }catch(e){
    wcProcErro(e.message);
    if(b){b.disabled=false;b.textContent='🔎 Pesquisar';}
  }
}
async function wcProcChamar(corpo){
  const r=await fetch(FN_CATALOGO_INFO,{
    method:'POST',
    headers:{'Content-Type':'application/json',apikey:SB_KEY,
             Authorization:'Bearer '+(_sbSession&&_sbSession.access_token)},
    body:JSON.stringify(corpo)
  });
  if(!r.ok&&r.status!==202){
    let msg='';try{msg=(await r.json()).error||'';}catch(_){}
    throw new Error(msg||('a função respondeu '+r.status));
  }
}

/* ── PESQUISA PROFUNDA ──
   O Gemini decide sozinho se usa a pesquisa Google, e muitas vezes responde
   com o que aprendeu no treino (`pesquisaWeb:false` no resultado). Isso não
   se recusa — é barato e costuma acertar —, mas diz-se, e daqui pede-se a
   mesma pesquisa outra vez com a pesquisa GARANTIDA (`profunda`): a Edge
   Function pesquisa ela própria no Google (Serper) e o Gemini só lê os
   resultados. Ver o CLAUDE.md, "De memória ou pesquisado". */
async function wcProcurarProfunda(){
  if(!_wcFicha||!isAdmin())return;
  const u=_wcProcUltimo&&_wcProcUltimo.vinhoId===_wcFicha.id?_wcProcUltimo:{campos:null,colheitaEspecifica:false,notas:'',sites:[],soSites:false};
  try{
    const p=await catRpc('pesquisa_criar',{p_vinho_id:_wcFicha.id});
    wcProcEspera(true);
    if(!p.jaAndava){
      await wcProcChamar({pesquisaId:p.id,campos:u.campos,colheitaEspecifica:u.colheitaEspecifica,
        notas:u.notas,sites:u.sites,soSites:u.soSites,profunda:true,rever:true});
    }
    wcProcIniciarPolling(p.id);
  }catch(e){
    wcProcErro(e.message);
  }
}

function wcProcCaixa(){return document.getElementById('proc-caixa');}
/* A espera vive em DOIS sítios: na janela (que é onde se está a olhar) e na
   ficha por baixo dela — quem fecha a janela a meio continua a ver que a
   pesquisa anda, e o resultado aparece-lhe lá. */
function wcProcEspera(profunda,manual,soSites){
  const t=manual?'A ler a resposta colada…'
    :soSites?'A ler os sites escolhidos…'
    :profunda?'Pesquisa avançada — a pesquisar no Google…':'A pesquisar com IA…';
  const box=document.getElementById('procurar-corpo');
  if(box){
    box.innerHTML=`<div class="pr-espera">
      <div class="wc-spin escuro"></div>
      <div><strong>${t}</strong>
        <div class="wc-note">${manual?'É só um instante.':soSites?'Procura o vinho em cada site e lê a página — pode levar um minuto.':'Pesquisa Google a sério — pode levar um minuto.'}
          Podes fechar esta janela: a pesquisa continua e o resultado fica à tua espera na ficha
          deste vinho. <strong>Nada é gravado sem confirmares.</strong></div></div>
    </div>`;
    wcProcTitulo('A pesquisar');
    abrirModal('modal-procurar');
    wcProcTopo();
  }
  const c=wcProcCaixa();
  if(c)c.innerHTML=`<div class="pr-espera">
    <div class="wc-spin escuro"></div>
    <div><strong>${t}</strong>
      <div class="wc-note">Quando acabar, mostra-te o que encontrou para escolheres o que guardar.</div></div>
  </div>`;
}
function wcProcErro(msg){
  const html=`<div class="pr-espera erro"><div>⚠️</div>
    <div><strong>A pesquisa falhou</strong><div class="wc-note">${esc(msg||'erro desconhecido')}</div></div></div>`;
  const c=wcProcCaixa();
  if(c)c.innerHTML=html;
  const m=document.getElementById('modal-procurar'), box=document.getElementById('procurar-corpo');
  if(m&&m.classList.contains('on')&&box){
    box.innerHTML=html+`<div class="macoes fim">
      <button class="btn-n" onclick="wcAbrirProcurar()">‹ Voltar</button>
      <button class="btn-prim auto" onclick="fecharModal('modal-procurar')">Fechar</button></div>`;
    wcProcTitulo('Procurar informação');
  }
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
    wcProcErro('demorou demasiado — se acabar entretanto, o resultado aparece quando voltares a abrir este vinho');
    return;
  }
  try{
    const p=await catRpc('pesquisa_ver',{p_id:_wcProcId});
    if(!p)return;
    if(p.estado==='pendente')return;
    wcProcPararPolling();
    if(p.estado==='erro'){wcProcErro(p.erro);return;}
    wcProcMostrarRevisao(p);
  }catch(e){
    wcProcPararPolling();
    wcProcErro(e.message);
  }
}
/* Ao abrir a ficha: há uma pesquisa deste vinho ainda a correr, ou acabada
   e por rever? Sem isto, fechar a janela a meio deitava o resultado fora. */
async function wcProcRetomar(id){
  try{
    const p=await catRpc('pesquisa_por_rever',{p_vinho_id:id});
    if(!p||!_wcFicha||_wcFicha.id!==id)return;
    if(p.estado==='pendente'){
      if(_wcProcId===p.id)return;
      const c=wcProcCaixa();
      if(c)c.innerHTML=`<div class="pr-espera"><div class="wc-spin escuro"></div>
        <div><strong>A pesquisar…</strong><div class="wc-note">Quando acabar, mostra-te o que encontrou
          para escolheres o que guardar.</div></div></div>`;
      wcProcIniciarPolling(p.id);
      return;
    }
    _wcRev={pesquisaId:p.id,vinhoId:id,res:p.resultado||{}};
    wcProcLembrete();
  }catch(_){ /* é um lembrete — a ficha abre na mesma */ }
}

/* ══════════════════════════════════════════════
   REVER ANTES DE GRAVAR — o ecrã da Garrafeira (`iaMostrarResultado`)

   Uma linha por campo: o nome, o que está agora (riscado) → o que a
   pesquisa encontrou, e de onde veio o que está agora (a `og-tag` do resto
   da app — a Garrafeira não precisa disto, aqui é a razão de a app existir).
   Vêm marcados SÓ os campos vazios: trocar um valor que já lá estava tem de
   ser um clique consciente. Os que vieram iguais não fazem linha — diz-se
   quantos foram, que é também uma resposta ("confirmou o que já lá está").

   Os valores gravam-se do lado do servidor, a partir da linha da pesquisa;
   daqui só vai a lista dos campos marcados.
   ══════════════════════════════════════════════ */
function wcRvVazio(v){return v==null||v===''||(Array.isArray(v)&&!v.length);}
/* Só para o ECRÃ (esconder as linhas iguais). Quem decide ao gravar é a
   `winecatalog.igual` — isto é a mesma ideia: sem acentos nem maiúsculas,
   números como números, castas como conjunto. */
function wcRvIgual(a,b){
  if(wcRvVazio(a)||wcRvVazio(b))return wcRvVazio(a)&&wcRvVazio(b);
  const n=x=>String(x).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
  if(Array.isArray(a)||Array.isArray(b)){
    if(!Array.isArray(a)||!Array.isArray(b))return false;
    const c=l=>[...new Set(l.map(n))].sort().join('|');
    return c(a)===c(b);
  }
  const num=/^-?\d+(\.\d+)?$/;
  if(num.test(String(a).trim())&&num.test(String(b).trim()))return Number(a)===Number(b);
  return n(a)===n(b);
}
function wcRvNome(k){
  if(k==='produtor')return 'Produtor';
  if(k==='vivino_url')return 'Link do Vivino';
  const c=WC_FICHA.find(([x])=>x===k);
  return c?c[1]:k;
}
/* Os links vão INTEIROS: é o fim deles (o número do vinho no Vivino) que
   distingue dois, e decide-se abrindo-os — a mesma lição do `escLink` da
   Garrafeira. A imagem mostra-se, que é assim que se escolhe uma imagem. */
function wcRvValorHTML(k,v){
  if(wcRvVazio(v))return '<em class="rv-vazio">vazio</em>';
  if(Array.isArray(v))return esc(v.join(', '));
  if(typeof v==='object')return esc(JSON.stringify(v));
  const s=String(v);
  if(/^https?:\/\/\S+$/i.test(s)){
    const img=k==='imagem_url'?`<img class="rv-img" src="${esc(s)}" alt="" onerror="this.remove()">`:'';
    return img+`<a class="rv-lnk" href="${esc(s)}" target="_blank" rel="noopener">${esc(s)}<span>↗</span></a>`;
  }
  if(k==='preco_medio')return esc(eurFmt(v));
  if(k==='teor')return esc(s)+' %';
  return esc(s);
}
function wcRvOrdem(k){
  if(k==='produtor')return -1;
  const i=WC_FICHA.findIndex(([c])=>c===k);
  return i<0?999:i;
}
/* As linhas (e o que ficou de fora por vir igual). */
function wcRvLinhas(res){
  const props=(Array.isArray(res.propostas)?res.propostas:[]).slice()
    .sort((a,b)=>wcRvOrdem(a.campo)-wcRvOrdem(b.campo));
  const iguais=[], linhas=[];
  for(const p of props){
    const k=p.campo;
    if(!p.identidade&&wcRvIgual(p.atual,p.valor)){iguais.push(k);continue;}
    const vazio=wcRvVazio(p.atual);
    const f=Number(p.forcaAtual||0);
    const orig=!vazio&&p.origemAtual
      ?`<span class="og-tag ${wcOrigemCls(p.origemAtual,f)}">agora: ${esc(wcOrigemTxt(p.origemAtual,f))}</span>`:'';
    linhas.push(`<label class="rv-linha">
      <input type="checkbox" data-campo="${esc(k)}"${vazio?' checked':''}>
      <span class="rv-campo">
        <b>${esc(wcRvNome(k))}</b>
        ${vazio?'':`<span class="rv-antes">${wcRvValorHTML(k,p.atual)}</span><span class="rv-seta">→</span>`}<span class="rv-novo">${wcRvValorHTML(k,p.valor)}</span>
        ${wcRvFonteHTML(p.fonte)}
        ${orig}
        ${p.identidade?'<span class="rv-nota">O produtor é a identidade do vinho. Se com ele esta linha passar a ser a mesma que outra, não muda — junta-as em Duplicados.</span>':''}
      </span>
    </label>`);
  }
  return {linhas,iguais,total:props.length};
}
/* DE ONDE VEIO o valor encontrado (27/09/2026, o dono das apps): a página
   ou o resultado da pesquisa que a IA diz ter lido (`deOnde` na
   `catalogo-info`), o link colado, ou a pesquisa Google do grounding — que
   não diz a página. Sem `fonte` (a resposta colada, ou a IA a não dizer),
   não se escreve nada: não se inventa uma origem. */
function wcRvFonteHTML(f){
  if(!f||typeof f!=='object')return '';
  if(f.google)return '<span class="rv-de">↳ da pesquisa Google <i>(a IA não diz a página)</i></span>';
  if(!f.url)return '';
  const lnk=`<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.site||f.url)}</a>`;
  if(f.dada&&!f.pagina)return `<span class="rv-de">↳ do link que colaste · ${lnk}</span>`;
  return `<span class="rv-de">↳ de ${lnk} <i>${f.pagina?'· página lida':'· resumo no Google'}</i></span>`;
}
/* O corpo da revisão, igual para um vinho e para o lote; muda só a lista
   (`id`) e os botões. */
function wcRevisaoCorpo(res,o){
  const r=wcRvLinhas(res);
  const nIg=r.iguais.length;
  const igual=nIg?`<p class="wc-note">${nIg===1?'Mais 1 campo veio':'Mais '+nIg+' campos vieram'} igual ao que
    já está (${esc(r.iguais.map(wcRvNome).join(', '))}).</p>`:'';
  let h='';
  /* As mesmas palavras da Garrafeira: o que a pesquisa fez, numa frase. */
  const manual=res.pesquisaWeb!==true&&res.pesquisaWeb!==false;
  // Desde 27/09/2026 a pesquisa automática é uma só (o Serper e depois o
  // grounding pelo que falta, na Edge Function): já não há "avançada".
  const quem=manual?'A resposta colada':res.soSites?'A leitura dos sites escolhidos':'A pesquisa com IA';
  const n=r.linhas.length;
  h+=`<p class="wc-note" style="font-size:13.5px;color:var(--tx)">${quem} terminou e ${n
    ?`trouxe informação nova em <b>${n}</b> ${n===1?'campo':'campos'}.`:'não trouxe nada de novo.'}</p>`;
  if(res.aviso)h+=`<div class="rv-aviso">⚠️ ${esc(res.aviso)}</div>`;
  const semF=Array.isArray(res.semFonte)?res.semFonte:[];
  if(semF.length)h+=`<div class="rv-aviso">${semF.length===1?'1 campo veio':semF.length+' campos vieram'} sem a IA dizer
    de que página o tirou (${esc(semF.map(wcRvNome).join(', '))}) — com “só estes sites”, ficou de fora.</div>`;
  if(!manual&&res.pesquisaWeb===false){
    h+=`<div class="rv-memoria"><span>🧠 A IA respondeu <b>de memória</b>, sem pesquisar na net — confere antes de guardar.</span></div>`;
  }
  if(r.linhas.length){
    h+=`<p class="wc-note"><strong>Ainda não foi gravado nada.</strong> Só entra o que ficar marcado.
      Já vêm marcados os campos que estavam <b>vazios</b>; para trocar o que já lá estava, marca à mão.</p>
      <div class="rv-lista" id="${o.id}">${r.linhas.join('')}</div>${igual}
      <div class="macoes fim">${o.botoes(true)}</div>`;
  }else{
    h+=`<p class="wc-note">${r.total
        ?'O que está na ficha já bate certo com o que se encontrou.'
        :'Não confirmou nenhum dos campos pedidos. Não é um erro: é o modelo a não inventar, que é o que se lhe pede.'}</p>
      ${igual}<div class="macoes fim">${o.botoes(false)}</div>`;
  }
  const fontes=Array.isArray(res.fontes)?res.fontes:[];
  if(fontes.length)h+=`<div class="rv-fontes">Fontes: ${fontes.map(f=>
    `<a href="${esc(f.url||'#')}" target="_blank" rel="noopener">${esc(f.titulo||f.url||'fonte')}</a>`).join(' · ')}</div>`;
  h+=wcRvSitesHTML(res);
  h+=`<div class="rv-fontes"><i>${
    res.pesquisaWeb===false?'⚠️ Isto saiu da memória do modelo, sem pesquisa na net — confere tudo antes de aceitar.'
    :res.soSites?'Lido só das páginas e dos resultados dos sites escolhidos — confere antes de aceitar.'
    :res.pesquisaWeb===true?(res.profunda?'Pesquisado no Google (e lido dos resultados).':'Pesquisado no Google.')+
      ' Leitura automática de páginas da net — vale como ponto de partida, não como certeza.'
    :'Resposta colada de um assistente de IA — confere antes de aceitar.'}${res.modelo?` · ${esc(res.modelo)}`:''}</i></div>`;
  return h;
}
/* O QUE SE FEZ COM OS SITES DE CONFIANÇA (27/09/2026). A `catalogo-info`
   procura o vinho em cada domínio e LÊ a página que encontrar (e as que se
   colaram), e diz o que aconteceu a cada uma (`paginas`) e quantos
   resultados vieram de cada site (`confianca`); sem nada disso (pesquisa
   colada, ou sem Serper) foram só uma frase no pedido à IA, e diz-se isso —
   era o que não se sabia. */
function wcRvSitesHTML(res){
  const sites=Array.isArray(res.sites)?res.sites:[];
  if(!sites.length)return '';
  const c=res.confianca&&typeof res.confianca==='object'?res.confianca:null;
  const pags=Array.isArray(res.paginas)?res.paginas:[];
  const titulo=res.soSites?'Só estes sites':'Sites de confiança';
  if(!c&&!pags.length)return `<div class="rv-fontes">${titulo} (${esc(sites.join(', '))}): foram só
    no texto do pedido — ${res.pesquisaWeb===true||res.pesquisaWeb===false
      ?'não houve pesquisa nossa no Google desta vez, por isso não há como confirmar se a IA os usou.'
      :'não há como confirmar se o assistente os usou.'}</div>`;
  const doSite=(x,d)=>!!x&&(x===d||x.endsWith('.'+d));
  const lnk=p=>p.url?`<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.titulo||p.url)}</a>`:'';
  const pagFrase=p=>{
    const l=lnk(p);
    if(p.estado==='lida')return `página lida${p.dada?' (a que colaste)':''} — ${l}`;
    if(p.estado==='recusada')return `a página recusou a leitura (${esc(p.motivo||'bloqueio')})${l?' — '+l:''}`;
    if(p.estado==='vazia')return `${esc(p.motivo||'a página não tem texto')}${l?' — '+l:''}`;
    if(p.estado==='nao_encontrada')return 'o vinho não apareceu na procura neste site';
    if(p.estado==='sem_pesquisa')return 'sem a pesquisa externa não há como procurar dentro do site — cola o link da página';
    return `${p.url?'não abriu':'falhou'} (${esc(p.motivo||'erro')})${l?' — '+l:''}`;
  };
  const linhas=sites.map(s=>{
    const ps=pags.filter(p=>doSite(p.site,s));
    const n=c&&s in c?Number(c[s])||0:null;
    const partes=ps.map(pagFrase);
    if(n!==null&&!ps.some(p=>p.estado==='lida'||p.estado==='nao_encontrada'))partes.push(`${n} resultado${n===1?'':'s'} da pesquisa`);
    if(!partes.length)partes.push(n===null?'não é um domínio — só no texto do pedido':'nada');
    return `<li><b>${esc(s)}</b>: ${partes.join(' · ')}</li>`;
  });
  return `<div class="rv-fontes">${titulo}:<ul class="rv-sites">${linhas.join('')}</ul></div>`;
}
function wcRevNovos(res){return wcRvLinhas(res).linhas.length;}
function wcRevTodos(id,on){
  document.querySelectorAll(`#${id} input[data-campo]`).forEach(c=>c.checked=on);
}
function wcRevMarcados(id){
  return [...document.querySelectorAll(`#${id} input[data-campo]:checked`)].map(c=>c.dataset.campo);
}
/* O que a `pesquisa_aplicar` respondeu, numa frase. */
function wcRevResumo(r){
  const n=((r&&r.entrou)||[]).length+(r&&r.produtor?1:0);
  let t=n?`${n} campo${n>1?'s':''} guardado${n>1?'s':''}`:'nada mudou';
  const m=((r&&r.mudaram)||[]).length;
  if(m)t+=` · ${m} mudou entretanto no catálogo e ficou como estava`;
  if(r&&r.produtorErro)t+=` · o produtor não mudou: ${r.produtorErro}`;
  return t;
}

/* Um vinho: a pesquisa acabou. */
function wcProcMostrarRevisao(p){
  const res=p.resultado||{};
  if(!res.rever){
    // Uma pesquisa arrancada pela app antiga (em cache) já gravou sozinha.
    toast('A pesquisa acabou e gravou pelas regras antigas — vê a ficha.');
    wcRefrescarFicha();
    return;
  }
  _wcRev={pesquisaId:p.id,vinhoId:p.vinhoId,res};
  wcProcLembrete();
  // Por cima de outro ecrã (o Editar, por exemplo) não se abre nada: fica o
  // lembrete na ficha.
  const outro=[...document.querySelectorAll('.modal.on')].some(m=>m.id!=='modal-ficha'&&m.id!=='modal-procurar');
  if(outro){toast('A pesquisa acabou — revê o que encontrou na ficha do vinho');return;}
  wcRevAbrir();
}
/* O lembrete na ficha, por baixo dos botões: fica enquanto a pesquisa
   estiver por rever, feche-se a janela como se fechar. */
function wcProcLembrete(){
  const c=wcProcCaixa();
  if(!c||!_wcRev||!_wcFicha||_wcFicha.id!==_wcRev.vinhoId)return;
  const n=wcRevNovos(_wcRev.res);
  if(!n){c.innerHTML='';return;}
  c.innerHTML=`<div class="pr-espera rv-lembrete"><div>📋</div>
    <div><strong>Há uma pesquisa por rever</strong>
      <div class="wc-note">${n} campo${n>1?'s':''} com informação nova — nada foi gravado ainda.</div></div>
    <button class="btn-prim auto" onclick="wcRevAbrir()">Rever</button></div>`;
}
function wcRevAbrir(){
  if(!_wcRev)return;
  const box=document.getElementById('procurar-corpo');
  if(!box)return;
  const n=wcRevNovos(_wcRev.res);
  box.innerHTML=wcRevisaoCorpo(_wcRev.res,{id:'rv-lista',profunda:true,botoes:tem=>tem
    ?`<button class="btn-prim auto" id="rv-ir" onclick="wcRevGuardar()">Guardar o que está marcado</button>
      <button class="btn-n" onclick="wcRevTodos('rv-lista',true)">Marcar tudo</button>
      <button class="btn-n" onclick="wcRevDescartar()">Descartar</button>`
    :`<button class="btn-prim auto" onclick="wcRevDescartar()">Fechar</button>`});
  wcProcTitulo(n?'O que se encontrou':'Procurar informação');
  abrirModal('modal-procurar');
  wcProcTopo();
  // Nada de novo = nada a decidir: a pesquisa não fica à espera na ficha.
  if(!n)wcRevDescartar(true);
}
async function wcRevGuardar(){
  const rv=_wcRev;
  if(!rv)return;
  const campos=wcRevMarcados('rv-lista');
  if(!campos.length){toast('Não marcaste nada — marca o que queres guardar, ou Descartar',1);return;}
  const b=document.getElementById('rv-ir');
  if(b){b.disabled=true;b.textContent='A guardar…';}
  try{
    const r=await catRpc('pesquisa_aplicar',{p_id:rv.pesquisaId,p_campos:campos});
    _wcRev=null;
    fecharModal('modal-procurar');
    await wcRefrescarFicha();
    wcCarregarCatalogo(true);
    const n=((r&&r.entrou)||[]).length+(r&&r.produtor?1:0);
    toast((n?'Ficha atualizada ✓ — ':'')+wcRevResumo(r),!!(r&&r.produtorErro)||!n);
  }catch(e){
    toast('Não foi possível guardar: '+e.message,1);
    if(b){b.disabled=false;b.textContent='Guardar o que está marcado';}
  }
}
/* Descartar = a pesquisa deixa de ficar à espera na ficha. Não mexe em nada
   do vinho. `quieto`: sem fechar a janela (o "nada de novo" continua à vista). */
async function wcRevDescartar(quieto){
  const rv=_wcRev;
  _wcRev=null;
  if(!quieto)fecharModal('modal-procurar');
  const c=wcProcCaixa();
  if(c)c.innerHTML='';
  if(rv)try{await catRpc('pesquisa_aplicar',{p_id:rv.pesquisaId,p_campos:[]});}catch(_){}
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
   colado, e segue exactamente o mesmo caminho a partir daí — as MESMAS
   propostas e a MESMA revisão antes de gravar (força 3 no que se aceitar,
   como qualquer pesquisa Google a sério). O polling do lado da app
   (`wcProcIniciarPolling`) não sabe a diferença — e não precisa de saber. */
let _wcManualCampos=null;

/* Espelho da regra do Vivino de `catalogo-info.ts` (`regraVivino`) — ver
   o comentário grande lá. A página é do VINHO; as NOTAS são duas (a de
   todas as colheitas e a de uma). `ano` undefined é o LOTE, onde cada
   vinho traz (ou não) o seu ano na lista. */
function wcManualRegraVivino(ano){
  const col=ano===undefined
    ?'"vivinoNota"/"vivinoAvaliacoes" — SÓ a da colheita indicada na lista (a página com "?year=<ano>", ou a dessa colheita na lista de colheitas); um vinho SEM ano na lista não as tem, fica só com a de todas. Se só vires a de todas as colheitas, deixa estas duas vazias — nunca copies a de todas para aqui.'
    :ano
    ?`"vivinoNota"/"vivinoAvaliacoes" — SÓ a da colheita ${ano}: a da página com "?year=${ano}", ou a dessa colheita na lista de colheitas. Se só vires a de todas as colheitas, deixa estas duas vazias — nunca copies a de todas para aqui.`
    :'"vivinoNota"/"vivinoAvaliacoes" ficam de fora: este vinho não tem colheita, e a única nota que serve é a de todas as colheitas.';
  return 'O Vivino tem DUAS notas, e não se misturam: "vivinoNotaGlobal"/"vivinoAvaliacoesGlobal" — a de TODAS as colheitas: a que a página do vinho mostra sem ano escolhido (…/w/<nº>, sem "?year="); '+col+' A nota é o número entre 1.0 e 5.0 ao lado das estrelas; as avaliações vêm logo a seguir, entre parêntesis — não uses números de outra zona da página. Uma colheita nunca tem mais avaliações do que o vinho todo. "vivinoUrl" é a página do VINHO (…/<nome>/w/<nº>), a mesma para todas as colheitas: o ano não faz parte da identidade dela — basta o nome e o produtor baterem certo. Mantém o link se tiveres a certeza da página, mesmo sem nota.';
}
/* "Tem de ser exatamente a colheita X" — espelho da `regraColheita`. */
function wcManualRegraColheita(ano){
  return `O que responderes tem de ser da colheita ${ano}: teor, estágio, preço, notas de prova e janela de uma colheita diferente ficam fora do JSON.`;
}
/* A pesquisa manual é grátis (é a conta do admin num assistente), por isso
   pede-se SEMPRE a pesquisa a sério — o equivalente à "pesquisa profunda"
   da automática. Mesmo texto no prompt de um vinho e no do lote. */
const WC_MANUAL_PESQUISA='PESQUISA OBRIGATÓRIA: antes de responderes, pesquisa MESMO na internet (Pesquisa Google ou a pesquisa web que tiveres) — pelo menos o Vivino do vinho e o preço em lojas portuguesas. NÃO respondas de memória: um valor que não vejas numa página fica vazio, mesmo que aches que sabes. Se não tiveres acesso à internet, diz isso em "aviso" e não preenchas nada.';
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

${WC_MANUAL_PESQUISA}

VINHO A IDENTIFICAR:
  ${linhas.join('\n  ')}
Hoje é ${hoje}.
${sitesTxt}${so}
REGRAS, e são a sério:
1. NÃO INVENTES. Um campo que não confirmes por pesquisa fica FORA do JSON (ou null) — este catálogo é lido por outras aplicações, e um palpite aqui propaga-se.
2. ${WC_MANUAL_REGRA_CUVEE}
3. ${wcManualRegraVivino(v.ano||null)}
4. "imagemUrl" é o link DIRETO de uma fotografia (acaba em .jpg/.jpeg/.png/.webp/.avif), nunca o link da página.
5. Se houver dúvida de homónimo, prioriza ano + produtor + região e diz o que ficou por confirmar em "aviso".
6. Castas separadas por nome (nunca "blend"/"lote"/"várias castas").
7. "precoMedio" é o preço de retalho em euros, garrafa de 0,75L.
8. ${v.ano?'"beberDe"/"beberAte" são anos (a janela DESTA colheita).':'Este vinho não tem colheita: NÃO há janela de consumo — deixa "beberDe"/"beberAte" de fora.'}
9. "produtorConfirmado" é o produtor tal como consta no rótulo ou numa loja oficial — usa o que vier em "Produtor" acima se estiver certo, ou corrige-o; deixa vazio se não tiveres a certeza, nunca inventes um nome.
${colheitaEspecifica&&v.ano?`10. ${wcManualRegraColheita(v.ano)}\n`:''}
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
${v.ano?`  "vivinoNota": 4.2,
  "vivinoAvaliacoes": 312,
`:''}  "vivinoNotaGlobal": 4.1,
  "vivinoAvaliacoesGlobal": 5234,
  "vivinoUrl": "",
  "imagemUrl": "",
  "precoMedio": 18.5,
${v.ano?`  "beberDe": 2026,
  "beberAte": 2034,
`:''}  "notasProva": "duas ou três frases sobre aroma, boca e final",
  "harmonizacao": "com que pratos",
  "resumo": "duas ou três frases sobre o vinho e o produtor",
  "aviso": "vazio, ou o que ficou por confirmar"
}

Se não conseguires identificar o vinho de todo, responde {"encontrado": false, "aviso": "porquê"}.`;
}

let _wcManualSites=[];
let _wcManualColado=null;   // {vinhoId, texto} — um JSON que falhou não obriga a colar outra vez
/* A resposta colada de outro assistente vive no EDITAR (27/09/2026, o dono
   das apps): é aí, ao lado de onde se escreve à mão, que se procura quem não
   quer gastar IA. Passa pela MESMA porta de sempre (`pesquisa_criar` + a
   `catalogo-info` com `resposta`) e pela mesma revisão — só se entra nela
   por outro sítio. Pede os campos vazios; sem nenhum vazio, pede todos. */
function wcEditarManual(){
  if(!_wcFicha||!isAdmin())return;
  fecharModal('modal-editar');
  wcAbrirProcurar();
  const cx=wcProcCaixas();
  if(!cx.some(c=>c.checked))cx.forEach(c=>c.checked=true);
  wcProcurarManual();
}
function wcProcurarManual(){
  if(!_wcFicha||!isAdmin())return;
  const campos=wcProcCaixas().filter(c=>c.checked).map(c=>c.value);
  if(!campos.length)return;
  _wcManualCampos=campos.length<WC_PROC_TOTAL?campos:null;
  const colheitaEspecifica=!!document.getElementById('pr-colheita-esp')?.checked;
  const ctx=wcContextoLer();
  _wcManualSites=ctx.sites; // o ecrã manual substitui a caixa: lê-se aqui
  const txt=wcManualPrompt(_wcManualCampos,colheitaEspecifica,ctx.notas,ctx.sites);
  const box=document.getElementById('procurar-corpo');
  if(!box)return;
  box.innerHTML=`
    <div class="pr-manual">
      <p class="wc-note">1. Copia o prompt. 2. Cola-o no assistente de IA que preferires (quanto
        mais capaz o modelo, melhor costuma ser o resultado — Gemini, ChatGPT, Claude, o que
        tiveres à mão). 3. Copia a resposta toda (o JSON) e cola-a aqui em baixo. 4. Vês campo a
        campo o que muda e escolhes o que guardar — nada entra antes disso, e não se gasta nada.</p>
      <label>Prompt a copiar</label>
      <textarea id="pr-manual-prompt" rows="6" readonly onclick="this.select()">${esc(txt)}</textarea>
      <button class="btn-n larg" onclick="wcManualCopiar()">📋 Copiar prompt</button>
      <label>Resposta (cola aqui)</label>
      <textarea id="pr-manual-resposta" rows="10" placeholder="Cola aqui o JSON que o modelo devolveu…">${
        _wcManualColado&&_wcManualColado.vinhoId===_wcFicha.id?esc(_wcManualColado.texto):''}</textarea>
      <p class="wc-note erro" id="pr-manual-erro"></p>
    </div>
    <div class="macoes fim">
      <button class="btn-n" onclick="wcAbrirProcurar()">‹ Voltar</button>
      <button class="btn-prim auto" id="pr-manual-ir" onclick="wcProcurarManualEnviar()">Ver o que muda ›</button>
    </div>`;
  wcProcTitulo('Pesquisa manual');
  wcProcTopo();
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
  _wcManualColado={vinhoId:_wcFicha.id,texto};
  const b=document.getElementById('pr-manual-ir');
  if(b){b.disabled=true;b.textContent='A ler…';}
  try{
    const p=await catRpc('pesquisa_criar',{p_vinho_id:_wcFicha.id});
    wcProcEspera(false,true);
    if(!p.jaAndava){
      const r=await fetch(FN_CATALOGO_INFO,{
        method:'POST',
        headers:{'Content-Type':'application/json',apikey:SB_KEY,
                 Authorization:'Bearer '+(_sbSession&&_sbSession.access_token)},
        body:JSON.stringify({pesquisaId:p.id,campos:_wcManualCampos,resposta:texto,sites:_wcManualSites,rever:true})
      });
      if(!r.ok&&r.status!==202){
        let msg='';try{msg=(await r.json()).error||'';}catch(_){}
        throw new Error(msg||('a função respondeu '+r.status));
      }
    }
    wcProcIniciarPolling(p.id);
  }catch(e){
    wcProcErro(e.message);
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
   `catalogo-info.ts` com `resposta` (e `rever`) no corpo — só que chamada
   uma vez por vinho, em vez de uma vez só. E revê-se da mesma maneira:
   vinho a vinho, no ecrã da Garrafeira (`wcRevisaoCorpo`), e só o que
   ficar marcado entra, pela `pesquisa_aplicar`. O Produtor fica de fora
   (é identidade, não ficha — por isso não está nas opções de campo aqui,
   só o que já está em `WC_CAMPOS`). Um atalho que escrevesse direto na
   `ficha` a partir do JSON colado, sem passar por ali, era a porta dos
   fundos que a app inteira evita.

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
  return `<div class="lote-passos">${['Vinhos','Campos','Prompt','Rever'].map((p,i)=>{
    const cls=i+1===n?' on':(i+1<n?' feito':'');
    return `<span class="lote-passo${cls}"><i>${i+1<n?'✓':i+1}</i><b>${esc(p)}</b></span>`;
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
    <div class="lote-campos" id="lote-campos">${WC_FICHA.map(([k,lbl])=>{
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
    vivino_nota:'4.2', vivino_avaliacoes:'312',
    vivino_nota_global:'4.1', vivino_avaliacoes_global:'5234', vivino_url:'""', imagem_url:'""',
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
  if(campos.some(k=>k.startsWith('vivino_')))r.push(wcManualRegraVivino(undefined));
  if(campos.includes('castas'))
    r.push('Castas separadas por nome (nunca "blend"/"lote"/"várias castas").');
  if(campos.includes('imagem_url'))
    r.push('"imagemUrl" é o link DIRETO de uma fotografia (acaba em .jpg/.jpeg/.png/.webp/.avif), nunca o link da página.');
  if(campos.includes('preco_medio'))
    r.push('"precoMedio" é o preço de retalho em euros, garrafa de 0,75L.');
  if(campos.includes('beber_de')||campos.includes('beber_ate'))
    r.push('"beberDe"/"beberAte" são anos, a janela da colheita indicada. Um vinho SEM ano na '+
      'lista não tem janela de consumo: deixa "beberDe"/"beberAte" de fora do objeto dele.');
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

${WC_MANUAL_PESQUISA} Faz pelo menos uma pesquisa POR VINHO.

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
        <li>A seguir vês, vinho a vinho, o que muda e escolhes o que guardar —
          <strong>nada é gravado antes disso</strong>.</li>
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
      <button class="btn-prim auto" id="lote-enviar" onclick="wcLoteEnviar()">Ver o que muda ›</button>
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
  if(btn){btn.disabled=true;btn.textContent='A ler…';}
  const progEl=document.getElementById('lote-progresso');
  const porId=new Map(lista.map(r=>[Number(r&&r.id),r]));
  const linhas=[..._wcLoteVinhos.values()].map(v=>({v,msg:'na fila',pesquisaId:null,res:null}));
  const pinta=()=>{
    if(!progEl)return;
    progEl.innerHTML=`<div class="pr-manual"><label>A ler a resposta</label>${linhas.map(l=>
      `<div class="lote-prog-l"><span>${esc(l.v.nome||'(sem nome)')}</span>`+
      `<span class="wc-note">${esc(l.msg||'')}</span></div>`).join('')}</div>`;
  };
  pinta();
  for(const l of linhas){
    const r=porId.get(l.v.id);
    if(!r){l.msg='não veio na resposta colada';pinta();continue;}
    if(r.encontrado===false){l.msg='não encontrado: '+(r.aviso||'sem razão indicada');pinta();continue;}
    l.msg='a ler…';pinta();
    try{
      const respostaObj={encontrado:true};
      for(const k of _wcLoteCampos){
        const jk=WC_CAMPOS_JSON[k]||k;
        if(r[jk]!==undefined)respostaObj[jk]=r[jk];
      }
      if(r.aviso)respostaObj.aviso=r.aviso;
      const p=await catRpc('pesquisa_criar',{p_vinho_id:l.v.id});
      if(!p.jaAndava){
        const resp=await fetch(FN_CATALOGO_INFO,{
          method:'POST',
          headers:{'Content-Type':'application/json',apikey:SB_KEY,
                   Authorization:'Bearer '+(_sbSession&&_sbSession.access_token)},
          body:JSON.stringify({pesquisaId:p.id,campos:_wcLoteCampos,resposta:JSON.stringify(respostaObj),rever:true})
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
        l.pesquisaId=p.id;
        l.res=res.resultado||{};
        const n=wcRevNovos(l.res);
        l.msg=n?`${n} campo${n>1?'s':''} com informação nova`:'nada de novo';
      }
    }catch(e){
      l.msg=e.message;
    }
    pinta();
  }
  if(btn){btn.disabled=false;btn.textContent='Ver o que muda ›';}
  wcLoteRever(linhas);
}

/* ── Passo 4: rever, vinho a vinho — o ecrã da Garrafeira ──
   Guardar passa ao vinho seguinte; Saltar descarta este (não fica à espera
   na ficha). Fechar a janela a meio deixa os que faltam por rever, cada um
   na ficha do seu vinho — não se perde nada. No fim, o que ficou de cada um. */
let _wcLoteRev=null;   // {fila:[linhas com proposta], i, todas:[linhas]}
function wcLoteRever(linhas){
  // Os que não trouxeram nada de novo não pedem decisão nenhuma.
  linhas.filter(l=>l.pesquisaId&&!wcRevNovos(l.res)).forEach(l=>{
    catRpc('pesquisa_aplicar',{p_id:l.pesquisaId,p_campos:[]}).catch(()=>{});
  });
  const fila=linhas.filter(l=>l.pesquisaId&&wcRevNovos(l.res));
  _wcLoteRev={fila,i:0,todas:linhas};
  if(!fila.length){wcLoteFim();return;}
  wcLoteMostrar();
}
function wcLoteMostrar(){
  const lr=_wcLoteRev, box=document.getElementById('lote-corpo');
  if(!lr||!box)return;
  const l=lr.fila[lr.i], ultimo=lr.i===lr.fila.length-1;
  const sub=[l.v.produtor,l.v.ano?String(l.v.ano):''].filter(Boolean).join(' · ');
  box.innerHTML=`${wcLotePassos(4)}
    <div class="lote-rv-cab">
      <span class="lote-cont">Vinho ${lr.i+1} de ${lr.fila.length}</span>
      <div class="lote-v-nome">${esc(l.v.nome||'(sem nome)')}</div>
      ${sub?`<div class="lote-v-sub">${esc(sub)}</div>`:''}
    </div>
    ${wcRevisaoCorpo(l.res,{id:'lote-rv-lista',botoes:()=>`
      <button class="btn-prim auto" id="lote-rv-ir" onclick="wcLoteGuardar()">${ultimo?'Guardar e terminar':'Guardar e seguinte ›'}</button>
      <button class="btn-n" onclick="wcRevTodos('lote-rv-lista',true)">Marcar tudo</button>
      <button class="btn-n" onclick="wcLoteSaltar()">Saltar</button>`})}`;
  wcLoteTopo();
}
async function wcLoteGuardar(){
  const lr=_wcLoteRev;
  if(!lr)return;
  const l=lr.fila[lr.i];
  const campos=wcRevMarcados('lote-rv-lista');
  if(!campos.length){toast('Não marcaste nada — marca o que queres guardar, ou Saltar',1);return;}
  const b=document.getElementById('lote-rv-ir');
  if(b){b.disabled=true;b.textContent='A guardar…';}
  try{
    const r=await catRpc('pesquisa_aplicar',{p_id:l.pesquisaId,p_campos:campos});
    l.msg=wcRevResumo(r);
    l.feito=true;
    wcLoteSeguinte();
  }catch(e){
    toast('Não foi possível guardar: '+e.message,1);
    if(b){b.disabled=false;b.textContent=lr.i===lr.fila.length-1?'Guardar e terminar':'Guardar e seguinte ›';}
  }
}
function wcLoteSaltar(){
  const lr=_wcLoteRev;
  if(!lr)return;
  const l=lr.fila[lr.i];
  l.msg='saltado — nada gravado';
  l.feito=true;
  catRpc('pesquisa_aplicar',{p_id:l.pesquisaId,p_campos:[]}).catch(()=>{});
  wcLoteSeguinte();
}
function wcLoteSeguinte(){
  const lr=_wcLoteRev;
  lr.i++;
  if(lr.i>=lr.fila.length){wcLoteFim();return;}
  wcLoteMostrar();
}
/* O fim: vinho a vinho, o que ficou. É a resposta a "o que é que foi
   atualizado?" sem ter de abrir ficha nenhuma. */
function wcLoteFim(){
  const lr=_wcLoteRev, box=document.getElementById('lote-corpo');
  _wcLoteRev=null;
  wcCarregarCatalogo(true);
  if(!lr||!box)return;
  box.innerHTML=`${wcLotePassos(5)}
    <div class="pr-manual"><label>O que ficou</label>${lr.todas.map(l=>
      `<div class="lote-prog-l"><span>${esc(l.v.nome||'(sem nome)')}</span>`+
      `<span class="wc-note">${esc(l.msg||'')}</span></div>`).join('')}</div>
    <div class="macoes fim">
      <button class="btn-prim auto" onclick="fecharModal('modal-lote')">Fechar</button>
    </div>`;
  wcLoteTopo();
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
      ${wcNotaLinhaHTML(v)}
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

/* ── PRODUTORES OFICIAIS (27/09/2026, db/produtores.sql) ──
   O mesmo produtor escrito de várias maneiras. As sugestões vêm aos pares
   (grafias em que as palavras de uma estão todas na outra) e juntam-se em
   grupos para se escolher o oficial uma vez. Confirmar corrige o catálogo e
   todas as garrafeiras; um vinho que fique com a chave de outro que já
   existe não se mexe e aparece aqui em cima, nos Duplicados. O mesmo ecrã
   está no painel do PC (batch/painel.mjs). */
let _wcProd=null;
function wcProdGrupos(pares){
  const pai={},ref=x=>pai[x]===undefined?(pai[x]=x):(pai[x]===x?x:(pai[x]=ref(pai[x])));
  const info={};
  for(const p of pares){for(const s of [p.a,p.b])info[s.produtor]=s;const ra=ref(p.a.produtor),rb=ref(p.b.produtor);if(ra!==rb)pai[ra]=rb;}
  const g={};for(const n of Object.keys(info))(g[ref(n)]=g[ref(n)]||[]).push(info[n]);
  return Object.values(g).map(l=>l.sort((x,y)=>(y.catalogo+y.garrafeiras)-(x.catalogo+x.garrafeiras)))
    .map(l=>({grafias:l,pares:pares.filter(p=>l.some(s=>s.produtor===p.a.produtor))}))
    .sort((a,b)=>a.grafias[0].produtor.localeCompare(b.grafias[0].produtor,'pt'));
}
async function wcProdCarregar(){
  const box=document.getElementById('prod-lista');
  if(!box)return;
  box.innerHTML='<p class="wc-note">A procurar…</p>';
  try{
    const [sug,ofi]=await Promise.all([catRpc('produtores_sugestoes'),catRpc('produtores_listar')]);
    _wcProd={grupos:wcProdGrupos(sug||[]),oficiais:ofi||[]};
    wcProdPintar();
  }catch(e){box.innerHTML=`<p class="wc-note erro">${esc(e.message)}</p>`;}
}
function wcProdPintar(){
  const G=_wcProd.grupos,O=_wcProd.oficiais;
  const grupos=G.length?G.map((g,i)=>{
    const oficial=(g.grafias.find(s=>s.oficial)||{}).oficial||'';
    const dif=g.pares.filter(p=>!p.mesmaChave);
    return `<div class="prod-g" data-i="${i}">
      ${g.grafias.map((s,j)=>`<div class="prod-l">
        <input type="checkbox" class="prod-inc" data-p="${esc(s.produtor)}" checked title="Esta grafia é este produtor">
        <label><input type="radio" name="prod-of-${i}" value="${esc(s.produtor)}"${(oficial?s.produtor===oficial:j===0)?' checked':''}>
          <span><strong>${esc(s.produtor)}</strong><small>${s.catalogo} no catálogo · ${s.garrafeiras} nas garrafeiras${s.oficial?` · já é de <strong>${esc(s.oficial)}</strong>`:''}</small></span></label>
      </div>`).join('')}
      <div class="prod-l"><label><input type="radio" name="prod-of-${i}" value="__outro"> outro nome:</label>
        <input type="text" class="prod-outro" placeholder="nome oficial"></div>
      <div class="prod-acoes"><button class="btn-prim auto" onclick="wcProdJuntar(${i})">Juntar</button>
        ${dif.map(p=>`<button class="btn-n" onclick="wcProdDiferentes(${i},${g.pares.indexOf(p)})">${g.pares.length>1?`${esc(p.a.produtor)} ≠ ${esc(p.b.produtor)}`:'Não são o mesmo'}</button>`).join('')}</div>
    </div>`;}).join(''):'<p class="wc-note">Nada por decidir.</p>';
  const ofi=O.length?`<details style="margin-top:10px"><summary class="wc-note">Produtores oficiais já definidos (${O.length})</summary>
    ${O.map(p=>`<div class="prod-ofi"><strong>${esc(p.nome)}</strong>
      <span class="prod-compl"><input type="text" id="prod-compl-${p.id}" value="${esc(p.nome_completo||'')}" placeholder="nome completo (opcional)">
        <button class="btn-n" onclick="wcProdCompleto(${p.id})">Guardar</button></span>
      <span class="wc-note">${(p.variantes||[]).map(v=>`${((v.escritos&&v.escritos.length)?v.escritos:[v.escrito]).map(esc).join(' = ')}${v.oficial?'':` <a href="#" title="Deixar de trocar esta grafia (o que já foi corrigido fica)" onclick="wcProdTirar('${escJs(v.chave)}');return false">✕</a>`}`).join(' · ')}</span></div>`).join('')}
  </details>`:'';
  document.getElementById('prod-lista').innerHTML=grupos+ofi;
}
async function wcProdJuntar(i){
  const el=document.querySelector(`.prod-g[data-i="${i}"]`),g=_wcProd.grupos[i];
  const r_=el.querySelector(`input[name="prod-of-${i}"]:checked`);
  let oficial=r_?r_.value:'';if(oficial==='__outro')oficial=el.querySelector('.prod-outro').value.trim();
  const grafias=[...el.querySelectorAll('.prod-inc:checked')].map(c=>c.dataset.p);
  if(!oficial)return toast('Escolhe o nome oficial.',1);
  if(grafias.filter(x=>x!==oficial).length<1)return toast('Marca pelo menos uma grafia além do nome oficial.',1);
  const tot=g.grafias.filter(s=>grafias.includes(s.produtor)).reduce((a,s)=>a+s.catalogo+s.garrafeiras,0);
  if(!confirm(`Passar a “${oficial}” as grafias: ${grafias.join(' · ')}?\n\n${tot} vinho(s) no catálogo e nas garrafeiras ficam com este nome.`))return;
  try{
    const r=await catRpc('produtor_definir',{p_oficial:oficial,p_grafias:grafias});
    const d=r.duplicados||[];
    toast(`“${r.oficial}” ✓ ${r.catalogo} no catálogo · ${r.garrafeiras} nas garrafeiras`);
    if(d.length)alert(`Ficaram por mexer ${d.length}, porque já existe o mesmo vinho e colheita com o nome oficial — junta-os aqui nos Duplicados:\n`+d.map(x=>`#${x.id} ${x.nome}${x.ano?' '+x.ano:''} → #${x.com}`).join('\n'));
    wcProdCarregar();wcCarregarDuplicados();
  }catch(e){toast('Erro: '+e.message,1);}
}
async function wcProdDiferentes(i,k){
  const p=_wcProd.grupos[i].pares[k];
  if(!confirm(`“${p.a.produtor}” e “${p.b.produtor}” são produtores diferentes? O par não volta a ser sugerido.`))return;
  try{await catRpc('produtores_diferentes',{p_a:p.a.produtor,p_b:p.b.produtor});wcProdCarregar();}
  catch(e){toast('Erro: '+e.message,1);}
}
/* O nome por extenso ao lado do oficial: só para se ler na ficha do vinho,
   não mexe em vinho nenhum nem na chave. */
async function wcProdCompleto(id){
  const el=document.getElementById('prod-compl-'+id);if(!el)return;
  try{
    await catRpc('produtor_nome_completo',{p_id:id,p_nome_completo:el.value.trim()});
    toast(el.value.trim()?'Nome completo guardado ✓':'Nome completo retirado');
    wcProdCompletos(true);
  }catch(e){toast('Erro: '+e.message,1);}
}
async function wcProdTirar(chave){
  if(!confirm('Deixar de trocar esta grafia pelo nome oficial? O que já foi corrigido fica como está.'))return;
  try{await catRpc('produtor_tirar_variante',{p_chave:chave});wcProdCarregar();}
  catch(e){toast('Erro: '+e.message,1);}
}

/* ── NOMES DOS VINHOS (27/09/2026, db/nomes-normalizar.sql + nomes-manter.sql) ──
   O separador "Nomes de vinhos" do painel do PC, trazido para aqui a pedido
   do dono: não abre site nenhum, é a BD a comparar a BD. `nomes_rever` sem
   `p_aplicar` é a simulação (catálogo e garrafeiras); com ele aplica só os
   itens escolhidos, recalculando a regra no momento. As mesmas funções que o
   painel chama — a regra vive só no SQL.
   Um desmarcado fica desmarcado ao mudar os filtros (`_wcNomesOff`), e
   "Aplicar" leva só os marcados QUE SE VEEM: o que um filtro esconde não vai
   sem se ver. "Manter o produtor no nome" leva os PRODUTORES dos desmarcados
   que se veem e a quem a regra tirava o produtor da frente. */
let _wcNomes=null;
const _wcNomesOff=new Set();
const WC_NOMES_MUD={ano:'sai a colheita',produtor:'sai o produtor',produtor_entra:'entra o produtor',cor:'sai a cor'};
const wcSemAc=t=>String(t==null?'':t).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
const wcPalavras=id=>wcSemAc((document.getElementById(id)||{}).value).split(/\s+/).filter(Boolean);
const wcNomesChave=x=>x.fonte+':'+x.id;
function wcNomesMuda(x){return x.novo_nome!==x.nome||String(x.novo_ano??'')!==String(x.ano??'');}
async function wcNomesCarregar(){
  const box=document.getElementById('nomes-lista');
  if(!box)return;
  box.innerHTML='<p class="wc-note">A simular…</p>';
  try{
    _wcNomes=await catRpc('nomes_rever',{});
    _wcNomesOff.clear();
    document.getElementById('nomes-ctl').style.display='';
    document.getElementById('nomes-acoes').style.display='';
    wcNomesPintar();
  }catch(e){box.innerHTML=`<p class="wc-note erro">${esc(e.message)}</p>`;}
}
function wcNomesVisiveis(){
  const so=document.getElementById('nomes-so').checked;
  const onde=document.getElementById('nomes-onde').value,mud=document.getElementById('nomes-mud').value;
  const q=wcPalavras('nomes-q');
  return ((_wcNomes&&_wcNomes.linhas)||[]).filter(x=>(!so||wcNomesMuda(x))&&(!onde||x.fonte===onde)
    &&(!mud||(mud==='avisos'?(x.avisos||[]).length>0:(x.mudancas||[]).includes(mud)))
    &&(!q.length||(t=>q.every(p=>t.includes(p)))(wcSemAc([x.nome,x.novo_nome,x.produtor,x.garrafeira,x.dono,x.ano,
      x.fonte==='catalogo'?'catalogo #'+x.id:''].join(' ')))));
}
const wcNomesMarcados=()=>wcNomesVisiveis().filter(x=>wcNomesMuda(x)&&!_wcNomesOff.has(wcNomesChave(x)));
const wcNomesAManter=()=>wcNomesVisiveis().filter(x=>_wcNomesOff.has(wcNomesChave(x))&&(x.mudancas||[]).includes('produtor'));
function wcNomesContar(){
  const todos=(_wcNomes&&_wcNomes.linhas)||[],vis=wcNomesVisiveis().length,m=wcNomesMarcados().length;
  document.getElementById('nomes-n').textContent=`${todos.filter(wcNomesMuda).length} a mudar agora · ${todos.length} com alguma coisa · ${vis} à vista · ${m} marcado${m===1?'':'s'}`;
  const b=document.getElementById('btn-nomes');b.disabled=!m;b.textContent='Aplicar os marcados'+(m?` (${m})`:'');
  const k=wcNomesAManter().length,bm=document.getElementById('btn-nomes-manter');
  bm.disabled=!k;bm.textContent='Manter o produtor no nome'+(k?` (${k})`:'');
}
function wcNomesPintar(){
  if(!_wcNomes)return;
  const L=wcNomesVisiveis();
  document.getElementById('nomes-lista').innerHTML=L.length?`<div class="rv-lista arr-rol">${L.map(x=>{
    const m=wcNomesMuda(x),on=m&&!_wcNomesOff.has(wcNomesChave(x));
    const onde=x.fonte==='catalogo'
      ?`<a href="#" onclick="event.preventDefault();wcVerFicha(${Number(x.id)})">catálogo #${esc(String(x.id))}</a>`
      :`${esc(x.garrafeira||'garrafeira')} · ${esc(x.dono||'')}`;
    const tags=(x.mudancas||[]).map(k=>`<span class="arr-tag">${esc(WC_NOMES_MUD[k]||k)}</span>`).join('');
    const av=(x.avisos||[]).map(a=>`<span class="arr-tag aviso">${esc(a)}</span>`).join('');
    const ano=a=>a?` · ${esc(String(a))}`:'';
    return `<label class="rv-linha${m&&!on?' off':''}">
      ${m?`<input type="checkbox" data-k="${esc(wcNomesChave(x))}"${on?' checked':''} onchange="wcNomesMarca(this)">`:'<span class="arr-sem"></span>'}
      <span class="rv-campo">
        <b>${onde}</b>
        ${m?`<span class="rv-antes">${esc(x.nome)}${ano(x.ano)}</span><span class="rv-seta">→</span><span class="rv-novo">${esc(x.novo_nome)}${ano(x.novo_ano)}</span>`
          :`<span class="rv-novo">${esc(x.nome)}${ano(x.ano)}</span>`}
        <span class="arr-sub">${esc(x.produtor||'(sem produtor)')} · ${esc(x.tipo||'sem cor')}</span>
        ${tags||av?`<span class="arr-tags">${tags}${av}</span>`:''}
      </span>
    </label>`;}).join('')}</div>`
    :`<p class="wc-note">${(_wcNomes.linhas||[]).length?'Nenhum com estes filtros.':'Nada a mudar — os nomes estão todos arrumados.'}</p>`;
  wcNomesContar();
}
function wcNomesMarca(el){
  const k=el.dataset.k;
  if(el.checked)_wcNomesOff.delete(k);else _wcNomesOff.add(k);
  el.closest('.rv-linha').classList.toggle('off',!el.checked);
  wcNomesContar();
}
function wcNomesMarcar(on){
  for(const x of wcNomesVisiveis())if(wcNomesMuda(x)){if(on)_wcNomesOff.delete(wcNomesChave(x));else _wcNomesOff.add(wcNomesChave(x));}
  wcNomesPintar();
}
async function wcNomesAplicar(){
  const itens=wcNomesMarcados().map(x=>({fonte:x.fonte,id:x.id}));
  if(!itens.length)return toast('Marca pelo menos um vinho.',1);
  if(!confirm(`Aplicar o nome novo a ${itens.length} vinho(s) — os marcados que se veem?\n\nFica no histórico do catálogo e no registo da Garrafeira.`))return;
  try{
    const r=await catRpc('nomes_rever',{p_itens:itens,p_aplicar:true});
    const d=r.duplicados||[];
    toast(`Nomes ✓ ${r.catalogo} no catálogo · ${r.garrafeiras} nas garrafeiras`);
    if(d.length)alert(`Ficaram por mexer ${d.length} do catálogo, porque passavam a ser o mesmo vinho e colheita que outro — junta-os aqui nos Duplicados:\n`+
      d.map(x=>`#${x.id} ${x.nome}${x.ano?' '+x.ano:''} → #${x.com}`).join('\n'));
    wcNomesCarregar();
    if(d.length)wcCarregarDuplicados();
  }catch(e){toast('Erro: '+e.message,1);}
}
async function wcNomesManter(){
  const lista=wcNomesAManter();
  const itens=lista.map(x=>({fonte:x.fonte,id:x.id}));
  if(!itens.length)return toast('Desmarca os vinhos cujo produtor deve ficar no nome (os que o perdiam da frente).',1);
  const prods=[...new Set(lista.map(x=>x.produtor||''))].filter(Boolean);
  if(!confirm(`Nos vinhos destes produtores, o produtor fica no nome — e entra à frente, se lá não estiver (agora e nos que vierem; a colheita e a cor no fim continuam a sair):\n\n${prods.join('\n')}`))return;
  try{
    const r=await catRpc('produtores_no_nome_marcar',{p_itens:itens});
    toast(`${r.marcados} produtor(es) acrescentado(s) à lista ✓`);
    await wcNomesCarregar();
    const d=document.getElementById('nomes-manter');
    if(d&&d.closest('details').open)wcNomesManterListar();
  }catch(e){toast('Erro: '+e.message,1);}
}
async function wcNomesManterListar(){
  const el=document.getElementById('nomes-manter');
  if(!el)return;
  el.innerHTML='<p class="wc-note">A carregar…</p>';
  try{
    const L=await catRpc('produtores_no_nome_listar',{});
    el.innerHTML=(L||[]).length?L.map(m=>`<div class="prod-ofi">${esc(m.produtor)}
        <a href="#" title="Deixar a regra voltar a tirar este produtor da frente dos nomes" onclick="event.preventDefault();wcNomesManterTirar('${escJs(m.chave)}')">✕</a></div>`).join('')
      :'<p class="wc-note">Nenhum.</p>';
  }catch(e){el.innerHTML=`<p class="wc-note erro">${esc(e.message)}</p>`;}
}
async function wcNomesManterTirar(chave){
  if(!confirm('Tirar da lista? Os nomes deste produtor voltam a aparecer na simulação.'))return;
  try{
    await catRpc('produtores_no_nome_tirar',{p_chave:chave});
    wcNomesManterListar();
    if(_wcNomes)wcNomesCarregar();
  }catch(e){toast('Erro: '+e.message,1);}
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
    /* Os alertas das garrafeiras, os comentários e sugestões por tratar e
       os links do Vivino por validar contam todos: são as coisas à espera
       de uma decisão do admin. Sem a `db/comentarios.sql` corrida, os
       comentários contam zero em vez de apagar o número dos outros. */
    const [n1,n2,c]=await Promise.all([
      catRpc('contar_reportes',{}),
      catRpc('vivino_contar',{}).catch(()=>0),
      catRpc('contar_comentarios',{}).catch(()=>null)]);
    const cv=Number((c&&c.vinho)||0), cs=Number((c&&c.sugestao)||0);
    wcComContagem('vinho',cv);wcComContagem('sugestao',cs);
    const n=Number(n1||0)+Number(n2||0)+cv+cs;
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
  const nome=(()=>{const c=WC_FICHA.find(([x])=>x===r.campo);return c?c[1]:r.campo;})();
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
   COMENTÁRIOS E SUGESTÕES — o que as garrafeiras têm a dizer

   Vêm da Garrafeira (db/comentarios.sql; a porta de lá é a migração 26):
   um comentário sobre um vinho — atributos errados, um site de onde
   atualizar, outro problema — escrito na página do vinho, e uma sugestão
   sobre a app, escrita em Definições. Não é o "o errado é o catálogo" de
   cima: esse é UM campo que a comparação já viu diferente; aqui é o que a
   pessoa escreveu, mesmo quando o catálogo e a garrafeira dizem o mesmo —
   e estão os dois errados, que é o caso mais comum (a garrafeira trouxe o
   erro do catálogo).

   A resposta que se escreve ao fechar é o que a pessoa lê na Garrafeira,
   ao lado do que escreveu — por isso pede-se sempre, e não só ao recusar.
   ══════════════════════════════════════════════ */
const WC_COM_MOTIVO={
  atributos:'Atributos errados',atualizar:'Atualizar a partir de um site',outro:'Outro problema',
  melhoria:'Ideia / melhoria',problema:'Algo não funciona'
};
const WC_COM_ESTADO={aberto:'por tratar',duvida:'à espera de resposta',resolvido:'tratado',rejeitado:'recusado'};
/* A conversa: o comentário, e cada fala a seguir — as do admin (perguntar,
   fechar, recusar) e as de quem escreveu. É a mesma lista que a pessoa vê na
   Garrafeira, e é de cada fala nova que sai o push (migração 27 de lá). */
function wcComFalasHTML(c){
  const ms=c.mensagens||[];
  if(!ms.length)return '';
  const rot={duvida:'Perguntaste',resolvido:'Tratado',rejeitado:'Recusado'};
  return `<div class="com-fio">${ms.map(m=>{
    const adm=m.de==='admin';
    return `<div class="com-fala${adm?' adm':''}"><b>${esc(adm?(rot[m.estado]||'Admin'):'Quem escreveu')} · ${esc(dataFmt(m.quando))}${
      adm&&m.quem?` · ${esc(m.quem)}`:''}</b>${m.texto?esc(m.texto):''}</div>`;}).join('')}</div>`;
}
const _wcCom={vinho:{estado:'aberto',lista:[]},sugestao:{estado:'aberto',lista:[]}};

function wcComContagem(tipo,n){
  const el=document.getElementById('com-'+tipo+'-n');
  if(!el)return;
  el.textContent=n>0?String(n):'';
  el.classList.toggle('on',n>0);
}
function wcComCampoNome(k){
  const id={nome:'Nome',produtor:'Produtor',ano:'Ano'};
  if(id[k])return id[k];
  const c=WC_FICHA.find(([x])=>x===k);return c?c[1]:k;
}

async function wcComentarios(tipo,estado){
  const st=_wcCom[tipo];if(!st)return;
  st.estado=estado||'aberto';
  const box=document.getElementById('com-'+tipo+'-lista');
  if(!box)return;
  box.innerHTML='<div class="wc-card"><p class="wc-note">A carregar…</p></div>';
  try{
    const l=await catRpc('listar_comentarios',{p_tipo:tipo,p_estado:st.estado});
    st.lista=Array.isArray(l)?l:[];
    // "Por tratar" traz também os que esperam por quem escreveu (`duvida`);
    // o número é só a vez do admin.
    if(st.estado==='aberto')wcComContagem(tipo,st.lista.filter(c=>c.estado==='aberto').length);
    box.innerHTML=st.lista.length?st.lista.map(wcComentarioHTML).join('')
      :`<div class="wc-card"><p class="wc-note">${st.estado==='aberto'?'Nada por tratar.':'Ainda não chegou nada.'} ${
        tipo==='vinho'?'Os comentários chegam da página de cada vinho, na Garrafeira.'
                      :'As sugestões chegam de Definições, na Garrafeira.'}</p></div>`;
  }catch(e){
    // O "falta correr" do catRpc aponta para o catalogo.sql; aqui é outro.
    const m=/Falta correr/.test(e.message)?'Falta correr db/comentarios.sql no Supabase (ver db/README.md).':e.message;
    box.innerHTML=`<div class="wc-card"><p class="wc-note erro">${esc(m)}</p></div>`;
  }
}

function wcComentarioHTML(c){
  const vinho=c.tipo==='vinho';
  const val=x=>(x==null||x===''||(Array.isArray(x)&&!x.length)?'<em>vazio</em>'
    :esc(Array.isArray(x)?x.join(', '):String(x)));
  const motivo=esc(WC_COM_MOTIVO[c.motivo]||c.motivo);
  const cab=vinho
    ?`<div class="cat-nome">${esc(c.nome||'')}${c.ano?` <span class="cat-ano">${esc(String(c.ano))}</span>`:''}</div>
      <div class="cat-sub">${esc([c.produtor||'—',c.cor].filter(Boolean).join(' · '))} · <strong>${motivo}</strong></div>`
    :`<div class="cat-nome">${motivo}</div>`;
  /* Os campos de que se queixa: o que a pessoa tem, o que o catálogo tinha
     quando ela escreveu e — só se mudou entretanto — o de agora. Um vinho
     que ainda não estava no catálogo mostra só o de agora, se já lá estiver. */
  const cat=c.valoresCatalogo, ag=c.valoresAgora;
  const campos=(c.campos||[]).map(k=>{
    const agV=ag?ag[k]:undefined, catV=cat?cat[k]:undefined;
    const mudou=cat&&ag&&JSON.stringify(agV??null)!==JSON.stringify(catV??null);
    return `<div class="com-campo"><div class="com-campo-k">${esc(wcComCampoNome(k))}</div>
      <div class="rep-vals">
        <div class="deles"><span>na garrafeira de quem escreveu</span><b>${val((c.valoresDeles||{})[k])}</b></div>
        ${cat?`<div><span>no catálogo, então</span><b>${val(catV)}</b></div>`:''}
        ${mudou||(!cat&&ag)?`<div class="agora"><span>no catálogo, agora</span><b>${val(agV)}</b></div>`:''}
      </div></div>`;
  }).join('');
  const fechado=c.estado==='resolvido'||c.estado==='rejeitado';
  return `<div class="wc-card rep">
    <div class="rep-cab"><div>${cab}</div>
      <span class="rep-est ${esc(c.estado)}">${esc(WC_COM_ESTADO[c.estado]||c.estado)}</span></div>
    ${c.texto?`<p class="com-texto">${esc(c.texto)}</p>`:''}
    ${c.link?`<p class="wc-note com-link">🔗 <a href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">${esc(c.link)}</a></p>`:''}
    ${campos}
    ${wcComFalasHTML(c)}
    ${vinho&&c.vinhoId&&c.mesmaColheita===false?`<p class="wc-note">A linha do catálogo é da colheita
      ${c.anoCatalogo?esc(String(c.anoCatalogo)):'sem ano'}, não da de quem escreveu.</p>`:''}
    <p class="wc-note">${esc(c.quem||'')} · ${esc(dataFmt(c.quando))} · ${esc(c.app||'')}</p>
    <div class="rep-acoes">
      ${vinho?(c.vinhoId?`<button class="btn-n" onclick="wcVerFicha(${Number(c.vinhoId)})">Abrir a ficha</button>
        ${c.link?`<button class="btn-n" onclick="wcComProcurar(${Number(c.id)})" title="Abre o Procurar informação com este link nos sites de confiança">🔎 Procurar com este site</button>`:''}`
        :'<span class="wc-note">Este vinho ainda não está no catálogo.</span>'):''}
      ${fechado?`<button class="btn-n" onclick="wcComResponder(${Number(c.id)},'aberto')">Reabrir</button>`
        :`<button class="btn-n" onclick="wcComResponder(${Number(c.id)},'duvida')"
            title="Pergunta a quem escreveu — o comentário fica à espera da resposta dele, e ele recebe um aviso">❓ ${
            c.estado==='duvida'?'Perguntar outra vez':'Pedir mais informação'}</button>
          <button class="btn-n" onclick="wcComResponder(${Number(c.id)},'resolvido')">Tratado ✓</button>
          <button class="btn-n" onclick="wcComResponder(${Number(c.id)},'rejeitado')">Recusar</button>`}
    </div>
  </div>`;
}

async function wcComResponder(id,estado){
  let resposta=null;
  if(estado==='duvida'){
    resposta=prompt('Que pergunta queres fazer a quem escreveu? Recebe um aviso e responde-te na Garrafeira.');
    if(resposta===null)return;
    if(!resposta.trim()){toast('Escreve a pergunta',1);return;}
  }else if(estado!=='aberto'){
    resposta=prompt(estado==='rejeitado'
      ?'Porquê? Quem escreveu lê isto na Garrafeira (deixa vazio se não quiseres explicar).'
      :'Uma resposta para quem escreveu? Aparece-lhe na Garrafeira (opcional).');
    if(resposta===null)return;
  }
  try{
    await catRpc('responder_comentario',{p_id:id,p_estado:estado,p_resposta:resposta||null});
    toast(estado==='aberto'?'Reaberto':estado==='duvida'?'Pergunta enviada ✓':'Tratado ✓');
    const tipo=['vinho','sugestao'].find(t=>_wcCom[t].lista.some(c=>c.id===id))||'vinho';
    await wcComentarios(tipo,_wcCom[tipo].estado);
    wcContarAlertas();
  }catch(e){toast('Erro: '+e.message,1);}
}

/* "Atualizem a partir deste site": abre a ficha e o Procurar informação
   por cima, já com o link nos sites de confiança e, se o comentário disse
   que campos, só esses marcados. Nada grava sem a revisão de sempre. */
async function wcComProcurar(id){
  const c=_wcCom.vinho.lista.find(x=>x.id===id);
  if(!c||!c.vinhoId)return;
  await wcVerFicha(c.vinhoId);
  if(!_wcFicha||_wcFicha.id!==c.vinhoId)return;
  wcAbrirProcurar();
  const s=document.getElementById('pr-sites');
  if(s&&c.link)s.value=c.link;
  const ks=new Set(c.campos||[]), cx=wcProcCaixas();
  if(cx.some(x=>ks.has(x.value))){cx.forEach(x=>x.checked=ks.has(x.value));wcProcContar();}
}

/* ══════════════════════════════════════════════
   LINKS DO VIVINO — o batch da noite, e o que ele propõe

   O script (`batch/vivino-verificar.mjs`, no GitHub Actions) abre a página
   de cada vinho, confere o nome e lê a nota e as avaliações; se o link não
   abre ou é de outro vinho, procura no próprio Vivino. Sem IA e sem Serper.
   NÃO escreve na ficha: deixa uma proposta em `vivino_verificacoes`, e é
   aqui que o admin a aplica (pela `editar`, a mesma porta de uma correção
   à mão) ou a deixa como está. Ver db/vivino.sql.

   Porque é que não aplica sozinho: os links errados que isto veio apanhar
   foram escritos por uma máquina com ar de verdadeiros. Trocá-los por
   outros escolhidos por outra máquina, sem ninguém olhar, era repetir o erro.
   ══════════════════════════════════════════════ */
let _wcVivRev='pendente';
let _wcVivLista=[];
const WC_VIV_ESTADO={
  certo:['certo','o link abre este vinho'],
  errado:['outro vinho','o link abre OUTRO vinho'],
  diferente:['outro link','o Google aponta para outro link (o atual não foi aberto)'],
  nao_existe:['não abre','o link não abre (não existe ou não é de um vinho)'],
  nao_encontrado:['não encontrado','a procura não encontrou este vinho no Vivino'],
  sem_link:['sem link','o catálogo não tinha link'],
  bloqueado:['bloqueado','o Vivino recusou a página ao script'],
  erro:['erro','o script falhou neste vinho']
};

async function wcVivinoConfig(){
  const out=document.getElementById('viv-estado');
  if(!out)return;
  try{
    const c=await catRpc('vivino_config',{});
    document.getElementById('viv-lote').value=c.lote||10;
    const ult=c.ultima?dataFmt(c.ultima):'nunca';
    out.innerHTML=`Última execução: <strong>${esc(ult)}</strong> · verificados: ${nFmt(c.verificados)} de ${nFmt(c.total)}`+
      (c.fila?` · <strong>${nFmt(c.fila)}</strong> pedido(s) na fila`:'')+
      (c.pendentes?` · <strong>${nFmt(c.pendentes)}</strong> por validar em Alertas`:'');
  }catch(e){out.innerHTML=`<span class="erro">${esc(e.message)}</span>`;}
}

/* Só o lote: a frequência fica 'desligado' enquanto não houver cron (corre
   à mão — o Serper tem limite). A coluna continua na BD para esse dia. */
async function wcVivinoGuardar(){
  const lote=parseInt(String(document.getElementById('viv-lote').value||'').replace(/\D/g,''),10);
  if(!(lote>=1&&lote<=30)){toast('Vinhos de cada vez: de 1 a 30',1);return;}
  try{
    await catRpc('vivino_definir',{p_frequencia:'desligado',p_lote:lote});
    toast(`Guardado ✓ — ${lote} de cada vez`);
    wcVivinoConfig();
  }catch(e){toast('Erro: '+e.message,1);}
}

async function wcVivinoPedir(id){
  try{
    const r=await catRpc('vivino_pedir',{p_ids:[id]});
    toast(`Na fila ✓ — entra na próxima verificação (${r.fila} na fila)`);
  }catch(e){toast('Erro: '+e.message,1);}
}

async function wcVivinoLista(revisao){
  _wcVivRev=revisao||'pendente';
  const box=document.getElementById('viv-lista');
  if(!box)return;
  box.innerHTML='<div class="wc-card"><p class="wc-note">A carregar…</p></div>';
  try{
    const l=await catRpc('vivino_listar',{p_revisao:_wcVivRev});
    _wcVivLista=Array.isArray(l)?l:[];
    if(!_wcVivLista.length){
      box.innerHTML=`<div class="wc-card"><p class="wc-note">${
        _wcVivRev==='pendente'?'Nada por validar.':'O script ainda não verificou nenhum vinho.'
} Como correr a verificação: Definições › Links do Vivino.</p></div>`;
      return;
    }
    box.innerHTML=_wcVivLista.map(wcVivinoHTML).join('');
  }catch(e){
    box.innerHTML=`<div class="wc-card"><p class="wc-note erro">${esc(e.message)}</p></div>`;
  }
}

/* Um link lê-se ABRINDO-O, não lendo o texto — o endereço inteiro, porque é
   o número do fim que distingue um do outro (mesma regra do `escLink` da
   Garrafeira). */
function wcVivLink(u){
  if(u==null||u==='')return '<em>sem link</em>';
  const t=esc(String(u));
  return /^https?:\/\/[^\s]+$/.test(String(u))
    ?`<a href="${t}" target="_blank" rel="noopener">${t}</a>`:t;
}
function wcVivNum(n,casas){
  if(n==null||n==='')return '—';
  const x=Number(n);
  return isFinite(x)?x.toLocaleString('pt-PT',casas?{minimumFractionDigits:casas,maximumFractionDigits:casas}:{}):esc(String(n));
}

/* A nota de todas as colheitas, quando a há (a de cima é a da colheita). */
function wcVivGlobalHTML(x){
  if(!x||(x.vivino_nota_global==null&&x.vivino_avaliacoes_global==null))return '';
  return `<span class="viv-sub">todas as colheitas: ${wcVivNum(x.vivino_nota_global,1)} ★ · ${wcVivNum(x.vivino_avaliacoes_global)} avaliações</span>`;
}
/* Os "outros resultados" da procura — sem o que já é a proposta e sem o
   vinho do link que está no catálogo: esse foi aberto e não passou, e
   propô-lo como alternativa era propor o que já lá está (o "Ermelinda
   Freitas Syrah", 27/09/2026). As verificações de antes da correção do
   script ainda o trazem, por isso tira-se aqui também. Pelo NÚMERO do
   vinho: o mesmo /w/<nº> com outro texto no endereço é o mesmo vinho. */
const wcVivId=u=>(String(u||'').match(/\/w\/(\d+)/)||[])[1]||null;
function wcVivCands(r){
  const p=r.proposta||null;
  const atual=wcVivId((r.agora||{}).vivino_url)||wcVivId(r.urlAntes);
  const todos=(Array.isArray(r.candidatos)?r.candidatos:[]).filter(c=>c&&c.vivino_url&&(!p||c.vivino_url!==p.vivino_url));
  const cands=todos.filter(c=>!atual||wcVivId(c.vivino_url)!==atual);
  return {cands, mesmo:cands.length<todos.length||!!(r.detalhe&&r.detalhe.procura&&r.detalhe.procura.mesmo_link)};
}
function wcVivinoHTML(r,i){
  const [rot,desc]=WC_VIV_ESTADO[r.estado]||[r.estado,''];
  const a=r.agora||{}, p=r.proposta||null;
  const apagar=p&&('vivino_url' in p)&&p.vivino_url==null;
  const pesq='https://www.vivino.com/search/wines?q='+encodeURIComponent(
    [r.nome,r.produtor&&!String(r.nome||'').toLowerCase().includes(String(r.produtor).toLowerCase())?r.produtor:'']
      .join(' ').replace(/\(.*?\)/g,' ').trim());
  const {cands,mesmo}=wcVivCands(r);
  const pend=r.revisao==='pendente';
  // "Abre OUTRO vinho" sem proposta: o que há a decidir é se o link que lá
  // está é o certo. "O link está certo" grava-o como confirmado, e o script
  // deixa de o recusar pelo nome (ver `confirmados` na `vivino_linha`).
  // (Só se o link de agora for o que foi verificado: confirma-se o `url_antes`.)
  const confirmar=r.estado==='errado'&&!p&&!!wcVivId(a.vivino_url)&&wcVivId(a.vivino_url)===wcVivId(r.urlAntes);
  const porque=r.estado==='errado'&&r.detalhe&&r.detalhe.atual&&Array.isArray(r.detalhe.atual.porque)?r.detalhe.atual.porque:[];
  return `<div class="wc-card rep">
    <div class="rep-cab">
      <div>
        <div class="cat-nome">${esc(r.nome||'(vinho apagado)')}${r.ano?` <span class="cat-ano">${esc(String(r.ano))}</span>`:''}</div>
        <div class="cat-sub">${esc(r.produtor||'—')}${r.tipo?' · '+esc(r.tipo):''}</div>
      </div>
      <span class="rep-est viv-${esc(r.estado)}" title="${esc(desc)}">${esc(rot)}</span>
    </div>
    <p class="wc-note" style="margin-top:6px">${esc(desc)}${r.nomePagina?` — a página diz <strong>“${esc(r.nomePagina)}”</strong>`:''}</p>
    ${porque.length?`<p class="wc-note">O que não bate: ${porque.map(esc).join(' · ')}.</p>`:''}
    ${mesmo&&r.estado==='errado'?`<p class="wc-note">A procura no Vivino voltou a dar <strong>este mesmo vinho</strong> — não encontrou outro melhor. Se é mesmo este, “O link está certo”${porque.some(x=>/menção|palavras a mais|casta/.test(x))?' (ou corrige o nome no catálogo, em “Abrir a ficha”)':''}.</p>`:''}
    <div class="rep-vals">
      <div><span>no catálogo agora</span><b class="viv-url">${wcVivLink(a.vivino_url)}</b>
        <b>${wcVivNum(a.vivino_nota,1)} ★ · ${wcVivNum(a.vivino_avaliacoes)} avaliações</b>
        ${wcVivGlobalHTML(a)}</div>
      ${p?`<div class="agora"><span>${apagar?'proposta':'o script propõe'}</span>
        ${apagar?'<b>apagar o link (não encontrou o vinho no Vivino)</b>':
        `<b class="viv-url">${wcVivLink(p.vivino_url)}</b>
         <b>${wcVivNum(p.vivino_nota,1)} ★ · ${wcVivNum(p.vivino_avaliacoes)} avaliações</b>
         ${wcVivGlobalHTML(p)}
         ${p.nome?`<span class="viv-sub">“${esc(p.nome)}”${p.confianca!=null?` · parecença ${Math.round(Number(p.confianca)*100)}%`:''}</span>`:''}`}
      </div>`:''}
    </div>
    ${cands.length?`<div class="viv-cands"><span class="viv-sub">Outros resultados da procura no Vivino:</span>
      ${cands.map((c,k)=>`<div class="viv-cand">
        <a href="${esc(c.vivino_url)}" target="_blank" rel="noopener">${esc(c.texto||c.vivino_url)}</a>
        <span class="viv-sub">${c.parecenca!=null?Math.round(Number(c.parecenca)*100)+'%':''}${c.cor_bate===false?' · outra cor':''}${c.cor_bate!==false&&c.nome_bate===false?' · o nome não bate':''}</span>
        ${pend?`<button class="btn-n" onclick="wcVivinoUsar(${i},${k})">Usar este</button>`:''}
      </div>`).join('')}</div>`:''}
    <p class="wc-note">${esc(dataFmt(r.quando))}${r.revisao!=='pendente'?` · ${esc(r.revisao)}${r.revistoPor?' por '+esc(r.revistoPor):''}`:''}</p>
    <div class="rep-acoes">
      ${pend&&p?`<button class="btn-prim auto" onclick="wcVivinoResolver(${r.id},'aceite')">${apagar?'Apagar o link':'Aplicar'}</button>`:''}
      ${pend&&confirmar?`<button class="btn-prim auto" onclick="wcVivinoConfirmar(${r.id})">O link está certo</button>`:''}
      ${pend&&!confirmar?`<button class="btn-n" onclick="wcVivinoResolver(${r.id},'recusado')">Deixar como está</button>`:''}
      ${a.vivino_url&&!(pend&&apagar)?`<button class="btn-n" onclick="wcVivinoRetirar(${r.id})">Retirar o link</button>`:''}
      ${!pend&&r.revisao!=='sem_acao'?`<button class="btn-n" onclick="wcVivinoResolver(${r.id},'pendente')">Reabrir</button>`:''}
      <a class="btn-n" href="${esc(pesq)}" target="_blank" rel="noopener">Procurar no Vivino ↗</a>
      ${r.vinhoId?`<button class="btn-n" onclick="wcVerFicha(${Number(r.vinhoId)})">Abrir a ficha</button>`:''}
    </div>
  </div>`;
}

async function wcVivinoResolver(id,decisao,campos,msg){
  try{
    await catRpc('vivino_resolver',{p_id:id,p_decisao:decisao,p_campos:campos||null});
    toast(msg||(decisao==='aceite'?'Aplicado ✓':decisao==='pendente'?'Reaberto':'Fica como está ✓'));
    wcVivinoLista(_wcVivRev);
    wcContarAlertas();
  }catch(e){toast('Erro: '+e.message,1);}
}

/* O link que lá está é o certo — as regras do nome é que não o reconhecem
   (uma menção que o nome do catálogo não diz, uma palavra a mais). Fica
   'recusado' sem proposta, que é o que a `vivino_linha` lê como confirmado:
   o script não o volta a dar como "outro vinho". */
function wcVivinoConfirmar(id){
  if(!confirm('Confirmar que este link é deste vinho? O script deixa de o dar como "outro vinho" (a cor e a colheita continuam a ser conferidas).'))return;
  wcVivinoResolver(id,'recusado',null,'Confirmado ✓ — o script deixa de o recusar');
}

/* Retirar o link que está no catálogo, haja proposta ou não — para o link
   que não abre e a procura não achou nada melhor. Mesma porta de sempre (a
   `editar`, com um `vivino_url` a null, que APAGA o campo), e a verificação
   fica "aceite". Apagar não fixa nada: uma garrafeira que tenha o mesmo
   link escrito pode voltar a trazê-lo — ver "Editar" no CLAUDE.md. */
function wcVivinoRetirar(id){
  if(!confirm('Retirar o link do Vivino deste vinho? A nota e as avaliações ficam como estão.'))return;
  wcVivinoResolver(id,'aceite',{vivino_url:null});
}

/* Escolher um dos outros resultados: só o LINK entra — a nota e as
   avaliações desse resultado não foram lidas (a página dele não foi
   aberta), e ficar com os números do vinho errado era pior do que não os
   mudar. Na noite seguinte em que este vinho voltar a ser verificado, o
   script lê-os da página certa. */
function wcVivinoUsar(i,k){
  const r=_wcVivLista[i];
  if(!r)return;
  const c=wcVivCands(r).cands[k];
  if(!c)return;
  wcVivinoResolver(r.id,'aceite',{vivino_url:c.vivino_url});
}

/* ══════════════════════════════════════════════
   AS GARRAFEIRAS × O CATÁLOGO — os links do Vivino e o resto da ficha

   Os dois cartões do painel do PC que não abrem site nenhum, trazidos para
   a app a pedido do dono (27/09/2026): "o que é só comparação e análise de
   dados, podemos ter". As regras são as MESMAS e vivem num sítio só — as
   `garrafeira.links_vivino_rever`/`fichas_catalogo_rever` (migrações 18 e
   19 do repo Garrafeira) —, a que a app chega pelos invólucros de
   `db/garrafeiras-rever.sql`, com o `sou_admin()` à porta. Sem `p_aplicar`
   é só a lista; com ele, só o que se marcou, e as regras voltam a correr no
   momento (o que mudou entretanto não se aplica). Cada troca fica no
   `garrafeira.sync_log`, com o email do admin.

   Só se compara quando se pede: são dois ou três segundos a varrer todas as
   garrafeiras, e o separador Alertas abre muitas vezes para outra coisa.
   ══════════════════════════════════════════════ */
function wcLinkCat(id){
  return id?`<a href="#" onclick="event.preventDefault();wcVerFicha(${Number(id)})">catálogo #${esc(String(id))}</a>`:'';
}

/* ── Os links do Vivino ── */
let _wcGl=null;
const WC_GL_CASO={formato_invalido:'sem o nº do vinho',outro_vinho:'abre outro vinho',vazio:'sem link'};
const WC_GL_CONTA={mesmo_vinho:'já com o link do catálogo',catalogo_sem_link:'sem link no catálogo',
  sem_catalogo:'fora do catálogo',cor_diferente:'com cor diferente da do catálogo (não se tocam)'};
async function wcGlComparar(){
  const box=document.getElementById('gl-lista');
  if(!box)return;
  box.innerHTML='<p class="wc-note">A comparar…</p>';
  document.getElementById('gl-n').textContent='';
  try{_wcGl=await catRpc('garrafeiras_links_rever',{});wcGlPintar();}
  catch(e){box.innerHTML=`<p class="wc-note erro">${esc(e.message)}</p>`;}
}
function wcGlPintar(){
  const L=_wcGl.linhas||[],P=_wcGl.por_confirmar||[],C=_wcGl.contagens||{};
  const ficam=Object.entries(WC_GL_CONTA).filter(([k])=>C[k]).map(([k,t])=>`${C[k]} ${t}`).join(' · ');
  /* A força não vem na lista; o link é volátil, e vindo de uma garrafeira
     vale 2 (invariante 5) — é o único caso em que a legenda depende dela. */
  const og=o=>o?`<span class="og-tag ${wcOrigemCls(o,2)}">${esc(wcOrigemTxt(o,2))}</span>`:'';
  let h='';
  if(L.length){
    h+=`<div class="rv-lista arr-rol">${L.map(x=>`<label class="rv-linha">
      <input type="checkbox" class="gl-c" data-id="${Number(x.vinho_id)}" checked onchange="wcGlBotao()">
      <span class="rv-campo">
        <b>${esc(x.garrafeira||'garrafeira')} · ${esc(x.dono||'')}</b>
        <span class="arr-nome">${esc(x.nome)}${x.ano?' '+esc(String(x.ano)):''} <span class="arr-tag">${esc(WC_GL_CASO[x.caso]||x.caso)}</span></span>
        ${x.caso==='vazio'?'':`<span class="rv-antes">${wcRvValorHTML('vivino_url',x.antes)}</span><span class="rv-seta">→</span>`}<span class="rv-novo">${wcRvValorHTML('vivino_url',x.depois)}</span>
        <span class="arr-sub">${wcLinkCat(x.catalogo_id)} ${og(x.catalogo_origem)}</span>
      </span>
    </label>`).join('')}</div>`;
  }else h+='<p class="wc-note">Nada a corrigir.</p>';
  if(P.length){
    h+=`<p class="wc-note" style="margin-top:12px"><strong>Por confirmar</strong> — o link da garrafeira parece errado,
      mas o do catálogo ainda não foi confirmado. Abre os dois: se o do catálogo for o certo, marca
      <strong>usar o do catálogo</strong>. Na dúvida, pede primeiro a verificação no Vivino (o script trata-os
      antes dos outros, na próxima corrida) e volta a comparar.</p>
      <div class="rv-lista">${P.map(x=>`<div class="rv-linha">
        <span class="rv-campo">
          <b>${esc(x.garrafeira||'garrafeira')} · ${esc(x.dono||'')}</b>
          <span class="arr-nome">${esc(x.nome)}${x.ano?' '+esc(String(x.ano)):''} <span class="arr-tag">${esc(WC_GL_CASO[x.caso]||x.caso)}</span></span>
          <span class="rv-antes">${wcRvValorHTML('vivino_url',x.antes)}</span><span class="rv-seta">→</span><span class="rv-novo">${wcRvValorHTML('vivino_url',x.catalogo_url)}</span>
          <span class="arr-sub">${wcLinkCat(x.catalogo_id)} ${og(x.catalogo_origem)}</span>
          ${x.catalogo_url?`<label class="arr-chk"><input type="checkbox" class="gl-f" data-id="${Number(x.vinho_id)}" onchange="wcGlBotao()"> usar o do catálogo</label>`:''}
        </span>
      </div>`).join('')}</div>
      <div class="arr-barra"><button class="btn-n" onclick="wcGlPedir()">🍷 Pedir a verificação no Vivino</button></div>`;
  }
  if(ficam)h+=`<p class="wc-note">Ficam como estão: ${esc(ficam)}.</p>`;
  if(L.length||P.length)h+=`<div class="arr-barra"><button class="btn-prim auto" id="btn-gl" onclick="wcGlCorrigir()" disabled>Corrigir os marcados</button></div>`;
  document.getElementById('gl-lista').innerHTML=h;
  document.getElementById('gl-n').textContent=`${L.length} a corrigir`+(P.length?` · ${P.length} por confirmar`:'');
  wcGlBotao();
}
function wcGlBotao(){
  const b=document.getElementById('btn-gl');
  if(!b)return;
  const n=document.querySelectorAll('.gl-c:checked,.gl-f:checked').length;
  b.disabled=!n;
  b.textContent='Corrigir os marcados'+(n?` (${n})`:'');
}
/* Os "Por confirmar" vão para a fila do script (a mesma do "🍷 Verificar no
   Vivino" da ficha): ele abre a página do vinho do CATÁLOGO, e um link lido
   lá passa a confirmado — na comparação seguinte já sai na lista de cima. */
async function wcGlPedir(){
  const ids=[...new Set((_wcGl.por_confirmar||[]).map(x=>Number(x.catalogo_id)).filter(Boolean))];
  if(!ids.length)return;
  try{
    const r=await catRpc('vivino_pedir',{p_ids:ids});
    toast(`Na fila ✓ ${ids.length} vinho(s) do catálogo (${r.fila} na fila)`);
  }catch(e){toast('Erro: '+e.message,1);}
}
async function wcGlCorrigir(){
  const ids=[...document.querySelectorAll('.gl-c:checked')].map(c=>Number(c.dataset.id));
  const forcar=[...document.querySelectorAll('.gl-f:checked')].map(c=>Number(c.dataset.id));
  const n=ids.length+forcar.length;
  if(!n)return toast('Marca pelo menos um vinho.',1);
  if(!confirm(`Trocar o link do Vivino de ${n} vinho(s) nas garrafeiras pelo do catálogo?`+
    (forcar.length?`\n\n${forcar.length} por confirmar, confirmados por ti.`:'')))return;
  try{
    const r=await catRpc('garrafeiras_links_rever',{p_ids:[...new Set([...ids,...forcar])],p_aplicar:true,p_forcar:forcar.length?forcar:null});
    toast(`${r.aplicados} link(s) corrigido(s) ✓ — fica no registo da Garrafeira`);
    wcGlComparar();
  }catch(e){toast('Erro: '+e.message,1);}
}

/* ── O resto da ficha ── */
let _wcFich=null;
const _wcFichOff=new Set();          // `vinho:campo` desmarcados (sobrevivem aos filtros)
const WC_FICH_CONTA={outra_colheita:'de outra colheita (não se tocam)',
  cor_diferente:'com cor diferente da do catálogo (não se tocam)',sem_catalogo:'fora do catálogo'};
const wcFichNome=k=>WC_ROTULOS_EXTRA[k]||wcRvNome(k);
async function wcFichComparar(erros){
  const box=document.getElementById('fich-lista');
  if(!box)return;
  box.innerHTML='<p class="wc-note">A comparar…</p>';
  document.getElementById('fich-n').textContent='';
  try{
    _wcFich=await catRpc('garrafeiras_fichas_rever',{});
    if(erros&&erros.length)_wcFich.erros=erros;
    _wcFichOff.clear();
    wcFichCampos();
    document.getElementById('fich-ctl').style.display='';
    document.getElementById('fich-acoes').style.display='';
    wcFichPintar();
  }catch(e){box.innerHTML=`<p class="wc-note erro">${esc(e.message)}</p>`;}
}
/* O filtro por campo: os campos que vieram, pela ordem da ficha, com quantos
   vinhos cada um tem. Refeito a cada comparação, mantendo a escolha se o
   campo ainda lá estiver. */
function wcFichCampos(){
  const sel=document.getElementById('fich-campo'),antes=sel.value,n={};
  for(const x of _wcFich.linhas||[])for(const c of x.campos||[])n[c.campo]=(n[c.campo]||0)+1;
  const ks=Object.keys(n).sort((a,b)=>wcRvOrdem(a)-wcRvOrdem(b)||a.localeCompare(b));
  sel.innerHTML='<option value="">todos os campos</option>'+ks.map(k=>`<option value="${esc(k)}">${esc(wcFichNome(k))} (${n[k]})</option>`).join('');
  sel.value=ks.includes(antes)?antes:'';
}
/* Os vinhos à vista, cada um só com os campos à vista. */
function wcFichVisiveis(){
  const q=wcPalavras('fich-q'),campo=document.getElementById('fich-campo').value,caso=document.getElementById('fich-caso').value;
  return (_wcFich.linhas||[]).map(x=>{
    if(q.length){const t=wcSemAc([x.nome,x.produtor,x.ano,x.garrafeira,x.dono].join(' '));if(!q.every(p=>t.includes(p)))return null;}
    const cs=(x.campos||[]).filter(c=>(!campo||c.campo===campo)&&(!caso||c.caso===caso));
    return cs.length?{x,cs}:null;
  }).filter(Boolean);
}
const wcFichK=(v,c)=>v+':'+c;
function wcFichMarcados(){
  return wcFichVisiveis().map(({x,cs})=>({vinho_id:x.vinho_id,
    campos:cs.filter(c=>!_wcFichOff.has(wcFichK(x.vinho_id,c.campo))).map(c=>c.campo)})).filter(i=>i.campos.length);
}
function wcFichContar(){
  const tot=(_wcFich.linhas||[]).reduce((a,x)=>a+(x.campos||[]).length,0);
  const vis=wcFichVisiveis(),nv=vis.reduce((a,v)=>a+v.cs.length,0);
  const m=wcFichMarcados().reduce((a,i)=>a+i.campos.length,0);
  const nl=(_wcFich.linhas||[]).length;
  document.getElementById('fich-n').textContent=`${tot} campo${tot===1?'':'s'} em ${nl} vinho${nl===1?'':'s'}`+
    (nv!==tot?` · ${nv} à vista`:'')+` · ${m} marcado${m===1?'':'s'}`;
  const b=document.getElementById('btn-fich');
  b.disabled=!m;b.textContent='Trazer os marcados'+(m?` (${m})`:'');
}
function wcFichPintar(){
  if(!_wcFich)return;
  const V=wcFichVisiveis(),C=_wcFich.contagens||{};
  const ficam=Object.entries(WC_FICH_CONTA).filter(([k])=>C[k]).map(([k,t])=>`${C[k]} ${t}`).join(' · ');
  let h='';
  if((_wcFich.erros||[]).length)h+=`<p class="wc-note erro">Não gravou: ${_wcFich.erros.map(e=>`${esc(e.nome)} (${esc(e.erro)})`).join('; ')}</p>`;
  if(V.length){
    h+=`<div class="arr-rol">${V.map(({x,cs})=>{
      const todos=cs.every(c=>!_wcFichOff.has(wcFichK(x.vinho_id,c.campo)));
      return `<div class="arr-vinho">
        <label class="rv-linha arr-vcab">
          <input type="checkbox"${todos?' checked':''} onchange="wcFichVinho(${Number(x.vinho_id)},this.checked)">
          <span class="rv-campo">
            <span class="arr-nome">${esc(x.nome)}${x.ano?' '+esc(String(x.ano)):''}</span>
            <span class="arr-sub">${esc(x.garrafeira||'garrafeira')} · ${esc(x.dono||'')} · ${wcLinkCat(x.catalogo_id)}</span>
          </span>
        </label>
        ${cs.map(c=>{
          const on=!_wcFichOff.has(wcFichK(x.vinho_id,c.campo));
          const vazio=c.caso==='vazio'||wcRvVazio(c.antes);
          return `<label class="rv-linha${on?'':' off'}">
            <input type="checkbox" data-v="${Number(x.vinho_id)}" data-c="${esc(c.campo)}"${on?' checked':''} onchange="wcFichMarca(this)">
            <span class="rv-campo">
              <b>${esc(wcFichNome(c.campo))} · ${c.caso==='vazio'?'vazio na garrafeira':'mais recente no catálogo'}</b>
              ${vazio?'':`<span class="rv-antes">${wcRvValorHTML(c.campo,c.antes)}</span><span class="rv-seta">→</span>`}<span class="rv-novo">${wcRvValorHTML(c.campo,c.depois)}</span>
              ${c.origem?`<span class="og-tag ${wcOrigemCls(c.origem,c.forca)}">no catálogo: ${esc(wcOrigemTxt(c.origem,c.forca))}${c.em?' · '+esc(dataFmt(c.em)):''}</span>`:''}
            </span>
          </label>`;}).join('')}
      </div>`;}).join('')}</div>`;
  }else h+=`<p class="wc-note">${(_wcFich.linhas||[]).length?'Nenhum com estes filtros.':'Nada a acertar — as garrafeiras batem com o catálogo.'}</p>`;
  if(ficam)h+=`<p class="wc-note">Ficam como estão: ${esc(ficam)}.</p>`;
  document.getElementById('fich-lista').innerHTML=h;
  wcFichContar();
}
function wcFichMarca(el){
  const k=wcFichK(el.dataset.v,el.dataset.c);
  if(el.checked)_wcFichOff.delete(k);else _wcFichOff.add(k);
  el.closest('.rv-linha').classList.toggle('off',!el.checked);
  wcFichContar();
}
/* O visto do vinho marca e desmarca os campos DELE que estão à vista. */
function wcFichVinho(id,on){
  const v=wcFichVisiveis().find(({x})=>Number(x.vinho_id)===Number(id));
  if(!v)return;
  for(const c of v.cs){const k=wcFichK(id,c.campo);if(on)_wcFichOff.delete(k);else _wcFichOff.add(k);}
  wcFichPintar();
}
function wcFichMarcar(on){
  for(const {x,cs} of wcFichVisiveis())for(const c of cs){const k=wcFichK(x.vinho_id,c.campo);if(on)_wcFichOff.delete(k);else _wcFichOff.add(k);}
  wcFichPintar();
}
async function wcFichTrazer(){
  const itens=wcFichMarcados();
  const n=itens.reduce((a,i)=>a+i.campos.length,0);
  if(!n)return toast('Marca pelo menos um campo.',1);
  if(!confirm(`Trazer do catálogo ${n} campo(s) em ${itens.length} vinho(s) das garrafeiras — os marcados que se veem?\n\nFica no registo da Garrafeira, com o antes e o depois.`))return;
  try{
    const r=await catRpc('garrafeiras_fichas_rever',{p_itens:itens,p_aplicar:true});
    const erros=r.erros||[];
    toast(`${r.aplicados} campo(s) em ${r.vinhos_aplicados} vinho(s) ✓`+(erros.length?` · ${erros.length} não gravaram`:''),erros.length>0);
    wcFichComparar(erros);
  }catch(e){toast('Erro: '+e.message,1);}
}

/* ══════════════════════════════════════════════
   HISTÓRICO DE ALTERAÇÕES — o que mudou, de quê para quê, quem e quando

   Desde 25/09/2026 o script do Vivino e das lojas ESCREVE no catálogo (a
   pedido do dono), e a troca foi esta: tudo o que muda fica registado
   campo a campo (trigger na `vinhos`, db/historico.sql — seja qual for a
   porta por onde entrou), e cada linha tem "Repor", que volta a pôr o valor
   de antes pela `editar`. Na ficha, a história daquele vinho; em Alertas,
   as últimas do catálogo todo.
   ══════════════════════════════════════════════ */
const WC_CAMPO_NOME=Object.assign({nome:'Nome',produtor:'Produtor',ano:'Colheita',_criado:'Criado'},
  Object.fromEntries(WC_CAMPOS), WC_ROTULOS_EXTRA);
let _wcHist=[];

async function wcHistorico(vinhoId,alvo){
  const box=document.getElementById(alvo);
  if(!box)return;
  if(!vinhoId)box.innerHTML='<div class="wc-card"><p class="wc-note">A carregar…</p></div>';
  try{
    const l=await catRpc('historico',{p_vinho_id:vinhoId||null,p_limite:vinhoId?200:80});
    _wcHist=_wcHist.filter(x=>!(l||[]).some(y=>y.id===x.id)).concat(l||[]);
    if(!Array.isArray(l)||!l.length){
      const t='Ainda não há alterações registadas. O registo começou a 25/09/2026 — o que mudou antes disso só se vê na origem de cada campo.';
      box.innerHTML=vinhoId?`<p class="wc-note">${t}</p>`:`<div class="wc-card"><p class="wc-note">${t}</p></div>`;
      return;
    }
    if(vinhoId){box.innerHTML=wcHistFichaHTML(vinhoId,l);return;}
    const linhas=l.map(a=>wcHistLinhaHTML(a,true)).join('');
    box.innerHTML=`<div class="wc-card"><div class="hist">${linhas}</div></div>`;
  }catch(e){
    box.innerHTML=`<p class="wc-note erro">${esc(e.message)}</p>`;
  }
}

/* Na ficha, a lista corrida enchia o ecrã — uma corrida do script escreve
   dez, quinze campos de uma vez. Fica atrás de um botão, e lá dentro um
   bloco por DIA, também fechado: a lista dos dias é o resumo, e abre-se só
   o que interessa. O que está aberto vive em memória e só para o MESMO
   vinho — o "Repor" refresca a ficha, e fechar-se debaixo do dedo era
   pior do que não ter dobras; outro vinho abre sempre fechado. */
let _wcHistVinho=null,_wcHistAberto=false,_wcHistDias=null;

function wcHistDia(s){
  const d=new Date(s);
  if(isNaN(d))return 'sem-data';
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function wcHistHora(s){
  const d=new Date(s);
  return isNaN(d)?'—':d.toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'});
}
function wcHistBtnHTML(n,nDias){
  const tit=(n===1?'1 alteração':`${nFmt(n)} alterações`)+(nDias>1?` em ${nDias} dias`:'');
  return `<span>${_wcHistAberto?'Esconder o histórico':'Ver o histórico · '+tit}</span><span>${_wcHistAberto?'▲':'▼'}</span>`;
}

function wcHistFichaHTML(vinhoId,l){
  if(_wcHistVinho!==vinhoId){_wcHistVinho=vinhoId;_wcHistAberto=false;_wcHistDias=null;}
  const dias=[],por={};   // pela ordem da `historico`: o mais recente primeiro
  l.forEach(a=>{
    const k=wcHistDia(a.quando);
    if(!por[k]){por[k]=[];dias.push(k);}
    por[k].push(a);
  });
  // Um dia só não precisa de dois toques para se ler.
  if(!_wcHistDias)_wcHistDias=new Set(dias.length===1?dias:[]);
  const blocos=dias.map(k=>{
    const as=por[k];
    const aberto=_wcHistDias.has(k);
    const campos=[...new Set(as.map(a=>WC_CAMPO_NOME[a.campo]||a.campo))].join(', ');
    return `<div class="hist-dia">
      <button class="hist-dia-btn" onclick="wcHistAlternarDia('${k}')">
        <span class="hist-dia-t"><strong>${esc(k==='sem-data'?'Sem data':dataFmt(as[0].quando))}</strong>
          <span class="hist-dia-n">· ${as.length===1?'1 alteração':`${nFmt(as.length)} alterações`}</span>
          <span class="hist-dia-c">${esc(campos)}</span></span>
        <span class="hist-dia-seta" id="hist-ds-${k}">${aberto?'▲':'▼'}</span>
      </button>
      <div class="hist hist-dia-det" id="hist-dd-${k}" style="display:${aberto?'':'none'}">${as.map(a=>wcHistLinhaHTML(a,false,true)).join('')}</div>
    </div>`;
  }).join('');
  return `<button class="pv-btn" id="hist-btn" data-n="${l.length}" data-dias="${dias.length}" onclick="wcHistAlternar()">${wcHistBtnHTML(l.length,dias.length)}</button>
  <div class="hist-dias" id="hist-det" style="display:${_wcHistAberto?'':'none'}">${blocos}</div>`;
}

function wcHistAlternar(){
  const d=document.getElementById('hist-det'),b=document.getElementById('hist-btn');
  if(!d||!b)return;
  _wcHistAberto=!_wcHistAberto;
  d.style.display=_wcHistAberto?'':'none';
  b.innerHTML=wcHistBtnHTML(Number(b.dataset.n),Number(b.dataset.dias));
}
function wcHistAlternarDia(k){
  const d=document.getElementById('hist-dd-'+k),s=document.getElementById('hist-ds-'+k);
  if(!d||!_wcHistDias)return;
  const abrir=d.style.display==='none';
  if(abrir)_wcHistDias.add(k);else _wcHistDias.delete(k);
  d.style.display=abrir?'':'none';
  if(s)s.textContent=abrir?'▲':'▼';
}

function wcHistValor(k,v){
  if(v==null)return '<em>vazio</em>';
  return wcValorHTML(k,v);
}

function wcHistLinhaHTML(a,comVinho,soHora){
  const campo=WC_CAMPO_NOME[a.campo]||a.campo;
  const identidade=['nome','produtor','ano','_criado'].includes(a.campo);
  /* "Repor" só faz sentido se o valor de agora ainda é o que esta
     alteração lá pôs — senão já foi mudado outra vez, e repor apagava essa
     mudança mais recente sem se dar por isso. */
  const aindaEste=JSON.stringify(a.agora??null)===JSON.stringify(a.depois??null);
  return `<div class="hist-l">
    <div class="hist-cab">
      ${comVinho?`<a href="#" onclick="wcVerFicha(${Number(a.vinhoId)});return false"><strong>${esc(a.nome||'(vinho)')}</strong>${a.ano?' '+esc(String(a.ano)):''}</a> · `:''}
      <strong>${esc(campo)}</strong>
      <span class="wc-note">${esc(soHora?wcHistHora(a.quando):dataFmt(a.quando))} · ${esc(a.quem||'?')}</span>
      ${a.origem?`<span class="og-tag ${wcOrigemCls(a.origem)}">${esc(wcOrigemTxt(a.origem))}</span>`:''}
    </div>
    ${a.campo==='_criado'?`<div class="hist-v">vinho criado no catálogo</div>`:
    `<div class="hist-v"><span class="hist-antes">${wcHistValor(a.campo,a.antes)}</span>
      <span class="hist-seta">→</span><span class="hist-depois">${wcHistValor(a.campo,a.depois)}</span></div>`}
    ${!identidade&&aindaEste?`<button class="btn-n hist-repor" onclick="wcReporAlteracao(${Number(a.id)})">Repor o valor de antes</button>`:''}
  </div>`;
}

async function wcReporAlteracao(id){
  const a=_wcHist.find(x=>x.id===id);
  const campo=a?(WC_CAMPO_NOME[a.campo]||a.campo):'o campo';
  if(!confirm(`Repor ${campo} ao valor de antes?`+(a&&a.antes==null?' (o campo fica vazio)':'')))return;
  try{
    await catRpc('repor_alteracao',{p_id:id});
    toast('Reposto ✓');
    if(_wcFicha&&document.getElementById('fi-hist'))await wcRefrescarFicha();
    if(document.getElementById('t-alertas')?.classList.contains('on'))wcHistorico(null,'hist-lista');
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
  /* O cartão dos links do Vivino só se preenche sabendo que é o admin — e
     isso só se sabe aqui, depois de o separador já poder estar aberto. */
  if(_souAdmin&&document.getElementById('t-cfg')?.classList.contains('on'))wcVivinoConfig();
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
/* A pesquisa vive numa janela POR CIMA da ficha: o Escape fecha essa
   primeiro — fechar a ficha por baixo parava a espera pelo resultado. */
document.addEventListener('keydown',(e)=>{
  if(e.key!=='Escape')return;
  const pr=document.getElementById('modal-procurar');
  if(pr&&pr.classList.contains('on')){fecharModal('modal-procurar');return;}
  wcFecharFicha();
});
