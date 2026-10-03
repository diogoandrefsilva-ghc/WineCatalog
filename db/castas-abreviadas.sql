-- ════════════════════════════════════════════════════════════════════
-- As castas ABREVIADAS: "T. Nacional" é "Touriga Nacional" (03/10/2026)
-- ════════════════════════════════════════════════════════════════════
-- A mesma carta das Sugestões do "Qt.ª" (ver `abreviaturas.sql`) escrevia
-- "Qt.ª de Cidrô T. Nacional + Cab. Sauvignon": a chave ficava com "t" e
-- "cab" onde a do vinho que lá estava ("Quinta de Cidrô Cabernet Sauvignon
-- Touriga Nacional", #115) tem "touriga" e "cabernet", e nasceu outra linha
-- (#411, que o dono renomeou à mão). O dono quis que ficasse normalizado.
--
-- A regra (`castas_por_extenso`): uma palavra curta (1 a 5 letras) acabada
-- em "." ou "ª" seguida de outra palavra é a abreviatura de uma casta de
-- referência quando essa outra palavra é a SEGUNDA da casta e a curta é o
-- princípio da PRIMEIRA — e só quando há UMA casta assim. O "T." sozinho
-- não diz nada (Touriga ou Tinta?): quem decide é a palavra a seguir.
--   "T. Nacional" / "T. Franca"                → Touriga
--   "T. Roriz" / "Tª Barroca" / "T. Francisca"  → Tinta
--   "T. Cão"                                    → Tinto Cão
--   "Cab. Sauvignon" / "C. Sauvignon"           → Cabernet Sauvignon
--   "Sauv. Blanc" / "Alic. Bouschet" / "P. Noir"…
-- "S. Lázaro", "D. Maria", "M.O.B." ficam como estão: não há casta com essa
-- segunda palavra. "do/da/de" a seguir não contam ("C. do Larinho" fica).
--
-- A lista é a da `casta_referencia` (`castas.sql`), e é UMA: passou de um
-- CASE a uma tabela de valores (`casta_referencias`), que a
-- `casta_referencia` lê e a `castas_por_extenso` também — duas listas
-- divergiam no dia em que se acrescentasse uma casta a uma só. Uma casta
-- nova de referência entra aqui, nos VALUES.
--
-- Onde vale: na CHAVE (`tokens` — é o que faz a carta achar a linha), no
-- NOME gravado (`identidade`, a seguir à "Quinta" por extenso) e nas
-- CASTAS da ficha (`normalizar_casta` — "T. Nacional" na lista das castas
-- passa a "Touriga Nacional"). Na Garrafeira a `casta_id`/`definir_castas`
-- e o trigger dos nomes já passam por estas — nada a correr do lado de lá.
--
-- A 03/10/2026 não havia nenhuma abreviatura de casta nos nomes, nos
-- produtores, nas fichas nem nas castas das garrafeiras (o #411 já tinha
-- sido renomeado); o recálculo do fim fica para outra base.
--
-- Idempotente. Depois do `castas.sql` e do `abreviaturas.sql` (substitui a
-- `casta_referencia`, a `normalizar_casta` do primeiro e a `tokens` e a
-- `identidade` do segundo).
-- ---------------------------------------------------------------------

-- A lista das castas de referência: a chave (`casta_chave`) e a grafia.
-- Era o CASE da `casta_referencia`, tal e qual.
CREATE OR REPLACE FUNCTION winecatalog.casta_referencias()
  RETURNS TABLE (chave_casta text, grafia text) LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  VALUES
    ('aragonez',                   'Aragonez'),                -- Aragonês, Aragonêz
    ('aragones',                   'Aragonez'),
    ('castelao',                   'Castelão'),
    ('sousao',                     'Sousão'),
    ('souzao',                     'Sousão'),
    ('syrah',                      'Syrah'),
    ('shiraz',                     'Syrah'),
    ('tinto cao',                  'Tinto Cão'),
    ('tinta cao',                  'Tinto Cão'),
    ('alicante bouschet',          'Alicante Bouschet'),
    ('alicante bouchet',           'Alicante Bouschet'),
    ('alicante bousquet',          'Alicante Bouschet'),
    ('alfrocheiro',                'Alfrocheiro'),
    ('alfrocheiro preto',          'Alfrocheiro'),
    ('touriga nacional',           'Touriga Nacional'),
    ('touriga franca',             'Touriga Franca'),
    ('touriga francesa',           'Touriga Franca'),
    ('touriga femea',              'Touriga Fêmea'),
    ('tinta roriz',                'Tinta Roriz'),
    ('tinta barroca',              'Tinta Barroca'),
    ('tinta amarela',              'Tinta Amarela'),
    ('tinta francisca',            'Tinta Francisca'),
    ('tinta miuda',                'Tinta Miúda'),
    ('tinta caiada',               'Tinta Caiada'),
    ('tinta carvalha',             'Tinta Carvalha'),
    ('tinta da barca',             'Tinta da Barca'),
    ('trincadeira',                'Trincadeira'),
    ('trincadeira preta',          'Trincadeira'),
    ('antao vaz',                  'Antão Vaz'),
    ('fernao pires',               'Fernão Pires'),
    ('codega do larinho',          'Códega do Larinho'),
    ('jaen',                       'Jaen'),
    ('baga',                       'Baga'),
    ('arinto',                     'Arinto'),
    ('encruzado',                  'Encruzado'),
    ('alvarinho',                  'Alvarinho'),
    ('loureiro',                   'Loureiro'),
    ('avesso',                     'Avesso'),
    ('gouveio',                    'Gouveio'),
    ('viosinho',                   'Viosinho'),
    ('rabigato',                   'Rabigato'),
    ('roupeiro',                   'Roupeiro'),
    ('verdelho',                   'Verdelho'),
    ('malvasia fina',              'Malvasia Fina'),
    ('moscatel galego branco',     'Moscatel Galego Branco'),
    ('cabernet sauvignon',         'Cabernet Sauvignon'),
    ('cabernet franc',             'Cabernet Franc'),
    ('sauvignon blanc',            'Sauvignon Blanc'),
    ('chenin blanc',               'Chenin Blanc'),
    ('petit verdot',               'Petit Verdot'),
    ('pinot noir',                 'Pinot Noir'),
    ('merlot',                     'Merlot'),
    ('chardonnay',                 'Chardonnay'),
    ('viognier',                   'Viognier'),
    ('field blend',                'Field Blend');
$$;

-- A grafia de referência de uma casta conhecida (pela chave), ou NULL.
CREATE OR REPLACE FUNCTION winecatalog.casta_referencia(k text)
  RETURNS text LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT r.grafia FROM winecatalog.casta_referencias() r WHERE r.chave_casta = k LIMIT 1;
$$;

-- O texto com as castas abreviadas por extenso. Devolve o MESMO texto
-- quando não há abreviatura nenhuma (o caso de quase todos), e por isso
-- sai logo se não houver um "." ou um "ª" depois de uma letra.
CREATE OR REPLACE FUNCTION winecatalog.castas_por_extenso(p_texto text)
  RETURNS text LANGUAGE plpgsql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v text := p_texto;
  m text[];
  f text[];
BEGIN
  IF v IS NULL OR v !~ '[[:alpha:]](\.|ª)' THEN RETURN p_texto; END IF;
  -- m[1] a abreviatura (só letras), m[2] o "." / "ª", m[3] a palavra a seguir
  FOR m IN SELECT regexp_matches(v, '(?:^|[^[:alnum:]])([[:alpha:]]{1,5})(\.ª?|ª\.?)\s?([[:alpha:]]+)', 'g') LOOP
    CONTINUE WHEN lower(m[3]) IN ('de', 'da', 'do', 'das', 'dos', 'e');
    SELECT array_agg(DISTINCT split_part(r.grafia, ' ', 1) || ' ' || split_part(r.grafia, ' ', 2)) INTO f
      FROM winecatalog.casta_referencias() r
     WHERE r.grafia LIKE '% %'
       AND winecatalog.casta_chave(split_part(r.grafia, ' ', 2)) = winecatalog.casta_chave(m[3])
       AND winecatalog.casta_chave(split_part(r.grafia, ' ', 1)) LIKE winecatalog.casta_chave(m[1]) || '%'
       AND length(split_part(r.grafia, ' ', 1)) > length(m[1]);
    CONTINUE WHEN COALESCE(cardinality(f), 0) <> 1;
    -- só letras na abreviatura e na palavra: nada a escapar no padrão além do "."
    v := regexp_replace(v,
           '(^|[^[:alnum:]])' || m[1] || replace(m[2], '.', '\.') || '\s?' || m[3] || '(?![[:alnum:]])',
           '\1' || f[1], 'g');
  END LOOP;
  RETURN v;
END;
$$;

-- Uma casta (UM nome, já separado), normalizada — ou NULL se não é casta.
CREATE OR REPLACE FUNCTION winecatalog.normalizar_casta(p_casta text)
  RETURNS text LANGUAGE plpgsql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  -- "T. Nacional" é "Touriga Nacional" antes de tudo o resto (`castas_por_extenso`).
  v      text := btrim(regexp_replace(COALESCE(winecatalog.castas_por_extenso(p_casta), ''), '\s+', ' ', 'g'), ' .');
  k      text := winecatalog.casta_chave(winecatalog.castas_por_extenso(p_casta));
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

CREATE OR REPLACE FUNCTION winecatalog.tokens(p_texto text)
  RETURNS text[] LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  -- Duas voltas, e a ORDEM importa: primeiro expandem-se as abreviaturas,
  -- só DEPOIS se deitam fora as palavras que não distinguem nada. Ao
  -- contrário, "Qta. do Vallado" dava tokens {quinta,vallado} (o "qta" não
  -- está na lista das que saem, e já ia expandido quando ninguém olhava) e
  -- "Quinta do Vallado" dava {vallado} — a MESMA garrafa com duas chaves,
  -- que é exatamente a avaria que este catálogo não pode ter.
  SELECT COALESCE(array_agg(DISTINCT t ORDER BY t), ARRAY[]::text[])
  FROM (
    SELECT CASE w
             -- "Qta.", "Qt.ª", "Qtª", "Qt." (o "ª" e o ponto já saíram)
             WHEN 'qta'  THEN 'quinta' WHEN 'qtas' THEN 'quintas'
             WHEN 'qt'   THEN 'quinta' WHEN 'qts'  THEN 'quintas'
             WHEN 'hrd'  THEN 'herdade'
             WHEN 'sto'  THEN 'santo'  WHEN 'sta'  THEN 'santa'
             ELSE w
           END AS t
    FROM regexp_split_to_table(
           regexp_replace(
             regexp_replace(
               -- as siglas com pontos numa palavra só: "m.o.b." -> "mob."
               -- (o ponto do fim cai a seguir, com o resto da pontuação)
               regexp_replace(
                 -- "q.ta" e "q. tas" -> "qta", "qtas", antes das siglas
                 regexp_replace(
                   -- NFD parte "é" em "e" + acento, e o intervalo apaga o acento;
                   -- antes disso, "T. Nacional" passa a "Touriga Nacional".
                   lower(regexp_replace(normalize(COALESCE(winecatalog.castas_por_extenso(p_texto), ''), NFD),
                                        U&'[\0300-\036F]', '', 'g')),
                   '\mq\.\s?(tas?)\M', 'q\1', 'g'
                 ),
                 '\m([a-z])\.\s?(?=[a-z]\M)', '\1', 'g'
               ),
               '\m(19|20)[0-9]{2}\M', ' ', 'g'    -- a colheita não entra no nome
             ),
             '[^a-z0-9]+', ' ', 'g'
           ), '\s+') AS w
    WHERE w <> ''
  ) x
  WHERE t <> ''
    -- vazias: não distinguem vinho nenhum
    AND t NOT IN ('de','do','da','dos','das','e','o','a','os','as','um','uma',
                  'vinho','vinhos','wine')
    -- de casa: é o ruído dos nomes portugueses, e é o que impede
    -- "Crasto" de encontrar "Quinta do Crasto"
    AND t NOT IN ('quinta','quintas','herdade','casa','adega','monte','vinha',
                  'vinhas','conde','dom','santo','santa','sociedade','agricola',
                  'soc','lda');
$$;

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
      v_nome := winecatalog.castas_por_extenso(
                  winecatalog.quinta_por_extenso(winecatalog.nome_proprio(v_nome)));
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

REVOKE ALL ON FUNCTION winecatalog.casta_referencias()      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION winecatalog.castas_por_extenso(text)  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.casta_referencias()     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION winecatalog.castas_por_extenso(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION winecatalog.casta_referencia(text)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION winecatalog.normalizar_casta(text)  TO authenticated, service_role;

-- ── O que já estava escrito ────────────────────────────────────────────
-- As chaves das linhas com uma casta abreviada no nome ou no produtor (a
-- conta do `abreviaturas.sql`, só nestas), e as castas das fichas. A
-- 03/10/2026 não mexeu em nada.
SELECT set_config('winecatalog.quem', 'castas abreviadas', true);
WITH q AS (
  SELECT v.id, v.chave AS antiga,
         winecatalog.identidade(v.nome, v.produtor, v.ano, v.ficha ->> 'tipo', false) AS i
    FROM winecatalog.vinhos v
   WHERE (winecatalog.castas_por_extenso(v.nome) <> v.nome
          OR winecatalog.castas_por_extenso(v.produtor) <> v.produtor)
     AND NOT EXISTS (SELECT 1 FROM winecatalog.alias a WHERE a.id_de = v.id)
), mud AS (
  UPDATE winecatalog.vinhos v SET
         chave = q.i ->> 'chave', chave_base = q.i ->> 'chave_base',
         chave_nome = q.i ->> 'chave_nome', base_nome = q.i ->> 'base_nome'
    FROM q
   WHERE v.id = q.id
     AND COALESCE(q.i ->> 'chave_base', '') <> ''
     AND (v.chave, v.chave_base, v.chave_nome, v.base_nome)
         IS DISTINCT FROM (q.i ->> 'chave', q.i ->> 'chave_base', q.i ->> 'chave_nome', q.i ->> 'base_nome')
     AND NOT EXISTS (SELECT 1 FROM winecatalog.vinhos o WHERE o.chave = q.i ->> 'chave' AND o.id <> v.id)
  RETURNING v.id, q.antiga, v.chave AS nova
), al AS (
  UPDATE winecatalog.alias a SET chave_para = mud.nova
    FROM mud WHERE a.chave_para = mud.antiga AND mud.antiga <> mud.nova
  RETURNING a.chave_de
)
SELECT mud.*, (SELECT count(*) FROM al) AS alias_seguiram FROM mud;

UPDATE winecatalog.vinhos
   SET ficha = jsonb_set(ficha, '{castas}', winecatalog.normalizar_castas_json(ficha -> 'castas'))
 WHERE (ficha -> 'castas') IS NOT NULL
   AND (ficha -> 'castas')::text ~ '[[:alpha:]](\.|ª)'
   AND winecatalog.normalizar_castas_json(ficha -> 'castas') <> '[]'::jsonb
   AND winecatalog.normalizar_castas_json(ficha -> 'castas') IS DISTINCT FROM ficha -> 'castas';
