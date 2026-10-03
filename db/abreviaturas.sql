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
