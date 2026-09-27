# Verificar os links do Vivino

O script `vivino-verificar.mjs` confere os links do Vivino do catálogo, **sem
IA**, lê a nota e as avaliações, e (no teu computador) o **preço na Garrafeira
Nacional, na Granvine e na Vinha.pt** — e o que as páginas dizem do vinho
(fotografia, castas, região, teor, estágio, harmonização, notas de prova), só para os
campos que o catálogo ainda tem **vazios**. **Escreve no catálogo** o que encontra com certeza;
cada campo que muda fica em **Alertas › Alterações ao catálogo** (e na ficha
do vinho), com o valor de antes e um botão para o repor. Em **Alertas › Links
do Vivino por validar** ficam só os casos que pedem uma decisão.

**Duas notas do Vivino** (desde 26/09/2026): a **da colheita** (a página
aberta com `?year=<ano>`) e a **de todas as colheitas** (a mesma página sem
ano — `vivino_nota_global`/`vivino_avaliacoes_global`). Num vinho com
colheita isso é uma página a mais por vinho, com a mesma pausa; num vinho
sem colheita a página já é a de todas, e só essa se grava. As apps mostram a
da colheita a partir de 100 avaliações, e a global abaixo disso.

O preço de mercado segue esta ordem: Garrafeira Nacional → Granvine → Vinha.pt →
Vivino. Ficam todos guardados na ficha ("Preços nas lojas"), com o link, a colheita
e a data. Se a loja só tiver outra colheita, aceita-se e fica escrita ao lado.

Tem dois motores:

| | onde corre | como |
|---|---|---|
| **serper** | GitHub Actions, à mão | uma pesquisa Google por vinho (gasta do limite do Serper) |
| **browser** | **o teu computador** | abre as páginas do Vivino num Chromium |

O `browser` não corre no GitHub: o Vivino recusa as páginas aos servidores
de lá (HTTP 403, 25/09/2026).

## Correr no GitHub (Serper)

Actions › **Vivino — verificar links (Serper)** › **Run workflow**, com o
número de vinhos. Precisa de dois secrets no repo (Settings › Secrets and
variables › Actions): `SUPABASE_SERVICE_ROLE_KEY` e `SEARCH_API_KEY` (a chave
do serper.dev).

## Correr no teu computador (browser)

Uma vez só:

1. Instala o **Node.js** (versão 20 ou mais recente) de https://nodejs.org —
   o botão "LTS". Confirma no Terminal (Mac) ou na Linha de comandos
   (Windows): `node --version`.
2. Descarrega o repo: no GitHub, **Code › Download ZIP**, e descomprime. (Ou
   `git clone https://github.com/diogoandrefsilva-ghc/WineCatalog.git`.)
3. No Terminal, entra na pasta `batch` do repo e instala o browser:
   ```
   cd caminho/para/WineCatalog/batch
   npm install
   npx playwright install chromium
   ```
4. Copia `.env.exemplo` para `.env` (na mesma pasta) e cola lá a
   `SUPABASE_SERVICE_ROLE_KEY`. **Este ficheiro nunca vai para o GitHub** e
   não se manda a ninguém: a chave abre a base de dados de todas as apps.

De cada vez que quiseres correr — **duplo clique em `vinhos.bat`** (Windows):

1. faz `git pull` (fica sempre com a versão mais recente do script);
2. na primeira vez, instala o Playwright e o Chromium;
3. abre o **painel** no browser (`http://127.0.0.1:8787`). Deixa a janela
   preta aberta enquanto o usas; fechá-la desliga o painel.

O painel tem **quatro separadores**: **Informação de vinhos**, **Nomes de
vinhos**, **Produtores** e **Duplicados** (o separador aberto fica no
endereço — `#info`, `#nomes`, `#produtores`, `#duplicados` —, e recarregar a
página não o perde).

### Informação de vinhos

- **Escolher os vinhos a enriquecer ou corrigir** — um menu só, em três
  passos:
  1. **Critério** — a procura (nome, produtor, região, cor, ano) e os
     filtros: **imagem** (sem imagem, do Vivino, de uma loja, de outro site,
     a vossa fotografia), **preço** (sem/com), **produtor** (sem produtor),
     **link do Vivino** (sem link, suspeito — sem o número do vinho —, por
     limpar, certo), **verificado** (nunca, ou nunca/há mais de 30 ou 90
     dias) e **pedidos na app** (os do botão "🍷 Verificar no Vivino" da
     ficha). Cada opção diz quantos vinhos há, contados com os outros
     filtros ligados. Sem filtros, escolhe-se no catálogo todo.
  2. **Escolha** — primeiro **Ordenar por**: nome, alterados há menos (ou
     mais) tempo, criados há menos (ou mais) tempo, verificados há mais
     tempo (os nunca verificados primeiro) ou há menos, menos informação
     primeiro, preço de referência (mais caros ou mais baratos) e colheita.
     A última coluna da lista diz quando cada vinho foi alterado, criado e
     verificado, com a da ordem a negrito; a ordem escolhida fica guardada
     no browser. Depois: **à mão** na lista, **⬆ Os primeiros N** pela ordem
     ("os 10 alterados há mais tempo"), **🎲 Ao acaso N** entre os que
     passam, ou **Marcar todos os que passam**. Os primeiros e o acaso
     trocam a escolha de agora e mostram só os escolhidos, para veres o que
     vai correr e desmarcares algum. **Ver só os escolhidos** mostra a
     escolha, pela ordem em que corre. Até 50 de cada vez.
  3. **Correr** — **onde procurar**: um visto por sítio (Vivino, Garrafeira
     Nacional, Granvine, Vinha.pt — todos marcados de
     cada vez que abres o painel; "todos" · "nenhum"); **o que ler** (ver
     abaixo); **"trocar a imagem destes,
     venha de onde vier"** (os escolhidos ficam com a imagem da primeira
     loja que os tenha, ou do Vivino, mesmo a de outro site — a vossa
     fotografia nunca), e:
     - **Simular** — lê tudo e não grava nada. Guarda uma simulação em
       `batch/simulacoes/` (fica só no teu computador);
     - **Enriquecer** — grava logo no catálogo.

  A lista mostra a **miniatura da imagem** de cada vinho (e de onde veio:
  Vivino, loja, vossa, outro site; "✕" se já não abre) e **os preços de
  cada sítio** (GN, Granvine, Vinha.pt, Vivino — o que é o preço de
  referência a negrito com ★; se veio de outro sítio, uma linha
  "referência" diz de onde; passa o rato para ver o nome na loja, a colheita
  e a data). Corre sempre só o que está marcado: o painel já não escolhe
  vinhos sozinho (a "fila" ficou para o GitHub e o `npm run vivino`).
  **Carrega no nome de um vinho** para abrir a ficha dele (ver "A ficha de
  um vinho", abaixo).
- **Onde procurar e o que ler** (no passo 3; o Vinho novo tem os seus):
  - os **sítios marcados** são os únicos que se abrem. Só com o Vivino
    marcado é o antigo "Só o Vivino": confirma o link (e, se preciso,
    procura o certo), lê a nota, as avaliações e o que a página diz do
    vinho, e poupa uns 30–60 s por vinho. Sem o Vivino marcado, não se abre
    nem se regista verificação. Uma loja desmarcada não perde nada: o preço
    que já lá estava fica, e conta para o preço de referência como sempre.
  - **Ler: Tudo** — a ficha toda (só preenche campos vazios).
  - **Ler: Só preços (e imagem)** — não abre o Vivino (o visto dele fica
    apagado): as lojas marcadas, pela ordem GN → Granvine → Vinha.pt,
    e pára na primeira que tenha o vinho; o preço médio
    fica com esse, e a imagem dessa loja entra se a atual estiver vazia ou
    tiver vindo do Vivino. Precisa de pelo menos uma loja marcada.
  - **A imagem**, em qualquer modo, segue a ordem das lojas (GN → Granvine
    → Vinha.pt) e só depois o Vivino: a das lojas é mais nítida e igual de
    vinho para vinho. Uma imagem que veio do Vivino é trocada pela da loja;
    a vossa fotografia e a de outros sites nunca.
- **Registo** — uma linha por vinho, enquanto corre, e por cima uma **barra**
  com quantos já foram tratados e quanto falta (pela média dos que já
  passaram). **⏹ Parar** pára no fim do vinho que está a tratar: numa
  simulação, fica guardada com os vinhos já tratados (revê-se e grava-se
  como as outras); no Enriquecer, esses já estão gravados. Gravar uma
  simulação não se interrompe. Enquanto corre, o separador mostra ⏳.
- **Simulações** — escolhe uma e vês, vinho a vinho, cada campo **antes →
  depois**. Desmarca o que não queres (um vinho inteiro ou um campo só) e
  carrega em **Gravar selecionados**. Grava exatamente o que viste, sem
  voltar a abrir página nenhuma; o que desmarcaste fica escrito no ficheiro.
  Desmarcar um link novo do Vivino desmarca também a nota e as avaliações
  lidas nessa página — eram desse link. E fica lembrado: esse link **não
  volta a ser proposto** para aquele vinho (nem os de "Deixar como está"
  em Alertas).
  **O "antes" é o de AGORA, não o do dia da simulação**: ao abrir, o painel
  relê cada vinho na BD. Se corrigiste um campo à mão entretanto, aparece
  **mudou desde a simulação** — o teu valor → o da simulação, desmarcado:
  marca-o só se quiseres trocar. Se já puseste o mesmo valor que a
  simulação propõe, fica cinzento ("já está assim na BD") e não se grava.
  Uma fonte de preço que retiraste depois de simular continua retirada.
- **Vinho novo** — nome, produtor, ano e **cor** (obrigatória) de um ou
  mais vinhos que ainda não estão no catálogo, o que procurar, e **Procurar
  (simular)**. O script procura cada um no Vivino e nas lojas e deixa uma
  simulação: o vinho só é criado quando a gravares. Se já existir,
  enriquece o que lá está.
  Em **Links (opcional)** podes colar os endereços que já tens (Vivino,
  Garrafeira Nacional, Granvine, Vinha.pt — separados por espaço): o script
  abre-os diretamente em vez de procurar, e o nome não os recusa (só a cor e
  a colheita contam). O do Vivino tem de ser o de um vinho (`/w/<nº>`). Sem
  produtor, propõe o que a página do Vivino diz (a adega) — aparece na
  simulação (com a etiqueta *identidade*) e só entra se o deixares marcado.
  O mesmo vale para **qualquer vinho do catálogo sem produtor** que o script
  trate (Simular ou Enriquecer): só preenche um produtor vazio, nunca troca
  um que já lá esteja (isso é o Editar da app). Para os apanhar todos de uma
  vez: **Produtor › sem produtor › Marcar todos os que passam**, só com o
  **Vivino** marcado.
- **A ficha de um vinho** (carrega no nome, na lista; ou no `#id`, nas
  simulações e nas garrafeiras) — o back-office: o vinho inteiro, cada campo
  com **de onde veio** (a origem, a força e a data), os preços de cada
  sítio, as fontes, as últimas verificações do Vivino, as linhas fundidas
  nele e o histórico. **✏️ Editar** corrige à mão — os mesmos campos do
  Editar da app, o interruptor da identidade (nome, produtor, colheita) e o
  "retirar" de cada fonte de preço (se for a do preço de referência, o campo
  passa ao da seguinte, pela ordem de sempre). Só vai o que mudaste, com a
  força de uma correção à mão (4 no rótulo, 3 na nota, no preço e na
  imagem), e fica no histórico como "painel do PC (admin)". Se a identidade
  nova for a de outro vinho que já existe, não grava e diz qual — juntam-se
  nos Duplicados. Esvaziar um campo apaga-o. **🔗 É o mesmo que…** procura
  o outro vinho na lista e faz o mesmo que o **É este** dos Duplicados.
- **Quem criou e quem alterou** — na lista, debaixo de cada data ("por
  pedro_barrona · Garrafeira", "por script no PC"…), no topo da ficha e no
  histórico dela; dá para filtrar (**Criado por**, **Alterado por**) e para
  procurar ("pedro"). Quando o histórico só diz "Edge Function" (uma
  pesquisa com IA de uma das apps) ou "uma garrafeira", o painel vai aos
  registos das apps ver quem foi, **pela hora** — duas pessoas no mesmo
  minuto podem trocar-se. Os vinhos de antes de 25/09/2026 dizem "(antes do
  histórico)".
- **As garrafeiras × o catálogo**:
  - **Links do Vivino nas garrafeiras** — **Comparar** compara o link de
    cada vinho das garrafeiras de toda a gente com o do catálogo e mostra os
    que estão errados (sem o número do vinho, ou a abrir outro vinho) ou
    vazios, com a garrafeira, o dono e **agora → catálogo**. Só propõe o
    link do catálogo quando ele está confirmado (lido na página pelo script,
    ou escrito por ti); um link para uma colheita do mesmo vinho fica como
    está. Desmarca o que não queres e **Corrigir os marcados** grava (fica
    no registo da Garrafeira). Os **Por confirmar** — o da garrafeira parece
    errado mas o do catálogo ainda não foi confirmado — ou os confirmas tu
    (abre os dois links; se o do catálogo for o certo, marca **usar o do
    catálogo** e vai com **Corrigir os marcados**), ou passam num clique
    para a escolha dos vinhos, já com **Só o Vivino**: simula-os (ou
    enriquece) e volta a comparar.
  - **Fichas das garrafeiras × catálogo** — o mesmo para o resto da ficha
    (nota, avaliações, preço, castas, teor, estágio, janela, notas de prova,
    harmonização, resumo), **só da mesma colheita**: o que está vazio na
    garrafeira, e o que é diferente quando o do catálogo é mais recente do
    que a última vez que o dono gravou o vinho. Um visto por campo (e um por
    vinho, que marca/desmarca os dele); **Corrigir os marcados** grava. A
    cor, a fotografia da própria pessoa e as notas pessoais nunca se tocam.

### Nomes de vinhos

A regra do nome (a colheita, o produtor da frente e a cor no fim saem do
nome) sobre o que já cá estava, no catálogo e nas garrafeiras. Simula
sozinha quando abres o separador (**🔄 Simular de novo** volta a correr).
Filtros: a procura, **Onde** (catálogo ou garrafeiras), **O que sai do
nome** (a colheita, o produtor, a cor, ou só os com avisos) e **só os que
mudam agora**. **Marcar/Desmarcar os que se veem** e **Aplicar os
marcados** — só os marcados que se veem; um desmarcado fica desmarcado ao
mudar os filtros. Quando o nome que sobra fica vago ("1836 Grande
Reserva"), desmarca-o e carrega em **Manter o nome dos desmarcados**: o
produtor nunca mais sai da frente desse nome (a lista está em **Nomes que
ficam como estão**, com ✕ para tirar).

### Produtores

As grafias do mesmo produtor ("Ramos Pinto" e "Adriano Ramos Pinto"):
escolhe o oficial e **Juntar**, ou **São diferentes**. Carrega sozinho
quando abres o separador; a procura filtra as sugestões e os oficiais já
definidos. Em cada oficial: **Mudar** troca o nome oficial (em todos os
vinhos dele, no catálogo e nas garrafeiras; o nome antigo fica como grafia),
**+ Acrescentar** junta-lhe outra maneira de o escrever (a lista sugere as
que existem, com quantos vinhos têm e de que oficial já são), ✕ tira uma
grafia, e ao lado escreve-se o nome completo.

### Duplicados

Vinhos que parecem o mesmo — o número no separador é o alerta (carrega ao
abrir o painel):

- **Uma letra de diferença** — um nome com uma letra trocada, a mais ou a
  menos ("Cristo" / "Crasto"), **em qualquer colheita**; o de cima é o
  suspeito (a palavra mais rara), por baixo os vinhos que ele pode ser.
- **Mesma colheita, nome parecido** — os pares dos Duplicados da app.

**É este** / **São o mesmo**: ficam o nome, o produtor e a cor do outro, e a
colheita de cada um. Da mesma colheita juntam-se num só (desfaz-se na app,
em Duplicados › Fusões); de outra colheita, este passa a ser essa colheita
do outro vinho (colheitas diferentes nunca se juntam). **Nenhum destes** /
**Não são** fica gravado e o par não volta.

Tudo o que é gravado (pelas duas vias) fica em **Alertas › Alterações ao
catálogo** na app, com "Repor".

Notas:

- **`SEARCH_API_KEY` no `.env` (opcional)** — a chave do serper.dev (a mesma
  do secret do GitHub). Com ela, quando a procura do Vivino não encontra o
  vinho, o script faz **uma** pesquisa Google por esse vinho (gasta uma do
  limite do Serper). É o ÚLTIMO recurso: primeiro o script escreve o nome
  na caixa de procura do Vivino (como tu fazes) e depois tenta o endereço
  de procura; só se nenhum dos dois der nada é que se gasta uma pesquisa.

- Uma simulação antiga ainda se pode gravar: o catálogo só aceita cada campo
  se a força da origem chegar (a mesma regra de sempre).
- Se aparecer **bloqueado**, o Vivino também recusa a partir de tua casa.
  Não se insiste: o script pára sozinho à segunda recusa.
- No painel, os vinhos que tratas são sempre os que escolheste (passo 2).
  A **fila** — os pedidos da app ("🍷 Verificar no Vivino"), depois os nunca
  verificados, depois os vistos há mais tempo — é a do GitHub e do
  `npm run vivino`; no painel, os pedidos são o filtro **Pedidos na app**.
- Sem o painel (Mac, ou à mão): `npm run vivino`, com `LIMITE=`, `ENSAIO=true`,
  `MODO=completo|vivino|precos` e `SITES=vivino,garrafeira_nacional,granvine,vinha`
  (vazio = todos) no `.env`; `APLICAR=simulacoes/<ficheiro>.json` grava uma
  simulação revista à mão (põe `"aplicar": false` no que não queres).
- O painel só escuta neste computador (127.0.0.1) e cada pedido que corre o
  script leva um código que só a página aberta conhece.
