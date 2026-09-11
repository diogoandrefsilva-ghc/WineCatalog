-- =====================================================================
-- WineCatalog — Schema DDL (schema `winecatalog`)
--
-- Mesmo projeto Supabase do Goals/FestasBV/Garrafeira/WineSelection
-- (gjweqwfbnkgnibhajldc), schema isolado. Correr no SQL Editor por esta
-- ordem:
--   schema.sql -> catalogo-winecatalog.sql -> functions.sql
--   -> policies.sql -> admin_pass_temp.sql
-- Ver db/README.md para os passos manuais (expor schemas na API, redirect
-- URLs).
--
-- A ORDEM NÃO É A DAS OUTRAS APPS, e é de propósito: o `catalogo` fica no
-- meio porque as duas metades se seguram uma à outra. `catalogo.pode_ler()`
-- lê `winecatalog.allowed_users` (que nasce aqui, no primeiro ficheiro) e
-- `winecatalog.is_admin()` pergunta a `catalogo.sou_admin()` quem manda
-- (que nasce no segundo). Uma função `LANGUAGE sql` é validada quando se
-- cria: pô-la a chamar outra que ainda não existe não dá um aviso, dá erro.
--
-- O QUE ESTE SCHEMA É: só a app. Quem entra, quem manda, e nada mais. O
-- que a app MOSTRA vive todo no schema `catalogo`, que não é dela — é
-- partilhado com a Garrafeira e a WineSelection, e a sua fonte de verdade
-- é `db/catalogo-partilhado.sql` no repo Garrafeira. Ver
-- `catalogo-winecatalog.sql` (neste repo) para o que a WineCatalog
-- ACRESCENTA lá, e porquê é um ficheiro à parte.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS winecatalog;

-- A service_role não tem acesso a schemas fora de `public` só por ser
-- service_role — BYPASSRLS é sobre policies, não sobre GRANTs. Esta app não
-- tem Edge Functions nenhumas hoje, mas o dia em que tiver não é o dia para
-- descobrir isto outra vez (aconteceu nas outras duas).
GRANT USAGE ON SCHEMA winecatalog TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA winecatalog TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA winecatalog TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA winecatalog GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA winecatalog GRANT USAGE, SELECT ON SEQUENCES TO service_role;

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
-- QUEM MANDA: não está aqui, de propósito.
--
-- O admin desta app é o admin do CATÁLOGO, e o catálogo não é de nenhuma
-- das três apps — por isso o email vive em `catalogo.config` (ver
-- `catalogo-winecatalog.sql`), não numa `winecatalog.config` que ninguém
-- mais soubesse ler. Uma segunda linha a dizer quem manda é uma que um dia
-- discorda da primeira.
--
-- `winecatalog.is_admin()` (functions.sql) vai lá buscá-lo.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- GRANTs (sem isto: HTTP 403 / 42501 em tudo)
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA winecatalog TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA winecatalog TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA winecatalog GRANT ALL ON TABLES TO anon, authenticated;

-- ---------------------------------------------------------------------
-- RLS (as policies ficam em policies.sql, depois de functions.sql)
-- ---------------------------------------------------------------------
ALTER TABLE winecatalog.allowed_users   ENABLE ROW LEVEL SECURITY;
ALTER TABLE winecatalog.access_requests ENABLE ROW LEVEL SECURITY;
