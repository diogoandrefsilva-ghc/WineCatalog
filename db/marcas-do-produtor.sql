-- ════════════════════════════════════════════════════════════════════
-- As MARCAS de um produtor: "Quinta de Cidrô" é da Real Companhia Velha,
-- mas fica no nome do vinho (03/10/2026, o dono das apps)
-- ════════════════════════════════════════════════════════════════════
-- O dono quis que uma carta (ou quem escreva) com "Quinta de Cidrô",
-- "Quinta das Carvalhas" ou "Quinta dos Aciprestes" no PRODUTOR gravasse
-- "Real Companhia Velha" — como as outras linhas desta casa no catálogo. É
-- o que a lista dos produtores oficiais faz: as três quintas passam a
-- grafias da Real Companhia Velha (`produtor_definir`, abaixo).
--
-- Mas a `nome_normal` tira da frente do nome do vinho QUALQUER grafia do
-- produtor (é o "Duorum Vinhos Tons" → "Tons") quando o que sobra se
-- aguenta sozinho. Com
-- as quintas como grafias, "Quinta do Cidrô Sauvignon Blanc" passava a
-- "Sauvignon Blanc" e "Quinta do Cidrô Marquis" a "Marquis" na próxima
-- escrita do nome — e, com o nome mudado, a chave deixava de bater com a
-- linha que lá está, e uma pesquisa a esse vinho (a `vinho-info` escreve
-- pela `juntar`, com o nome da linha) fazia nascer um duplicado.
--
-- A diferença entre uma GRAFIA e uma MARCA está nas palavras: "Herdade do
-- Esporão" e "Esporão", "Adriano Ramos Pinto" e "Ramos Pinto", "Quinta Nova
-- de Nossa Senhora do Carmo" e "Quinta Nova" partilham uma palavra que
-- identifica a casa; "Quinta de Cidrô" e "Real Companhia Velha" não
-- partilham nenhuma — é OUTRO nome, o de uma propriedade ou de uma gama da
-- casa. Uma grafia assim troca-se pelo oficial no campo do produtor (a
-- `produtor_oficial`, como qualquer grafia), mas não entra na lista do que
-- se tira da frente do nome. A 03/10/2026 nenhuma das grafias que já lá
-- estavam era assim: só as três quintas mudam alguma coisa.
--
-- Substitui a `nome_normal` do nomes-normalizar.sql (só a lista das
-- grafias). Idempotente.
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
  no_nome  boolean;
  -- as palavras de "casa" de um nome de produtor que não dizem QUAL é
  -- (a `tokens` já tira quinta, herdade, casa, adega, monte…)
  de_casa  text[] := ARRAY['caves','cave','companhia','company','wines','family','estates','estate',
                           'cooperativa','vinicola','vitivinicola','produtores','herdeiros','filhos',
                           'irmaos','sucessores','sa','vineyards','vinhateiros','agricultores'];
  regioes  text[] := ARRAY['douro','duriense','alentejo','alentejano','dao','bairrada','tejo','lisboa',
                           'setubal','peninsula','minho','verde','verdes','madeira','porto','algarve',
                           'beira','beiras','interior','tras','montes','transmontano','tavora','varosa',
                           'palmela','colares','bucelas','carcavelos','evora','reguengos','borba',
                           'redondo','vidigueira','portalegre','moura','granja','amareleja','doc','vr',
                           'regional','ipr','preta','branca','portugal'];
BEGIN
  IF btrim(COALESCE(p_nome,'')) = '' THEN
    RETURN jsonb_build_object('nome', p_nome, 'ano', p_ano, 'nome_sem_cor', p_nome, 'mudancas', '[]'::jsonb, 'avisos', '[]'::jsonb);
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

  -- 3. O PRODUTOR à frente. As grafias possíveis: a escrita, a oficial e
  -- todas as grafias confirmadas da oficial (`escritos`, produtores.sql —
  -- "Esporão" e "Herdade do Esporão" são a mesma chave, mas não a mesma
  -- frente de um nome). Fica a mais comprida que case palavra a palavra.
  cand := ARRAY[COALESCE(p_produtor,''), COALESCE(winecatalog.produtor_oficial(p_produtor),'')];
  cand := cand || COALESCE((SELECT array_agg(e)
                              FROM winecatalog.produtor_variantes pv
                              JOIN winecatalog.produtores p ON p.id = pv.produtor_id
                              CROSS JOIN LATERAL unnest(array_prepend(pv.escrito, pv.escritos)) e
                             WHERE p.nome = winecatalog.produtor_oficial(p_produtor)
                               -- uma MARCA da casa não sai da frente do nome (marcas-do-produtor.sql)
                               AND string_to_array(pv.chave, '-')
                                   && string_to_array(winecatalog.chave_produtor(p.nome), '-')), ARRAY[]::text[]);
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
  -- Um produtor da lista do admin (`produtores_no_nome`, nomes-manter.sql)
  -- fica no nome: não sai da frente e, se lá não estiver, ENTRA à frente
  -- ("1836 Grande Reserva" → "Companhia das Lezírias 1836 Grande Reserva";
  -- 28/09/2026, o dono: "nos vinhos deste produtor, o nome do produtor deve
  -- aparecer no nome do vinho"). "Estar lá" é o nome ter uma palavra que
  -- DIGA o produtor, de qualquer grafia dele: "Primavera Reserva" já diz a
  -- Caves Primavera (o "caves" não diz qual é). Entra o nome oficial, sem o
  -- parêntesis.
  no_nome := winecatalog.produtor_no_nome(p_produtor);
  IF no_nome THEN
    IF melhor = 0 AND NOT EXISTS (
         SELECT 1 FROM unnest(cand) x
          WHERE winecatalog.chave_produtor(x) <> ''
            AND (string_to_array(winecatalog.chave_produtor(x), '-') <@ winecatalog.tokens(array_to_string(w, ' '))
                 OR EXISTS (SELECT 1 FROM unnest(string_to_array(winecatalog.chave_produtor(x), '-')) t
                             WHERE t <> ALL (de_casa) AND NOT winecatalog.generico(t) AND t <> ALL (regioes)
                               AND t = ANY (winecatalog.tokens(array_to_string(w, ' ')))))) THEN
      c := btrim(regexp_replace(regexp_replace(
             COALESCE(NULLIF(btrim(winecatalog.produtor_oficial(p_produtor)), ''), btrim(p_produtor)),
             '\s*\([^)]*\)', ' ', 'g'), '\s+', ' ', 'g'));
      IF c <> '' AND winecatalog.palavra_norm(c) <> winecatalog.palavra_norm(array_to_string(w, ' ')) THEN
        w := regexp_split_to_array(c, ' ') || w;
        mud := array_append(mud, 'produtor_entra');
      END IF;
    END IF;
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
    'avisos', to_jsonb(avisos));
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.nome_normal(text, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.nome_normal(text, text, text, integer) TO authenticated, service_role;

-- ── As três quintas da Real Companhia Velha ────────────────────────────
-- Uma decisão do admin, como as do ecrã dos Produtores: corre-se como ele
-- (a `produtor_definir` confirma o `sou_admin()`), e foi o que se fez a
-- 03/10/2026, pelo SQL, com o email do admin na sessão:
--
--   SELECT winecatalog.produtor_definir('Real Companhia Velha',
--     ARRAY['Quinta de Cidrô', 'Quinta do Cidrô', 'Quinta das Carvalhas',
--           'Quinta dos Aciprestes']);
--
-- Nesse dia não mudou nenhum produtor (as linhas destas quintas já diziam
-- "Real Companhia Velha", e os vinhos das garrafeiras também). Conferido
-- antes de aplicar, numa transação desfeita: com as quintas como grafias e
-- a `nome_normal` antiga, sete nomes perdiam a quinta (o "Quinta do Cidrô
-- Marquis", o "…Sauvignon Blanc", o "…Gewurztraminer", no catálogo e numa
-- garrafeira); com esta, nenhum dos 617 nomes muda. E uma carta com
-- "Qt.ª de Cidrô Marquis" e o produtor "Qt.ª de Cidrô" grava "Quinta de
-- Cidrô Marquis" da Real Companhia Velha, e liga ao #194 — antes ficava
-- "Marquis".
