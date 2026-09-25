# Verificar os links do Vivino

O script `vivino-verificar.mjs` confere os links do Vivino do catálogo, **sem
IA**, lê a nota e as avaliações, e (no teu computador) o **preço na Garrafeira
Nacional e na Granvine**. **Escreve no catálogo** o que encontra com certeza;
cada campo que muda fica em **Alertas › Alterações ao catálogo** (e na ficha
do vinho), com o valor de antes e um botão para o repor. Em **Alertas › Links
do Vivino por validar** ficam só os casos que pedem uma decisão.

O preço de mercado segue esta ordem: Garrafeira Nacional → Granvine → Vivino.
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

De cada vez que quiseres correr:

```
cd caminho/para/WineCatalog/batch
npm run vivino
```

Vês uma linha por vinho. No fim, abre a app › Alertas.

- Muda `LIMITE=` no `.env` para tratar mais ou menos vinhos.
- `ENSAIO=true` lê as páginas mas não grava nada — bom para um primeiro teste.
- Se aparecer **bloqueado**, o Vivino também recusa a partir de tua casa.
  Não se insiste: o script pára sozinho à segunda recusa.
- Os vinhos que tratas são os da **fila** (o botão "🍷 Verificar no Vivino"
  na ficha de um vinho) e depois os que nunca foram verificados.
- Quando acabares de usar, podes apagar o `.env` — voltas a criá-lo da
  próxima vez.
