-- =====================================================================
-- WineCatalog — a COR NA CHAVE e a regra do nome a cada escrita
-- (27/09/2026, fase 4 dos nomes — decidida com o dono das apps)
--
-- Correr DEPOIS de `catalogo.sql`, `curadoria.sql`, `vivino.sql`,
-- `historico.sql`, `nomes.sql`, `produtores.sql` e `nomes-normalizar.sql`.
-- Substitui funções desses ficheiros (a chave, a `achar`, a `juntar`, a
-- `procurar`, a `criar`, a `editar`, a `comparar`, a `colheitas`, a
-- `candidatos`, o trigger dos nomes): é a versão que vale. Idempotente.
--
-- O QUE MUDA. A cor deixa de estar dentro do NOME e passa a ser um campo da
-- identidade (`vinhos.cor`: tinto · branco · rose · espumante · frisante ·
-- licoroso), vindo do `tipo` da ficha — ou, sem ele, da cor escrita no nome.
--   · as palavras de cor saem das chaves (`tokens_id`), se sobrar alguma
--     coisa: "Papa Figos Branco" e nome "Papa Figos" + tipo Branco passam a
--     ser a MESMA chave de nome, e a cor à parte separa-os do tinto;
--   · a `chave` (a única) é nome+produtor | ano | cor;
--   · a `achar` casa pelo nome e pelo ano como antes e depois pela cor com
--     um CORINGA: cor desconhecida (de um lado ou do outro) casa com
--     qualquer uma; duas cores conhecidas e diferentes nunca casam. Uma
--     carta de restaurante muitas vezes não diz a cor, e sem o coringa a
--     mudança partia-lhe as consultas. Com a cor desconhecida e as duas
--     versões no catálogo, a `colheitas` mostra as duas;
--   · a cor é OBRIGATÓRIA para nascer uma linha pela mão de alguém (`criar`).
--
-- E A REGRA DO NOME passa a valer em cada escrita (`identidade`, chamada
-- pelo trigger): as maiúsculas, o produtor oficial, o ano fora do nome, o
-- produtor fora da frente do nome (se o resto se aguentar) e a cor no fim
-- do nome — que agora sai. O que já lá estava NÃO muda sozinho: continua a
-- ser a simulação do painel (`nomes_rever`), validada pelo admin.
--
-- As CHAVES de todas as linhas são recalculadas no fim deste ficheiro (a
-- cor entra, as palavras de cor saem). Duas linhas que fiquem com a mesma
-- chave não se fundem sozinhas: a segunda fica com a chave antiga e aparece
-- nos Duplicados (`candidatos`), para o admin dizer que sim.
-- =====================================================================

ALTER TABLE winecatalog.vinhos ADD COLUMN IF NOT EXISTS cor text;
CREATE INDEX IF NOT EXISTS vinhos_cor_idx ON winecatalog.vinhos (cor);

-- A cor de um tipo ("Tinto", "Rosé", "rosado"…), ou NULL.
CREATE OR REPLACE FUNCTION winecatalog.cor_de(p_tipo text)
  RETURNS text LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT CASE regexp_replace(lower(regexp_replace(normalize(COALESCE(p_tipo,''), NFD), U&'[\0300-\036F]', '', 'g')), '[^a-z]', '', 'g')
    WHEN 'tinto' THEN 'tinto'
    WHEN 'branco' THEN 'branco'
    WHEN 'rose' THEN 'rose' WHEN 'rosado' THEN 'rose'
    WHEN 'espumante' THEN 'espumante'
    WHEN 'frisante' THEN 'frisante'
    WHEN 'licoroso' THEN 'licoroso'
    ELSE NULL END;
$$;

-- O nome do tipo como a ficha o escreve ("Rosé"), a partir da cor.
CREATE OR REPLACE FUNCTION winecatalog.tipo_da_cor(p_cor text)
  RETURNS text LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT CASE p_cor WHEN 'tinto' THEN 'Tinto' WHEN 'branco' THEN 'Branco' WHEN 'rose' THEN 'Rosé'
    WHEN 'espumante' THEN 'Espumante' WHEN 'frisante' THEN 'Frisante' WHEN 'licoroso' THEN 'Licoroso' END;
$$;

-- As palavras de cor, como a `tokens` as deixa.
CREATE OR REPLACE FUNCTION winecatalog.palavra_cor(p_token text)
  RETURNS boolean LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT p_token IN ('tinto','branco','rose','rosado','espumante','frisante','licoroso');
$$;

-- A cor escrita no nome: a única que lá esteja (duas diferentes = nenhuma).
CREATE OR REPLACE FUNCTION winecatalog.cor_do_nome(p_nome text)
  RETURNS text LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT CASE WHEN count(DISTINCT winecatalog.cor_de(t)) = 1 THEN min(winecatalog.cor_de(t)) END
    FROM unnest(winecatalog.tokens(p_nome)) t
   WHERE winecatalog.palavra_cor(t);
$$;

-- Os tokens da IDENTIDADE: os da `tokens` sem as palavras de cor — a não
-- ser que não sobre mais nada ("Monte Branco" continua a ser "branco").
CREATE OR REPLACE FUNCTION winecatalog.tokens_id(p_texto text)
  RETURNS text[] LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT CASE WHEN cardinality(s) > 0 THEN s ELSE t END
    FROM (SELECT winecatalog.tokens(p_texto) AS t) a,
         LATERAL (SELECT COALESCE(array_agg(x ORDER BY x), ARRAY[]::text[]) AS s
                    FROM unnest(a.t) x WHERE NOT winecatalog.palavra_cor(x)) b;
$$;

-- ---------------------------------------------------------------------
-- As chaves, sem a cor lá dentro.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.chave_base(p_nome text, p_produtor text)
  RETURNS text LANGUAGE sql STABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT array_to_string(
    winecatalog.tokens_id(
      COALESCE(p_nome,'') || ' ' ||
      regexp_replace(COALESCE(winecatalog.produtor_oficial(p_produtor),''), '\s*\([^)]*\)', ' ', 'g')
    ), '-');
$$;

CREATE OR REPLACE FUNCTION winecatalog.base_nome(p_nome text)
  RETURNS text LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM unnest(winecatalog.tokens_id(p_nome)) t
       WHERE t NOT IN ('reserva','grande','garrafeira','colheita','selecionada',
                       'seleccionada','velhas','superior','especial','premium',
                       'tinto','branco','rose','doce','seco','bruto','meio',
                       'unoaked','barrica','madeira','antiga','velho','novo')
    )
    THEN array_to_string(winecatalog.tokens_id(p_nome), '-')
    ELSE NULL
  END;
$$;

-- A chave ÚNICA: nome+produtor | ano | cor. A de três argumentos fica para
-- quem ainda a chame — sem cor, que é o coringa.
CREATE OR REPLACE FUNCTION winecatalog.chave(p_nome text, p_produtor text, p_ano integer, p_cor text)
  RETURNS text LANGUAGE sql STABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT winecatalog.chave_base(p_nome, p_produtor) || '|' || COALESCE(p_ano::text, '')
         || '|' || COALESCE(winecatalog.cor_de(p_cor), '');
$$;
CREATE OR REPLACE FUNCTION winecatalog.chave(p_nome text, p_produtor text, p_ano integer)
  RETURNS text LANGUAGE sql STABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT winecatalog.chave(p_nome, p_produtor, p_ano, NULL);
$$;

-- ---------------------------------------------------------------------
-- A IDENTIDADE de uma escrita: o nome arrumado (a regra toda), o produtor
-- oficial, o ano, a cor e as quatro chaves. É a ÚNICA conta disto — o
-- trigger usa-a, e quem precisa de saber a chave antes de escrever (para
-- recusar um duplicado) também. `p_normalizar = false` calcula as chaves
-- do nome tal como está (é o recálculo em massa, que não muda nomes).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.identidade(
  p_nome text, p_produtor text, p_ano integer, p_tipo text, p_normalizar boolean DEFAULT true
) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_nome text := btrim(regexp_replace(COALESCE(p_nome,''), '\s+', ' ', 'g'));
  v_prod text := btrim(COALESCE(p_produtor,''));
  v_ano  integer := p_ano;
  v_cor  text;
  nn     jsonb;
BEGIN
  v_cor := COALESCE(winecatalog.cor_de(p_tipo), winecatalog.cor_do_nome(v_nome));
  IF p_normalizar THEN
    BEGIN
      v_nome := winecatalog.nome_proprio(v_nome);
      v_prod := winecatalog.produtor_oficial(winecatalog.nome_proprio(v_prod));
      nn := winecatalog.nome_normal(v_nome, v_prod, COALESCE(winecatalog.tipo_da_cor(v_cor), p_tipo), v_ano);
      IF COALESCE(nn ->> 'nome_sem_cor', '') <> '' THEN v_nome := nn ->> 'nome_sem_cor'; END IF;
      v_ano := COALESCE((nn ->> 'ano')::integer, v_ano);
    EXCEPTION WHEN OTHERS THEN NULL;   -- arrumação: nunca deita uma escrita abaixo
    END;
  END IF;
  RETURN jsonb_build_object(
    'nome', v_nome, 'produtor', v_prod, 'ano', v_ano, 'cor', v_cor,
    'chave',      winecatalog.chave(v_nome, v_prod, v_ano, v_cor),
    'chave_base', winecatalog.chave_base(v_nome, v_prod),
    'chave_nome', winecatalog.chave_nome(v_nome, v_ano),
    'base_nome',  winecatalog.base_nome(v_nome));
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.identidade(text, text, integer, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.identidade(text, text, integer, text, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- O TRIGGER do catálogo: a identidade inteira, a cada escrita que mexa no
-- nome, no produtor, no ano ou na cor (a regra do nome, só quando o nome é
-- escrito). Se as chaves novas forem as de
-- OUTRA linha, ficam as de antes (a linha vai aparecer nos Duplicados) —
-- nunca um erro a meio de uma escrita.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.vinhos_nomes()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  -- NÃO se chama `id`: dentro do NOT EXISTS de baixo, `id` colidia com a
  -- coluna `o.id`, o erro era engolido e as chaves ficavam por recalcular.
  v_idt jsonb;
  v_tipo text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.nome IS NOT DISTINCT FROM OLD.nome
     AND NEW.produtor IS NOT DISTINCT FROM OLD.produtor
     AND NEW.ano IS NOT DISTINCT FROM OLD.ano
     AND (NEW.ficha ->> 'tipo') IS NOT DISTINCT FROM (OLD.ficha ->> 'tipo') THEN
    RETURN NEW;
  END IF;
  BEGIN
    v_tipo := NEW.ficha ->> 'tipo';
    -- A regra do NOME só corre quando o nome é escrito (um vinho novo, ou o
    -- nome mudado). Mudar o produtor, a cor ou o ano recalcula as chaves
    -- mas não mexe no nome: os nomes que já lá estavam arrumam-se pela
    -- simulação do painel, com o admin a ver (`nomes_rever`).
    IF TG_OP = 'INSERT' OR NEW.nome IS DISTINCT FROM OLD.nome THEN
      v_idt := winecatalog.identidade(NEW.nome, NEW.produtor, NEW.ano, v_tipo, true);
    ELSE
      NEW.produtor := winecatalog.produtor_oficial(winecatalog.nome_proprio(NEW.produtor));
      v_idt := winecatalog.identidade(NEW.nome, NEW.produtor, NEW.ano, v_tipo, false);
    END IF;
    NEW.nome     := COALESCE(NULLIF(v_idt ->> 'nome', ''), NEW.nome);
    NEW.produtor := COALESCE(v_idt ->> 'produtor', NEW.produtor);
    NEW.ano      := (v_idt ->> 'ano')::integer;
    NEW.cor      := v_idt ->> 'cor';
    -- A cor que só estava no nome passa para a ficha (força 0: qualquer
    -- escrita a sério ganha-lhe), para não se perder quando sai do nome.
    IF COALESCE(v_tipo, '') = '' AND NEW.cor IS NOT NULL THEN
      NEW.ficha   := NEW.ficha || jsonb_build_object('tipo', winecatalog.tipo_da_cor(NEW.cor));
      NEW.origens := NEW.origens || jsonb_build_object('tipo',
                       jsonb_build_object('o', 'nome', 'f', 0, 'em', now()));
    END IF;
    -- Uma linha FUNDIDA nesta com a mesma chave não trava: estaciona-se a
    -- dela (`libertar_chave`, nomes-manter.sql). Outra linha viva, sim.
    IF v_idt ->> 'chave_base' <> ''
       AND winecatalog.libertar_chave(v_idt ->> 'chave', NEW.id) THEN
      NEW.chave      := v_idt ->> 'chave';
      NEW.chave_base := v_idt ->> 'chave_base';
      NEW.chave_nome := v_idt ->> 'chave_nome';
      NEW.base_nome  := v_idt ->> 'base_nome';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.vinhos_nomes() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS vinhos_nomes ON winecatalog.vinhos;
CREATE TRIGGER vinhos_nomes
  BEFORE INSERT OR UPDATE OF nome, produtor, ano, ficha ON winecatalog.vinhos
  FOR EACH ROW EXECUTE FUNCTION winecatalog.vinhos_nomes();

-- ---------------------------------------------------------------------
-- ACHAR, com a cor. As mesmas combinações das duas chaves (agora sem a cor
-- lá dentro), o ano igual quando se exige, e a cor com o coringa. A cor da
-- pergunta é a `p_cor` ou, sem ela, a que vier escrita no nome.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS winecatalog.achar(text, text, integer, boolean, bigint);
CREATE OR REPLACE FUNCTION winecatalog.achar(
  p_nome text, p_produtor text, p_ano integer, p_exigir_ano boolean DEFAULT true,
  p_excluir bigint DEFAULT NULL, p_cor text DEFAULT NULL
) RETURNS bigint
  LANGUAGE sql STABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  WITH q AS MATERIALIZED (
    SELECT winecatalog.chave_base(p_nome, p_produtor)    AS b,
           winecatalog.base_nome(p_nome)                 AS bn,
           COALESCE(winecatalog.cor_de(p_cor), winecatalog.cor_do_nome(p_nome)) AS c
  )
  SELECT COALESCE(a.id_para, v.id)
    FROM q, winecatalog.vinhos v
    LEFT JOIN winecatalog.alias a ON a.id_de = v.id
   WHERE (p_excluir IS NULL OR v.id <> p_excluir)
     AND q.b <> ''
     AND (v.chave_base = q.b
          OR (q.bn IS NOT NULL AND v.chave_base = q.bn)
          OR (v.base_nome IS NOT NULL AND v.base_nome IN (q.b, q.bn)))
     AND (NOT p_exigir_ano OR v.ano IS NOT DISTINCT FROM p_ano)
     AND (q.c IS NULL OR v.cor IS NULL OR v.cor = q.c)
   ORDER BY (a.id_para IS NOT NULL),
            (q.c IS NOT NULL AND v.cor = q.c) DESC,
            (SELECT count(*) FROM jsonb_object_keys(v.ficha)) DESC,
            v.ano DESC NULLS LAST
   LIMIT 1;
$$;

-- ---------------------------------------------------------------------
-- JUNTAR: a cor da escrita é o `tipo` da ficha que vem com ela.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.juntar(
  p_nome text, p_produtor text, p_ano integer,
  p_ficha jsonb, p_origem text, p_fontes jsonb DEFAULT '[]'::jsonb
) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_forca   integer := winecatalog.forca(p_origem);
  v_fcampo  integer;
  v_tipo    text    := CASE WHEN jsonb_typeof(p_ficha) = 'object' THEN p_ficha ->> 'tipo' END;
  v_idt     jsonb;
  v_id      bigint;
  v_ficha   jsonb;
  v_origens jsonb;
  v_fontes  jsonb;
  v_mexeu   boolean := false;
  v_novo    boolean := false;
  v_ano     integer;
  k         text;
  v         jsonb;
  v_ant     integer;
BEGIN
  v_idt := winecatalog.identidade(p_nome, p_produtor, p_ano, v_tipo, true);
  IF v_forca <= 0 OR COALESCE(v_idt ->> 'chave_base', '') = '' OR p_ficha IS NULL OR jsonb_typeof(p_ficha) <> 'object' THEN
    RETURN NULL;
  END IF;

  -- A pergunta faz-se com a identidade já arrumada: o ano que vinha no
  -- nome ("Papa Figos Branco 2022") é o da colheita.
  v_ano := (v_idt ->> 'ano')::integer;
  v_id := winecatalog.achar(v_idt ->> 'nome', v_idt ->> 'produtor', v_ano, true, NULL, v_idt ->> 'cor');

  IF v_id IS NULL THEN
    INSERT INTO winecatalog.vinhos (chave, chave_base, chave_nome, base_nome, nome, produtor, ano, cor, ficha)
    VALUES (v_idt ->> 'chave', v_idt ->> 'chave_base', v_idt ->> 'chave_nome', v_idt ->> 'base_nome',
            COALESCE(p_nome,''), COALESCE(p_produtor,''), v_ano, v_idt ->> 'cor',
            CASE WHEN COALESCE(v_tipo,'') <> '' THEN jsonb_build_object('tipo', v_tipo) ELSE '{}'::jsonb END)
    ON CONFLICT (chave) DO NOTHING
    RETURNING id INTO v_id;
    v_novo := v_id IS NOT NULL;
    IF v_id IS NULL THEN
      SELECT v.id INTO v_id FROM winecatalog.vinhos v WHERE v.chave = v_idt ->> 'chave';
    END IF;
  END IF;
  IF v_id IS NULL THEN RETURN NULL; END IF;

  SELECT v.ficha, v.origens, v.fontes
    INTO v_ficha, v_origens, v_fontes
    FROM winecatalog.vinhos v WHERE v.id = v_id FOR UPDATE;
  -- a ficha nasceu com o tipo só para a cor entrar na chave; a força
  -- decide-se aqui como para os outros campos
  IF v_novo AND NOT (v_origens ? 'tipo') THEN v_ficha := v_ficha - 'tipo'; END IF;

  FOR k, v IN SELECT key, value FROM jsonb_each(p_ficha) LOOP
    CONTINUE WHEN v IS NULL
                  OR jsonb_typeof(v) = 'null'
                  OR v = '""'::jsonb OR v = '[]'::jsonb OR v = '{}'::jsonb;
    IF k = 'regiao' AND jsonb_typeof(v) = 'string' THEN
      v := to_jsonb(winecatalog.normalizar_regiao(v #>> '{}'));
      CONTINUE WHEN v IS NULL;
    END IF;
    v_fcampo := winecatalog.forca(p_origem, k);
    v_ant    := COALESCE((v_origens -> k ->> 'f')::integer, 0);
    IF v_fcampo >= v_ant THEN
      v_ficha   := v_ficha   || jsonb_build_object(k, v);
      v_origens := v_origens || jsonb_build_object(
        k, jsonb_build_object('o', p_origem, 'f', v_fcampo, 'em', now())
      );
      v_mexeu := true;
    END IF;
  END LOOP;

  IF p_fontes IS NOT NULL AND jsonb_typeof(p_fontes) = 'array' THEN
    SELECT COALESCE(jsonb_agg(f), '[]'::jsonb) INTO v_fontes FROM (
      SELECT DISTINCT ON (f ->> 'url') f
        FROM jsonb_array_elements(v_fontes || p_fontes) f
       WHERE COALESCE(f ->> 'url', '') <> ''
       ORDER BY (f ->> 'url')
       LIMIT 8
    ) x;
  END IF;

  -- O nome mais COMPRIDO fica (já arrumado pela regra do nome); o trigger
  -- volta a calcular as chaves com ele.
  UPDATE winecatalog.vinhos SET
    ficha    = v_ficha,
    origens  = v_origens,
    fontes   = v_fontes,
    nome     = CASE WHEN length(COALESCE(v_idt ->> 'nome','')) > length(nome) THEN v_idt ->> 'nome' ELSE nome END,
    produtor = CASE WHEN produtor = '' THEN COALESCE(p_produtor,'') ELSE produtor END,
    ano      = COALESCE(ano, v_ano),
    vezes    = vezes + 1,
    atualizado_em = CASE WHEN v_mexeu THEN now() ELSE atualizado_em END
  WHERE id = v_id;

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------
-- PROCURAR (e em lote), com a cor. `p_cor` é opcional: sem ela é o coringa
-- (ou a cor escrita no nome, que é como as cartas a trazem).
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS winecatalog.procurar(text, text, integer, integer);
CREATE OR REPLACE FUNCTION winecatalog.procurar(
  p_nome text, p_produtor text, p_ano integer, p_idade_dias integer DEFAULT 30,
  p_cor text DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_id    bigint;
  r       winecatalog.vinhos%ROWTYPE;
  r2      winecatalog.vinhos%ROWTYPE;
  v_irmao bigint;
  v_exato boolean := true;
  v_outra boolean;
  v_corte timestamptz := now() - make_interval(days => GREATEST(COALESCE(p_idade_dias, 30), 0));
  v_ficha jsonb;
  v_orig  jsonb;
  v_empr  jsonb := '[]'::jsonb;
  v_cor   text;
  k       text;
BEGIN
  IF winecatalog.chave_base(p_nome, p_produtor) = '' THEN RETURN NULL; END IF;

  IF p_ano IS NULL THEN
    v_id := winecatalog.achar(p_nome, COALESCE(p_produtor,''), NULL, false, NULL, p_cor);
    IF v_id IS NULL THEN RETURN NULL; END IF;
    v_exato := (SELECT v.ano IS NULL FROM winecatalog.vinhos v WHERE v.id = v_id);
  ELSE
    v_id := winecatalog.achar(p_nome, COALESCE(p_produtor,''), p_ano, true, NULL, p_cor);
  END IF;
  IF v_id IS NULL THEN
    v_exato := false;
    v_id := winecatalog.achar(p_nome, COALESCE(p_produtor,''), p_ano, false, NULL, p_cor);
  END IF;
  IF v_id IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO r FROM winecatalog.vinhos v WHERE v.id = v_id;
  IF r.id IS NULL THEN RETURN NULL; END IF;

  v_outra := p_ano IS NOT NULL AND r.ano IS DISTINCT FROM p_ano;

  v_ficha := r.ficha;
  v_orig  := r.origens;
  FOR k IN SELECT key FROM jsonb_each(r.ficha) LOOP
    IF (v_outra AND winecatalog.da_colheita(k))
       OR (winecatalog.volatil(k)
           AND COALESCE((r.origens -> k ->> 'em')::timestamptz, r.criado_em) < v_corte) THEN
      v_ficha := v_ficha - k;
    END IF;
  END LOOP;

  -- A irmã tem de ser da MESMA cor da linha que responde (ou sem cor).
  IF v_exato OR p_ano IS NULL THEN
    v_cor := COALESCE(r.cor, p_cor);
    v_irmao := winecatalog.achar(p_nome, COALESCE(p_produtor,''), p_ano, false, r.id, v_cor);
    IF v_irmao IS NOT NULL THEN
      SELECT * INTO r2 FROM winecatalog.vinhos v WHERE v.id = v_irmao;
      FOR k IN SELECT key FROM jsonb_each(r2.ficha) LOOP
        IF NOT winecatalog.da_colheita(k) AND NOT (v_ficha ? k)
           AND NOT (winecatalog.volatil(k)
                    AND COALESCE((r2.origens -> k ->> 'em')::timestamptz, r2.criado_em) < v_corte) THEN
          v_ficha := v_ficha || jsonb_build_object(k, r2.ficha -> k);
          v_orig  := v_orig  || jsonb_build_object(k, COALESCE(r2.origens -> k, '{}'::jsonb));
          v_empr  := v_empr  || to_jsonb(k);
        END IF;
      END LOOP;
    END IF;
  END IF;

  UPDATE winecatalog.vinhos v SET visto_em = now() WHERE v.id = r.id;

  RETURN jsonb_build_object(
    'chave',    r.chave,
    'nome',     r.nome,
    'produtor', r.produtor,
    'ano',      r.ano,
    'cor',      r.cor,
    'ficha',    v_ficha,
    'origens',  v_orig,
    'fontes',   r.fontes,
    'exato',    v_exato,
    'emprestados', v_empr,
    'mesmoAno', CASE WHEN p_ano IS NULL THEN NULL ELSE NOT v_outra END,
    'atualizadoEm', r.atualizado_em
  );
END;
$$;

CREATE OR REPLACE FUNCTION winecatalog.procurar_lote(
  p_pedidos jsonb, p_idade_dias integer DEFAULT 30
) RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT COALESCE(jsonb_agg(
           winecatalog.procurar(
             p ->> 'nome', COALESCE(p ->> 'produtor', ''),
             CASE WHEN jsonb_typeof(p -> 'ano') = 'number' THEN (p ->> 'ano')::integer END,
             p_idade_dias,
             COALESCE(p ->> 'cor', p ->> 'tipo')
           ) ORDER BY i
         ), '[]'::jsonb)
    FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(p_pedidos) = 'array' THEN p_pedidos ELSE '[]'::jsonb END
         ) WITH ORDINALITY AS t(p, i);
$$;
REVOKE ALL ON FUNCTION winecatalog.procurar(text, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION winecatalog.procurar(text, text, integer, integer, text) TO service_role;

-- ---------------------------------------------------------------------
-- CRIAR: a cor passa a ser obrigatória (o `tipo` dos campos, ou a cor
-- escrita no nome).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.criar(
  p_nome text,
  p_produtor text DEFAULT '',
  p_ano integer DEFAULT NULL,
  p_campos jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_nome    text := btrim(COALESCE(p_nome, ''));
  v_prod    text := COALESCE(p_produtor, '');
  v_tipo    text := CASE WHEN jsonb_typeof(p_campos) = 'object' THEN p_campos ->> 'tipo' END;
  v_idt     jsonb;
  v_existe  bigint;
  v_id      bigint;
  v_ficha   jsonb := '{}'::jsonb;
  v_origens jsonb := '{}'::jsonb;
  k text; v jsonb; v_f integer;
BEGIN
  IF NOT (winecatalog.sou_admin() OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'Só o admin do catálogo pode criar uma linha.';
  END IF;
  IF v_nome = '' THEN
    RAISE EXCEPTION 'Um vinho novo precisa de um nome.';
  END IF;
  v_idt := winecatalog.identidade(v_nome, v_prod, p_ano, v_tipo, true);
  IF v_idt ->> 'cor' IS NULL THEN
    RAISE EXCEPTION 'Falta a cor — é parte da identidade do vinho.';
  END IF;
  IF COALESCE(v_idt ->> 'chave_base', '') = '' THEN
    RAISE EXCEPTION 'Esse nome não deixa identidade nenhuma — não distingue este vinho de mais nenhum.';
  END IF;

  v_existe := winecatalog.achar(v_nome, v_prod, p_ano, true, NULL, v_idt ->> 'cor');
  IF v_existe IS NOT NULL THEN
    RAISE EXCEPTION 'Já existe uma linha para este vinho e colheita — é a #%. Abre-a em vez de criar outra.', v_existe;
  END IF;

  IF COALESCE(v_tipo, '') = '' THEN
    p_campos := COALESCE(p_campos, '{}'::jsonb) || jsonb_build_object('tipo', winecatalog.tipo_da_cor(v_idt ->> 'cor'));
  END IF;
  IF p_campos IS NOT NULL AND jsonb_typeof(p_campos) = 'object' THEN
    FOR k, v IN SELECT key, value FROM jsonb_each(p_campos) LOOP
      CONTINUE WHEN k !~ '^[a-z][a-z0-9_]{0,39}$';
      IF k = 'regiao' AND jsonb_typeof(v) = 'string' THEN
        v := to_jsonb(winecatalog.normalizar_regiao(v #>> '{}'));
      END IF;
      CONTINUE WHEN winecatalog.vazio(v);
      v_f := winecatalog.forca('catalogo-admin', k);
      v_ficha   := v_ficha   || jsonb_build_object(k, v);
      v_origens := v_origens || jsonb_build_object(
        k, jsonb_build_object('o', 'catalogo-admin', 'f', v_f, 'em', now()));
    END LOOP;
  END IF;

  BEGIN
    INSERT INTO winecatalog.vinhos
      (chave, chave_base, chave_nome, base_nome, nome, produtor, ano, cor, ficha, origens)
    VALUES
      (v_idt ->> 'chave', v_idt ->> 'chave_base', v_idt ->> 'chave_nome', v_idt ->> 'base_nome',
       v_nome, v_prod, p_ano, v_idt ->> 'cor', v_ficha, v_origens)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Já existe uma linha com essa identidade — outra escrita chegou primeiro.';
  END;

  INSERT INTO winecatalog.sync_log (origem, acao, estado, quem, detalhe)
  VALUES ('app', 'criar', 'ok', auth.email(), jsonb_build_object(
    'vinho_id', v_id, 'nome', v_nome, 'produtor', v_prod, 'ano', p_ano,
    'campos', (SELECT count(*) FROM jsonb_object_keys(v_ficha))));

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

-- ---------------------------------------------------------------------
-- EDITAR: a identidade confere-se com a cor da ficha NOVA (mudar a cor é
-- mudar de vinho, e pode ir bater noutra linha).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.editar(
  p_id bigint,
  p_campos jsonb DEFAULT '{}'::jsonb,
  p_nome text DEFAULT NULL,
  p_produtor text DEFAULT NULL,
  p_ano integer DEFAULT NULL,
  p_mexer_identidade boolean DEFAULT false
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  r         winecatalog.vinhos%ROWTYPE;
  v_ficha   jsonb;
  v_origens jsonb;
  v_antes   jsonb := '{}'::jsonb;
  v_mudou   integer := 0;
  v_apagou  integer := 0;
  k         text;
  v         jsonb;
  v_f       integer;
  v_nome    text;
  v_prod    text;
  v_ano     integer;
  v_idt     jsonb;
  v_outro   bigint;
BEGIN
  IF NOT winecatalog.sou_admin() THEN
    RAISE EXCEPTION 'Só o admin do catálogo pode corrigir uma linha.';
  END IF;

  SELECT * INTO r FROM winecatalog.vinhos WHERE id = p_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Linha não encontrada.'; END IF;
  IF EXISTS (SELECT 1 FROM winecatalog.alias a WHERE a.id_de = r.id) THEN
    RAISE EXCEPTION 'Essa linha foi fundida noutra — corrige a linha que ficou.';
  END IF;

  v_ficha   := r.ficha;
  v_origens := r.origens;

  IF p_campos IS NOT NULL AND jsonb_typeof(p_campos) = 'object' THEN
    FOR k, v IN SELECT key, value FROM jsonb_each(p_campos) LOOP
      CONTINUE WHEN k !~ '^[a-z][a-z0-9_]{0,39}$';
      IF k = 'regiao' AND jsonb_typeof(v) = 'string' THEN
        v := to_jsonb(winecatalog.normalizar_regiao(v #>> '{}'));
      END IF;
      CONTINUE WHEN winecatalog.igual(v_ficha -> k, v)
                    AND (v_ficha ? k) = NOT winecatalog.vazio(v);
      -- a cor é obrigatória: não se apaga, troca-se
      IF k = 'tipo' AND winecatalog.vazio(v) THEN
        RAISE EXCEPTION 'A cor não pode ficar vazia — é parte da identidade do vinho.';
      END IF;

      v_antes := v_antes || jsonb_build_object(k, jsonb_build_object(
        'valor',  v_ficha -> k, 'origem', v_origens -> k));

      IF winecatalog.vazio(v) THEN
        v_ficha   := v_ficha   - k;
        v_origens := v_origens - k;
        v_apagou  := v_apagou + 1;
      ELSE
        v_f := winecatalog.forca('catalogo-admin', k);
        v_ficha   := v_ficha   || jsonb_build_object(k, v);
        v_origens := v_origens || jsonb_build_object(
          k, jsonb_build_object('o', 'catalogo-admin', 'f', v_f, 'em', now()));
        v_mudou := v_mudou + 1;
      END IF;
    END LOOP;
  END IF;

  v_nome := COALESCE(NULLIF(btrim(COALESCE(p_nome, '')), ''), r.nome);
  v_prod := COALESCE(p_produtor, r.produtor);
  v_ano  := CASE WHEN p_mexer_identidade THEN p_ano ELSE COALESCE(p_ano, r.ano) END;

  -- Com a identidade mexida, OU com a cor mudada, a chave muda: confere-se.
  IF p_mexer_identidade OR (v_ficha ->> 'tipo') IS DISTINCT FROM (r.ficha ->> 'tipo') THEN
    v_idt := winecatalog.identidade(
      CASE WHEN p_mexer_identidade THEN v_nome ELSE r.nome END,
      CASE WHEN p_mexer_identidade THEN v_prod ELSE r.produtor END,
      CASE WHEN p_mexer_identidade THEN v_ano  ELSE r.ano END,
      v_ficha ->> 'tipo', true);
    IF COALESCE(v_idt ->> 'chave_base', '') = '' THEN
      RAISE EXCEPTION 'Esse nome não deixa identidade nenhuma — ficava a casar com tudo.';
    END IF;
    SELECT id INTO v_outro FROM winecatalog.vinhos WHERE chave = v_idt ->> 'chave' AND id <> r.id;
    IF v_outro IS NOT NULL THEN
      RAISE EXCEPTION 'Assim esta linha passa a ser a mesma que a #% — junta-as no ecrã de Duplicados em vez de a reescrever aqui.', v_outro;
    END IF;
  END IF;

  IF p_mexer_identidade THEN
    UPDATE winecatalog.vinhos SET
      nome = v_nome, produtor = COALESCE(v_prod,''), ano = v_ano
    WHERE id = r.id;
  END IF;

  UPDATE winecatalog.vinhos
     SET ficha = v_ficha, origens = v_origens,
         atualizado_em = CASE WHEN v_mudou + v_apagou > 0 THEN now() ELSE atualizado_em END
   WHERE id = r.id;

  IF v_mudou + v_apagou > 0 OR p_mexer_identidade THEN
    INSERT INTO winecatalog.sync_log (origem, acao, estado, quem, detalhe)
    VALUES ('app', 'editar', 'ok', auth.email(), jsonb_build_object(
      'vinho_id', r.id, 'campos', v_mudou, 'apagados', v_apagou,
      'antes', v_antes, 'depois', p_campos,
      'identidade', CASE WHEN p_mexer_identidade
        THEN jsonb_build_object('nome', v_nome, 'produtor', v_prod, 'ano', v_ano) END));
  END IF;

  RETURN jsonb_build_object('ok', true, 'campos', v_mudou, 'apagados', v_apagou);
END;
$$;

-- ---------------------------------------------------------------------
-- COMPARAR: a cor de quem pergunta vem na ficha dele (`tipo`).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.comparar(
  p_nome text, p_produtor text DEFAULT '', p_ano integer DEFAULT NULL,
  p_ficha jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_id  bigint;
  r     winecatalog.vinhos%ROWTYPE;
  v_res jsonb;
  v_cor text := CASE WHEN jsonb_typeof(p_ficha) = 'object' THEN p_ficha ->> 'tipo' END;
BEGIN
  IF COALESCE(auth.email(), '') = '' AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Precisa de sessão iniciada.';
  END IF;
  IF COALESCE(btrim(COALESCE(p_nome,'')), '') = '' THEN RETURN NULL; END IF;

  IF p_ano IS NOT NULL THEN
    v_id := winecatalog.achar(p_nome, COALESCE(p_produtor,''), p_ano, true, NULL, v_cor);
  END IF;
  v_id := COALESCE(v_id, winecatalog.achar(p_nome, COALESCE(p_produtor,''), p_ano, false, NULL, v_cor));
  IF v_id IS NULL THEN
    RETURN jsonb_build_object('encontrado', false);
  END IF;
  SELECT * INTO r FROM winecatalog.vinhos WHERE id = v_id;
  IF r.id IS NULL THEN RETURN jsonb_build_object('encontrado', false); END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x ->> 'campo'), '[]'::jsonb) INTO v_res
    FROM (
      SELECT jsonb_build_object(
               'campo',    k,
               'catalogo', r.ficha -> k,
               'meu',      p_ficha -> k,
               'origem',   r.origens -> k ->> 'o',
               'forca',    COALESCE((r.origens -> k ->> 'f')::integer, 0),
               'em',       r.origens -> k ->> 'em',
               'difere',      NOT winecatalog.vazio(p_ficha -> k)
                              AND NOT winecatalog.vazio(r.ficha -> k)
                              AND NOT winecatalog.igual(p_ficha -> k, r.ficha -> k),
               'soCatalogo',  winecatalog.vazio(p_ficha -> k)
                              AND NOT winecatalog.vazio(r.ficha -> k),
               'soMeu',       NOT winecatalog.vazio(p_ficha -> k)
                              AND winecatalog.vazio(r.ficha -> k)
             ) AS x
        FROM (SELECT jsonb_object_keys(r.ficha) AS k
              UNION
              SELECT jsonb_object_keys(COALESCE(p_ficha,'{}'::jsonb))) ks
       WHERE NOT (k IN ('beber_de', 'beber_ate')
                  AND NOT COALESCE(r.ano = p_ano, false))
    ) y
   WHERE (x ->> 'difere')::boolean OR (x ->> 'soCatalogo')::boolean;

  RETURN jsonb_build_object(
    'encontrado', true,
    'id', r.id,
    'nome', r.nome, 'produtor', r.produtor, 'ano', r.ano, 'cor', r.cor,
    'mesmaColheita', (r.ano IS NOT DISTINCT FROM p_ano),
    'campos', v_res);
END;
$$;

-- ---------------------------------------------------------------------
-- COLHEITAS: as linhas que são ESTE vinho (todas as colheitas), pela mesma
-- regra da `achar` — com a cor na chave, já não é preciso tirá-la à mão.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.colheitas(
  p_nome text, p_produtor text DEFAULT '', p_tipo text DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF COALESCE(auth.email(), '') = '' AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Precisa de sessão iniciada.';
  END IF;
  IF btrim(COALESCE(p_nome,'')) = '' THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    WITH q AS MATERIALIZED (
      SELECT winecatalog.chave_base(p_nome, COALESCE(p_produtor,''))  AS b,
             winecatalog.base_nome(p_nome)                            AS bn,
             COALESCE(winecatalog.cor_de(p_tipo), winecatalog.cor_do_nome(p_nome)) AS c,
             winecatalog.tokens(regexp_replace(COALESCE(winecatalog.produtor_oficial(p_produtor),''), '\s*\([^)]*\)', ' ', 'g')) AS pt
    ),
    cand AS (
      SELECT DISTINCT COALESCE(a.id_para, v.id) AS id
        FROM q, winecatalog.vinhos v
        LEFT JOIN winecatalog.alias a ON a.id_de = v.id
       WHERE q.b <> ''
         AND (v.chave_base = q.b
              OR (q.bn IS NOT NULL AND v.chave_base = q.bn)
              OR (v.base_nome IS NOT NULL AND v.base_nome IN (q.b, q.bn)))
         AND (q.c IS NULL OR v.cor IS NULL OR v.cor = q.c)
    ),
    -- O PRODUTOR ajuda como um "contém": se algum candidato bate, ficam
    -- só esses; se nenhum bate, ficam todos.
    marc AS (
      SELECT v, (cardinality(q.pt) = 0 OR COALESCE(v.produtor,'') = ''
                 OR q.pt <@ winecatalog.tokens(v.produtor)
                 OR winecatalog.tokens(v.produtor) <@ q.pt) AS bate
        FROM q, cand JOIN winecatalog.vinhos v ON v.id = cand.id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', (m.v).id, 'nome', (m.v).nome, 'produtor', (m.v).produtor, 'ano', (m.v).ano,
             'tipo', (m.v).ficha ->> 'tipo', 'cor', (m.v).cor,
             'castas', (m.v).ficha -> 'castas',
             'regiao', (m.v).ficha ->> 'regiao',
             'campos', (SELECT count(*) FROM jsonb_object_keys((m.v).ficha)),
             'vivino_nota', (m.v).ficha -> 'vivino_nota',
             'vivino_nota_global', (m.v).ficha -> 'vivino_nota_global',
             'produtorBate', m.bate)
           ORDER BY m.bate DESC, (m.v).ano DESC NULLS LAST, (m.v).id), '[]'::jsonb)
      FROM marc m
     WHERE m.bate OR NOT EXISTS (SELECT 1 FROM marc x WHERE x.bate)
  );
END;
$$;

-- ---------------------------------------------------------------------
-- CANDIDATOS a duplicado: duas cores conhecidas e diferentes nunca são
-- par; e duas linhas com a MESMA chave de nome e cor compatível são
-- sempre par (é o que sobra do recálculo das chaves, abaixo).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.candidatos(p_limite integer DEFAULT 40)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_lim integer := LEAST(GREATEST(COALESCE(p_limite, 40), 1), 200);
  v_res jsonb;
BEGIN
  IF NOT winecatalog.pode_ler() THEN
    RAISE EXCEPTION 'Sem acesso ao catálogo.';
  END IF;

  WITH linhas AS (
    SELECT v.*,
           string_to_array(v.chave_base, '-') AS toks,
           winecatalog.tokens_id(v.nome)      AS toks_nome
      FROM winecatalog.vinhos v
     WHERE NOT EXISTS (SELECT 1 FROM winecatalog.alias a WHERE a.id_de = v.id)
  ), pares AS (
    SELECT a.id AS id_a, b.id AS id_b,
           a.chave AS chave_a, b.chave AS chave_b,
           a.chave_base = b.chave_base AS igual,
           cardinality(ARRAY(SELECT unnest(a.toks) INTERSECT SELECT unnest(b.toks))) AS comuns,
           LEAST(cardinality(a.toks), cardinality(b.toks)) AS menor,
           ARRAY(SELECT t FROM (
                   SELECT unnest(a.toks_nome) INTERSECT SELECT unnest(b.toks_nome)
                 ) x(t)
                  WHERE NOT winecatalog.generico(t)) AS fortes
      FROM linhas a
      JOIN linhas b
        ON b.id > a.id
       AND b.ano IS NOT DISTINCT FROM a.ano
       AND (a.cor IS NULL OR b.cor IS NULL OR a.cor = b.cor)
  ), filtrados AS (
    SELECT p.*, CASE WHEN p.igual THEN 1 ELSE round(p.comuns::numeric / NULLIF(p.menor, 0), 2) END AS sobreposicao
      FROM pares p
     WHERE (p.igual
            OR (cardinality(p.fortes) >= 1
                AND p.comuns >= 2
                AND p.menor > 0
                AND p.comuns::numeric / p.menor >= 0.6))
       AND NOT EXISTS (
             SELECT 1 FROM winecatalog.distintos d
              WHERE d.chave_a = LEAST(p.chave_a, p.chave_b)
                AND d.chave_b = GREATEST(p.chave_a, p.chave_b))
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'comuns',       f.comuns,
           'sobreposicao', f.sobreposicao,
           'fortes',       to_jsonb(f.fortes),
           'a', winecatalog.resumo_linha(va.*),
           'b', winecatalog.resumo_linha(vb.*)
         ) ORDER BY f.igual DESC, f.sobreposicao DESC, f.comuns DESC), '[]'::jsonb)
    INTO v_res
    FROM (SELECT * FROM filtrados ORDER BY igual DESC, sobreposicao DESC, comuns DESC LIMIT v_lim) f
    JOIN winecatalog.vinhos va ON va.id = f.id_a
    JOIN winecatalog.vinhos vb ON vb.id = f.id_b;

  RETURN v_res;
END;
$$;

-- ---------------------------------------------------------------------
-- O RECÁLCULO de todas as chaves (idempotente: correr outra vez não muda
-- nada). A cor entra (da ficha, senão do nome); as palavras de cor saem.
-- Os NOMES não mudam aqui (isso é a simulação do painel). Quando duas
-- linhas ficam com a mesma chave, a mais preenchida fica com ela e a outra
-- mantém a antiga — e vai aos Duplicados. As chaves que a `alias` e a
-- `distintos` guardam acompanham a mudança.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.cor_na_chave_recalcular()
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  r       record;
  v_idt   jsonb;
  n       integer := 0;
  v_dup   jsonb := '[]'::jsonb;
BEGIN
  IF NOT (COALESCE(auth.role(), '') IN ('service_role', '') OR winecatalog.sou_admin()) THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  CREATE TEMP TABLE IF NOT EXISTS _mapa_chaves (antiga text PRIMARY KEY, nova text) ON COMMIT DROP;
  DELETE FROM _mapa_chaves;

  PERFORM set_config('winecatalog.quem', 'cor na chave', true);
  FOR r IN
    SELECT v.* FROM winecatalog.vinhos v
     ORDER BY (SELECT count(*) FROM jsonb_object_keys(v.ficha)) DESC, v.id
  LOOP
    v_idt := winecatalog.identidade(r.nome, r.produtor, r.ano, r.ficha ->> 'tipo', false);
    CONTINUE WHEN COALESCE(v_idt ->> 'chave_base', '') = '';
    IF r.chave <> v_idt ->> 'chave'
       AND EXISTS (SELECT 1 FROM winecatalog.vinhos o WHERE o.chave = v_idt ->> 'chave' AND o.id <> r.id) THEN
      v_dup := v_dup || jsonb_build_object('id', r.id, 'nome', r.nome, 'ano', r.ano, 'cor', v_idt ->> 'cor',
                 'com', (SELECT o.id FROM winecatalog.vinhos o WHERE o.chave = v_idt ->> 'chave' AND o.id <> r.id));
      -- as chaves de procura acompanham (é o que o põe nos Duplicados); a única fica
      UPDATE winecatalog.vinhos SET cor = v_idt ->> 'cor',
             chave_base = v_idt ->> 'chave_base', chave_nome = v_idt ->> 'chave_nome', base_nome = v_idt ->> 'base_nome'
       WHERE id = r.id;
      CONTINUE;
    END IF;
    CONTINUE WHEN r.chave = v_idt ->> 'chave' AND r.cor IS NOT DISTINCT FROM v_idt ->> 'cor'
              AND r.chave_base = v_idt ->> 'chave_base'
              AND r.chave_nome IS NOT DISTINCT FROM v_idt ->> 'chave_nome'
              AND r.base_nome IS NOT DISTINCT FROM v_idt ->> 'base_nome';
    IF r.chave <> v_idt ->> 'chave' THEN
      INSERT INTO _mapa_chaves VALUES (r.chave, v_idt ->> 'chave') ON CONFLICT DO NOTHING;
    END IF;
    UPDATE winecatalog.vinhos SET
           cor = v_idt ->> 'cor',
           chave = v_idt ->> 'chave', chave_base = v_idt ->> 'chave_base',
           chave_nome = v_idt ->> 'chave_nome', base_nome = v_idt ->> 'base_nome'
     WHERE id = r.id;
    n := n + 1;
  END LOOP;

  UPDATE winecatalog.alias a SET chave_de = m.nova FROM _mapa_chaves m WHERE a.chave_de = m.antiga;
  UPDATE winecatalog.alias a SET chave_para = m.nova FROM _mapa_chaves m WHERE a.chave_para = m.antiga;
  -- a `distintos` guarda o par ordenado: reescreve-se inteira pela ordem nova
  CREATE TEMP TABLE IF NOT EXISTS _dist AS SELECT * FROM winecatalog.distintos WITH NO DATA;
  DELETE FROM _dist;
  INSERT INTO _dist SELECT * FROM winecatalog.distintos;
  UPDATE _dist d SET chave_a = m.nova FROM _mapa_chaves m WHERE d.chave_a = m.antiga;
  UPDATE _dist d SET chave_b = m.nova FROM _mapa_chaves m WHERE d.chave_b = m.antiga;
  DELETE FROM winecatalog.distintos;
  INSERT INTO winecatalog.distintos
  SELECT DISTINCT ON (LEAST(chave_a, chave_b), GREATEST(chave_a, chave_b))
         LEAST(chave_a, chave_b), GREATEST(chave_a, chave_b), quem, quando
    FROM _dist WHERE chave_a <> chave_b;
  DROP TABLE _dist;
  PERFORM set_config('winecatalog.quem', '', true);

  RETURN jsonb_build_object('ok', true, 'recalculadas', n, 'duplicados', v_dup);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.cor_na_chave_recalcular() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION winecatalog.cor_na_chave_recalcular() TO service_role;

SELECT winecatalog.cor_na_chave_recalcular();
