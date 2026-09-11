# WineCatalog 📚

A casa do **catálogo partilhado de vinhos** — a memória comum da
[Garrafeira](https://github.com/diogoandrefsilva-ghc/Garrafeira) e da
[WineSelection](https://github.com/diogoandrefsilva-ghc/WineSelection).

As duas apps pagavam ao Gemini para perguntar o mesmo sobre os mesmos
vinhos. O schema `catalogo` passou a ser a memória comum: o que uma
descobre, a outra aproveita. Funcionava — mas não tinha ecrã nenhum, não
tinha forma de resolver duplicados, e ninguém sabia quanto é que estava a
poupar. É isso que esta app é.

## Os ecrãs

- **Resumo** — pedidos servidos pelo catálogo vs. idas à IA, gasto e
  poupança estimados, tamanho do catálogo, e de que origem veio cada campo.
  Mais o "Sinal de vida": a última chamada de cada app, porque um log limpo
  numa app que não corre não é saúde, é desuso.
- **Catálogo** — a lista, com procura por nome, produtor, região ou casta.
  Cada vinho abre numa ficha que mostra, **campo a campo, de onde veio**:
  a origem, a força e a data. É o primeiro ecrã que alguma vez mostrou uma
  linha do catálogo.
- **Duplicados** — pares parecidos, lado a lado, com "ficar com esta" e
  "não são o mesmo". A semelhança **sugere, nunca decide**: já apanhou um
  Vallado com um Esporão por partilharem o nome de uma casta. Fundir é
  reversível e colheitas diferentes nunca se fundem.
- **Definições** — conta, utilizadores (admin) e a passagem do catálogo a
  outra pessoa.

## Instalar

Site estático, **sem build e sem npm**. PWA.

1. **Base de dados** — correr os ficheiros de `db/` na ordem que o
   [`db/README.md`](db/README.md) indica, e seguir os passos manuais do
   painel Supabase que lá estão (expor o schema `winecatalog` na API,
   redirect URLs, e **confirmar os GRANTs**).
2. **Publicar** — GitHub Pages a partir de `main`. Um push publica.

## Notas

- O schema `catalogo` **não é desta app**: a fonte de verdade dele é
  `db/catalogo-partilhado.sql` no repo da Garrafeira. O que está aqui em
  `db/catalogo-winecatalog.sql` acrescenta e não redefine nada — a chave
  que decide o que é o mesmo vinho vive num sítio só, de propósito.
- A chave `anon` no topo do `app.js` é **pública por design**, protegida por
  RLS + login.

Ver [`CLAUDE.md`](CLAUDE.md) para o resto — as invariantes, o que falta, e
porquê.
