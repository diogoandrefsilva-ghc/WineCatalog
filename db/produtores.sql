-- =====================================================================
-- WineCatalog — os PRODUTORES OFICIAIS (27/09/2026, fase 1 dos nomes)
--
-- Correr DEPOIS de `catalogo.sql` (as tabelas `produtores`/
-- `produtor_variantes`, a `chave_produtor`, a `produtor_oficial` e a
-- `chave_base` que já a usa), do `historico.sql` e do `nomes.sql` (o
-- trigger dos nomes, que aqui passa a trocar também o produtor).
-- Idempotente. Do repo Garrafeira, a `db/migracao-produtores.sql`
-- (migração 23) põe o mesmo no trigger das garrafeiras.
--
-- O QUE RESOLVE. O mesmo produtor escrito de várias maneiras ("Ramos
-- Pinto" / "Adriano Ramos Pinto", três Carlos Alonso, CARM de três
-- maneiras…) fazia do mesmo vinho linhas diferentes, e no ecrã não se
-- sabia qual era a certa. O admin escolhe o nome OFICIAL; cada grafia
-- passa a ser uma variante dele, e:
--   · a CHAVE do vinho usa o oficial (a `chave_base`, em `catalogo.sql`);
--   · o trigger dos nomes troca a grafia pelo oficial em QUALQUER escrita,
--     no catálogo e nas garrafeiras — digite-se o que se digitar;
--   · o que já lá estava é corrigido no momento em que se confirma
--     (`produtor_definir`), no catálogo e em todas as garrafeiras (decisão
--     do dono, 27/09/2026: "quero aplicar também nas garrafeiras").
--
-- NUNCA AUTOMÁTICO. As sugestões (`produtores_sugestoes`) são pares de
-- grafias em que as palavras de uma estão todas na outra — e isso junta
-- também o que não é o mesmo ("Quinta Nova" e "Herdade da Malhadinha
-- Nova"). A semelhança sugere; quem decide é o admin, e o "são diferentes"
-- fica gravado para o par não voltar. A mesma lição dos Duplicados.
--
-- A CHAVE MUDA NO MOMENTO DE CONFIRMAR. Cada linha do catálogo com uma
-- grafia confirmada é regravada com o produtor oficial e as chaves novas.
-- Se a chave nova for a de OUTRA linha que já existe (o mesmo vinho e a
-- mesma colheita escritos com as duas grafias), a linha não se mexe: é um
-- duplicado, e diz-se qual — junta-se nos Duplicados (a `fundir`, que é
-- reversível). Ficar calado e sobrescrever era a porta dos fundos por onde
-- uma leitura fraca tapava outra.
--
-- QUEM. O admin do catálogo (pela app) ou a `service_role` (o painel do
-- PC). Cada correção fica no histórico (quem: "produtores: nome oficial") e
-- no `garrafeira.sync_log` (origem `winecatalog-batch`).
-- =====================================================================

-- Os pares que o admin disse que NÃO são o mesmo produtor (chaves
-- ordenadas: a < b, para (A,B) e (B,A) serem a mesma linha).
CREATE TABLE IF NOT EXISTS winecatalog.produtores_distintos (
  chave_a   text NOT NULL,
  chave_b   text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chave_a, chave_b),
  CHECK (chave_a < chave_b)
);
ALTER TABLE winecatalog.produtores_distintos ENABLE ROW LEVEL SECURITY;

-- O admin da app ou o painel do PC — e mais ninguém.
CREATE OR REPLACE FUNCTION winecatalog.produtores_autorizado()
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT COALESCE(auth.role(), '') = 'service_role' OR winecatalog.sou_admin();
$$;

-- ---------------------------------------------------------------------
-- As grafias que existem: no catálogo (sem os fundidos) e nas garrafeiras,
-- com quantos vinhos cada uma tem de cada lado.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.produtores_grafias()
  RETURNS TABLE (produtor text, chave text, n_catalogo bigint, n_garrafeiras bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'garrafeira', 'public'
AS $$
  WITH e AS (
    SELECT v.produtor AS p, 1 AS c, 0 AS g FROM winecatalog.vinhos v
     WHERE btrim(v.produtor) <> ''
       AND NOT EXISTS (SELECT 1 FROM winecatalog.alias a WHERE a.id_de = v.id)
    UNION ALL
    SELECT g.produtor, 0, 1 FROM garrafeira.vinhos g WHERE btrim(COALESCE(g.produtor,'')) <> ''
  )
  SELECT p, winecatalog.chave_produtor(p), sum(c), sum(g)
    FROM e GROUP BY p;
$$;
REVOKE ALL ON FUNCTION winecatalog.produtores_grafias() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- SUGESTÕES: pares de grafias em que as palavras de uma estão TODAS na
-- outra (e a mais curta tem pelo menos uma). Fora: pares já com o mesmo
-- oficial, e pares marcados como diferentes. Cada lado diz o oficial que
-- já tem (se tiver), para o ecrã propor esse.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.produtores_sugestoes()
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  RETURN (
    WITH g AS MATERIALIZED (
      SELECT x.produtor, x.chave, x.n_catalogo, x.n_garrafeiras,
             string_to_array(x.chave, '-') AS tk,
             pv.produtor_id, p.nome AS oficial
        FROM winecatalog.produtores_grafias() x
        LEFT JOIN winecatalog.produtor_variantes pv ON pv.chave = x.chave
        LEFT JOIN winecatalog.produtores p ON p.id = pv.produtor_id
       WHERE x.chave <> ''
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'a', jsonb_build_object('produtor', a.produtor, 'chave', a.chave, 'catalogo', a.n_catalogo,
                                     'garrafeiras', a.n_garrafeiras, 'oficial', a.oficial),
             'b', jsonb_build_object('produtor', b.produtor, 'chave', b.chave, 'catalogo', b.n_catalogo,
                                     'garrafeiras', b.n_garrafeiras, 'oficial', b.oficial),
             'mesmaChave', a.chave = b.chave)
           ORDER BY lower(a.produtor), lower(b.produtor)), '[]'::jsonb)
      FROM g a JOIN g b ON a.produtor < b.produtor
     WHERE (a.tk <@ b.tk OR b.tk <@ a.tk)
       AND NOT (a.produtor_id IS NOT NULL AND a.produtor_id = b.produtor_id)
       -- a mesma chave ("Herdade do Mouchão"/"Mouchão") já é o mesmo vinho
       -- na chave: aparece sempre, só para se escolher como se escreve.
       AND (a.chave = b.chave OR NOT EXISTS (
             SELECT 1 FROM winecatalog.produtores_distintos d
              WHERE d.chave_a = LEAST(a.chave, b.chave) AND d.chave_b = GREATEST(a.chave, b.chave)))
  );
END;
$$;

-- ---------------------------------------------------------------------
-- A LISTA dos oficiais, com as grafias de cada um.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.produtores_listar()
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', p.id, 'nome', p.nome, 'nome_completo', p.nome_completo, 'criado_em', p.criado_em,
             'variantes', (SELECT COALESCE(jsonb_agg(jsonb_build_object('chave', v.chave, 'escrito', v.escrito)
                                                     ORDER BY v.escrito), '[]'::jsonb)
                             FROM winecatalog.produtor_variantes v WHERE v.produtor_id = p.id))
           ORDER BY lower(p.nome)), '[]'::jsonb)
      FROM winecatalog.produtores p
  );
END;
$$;

-- ---------------------------------------------------------------------
-- CONFIRMAR: `p_oficial` é o nome oficial; `p_grafias` as maneiras de o
-- escrever que passam a ser ele (o próprio oficial entra sozinho). Grava
-- as variantes e corrige o que já lá está — no catálogo (com as chaves) e
-- em todas as garrafeiras. Devolve o que mudou e os duplicados que
-- sobraram (a juntar nos Duplicados).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.produtor_definir(p_oficial text, p_grafias text[])
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'garrafeira', 'public'
AS $$
DECLARE
  v_oficial text := btrim(regexp_replace(COALESCE(p_oficial,''), '\s+', ' ', 'g'));
  v_id      bigint;
  v_chaves  text[];
  g         text;
  k         text;
  r         record;
  v_base    text;
  v_chave   text;
  n_cat     integer := 0;
  n_garr    integer := 0;
  v_dup     jsonb := '[]'::jsonb;
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  IF v_oficial = '' OR winecatalog.chave_produtor(v_oficial) = '' THEN
    RAISE EXCEPTION 'Falta o nome oficial.';
  END IF;
  -- A regra das maiúsculas vale também para o oficial.
  BEGIN v_oficial := winecatalog.nome_proprio(v_oficial); EXCEPTION WHEN OTHERS THEN NULL; END;

  -- O oficial pode já existir (pelo nome, ou como variante de si próprio).
  SELECT p.id INTO v_id FROM winecatalog.produtores p WHERE lower(p.nome) = lower(v_oficial);
  IF v_id IS NULL THEN
    SELECT pv.produtor_id INTO v_id FROM winecatalog.produtor_variantes pv
     WHERE pv.chave = winecatalog.chave_produtor(v_oficial);
  END IF;
  IF v_id IS NULL THEN
    INSERT INTO winecatalog.produtores (nome, criado_por)
    VALUES (v_oficial, COALESCE(NULLIF(auth.email(), ''), 'painel do PC'))
    RETURNING id INTO v_id;
  ELSE
    UPDATE winecatalog.produtores SET nome = v_oficial WHERE id = v_id AND nome <> v_oficial;
  END IF;

  -- As variantes: o oficial e cada grafia. Uma grafia que era de outro
  -- oficial passa para este (foi o admin que o disse agora).
  FOREACH g IN ARRAY (ARRAY[v_oficial] || COALESCE(p_grafias, ARRAY[]::text[])) LOOP
    k := winecatalog.chave_produtor(g);
    CONTINUE WHEN k = '';
    INSERT INTO winecatalog.produtor_variantes (chave, produtor_id, escrito)
    VALUES (k, v_id, btrim(g))
    ON CONFLICT (chave) DO UPDATE SET produtor_id = EXCLUDED.produtor_id;
  END LOOP;
  -- As que já eram deste oficial também contam (renomear o oficial corrige-as).
  SELECT array_agg(pv.chave) INTO v_chaves FROM winecatalog.produtor_variantes pv WHERE pv.produtor_id = v_id;

  -- O CATÁLOGO: linha a linha, com as chaves recalculadas. Os fundidos
  -- (perdedoras de um alias) ficam: respondem pela alvo.
  PERFORM set_config('winecatalog.quem', 'produtores: nome oficial', true);
  FOR r IN
    SELECT v.* FROM winecatalog.vinhos v
     WHERE winecatalog.chave_produtor(v.produtor) = ANY(v_chaves)
       AND NOT EXISTS (SELECT 1 FROM winecatalog.alias a WHERE a.id_de = v.id)
     ORDER BY v.id
  LOOP
    v_chave := winecatalog.chave(r.nome, v_oficial, r.ano, r.cor);
    CONTINUE WHEN r.produtor = v_oficial AND r.chave = v_chave;
    IF NOT winecatalog.libertar_chave(v_chave, r.id) THEN   -- um fundido nesta não trava
      v_dup := v_dup || jsonb_build_object('id', r.id, 'nome', r.nome, 'produtor', r.produtor, 'ano', r.ano,
                 'com', (SELECT o.id FROM winecatalog.vinhos o WHERE o.chave = v_chave AND o.id <> r.id));
      CONTINUE;
    END IF;
    UPDATE winecatalog.vinhos
       SET produtor = v_oficial   -- o trigger recalcula as chaves
     WHERE id = r.id;
    n_cat := n_cat + 1;
  END LOOP;
  PERFORM set_config('winecatalog.quem', '', true);

  -- AS GARRAFEIRAS: só o texto do produtor. O trigger `vinhos_catalogo` de
  -- lá volta a catalogar o vinho, já com a chave nova.
  IF to_regclass('garrafeira.vinhos') IS NOT NULL THEN
    WITH mudou AS (
      UPDATE garrafeira.vinhos gv SET produtor = v_oficial
        FROM (SELECT id, produtor FROM garrafeira.vinhos) antes
       WHERE antes.id = gv.id
         AND winecatalog.chave_produtor(gv.produtor) = ANY(v_chaves)
         AND gv.produtor IS DISTINCT FROM v_oficial
      RETURNING gv.id, gv.garrafeira_id, antes.produtor AS antes
    ), log AS (
      INSERT INTO garrafeira.sync_log (origem, acao, estado, quem, detalhe)
      SELECT 'winecatalog-batch', 'produtor_oficial', 'ok', COALESCE(NULLIF(auth.email(), ''), 'painel do PC'),
             jsonb_build_object('vinho_id', id, 'garrafeira_id', garrafeira_id, 'antes', antes, 'depois', v_oficial)
        FROM mudou
      RETURNING 1
    )
    SELECT count(*) INTO n_garr FROM log;
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'oficial', v_oficial,
    'catalogo', n_cat, 'garrafeiras', n_garr, 'duplicados', v_dup);
END;
$$;

-- "São diferentes": o par não volta a ser sugerido.
CREATE OR REPLACE FUNCTION winecatalog.produtores_diferentes(p_a text, p_b text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  ka text := winecatalog.chave_produtor(p_a);
  kb text := winecatalog.chave_produtor(p_b);
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  IF ka = '' OR kb = '' OR ka = kb THEN
    RAISE EXCEPTION 'Estas duas grafias dão a mesma chave — não podem ser produtores diferentes.';
  END IF;
  INSERT INTO winecatalog.produtores_distintos (chave_a, chave_b)
  VALUES (LEAST(ka, kb), GREATEST(ka, kb)) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Tirar uma grafia de um oficial. NÃO desfaz o que ela já corrigiu (isso
-- está no histórico e no `sync_log`): só deixa de a trocar daqui para a
-- frente. A do próprio nome oficial não se tira.
CREATE OR REPLACE FUNCTION winecatalog.produtor_tirar_variante(p_chave text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  IF EXISTS (SELECT 1 FROM winecatalog.produtor_variantes v JOIN winecatalog.produtores p ON p.id = v.produtor_id
              WHERE v.chave = p_chave AND winecatalog.chave_produtor(p.nome) = p_chave) THEN
    RAISE EXCEPTION 'É a grafia do próprio nome oficial.';
  END IF;
  DELETE FROM winecatalog.produtor_variantes WHERE chave = p_chave;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ---------------------------------------------------------------------
-- O TRIGGER DOS NOMES passa a trocar a grafia do produtor pela oficial
-- (a mesma função de `nomes.sql`, com uma linha a mais). As maiúsculas
-- primeiro: a grafia oficial já vem arrumada, e a desconhecida arruma-se.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.vinhos_nomes()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  BEGIN
    NEW.nome     := winecatalog.nome_proprio(NEW.nome);
    NEW.produtor := winecatalog.produtor_oficial(winecatalog.nome_proprio(NEW.produtor));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.vinhos_nomes() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION winecatalog.produtores_autorizado()              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION winecatalog.produtores_sugestoes()               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION winecatalog.produtores_listar()                  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION winecatalog.produtor_definir(text, text[])       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION winecatalog.produtores_diferentes(text, text)    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION winecatalog.produtor_tirar_variante(text)        FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.produtores_autorizado()           TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION winecatalog.produtores_sugestoes()            TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION winecatalog.produtores_listar()               TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION winecatalog.produtor_definir(text, text[])    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION winecatalog.produtores_diferentes(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION winecatalog.produtor_tirar_variante(text)     TO authenticated, service_role;


-- ---------------------------------------------------------------------
-- O NOME COMPLETO (27/09/2026, o dono das apps). O nome OFICIAL é o que se
-- escreve no vinho e entra na chave — curto, como se diz ("Quinta Nova",
-- "Carlos Alonso"). Ao lado, o nome por extenso ("Quinta Nova de Nossa
-- Senhora do Carmo", "Carlos Alonso Douro Wine Company"): só para se ler na
-- ficha do vinho. NÃO entra na chave nem nas grafias — mudar o completo não
-- mexe em vinho nenhum.
-- ---------------------------------------------------------------------
ALTER TABLE winecatalog.produtores ADD COLUMN IF NOT EXISTS nome_completo text;

CREATE OR REPLACE FUNCTION winecatalog.produtor_nome_completo(p_id bigint, p_nome_completo text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v text := NULLIF(btrim(regexp_replace(COALESCE(p_nome_completo, ''), '\s+', ' ', 'g')), '');
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  IF length(v) > 200 THEN RAISE EXCEPTION 'Nome comprido de mais.'; END IF;
  UPDATE winecatalog.produtores SET nome_completo = v WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Produtor não encontrado.'; END IF;
  RETURN jsonb_build_object('ok', true, 'nome_completo', v);
END;
$$;

-- Os nomes completos, para as apps mostrarem na ficha do vinho. Aberta a
-- quem tem sessão (a Garrafeira, a WineCatalog): são nomes de adegas, e a
-- lista dos oficiais não diz nada sobre o que alguém tem em casa.
CREATE OR REPLACE FUNCTION winecatalog.produtores_completos()
  RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT COALESCE(jsonb_object_agg(p.nome, p.nome_completo), '{}'::jsonb)
    FROM winecatalog.produtores p
   WHERE COALESCE(p.nome_completo, '') <> '' AND p.nome_completo <> p.nome;
$$;

REVOKE ALL ON FUNCTION winecatalog.produtor_nome_completo(bigint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION winecatalog.produtores_completos()               FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.produtor_nome_completo(bigint, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION winecatalog.produtores_completos()               TO authenticated, service_role;


-- ---------------------------------------------------------------------
-- MUDAR O NOME OFICIAL e ACRESCENTAR GRAFIAS a um que já existe
-- (27/09/2026, o dono das apps: "gostava de poder mudar o nome principal e
-- de poder adicionar outras grafias"). Acrescentar é a `produtor_definir`
-- com o oficial que já lá está — não precisa de função nova. Mudar o nome
-- precisa: pela `produtor_definir` com o nome novo nascia OUTRO oficial, e
-- as grafias do antigo ficavam penduradas nele.
--
-- O nome antigo fica como grafia (quem o escrever continua a cair aqui), e
-- o resto é a `produtor_definir`: o catálogo com as chaves recalculadas, as
-- garrafeiras com uma linha no `sync_log`, os duplicados devolvidos.
-- Se o nome novo já for de OUTRO oficial (o nome, ou uma grafia dele), é
-- juntar dois produtores e não mudar um nome: recusa, e diz qual é.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.produtor_renomear(p_id bigint, p_nome text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_novo  text := btrim(regexp_replace(COALESCE(p_nome, ''), '\s+', ' ', 'g'));
  v_velho text;
  v_outro bigint;
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  SELECT nome INTO v_velho FROM winecatalog.produtores WHERE id = p_id;
  IF v_velho IS NULL THEN RAISE EXCEPTION 'Produtor não encontrado.'; END IF;
  IF v_novo = '' OR winecatalog.chave_produtor(v_novo) = '' THEN
    RAISE EXCEPTION 'Falta o nome oficial.';
  END IF;
  BEGIN v_novo := winecatalog.nome_proprio(v_novo); EXCEPTION WHEN OTHERS THEN NULL; END;
  IF v_novo = v_velho THEN
    RETURN jsonb_build_object('ok', true, 'id', p_id, 'oficial', v_novo,
      'catalogo', 0, 'garrafeiras', 0, 'duplicados', '[]'::jsonb);
  END IF;

  SELECT id INTO v_outro FROM winecatalog.produtores WHERE lower(nome) = lower(v_novo) AND id <> p_id;
  IF v_outro IS NULL THEN
    SELECT produtor_id INTO v_outro FROM winecatalog.produtor_variantes
     WHERE chave = winecatalog.chave_produtor(v_novo) AND produtor_id <> p_id;
  END IF;
  IF v_outro IS NOT NULL THEN
    RAISE EXCEPTION '"%" já é do produtor oficial "%" — para os juntar, acrescenta lá as grafias deste.',
      v_novo, (SELECT nome FROM winecatalog.produtores WHERE id = v_outro);
  END IF;

  UPDATE winecatalog.produtores SET nome = v_novo WHERE id = p_id;
  RETURN winecatalog.produtor_definir(v_novo, ARRAY[v_velho]);
END;
$$;

-- As grafias que existem (catálogo e garrafeiras), com o oficial de cada
-- uma, se já tiver — é a lista de onde se escolhem as grafias a acrescentar.
CREATE OR REPLACE FUNCTION winecatalog.produtores_grafias_lista()
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'produtor', g.produtor, 'chave', g.chave, 'catalogo', g.n_catalogo,
             'garrafeiras', g.n_garrafeiras, 'oficial', p.nome)
           ORDER BY lower(g.produtor)), '[]'::jsonb)
      FROM winecatalog.produtores_grafias() g
      LEFT JOIN winecatalog.produtor_variantes pv ON pv.chave = g.chave
      LEFT JOIN winecatalog.produtores p ON p.id = pv.produtor_id
     WHERE g.chave <> ''
  );
END;
$$;

REVOKE ALL ON FUNCTION winecatalog.produtor_renomear(bigint, text)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION winecatalog.produtores_grafias_lista()        FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.produtor_renomear(bigint, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION winecatalog.produtores_grafias_lista()      TO authenticated, service_role;
