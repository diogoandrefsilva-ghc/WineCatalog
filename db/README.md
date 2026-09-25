# Base de dados — WineCatalog

**Um schema só: `winecatalog`.** Lá dentro vivem duas coisas diferentes, e
a diferença é o que decide como se lhes mexe:

| | o que é | ficheiro | quem lhe toca |
|---|---|---|---|
| **a app** | `allowed_users`, `access_requests` | `schema.sql` | só esta app, por REST com RLS |
| **o catálogo** | `vinhos`, `alias`, `distintos`, `config` + a chave, a força e as funções | `catalogo.sql` | esta app (por funções), e as três Edge Functions (por RPC, service role) |

**`catalogo.sql` é a FONTE DE VERDADE do catálogo.** Não há cópia em lado
nenhum. Viveu até setembro de 2026 num schema à parte (`catalogo`) e num
terceiro repo (Garrafeira) — ver `migracao-catalogo-para-winecatalog.sql`.

A chave que decide o que é o mesmo vinho (`tokens`/`chave_base`/`chave`/
`base_nome`/`chave_nome`/`achar`) vive **só ali**. Nenhuma Edge Function a
calcula, de propósito: esteve repetida em TypeScript nos três lados com um
aviso a dizer para as manter iguais, e um aviso desses é uma dívida à
espera — no dia em que uma divergisse, o catálogo partia-se em dois em
silêncio e a única coisa que se notava era a conta da IA a não descer.

## Ordem

```
0. db/migracao-catalogo-para-winecatalog.sql   (SÓ se vens do schema `catalogo`)
1. db/schema.sql            (schema + as duas tabelas de quem entra)
2. db/catalogo.sql          (o catálogo: tabelas, chave, força, funções, grants)
3. db/functions.sql         (is_admin / is_allowed)
4. db/policies.sql          (RLS das tabelas da app)
5. db/admin_pass_temp.sql   (password temporária)
6. db/imagens.sql          (bucket público das fotografias do catálogo)
7. db/vivino.sql           (a verificação dos links do Vivino — depois do curadoria.sql)
8. db/historico.sql        (o histórico campo a campo, com "Repor" — depois do curadoria.sql)
```

O `vivino.sql` precisa de um passo fora do Supabase: o secret
`SUPABASE_SERVICE_ROLE_KEY` no repo do GitHub (Settings › Secrets and
variables › Actions), que é o que o `.github/workflows/vivino.yml` usa.

E, do repo **Garrafeira**, o `db/catalogo-partilhado.sql` — que passou a ser
só o gancho dela (o trigger que leva cada vinho gravado numa garrafeira
para o catálogo).

Todos são idempotentes.

## `ia_uso.sql` — fora desta ordem, de propósito

```
db/ia_uso.sql               (o registo do que as 5 apps gastam no Gemini)
```

**Não depende de nada nem nada depende dele**, por isso corre-se quando se
quiser. É um schema À PARTE (`ia_uso`) e **não é desta app**: é a memória
comum do que as cinco apps que chamam o Gemini gastam — WineCatalog,
Garrafeira, WineSelection, SplitBill e FestasBV, por oito Edge Functions.
Está aqui pela mesma razão por que o catálogo está: não é de nenhuma delas,
e este é o repo onde as coisas de todos vivem. Tem dono próprio
(`ia_uso.config.admin_email`), que não tem de ser o admin desta app.

Uma linha por chamada: app, função, modelo, tokens, custo estimado,
duração, quem e o erro. Escreve a `service_role`, de dentro de cada Edge
Function; lê-se por `ia_uso.listar()`/`ia_uso.resumo()`, com o portão
`ia_uso.sou_admin()` lá dentro. Ver "O registo central de acessos ao
Gemini" no `CLAUDE.md`.

**Dois passos manuais, e falham os dois em silêncio:**

1. **Expor `ia_uso`** em Settings › API › Data API › *Exposed schemas* (o
   mesmo passo do `winecatalog`, lá em baixo). Sem isto o PostgREST
   responde `PGRST106`.
2. **Correr o ficheiro INTEIRO** — o bloco de GRANTs no fim inclusive. Sem
   ele não há um único GRANT no schema, nem sequer `USAGE` para a
   `service_role`, e os INSERTs levam 403 (`42501`).

Em qualquer dos dois casos o erro é engolido pelo `try/catch` da
`registarIaUso()` de cada função — que é o que a impede de deitar abaixo a
chamada que estava a ser feita — e o que se vê é a tabela a zero linhas,
sem um erro em lado nenhum. **Já aconteceu.** Se `ia_uso.registos` estiver
vazia, confere estes dois ANTES de desconfiar do código:

```sql
SELECT has_schema_privilege('service_role', 'ia_uso', 'USAGE')            AS srv_usage,
       has_table_privilege('service_role', 'ia_uso.registos', 'INSERT')   AS srv_insert,
       has_table_privilege('authenticated', 'ia_uso.registos', 'SELECT')  AS auth_select;
SELECT count(*) FROM pg_policies WHERE schemaname = 'ia_uso';  -- 2
```

## Passos manuais no painel Supabase

1. **Expor o schema na API** — Settings › API › Data API › *Exposed
   schemas*: acrescentar **`winecatalog`** e, se estavas no mundo antigo,
   **tirar `catalogo`**. Sem isto, tudo responde 404/406 sem uma palavra
   sobre o motivo.
   Expor não abre nada: a `vinhos` tem RLS sem policy nenhuma **e** nenhum
   GRANT a quem tem login, e as funções estão revogadas a `anon`.
2. **Redirect URLs** — Authentication › URL Configuration: acrescentar o URL
   das GitHub Pages desta app.
3. **Deploy das três Edge Functions** (ver a migração), se vens do mundo
   antigo.
4. **Confirmar os GRANTs.** Cada função `SECURITY DEFINER` nasce com
   `EXECUTE` para `PUBLIC`, e um `REVOKE` esquecido não dá erro — dá uma
   porta aberta calada:

```sql
SELECT p.proname,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'winecatalog'
 ORDER BY 1;
```

O que se espera:

- **`false` para `authenticated`** em `juntar`, `procurar`, `procurar_lote`
  (são das Edge Functions) e em `admin_email`/`resumo_linha` (são chamadas
  de dentro das outras). **É esta a linha que interessa** — se alguma
  aparecer a `true`, falta um `REVOKE`.
- **`true` para `authenticated`, `false` para `anon`** nas que a app chama:
  `listar`, `ver`, `candidatos`, `listar_distintos`, `resumo`,
  `fundir`, `separar`, `marcar_distintos`,
  `desmarcar_distintos`, `definir_admin`, `sou_admin`, `pode_ler`.
- **`false` nos dois** em `preco_num` e `faixa_preco` — são as duas do
  filtro de preço da lista, e quem as chama é a `listar`, por dentro. As
  faixas (`<15`/`15-30`/`30-60`/`60+`) vivem ali e não no browser: são o
  que a `listar` conta E o que ela filtra, e duas listas destas divergem
  no dia em que alguém mexe numa só.
- **`true` nos dois** em `tokens`, `chave`, `chave_base`, `base_nome`,
  `chave_nome`, `achar`, `forca`, `volatil`, `num`. **Não é esquecimento**:
  são puras sobre os argumentos, a única que lê a tabela (`achar`) corre
  como quem chama e esbarra na RLS, e o `anon` nem tem `USAGE` no schema.

5. **Confirmar a trava dupla da `vinhos`** — é o que a mudança de casa podia
   ter aberto, e a razão de os grants deste schema serem tabela a tabela:

```sql
SELECT count(*) FROM pg_policies
 WHERE schemaname='winecatalog' AND tablename='vinhos';                    -- 0
SELECT has_table_privilege('authenticated','winecatalog.vinhos','SELECT'); -- false
```

6. **Primeiro utilizador.** O admin começa em `winecatalog.config.admin_email`.
   Não precisa de estar em `allowed_users` para entrar — a `is_allowed()`
   deixa-o passar sempre, senão apagar a própria linha trancava a app. Os
   outros pedem acesso pelo ecrã "Sem acesso".

## Duas figuras diferentes, e não se confundem

- **Admin do catálogo** (`winecatalog.config.admin_email`) — aprova quem
  entra e decide fusões. **Passa** com `winecatalog.definir_admin()`.
- **Dono da conta Supabase** (fixo em `admin_pass_temp.sql` e no `app.js`) —
  atrás dele fica o que mexe na CONTA e não na app: a password temporária.
  **Não passa**, porque a conta continua a ser de quem a paga.

## Se acrescentares uma tabela aqui

A pergunta é sempre a mesma: **é da APP ou é do CATÁLOGO?** Da app, leva
GRANT nomeado no `schema.sql` e policies no `policies.sql`. Do catálogo,
não leva grant nenhum a quem tem login — só à service role — e alcança-se
por uma função `SECURITY DEFINER`. Não há grants em bloco neste schema
(`GRANT ALL ON ALL TABLES`), e é de propósito: um grant desses apanhava a
`vinhos` de caminho e tirava-lhe uma das duas travas sem ninguém dar por
isso.
