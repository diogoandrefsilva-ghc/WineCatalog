-- =====================================================================
-- As garrafeiras × o catálogo, na app (27/09/2026, pedido do dono)
--
-- Correr DEPOIS das migrações 18 e 19 do repo Garrafeira
-- (`db/migracao-links-vivino.sql`, `db/migracao-fichas-catalogo.sql`) na
-- versão de 27/09/2026, cujo portão aceita o admin do catálogo além da
-- `service_role`. Sem essa versão, isto responde "Só o batch…".
--
-- O painel do PC (batch/painel.mjs) tinha dois cartões que não abrem site
-- nenhum — é a BD a comparar a BD: os links do Vivino das garrafeiras com os
-- do catálogo, e o resto da ficha. O dono das apps: "o que é só comparação e
-- análise de dados, podemos ter na app". Estas duas funções são a porta da
-- app para as MESMAS `garrafeira.links_vivino_rever`/`fichas_catalogo_rever`
-- — as regras, a confirmação do link, o registo no `sync_log`: uma cópia só,
-- no repo Garrafeira, e o painel continua a chamá-las como antes.
--
-- Porque um invólucro aqui, e não a função de lá aberta a `authenticated`:
-- a app fala com UM schema (`catRpc`, ver app.js), e a de lá continua só da
-- `service_role` — quem tem login chega-lhe por aqui, com o portão deste lado
-- (`sou_admin()`) E o de lá.
--
-- O que isto abre, e a quem: ao ADMIN DO CATÁLOGO, cada vinho das
-- garrafeiras com a garrafeira e o dono — o mesmo que o painel já lhe
-- mostrava, e o que a `nomes_rever` e a `produtor_definir` (os Nomes e os
-- Produtores, também na app) já viam. Ver a invariante 2 no CLAUDE.md.
-- =====================================================================

CREATE OR REPLACE FUNCTION winecatalog.garrafeiras_links_rever(
  p_ids bigint[] DEFAULT NULL, p_aplicar boolean DEFAULT false,
  p_forcar bigint[] DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT winecatalog.sou_admin() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  IF to_regprocedure('garrafeira.links_vivino_rever(bigint[], boolean, bigint[])') IS NULL THEN
    RAISE EXCEPTION 'Falta a migração 18 da Garrafeira (db/migracao-links-vivino.sql).';
  END IF;
  RETURN garrafeira.links_vivino_rever(p_ids, p_aplicar, p_forcar);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.garrafeiras_links_rever(bigint[], boolean, bigint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.garrafeiras_links_rever(bigint[], boolean, bigint[]) TO authenticated;

CREATE OR REPLACE FUNCTION winecatalog.garrafeiras_fichas_rever(
  p_itens jsonb DEFAULT NULL, p_aplicar boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT winecatalog.sou_admin() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  IF to_regprocedure('garrafeira.fichas_catalogo_rever(jsonb, boolean)') IS NULL THEN
    RAISE EXCEPTION 'Falta a migração 19 da Garrafeira (db/migracao-fichas-catalogo.sql).';
  END IF;
  RETURN garrafeira.fichas_catalogo_rever(p_itens, p_aplicar);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.garrafeiras_fichas_rever(jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.garrafeiras_fichas_rever(jsonb, boolean) TO authenticated;

-- Confirmar (as duas: `authenticated` sim, `anon` não; e as de lá continuam
-- só com `service_role` e o dono):
-- select routine_schema, routine_name, grantee from information_schema.routine_privileges
--  where routine_name in ('garrafeiras_links_rever', 'garrafeiras_fichas_rever',
--                         'links_vivino_rever', 'fichas_catalogo_rever')
--  order by 1, 2, 3;
