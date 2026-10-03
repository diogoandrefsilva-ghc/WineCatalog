-- ════════════════════════════════════════════════════════════════════
-- "Qt.ª" é "Quinta" (03/10/2026, o dono das apps)
-- ════════════════════════════════════════════════════════════════════
-- Uma carta lida nas Sugestões da Garrafeira escrevia "Qt.ª das Carvalhas
-- Touriga Nacional", e o catálogo não o reconheceu: a `tokens` só conhecia
-- o "Qta." ("qta" → "quinta"), e "Qt.ª" dava "qt" — o "ª" sai com o resto
-- da pontuação, não é um acento que o NFD tire. O "qt" ficava como uma
-- palavra do nome, a chave passava a ser outra ("carvalhas-nacional-qt-
-- touriga" em vez de "carvalhas-nacional-touriga"), a `carta_ligar` não
-- achava a linha, e o "Procurar informação" fez nascer outra (#408, ao lado
-- do #202). O mesmo com o "Qt.ª de Cidrô", o "Qt.ª dos Aciprestes" e o
-- "Qt.ª do Síbio" dessa carta — doze linhas novas com "qt" na chave.
--
-- A regra: "Qt.ª", "Qtª", "Qt.", "Qt" e "Q.ta" são "Quinta" (e "Qts",
-- "Q.tas" são "Quintas"), como já eram o "Qta." e o "Qtas.". O "Q.ta" tem
-- de se juntar ANTES das siglas — senão parte-se em "q" e "ta", que não
-- são abreviatura nenhuma. A seguir, como sempre, a "quinta" sai com as
-- outras palavras de casa: "Qt.ª das Carvalhas" e "Quinta das Carvalhas"
-- dão a mesma chave, {carvalhas}.
--
-- A procura da Garrafeira, que é no browser, faz o mesmo (`siglas`, no
-- app.js de lá) — não é a chave, é o texto livre da caixa de procura.
--
-- Idempotente. Depois do siglas.sql (traz as siglas com pontos tal e
-- qual). Substitui a `tokens` do siglas.sql.
-- ---------------------------------------------------------------------

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
                   -- NFD parte "é" em "e" + acento, e o intervalo apaga o acento.
                   lower(regexp_replace(normalize(COALESCE(p_texto, ''), NFD),
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

-- ── As chaves que mudam com isto ───────────────────────────────────────
-- Só as linhas com um "Qt"/"Q.ta" no nome ou no produtor, e não as fundidas
-- noutra (essas guardam a chave de propósito — ver `libertar_chave`). Uma
-- linha que ficasse com a chave de OUTRA não se mexe (vai aos Duplicados),
-- e o `RETURNING` diz quais mudaram. É a conta do siglas.sql, só nestas.
-- A 03/10/2026 eram as doze da carta das Sugestões (#396–#411, todas
-- nascidas nesse dia, nenhuma ligada a uma garrafeira), nenhuma ficou com a
-- chave de outra, e nenhum `alias` nem `distintos` apontava para elas.
SELECT set_config('winecatalog.quem', 'abreviaturas na chave', true);
WITH q AS (
  SELECT v.id, v.chave AS antiga,
         winecatalog.identidade(v.nome, v.produtor, v.ano, v.ficha ->> 'tipo', false) AS i
    FROM winecatalog.vinhos v
   WHERE (v.nome ~* '\mq\.?\s?t(a|as|s)?\M' OR v.produtor ~* '\mq\.?\s?t(a|as|s)?\M')
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
  RETURNING v.id, q.antiga, v.chave AS nova, v.chave_base, v.chave_nome, v.base_nome
), al AS (
  UPDATE winecatalog.alias a SET chave_para = mud.nova
    FROM mud WHERE a.chave_para = mud.antiga AND mud.antiga <> mud.nova
  RETURNING a.chave_de
)
SELECT mud.*, (SELECT count(*) FROM al) AS alias_seguiram FROM mud;

-- ── E as dos produtores ────────────────────────────────────────────────
-- A `chave_produtor` também passa pela `tokens`. A 03/10/2026 não havia
-- nenhuma grafia nem produtor "no nome" com "Qt"; fica para quem correr
-- isto noutra base. Uma chave nova que já seja de outra linha fica como
-- estava.
UPDATE winecatalog.produtor_variantes pv
   SET chave = winecatalog.chave_produtor(pv.escrito)
 WHERE pv.escrito ~* '\mq\.?\s?t(a|as|s)?\M'
   AND winecatalog.chave_produtor(pv.escrito) <> ''
   AND winecatalog.chave_produtor(pv.escrito) <> pv.chave
   AND NOT EXISTS (SELECT 1 FROM winecatalog.produtor_variantes o
                    WHERE o.chave = winecatalog.chave_produtor(pv.escrito));

UPDATE winecatalog.produtores_no_nome m
   SET chave = winecatalog.chave_produtor(m.produtor)
 WHERE m.produtor ~* '\mq\.?\s?t(a|as|s)?\M'
   AND winecatalog.chave_produtor(m.produtor) <> ''
   AND winecatalog.chave_produtor(m.produtor) <> m.chave
   AND NOT EXISTS (SELECT 1 FROM winecatalog.produtores_no_nome o
                    WHERE o.chave = winecatalog.chave_produtor(m.produtor));

-- ════════════════════════════════════════════════════════════════════
-- E no PRODUTOR escreve-se "Quinta" por extenso (03/10/2026, o dono)
-- ════════════════════════════════════════════════════════════════════
-- A chave já tratava as duas grafias como iguais (acima); o que se via
-- continuava a ser "Qt.ª das Carvalhas". Um produtor que não esteja na
-- lista dos oficiais (`produtor_variantes`) fica como foi escrito — a
-- `produtor_oficial` devolvia-o tal e qual —, e agora sai com o "Qt.ª",
-- "Qtª", "Qta.", "Qt." ou "Q.ta" trocado por "Quinta" (e "Qtas." por
-- "Quintas"). Só no princípio de uma palavra e seguido de espaço ou do
-- fim: "BQT" não é abreviatura nenhuma.
--
-- É a `produtor_oficial` porque é por ela que passam TODAS as escritas do
-- produtor: o trigger dos nomes do catálogo (`vinhos_nomes`), a
-- `identidade` (a `juntar`, a `criar`, a `editar`) e o trigger dos nomes
-- da Garrafeira (`garrafeira.vinhos_nomes`, migração 23 de lá). A chave
-- não muda: a `tokens` já dava o mesmo às duas grafias.
-- O NOME do vinho também — ver a secção a seguir.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.quinta_por_extenso(p_texto text)
  RETURNS text LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT regexp_replace(p_texto,
           '(^|[^[:alnum:]])(q\.\s?ta|qta|qt)(s?)\.?ª?(?=\s|$)', '\1Quinta\3', 'gi');
$$;
REVOKE ALL ON FUNCTION winecatalog.quinta_por_extenso(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.quinta_por_extenso(text) TO authenticated, service_role;

-- O nome oficial de uma grafia, ou a própria grafia (com a "Quinta" por
-- extenso) se não houver. Substitui a do catalogo.sql.
CREATE OR REPLACE FUNCTION winecatalog.produtor_oficial(p_produtor text)
  RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  k text := winecatalog.chave_produtor(p_produtor);
  r text;
BEGIN
  IF k = '' THEN RETURN p_produtor; END IF;
  SELECT p.nome INTO r
    FROM winecatalog.produtor_variantes v
    JOIN winecatalog.produtores p ON p.id = v.produtor_id
   WHERE v.chave = k;
  RETURN COALESCE(r, winecatalog.quinta_por_extenso(p_produtor));
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.produtor_oficial(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.produtor_oficial(text) TO authenticated, service_role;

-- Os que já lá estão. A 03/10/2026, seis linhas do catálogo da carta das
-- Sugestões ("Qt.ª de Cidrô", "Qt.ª dos Aciprestes", "Qt.ª das Carvalhas")
-- e nenhuma garrafeira. O trigger dos nomes refaz as chaves; nenhuma muda.
SELECT set_config('winecatalog.quem', 'abreviaturas no produtor', true);
UPDATE winecatalog.vinhos
   SET produtor = winecatalog.produtor_oficial(produtor)
 WHERE produtor ~* '(^|[^[:alnum:]])(q\.\s?ta|qta|qt)s?\.?ª?(\s|$)'
   AND winecatalog.produtor_oficial(produtor) IS DISTINCT FROM produtor;
-- Na Garrafeira o trigger dos nomes só deixa passar o produtor oficial;
-- quem tiver "Qta." escrito passa a "Quinta" na próxima gravação. A
-- 03/10/2026 não havia nenhum.

-- ════════════════════════════════════════════════════════════════════
-- E no NOME do vinho também (03/10/2026, o dono: "ainda tenho Qtª")
-- ════════════════════════════════════════════════════════════════════
-- O Catálogo continuava a mostrar "Qt.ª de Cidrô Arinto" ao lado de
-- "Quinta de Cidrô Touriga Nacional". A `identidade` — a ÚNICA conta do
-- nome arrumado, por onde passam o trigger dos nomes do catálogo, a
-- `juntar`, a `criar`, a `editar` e o trigger dos nomes da Garrafeira —
-- passa o nome pela `quinta_por_extenso` a seguir à regra das maiúsculas.
-- A chave não muda (a `tokens` já dava o mesmo), e a regra que tira o
-- produtor da frente do nome (`nome_normal`) deixa "Quinta de Cidrô
-- Touriga Nacional" como está — conferido nas nove linhas abaixo.
-- Substitui a `identidade` do cor-na-chave.sql (só a linha do `v_nome`).
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
      v_nome := winecatalog.quinta_por_extenso(winecatalog.nome_proprio(v_nome));
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

-- Os que já lá estão. A 03/10/2026, nove linhas da carta das Sugestões
-- ("Qt.ª de Cidrô Arinto", "Qt.ª dos Aciprestes", "Qt.ª das Carvalhas
-- Reserva"…), nenhuma ligada a uma garrafeira, e nenhum vinho de uma
-- garrafeira com "Qt" no nome. O trigger dos nomes faz o resto. As linhas
-- fundidas noutra não se mexem (guardam a chave de propósito).
SELECT set_config('winecatalog.quem', 'abreviaturas no nome', true);
UPDATE winecatalog.vinhos v
   SET nome = winecatalog.quinta_por_extenso(v.nome)
 WHERE v.nome ~* '(^|[^[:alnum:]])(q\.\s?ta|qta|qt)s?\.?ª?(\s|$)'
   AND winecatalog.quinta_por_extenso(v.nome) <> v.nome
   AND NOT EXISTS (SELECT 1 FROM winecatalog.alias a WHERE a.id_de = v.id);
