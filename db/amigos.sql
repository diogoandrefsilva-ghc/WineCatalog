-- =====================================================================
-- WineCatalog — AS MARCAS DOS AMIGOS (25/09/2026)
--
-- A WineSelection pergunta, para cada vinho de uma carta:
--   🍾 está na garrafeira de algum amigo?
--   ⭐ algum amigo já o bebeu e o classificou?
--   💭 está na wishlist de algum amigo?
--   🎁 já o oferecemos a algum amigo nas prendas de anos?
--
-- Corre DEPOIS do `catalogo.sql` (usa a `chave_base`, a `base_nome`, a
-- `achar` e a `alias`), e precisa dos schemas `garrafeira` e
-- `anniversarygifts` já criados.
--
-- ── QUEM SÃO "OS AMIGOS" — e a exceção consciente à invariante 2 ──
-- Os amigos são o grupo das Prendas de Anos (`anniversarygifts.amigos`,
-- ativos e com email). É um grupo FECHADO e as marcas só existem lá
-- dentro:
--   · só quem está nesse grupo recebe marcas — para qualquer outra sessão
--     esta função devolve NULL (e a app não mostra nada);
--   · só contam as garrafeiras cujo DONO está no grupo.
-- Isto abre, dentro do grupo, o que cada um tem em casa — o que a
-- invariante 2 deste repo ("isto não abre garrafeira nenhuma") e o "cada
-- um vê a sua garrafeira" da Garrafeira proíbem. É uma decisão do dono
-- das apps (25/09/2026), e fica estreita de propósito: não se vê a LINHA
-- de ninguém (nem notas, nem preço, nem local, nem fotografia) — só o
-- nome do amigo e, conforme a marca, quantas garrafas, a colheita, a nota
-- que ele deu, e a data. Alargar isto a quem não está no grupo é outra
-- decisão, não uma linha a mais aqui.
--
-- ── A SURPRESA DAS PRENDAS ──
-- Quem faz anos não vê a garrafa antes de ela ser `entregue` (regra da
-- AnniversaryGifts, que lá é do SERVIDOR). Aqui também: uma prenda por
-- entregar nunca aparece a quem a vai receber.
--
-- ── O QUE É "O MESMO VINHO" ──
-- A regra de identidade é a do catálogo, a do `achar` sem ano: cada lado
-- tem as suas chaves de vinho (`chave_base` = nome+produtor, `base_nome`
-- = só o nome, quando o nome distingue alguma coisa) e casam se QUALQUER
-- uma bater com QUALQUER uma — é o que faz o "Crasto Reserva" de uma
-- carta encontrar o "Reserva" + "Quinta do Crasto" de uma garrafeira.
-- Não se exige a colheita: "o Barrona tem este vinho" continua a ser
-- verdade se ele tiver o 2018 e a carta o 2020; a marca diz qual é.
-- Do lado da carta juntam-se ainda as chaves da linha do catálogo que ela
-- achou e das linhas FUNDIDAS nela (`alias`), para que uma grafia que os
-- Duplicados já resolveram ("Moon Harvest"/"Moon Harvested") também case
-- aqui. Nenhuma chave é calculada fora do SQL — invariante 8.
-- Como no catálogo, a cor ainda não entra na chave (ver "A mudança da cor
-- na chave" no CLAUDE.md): o dia em que entrar lá, entra aqui sozinha.
-- =====================================================================

-- `p_pedidos`: [{nome, produtor, ano}] — a mesma forma do `procurar_lote`.
-- Devolve um array na MESMA ordem, com `null` onde não há marca nenhuma:
--   { garrafeiras: [{amigo, eu, garrafas, anos}],
--     bebidos:     [{amigo, eu, nota, vezes, ultima}],
--     wishlist:    [{amigo, eu}],
--     prendas:     [{para, de, paraMim, deMim, ano, entregue}] }
-- `eu`/`paraMim`/`deMim`: é a própria pessoa que pergunta ("está na TUA
-- garrafeira", "ofereceram-TO").
CREATE OR REPLACE FUNCTION winecatalog.marcas_amigos(p_pedidos jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_eu   text := lower(COALESCE(auth.email(), ''));
  v_nome text;
BEGIN
  IF v_eu = '' THEN RETURN NULL; END IF;
  SELECT a.nome INTO v_nome
    FROM anniversarygifts.amigos a
   WHERE a.ativo AND lower(a.email) = v_eu;
  -- Fora do grupo, nada. NULL e não erro: a app pergunta sempre, e para
  -- quem não é do grupo a resposta certa é simplesmente não haver marcas.
  IF v_nome IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_pedidos) IS DISTINCT FROM 'array' THEN RETURN '[]'::jsonb; END IF;

  RETURN (
    WITH am AS MATERIALIZED (
      SELECT a.nome, lower(a.email) AS email
        FROM anniversarygifts.amigos a
       WHERE a.ativo AND COALESCE(btrim(a.email), '') <> ''
    ),
    -- Os vinhos das garrafeiras do grupo, com as chaves calculadas UMA vez
    -- (a lição da `achar`: nada de `tokens()` por linha e por pergunta).
    gv AS MATERIALIZED (
      SELECT am.nome AS amigo, v.desejado,
             v.ano, gs.stock, gs.aval_n, gs.media, gs.ultima,
             array_remove(ARRAY[NULLIF(winecatalog.chave_base(v.nome, v.produtor), ''),
                                winecatalog.base_nome(v.nome)], NULL) AS ks
        FROM garrafeira.vinhos v
        JOIN garrafeira.garrafeiras g ON g.id = v.garrafeira_id
        JOIN am ON am.email = lower(g.dono)
        CROSS JOIN LATERAL (
          SELECT count(*) FILTER (WHERE ga.estado = 'na_garrafeira') AS stock,
                 count(*) FILTER (WHERE ga.estado = 'consumida' AND ga.consumo_avaliacao IS NOT NULL) AS aval_n,
                 avg(ga.consumo_avaliacao) FILTER (WHERE ga.estado = 'consumida') AS media,
                 max(ga.consumido_em) FILTER (WHERE ga.estado = 'consumida' AND ga.consumo_avaliacao IS NOT NULL) AS ultima
            FROM garrafeira.garrafas ga
           WHERE ga.vinho_id = v.id
        ) gs
    ),
    pr AS MATERIALIZED (
      SELECT e.aniversariante AS para, e.responsavel AS de, e.data, e.estado,
             array_remove(ARRAY[NULLIF(winecatalog.chave_base(e.vinho ->> 'nome', COALESCE(e.vinho ->> 'produtor', '')), ''),
                                winecatalog.base_nome(e.vinho ->> 'nome')], NULL) AS ks,
             (SELECT COALESCE(al.id_para, w.id)
                FROM winecatalog.vinhos w
                LEFT JOIN winecatalog.alias al ON al.id_de = w.id
               WHERE (e.vinho ->> 'catalogo_id') ~ '^[0-9]{1,18}$'
                 AND w.id = (e.vinho ->> 'catalogo_id')::bigint) AS cat
        FROM anniversarygifts.eventos e
       WHERE COALESCE(btrim(e.vinho ->> 'nome'), '') <> ''
         -- a surpresa: quem faz anos não a vê antes de a receber
         AND NOT (e.aniversariante = v_nome AND e.estado <> 'entregue')
    ),
    -- Cada vinho da carta: a linha do catálogo que ele acha (qualquer
    -- colheita), e depois as chaves dele MAIS as dessa linha e das linhas
    -- fundidas nela. As duas CTEs são MATERIALIZED, e não é pormenor:
    -- · sem o `pq` à parte, o Postgres desdobrava o `rid` para dentro do
    --   filtro das linhas do catálogo e chamava a `achar` por CADA uma;
    -- · sem o `ped` materializado, levava o ARRAY(...) para dentro dos
    --   quatro subselects das marcas e recalculava-o por cada vinho das
    --   garrafeiras.
    -- Juntos davam 29 s numa carta de oito vinhos, na primeira medição.
    pq AS MATERIALIZED (
      SELECT t.i, c.n, c.pr,
             CASE WHEN winecatalog.chave_base(c.n, c.pr) <> ''
                  THEN winecatalog.achar(c.n, c.pr, c.ano, false) END AS rid
        FROM jsonb_array_elements(p_pedidos) WITH ORDINALITY AS t(p, i)
        CROSS JOIN LATERAL (
          SELECT COALESCE(t.p ->> 'nome', '') AS n,
                 COALESCE(t.p ->> 'produtor', '') AS pr,
                 CASE WHEN jsonb_typeof(t.p -> 'ano') = 'number' THEN (t.p ->> 'ano')::integer END AS ano
        ) c
    ),
    ped AS MATERIALIZED (
      SELECT pq.i, pq.rid,
             ARRAY(
               SELECT DISTINCT k FROM (
                 SELECT NULLIF(winecatalog.chave_base(pq.n, pq.pr), '') AS k
                 UNION ALL SELECT winecatalog.base_nome(pq.n)
                 UNION ALL SELECT w.chave_base FROM winecatalog.vinhos w
                             LEFT JOIN winecatalog.alias al ON al.id_de = w.id
                            WHERE pq.rid IS NOT NULL AND COALESCE(al.id_para, w.id) = pq.rid
                 UNION ALL SELECT w.base_nome FROM winecatalog.vinhos w
                             LEFT JOIN winecatalog.alias al ON al.id_de = w.id
                            WHERE pq.rid IS NOT NULL AND COALESCE(al.id_para, w.id) = pq.rid
               ) z WHERE COALESCE(k, '') <> ''
             ) AS ks
        FROM pq
    ),
    marcas AS (
      SELECT ped.i,
        (SELECT jsonb_agg(jsonb_build_object('amigo', s.amigo, 'eu', s.amigo = v_nome,
                                             'garrafas', s.n, 'anos', s.anos)
                          ORDER BY s.amigo = v_nome DESC, s.amigo)
           FROM (SELECT gv.amigo, sum(gv.stock) AS n,
                        COALESCE(array_agg(DISTINCT gv.ano ORDER BY gv.ano) FILTER (WHERE gv.ano IS NOT NULL), '{}') AS anos
                   FROM gv WHERE gv.ks && ped.ks AND gv.stock > 0 AND NOT gv.desejado
                  GROUP BY gv.amigo) s) AS garrafeiras,
        (SELECT jsonb_agg(jsonb_build_object('amigo', s.amigo, 'eu', s.amigo = v_nome,
                                             'nota', s.nota, 'vezes', s.vezes, 'ultima', s.ultima)
                          ORDER BY s.amigo = v_nome DESC, s.nota DESC, s.amigo)
           FROM (SELECT gv.amigo, sum(gv.aval_n) AS vezes,
                        round(sum(gv.media * gv.aval_n) / sum(gv.aval_n), 1) AS nota,
                        max(gv.ultima) AS ultima
                   FROM gv WHERE gv.ks && ped.ks AND gv.aval_n > 0
                  GROUP BY gv.amigo) s) AS bebidos,
        (SELECT jsonb_agg(jsonb_build_object('amigo', s.amigo, 'eu', s.amigo = v_nome)
                          ORDER BY s.amigo = v_nome DESC, s.amigo)
           FROM (SELECT DISTINCT gv.amigo FROM gv
                  WHERE gv.ks && ped.ks AND gv.desejado) s) AS wishlist,
        (SELECT jsonb_agg(jsonb_build_object('para', pr.para, 'de', pr.de,
                                             'paraMim', pr.para = v_nome, 'deMim', pr.de = v_nome,
                                             'ano', extract(year FROM pr.data)::integer,
                                             'entregue', pr.estado = 'entregue')
                          ORDER BY pr.data DESC)
           FROM pr WHERE pr.ks && ped.ks OR (pr.cat IS NOT NULL AND pr.cat = ped.rid)) AS prendas
        FROM ped
    )
    SELECT COALESCE(jsonb_agg(
             CASE WHEN m.garrafeiras IS NULL AND m.bebidos IS NULL
                       AND m.wishlist IS NULL AND m.prendas IS NULL THEN NULL
                  ELSE jsonb_strip_nulls(jsonb_build_object(
                         'garrafeiras', m.garrafeiras, 'bebidos', m.bebidos,
                         'wishlist', m.wishlist, 'prendas', m.prendas))
             END ORDER BY m.i), '[]'::jsonb)
      FROM marcas m
  );
END;
$$;

-- Só quem tem sessão; e o portão do grupo está LÁ DENTRO (ver acima).
-- Uma função nova nasce com EXECUTE para PUBLIC — este REVOKE não é
-- decoração (ver "O caminho de leitura" no CLAUDE.md).
REVOKE ALL ON FUNCTION winecatalog.marcas_amigos(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.marcas_amigos(jsonb) TO authenticated;
