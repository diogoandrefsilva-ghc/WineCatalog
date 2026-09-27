-- =====================================================================
-- WineCatalog — o NOME do vinho, normalizado (27/09/2026, fases 2 e 3)
--
-- Correr DEPOIS de `catalogo.sql`, `historico.sql`, `nomes.sql` e
-- `produtores.sql` (usa a `produtor_oficial` e as variantes). Idempotente.
--
-- A REGRA (decidida com o dono das apps). O nome é o que distingue o vinho
-- e mais nada. O produtor, a cor e a colheita são campos à parte:
--   · o ANO sai do nome quando é o da colheita ("Viúva Le Cocq Reserva
--     2021", ano 2021) — e, sem colheita no vinho, passa a sê-la;
--   · o PRODUTOR sai da FRENTE do nome, se o que sobra se aguentar sozinho
--     ("Ramos Pinto Duas Quintas" → "Duas Quintas"). Se o que sobra for só
--     gama, cor ou casta ("Cartuxa Colheita", "Morais Rocha Reserva",
--     "Herdade do Sobroso Reserva"), fica: esse vinho CHAMA-SE pelo nome do
--     produtor. É a `generico` dos Duplicados que diz o que "se aguenta";
--   · a COR no fim do nome ("… Tinto", "… Vinho Tinto") também sai, se for
--     a do vinho. Esperou pela fase 4 (`cor-na-chave.sql`): antes, a cor
--     estava dentro da chave pelo nome, e o "Papa Figos Tinto" e o "Papa
--     Figos Branco" sem cor no nome passavam a ser a mesma chave.
-- O que é duvidoso não muda sozinho: a cor a meio do nome ("Tapada do
-- Chaves Tinto Reserva"), um ano no nome diferente da colheita, uma cor
-- no nome diferente da do vinho. Aparece como aviso.
--
-- A CHAVE NÃO MUDA com o produtor: a `chave_base` junta o nome e o produtor
-- no mesmo saco de palavras, e tirar do nome palavras que estão no produtor
-- dá o mesmo saco. Mudam as chaves só-do-nome (`chave_nome`/`base_nome`,
-- recalculadas aqui), e a `chave` quando a colheita passa do nome para o
-- campo — se isso a fizer igual à de outra linha, a linha não se mexe e
-- vai para os Duplicados, como nos produtores.
--
-- NADA É AUTOMÁTICO AINDA. `nomes_rever` sem `p_aplicar` é a SIMULAÇÃO (o
-- painel do PC mostra-a, o admin valida); com ele, aplica só as linhas
-- escolhidas, no catálogo e em todas as garrafeiras (decisão do dono),
-- com histórico e `garrafeira.sync_log` (acao `nome_normalizado`). As
-- escritas FUTURAS passam pela regra no trigger (`identidade`, fase 4).
-- =====================================================================

-- Uma palavra para comparar: sem acentos, minúsculas, só letras e números.
CREATE OR REPLACE FUNCTION winecatalog.palavra_norm(p text)
  RETURNS text LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT regexp_replace(lower(regexp_replace(normalize(COALESCE(p,''), NFD), U&'[\0300-\036F]', '', 'g')),
                        '[^a-z0-9]', '', 'g');
$$;

-- ---------------------------------------------------------------------
-- A REGRA. Devolve o nome novo (ano, cor e produtor aplicados), o ano
-- novo, o que mudou e os avisos. `nome_sem_cor` ficou igual ao `nome`
-- desde a fase 4 (era a pré-visualização da cor a sair).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.nome_normal(p_nome text, p_produtor text, p_tipo text, p_ano integer)
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  w        text[] := regexp_split_to_array(btrim(regexp_replace(COALESCE(p_nome,''), '\s+', ' ', 'g')), ' ');
  n        integer;
  i        integer;
  v_ano    integer := p_ano;
  mud      text[] := ARRAY[]::text[];
  avisos   text[] := ARRAY[]::text[];
  cores    text[] := ARRAY['tinto','branco','rose','rosado'];
  tipo_n   text := winecatalog.palavra_norm(p_tipo);
  cand     text[];
  c        text;
  cw       text[];
  melhor   integer := 0;
  k        integer;
  ok       boolean;
  resto    text[];
  cor_fim  text;
  v_manter text;
  regioes  text[] := ARRAY['douro','duriense','alentejo','alentejano','dao','bairrada','tejo','lisboa',
                           'setubal','peninsula','minho','verde','verdes','madeira','porto','algarve',
                           'beira','beiras','interior','tras','montes','transmontano','tavora','varosa',
                           'palmela','colares','bucelas','carcavelos','evora','reguengos','borba',
                           'redondo','vidigueira','portalegre','moura','granja','amareleja','doc','vr',
                           'regional','ipr','preta','branca','portugal'];
BEGIN
  IF btrim(COALESCE(p_nome,'')) = '' THEN
    RETURN jsonb_build_object('nome', p_nome, 'ano', p_ano, 'nome_sem_cor', p_nome, 'mudancas', '[]'::jsonb, 'avisos', '[]'::jsonb, 'chave_manter', '');
  END IF;

  -- 1. O ANO. Só uma palavra que É um ano (19xx/20xx), e nunca a única.
  n := array_length(w, 1);
  FOR i IN REVERSE n..1 LOOP
    CONTINUE WHEN w[i] !~ '^\(?(19|20)[0-9]{2}\)?$' OR array_length(w, 1) = 1;
    k := substring(w[i] FROM '((?:19|20)[0-9]{2})')::integer;
    IF v_ano IS NULL OR v_ano = k THEN
      v_ano := k;
      w := w[1:i-1] || w[i+1:];
      mud := array_append(mud, 'ano');
    ELSE
      avisos := array_append(avisos, format('ano %s no nome e colheita %s', k, v_ano));
    END IF;
  END LOOP;

  -- 2. A COR no fim (e o "Vinho" antes dela), se for a do vinho. Antes do
  -- produtor: "Cartuxa Tinto" sem a cor é "Cartuxa", e é esse que tem de
  -- se aguentar sozinho no passo seguinte.
  n := COALESCE(array_length(w, 1), 0);
  IF n > 1 AND winecatalog.palavra_norm(w[n]) = ANY(cores) THEN
    cor_fim := winecatalog.palavra_norm(w[n]);
    IF tipo_n = '' OR tipo_n = cor_fim OR (tipo_n = 'rose' AND cor_fim = 'rosado') THEN
      w := w[1:n-1];
      IF array_length(w, 1) > 1 AND winecatalog.palavra_norm(w[array_length(w,1)]) = 'vinho' THEN
        w := w[1:array_length(w,1)-1];
      END IF;
      mud := array_append(mud, 'cor');
    ELSE
      avisos := array_append(avisos, format('a cor no nome (%s) não é a do vinho (%s)', w[n], p_tipo));
    END IF;
  END IF;

  -- Um nome da lista do admin (`nomes_manter`, ver nomes-manter.sql) fica
  -- com o produtor à frente: "1836 Grande Reserva" sozinho é vago.
  v_manter := winecatalog.chave_manter(w);

  -- 3. O PRODUTOR à frente. As grafias possíveis: a escrita, a oficial e as
  -- variantes da oficial. Fica a mais comprida que case palavra a palavra.
  cand := ARRAY[COALESCE(p_produtor,''), COALESCE(winecatalog.produtor_oficial(p_produtor),'')];
  cand := cand || COALESCE((SELECT array_agg(pv.escrito)
                              FROM winecatalog.produtor_variantes pv
                              JOIN winecatalog.produtores p ON p.id = pv.produtor_id
                             WHERE p.nome = winecatalog.produtor_oficial(p_produtor)), ARRAY[]::text[]);
  FOREACH c IN ARRAY cand LOOP
    cw := regexp_split_to_array(btrim(regexp_replace(regexp_replace(c, '\s*\([^)]*\)', ' ', 'g'), '\s+', ' ', 'g')), ' ');
    CONTINUE WHEN cw IS NULL OR array_length(cw, 1) IS NULL OR cw[1] = '';
    CONTINUE WHEN array_length(cw, 1) >= array_length(w, 1);
    ok := true;
    FOR i IN 1..array_length(cw, 1) LOOP
      IF winecatalog.palavra_norm(cw[i]) <> winecatalog.palavra_norm(w[i]) THEN ok := false; EXIT; END IF;
    END LOOP;
    IF ok AND array_length(cw, 1) > melhor THEN melhor := array_length(cw, 1); END IF;
  END LOOP;
  IF melhor > 0 AND EXISTS (SELECT 1 FROM winecatalog.nomes_manter m WHERE m.chave = v_manter) THEN
    melhor := 0;
  END IF;
  IF melhor > 0 THEN
    resto := w[melhor+1:];
    WHILE array_length(resto, 1) > 0 AND winecatalog.palavra_norm(resto[1]) = '' LOOP resto := resto[2:]; END LOOP;
    IF EXISTS (SELECT 1 FROM unnest(winecatalog.tokens(array_to_string(resto, ' '))) t
                WHERE NOT winecatalog.generico(t) AND t <> ALL (regioes)) THEN
      w := resto;
      mud := array_append(mud, 'produtor');
    END IF;
  END IF;

  FOR i IN 2..COALESCE(array_length(w, 1), 0) - 1 LOOP
    IF winecatalog.palavra_norm(w[i]) = ANY(cores) THEN
      avisos := array_append(avisos, format('"%s" a meio do nome', w[i]));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'nome', array_to_string(w, ' '),
    'ano', v_ano,
    'nome_sem_cor', array_to_string(w, ' '),   -- igual ao nome desde a fase 4
    'mudancas', to_jsonb(mud),
    'avisos', to_jsonb(avisos),
    'chave_manter', v_manter);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.nome_normal(text, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.nome_normal(text, text, text, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- A SIMULAÇÃO e a aplicação. Sem `p_aplicar`: a lista de tudo o que a
-- regra mudaria (ou só avisa), no catálogo e nas garrafeiras. Com ele:
-- aplica os itens escolhidos ([{fonte:'catalogo'|'garrafeira', id}]) —
-- recalculando a regra no momento (o que mudou entretanto conta).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.nomes_rever(p_itens jsonb DEFAULT NULL, p_aplicar boolean DEFAULT false)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'garrafeira', 'public'
AS $$
DECLARE
  linhas   jsonb := '[]'::jsonb;
  r        record;
  nn       jsonb;
  v_nome   text;
  v_ano    integer;
  v_base   text;
  v_chave  text;
  n_cat    integer := 0;
  n_garr   integer := 0;
  v_dup    jsonb := '[]'::jsonb;
  escolhe  boolean;
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;

  -- O CATÁLOGO (sem os fundidos).
  PERFORM set_config('winecatalog.quem', 'nomes: normalização', true);
  FOR r IN
    SELECT v.id, v.nome, v.produtor, v.ano, v.ficha ->> 'tipo' AS tipo, v.chave
      FROM winecatalog.vinhos v
     WHERE NOT EXISTS (SELECT 1 FROM winecatalog.alias a WHERE a.id_de = v.id)
     ORDER BY lower(v.nome), v.ano
  LOOP
    nn := winecatalog.nome_normal(r.nome, r.produtor, r.tipo, r.ano);
    v_nome := nn ->> 'nome';
    v_ano  := (nn ->> 'ano')::integer;
    CONTINUE WHEN v_nome = r.nome AND v_ano IS NOT DISTINCT FROM r.ano
              AND nn ->> 'nome_sem_cor' = r.nome AND jsonb_array_length(nn -> 'avisos') = 0;
    IF p_aplicar THEN
      escolhe := COALESCE(p_itens, '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('fonte', 'catalogo', 'id', r.id));
      CONTINUE WHEN NOT escolhe OR (v_nome = r.nome AND v_ano IS NOT DISTINCT FROM r.ano);
      v_chave := winecatalog.chave(v_nome, r.produtor, v_ano, r.tipo);
      IF NOT winecatalog.libertar_chave(v_chave, r.id) THEN   -- um fundido nesta não trava (nomes-manter.sql)
        v_dup := v_dup || jsonb_build_object('id', r.id, 'nome', r.nome, 'ano', r.ano,
                   'com', (SELECT o.id FROM winecatalog.vinhos o WHERE o.chave = v_chave AND o.id <> r.id));
        CONTINUE;
      END IF;
      UPDATE winecatalog.vinhos
         SET nome = v_nome, ano = v_ano   -- o trigger recalcula as chaves
       WHERE id = r.id;
      n_cat := n_cat + 1;
    ELSE
      linhas := linhas || jsonb_build_object('fonte', 'catalogo', 'id', r.id,
        'nome', r.nome, 'produtor', r.produtor, 'ano', r.ano, 'tipo', r.tipo,
        'novo_nome', v_nome, 'novo_ano', v_ano, 'nome_sem_cor', nn -> 'nome_sem_cor',
        'mudancas', nn -> 'mudancas', 'avisos', nn -> 'avisos');
    END IF;
  END LOOP;
  PERFORM set_config('winecatalog.quem', '', true);

  -- AS GARRAFEIRAS.
  IF to_regclass('garrafeira.vinhos') IS NOT NULL THEN
    FOR r IN
      SELECT gv.id, gv.nome, gv.produtor, gv.ano, gv.tipo, gv.garrafeira_id, g.nome AS garrafeira, g.dono
        FROM garrafeira.vinhos gv JOIN garrafeira.garrafeiras g ON g.id = gv.garrafeira_id
       ORDER BY lower(gv.nome), gv.ano
    LOOP
      nn := winecatalog.nome_normal(r.nome, r.produtor, r.tipo, r.ano);
      v_nome := nn ->> 'nome';
      v_ano  := (nn ->> 'ano')::integer;
      CONTINUE WHEN v_nome = r.nome AND v_ano IS NOT DISTINCT FROM r.ano
                AND nn ->> 'nome_sem_cor' = r.nome AND jsonb_array_length(nn -> 'avisos') = 0;
      IF p_aplicar THEN
        escolhe := COALESCE(p_itens, '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('fonte', 'garrafeira', 'id', r.id));
        CONTINUE WHEN NOT escolhe OR (v_nome = r.nome AND v_ano IS NOT DISTINCT FROM r.ano);
        UPDATE garrafeira.vinhos SET nome = v_nome, ano = v_ano WHERE id = r.id;
        INSERT INTO garrafeira.sync_log (origem, acao, estado, quem, detalhe)
        VALUES ('winecatalog-batch', 'nome_normalizado', 'ok', COALESCE(NULLIF(auth.email(), ''), 'painel do PC'),
                jsonb_build_object('vinho_id', r.id, 'garrafeira_id', r.garrafeira_id,
                  'antes', jsonb_build_object('nome', r.nome, 'ano', r.ano),
                  'depois', jsonb_build_object('nome', v_nome, 'ano', v_ano)));
        n_garr := n_garr + 1;
      ELSE
        linhas := linhas || jsonb_build_object('fonte', 'garrafeira', 'id', r.id,
          'nome', r.nome, 'produtor', r.produtor, 'ano', r.ano, 'tipo', r.tipo,
          'garrafeira', r.garrafeira, 'dono', r.dono,
          'novo_nome', v_nome, 'novo_ano', v_ano, 'nome_sem_cor', nn -> 'nome_sem_cor',
          'mudancas', nn -> 'mudancas', 'avisos', nn -> 'avisos');
      END IF;
    END LOOP;
  END IF;

  IF p_aplicar THEN
    RETURN jsonb_build_object('ok', true, 'catalogo', n_cat, 'garrafeiras', n_garr, 'duplicados', v_dup);
  END IF;
  RETURN jsonb_build_object('linhas', linhas);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.nomes_rever(jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.nomes_rever(jsonb, boolean) TO authenticated, service_role;
