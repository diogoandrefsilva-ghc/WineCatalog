-- =====================================================================
-- CATÁLOGO — filtros e facetas para o ecrã do Catálogo
--
-- Corre DEPOIS de db/catalogo.sql. Substitui duas funções que já lá estão:
--
--   · `resumo_linha`  — passa a devolver também `imagem` (a fotografia do
--     vinho, que a lista agora mostra). Tudo o resto fica igual.
--
--   · `listar`        — ganha quatro filtros (tipo, região, castas, faixa
--     de preço) e devolve, no mesmo pedido, as CONTAGENS por opção
--     (`facetas`) que os cartões do ecrã mostram.
--
-- Porque é que os filtros são do SQL e não do browser: a lista é paginada
-- (50 de cada vez). Filtrar do lado do cliente filtrava só a página que
-- por acaso já tinha vindo — "3 tintos do Douro" quando havia trinta.
--
-- Porque é que as contagens vêm com os OUTROS grupos aplicados mas não o
-- próprio: é o que faz "Branco 7" continuar visível depois de se escolher
-- Tinto. Um filtro que só conta o que já está filtrado por ele mesmo
-- mostra sempre o total escolhido, e não serve para nada.
-- =====================================================================

-- O preço como número, ou NULL. A ficha é jsonb e um dia tem lá "34,90"
-- escrito à mão: um cast directo rebentava a lista inteira por causa de
-- uma linha.
CREATE OR REPLACE FUNCTION winecatalog.preco_num(f jsonb)
  RETURNS numeric LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN jsonb_typeof(f -> 'preco_medio') = 'number'
              THEN (f ->> 'preco_medio')::numeric END;
$$;

-- As faixas de preço vivem AQUI e não no browser: são o que a `listar`
-- conta e o que ela filtra, e duas listas destas divergem no dia em que
-- alguém mexe numa só.
CREATE OR REPLACE FUNCTION winecatalog.faixa_preco(p numeric)
  RETURNS text LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
           WHEN p IS NULL THEN NULL
           WHEN p <  15 THEN '<15'
           WHEN p <  30 THEN '15-30'
           WHEN p <  60 THEN '30-60'
           ELSE '60+'
         END;
$$;

CREATE OR REPLACE FUNCTION winecatalog.resumo_linha(r winecatalog.vinhos)
  RETURNS jsonb LANGUAGE sql STABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT jsonb_build_object(
    'id',       r.id,
    'chave',    r.chave,
    'nome',     r.nome,
    'produtor', r.produtor,
    'ano',      r.ano,
    'tipo',     r.ficha ->> 'tipo',
    'regiao',   COALESCE(r.ficha ->> 'regiao', r.ficha ->> 'pais'),
    'castas',   r.ficha -> 'castas',
    'nota',     r.ficha -> 'vivino_nota',
    'preco',    r.ficha -> 'preco_medio',
    -- A fotografia do vinho. A lista desenha a garrafa quando isto vem
    -- vazio, por isso é seguro estar em falta — o que não pode é obrigar
    -- o ecrã a abrir a ficha inteira só para saber se existe.
    'imagem',   r.ficha ->> 'imagem_url',
    'campos',   (SELECT count(*) FROM jsonb_object_keys(r.ficha)),
    'forca',    (SELECT COALESCE(max((o.value ->> 'f')::integer), 0)
                   FROM jsonb_each(r.origens) o),
    'fontes',   jsonb_array_length(COALESCE(r.fontes, '[]'::jsonb)),
    'vezes',    r.vezes,
    'vistoEm',      r.visto_em,
    'atualizadoEm', r.atualizado_em
  );
$$;

-- A assinatura muda (quatro parâmetros novos), por isso a antiga sai —
-- senão ficavam as duas e o PostgREST escolhia a que lhe desse jeito.
DROP FUNCTION IF EXISTS winecatalog.listar(text, integer, integer);

CREATE OR REPLACE FUNCTION winecatalog.listar(
  p_procura text    DEFAULT NULL,
  p_limite  integer DEFAULT 50,
  p_saltar  integer DEFAULT 0,
  p_tipos   text[]  DEFAULT NULL,
  p_regioes text[]  DEFAULT NULL,
  p_castas  text[]  DEFAULT NULL,
  p_precos  text[]  DEFAULT NULL   -- ids das faixas: '<15','15-30','30-60','60+'
) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_q    text    := lower(trim(COALESCE(p_procura, '')));
  v_toks text[]  := CASE WHEN v_q = '' THEN ARRAY[]::text[] ELSE winecatalog.tokens(v_q) END;
  v_lim  integer := LEAST(GREATEST(COALESCE(p_limite, 50), 1), 200);
  v_off  integer := GREATEST(COALESCE(p_saltar, 0), 0);
  v_res  jsonb;
BEGIN
  IF NOT winecatalog.pode_ler() THEN
    RAISE EXCEPTION 'Sem acesso ao catálogo.';
  END IF;

  WITH achados AS (
    SELECT v.*
      FROM winecatalog.vinhos v
     WHERE NOT EXISTS (SELECT 1 FROM winecatalog.alias a WHERE a.id_de = v.id)
       AND (
         v_q = ''
         OR v.nome     ILIKE '%' || v_q || '%'
         OR v.produtor ILIKE '%' || v_q || '%'
         OR COALESCE(v.ficha ->> 'regiao', '')     ILIKE '%' || v_q || '%'
         OR COALESCE(v.ficha ->> 'sub_regiao', '') ILIKE '%' || v_q || '%'
         OR EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(
                             CASE WHEN jsonb_typeof(v.ficha -> 'castas') = 'array'
                                  THEN v.ficha -> 'castas' ELSE '[]'::jsonb END) c
               WHERE c ILIKE '%' || v_q || '%')
         OR (cardinality(v_toks) > 0
             AND string_to_array(v.chave_base, '-') @> v_toks)
       )
  ),
  -- Cada linha sabe quais dos quatro filtros passa. É isto que permite
  -- contar um grupo "como se ele não estivesse escolhido" sem repetir a
  -- procura quatro vezes.
  marcados AS (
    SELECT a.*,
      (p_tipos IS NULL OR cardinality(p_tipos) = 0
        OR (a.ficha ->> 'tipo') = ANY(p_tipos))                                   AS ok_tipo,
      (p_regioes IS NULL OR cardinality(p_regioes) = 0
        OR COALESCE(a.ficha ->> 'regiao', a.ficha ->> 'pais') = ANY(p_regioes))   AS ok_regiao,
      (p_castas IS NULL OR cardinality(p_castas) = 0
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                     CASE WHEN jsonb_typeof(a.ficha -> 'castas') = 'array'
                          THEN a.ficha -> 'castas' ELSE '[]'::jsonb END) c
                    WHERE c = ANY(p_castas)))                                     AS ok_casta,
      (p_precos IS NULL OR cardinality(p_precos) = 0
        OR winecatalog.faixa_preco(winecatalog.preco_num(a.ficha)) = ANY(p_precos)) AS ok_preco
      FROM achados a
  ),
  filtrados AS (
    SELECT * FROM marcados WHERE ok_tipo AND ok_regiao AND ok_casta AND ok_preco
  ),
  pagina AS (
    SELECT f.* FROM filtrados f
     ORDER BY f.visto_em DESC, f.id DESC
     OFFSET v_off LIMIT v_lim
  ),
  f_tipo AS (
    SELECT m.ficha ->> 'tipo' AS v, count(*) AS n
      FROM marcados m
     WHERE m.ok_regiao AND m.ok_casta AND m.ok_preco AND m.ficha ->> 'tipo' IS NOT NULL
     GROUP BY 1
  ),
  f_regiao AS (
    SELECT COALESCE(m.ficha ->> 'regiao', m.ficha ->> 'pais') AS v, count(*) AS n
      FROM marcados m
     WHERE m.ok_tipo AND m.ok_casta AND m.ok_preco
       AND COALESCE(m.ficha ->> 'regiao', m.ficha ->> 'pais') IS NOT NULL
     GROUP BY 1
  ),
  f_casta AS (
    SELECT c AS v, count(*) AS n
      FROM marcados m,
           LATERAL jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(m.ficha -> 'castas') = 'array'
                  THEN m.ficha -> 'castas' ELSE '[]'::jsonb END) c
     WHERE m.ok_tipo AND m.ok_regiao AND m.ok_preco
     GROUP BY 1
  ),
  f_preco AS (
    SELECT winecatalog.faixa_preco(winecatalog.preco_num(m.ficha)) AS v, count(*) AS n
      FROM marcados m
     WHERE m.ok_tipo AND m.ok_regiao AND m.ok_casta
       AND winecatalog.faixa_preco(winecatalog.preco_num(m.ficha)) IS NOT NULL
     GROUP BY 1
  )
  SELECT jsonb_build_object(
           'total',  (SELECT count(*) FROM filtrados),
           'linhas', COALESCE((SELECT jsonb_agg(winecatalog.resumo_linha(p.*)
                                        ORDER BY p.visto_em DESC, p.id DESC)
                                 FROM pagina p), '[]'::jsonb),
           'facetas', jsonb_build_object(
             -- Região e castas são listas abertas: mostram-se as mais
             -- cheias, e o ecrã acrescenta as que já estão escolhidas
             -- (senão não havia como as desmarcar).
             'tipos',   COALESCE((SELECT jsonb_agg(x) FROM (
                          SELECT jsonb_build_object('v', v, 'n', n) AS x
                            FROM f_tipo ORDER BY n DESC, v) s), '[]'::jsonb),
             'regioes', COALESCE((SELECT jsonb_agg(x) FROM (
                          SELECT jsonb_build_object('v', v, 'n', n) AS x
                            FROM f_regiao ORDER BY n DESC, v LIMIT 12) s), '[]'::jsonb),
             'castas',  COALESCE((SELECT jsonb_agg(x) FROM (
                          SELECT jsonb_build_object('v', v, 'n', n) AS x
                            FROM f_casta ORDER BY n DESC, v LIMIT 12) s), '[]'::jsonb),
             'precos',  COALESCE((SELECT jsonb_agg(x) FROM (
                          SELECT jsonb_build_object('v', v, 'n', n) AS x
                            FROM f_preco ORDER BY v) s), '[]'::jsonb)
           )
         )
    INTO v_res;

  RETURN v_res;
END;
$$;

-- Os REVOKEs/GRANTs seguem a mesma disciplina do catalogo.sql: cada
-- função nova nasce com EXECUTE para PUBLIC e tem de ser fechada à mão.
REVOKE ALL ON FUNCTION winecatalog.listar(text, integer, integer, text[], text[], text[], text[])
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION winecatalog.resumo_linha(winecatalog.vinhos) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION winecatalog.preco_num(jsonb)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION winecatalog.faixa_preco(numeric) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION winecatalog.listar(text, integer, integer, text[], text[], text[], text[])
  TO authenticated;
