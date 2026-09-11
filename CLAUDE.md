# WineCatalog — guia para o assistente

App pessoal: a casa do **catálogo partilhado de vinhos** (schema
`catalogo`), que já servia a **Garrafeira** e a **WineSelection** sem
nunca ter tido um ecrã. Mostra o que lá está e de onde veio cada campo,
diz quanto é que a partilha está a poupar, e é onde se resolvem os
duplicados à mão. **Sem build, sem npm.** Site estático (GitHub Pages),
PWA. Dados e login em **Supabase** — o mesmo projeto das outras apps
(`gjweqwfbnkgnibhajldc`).

Este ficheiro nasceu do documento de arranque (setembro de 2026). Quase
tudo o que aqui está foi pago com um erro.

## Estrutura
- `index.html` — só markup: os quatro separadores + os três ecrãs de
  autenticação (`page-login`, `page-nova-pass`, `page-sem-acesso`) + o
  splash + o modal da ficha.
- `app.js` — toda a lógica. Secções (`grep` pelo título): Sessão Supabase
  (`sbHeaders`/`sbFetch`/`sbReq`) · **RPC ao schema `catalogo`** (`catRpc`)
  · Escapes · Tabs · **De onde veio cada campo** · **Resumo** · **Catálogo**
  · **Duplicados** · Utilizadores (admin) · **Auth (Supabase)** · Init.
- `style.css` — todo o CSS (paleta bordô/dourado das apps irmãs).
- `sw.js` — service worker (cache PWA).
- `db/` — `schema.sql` → **`catalogo-winecatalog.sql`** → `functions.sql` →
  `policies.sql` → `admin_pass_temp.sql` (+ `README.md` com os passos
  manuais). **A ordem não é a das outras apps** — ver o `db/README.md`.
- `apple-touch-icon.png` / `icon-512.png` — gerados por um script Node
  descartável (encoder PNG à mão, sem dependências); não há fonte vetorial
  guardada no repo. Para os refazer, escreve outro script assim.

## Porque é que esta app existe
As duas apps de vinhos pagavam ao Gemini para perguntar o mesmo sobre os
mesmos vinhos. O schema `catalogo` passou a ser a memória comum: o que uma
descobre, a outra aproveita. Funcionava — mas **não tinha casa**:

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
**A fonte de verdade do schema `catalogo` é `db/catalogo-partilhado.sql` no
repo Garrafeira.** A tabela, a chave (`tokens`/`chave_base`/`chave`/
`base_nome`/`chave_nome`/`achar`), a `forca()`, a `volatil()` e as três
funções das Edge Functions (`juntar`/`procurar`/`procurar_lote`) vivem
**lá e só lá**. O `db/catalogo-winecatalog.sql` deste repo **acrescenta** e
**não redefine nada** disso.

Porquê tão insistente: a chave esteve repetida em TypeScript nas três Edge
Functions com um aviso a dizer para as manter iguais — e um aviso desses é
uma dívida à espera. No dia em que uma divergisse, o catálogo partia-se em
dois em silêncio (as mesmas garrafas em linhas diferentes) e a única coisa
que se notava era a conta da IA a não descer. **Se precisares de mexer na
chave ou na força, mexe lá.**

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
Lê `catalogo.consumo_resumo()` e `catalogo.resumo()`.
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
mesma `catalogo.tokens` da chave, e é isso que faz "qta do crasto"
encontrar "Quinta do Crasto"). Cada vinho abre numa ficha que mostra,
**campo a campo, de onde veio** (origem, força, data) e as fontes.

É o primeiro ecrã que alguma vez mostrou uma linha do catálogo.

### Duplicados — *a fusão manual*
Três coisas que não são negociáveis:
- **nunca automática.** Uma varredura por semelhança (mesmo ano, ≥2 tokens
  comuns, ≥60% de sobreposição) devolveu 29 pares em 162 linhas. Lá dentro
  havia duplicados a sério (*dona-ermelinda-freitas* / *ermelinda-freitas*)
  **e** falsos positivos perigosos: *nacional-touriga-vallado* com
  *esporao-nacional-touriga* — produtores diferentes a partilhar o nome de
  uma casta. **A semelhança serve para SUGERIR, nunca para DECIDIR**, e os
  números de cada par vão para o ecrã com ele.
- **o "não são" fica GRAVADO** (`catalogo.distintos`). Senão a lista volta
  a propor o mesmo par todas as semanas, e uma lista que insiste em erros
  deixa de se ler — é o caminho para alguém carregar em "são o mesmo" sem
  olhar e juntar um Vallado a um Esporão. Desmarcar também existe.
- **fundir é reversível.**
- **nunca se fundem colheitas diferentes.** `catalogo.fundir` recusa-o com
  erro, e a `candidatos` nem sequer propõe esses pares.

**Como a reversibilidade é feita, e porque não é como o documento propunha.**
O desenho original era um alias que a `catalogo.achar()` resolvesse — mas a
`achar` vive na fonte de verdade, no repo Garrafeira, e uma cópia dela aqui
era exatamente a avaria contra a qual está escrito o aviso grande lá em
cima. Sem lhe tocar:
1. os campos da linha perdedora passam para a alvo **um a um**, respeitando
   a `forca` que cada um já tinha dos dois lados — uma fusão nunca pode ser
   a porta dos fundos por onde uma leitura fraca tapa uma pesquisa paga;
2. a linha perdedora fica com as chaves **estacionadas** (prefixo
   `alias:`), e é só isso que a tira do caminho da `achar`. **A ficha dela
   não se toca; não se apaga uma linha.** Por isso a `listar` e a
   `candidatos` filtram `chave NOT LIKE 'alias:%'`;
3. o que foi mexido fica escrito em `catalogo.alias.campos_movidos`, com o
   estado ANTERIOR de cada campo.

`catalogo.separar` repõe as chaves e devolve cada campo ao que era — **mas
só os campos que ninguém reescreveu entretanto** (compara a entrada de
`origens` com a que a fusão lá pôs). Desfazer uma fusão de setembro não
pode deitar fora uma verificação de outubro; a app diz quantos ficaram.

## Login e permissões
- `SB_URL`/`SB_KEY` são os do projeto partilhado. **`Accept-Profile`/
  `Content-Profile` em todos os pedidos** — é isso que aponta para o schema,
  nunca vai no URL. Esta app fala com **dois**: `winecatalog` (REST normal,
  quem entra) e `catalogo` (**só por RPC**, e só pelas funções
  SECURITY DEFINER — a tabela tem RLS com zero policies e é assim que fica).
- Fluxo de acesso igual às outras: login → `sbAposLogin` confirma
  `allowed_users` → se não estiver lá, ecrã "sem acesso" com "Solicitar
  acesso" → o admin aprova em Definições.
- **Duas figuras diferentes, e não se confundem:**
  - **admin do catálogo** (`catalogo.config.admin_email`, na BD e não em
    código) — aprova quem entra e decide fusões. **Passa**, com
    `catalogo.definir_admin()`;
  - **dono da conta Supabase** (`SUPABASE_DONO_EMAIL`, fixo no `app.js`) —
    atrás dele fica só o que mexe na CONTA e não na app: a password
    temporária (`admin_pass_temp`, que escreve em `auth.users`). **Não
    passa**, porque a conta continua a ser de quem a paga.
- `isAdmin()` **não compara emails em código**: pergunta ao servidor
  (`catalogo.sou_admin()`). A UI só decide que botões mostrar; todas as
  funções de escrita voltam a confirmar — um botão escondido não é
  segurança.
- O admin entra sempre, mesmo sem linha em `allowed_users` (igual à
  `is_allowed()` do SQL): sem isso, apagar a própria linha trancava a app e
  não havia ninguém com direito a destrancá-la.

## O caminho de leitura, e porque não são policies
`catalogo.vinhos` continua com RLS e **zero policies**. Quem lê são funções
`SECURITY DEFINER` novas (`listar`/`ver`/`candidatos`/`resumo`/
`consumo_resumo`/`listar_distintos`) com `REVOKE` de `PUBLIC`/`anon` e
`GRANT` só a `authenticated` — e é **dentro** de cada uma que se confirma
quem é (`pode_ler()` para ler, `sou_admin()` para decidir).

Uma policy de SELECT era mais simples, mas abria a tabela a qualquer pessoa
com login em **qualquer** app do projeto que aponte para o schema
`catalogo` — e o schema está **exposto** na API. A lista de vinhos que
passaram por aqui diz alguma coisa sobre o que as pessoas têm em casa,
mesmo que cada linha à parte não diga.

**Cada função nova nasce com `EXECUTE` para `PUBLIC`, e um `REVOKE`
esquecido não dá erro — dá uma porta aberta calada.** Confirma sempre, com
a consulta que está no fim do `db/catalogo-winecatalog.sql` e no
`db/README.md`.

A vista `catalogo.consumo` (que une as duas `sync_log`) não se dá a
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
  Editor do Supabase — nunca ao contrário. E se for no `catalogo`, ver a
  regra grande lá em cima sobre onde é o "primeiro".
- **Escapar HTML:** `esc()` para conteúdo, `escJs()` para o que vai dentro
  de `onclick="…('…')"` — há vinhos com plica no nome ("Clefs D'or").
- **`STABLE` numa função que escreve não é `STABLE`** — nem sequer num
  `CREATE TEMP TABLE`, e o Postgres só o diz quando a função CORRE. A
  `catalogo.listar` usa uma CTE por causa disto.
- **`RETURNS TABLE` com nomes iguais aos das colunas** dá ambiguidade em
  plpgsql — daí tudo aqui devolver `jsonb`.
- Edições **cirúrgicas** (diffs pequenos).

## As lições das outras apps atravessam para cá
Aconteceu duas vezes seguidas: a Garrafeira apanhou os 404 dos nomes de
modelo fixos (1 de setembro) e os 400 do `thinkingBudget:0` com
`google_search` (10 de setembro), corrigiu-se, e a WineSelection ficou com
as duas avarias intactas durante semanas.

Esta app **não chama o Gemini** — não tem, hoje, nenhuma escolha de modelo
para divergir, e isso é de propósito (ver "O que falta"). Mas o Resumo é
onde isso se vê: **compara a última chamada de cada app antes de assumir
que a que está calada está bem.**

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

### Enriquecer um vinho que ninguém tem (§4.4 do doc de arranque)
Escrever nome + produtor + ano + cor, escolher os campos, e pesquisar — a
`vinho-info` sem garrafeira por trás.

**Porque não está feito, e não é por falta de tempo:** a regra dura é que a
WineCatalog **não ganha uma terceira cópia da escolha de modelo do Gemini**.
Foram precisas duas avarias silenciosas para se perceber o custo de duas
cópias; três seria pedi-lo. As duas saídas, por ordem de preferência:
1. **reutilizar a `vinho-info`**, tornando o `vinhoId` opcional — ela já faz
   exatamente isto (recebe nome/produtor/ano/campos, pergunta ao catálogo,
   chama a IA só pelo que falta, escreve de volta). O que a prende à
   Garrafeira é a linha em `garrafeira.analises` e a autorização por
   `is_editor()`. **É trabalho no repo Garrafeira**, não aqui;
2. uma função nova que **importe** a escolha de modelo de um sítio só.

A convenção das Edge Functions deste projeto é serem auto-contidas, e a
duplicação entre elas é intencional — mas essa convenção nasceu antes de
haver três. Se escolheres a 2, **escreve no `CLAUDE.md` das três apps que
agora há um sítio só.**

### O selector no momento de gravar (vive na Garrafeira)
"Já existe *X 2023* — é o mesmo?" É o que **previne** duplicados em vez de
os remediar, e o caso do Grous mostra que é a peça que faltava. Vale mais
do que o ecrã de Duplicados — mas é trabalho no outro repo.

## Deploy
GitHub Pages a partir de `main`. Um push para `main` publica.
Não há Edge Functions nesta app.
