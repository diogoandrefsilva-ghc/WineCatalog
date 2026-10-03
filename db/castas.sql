-- ════════════════════════════════════════════════════════════════════
-- As CASTAS: uma grafia por casta (01/10/2026)
-- ════════════════════════════════════════════════════════════════════
-- No Catálogo (e nas garrafeiras) havia "Aragonez", "Aragonês" e
-- "Aragonêz" lado a lado nos filtros, cada uma a responder pelos seus
-- vinhos — e "Castelao"/"Castelão", "Sousão"/"Souzão", "Shiraz/Syrah"/
-- "Syrah", "Sauvignon blanc"/"Sauvignon Blanc", "Tinta Cão"/"Tinto Cão".
-- E entrou uma "Touriga Nacional e Merlot": duas castas escritas sem
-- vírgula, que passaram a ser uma casta só.
--
-- A regra (`normalizar_casta`, `normalizar_castas`):
--   1. uma lista separa-se também por " e ", "&", "/", "+" e ";" — não só
--      por vírgulas. Nenhuma casta tem um " e " no nome; "Shiraz/Syrah"
--      dá Shiraz + Syrah, que são a MESMA casta e ficam numa só;
--   2. a chave de comparação é sem acentos, sem maiúsculas e com os hífens
--      como espaços (`casta_chave`) — "Castelao" e "Castelão" são a mesma;
--   3. um sinónimo de GRAFIA passa ao nome de referência (a lista do IVV):
--      Aragonês → Aragonez, Souzão → Sousão, Shiraz → Syrah, Tinta Cão →
--      Tinto Cão, Alicante Bouchet → Alicante Bouschet…;
--   4. o que não é casta sai ("Vinhas Velhas" é uma menção);
--   5. uma casta desconhecida em CAPS LOCK ou toda em minúsculas passa a
--      Title Case ("do/da/de" pequenos); com mistura fica como está.
--
-- NÃO se juntam SINÓNIMOS REGIONAIS: Tinta Roriz, Aragonez e Tempranillo
-- são a mesma uva, mas o nome diz de onde é o vinho (Douro, Alentejo,
-- Espanha) e é assim que vem no rótulo. O mesmo para Trincadeira/Tinta
-- Amarela e Castelão/Periquita. Só se junta a mesma PALAVRA mal escrita.
--
-- Quem a usa: o trigger `vinhos_castas` (abaixo), em qualquer escrita da
-- ficha do catálogo; e, na Garrafeira, a `casta_id` e a `definir_castas`
-- (migração 38, `db/migracao-castas.sql` de lá). Mexer aqui mexe nas
-- castas das garrafeiras também.
--
-- Idempotente. Na Garrafeira, a seguir: a migração 38.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION winecatalog.casta_chave(p text)
  RETURNS text LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT btrim(regexp_replace(
           translate(lower(COALESCE(p, '')), 'áàâãäéèêëíìîïóòôõöúùûüç-', 'aaaaaeeeeiiiiooooouuuuc '),
           '\s+', ' ', 'g'));
$$;

-- ⚠ SUBSTITUÍDA em `castas-abreviadas.sql` (03/10/2026): a lista passou a
-- `casta_referencias()`, e é lá que se acrescenta uma casta.
-- A grafia de referência de uma casta conhecida (pela chave), ou NULL.
CREATE OR REPLACE FUNCTION winecatalog.casta_referencia(k text)
  RETURNS text LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT CASE k
    WHEN 'aragonez'             THEN 'Aragonez'      -- Aragonês, Aragonêz
    WHEN 'aragones'             THEN 'Aragonez'
    WHEN 'castelao'             THEN 'Castelão'
    WHEN 'sousao'               THEN 'Sousão'
    WHEN 'souzao'               THEN 'Sousão'
    WHEN 'syrah'                THEN 'Syrah'
    WHEN 'shiraz'               THEN 'Syrah'
    WHEN 'tinto cao'            THEN 'Tinto Cão'
    WHEN 'tinta cao'            THEN 'Tinto Cão'
    WHEN 'alicante bouschet'    THEN 'Alicante Bouschet'
    WHEN 'alicante bouchet'     THEN 'Alicante Bouschet'
    WHEN 'alicante bousquet'    THEN 'Alicante Bouschet'
    WHEN 'alfrocheiro'          THEN 'Alfrocheiro'
    WHEN 'alfrocheiro preto'    THEN 'Alfrocheiro'
    WHEN 'touriga nacional'     THEN 'Touriga Nacional'
    WHEN 'touriga franca'       THEN 'Touriga Franca'
    WHEN 'touriga francesa'     THEN 'Touriga Franca'
    WHEN 'touriga femea'        THEN 'Touriga Fêmea'
    WHEN 'tinta roriz'          THEN 'Tinta Roriz'
    WHEN 'tinta barroca'        THEN 'Tinta Barroca'
    WHEN 'tinta amarela'        THEN 'Tinta Amarela'
    WHEN 'tinta francisca'      THEN 'Tinta Francisca'
    WHEN 'tinta miuda'          THEN 'Tinta Miúda'
    WHEN 'tinta caiada'         THEN 'Tinta Caiada'
    WHEN 'tinta carvalha'       THEN 'Tinta Carvalha'
    WHEN 'tinta da barca'       THEN 'Tinta da Barca'
    WHEN 'trincadeira'          THEN 'Trincadeira'
    WHEN 'trincadeira preta'    THEN 'Trincadeira'
    WHEN 'antao vaz'            THEN 'Antão Vaz'
    WHEN 'fernao pires'         THEN 'Fernão Pires'
    WHEN 'codega do larinho'    THEN 'Códega do Larinho'
    WHEN 'jaen'                 THEN 'Jaen'
    WHEN 'baga'                 THEN 'Baga'
    WHEN 'arinto'               THEN 'Arinto'
    WHEN 'encruzado'            THEN 'Encruzado'
    WHEN 'alvarinho'            THEN 'Alvarinho'
    WHEN 'loureiro'             THEN 'Loureiro'
    WHEN 'avesso'               THEN 'Avesso'
    WHEN 'gouveio'              THEN 'Gouveio'
    WHEN 'viosinho'             THEN 'Viosinho'
    WHEN 'rabigato'             THEN 'Rabigato'
    WHEN 'roupeiro'             THEN 'Roupeiro'
    WHEN 'verdelho'             THEN 'Verdelho'
    WHEN 'malvasia fina'        THEN 'Malvasia Fina'
    WHEN 'moscatel galego branco' THEN 'Moscatel Galego Branco'
    WHEN 'cabernet sauvignon'   THEN 'Cabernet Sauvignon'
    WHEN 'cabernet franc'       THEN 'Cabernet Franc'
    WHEN 'sauvignon blanc'      THEN 'Sauvignon Blanc'
    WHEN 'chenin blanc'         THEN 'Chenin Blanc'
    WHEN 'petit verdot'         THEN 'Petit Verdot'
    WHEN 'pinot noir'           THEN 'Pinot Noir'
    WHEN 'merlot'               THEN 'Merlot'
    WHEN 'chardonnay'           THEN 'Chardonnay'
    WHEN 'viognier'             THEN 'Viognier'
    WHEN 'field blend'          THEN 'Field Blend'
  END;
$$;

-- ⚠ SUBSTITUÍDA em `castas-abreviadas.sql` (03/10/2026, "T. Nacional").
-- Uma casta (UM nome, já separado), normalizada — ou NULL se não é casta.
CREATE OR REPLACE FUNCTION winecatalog.normalizar_casta(p_casta text)
  RETURNS text LANGUAGE plpgsql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v      text := btrim(regexp_replace(COALESCE(p_casta, ''), '\s+', ' ', 'g'), ' .');
  k      text := winecatalog.casta_chave(p_casta);
  small  text[] := ARRAY['de','da','do','das','dos','e'];
  words  text[];
  out_arr text[] := '{}';
  i      integer;
BEGIN
  IF v = '' OR k = '' THEN RETURN NULL; END IF;
  -- 4. O que não é casta.
  IF k IN ('vinhas velhas', 'varias castas', 'varias', 'outras', 'outras castas',
           'castas tradicionais', 'n d', 'nd') THEN
    RETURN NULL;
  END IF;
  -- 3. A grafia de referência.
  IF winecatalog.casta_referencia(k) IS NOT NULL THEN
    RETURN winecatalog.casta_referencia(k);
  END IF;
  -- 5. Uma desconhecida: só as maiúsculas, e só quando são TODAS iguais.
  IF v <> upper(v) AND v <> lower(v) THEN RETURN v; END IF;
  words := regexp_split_to_array(lower(v), ' ');
  FOR i IN 1..array_length(words, 1) LOOP
    IF i > 1 AND words[i] = ANY(small) THEN
      out_arr := out_arr || words[i];
    ELSE
      out_arr := out_arr || (upper(substring(words[i] FROM 1 FOR 1)) || substring(words[i] FROM 2));
    END IF;
  END LOOP;
  RETURN array_to_string(out_arr, ' ');
END;
$$;

-- Uma LISTA de castas: separa o que vinha colado, normaliza cada uma, tira
-- o que não é casta e as repetidas (pela chave), mantendo a ordem.
CREATE OR REPLACE FUNCTION winecatalog.normalizar_castas(p_castas text[])
  RETURNS text[] LANGUAGE plpgsql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  x      text;
  p      text;
  n      text;
  chaves text[] := '{}';
  out_arr text[] := '{}';
BEGIN
  FOREACH x IN ARRAY COALESCE(p_castas, ARRAY[]::text[]) LOOP
    FOR p IN SELECT regexp_split_to_table(COALESCE(x, ''), '\s*[,;/+&]\s*|\s+[eE]\s+') LOOP
      n := winecatalog.normalizar_casta(p);
      IF n IS NOT NULL AND NOT (winecatalog.casta_chave(n) = ANY(chaves)) THEN
        chaves  := chaves  || winecatalog.casta_chave(n);
        out_arr := out_arr || n;
      END IF;
    END LOOP;
  END LOOP;
  RETURN out_arr;
END;
$$;

-- A mesma, para o `ficha -> 'castas'` (uma lista em JSON; um texto também
-- se aceita, que já houve fichas com "Touriga Nacional, Syrah" numa string).
CREATE OR REPLACE FUNCTION winecatalog.normalizar_castas_json(p jsonb)
  RETURNS jsonb LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT CASE jsonb_typeof(p)
    WHEN 'array'  THEN to_jsonb(winecatalog.normalizar_castas(
                         ARRAY(SELECT jsonb_array_elements_text(p))))
    WHEN 'string' THEN to_jsonb(winecatalog.normalizar_castas(ARRAY[p #>> '{}']))
    ELSE p
  END;
$$;

-- ---------------------------------------------------------------------
-- O trigger: em QUALQUER escrita da ficha (juntar, editar, criar, os
-- scripts, a fusão de duplicados) as castas ficam normalizadas. Um sítio
-- só, em vez de uma chamada em cada porta — as portas são muitas e uma
-- esquecida bastava para voltar a nascer um "Aragonês".
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.vinhos_castas()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  n jsonb;
BEGIN
  IF NEW.ficha IS NULL OR (NEW.ficha -> 'castas') IS NULL THEN RETURN NEW; END IF;
  n := winecatalog.normalizar_castas_json(NEW.ficha -> 'castas');
  IF n = '[]'::jsonb THEN
    NEW.ficha := NEW.ficha - 'castas';
  ELSIF n IS DISTINCT FROM NEW.ficha -> 'castas' THEN
    NEW.ficha := jsonb_set(NEW.ficha, '{castas}', n);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;   -- arrumar é um extra: nunca deita uma escrita abaixo
END;
$$;

CREATE OR REPLACE TRIGGER vinhos_castas
  BEFORE INSERT OR UPDATE OF ficha ON winecatalog.vinhos
  FOR EACH ROW EXECUTE FUNCTION winecatalog.vinhos_castas();

-- A Garrafeira chama estas funções com o papel de quem tem sessão.
GRANT EXECUTE ON FUNCTION winecatalog.casta_chave(text)              TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION winecatalog.normalizar_casta(text)         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION winecatalog.casta_referencia(text)         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION winecatalog.normalizar_castas(text[])      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION winecatalog.normalizar_castas_json(jsonb)  TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- O que já estava escrito. Não mexe em `origens` nem em `atualizado_em`:
-- é arrumar o valor que lá estava, não uma escrita nova. O histórico fica
-- com uma linha por vinho, assinada "castas: normalização".
-- ---------------------------------------------------------------------
DO $$
BEGIN
  PERFORM set_config('winecatalog.quem', 'castas: normalização', true);
  UPDATE winecatalog.vinhos
     SET ficha = CASE WHEN winecatalog.normalizar_castas_json(ficha -> 'castas') = '[]'::jsonb
                      THEN ficha - 'castas'
                      ELSE jsonb_set(ficha, '{castas}', winecatalog.normalizar_castas_json(ficha -> 'castas')) END
   WHERE (ficha -> 'castas') IS NOT NULL
     AND winecatalog.normalizar_castas_json(ficha -> 'castas') IS DISTINCT FROM ficha -> 'castas';
  PERFORM set_config('winecatalog.quem', '', true);
END;
$$;
