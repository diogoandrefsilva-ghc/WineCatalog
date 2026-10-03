-- ════════════════════════════════════════════════════════════════════
-- As SIGLAS com pontos: "M.O.B." é "MOB" (03/10/2026, o dono das apps)
-- ════════════════════════════════════════════════════════════════════
-- O "M.O.B. Lote 3" do catálogo não se achava por "MOB Lote 3": a `tokens`
-- partia a sigla nos pontos em letras soltas ({b, m} — e o "o" ainda saía
-- como palavra vazia), e "MOB" é uma palavra só ({mob}). Duas chaves para a
-- mesma garrafa: uma garrafeira que escrevesse "MOB" fazia nascer outra
-- linha, a `colheitas` (a 1.ª etapa do "Procurar informação") não a
-- encontrava, e a procura do Catálogo (que passa pela `tokens`) também não.
--
-- A regra: letras SOLTAS seguidas de ponto juntam-se numa palavra, ANTES de
-- se partir pelo que não é letra nem número — "M.O.B." e "M. O. B." dão
-- "mob", "J.M. Fonseca" dá "jm fonseca", "D.O.C." dá "doc". Só com DUAS ou
-- mais letras: uma letra solta não é sigla ("S. Miguel", "D. Maria" ficam
-- como estavam).
--
-- A procura da Garrafeira faz o mesmo no browser (`siglas`, no app.js de
-- lá) — não é a chave, é o texto livre da caixa de procura, que lá se lê
-- sem passar pela BD.
--
-- A 03/10/2026 só as duas linhas do M.O.B. Lote 3 (#348 tinto, #384
-- branco) tinham siglas com pontos — nos vinhos do catálogo, nos produtores,
-- nas grafias e nas garrafeiras —, e são só essas que o recálculo do fim
-- mexe. Nenhum `alias` nem `distintos` apontava para elas.
--
-- Idempotente. Depois do cor-na-chave.sql e do nomes-manter.sql (usa a
-- `identidade`). Substitui a `tokens` do catalogo.sql.
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
             WHEN 'qta'  THEN 'quinta' WHEN 'qtas' THEN 'quintas'
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
                 -- NFD parte "é" em "e" + acento, e o intervalo apaga o acento.
                 lower(regexp_replace(normalize(COALESCE(p_texto, ''), NFD),
                                      U&'[\0300-\036F]', '', 'g')),
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
-- Só as linhas com uma sigla de pontos no nome ou no produtor, e não as
-- fundidas noutra (essas guardam a chave de propósito — ver `libertar_chave`).
-- Uma linha que ficasse com a chave de OUTRA não se mexe (vai aos
-- Duplicados), e o `RETURNING` diz quais mudaram. É a mesma conta do
-- `cor_na_chave_recalcular`, só nestas. Os `alias` que apontam para a chave
-- antiga seguem-na; os `distintos` destas chaves (nenhum a 03/10/2026)
-- acertam-se como lá. Um UPDATE e não um bloco DO: assim corre igual no SQL
-- Editor e pelo MCP, que se engasgou com o DO.
SELECT set_config('winecatalog.quem', 'siglas na chave', true);
WITH q AS (
  SELECT v.id, v.chave AS antiga,
         winecatalog.identidade(v.nome, v.produtor, v.ano, v.ficha ->> 'tipo', false) AS i
    FROM winecatalog.vinhos v
   WHERE (v.nome ~* '\m[a-z]\.\s?[a-z]\M' OR v.produtor ~* '\m[a-z]\.\s?[a-z]\M')
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
-- A `chave_produtor` também passa pela `tokens`: uma grafia de produtor ou
-- um produtor da lista "no nome" com uma sigla de pontos mudava de chave e
-- deixava de se reconhecer. A 03/10/2026 não havia nenhum; fica para quem
-- correr isto noutra base. Uma chave nova que já seja de outra linha fica
-- como estava.
UPDATE winecatalog.produtor_variantes pv
   SET chave = winecatalog.chave_produtor(pv.escrito)
 WHERE pv.escrito ~* '\m[a-z]\.\s?[a-z]\M'
   AND winecatalog.chave_produtor(pv.escrito) <> ''
   AND winecatalog.chave_produtor(pv.escrito) <> pv.chave
   AND NOT EXISTS (SELECT 1 FROM winecatalog.produtor_variantes o
                    WHERE o.chave = winecatalog.chave_produtor(pv.escrito));

UPDATE winecatalog.produtores_no_nome m
   SET chave = winecatalog.chave_produtor(m.produtor)
 WHERE m.produtor ~* '\m[a-z]\.\s?[a-z]\M'
   AND winecatalog.chave_produtor(m.produtor) <> ''
   AND winecatalog.chave_produtor(m.produtor) <> m.chave
   AND NOT EXISTS (SELECT 1 FROM winecatalog.produtores_no_nome o
                    WHERE o.chave = winecatalog.chave_produtor(m.produtor));
