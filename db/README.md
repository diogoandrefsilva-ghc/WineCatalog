# Base de dados — WineCatalog

Dois schemas, e a diferença entre eles é o ponto todo desta app:

| schema | de quem é | fonte de verdade |
|---|---|---|
| `winecatalog` | desta app | `db/schema.sql` + `functions.sql` + `policies.sql` + `admin_pass_temp.sql` (aqui) |
| `catalogo` | **de nenhuma app** — partilhado com a Garrafeira e a WineSelection | **`db/catalogo-partilhado.sql` no repo Garrafeira** |

O que está aqui em `catalogo-winecatalog.sql` **acrescenta** ao `catalogo` e
**não redefine nada** do que vem do repo Garrafeira: nem a tabela
`catalogo.vinhos`, nem a chave (`tokens`/`chave_base`/`chave`/`base_nome`/
`chave_nome`/`achar`), nem a `forca()`, nem a `volatil()`, nem as três
funções das Edge Functions (`juntar`/`procurar`/`procurar_lote`).

**Se precisares de mexer na chave ou na força, mexe lá.** Uma segunda cópia
da chave é a avaria que este catálogo não pode ter: no dia em que as duas
divergissem, ele partia-se em dois em silêncio e a única coisa que se
notava era a conta da IA a não descer.

## Ordem

```
1. db/schema.sql                   (schema winecatalog, allowed_users, access_requests)
2. db/catalogo-winecatalog.sql     (catalogo.config, leitura, alias, distintos, consumo)
3. db/functions.sql                (is_admin / is_allowed)
4. db/policies.sql                 (RLS do winecatalog)
5. db/admin_pass_temp.sql          (password temporária)
```

A ordem **não** é a das outras apps e é de propósito: o `catalogo` fica no
meio porque as duas metades se seguram uma à outra — `catalogo.pode_ler()`
lê `winecatalog.allowed_users` (nasce em 1) e `winecatalog.is_admin()`
pergunta a `catalogo.sou_admin()` quem manda (nasce em 2). Uma função
`LANGUAGE sql` é validada quando se cria: pô-la a chamar outra que ainda
não existe não dá um aviso, dá erro.

Todos os ficheiros são idempotentes — podem correr outra vez sem estragar
nada.

## Passos manuais no painel Supabase

1. **Expor os schemas na API** — Settings › API › Data API › *Exposed
   schemas*: acrescentar **`winecatalog`**. O `catalogo` já lá tem de estar
   (as Edge Functions das outras duas apps falam-lhe por RPC).
   Sem isto, tudo responde 404/406 sem uma palavra sobre o motivo.
   Expor não abre nada: `catalogo.vinhos`, `catalogo.config`,
   `catalogo.alias` e `catalogo.distintos` têm RLS **sem policy nenhuma**, e
   as funções estão revogadas a `anon`.
2. **Redirect URLs** — Authentication › URL Configuration › *Redirect URLs*:
   acrescentar o URL das GitHub Pages desta app
   (`https://<user>.github.io/WineCatalog/`). É para onde o link do email de
   recuperação volta.
3. **Confirmar os GRANTs** depois de correr o ponto 2 da ordem. Cada função
   `SECURITY DEFINER` nasce com `EXECUTE` para `PUBLIC`, e um `REVOKE`
   esquecido não dá erro — dá uma porta aberta calada:

```sql
SELECT p.proname,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'catalogo'
 ORDER BY 1;
```

O que se espera ver:

- **`false` para `authenticated`** em `juntar`, `procurar`, `procurar_lote`
  (são das Edge Functions, service_role) e em `admin_email` /`resumo_linha`
  (são chamadas de dentro das outras, onde o `SECURITY DEFINER` já as
  alcança). **É esta a linha que interessa** — se alguma delas aparecer a
  `true`, falta um `REVOKE`.
- **`true` para `authenticated` e `false` para `anon`** nas que a app chama:
  `listar`, `ver`, `candidatos`, `listar_distintos`, `resumo`,
  `consumo_resumo`, `fundir`, `separar`, `marcar_distintos`,
  `desmarcar_distintos`, `definir_admin`, `sou_admin`, `pode_ler`.
- **`true` para os dois** em `tokens`, `chave`, `chave_base`, `base_nome`,
  `chave_nome`, `achar`, `forca`, `volatil` e `num`. **Isto não é um
  esquecimento** — é como elas estão na fonte de verdade (uma função nasce
  com `EXECUTE` para `PUBLIC` e estas ficaram assim de propósito). São puras
  sobre os argumentos e não leem nada; a única que toca na tabela (`achar`)
  corre como quem chama e esbarra na RLS na mesma. E o `anon` nem chega lá:
  não tem `USAGE` neste schema.

Confirma também que o `anon` continua sem `USAGE` (e o `authenticated` com):

```sql
SELECT has_schema_privilege('anon','catalogo','USAGE')          AS anon,      -- false
       has_schema_privilege('authenticated','catalogo','USAGE') AS auth;      -- true
```

E que a tabela continua fechada:

```sql
SELECT count(*) FROM pg_policies WHERE schemaname = 'catalogo';   -- 0
```

4. **Primeiro utilizador.** O admin do catálogo começa em
   `catalogo.config.admin_email` (semeado com o email de quem montou isto).
   O admin não precisa de estar em `allowed_users` para entrar — a
   `is_allowed()` deixa-o passar sempre, senão apagar a própria linha
   trancava a app para toda a gente. Os outros pedem acesso pelo ecrã
   "Sem acesso" e o admin aprova-os em Definições › Utilizadores.

## Duas figuras diferentes, e não se confundem

- **Admin do catálogo** (`catalogo.config.admin_email`) — quem aprova quem
  entra e quem decide fusões. **Passa** com `catalogo.definir_admin()`.
- **Dono da conta Supabase** (fixo em `admin_pass_temp.sql` e em `app.js`) —
  fica atrás dele o que mexe na CONTA e não na app: a password temporária.
  **Não passa**, porque a conta continua a ser de quem a paga mesmo depois
  de o catálogo mudar de mãos. Mesma distinção que a Garrafeira faz.
