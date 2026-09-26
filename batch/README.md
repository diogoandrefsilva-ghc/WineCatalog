# Verificar os links do Vivino

O script `vivino-verificar.mjs` confere os links do Vivino do catálogo, **sem
IA**, lê a nota e as avaliações, e (no teu computador) o **preço na Garrafeira
Nacional, na Granvine e na Vinha.pt** — e o que as páginas dizem do vinho
(fotografia, castas, região, teor, estágio, harmonização, notas de prova), só para os
campos que o catálogo ainda tem **vazios**. **Escreve no catálogo** o que encontra com certeza;
cada campo que muda fica em **Alertas › Alterações ao catálogo** (e na ficha
do vinho), com o valor de antes e um botão para o repor. Em **Alertas › Links
do Vivino por validar** ficam só os casos que pedem uma decisão.

O preço de mercado segue esta ordem: Garrafeira Nacional → Granvine → Vinha.pt → Vivino.
Os três ficam guardados na ficha ("Preços nas lojas"), com o link, a colheita
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

No painel:

- **Correr** — quantos vinhos, o que procurar (ver abaixo), e:
  - **Simular** — lê tudo e não grava nada. Guarda uma simulação em
    `batch/simulacoes/` (fica só no teu computador);
  - **Enriquecer** — grava logo no catálogo.
- **Escolher no catálogo** — a lista dos vinhos do catálogo, com a
  **miniatura da imagem** de cada um (e de onde veio: Vivino, loja, vossa,
  outro site; "✕" se já não abre), procura e filtros (imagem por origem ou
  sem imagem, sem preço, nunca verificados, link do Vivino suspeito). Com
  **"trocar a imagem destes, venha de onde vier"** ligado, os escolhidos
  ficam com a imagem da primeira loja que os tenha (ou do Vivino), mesmo a
  de outro site — a vossa fotografia nunca. Marca os que
  queres (até 50) e **Simular escolhidos** / **Enriquecer escolhidos**
  correm só esses, em vez da fila.
- **Vinho novo** — nome, produtor, ano e **cor** (obrigatória) de um ou
  mais vinhos que ainda não estão no catálogo, e **Procurar (simular)**. O
  script procura cada um no Vivino e nas lojas e deixa uma simulação: o vinho
  só é criado quando a gravares. Se já existir, enriquece o que lá está.
- **Procurar** (no cartão Correr; vale para Simular/Enriquecer, para os
  escolhidos no catálogo e para o vinho novo):
  - **Tudo** — Vivino e lojas, a ficha toda (só preenche campos vazios).
  - **Só o Vivino** — confirma o link (abre, é o vinho certo) e, se preciso,
    procura o certo; lê a nota e as avaliações; e a **imagem**, se estiver
    vazia ou também tiver vindo do Vivino. Não abre as lojas (poupa uns
    30–60 s por vinho), e por isso **não mexe num preço médio que veio de
    uma loja**; os outros campos da ficha também não.
  - **Só preços (e imagem)** — não abre o Vivino: Garrafeira Nacional →
    Granvine → Vinha.pt, e pára na primeira que tenha o vinho; o preço médio
    fica com esse, e a imagem dessa loja entra se a atual estiver vazia ou
    tiver vindo do Vivino.
  - **A imagem**, em qualquer modo, segue a ordem das lojas (GN → Granvine
    → Vinha.pt) e só depois o Vivino: a das lojas é mais nítida e igual de
    vinho para vinho. Uma imagem que veio do Vivino é trocada pela da loja;
    a vossa fotografia e a de outros sites nunca.
- **Registo** — uma linha por vinho, enquanto corre.
- **Simulações** — escolhe uma e vês, vinho a vinho, cada campo **antes →
  depois**. Desmarca o que não queres (um vinho inteiro ou um campo só) e
  carrega em **Gravar selecionados**. Grava exatamente o que viste, sem
  voltar a abrir página nenhuma; o que desmarcaste fica escrito no ficheiro.
  Desmarcar um link novo do Vivino desmarca também a nota e as avaliações
  lidas nessa página — eram desse link. E fica lembrado: esse link **não
  volta a ser proposto** para aquele vinho (nem os de "Deixar como está"
  em Alertas).

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
- Os vinhos que tratas são os da **fila** (o botão "🍷 Verificar no Vivino"
  na ficha de um vinho) e depois os que nunca foram verificados.
- Sem o painel (Mac, ou à mão): `npm run vivino`, com `LIMITE=`, `ENSAIO=true`
  e `MODO=completo|vivino|precos` no `.env`; `APLICAR=simulacoes/<ficheiro>.json` grava uma
  simulação revista à mão (põe `"aplicar": false` no que não queres).
- O painel só escuta neste computador (127.0.0.1) e cada pedido que corre o
  script leva um código que só a página aberta conhece.
