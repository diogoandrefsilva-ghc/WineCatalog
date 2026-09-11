-- =====================================================================
-- WineCatalog — Funções (schema `winecatalog`)
-- Ordem: schema.sql -> catalogo-winecatalog.sql -> functions.sql
--        -> policies.sql -> admin_pass_temp.sql
--
-- Nota de segurança: `is_admin` e `is_allowed` são SECURITY DEFINER com
-- search_path fixo. Têm de o ser: leem tabelas que estão elas próprias
-- por trás de RLS (`winecatalog.config`, `winecatalog.allowed_users`), e uma
-- policy que chama uma função que volta a bater na mesma tabela protegida
-- é recursão infinita (42P17) ou, pior, um `false` calado que tranca a app
-- toda sem erro visível.
-- =====================================================================

-- QUEM MANDA não se decide aqui: pergunta-se ao catálogo.
--
-- É a diferença que justifica esta app existir. A Garrafeira tem o seu
-- admin e a WineSelection tem o dela; o CATÁLOGO não é de nenhuma das
-- duas, e quem manda nele tem de ser uma pessoa só, escrita num sítio só
-- (`winecatalog.config.admin_email`). Uma `winecatalog.config.admin_email` à
-- parte era uma segunda linha a dizer quem manda — e duas linhas dessas
-- um dia discordam.
CREATE OR REPLACE FUNCTION winecatalog.is_admin()
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT winecatalog.sou_admin();
$$;

-- Tem acesso? O admin conta sempre, mesmo que se esqueça de se pôr na
-- lista a si próprio — sem isto, apagar a própria linha era trancar a app
-- e não haver ninguém com direito a destrancá-la.
CREATE OR REPLACE FUNCTION winecatalog.is_allowed()
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT winecatalog.is_admin() OR EXISTS (
    SELECT 1 FROM winecatalog.allowed_users
     WHERE lower(email) = lower(COALESCE(auth.email(), ''))
  );
$$;

-- O REVOKE antes do GRANT, e não é zelo a mais: uma função SECURITY
-- DEFINER nasce com EXECUTE para PUBLIC, e PUBLIC inclui o `anon`. Sem
-- estas duas linhas ficavam as duas abertas a quem não tem login — foi o
-- linter do Supabase que o apontou, e é exactamente o buraco calado
-- contra o qual está escrito o aviso no `catalogo.sql`.
REVOKE ALL ON FUNCTION winecatalog.is_admin()   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION winecatalog.is_allowed() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.is_admin()   TO authenticated;
GRANT EXECUTE ON FUNCTION winecatalog.is_allowed() TO authenticated;
