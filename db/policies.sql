-- =====================================================================
-- WineCatalog — RLS Policies (schema `winecatalog`)
--
-- PRÉ-REQUISITO: depende de `winecatalog.is_admin()` (functions.sql), que
-- por sua vez depende de `catalogo.sou_admin()`
-- (catalogo-winecatalog.sql). Correr os dois ANTES deste ficheiro.
--
-- Repara que aqui NÃO há policy nenhuma sobre o catálogo. `catalogo.vinhos`
-- continua com RLS e ZERO policies, como sempre esteve, e é assim que fica:
-- quem lê o catálogo lê-o pelas funções SECURITY DEFINER
-- (`catalogo.listar`/`ver`/…), nunca pela tabela. Abrir a tabela com uma
-- policy dava-a a qualquer pessoa com login em QUALQUER app do projeto que
-- aponte para o schema `catalogo` — e o schema está exposto na API.
-- =====================================================================

-- ---------------------------------------------------------------------
-- access_requests
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS ar_insert ON winecatalog.access_requests;
CREATE POLICY ar_insert ON winecatalog.access_requests
  FOR INSERT TO authenticated
  WITH CHECK (email = auth.email());

DROP POLICY IF EXISTS ar_admin_sel ON winecatalog.access_requests;
CREATE POLICY ar_admin_sel ON winecatalog.access_requests
  FOR SELECT TO authenticated
  USING (winecatalog.is_admin());

DROP POLICY IF EXISTS ar_admin_del ON winecatalog.access_requests;
CREATE POLICY ar_admin_del ON winecatalog.access_requests
  FOR DELETE TO authenticated
  USING (winecatalog.is_admin());

-- ---------------------------------------------------------------------
-- allowed_users — cada um vê a sua linha (é o que o ecrã de arranque
-- pergunta para saber se entra); o admin vê e mexe na lista toda.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS au_select ON winecatalog.allowed_users;
CREATE POLICY au_select ON winecatalog.allowed_users
  FOR SELECT TO authenticated
  USING (lower(email) = lower(COALESCE(auth.email(), '')) OR winecatalog.is_admin());

DROP POLICY IF EXISTS au_admin_ins ON winecatalog.allowed_users;
CREATE POLICY au_admin_ins ON winecatalog.allowed_users
  FOR INSERT TO authenticated
  WITH CHECK (winecatalog.is_admin());

DROP POLICY IF EXISTS au_admin_del ON winecatalog.allowed_users;
CREATE POLICY au_admin_del ON winecatalog.allowed_users
  FOR DELETE TO authenticated
  USING (winecatalog.is_admin());
