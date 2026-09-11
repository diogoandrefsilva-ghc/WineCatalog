-- =====================================================================
-- WineCatalog — Schema DDL (schema `winecatalog`)
--
-- Mesmo projeto Supabase do Goals/FestasBV/Garrafeira/WineSelection
-- (gjweqwfbnkgnibhajldc). Correr no SQL Editor por esta ordem:
--   schema.sql -> catalogo.sql -> functions.sql -> policies.sql
--   -> admin_pass_temp.sql
-- Ver db/README.md para os passos manuais (expor o schema na API,
-- redirect URLs) e db/migracao-catalogo-para-winecatalog.sql se vens do
-- schema `catalogo` antigo.
--
-- O QUE ESTE FICHEIRO CRIA: o schema, e as duas tabelas de quem entra. O
-- CATÁLOGO em si (a `vinhos`, a chave, a força, as funções) está no
-- `catalogo.sql`, que corre a seguir — vivem no MESMO schema mas em
-- ficheiros separados de propósito: um é a app, o outro é a coisa que a
-- app existe para guardar, e o segundo é lido por mais duas apps.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS winecatalog;

-- A service_role não tem acesso a schemas fora de `public` só por ser
-- service_role — BYPASSRLS é sobre policies, não sobre GRANTs. Sem isto,
-- as três Edge Functions falham com 42501 e sem uma palavra do lado de
-- quem chama. (A mesma nota está no `wineselection/db/schema.sql`, e foi
-- paga lá.)
GRANT USAGE ON SCHEMA winecatalog TO service_role;

-- E o `authenticated` precisa de USAGE para chamar as funções da app.
-- Isto não abre nada: USAGE deixa REFERENCIAR o que está no schema, e
-- cada objeto continua a precisar do seu próprio direito.
GRANT USAGE ON SCHEMA winecatalog TO authenticated;

-- ---------------------------------------------------------------------
-- Controlo de acesso (mesmo padrão do Goals/FestasBV/WineSelection)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS winecatalog.allowed_users (
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT allowed_users_pkey PRIMARY KEY (email)
);

CREATE TABLE IF NOT EXISTS winecatalog.access_requests (
  email        text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT access_requests_pkey PRIMARY KEY (email)
);

-- ---------------------------------------------------------------------
-- GRANTs — TABELA A TABELA, e isso não é preciosismo
--
-- As apps irmãs fazem `GRANT ALL ON ALL TABLES IN SCHEMA <x> TO anon,
-- authenticated` mais um `ALTER DEFAULT PRIVILEGES`, porque no schema
-- delas está tudo ao mesmo nível: são tabelas da app, protegidas por RLS
-- com policies. Este repo chegou a copiar esse padrão.
--
-- Aqui NÃO pode ser assim, e a razão é a mudança de casa do catálogo.
-- Enquanto ele viveu num schema só dele, a `vinhos` tinha DUAS travas: RLS
-- sem policy nenhuma E nenhum GRANT a quem tem login. Um grant em bloco
-- neste schema apanhava-a de caminho e deixava-a só com a RLS — continuava
-- fechada, mas por uma trave em vez de duas, e a diferença só se via no
-- dia em que alguém acrescentasse uma policy "só para uma coisinha".
--
-- Por isso: grants nomeados, e as tabelas do catálogo não estão nesta
-- lista (os delas estão no `catalogo.sql`, e são só para a service role).
-- Uma tabela nova aqui obriga à pergunta: é da APP ou é do CATÁLOGO?
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON winecatalog.allowed_users   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON winecatalog.access_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON winecatalog.allowed_users   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON winecatalog.access_requests TO service_role;

-- ---------------------------------------------------------------------
-- RLS (as policies ficam em policies.sql, depois de functions.sql)
-- ---------------------------------------------------------------------
ALTER TABLE winecatalog.allowed_users   ENABLE ROW LEVEL SECURITY;
ALTER TABLE winecatalog.access_requests ENABLE ROW LEVEL SECURITY;
