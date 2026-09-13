# WineCatalog — guia para o assistente

App pessoal: a casa do **catálogo de vinhos** (schema `winecatalog`), que
já servia a **Garrafeira** e a **WineSelection** sem nunca ter tido um
ecrã — nem dono. Mostra o que lá está e de onde veio cada campo,
diz quanto é que a partilha está a poupar, e é onde se resolvem os
duplicados à mão. **Sem build, sem npm.** Site estático (GitHub Pages),
PWA. Dados e login em **Supabase** — o mesmo projeto das outras apps
(`gjweqwfbnkgnibhajldc`).

Este ficheiro nasceu do documento de arranque (setembro de 2026). Quase
tudo o que aqui está foi pago com um erro.

## Estrutura
- `index.html` — só markup: os cinco separadores (o quinto, Alertas, só
  aparece ao admin) + os três ecrãs de autenticação (`page-login`,
  `page-nova-pass`, `page-sem-acesso`) + o splash + os cinco modais: a
  ficha, **Editar**, **Vinho novo**, **Procurar informação** e Alertas
  vivem em `t-alertas`.
- `app.js` — toda a lógica. Secções (`grep` pelo título): Sessão Supabase
  (`sbHeaders`/`sbFetch`/`sbReq`) · **RPC ao catálogo** (`catRpc`)
  · Escapes · Modais (`abrirModal`/`fecharModal`) · Tabs · **De onde veio
  cada campo** · **Resumo** · **Catálogo** · **A ficha de um vinho**
  (a capa + **Editar** + **Vinho novo** + **Procurar informação**, ver
  abaixo) · **Alertas** · **Duplicados** · Utilizadores (admin) ·
  **Auth (Supabase)** · Init.
- `style.css` — todo o CSS (paleta bordô/dourado das apps irmãs).
- `sw.js` — service worker (cache PWA).
- `catalogo-info.ts` — Edge Function (Deno). Pesquisa Google a sério para
  UMA linha do catálogo, a pedido do admin (ver "Editar, Procurar,
  Comparar, Reportar" abaixo). Deploy à parte:
  `supabase functions deploy catalogo-info`.
- `catalogo-foto.ts` — Edge Function (Deno). Lê o RÓTULO de uma fotografia
  para pré-preencher o formulário "Vinho novo" — visão, nunca pesquisa web
  (ver "Vinho novo" abaixo). Deploy à parte:
  `supabase functions deploy catalogo-foto`.
- `db/` — `schema.sql` → `catalogo.sql` → **`curadoria.sql`** →
  `functions.sql` → `policies.sql` → `admin_pass_temp.sql` (+ `README.md`
  com os passos manuais e `migracao-catalogo-para-winecatalog.sql`, a
  mudança de casa). O `curadoria.sql` corre DEPOIS do `catalogo.sql` — usa
  a `forca`, a `juntar` e a `achar` que já lá estão.
- `apple-touch-icon.png` / `icon-512.png` — gerados por um script Node
  descartável (encoder PNG à mão, sem dependências); não há fonte vetorial
  guardada no repo. Para os refazer, escreve outro script assim.

## Porque é que esta app existe
As duas apps de vinhos pagavam ao Gemini para perguntar o mesmo sobre os
mesmos vinhos. Criou-se um catálogo comum: o que uma descobre, a outra
aproveita. Funcionava — mas **não tinha casa**:

1. **Ninguém via o que lá estava.** RLS ligada e zero policies; só as Edge
   Functions (service_role) lhe chegavam.
2. **Os duplicados não se resolvem sozinhos** — e não podem, ver abaixo.
3. **Não se sabia quanto estava a poupar.** As funções já registavam
   `custo_estimado_eur` no `sync_log` (e `0` quando o catálogo respondeu),
   mas ninguém somava isso em lado nenhum.

E um problema de governo que uma app nova resolve de graça: **o catálogo
não é de nenhuma das duas apps**. Pôr o painel dentro da Garrafeira era dar
a quem herdasse a Garrafeira poder sobre uma tabela que também serve a
WineSelection.

## A REGRA QUE SEGURA TUDO O RESTO: uma cópia só não pode divergir
**`db/catalogo.sql` é a FONTE DE VERDADE do catálogo.** Não há cópia em
lado nenhum: a tabela `vinhos`, a chave (`tokens`/`chave_base`/`chave`/
`base_nome`/`chave_nome`/`achar`), a `forca()`, a `volatil()` e as três
funções que as Edge Functions chamam (`juntar`/`procurar`/`procurar_lote`)
estão todas ali.

Porquê tão insistente: a chave esteve repetida em TypeScript nas três Edge
Functions com um aviso a dizer para as manter iguais — e um aviso desses é
uma dívida à espera. No dia em que uma divergisse, o catálogo partia-se em
dois em silêncio (as mesmas garrafas em linhas diferentes) e a única coisa
que se notava era a conta da IA a não descer.

Até setembro de 2026 este ficheiro vivia noutro schema (`catalogo`) e
noutro repo (Garrafeira), e a WineCatalog só lhe podia acrescentar. Isso
resolvia o governo mas deixava o catálogo órfão: sem ecrã, sem dono, e com
a fonte de verdade dentro do repo de uma das apps que o consomem — que é
precisamente o que se queria evitar. Ver
`db/migracao-catalogo-para-winecatalog.sql`.

**Mexer na chave ou na força é mexer aqui, e mexe com as três apps.** Não
há nada a proteger-te disso a não ser teres lido isto.

## As invariantes — não se rediscutem
Cada uma custou um erro.

1. **O catálogo é sobre o VINHO, nunca sobre quem o tem.** Entra: castas,
   região, tipo, teor, estágio, nota do Vivino, preço de mercado, janela de
   consumo, notas de prova, harmonização. Nunca entra: as `notas` pessoais,
   o `imagem_path` (a fotografia tirada em casa, que apanha a prateleira à
   volta), o `preco_compra`, o lugar na prateleira, o `criado_por`. Ao
   acrescentar uma coluna, a pergunta é sempre: **isto é sobre o vinho ou
   sobre quem o tem?**
2. **Isto não abre garrafeira nenhuma.** Ninguém passa a ver uma linha de
   `vinhos`, `garrafas` ou `locais` de outra pessoa.
3. **A `pontuacaoAprox` da WineSelection NUNCA entra.** É uma estimativa de
   memória do modelo, sem pesquisa. A `forca()` devolve 0 para ela.
4. **O "barato/justo/caro" também não entra**, por outra razão: não é do
   vinho, é de uma CARTA. O mesmo Papa Figos é barato a 22 € e caro a 45 €,
   e nem o vinho mudou. O que atravessa é o `preco_medio`.
5. **A força é da ORIGEM e do CAMPO** (3 garrafeira-no-rótulo e
   ws-verificacao · 2 pesquisas e garrafeira-nos-voláteis · 1
   garrafeira-bruto · 0 o resto). A segunda metade é o que impede o
   catálogo de tomar por facto tudo o que alguém escreveu à mão: durante
   semanas os 3106 campos estavam TODOS a 3, nenhum tinha entrado por uma
   pesquisa, e nenhum podia, porque 3 tapa 2.
6. **A colheita separa um facto de uma invenção.** Campos voláteis nunca
   atravessam colheitas; os estáveis atravessam.
7. **Nada disto pode deitar uma procura abaixo.** É uma poupança, não uma
   dependência.
8. **A chave vive só no SQL** (ver acima).
9. **Uma nota pesquisada e um palpite não podem parecer a mesma coisa** na
   UI. Aqui é a `.forca` (dourado 3 · bordô 2 · cinzento 1) e a `og-tag`
   com o nome da origem por extenso, em cada campo da ficha.
10. **Um log limpo numa app que não corre não é saúde, é desuso.** A
    WineSelection ficou semanas com duas avarias que a Garrafeira já tinha
    corrigido, e ninguém deu por nada porque ela não corria. **Esta app vai
    correr ainda menos vezes** — daí o cartão "Sinal de vida" no Resumo, que
    mostra a última chamada de cada app e a pinta a vermelho passados 30
    dias. É a única coisa que esta app faz "sozinha", e é de propósito.

## O que a app faz — os ecrãs
Nenhum deles é "a lista toda do catálogo" como ecrã inicial.

### Resumo (inicial) — *quanto é que isto está a poupar*
Lê `winecatalog.consumo_resumo()` e `winecatalog.resumo()`.
- pedidos servidos pelo catálogo vs. total, por app e no total;
- gasto estimado, poupança estimada, tokens;
- tamanho do catálogo e **quantos campos vieram de cada origem** (é onde se
  vê se as pesquisas a sério já estão a entrar);
- "Sinal de vida" (ver invariante 10).

**As unidades não se somam.** A `vinho-info` conta CAMPOS, a
`sugerir-vinho` conta NOTAS, a `verificar-vinhos` conta VINHOS — cada linha
diz em que unidade está. O que atravessa as três e se pode somar é o
PEDIDO. Somá-las seria inventar um número.

**Os tokens são facto; o euro é uma estimativa grosseira.** Sai de
constantes escritas à mão nas Edge Functions, não é um preço publicado, e a
pesquisa Google é faturada à parte por pedido. A poupança é uma estimativa
em cima dessa (os pedidos servidos pelo catálogo × o custo médio de um que
foi mesmo à IA). **Isto tem de continuar escrito no ecrã** (`.aviso-euro`)
— é a diferença entre um número em que se pode confiar e um inventado.

### Catálogo — *ver e procurar o que já se sabe*
Lista com procura por nome/produtor/região/casta (a procura passa pela
mesma `winecatalog.tokens` da chave, e é isso que faz "qta do crasto"
encontrar "Quinta do Crasto"). Cada vinho abre numa ficha que mostra,
**campo a campo, de onde veio** (origem, força, data) e as fontes.

**Os filtros (tipo, região, castas, faixa de preço) são do SQL, nunca do
browser** — a lista é paginada (50 de cada vez), e filtrar do lado de cá
filtrava só a página que por acaso já tinha vindo: "3 tintos do Douro"
quando havia trinta. As CONTAGENS de cada opção (`facetas`) voltam no
MESMO pedido da lista, contadas com os outros grupos aplicados mas não o
próprio — é o que faz "Branco 7" continuar visível depois de se escolher
Tinto. As faixas de preço vivem na `winecatalog.faixa_preco`, e não
também no `app.js`, pela razão do costume: duas listas destas divergem no
dia em que alguém mexe numa só.

**As castas — e só elas — têm um visto de "todas em simultâneo"**
(`p_castas_todas`). Escolher Touriga Nacional e Syrah tem duas leituras
legítimas: qualquer uma (o costume) ou os lotes que levam as duas. Um
vinho tem UM tipo e UMA região, e "tinto E branco" não existe — daí o
visto não aparecer nos outros grupos. Em modo "todas", a contagem de cada
casta deixa de ignorar o grupo inteiro e passa a ignorar só a PRÓPRIA
opção (conta com as outras castas escolhidas por cima): de outro modo o
cartão dizia "Syrah 28" com a lista a mostrar três vinhos. A escolhida
continua visível — é o que permite desmarcá-la — e uma que dê zero
desaparece, que é a resposta certa para um caminho sem saída.

**Os cartões de filtro são uma GRELHA de duas colunas, não um
`flex-wrap`.** Com três por linha, "Península de Setúbal" e "Cabernet
Sauvignon" chegavam ao ecrã cortadas a meio, e um filtro que não se lê não
se escolhe. O `flex:1 1 108px` de antes trazia outro defeito: numa linha
ímpar o `flex-grow` esticava o cartão sozinho de ponta a ponta. Numa
grelha, o que sobra fica na primeira coluna e alinha com o de cima. E as
colunas são `minmax(0,1fr)` com `min-width:0` no cartão — o mínimo de um
item de grelha é `auto`, e sem isto o `text-overflow:ellipsis` nunca
dispara: é a coluna que cresce.

É o primeiro ecrã que alguma vez mostrou uma linha do catálogo.

**"+ Vinho novo"**, só para o admin (ver "Vinho novo" abaixo), é a outra
metade do §4.4 do documento de arranque: até aqui só se podia enriquecer
um vinho que **já existia** — nascer um do zero não tinha ecrã nenhum.

### Vinho novo — *um vinho que ninguém tem, do zero*
O botão **"+ Vinho novo"** no Catálogo (só admin) cria uma linha vazia
(`winecatalog.criar`) e abre logo a ficha para "Procurar informação"
tratar do resto — exatamente o plano que ficou por fazer em "O que falta"
até esta ronda. Só o **nome** é obrigatório; o formulário é o MESMO da
Editar (`wcCamposEditHTML`, partilhado entre os dois modais por um
`prefixo` de ids, `ed-`/`nv-`), a começar vazio em vez de a partir do que
já lá está — o admin pode escrever à mão o que já souber (região, castas,
teor…) em vez de deixar tudo para uma pesquisa.

A `criar` faz a MESMA pergunta que o `juntar` faz antes de escrever
(`achar`, às duas chaves): se este vinho e esta colheita já tiverem linha,
recusa e diz qual é — nunca nasce uma segunda linha do mesmo vinho só
porque alguém carregou em "+ Vinho novo" em vez de procurar primeiro. Os
campos entram com a mesma força de um `editar` (`catalogo-admin`: 4 no
rótulo, 3 na nota/preço/imagem).

**A segunda porta para o mesmo formulário: ler o rótulo de uma
fotografia.** Um botão dentro do próprio modal encolhe a foto no browser
(`wcEncolherImagem`, o mesmo truque `imageOrientation:'from-image'`/1000px
da Garrafeira) e manda-a para a Edge Function `catalogo-foto.ts`, que a lê
com o Gemini e devolve nome/produtor/ano + os campos de RÓTULO (cor,
castas, região, teor, menção, classificação) — **nunca escreve na base de
dados**: só pré-preenche o formulário, para o admin rever e corrigir antes
de "Criar vinho". Por ser leitura de RÓTULO e não pesquisa, a
`catalogo-foto` nunca vê nota do Vivino, preço de mercado, notas de prova
nem harmonização — isso é sempre trabalho de "Procurar informação",
depois de o vinho já existir.

**Porque é uma Edge Function à parte, e não a `catalogo-info` a aceitar
uma imagem.** São perguntas diferentes: a `catalogo-info` PESQUISA a
internet (grounding search) sobre uma referência que já existe; a
`catalogo-foto` faz VISÃO sobre uma fotografia — sem `google_search`, o
que aliás é o que deixa pedir `responseMimeType:"application/json"` direto
ao Gemini, sem a extração de texto que a pesquisa com grounding obriga.
Ver a confissão sobre a escolha de modelo, abaixo.

**A terceira porta, ao lado da fotografia: "🔎 Procurar informação"
direto do formulário** (`wcNovoProcurar`). Não é pesquisa nova nenhuma —
é a MESMA porta que já existe na ficha de um vinho (`wcAbrirProcurar`,
que por sua vez bifurca em automática e manual), só que chamada um
instante mais cedo: a linha ainda não existe, por isso `wcNovoProcurar`
primeiro chama `winecatalog.criar` (com o que já estiver no formulário —
um rótulo lido a seguir a completar, por exemplo) e só depois abre a
ficha nova já com o ecrã de pesquisa por cima. Zero código de pesquisa
novo — o botão só decide QUANDO criar a linha, nunca COMO se pesquisa.

### A ficha de um vinho — *igual à da Garrafeira, com Editar e Procurar*
O ecrã de detalhe passou a ser **o mesmo desenho da Garrafeira** — a capa
bordô com a garrafa, os crachás, os botões, as secções com filete — e não
por gosto: quem anda nas duas apps não tem de aprender dois ecrãs para ver
um vinho, e a diferença que interessa (de onde veio cada campo) está no
CONTEÚDO, não na moldura. O que **não** veio de lá: o cabeçalho que encolhe
ao rolar (`modal.pagina`) — lá resolve um problema (a ficha é uma página
cheia de garrafas e prateleiras) que aqui não existe.

Dois botões, **só para o admin do catálogo** — não é avareza, é a mesma
regra do resto: quem lê o catálogo é toda a gente aprovada, quem o manda
mexer e gastar é quem é dono dele.

**Editar** (`winecatalog.editar`) corrige um campo à mão. A força que isto
usa é **4 no que está no rótulo** (castas, cor, teor, região — ninguém lhe
passa por cima) e **3 na nota, no preço e na imagem** (esses ninguém os
sabe por ser admin; uma pesquisa a sério fresca ainda os pode actualizar).
Ver `winecatalog.forca` em `catalogo.sql`, onde isto está com o comentário
todo. **Esvaziar um campo apaga-o, e apagar NÃO fixa nada** — fica livre
para a próxima escrita de qualquer garrafeira o voltar a preencher, com o
mesmo valor errado se for isso que ela tem escrito. Para travar um valor
errado, corrige-se. A identidade (nome/produtor/ano) também se pode mexer,
atrás de um interruptor fechado por omissão: muda a CHAVE, e se a chave
nova já for de outra linha a função recusa e manda para Duplicados —
juntar é a `fundir`, que é reversível; um UPDATE à socapa não seria.

**Procurar informação** (`winecatalog.pesquisa_criar` + a Edge Function
`catalogo-info.ts`) manda uma pesquisa Google a sério para a linha aberta,
com o mesmo desenho assíncrono da `sugerir-vinho`/`verificar-vinhos`
(`EdgeRuntime.waitUntil` + polling do browser, porque a pesquisa pode
passar de um minuto). Escolhem-se os campos — pedir os vinte de uma vez
põe o modelo a andar atrás de tudo e a voltar com meia dúzia de coisas
mornas — e o resultado diz sempre **o que NÃO entrou e porquê**: se o
catálogo já tinha uma fonte mais forte, isso é o sistema a funcionar, mas
só se souber que aconteceu.

**O Produtor é sempre uma das opções a pedir, mesmo já preenchido** — só uma
leitura errada o faz vir diferente, e é exatamente isso que vale a pena
confirmar (foi o que faltava quando "+ Vinho novo" começou a criar linhas
com nome mas sem produtor: a pesquisa nunca era chamada a preenchê-lo).
Mas o Produtor não é campo de FICHA — é IDENTIDADE, faz parte da `chave` —
e por isso não passa pela `juntar` como os outros: uma pesquisa não pode
mudar de que vinho se trata só por ter sido pedida. O que volta é uma
SUGESTÃO à parte no relatório (`identidade:true` na proposta, nunca
`entrou`), a aplicar à mão em **Editar**, com o interruptor de identidade
que já verifica duplicados. Vale para as duas pesquisas — automática e
manual, que passam pelo mesmo `processarPesquisa`.

**Sobre a escolha de modelo, uma confissão.** A secção "O que falta"
abaixo dizia que a WineCatalog não devia ganhar uma TERCEIRA cópia da
descoberta de modelo do Gemini. A `catalogo-info.ts` é uma quarta (as
outras: `sugerir-vinho`, `verificar-vinhos`, `vinho-info`,
`importar-vinhos`) — nenhuma das duas saídas que a secção propunha
(reutilizar a `vinho-info` tornando `vinhoId` opcional, ou uma função nova
que IMPORTA a escolha de um sítio só) chegou a acontecer. Ficou
auto-contida, como as outras quatro, porque era isso que um pedido do
utilizador — "quero o botão de pesquisar aqui, igual ao da Garrafeira" —
pedia sem rodeios, e puxar isto para dentro de uma Edge Function de outro
repo (com a autorização e a linha de trabalho de OUTRA app) trocava uma
duplicação conhecida por um acoplamento entre repos pior. E a
`catalogo-foto.ts` (ver "Vinho novo" acima) é a QUINTA: a mesma decisão,
pela mesma razão, desta vez porque um "+ Vinho novo" com leitura de
rótulo não existe em nenhuma das outras apps para se reutilizar — a mais
parecida é a `importar-vinhos` da Garrafeira, que lê fotos de garrafeira,
não de catálogo, e vive noutro repo com outra autorização. **A regra que
fica**: se mexeres na escolha de modelo, nos parâmetros da chamada ou no
tratamento de erros do Gemini AQUI, vai ver as outras cinco no mesmo dia
— exatamente a disciplina que a WineSelection já pratica (ver o
`CLAUDE.md` dela, "As lições da Garrafeira têm de atravessar para cá").

### Comparar, Aplicar, Reportar — *o catálogo a ouvir a Garrafeira de volta*
Até esta ronda a relação com a Garrafeira era de sentido único: ela
escrevia no catálogo e nunca ouvia nada. Isso deixava a avaria mais chata
de todas sem sítio nenhum onde aparecer — o mesmo vinho com números
diferentes nos dois lados, e ninguém a saber qual está certo. Três funções
resolvem isto, e vivem em `curadoria.sql`:

- **`winecatalog.comparar`** — dado nome/produtor/ano e a ficha de quem
  pergunta, devolve só os campos que DIFEREM ou que só o catálogo tem.
  **É a única função deste schema aberta a QUALQUER pessoa com login** —
  quem chama é a Garrafeira em nome de alguém que normalmente não está em
  `winecatalog.allowed_users` (é dona da sua garrafeira, não tem nada que
  ver com esta app), e exigir-lhe uma conta aqui matava a funcionalidade à
  nascença. O que se abre é só a FICHA de UM vinho de cada vez — não
  enumera nada, não há como varrer o catálogo com isto.
- **`winecatalog.igual`** decide se dois valores são "diferentes" a
  sério: "Tinto" e "tinto" não são, 13.5 e 13.50 não são, as mesmas castas
  por outra ordem não são. Sem isto a marca do lado da Garrafeira aparecia
  em metade dos campos de toda a gente no primeiro dia — o mesmo erro que
  a lista de Duplicados já cometeu uma vez antes de ganhar o `generico()`.
- **`winecatalog.reportar`** — "isto está errado no catálogo". Guarda os
  DOIS valores no momento do alerta (não só um apontador para o campo: o
  catálogo muda, e "o preço está mal" é inútil daqui a três semanas), com
  índice único por pessoa+vinho+campo enquanto `aberto` — carregar duas
  vezes não enche o ecrã do admin com a mesma queixa. `listar_reportes`/
  `contar_reportes`/`resolver_reporte` são o lado do admin, no separador
  **Alertas** (só visível a ele).

Do lado da Garrafeira: `garrafeira.ficha_catalogo` (a MESMA tradução
colunas→ficha que já alimentava `catalogar_vinho`, extraída para não
haver duas cópias — ver `db/catalogo-partilhado.sql`), e as três que a
app chama, `comparar_catalogo`/`aplicar_do_catalogo`/`reportar_ao_catalogo`.
Nenhuma pode deitar a ficha de um vinho abaixo se o catálogo não
responder: o catálogo é uma poupança e um espelho, nunca uma dependência.

### Duplicados — *a fusão manual*
Três coisas que não são negociáveis:
- **nunca automática.** Uma varredura por semelhança (mesmo ano, ≥2 tokens
  comuns, ≥60% de sobreposição) devolveu 29 pares em 162 linhas. Lá dentro
  havia duplicados a sério (*dona-ermelinda-freitas* / *ermelinda-freitas*)
  **e** falsos positivos perigosos: *nacional-touriga-vallado* com
  *esporao-nacional-touriga* — produtores diferentes a partilhar o nome de
  uma casta. **A semelhança serve para SUGERIR, nunca para DECIDIR**, e os
  números de cada par vão para o ecrã com ele.
- **uma palavra em comum tem de IDENTIFICAR um vinho** (`winecatalog.generico`,
  e é a trave que tornou a lista legível: 28 pares → 7 na base real). Os
  cortes acima medem quão parecidas são duas CHAVES, e isso sozinho propunha
  três ruídos diferentes:
  · *HERDADE DO SOBROSO Grande Reserva* × *Bafarela Grande Reserva* — só a
    GAMA em comum;
  · *Esporão Touriga Nacional* × *Quinta do Noval Touriga Nacional* — só a
    CASTA (metade do Douro engarrafa a mesma);
  · *Leo d'Honor* × *Ermelinda Freitas Syrah* — só o PRODUTOR, e este é
    estrutural: a chave junta nome E produtor de propósito (ver `achar`), por
    isso dois vinhos diferentes da mesma casa parecem-se sempre por tokens.
  Uma regra só mata os três: a palavra partilhada tem de vir do **nome**
  (não da chave — é aí que o produtor entra pela porta do lado) e não pode
  ser nem qualificador nem casta. O ecrã diz sempre QUAL foi (`fortes`), que
  é o que torna a decisão de um segundo em vez de um estudo.
  **Esta lista não é a do `base_nome` e não tem de ser:** aquela decide
  IDENTIDADE — mexer nela mexe na chave e, por aí, nas três apps. Esta só
  decide se vale a pena PROPOR um par a uma pessoa, e por isso pode ser
  muito mais larga: aqui um falso negativo custa um duplicado que espera mais
  um mês, e um falso positivo custa a confiança na lista toda.
- **o "não são" fica GRAVADO** (`winecatalog.distintos`). Senão a lista volta
  a propor o mesmo par todas as semanas, e uma lista que insiste em erros
  deixa de se ler — é o caminho para alguém carregar em "são o mesmo" sem
  olhar e juntar um Vallado a um Esporão. Desmarcar também existe.
- **fundir é reversível.**
- **nunca se fundem colheitas diferentes.** `winecatalog.fundir` recusa-o com
  erro, e a `candidatos` nem sequer propõe esses pares.

**Como a reversibilidade é feita.** Exatamente como o documento de arranque
pedia: um alias que a `winecatalog.achar()` resolve.

1. os campos da linha perdedora passam para a alvo **um a um**, respeitando
   a `forca` que cada um já tinha dos dois lados — uma fusão nunca pode ser
   a porta dos fundos por onde uma leitura fraca tapa uma pesquisa paga;
2. grava-se uma linha em `winecatalog.alias`, e é **só isso**. À perdedora
   não se lhe toca: mesmas chaves, mesma ficha. O que muda é a `achar`, que
   passa a responder com a alvo quando esbarra nela;
3. o estado ANTERIOR de cada campo mexido fica em
   `winecatalog.alias.campos_movidos`.

`winecatalog.separar` apaga a linha do alias (a perdedora volta a responder
por si no mesmo instante) e devolve cada campo ao que era — **mas só os que
ninguém reescreveu entretanto**: compara a entrada de `origens` com a que a
fusão lá pôs. Desfazer uma fusão de setembro não pode deitar fora uma
verificação de outubro; a app diz quantos ficaram.

**A primeira versão não fazia assim, e o porquê vale a pena guardar.**
Quando a `achar` vivia noutro repo, a fusão resolvia-se a ESTACIONAR as
chaves da perdedora (um prefixo `alias:`). Tirava-a do caminho, sim — mas
tirava-a demais: a grafia antiga deixava de casar com fosse o que fosse, e
a próxima carta que voltasse a escrevê-la não achava a perdedora (com a
chave mexida) nem a alvo (que tem outra), e nascia uma **terceira** linha.
O duplicado voltava, e voltava por causa da própria ferramenta que servia
para o resolver. É o género de avaria que não dá erro nenhum — só a conta a
não descer.

## Login e permissões
- `SB_URL`/`SB_KEY` são os do projeto partilhado. **`Accept-Profile`/
  `Content-Profile` em todos os pedidos** — é isso que aponta para o schema,
  nunca vai no URL. É um schema só (`winecatalog`), mas com duas metades:
  as tabelas de quem entra, por REST normal com RLS e policies; e o
  CATÁLOGO, **só por RPC** e só pelas funções SECURITY DEFINER — esse tem
  RLS com zero policies **e** nenhum GRANT a quem tem login, e é assim que
  fica.
- Fluxo de acesso igual às outras: login → `sbAposLogin` confirma
  `allowed_users` → se não estiver lá, ecrã "sem acesso" com "Solicitar
  acesso" → o admin aprova em Definições.
- **Duas figuras diferentes, e não se confundem:**
  - **admin do catálogo** (`winecatalog.config.admin_email`, na BD e não em
    código) — aprova quem entra e decide fusões. **Passa**, com
    `winecatalog.definir_admin()`;
  - **dono da conta Supabase** (`SUPABASE_DONO_EMAIL`, fixo no `app.js`) —
    atrás dele fica só o que mexe na CONTA e não na app: a password
    temporária (`admin_pass_temp`, que escreve em `auth.users`). **Não
    passa**, porque a conta continua a ser de quem a paga.
- `isAdmin()` **não compara emails em código**: pergunta ao servidor
  (`winecatalog.sou_admin()`). A UI só decide que botões mostrar; todas as
  funções de escrita voltam a confirmar — um botão escondido não é
  segurança.
- O admin entra sempre, mesmo sem linha em `allowed_users` (igual à
  `is_allowed()` do SQL): sem isso, apagar a própria linha trancava a app e
  não havia ninguém com direito a destrancá-la.

## O caminho de leitura, e porque não são policies
`winecatalog.vinhos` continua com RLS e **zero policies**. Quem lê são funções
`SECURITY DEFINER` novas (`listar`/`ver`/`candidatos`/`resumo`/
`consumo_resumo`/`listar_distintos`) com `REVOKE` de `PUBLIC`/`anon` e
`GRANT` só a `authenticated` — e é **dentro** de cada uma que se confirma
quem é (`pode_ler()` para ler, `sou_admin()` para decidir).

Uma policy de SELECT era mais simples, mas abria a tabela a qualquer pessoa
com login em **qualquer** app do projeto que aponte para o schema
`winecatalog` — e o schema está **exposto** na API. A lista de vinhos que
passaram por aqui diz alguma coisa sobre o que as pessoas têm em casa,
mesmo que cada linha à parte não diga.

E é por isso que os GRANTs deste schema são **tabela a tabela**. As apps
irmãs fazem `GRANT ALL ON ALL TABLES IN SCHEMA <x> TO anon, authenticated`,
e este repo chegou a copiá-lo — mas com o catálogo a viver no mesmo schema
da app, um grant desses apanhava a `vinhos` de caminho e deixava-a só com a
RLS. Continuava fechada, mas por **uma** trave em vez de duas.

**Cada função nova nasce com `EXECUTE` para `PUBLIC`, e um `REVOKE`
esquecido não dá erro — dá uma porta aberta calada.** Confirma sempre, com
a consulta que está no fim do `db/catalogo.sql` e no `db/README.md`.

A vista `winecatalog.consumo` (que une as duas `sync_log`) não se dá a
ninguém: uma vista não é `security_invoker`, corre como o dono, e por isso
vê as duas tabelas inteiras, `quem` incluído. Quem lhe chega é só a
`consumo_resumo()`, que agrega e nunca devolve o `quem`.

## Regras técnicas (não partir a app)
- `app.js` carrega como `<script src>` **normal, NÃO module** — há
  `onclick="…"` no HTML, as funções têm de ser **globais**.
- **PWA/cache:** se mexeres em `app.js`, `style.css` ou `index.html`, **sobe
  `CACHE_NAME` no `sw.js`** (`wc-cache-v1` → `v2`). Os três são
  network-first — sem isto, num deploy o browser pode apanhar o
  `index.html` novo com o `app.js` VELHO da cache: botões novos a chamar
  funções que ainda não existiam, sem erro visível. Já aconteceu.
- **A chave `anon` no topo do `app.js` é pública por design**, protegida por
  RLS + login. **Não é bug nem risco — não a "corrijas" nem a escondas.**
- **Alterar o schema:** edita primeiro `db/*.sql` e só depois corre no SQL
  Editor do Supabase — nunca ao contrário.
- **A caixa de procura do Catálogo tem uma regra de especificidade a
  proteger.** O `.wc-card input[type=text]` genérico (0-2-1) ganha ao
  `.cf-procura input` (0-1-1) e repõe-lhe o `padding`, com a lupa a
  atropelar o texto — já chegou ao ecrã assim. A regra é
  `.wc-card .cf-procura input[type=text]`, igualmente específica e a vir
  depois. Não é `!important`: qualquer coisa dentro de um `.wc-card` que
  precise de padding próprio cai na mesma pedra.
- **Escapar HTML:** `esc()` para conteúdo, `escJs()` para o que vai dentro
  de `onclick="…('…')"` — há vinhos com plica no nome ("Clefs D'or").
- **`STABLE` numa função que escreve não é `STABLE`** — nem sequer num
  `CREATE TEMP TABLE`, e o Postgres só o diz quando a função CORRE. A
  `winecatalog.listar` usa uma CTE por causa disto.
- **`RETURNS TABLE` com nomes iguais aos das colunas** dá ambiguidade em
  plpgsql — daí tudo aqui devolver `jsonb`.
- **Uma linha de vinho que atravesse CTEs viaja numa COLUNA de tipo
  `winecatalog.vinhos`, nunca como `v.*`.** O `resumo_linha` recebe uma
  `vinhos`; no dia em que uma CTE pelo meio acrescentar uma coluna sua
  (os `ok_*` dos filtros da `listar`, por exemplo), o `p.*` dessa CTE
  passa a ser um `record` com colunas a mais e o Postgres recusa-o com
  **«cannot cast type record to vinhos»** — e só o diz quando a função
  CORRE, com o ecrã do Catálogo inteiro a morrer por causa disso. Já
  aconteceu, no dia em que a `listar` ganhou os filtros.
- Edições **cirúrgicas** (diffs pequenos).

## As lições das outras apps atravessam para cá
Aconteceu duas vezes seguidas: a Garrafeira apanhou os 404 dos nomes de
modelo fixos (1 de setembro) e os 400 do `thinkingBudget:0` com
`google_search` (10 de setembro), corrigiu-se, e a WineSelection ficou com
as duas avarias intactas durante semanas.

Esta app agora TAMBÉM chama o Gemini (`catalogo-info.ts` e
`catalogo-foto.ts`) — ver a confissão em "A ficha de um vinho" sobre a
descoberta de modelo duplicada de propósito cinco vezes no projeto. Mas o
Resumo continua a ser onde a calada se apanha: **compara a última chamada
de cada app antes de assumir que a que está calada está bem.**

## Coisas que já aconteceram e que é bom conhecer
- **O Grous Moon Harvested.** Três linhas para o que pareciam ser o mesmo
  vinho. Afinal: duas colheitas legítimas (2022 e 2023, que têm de ficar
  separadas) mais uma duplicação verdadeira — alguém escreveu "Moon
  Harve**st**" e outra pessoa "Moon Harve**sted**". Uma letra. A correção
  foi mudar o nome na garrafeira; o trigger recatalogou e o `juntar` fundiu
  sozinho na linha certa. **Não foi preciso ferramenta de fusão nenhuma** —
  o que faltava era um selector no momento de gravar.
- **O parêntesis do produtor.** "Herdade dos Grous (Monte do Trevo)" é uma
  NOTA de quem escreveu, não outro produtor. Corrigido em 10 de setembro;
  sozinho, baixou os pares suspeitos de 29 para 10. Tira-se só do PRODUTOR,
  nunca do NOME.
- **A colheita irmã a ser tapada.** O `procurar` achava a linha do ano
  pedido e ficava por aí — mesmo quando essa linha era um espelho quase
  vazio e a do ano ao lado tinha dezassete campos.
- **A ordem de expandir abreviaturas.** Primeiro mapeia-se ("qta."→"quinta"),
  depois filtram-se as palavras vazias. Ao contrário, a mesma garrafa ficava
  com duas chaves.

## O que falta, e porque não está feito

### A mudança da cor na chave (decidida, não feita)
Tirar a cor do NOME e passá-la a um lugar próprio da chave, vindo da coluna
`tipo`. Hoje "tinto"/"branco"/"rose" ficam dentro da chave, e por isso um
vinho gravado como nome "Papa Figos" + tipo Branco **não encontra** o "Papa
Figos Branco" lido numa carta. Medido: **162 chaves → 161**; o valor está
nas cartas de restaurante, não no ganho de hoje.

Três regras que a tornam segura: (1) na Garrafeira a cor passa a ser
obrigatória antes de qualquer pesquisa; (2) cor desconhecida casa com
qualquer uma, duas cores conhecidas e diferentes nunca casam — e isto é
**obrigatório**, não opcional: uma carta muitas vezes não traz cor nenhuma,
e sem o coringa a mudança partia as consultas das cartas; (3) com a cor
desconhecida e as duas versões no catálogo, **mostram-se as duas**.

**Porque não está feito:** aplicá-la é, em si, uma fusão em massa — mudar o
`chave_base` obriga a recalcular as 162 linhas e desta vez as colisões são
o objetivo, não um acidente. Faz-se com a lista de pares à frente e um
"sim" por par, ou seja **depois** do ecrã de Duplicados existir (existe
agora) **e depois** de a Garrafeira passar a obrigar a escolher a cor (não
passou — é trabalho no outro repo). E a mudança da chave em si é no ficheiro
da Garrafeira, que é a fonte de verdade.

### Um vinho que ninguém tem, do zero (§4.4 do doc de arranque) — FEITO
A `catalogo-info.ts` já resolvia a metade que mais se pedia: pesquisar a
sério UMA linha que **já existe** no catálogo (ver "A ficha de um vinho").
Faltava a outra metade do §4.4 — escrever nome + produtor + ano **do
zero**, sem nenhuma linha prévia — e é o que o botão **"+ Vinho novo"**
(ver a secção própria, acima) passou a fazer: `winecatalog.criar` nasce a
linha, e o admin abre logo "Procurar informação" para tratar do resto — ou
lê o rótulo de uma fotografia (`catalogo-foto.ts`) para não ter de escrever
tudo à mão.

**Duas diferenças do que este documento tinha planeado, e porquê:**
- não foi `winecatalog.editar`-como-`INSERT` — ganhou uma função própria
  (`criar`), porque um INSERT e uma correção são pedidos diferentes: a
  `criar` tem de recusar quando o vinho já existe (a mesma pergunta que o
  `juntar` já fazia), e forçar isso dentro da `editar` obrigava a um `p_id`
  opcional a mudar de sentido consoante viesse preenchido ou não — mais
  confuso do que duas funções pequenas;
- a **cor não é obrigatória** para criar a linha, ao contrário do que a
  primeira versão deste plano dizia ("nome/produtor/ano/`tipo`"). O
  formulário de "Vinho novo" acabou por ser o MESMO da "Editar" (só o nome
  obrigatório), para poder receber o que a leitura do rótulo trouxer sem um
  segundo formulário mais restrito ao lado. Se um dia a mudança da cor na
  chave (ver acima) avançar, é aqui que a cor passa a obrigatória — e é
  o mesmo aviso que já vale para a Garrafeira (`iaCorGuard`).

Sobre a "terceira cópia" que este documento pedia para evitar: não
aconteceu, e agora são CINCO. Ver a confissão em "A ficha de um vinho",
acima.

### O selector no momento de gravar (vive na Garrafeira)
"Já existe *X 2023* — é o mesmo?" É o que **previne** duplicados em vez de
os remediar, e o caso do Grous mostra que é a peça que faltava. Vale mais
do que o ecrã de Duplicados — mas é trabalho no outro repo.

## Deploy
GitHub Pages a partir de `main`. Um push para `main` publica.
Edge Functions: `supabase functions deploy catalogo-info` e
`supabase functions deploy catalogo-foto` (ou
`mcp__Supabase__deploy_edge_function`). **PWA/cache:** se mexeres em
`app.js`, `style.css` ou `index.html`, sobe `CACHE_NAME` no `sw.js` — os
três são network-first, mas sem isto um deploy pode deixar o browser com o
`index.html` novo e o `app.js` velho da cache.
