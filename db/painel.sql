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

-- ---------------------------------------------------------------------
-- QUEM criou e QUEM alterou (27/09/2026, o dono: "dava-me jeito ver quem
-- criou cada vinho e quem atualizou pela última vez"). O histórico
-- (`alteracoes.quem`) diz um processo ("script no PC…", "nomes:
-- normalização"), o email do admin, ou uma de duas coisas que não dizem
-- QUEM: "Edge Function (service_role)" (uma pesquisa com IA de uma das
-- apps — a Edge Function escreve com a service_role, sem email) e "uma
-- garrafeira" (o trigger de lá — sem email de propósito, invariante 2).
--
-- O catálogo continua sem guardar quem é quem. É AQUI, só no painel do PC
-- (service_role — a mesma exceção de "Links do Vivino nas garrafeiras", onde
-- o admin já vê a garrafeira e o dono), que se vai ver aos registos das
-- apps quem foi, pela hora:
--   · Edge Function → o `sync_log` da app que chamou (pela origem: vinho-info
--     é a Garrafeira, ws-* a WineSelection, catalogo-* esta), a linha da
--     função mais perto dessa hora (de 5 s antes a 90 s depois — a função
--     regista depois de escrever no catálogo);
--   · uma garrafeira → o vinho da garrafeira gravado nesse instante (±20 s):
--     criado → quem o criou; alterado → a garrafeira (a de lá não guarda
--     quem alterou, só quem criou);
--   · sem histórico (antes de 25/09/2026) → as duas coisas, pela hora da
--     criação.
-- É um cruzamento pela hora, não um registo: duas pessoas a pesquisar no
-- mesmo minuto podem trocar-se. O ecrã diz isto.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.painel_autor(
  p_quem text, p_origem text, p_quando timestamptz, p_ano integer DEFAULT NULL)
  RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  q text := NULLIF(btrim(COALESCE(p_quem, '')), '');
  o text := COALESCE(p_origem, '');
  r text;
  g record;
BEGIN
  IF q IS NOT NULL AND q NOT IN ('Edge Function (service_role)', 'uma garrafeira') THEN
    RETURN q;
  END IF;
  IF p_quando IS NULL THEN RETURN q; END IF;

  IF q IS DISTINCT FROM 'uma garrafeira' THEN
    IF o ~ '^catalogo' OR q IS NULL THEN
      SELECT s.quem INTO r FROM winecatalog.sync_log s
       WHERE s.origem = 'function' AND COALESCE(s.quem, '') <> ''
         AND s.criado_em BETWEEN p_quando - interval '5 seconds' AND p_quando + interval '90 seconds'
       ORDER BY abs(extract(epoch FROM s.criado_em - p_quando)) LIMIT 1;
      IF r IS NOT NULL THEN RETURN r || ' · WineCatalog'; END IF;
    END IF;
    IF (o ~ '^ws-' OR q IS NULL) AND to_regclass('wineselection.sync_log') IS NOT NULL THEN
      SELECT s.quem INTO r FROM wineselection.sync_log s
       WHERE COALESCE(s.quem, '') <> ''
         AND s.criado_em BETWEEN p_quando - interval '5 seconds' AND p_quando + interval '90 seconds'
       ORDER BY abs(extract(epoch FROM s.criado_em - p_quando)) LIMIT 1;
      IF r IS NOT NULL THEN RETURN r || ' · WineSelection'; END IF;
    END IF;
    IF o !~ '^(catalogo|ws-)' AND to_regclass('garrafeira.sync_log') IS NOT NULL THEN
      SELECT s.quem INTO r FROM garrafeira.sync_log s
       WHERE s.origem = 'function' AND s.acao IN ('vinho-info', 'importar-vinhos')
         AND COALESCE(s.quem, '') <> ''
         AND s.criado_em BETWEEN p_quando - interval '5 seconds' AND p_quando + interval '90 seconds'
       ORDER BY abs(extract(epoch FROM s.criado_em - p_quando)) LIMIT 1;
      IF r IS NOT NULL THEN RETURN r || ' · Garrafeira'; END IF;
    END IF;
  END IF;

  IF (q IS NULL OR q = 'uma garrafeira') AND to_regclass('garrafeira.vinhos') IS NOT NULL THEN
    SELECT gv.criado_por, gv.criado_em, gv.atualizado_em, ga.nome AS garrafeira INTO g
      FROM garrafeira.vinhos gv
      LEFT JOIN garrafeira.garrafeiras ga ON ga.id = gv.garrafeira_id
     WHERE (p_ano IS NULL OR gv.ano IS NOT DISTINCT FROM p_ano)
       AND (gv.criado_em BETWEEN p_quando - interval '20 seconds' AND p_quando + interval '20 seconds'
            OR gv.atualizado_em BETWEEN p_quando - interval '20 seconds' AND p_quando + interval '20 seconds')
     ORDER BY LEAST(abs(extract(epoch FROM gv.criado_em - p_quando)),
                    abs(extract(epoch FROM COALESCE(gv.atualizado_em, gv.criado_em) - p_quando)))
     LIMIT 1;
    IF FOUND THEN
      IF abs(extract(epoch FROM g.criado_em - p_quando)) <= 20 AND COALESCE(g.criado_por, '') <> '' THEN
        RETURN g.criado_por || ' · Garrafeira';
      END IF;
      IF COALESCE(g.garrafeira, '') <> '' THEN RETURN g.garrafeira; END IF;
    END IF;
  END IF;
  RETURN q;
END;
$$;

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
    -- quem o criou e quem mexeu por último (a `painel_autor`, acima)
    'criado_por', COALESCE(
      (SELECT winecatalog.painel_autor(h.quem, h.origem, h.quando, r.ano) FROM winecatalog.alteracoes h
        WHERE h.vinho_id = r.id AND h.campo = '_criado' ORDER BY h.quando LIMIT 1),
      winecatalog.painel_autor(NULL, NULL, r.criado_em, r.ano), 'antes do histórico'),
    'alterado_por', (SELECT winecatalog.painel_autor(h.quem, h.origem, h.quando, r.ano) FROM winecatalog.alteracoes h
                      WHERE h.vinho_id = r.id AND h.campo <> '_criado' ORDER BY h.quando DESC, h.id DESC LIMIT 1),
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
    -- primeiro. O "quem" gravado é o da `quem_escreve` (nunca o email de
    -- quem não é o admin, invariante 2); o `autor` é o que a `painel_autor`
    -- descobre pela hora, só aqui no painel.
    'historico', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('campo', a.campo, 'antes', a.antes, 'depois', a.depois,
                                          'origem', a.origem, 'quem', a.quem, 'quando', a.quando,
                                          'autor', winecatalog.painel_autor(a.quem, a.origem, a.quando, r.ano))
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

-- ---------------------------------------------------------------------
-- A PESQUISA COM IA NO PAINEL (29/09/2026, o dono das apps: "manter o que
-- existe e chamar-lhe «Pesquisa sem IA às lojas principais e Vivino», e um
-- segundo tipo, «Pesquisa com IA», com até 5 sites por vinho, só nesses
-- sites ou a completar com a pesquisa do Gemini"). Não é um caminho novo: o
-- painel cria a pesquisa (`pesquisa_criar`), chama a MESMA Edge Function
-- `catalogo-info` da app (que o aceita pelo papel do token) e grava pela
-- MESMA `pesquisa_aplicar` — os valores vêm da linha da pesquisa, nunca do
-- browser, e o que o admin não marcar não entra. Duas portas pequenas:
--   · `painel_pesquisas_por_rever` — as pesquisas por rever, a última de
--     cada vinho (a regra da `pesquisa_por_rever` da ficha: concluída, com
--     propostas, por guardar, até 7 dias), com o vinho de agora ao lado;
--   · `painel_pesquisa_aplicar` — a `pesquisa_aplicar` com o "quem" do
--     histórico posto. `p_campos` vazio descarta, como na app.
-- Uma pesquisa feita no painel também aparece "por rever" na ficha da app
-- (fica em nome do admin), e vice-versa: é a mesma linha.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.painel_pesquisas_por_rever()
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Só o painel do PC (service_role) chama isto.';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id', u.id, 'vinhoId', u.vinho_id, 'fechadoEm', u.fechado_em,
             'nome', v.nome, 'produtor', v.produtor, 'ano', v.ano, 'cor', v.cor,
             'resultado', u.resultado)
           ORDER BY u.fechado_em DESC)
      FROM (SELECT DISTINCT ON (p.vinho_id) p.*
              FROM winecatalog.pesquisas p
             ORDER BY p.vinho_id, p.criado_em DESC) u
      JOIN winecatalog.vinhos v ON v.id = u.vinho_id
     WHERE u.estado = 'concluido'
       AND u.resultado ->> 'rever' = 'true'
       AND NOT u.resultado ? 'aplicadoEm'
       AND jsonb_array_length(COALESCE(u.resultado -> 'propostas', '[]'::jsonb)) > 0
       AND u.fechado_em > now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM winecatalog.alias a WHERE a.id_de = u.vinho_id)
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION winecatalog.painel_pesquisa_aplicar(
  p_id bigint, p_campos text[], p_quem text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Só o painel do PC (service_role) chama isto.';
  END IF;
  PERFORM set_config('winecatalog.quem',
    COALESCE(NULLIF(btrim(COALESCE(p_quem, '')), ''), 'painel do PC (admin)'), true);
  RETURN winecatalog.pesquisa_aplicar(p_id, COALESCE(p_campos, '{}'::text[]));
END;
$$;

-- Cada função nova nasce com EXECUTE para PUBLIC; tira-se sempre.
REVOKE ALL ON FUNCTION winecatalog.painel_autor(text, text, timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION winecatalog.painel_vinho(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION winecatalog.painel_editar(bigint, jsonb, text, text, integer, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION winecatalog.painel_autor(text, text, timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION winecatalog.painel_vinho(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION winecatalog.painel_editar(bigint, jsonb, text, text, integer, boolean, text) TO service_role;
REVOKE ALL ON FUNCTION winecatalog.painel_pesquisas_por_rever() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION winecatalog.painel_pesquisa_aplicar(bigint, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION winecatalog.painel_pesquisas_por_rever() TO service_role;
GRANT EXECUTE ON FUNCTION winecatalog.painel_pesquisa_aplicar(bigint, text[], text) TO service_role;

-- Confirmar (deve dar só postgres e service_role):
-- SELECT p.proname, r.rolname FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
--   JOIN pg_roles r ON r.oid = a.grantee
--  WHERE n.nspname = 'winecatalog' AND p.proname LIKE 'painel%';
