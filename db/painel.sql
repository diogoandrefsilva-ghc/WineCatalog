-- =====================================================================
-- O PAINEL DO PC COMO BACK-OFFICE (27/09/2026, pedido do dono: "estamos a
-- tentar fazer disto o nosso back-office"). Na lista de vinhos do painel
-- (batch/painel.mjs), um clique abre a ficha do vinho — cada campo com a
-- origem, a força e a data, os preços de cada sítio, as fontes, as últimas
-- verificações do Vivino e o histórico — e dá para corrigir à mão.
--
-- O painel fala com a BD pela `service_role` (a chave do batch/.env), que
-- não tem email: a `ver`, a `historico` e a `editar` da app confirmam o
-- admin pelo email (`sou_admin()`) e recusavam-no. Duas portas pequenas,
-- SÓ para a `service_role`:
--   · `painel_vinho` — o vinho inteiro, numa ida;
--   · `painel_editar` — a MESMA `editar` da app (força 4 no rótulo, 3 na
--     nota/preço/imagem, a trava da identidade, o histórico, o sync_log),
--     com o "quem" do histórico posto ("painel do PC (admin)"). Não há um
--     segundo caminho de escrita: a `editar` passou a aceitar a
--     `service_role` (db/cor-na-chave.sql) e esta só lhe põe o nome.
-- Corre depois de db/cor-na-chave.sql e db/historico.sql.
-- =====================================================================

CREATE OR REPLACE FUNCTION winecatalog.painel_vinho(p_id bigint)
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_alvo bigint;
  r      winecatalog.vinhos%ROWTYPE;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Só o painel do PC (service_role) chama isto.';
  END IF;
  -- Um id fundido responde pelo vinho que ficou (como a `vivino_estes`).
  v_alvo := COALESCE((SELECT id_para FROM winecatalog.alias WHERE id_de = p_id), p_id);
  SELECT * INTO r FROM winecatalog.vinhos WHERE id = v_alvo;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Vinho não encontrado.'; END IF;
  RETURN jsonb_build_object(
    'id', r.id, 'nome', r.nome, 'produtor', r.produtor, 'ano', r.ano, 'cor', r.cor,
    'ficha', r.ficha, 'origens', r.origens, 'fontes', r.fontes,
    'vezes', r.vezes, 'criado', r.criado_em, 'atualizado', r.atualizado_em,
    'produtor_completo', (SELECT p.nome_completo FROM winecatalog.produtores p
                           WHERE p.nome = winecatalog.produtor_oficial(r.produtor) LIMIT 1),
    -- As grafias que os Duplicados já juntaram nesta.
    'fundidos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', v.id, 'nome', v.nome, 'produtor', v.produtor, 'ano', v.ano) ORDER BY v.id)
        FROM winecatalog.alias a JOIN winecatalog.vinhos v ON v.id = a.id_de
       WHERE a.id_para = r.id), '[]'::jsonb),
    'verificacoes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('em', x.verificado_em, 'estado', x.estado, 'revisao', x.revisao,
                                          'pagina', x.nome_pagina) ORDER BY x.verificado_em DESC)
        FROM (SELECT * FROM winecatalog.vivino_verificacoes
               WHERE vinho_id = r.id ORDER BY verificado_em DESC LIMIT 5) x), '[]'::jsonb),
    -- O histórico deste vinho (e das linhas fundidas nele), o mais recente
    -- primeiro. O "quem" é o da `quem_escreve`: nunca o email de quem não é
    -- o admin (invariante 2).
    'historico', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('campo', a.campo, 'antes', a.antes, 'depois', a.depois,
                                          'origem', a.origem, 'quem', a.quem, 'quando', a.quando)
                       ORDER BY a.quando DESC, a.id DESC)
        FROM (SELECT * FROM winecatalog.alteracoes
               WHERE vinho_id = r.id
                  OR vinho_id IN (SELECT id_de FROM winecatalog.alias WHERE id_para = r.id)
               ORDER BY quando DESC, id DESC LIMIT 60) a), '[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION winecatalog.painel_editar(
  p_id bigint,
  p_campos jsonb DEFAULT '{}'::jsonb,
  p_nome text DEFAULT NULL,
  p_produtor text DEFAULT NULL,
  p_ano integer DEFAULT NULL,
  p_mexer_identidade boolean DEFAULT false,
  p_quem text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Só o painel do PC (service_role) chama isto.';
  END IF;
  -- Só nesta transação: é o que o histórico escreve em "quem".
  PERFORM set_config('winecatalog.quem',
    COALESCE(NULLIF(btrim(COALESCE(p_quem, '')), ''), 'painel do PC (admin)'), true);
  RETURN winecatalog.editar(p_id, COALESCE(p_campos, '{}'::jsonb), p_nome, p_produtor, p_ano,
                            COALESCE(p_mexer_identidade, false));
END;
$$;

-- Cada função nova nasce com EXECUTE para PUBLIC; tira-se sempre.
REVOKE ALL ON FUNCTION winecatalog.painel_vinho(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION winecatalog.painel_editar(bigint, jsonb, text, text, integer, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION winecatalog.painel_vinho(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION winecatalog.painel_editar(bigint, jsonb, text, text, integer, boolean, text) TO service_role;

-- Confirmar (deve dar só postgres e service_role):
-- SELECT p.proname, r.rolname FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
--   JOIN pg_roles r ON r.oid = a.grantee
--  WHERE n.nspname = 'winecatalog' AND p.proname LIKE 'painel%';
