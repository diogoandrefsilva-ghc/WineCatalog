-- =====================================================================
-- WineCatalog — "ESTE VINHO É AQUELE" (27/09/2026, o dono das apps)
--
-- Correr DEPOIS de db/painel.sql (e, antes disso, de catalogo.sql,
-- cor-na-chave.sql e historico.sql). Idempotente.
--
-- O CASO. Alguém escreveu "Cristo vinhas velhas" na Garrafeira e pediu a
-- pesquisa com IA; a `vinho-info` gravou no catálogo com o nome tal como foi
-- escrito (#216), e o vinho — que era da lista de desejos, e essa não vai ao
-- catálogo — ficou "Crasto Vinhas Velhas" só na garrafeira. O #216 ficou
-- órfão: uma letra trocada, sem produtor, e nenhuma ferramenta o apanhava.
-- Os Duplicados (`candidatos`) só propõem pares da MESMA colheita e com
-- palavras IGUAIS no nome — "cristo" e "crasto" não são iguais, e 2023 não é
-- 2022.
--
-- DUAS PEÇAS:
--
-- 1. `parecidos` — os alertas. Uma palavra do nome (ou do produtor) que está
--    a UMA letra de outra (uma trocada, a mais ou a menos, duas vizinhas
--    trocadas) ou que é o princípio dela com 2–3 letras a menos ("Harvest" /
--    "Harvested", o caso do Grous); a mais RARA das duas é a suspeita (o
--    erro é o que só aparece uma vez). Um par só é proposto se TODAS as
--    palavras distintivas do suspeito estiverem no outro, iguais ou a uma
--    letra — "Quinta da Gaivosa" (Domingos Alves de Sousa) não é par de
--    "Caves Primavera" por "alves"/"caves". Palavras de 5 letras ou mais,
--    sem as genéricas (a `generico` dos Duplicados). Cores diferentes nunca.
--    Qualquer colheita: é isso que falta aos Duplicados. Medido no catálogo
--    real (27/09/2026): 16 pares de palavras, e com a regra da cobertura
--    ficam o Cristo × os quatro Crasto e o Carvalhais × Carvalhas (que são
--    mesmo vinhos diferentes — o "não são" fica gravado). Devolve também os
--    `candidatos` dos Duplicados (mesma colheita), para o painel ter os dois.
--
-- 2. `corresponde(p_id, p_alvo)` — "este vinho (p_id) é aquele (p_alvo)". A
--    identidade certa é a do alvo; a colheita é a de cada um:
--      · a MESMA colheita (ou a do alvo em falta dos dois lados) → funde-se
--        (`fundir`, reversível — em Duplicados › Fusões, na app), e o nome
--        que fica é o do alvo, mesmo que o outro seja mais comprido;
--      · OUTRA colheita → este passa a ser essa colheita do vinho do alvo:
--        o nome, o produtor e a cor do alvo, o ano dele (`editar` com o
--        interruptor da identidade) — e se essa colheita desse vinho já
--        existir noutra linha, funde-se nela.
--    Nunca se fundem colheitas diferentes (a trave da `fundir` fica).
--    Uma coisa que isto não resolve: depois de mudado o nome, a grafia
--    errada deixa de estar no catálogo — se alguém voltar a escrever
--    "Cristo vinhas velhas", nasce outra linha. Na fusão não: a perdedora
--    guarda a chave, e a `achar` responde com a alvo.
--
-- QUEM. O admin (pela app, um dia) ou a `service_role` (o painel do PC). A
-- `fundir`, a `marcar_distintos` e a `candidatos` passaram a aceitar a
-- `service_role` (catalogo.sql, cor-na-chave.sql), como a `editar`.
-- =====================================================================

CREATE OR REPLACE FUNCTION winecatalog.parecidos(p_limite integer DEFAULT 80)
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_lim   integer := LEAST(GREATEST(COALESCE(p_limite, 80), 1), 300);
  v_letra jsonb;
BEGIN
  IF NOT (winecatalog.sou_admin() OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;

  -- Tudo MATERIALIZED, calculado uma vez: a lição da `achar` (nada de
  -- `tokens()` por linha e por par).
  WITH linhas AS MATERIALIZED (
    SELECT v.id, v.chave, v.cor, v.ano,
           ARRAY(SELECT t FROM unnest(winecatalog.tokens_id(
                   COALESCE(v.nome, '') || ' ' ||
                   regexp_replace(COALESCE(winecatalog.produtor_oficial(v.produtor), ''), '\s*\([^)]*\)', ' ', 'g'))) t
                  WHERE NOT winecatalog.generico(t)) AS toks
      FROM winecatalog.vinhos v
     WHERE NOT EXISTS (SELECT 1 FROM winecatalog.alias a WHERE a.id_de = v.id)
  ), tk AS MATERIALIZED (
    SELECT DISTINCT l.id, t FROM linhas l, unnest(l.toks) t
     WHERE length(t) >= 5 AND t !~ '^[0-9]+$'
  ), freq AS MATERIALIZED (
    SELECT t, count(*) AS n FROM tk GROUP BY t
  ), del AS MATERIALIZED (
    -- Cada palavra e ela sem uma das letras: duas palavras a uma letra uma
    -- da outra partilham uma destas (trocada, a mais, a menos, vizinhas).
    SELECT t, t AS d FROM freq
    UNION ALL
    SELECT f.t, left(f.t, i - 1) || substr(f.t, i + 1) FROM freq f, generate_series(1, length(f.t)) i
  ), perto AS MATERIALIZED (
    SELECT DISTINCT a.t AS ta, b.t AS tb FROM del a JOIN del b ON a.d = b.d AND a.t <> b.t
    UNION
    SELECT a.t, b.t FROM freq a JOIN freq b ON a.t <> b.t
       AND (b.t LIKE a.t || '%' OR a.t LIKE b.t || '%')
       AND abs(length(a.t) - length(b.t)) BETWEEN 2 AND 3
  ), pares AS (
    SELECT a.id AS id_a, b.id AS id_b,
           jsonb_agg(DISTINCT jsonb_build_object('de', p.ta, 'para', p.tb)) AS palavras
      FROM perto p
      JOIN freq fa ON fa.t = p.ta
      JOIN freq fb ON fb.t = p.tb
      JOIN tk ka ON ka.t = p.ta
      JOIN tk kb ON kb.t = p.tb
      JOIN linhas a ON a.id = ka.id
      JOIN linhas b ON b.id = kb.id
     WHERE a.id <> b.id
       AND (a.cor IS NULL OR b.cor IS NULL OR a.cor = b.cor)
       AND NOT (p.tb = ANY (a.toks)) AND NOT (p.ta = ANY (b.toks))
       -- o suspeito é o da palavra mais rara; em empate, o mais recente
       AND (fa.n < fb.n OR (fa.n = fb.n AND a.id > b.id))
     GROUP BY a.id, b.id
  ), cobertos AS (
    SELECT pr.id_a, pr.id_b, pr.palavras
      FROM pares pr
      JOIN linhas a ON a.id = pr.id_a
      JOIN linhas b ON b.id = pr.id_b
     WHERE NOT EXISTS (
             SELECT 1 FROM unnest(a.toks) t
              WHERE NOT (t = ANY (b.toks))
                AND NOT EXISTS (SELECT 1 FROM perto p WHERE p.ta = t AND p.tb = ANY (b.toks)))
       AND NOT EXISTS (
             SELECT 1 FROM winecatalog.distintos d
              WHERE d.chave_a = LEAST(a.chave, b.chave) AND d.chave_b = GREATEST(a.chave, b.chave))
  ), grupos AS (
    SELECT c.id_a,
           jsonb_agg(winecatalog.resumo_linha(vb) || jsonb_build_object(
                       'palavras', c.palavras,
                       'mesma_colheita', vb.ano IS NOT DISTINCT FROM va.ano,
                       'criado', vb.criado_em)
                     ORDER BY (vb.ano IS NOT DISTINCT FROM va.ano) DESC,
                              (SELECT count(*) FROM jsonb_object_keys(vb.ficha)) DESC, vb.id) AS candidatos
      FROM cobertos c
      JOIN winecatalog.vinhos va ON va.id = c.id_a
      JOIN winecatalog.vinhos vb ON vb.id = c.id_b
     GROUP BY c.id_a
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'vinho', winecatalog.resumo_linha(va) || jsonb_build_object('criado', va.criado_em),
           'candidatos', g.candidatos)
         ORDER BY va.criado_em DESC, va.id DESC), '[]'::jsonb)
    INTO v_letra
    FROM (SELECT * FROM grupos LIMIT v_lim) g
    JOIN winecatalog.vinhos va ON va.id = g.id_a;

  RETURN jsonb_build_object(
    'letra', v_letra,
    'colheita', winecatalog.candidatos(v_lim));
END;
$$;

-- ---------------------------------------------------------------------
-- "Este vinho (p_id) é aquele (p_alvo)." Ver o cabeçalho.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.corresponde(p_id bigint, p_alvo bigint, p_quem text DEFAULT NULL)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  de     winecatalog.vinhos%ROWTYPE;
  alvo   winecatalog.vinhos%ROWTYPE;
  v_idt  jsonb;
  v_para bigint;
  v_tipo text;
  v_res  jsonb;
BEGIN
  IF NOT (winecatalog.sou_admin() OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  IF p_id IS NULL OR p_alvo IS NULL OR p_id = p_alvo THEN
    RAISE EXCEPTION 'Par inválido.';
  END IF;
  SELECT * INTO de FROM winecatalog.vinhos WHERE id = p_id;
  -- um alvo fundido responde pelo vinho que ficou
  SELECT * INTO alvo FROM winecatalog.vinhos
   WHERE id = COALESCE((SELECT id_para FROM winecatalog.alias WHERE id_de = p_alvo), p_alvo);
  IF de.id IS NULL OR alvo.id IS NULL THEN RAISE EXCEPTION 'Linha não encontrada.'; END IF;
  IF de.id = alvo.id THEN RAISE EXCEPTION 'Já são o mesmo vinho.'; END IF;
  IF EXISTS (SELECT 1 FROM winecatalog.alias WHERE id_de = de.id) THEN
    RAISE EXCEPTION 'Essa linha já foi fundida noutra.';
  END IF;
  IF de.cor IS NOT NULL AND alvo.cor IS NOT NULL AND de.cor <> alvo.cor THEN
    RAISE EXCEPTION 'As cores são diferentes (% e %) — é outro vinho.', de.cor, alvo.cor;
  END IF;

  IF NULLIF(btrim(COALESCE(p_quem, '')), '') IS NOT NULL THEN
    PERFORM set_config('winecatalog.quem', btrim(p_quem), true);
  END IF;

  -- A identidade que este passa a ter: a do alvo, com a SUA colheita.
  v_tipo := COALESCE(NULLIF(alvo.ficha ->> 'tipo', ''), de.ficha ->> 'tipo');
  v_idt  := winecatalog.identidade(alvo.nome, alvo.produtor, de.ano, v_tipo, true);

  IF alvo.ano IS NOT DISTINCT FROM de.ano THEN
    v_para := alvo.id;
  ELSE
    -- essa colheita desse vinho já existe? (viva, ou fundida noutra)
    SELECT v.id INTO v_para FROM winecatalog.vinhos v
     WHERE v.chave = v_idt ->> 'chave' AND v.id <> de.id LIMIT 1;
    IF v_para IS NOT NULL THEN
      v_para := COALESCE((SELECT id_para FROM winecatalog.alias WHERE id_de = v_para), v_para);
      IF v_para = de.id THEN RAISE EXCEPTION 'Já são o mesmo vinho.'; END IF;
    END IF;
  END IF;

  IF v_para IS NOT NULL THEN
    PERFORM set_config('winecatalog.manter_nome', 'sim', true);
    v_res := winecatalog.fundir(de.id, v_para);
    PERFORM set_config('winecatalog.manter_nome', '', true);
    RETURN jsonb_build_object('ok', true, 'acao', 'fundido', 'id', v_para,
                              'campos', v_res -> 'campos');
  END IF;

  -- Outra colheita do mesmo vinho, que ainda não existe: este passa a sê-la.
  v_res := winecatalog.editar(
    de.id,
    CASE WHEN v_tipo IS NOT NULL AND v_tipo IS DISTINCT FROM (de.ficha ->> 'tipo')
         THEN jsonb_build_object('tipo', v_tipo) ELSE '{}'::jsonb END,
    alvo.nome, COALESCE(alvo.produtor, ''), de.ano, true);
  RETURN jsonb_build_object('ok', true, 'acao', 'identidade', 'id', de.id,
    'nome', (SELECT nome FROM winecatalog.vinhos WHERE id = de.id),
    'produtor', (SELECT produtor FROM winecatalog.vinhos WHERE id = de.id),
    'ano', de.ano);
END;
$$;

-- "Nenhum destes": o par (ou os pares) não volta a ser proposto — nem aqui
-- nem nos Duplicados da app (a mesma `distintos`, desfaz-se lá).
CREATE OR REPLACE FUNCTION winecatalog.nao_correspondem(p_id bigint, p_outros bigint[], p_quem text DEFAULT NULL)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  o bigint;
  n integer := 0;
BEGIN
  IF NOT (winecatalog.sou_admin() OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  IF NULLIF(btrim(COALESCE(p_quem, '')), '') IS NOT NULL THEN
    PERFORM set_config('winecatalog.quem', btrim(p_quem), true);
  END IF;
  FOREACH o IN ARRAY COALESCE(p_outros, ARRAY[]::bigint[]) LOOP
    CONTINUE WHEN o IS NULL OR o = p_id;
    PERFORM winecatalog.marcar_distintos(p_id, o);
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'pares', n);
END;
$$;

-- Cada função nova nasce com EXECUTE para PUBLIC; tira-se sempre.
REVOKE ALL ON FUNCTION winecatalog.parecidos(integer)                  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION winecatalog.corresponde(bigint, bigint, text)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION winecatalog.nao_correspondem(bigint, bigint[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.parecidos(integer)                TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION winecatalog.corresponde(bigint, bigint, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION winecatalog.nao_correspondem(bigint, bigint[], text) TO authenticated, service_role;
