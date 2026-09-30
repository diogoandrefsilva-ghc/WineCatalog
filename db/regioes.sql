-- ════════════════════════════════════════════════════════════════════
-- As REGIÕES: os sinónimos passam à região a sério (30/09/2026)
-- ════════════════════════════════════════════════════════════════════
-- Nas garrafeiras e no catálogo entraram "Alentejano", "Évora",
-- "Evoramonte", "Terras do Sado", "DOC Douro" — e cada um respondia por uma
-- faceta própria nos filtros, ao lado de "Alentejo" e de "Setúbal". Nenhum
-- é uma região:
--   * "Alentejano", "Duriense", "Transmontano", "Terras do Sado"… são os
--     nomes dos VINHOS REGIONAIS (a classificação, que tem campo próprio);
--   * "Évora", "Redondo", "Borba"… são SUB-REGIÕES do Alentejo DOC, e
--     "Evoramonte"/"Estremoz" são terras dentro dele;
--   * "DOC Douro" é a região com a classificação colada.
--
-- Até aqui a `normalizar_regiao` só arrumava as maiúsculas e a Península de
-- Setúbal. Agora conhece estes sinónimos, e a `subregiao_de` diz que
-- sub-região um desses valores trazia — para não se perder o "Évora" quando
-- a região passa a "Alentejo". Quem a usa é o trigger da Garrafeira
-- (`db/migracao-regiao.sql` de lá), que enche a `sub_regiao` quando está
-- vazia; do lado do catálogo, a correção dos dados (no fim deste ficheiro)
-- faz o mesmo na ficha. As portas do catálogo (`juntar`, `editar`,
-- `criar`) continuam só a normalizar a região — uma sub-região vazia na
-- ficha enche-se pela garrafeira que a tem.
--
-- NÃO entra nos sinónimos o que é ambíguo: "Beiras" pode ser Dão, Bairrada
-- ou Beira Interior, "Beira Atlântico" também — esses corrigem-se à mão.
--
-- Substitui a `normalizar_regiao` do `catalogo.sql` (esta é a versão que
-- vale). Idempotente. Na Garrafeira, a seguir: `db/migracao-regiao.sql` e a
-- migração 37 (`db/migracao-regioes-sinonimos.sql`).
-- ---------------------------------------------------------------------

-- A chave de comparação: minúsculas, sem acentos, hífens como espaços, e
-- sem a classificação à frente ou atrás ("DOC Douro", "Douro DOC",
-- "Vinho Regional Alentejano", "IGP Lisboa").
CREATE OR REPLACE FUNCTION winecatalog.regiao_chave(p text)
  RETURNS text LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT btrim(regexp_replace(regexp_replace(
           translate(lower(COALESCE(p, '')), 'áàâãäéèêëíìîïóòôõöúùûüç-', 'aaaaaeeeeiiiiooooouuuuc '),
           '^\s*(doc|dop|igp|ig|vinho regional)\s+|\s+(doc|dop|igp)\s*$', '', 'g'),
         '\s+', ' ', 'g'));
$$;

-- A sub-região que um valor de REGIÃO trazia, ou NULL. Só as do Alentejo DOC
-- (e as terras que as pessoas escrevem no lugar delas) e Palmela, na de
-- Setúbal: são as que aparecem escritas como região.
CREATE OR REPLACE FUNCTION winecatalog.subregiao_de(p_regiao text)
  RETURNS text LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT CASE winecatalog.regiao_chave(p_regiao)
    WHEN 'evora'               THEN 'Évora'
    WHEN 'borba'               THEN 'Borba'
    WHEN 'redondo'             THEN 'Redondo'
    WHEN 'reguengos'           THEN 'Reguengos'
    WHEN 'reguengos de monsaraz' THEN 'Reguengos'
    WHEN 'vidigueira'          THEN 'Vidigueira'
    WHEN 'portalegre'          THEN 'Portalegre'
    WHEN 'moura'               THEN 'Moura'
    WHEN 'granja amareleja'    THEN 'Granja-Amareleja'
    WHEN 'evoramonte'          THEN 'Evoramonte'
    WHEN 'estremoz'            THEN 'Estremoz'
    WHEN 'palmela'             THEN 'Palmela'
  END;
$$;

-- ---------------------------------------------------------------------
-- A REGIÃO, normalizada — "DOURO" e "Douro" não podem responder por
-- facetas diferentes no Catálogo, nem "Alentejano" e "Alentejo".
--
-- Três regras:
--   1. um sinónimo passa à região a sério (Vinho Regional, sub-região, a
--      classificação colada — ver o cabeçalho);
--   2. um valor todo em CAPS LOCK ou todo em minúsculas passa a Title
--      Case. Não se toca em mais nada: "Beira Interior" e
--      "Trás-os-Montes" já estão certos, e um `initcap()` ingénuo
--      estragava o hífen e as preposições;
--   3. uma região vazia devolve NULL — o trigger da Garrafeira guarda `''`,
--      que a coluna de lá é NOT NULL.
--
-- Chamada em CADA sítio por onde uma região pode entrar no catálogo —
-- `juntar` (garrafeira/pesquisa) e `editar`/`criar` (admin) — e pelo
-- trigger `vinhos_normalizar_regiao` da Garrafeira: mexer aqui mexe na
-- região das garrafeiras também.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.normalizar_regiao(p_regiao text)
  RETURNS text LANGUAGE plpgsql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v      text := btrim(regexp_replace(COALESCE(p_regiao, ''), '\s+', ' ', 'g'));
  k      text;
  v_low  text;
  small  text[] := ARRAY['de','da','do','das','dos','e'];
  words  text[];
  out_arr text[] := '{}';
  i      integer;
BEGIN
  IF v = '' THEN RETURN NULL; END IF;
  k := winecatalog.regiao_chave(v);
  IF k = '' THEN RETURN NULL; END IF;

  -- 1. Os sinónimos.
  IF k IN ('alentejo', 'alentejano') THEN RETURN 'Alentejo'; END IF;
  IF k IN ('setubal', 'peninsula de setubal', 'terras do sado') THEN RETURN 'Setúbal'; END IF;
  IF winecatalog.subregiao_de(v) = 'Palmela' THEN RETURN 'Setúbal'; END IF;
  IF winecatalog.subregiao_de(v) IS NOT NULL THEN RETURN 'Alentejo'; END IF;
  IF k IN ('douro', 'duriense') THEN RETURN 'Douro'; END IF;
  IF k IN ('tras os montes', 'transmontano') THEN RETURN 'Trás-os-Montes'; END IF;
  IF k IN ('tejo', 'ribatejo', 'ribatejano') THEN RETURN 'Tejo'; END IF;
  IF k IN ('lisboa', 'estremadura') THEN RETURN 'Lisboa'; END IF;
  IF k IN ('vinho verde', 'minho') THEN RETURN 'Vinho Verde'; END IF;
  IF k IN ('dao', 'terras do dao') THEN RETURN 'Dão'; END IF;
  IF k IN ('beira interior', 'terras da beira') THEN RETURN 'Beira Interior'; END IF;
  IF k IN ('algarve', 'algarvio') THEN RETURN 'Algarve'; END IF;
  IF k = 'bairrada' THEN RETURN 'Bairrada'; END IF;

  -- 2. As maiúsculas. Só se mexe quando o valor é TUDO maiúsculas ou TUDO
  -- minúsculas — um valor já com mistura das duas ("Beira Interior",
  -- "Castilla y León") está certo.
  IF v <> upper(v) AND v <> lower(v) THEN
    RETURN v;
  END IF;

  v_low := lower(v);
  words := regexp_split_to_array(v_low, ' ');
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

-- ---------------------------------------------------------------------
-- O que já estava escrito no catálogo. A sub-região que a região trazia
-- ("Évora") passa para a `sub_regiao` da ficha quando essa está vazia. Não
-- mexe em `origens` nem em `atualizado_em`, como a
-- `migracao-normalizar-regioes.sql`: é arrumar o valor que lá estava, não
-- uma escrita nova. Idempotente.
-- ---------------------------------------------------------------------
UPDATE winecatalog.vinhos
   SET ficha = ficha || jsonb_build_object('sub_regiao', winecatalog.subregiao_de(ficha->>'regiao'))
 WHERE winecatalog.subregiao_de(ficha->>'regiao') IS NOT NULL
   AND COALESCE(btrim(ficha->>'sub_regiao'), '') = '';

UPDATE winecatalog.vinhos
   SET ficha = jsonb_set(ficha, '{regiao}', to_jsonb(winecatalog.normalizar_regiao(ficha->>'regiao')))
 WHERE ficha ? 'regiao'
   AND ficha->>'regiao' IS DISTINCT FROM winecatalog.normalizar_regiao(ficha->>'regiao')
   AND winecatalog.normalizar_regiao(ficha->>'regiao') IS NOT NULL;

-- "Beiras" é ambíguo e não entra na regra — mas com a sub-região escrita
-- deixa de o ser: Silgueiros (e as outras do Dão DOC) é Dão, e "Bairrada"
-- é a própria região. Mesmo passo na Garrafeira (migração 37).
UPDATE winecatalog.vinhos
   SET ficha = jsonb_set(ficha, '{regiao}', '"Dão"')
 WHERE ficha->>'regiao' = 'Beiras'
   AND ficha->>'sub_regiao' IN ('Silgueiros', 'Alva', 'Besteiros', 'Castendo',
                                'Serra da Estrela', 'Terras de Azurara', 'Terras de Senhorim');

UPDATE winecatalog.vinhos
   SET ficha = (ficha - 'sub_regiao') || '{"regiao":"Bairrada"}'::jsonb
 WHERE ficha->>'regiao' = 'Beiras'
   AND ficha->>'sub_regiao' = 'Bairrada';
