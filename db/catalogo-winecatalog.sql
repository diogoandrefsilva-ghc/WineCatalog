-- =====================================================================
-- WineCatalog — o que esta app ACRESCENTA ao schema `catalogo`
--
-- ISTO NÃO É O SCHEMA `catalogo`. A FONTE DE VERDADE dele é
-- `db/catalogo-partilhado.sql` NO REPO GARRAFEIRA — a tabela
-- `catalogo.vinhos`, a chave (`tokens`/`chave_base`/`chave`/`base_nome`/
-- `chave_nome`/`achar`), a `forca()`, a `volatil()`, e as três funções que
-- as Edge Functions usam (`juntar`/`procurar`/`procurar_lote`). Nada disso
-- se repete aqui, e este ficheiro NÃO REDEFINE NENHUMA DELAS.
--
-- Porquê tão insistente: o catálogo existe porque a chave vive num sítio
-- só. Esteve repetida em TypeScript nas três Edge Functions com um aviso a
-- dizer para as manter iguais, e um aviso desses é uma dívida à espera —
-- no dia em que uma divergisse, o catálogo partia-se em dois em silêncio e
-- a única coisa que se notava era a conta da IA a não descer. Uma app
-- nova a trazer a SEGUNDA cópia do ficheiro era repetir o erro num degrau
-- acima. Se precisares de mexer na chave ou na força, mexe LÁ.
--
-- O que entra aqui é só o que o catálogo nunca teve e que é desta app:
--   1. quem manda no catálogo             (`catalogo.config`, §5.3 do doc)
--   2. um caminho de LEITURA para uma UI  (§5.1 — funções, não policies)
--   3. as duas tabelas novas              (`alias`, `distintos`, §5.2)
--   4. a fusão manual, reversível         (§4.3)
--   5. a vista do consumo das outras apps (`catalogo.consumo`, §4.1)
--
-- Correr no SQL Editor do Supabase, DEPOIS de `schema.sql` (precisa da
-- `winecatalog.allowed_users`) e ANTES de `functions.sql` (que pergunta
-- aqui quem é o admin). É IDEMPOTENTE.
--
-- PASSO MANUAL: `catalogo` já tem de estar nos "Exposed schemas" por causa
-- das Edge Functions; `winecatalog` tem de ser acrescentado ao lado. Ver
-- db/README.md.
-- =====================================================================


-- =====================================================================
-- 1. QUEM MANDA NO CATÁLOGO
--
-- O catálogo não é de nenhuma das três apps, por isso não herda o admin de
-- nenhuma. Era esse o problema de governo que uma app nova resolve de
-- graça: pôr este painel dentro da Garrafeira significava que quem
-- herdasse a Garrafeira (o admin dela passa com `definir_admin()`)
-- herdava poder sobre uma tabela que também serve a WineSelection.
--
-- Mesmo desenho do `garrafeira.config.admin_email`: numa LINHA e não fixo
-- em código, porque passar a app a outra pessoa tem de ser um clique e não
-- um deploy. O COALESCE é a rede de segurança — se alguém apagar a linha,
-- o catálogo não fica sem admin nenhum (o que o trancaria para sempre:
-- não haveria ninguém com direito a repor a linha).
-- =====================================================================
CREATE TABLE IF NOT EXISTS catalogo.config (
  chave text NOT NULL,
  valor text NOT NULL,
  CONSTRAINT config_pkey PRIMARY KEY (chave)
);

INSERT INTO catalogo.config (chave, valor)
VALUES ('admin_email', 'diogo.andre.f.silva@gmail.com')
ON CONFLICT (chave) DO NOTHING;

-- RLS ligada e sem policy nenhuma, como a `catalogo.vinhos`: quem lê isto
-- é a `catalogo.admin_email()`, que é SECURITY DEFINER. A UI também quer
-- saber (para decidir que botões mostrar), mas pergunta pela função —
-- quem DECIDE é sempre a BD, nunca o que o browser acha.
ALTER TABLE catalogo.config ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION catalogo.admin_email()
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'catalogo', 'public'
AS $$
  SELECT COALESCE(
    (SELECT lower(valor) FROM catalogo.config WHERE chave = 'admin_email'),
    'diogo.andre.f.silva@gmail.com'
  );
$$;

CREATE OR REPLACE FUNCTION catalogo.sou_admin()
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'catalogo', 'public'
AS $$
  SELECT lower(COALESCE(auth.email(), '')) = catalogo.admin_email();
$$;

-- Quem pode LER o catálogo: o admin, e quem estiver aprovado na
-- WineCatalog. É a única dependência do `catalogo` para dentro de uma app,
-- e é deliberada: a WineCatalog é a app que existe para GOVERNAR o
-- catálogo, ao contrário das outras duas que só o consomem. Fica numa
-- função só para que mudar de ideias sobre quem lê seja mudar uma linha.
CREATE OR REPLACE FUNCTION catalogo.pode_ler()
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'catalogo', 'public'
AS $$
  SELECT catalogo.sou_admin() OR EXISTS (
    SELECT 1 FROM winecatalog.allowed_users
     WHERE lower(email) = lower(COALESCE(auth.email(), ''))
  );
$$;

-- Passar o catálogo a outra pessoa. Só o admin, e só para um email que já
-- tenha acesso à app — passá-lo a quem não está em `allowed_users` é
-- ficar sem admin nenhum e sem forma de voltar atrás pela UI.
CREATE OR REPLACE FUNCTION catalogo.definir_admin(p_email text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'catalogo', 'public'
AS $$
DECLARE
  v_novo text := lower(trim(COALESCE(p_email, '')));
BEGIN
  IF NOT catalogo.sou_admin() THEN
    RAISE EXCEPTION 'Só o admin pode passar o catálogo a outra pessoa.';
  END IF;
  IF v_novo = '' OR v_novo NOT LIKE '%@%' THEN
    RAISE EXCEPTION 'Email inválido.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM winecatalog.allowed_users WHERE lower(email) = v_novo) THEN
    RAISE EXCEPTION 'Esse email ainda não tem acesso à app — aprova-o primeiro em Utilizadores.';
  END IF;
  INSERT INTO catalogo.config (chave, valor) VALUES ('admin_email', v_novo)
  ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
  RETURN 'ok';
END;
$$;


-- =====================================================================
-- 2. UM CAMINHO DE LEITURA PARA A UI
--
-- Até aqui `catalogo.vinhos` tinha RLS com ZERO policies: nem o
-- `authenticated` lia uma linha, e não havia um único ecrã em lado nenhum
-- que mostrasse o que lá está. Só as Edge Functions (service_role) lhe
-- chegavam.
--
-- Duas saídas, e a escolhida é a segunda:
--   · policies de SELECT — mais simples, mas abre a tabela a QUALQUER
--     pessoa com login em QUALQUER app do projeto que aponte para o
--     schema `catalogo`, e o schema está EXPOSTO na API. A lista de
--     vinhos que passaram por aqui diz alguma coisa sobre o que as
--     pessoas têm em casa, mesmo que cada linha à parte não diga;
--   · funções SECURITY DEFINER com `REVOKE` e `GRANT` só a quem deve —
--     a mesma razão que levou ao REVOKE da `juntar`/`procurar`/
--     `procurar_lote`, e a mesma disciplina.
--
-- Cada função nova nasce com EXECUTE para PUBLIC. Os REVOKEs estão todos
-- juntos no FIM deste ficheiro, e confirmam-se com a consulta que está lá.
-- =====================================================================

-- Uma linha do catálogo como a UI a quer numa LISTA: sem a ficha inteira
-- (são ~19 campos por linha e a lista tem centenas), mas com o que
-- responde à pergunta "vale a pena abrir esta?".
CREATE OR REPLACE FUNCTION catalogo.resumo_linha(r catalogo.vinhos)
  RETURNS jsonb LANGUAGE sql STABLE
  SET search_path TO 'catalogo', 'public'
AS $$
  SELECT jsonb_build_object(
    'id',       r.id,
    'chave',    r.chave,
    'nome',     r.nome,
    'produtor', r.produtor,
    'ano',      r.ano,
    'tipo',     r.ficha ->> 'tipo',
    'regiao',   COALESCE(r.ficha ->> 'regiao', r.ficha ->> 'pais'),
    'castas',   r.ficha -> 'castas',
    'nota',     r.ficha -> 'vivino_nota',
    'preco',    r.ficha -> 'preco_medio',
    'campos',   (SELECT count(*) FROM jsonb_object_keys(r.ficha)),
    -- A força MÁXIMA que esta linha tem em cima: é o que distingue um
    -- vinho que alguém pesquisou a sério de um que foi escrito à pressa
    -- numa garrafeira e nunca mais ninguém tocou.
    'forca',    (SELECT COALESCE(max((o.value ->> 'f')::integer), 0)
                   FROM jsonb_each(r.origens) o),
    'fontes',   jsonb_array_length(COALESCE(r.fontes, '[]'::jsonb)),
    'vezes',    r.vezes,
    'vistoEm',      r.visto_em,
    'atualizadoEm', r.atualizado_em
  );
$$;

-- A LISTA, com procura. `p_procura` vazio devolve tudo (por ordem da
-- última vez que serviu uma pergunta — que é a ordem por que alguém quer
-- ver isto, não a alfabética).
--
-- A procura bate em quatro sítios porque é por esses quatro que se procura
-- um vinho: o nome, o produtor, a região e a casta. Os dois primeiros
-- passam também pela CHAVE (`catalogo.tokens`), e é isso que faz "qta do
-- crasto" encontrar a linha escrita "Quinta do Crasto" e "crasto"
-- encontrar as duas — a mesma normalização que o catálogo já usa para
-- decidir o que é o mesmo vinho, sem uma segunda ideia sobre acentos.
CREATE OR REPLACE FUNCTION catalogo.listar(
  p_procura text DEFAULT NULL,
  p_limite  integer DEFAULT 50,
  p_saltar  integer DEFAULT 0
) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'catalogo', 'public'
AS $$
DECLARE
  v_q    text    := lower(trim(COALESCE(p_procura, '')));
  v_toks text[]  := CASE WHEN v_q = '' THEN ARRAY[]::text[] ELSE catalogo.tokens(v_q) END;
  v_lim  integer := LEAST(GREATEST(COALESCE(p_limite, 50), 1), 200);
  v_off  integer := GREATEST(COALESCE(p_saltar, 0), 0);
  v_res  jsonb;
BEGIN
  IF NOT catalogo.pode_ler() THEN
    RAISE EXCEPTION 'Sem acesso ao catálogo.';
  END IF;

  -- Uma CTE e não uma tabela temporária: uma função STABLE não pode
  -- escrever, nem sequer num `CREATE TEMP TABLE`, e o Postgres só o diz
  -- quando a função CORRE. É a mesma pedra em que já se tropeçou do outro
  -- lado (um `UPDATE` do `visto_em` dentro de algo marcado STABLE) e que
  -- está escrita no CLAUDE.md — aqui não se repete.
  WITH achados AS (
    SELECT v.*
      FROM catalogo.vinhos v
     WHERE
       -- As linhas estacionadas por uma fusão não entram na lista:
       -- deixaram de ser um vinho e passaram a ser o rasto de uma
       -- decisão. Quem as quer ver vai a Duplicados, onde se desfaz.
       v.chave NOT LIKE 'alias:%'
       AND (
         v_q = ''
         OR v.nome     ILIKE '%' || v_q || '%'
         OR v.produtor ILIKE '%' || v_q || '%'
         OR COALESCE(v.ficha ->> 'regiao', '')     ILIKE '%' || v_q || '%'
         OR COALESCE(v.ficha ->> 'sub_regiao', '') ILIKE '%' || v_q || '%'
         OR EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(
                             CASE WHEN jsonb_typeof(v.ficha -> 'castas') = 'array'
                                  THEN v.ficha -> 'castas' ELSE '[]'::jsonb END) c
               WHERE c ILIKE '%' || v_q || '%')
         -- e pela CHAVE: todos os tokens escritos têm de estar na linha
         OR (cardinality(v_toks) > 0
             AND string_to_array(v.chave_base, '-') @> v_toks)
       )
  ), pagina AS (
    SELECT a.* FROM achados a
     ORDER BY a.visto_em DESC, a.id DESC
     OFFSET v_off LIMIT v_lim
  )
  SELECT jsonb_build_object(
           'total',  (SELECT count(*) FROM achados),
           'linhas', COALESCE((SELECT jsonb_agg(catalogo.resumo_linha(p.*)
                                        ORDER BY p.visto_em DESC, p.id DESC)
                                 FROM pagina p), '[]'::jsonb)
         )
    INTO v_res;

  RETURN v_res;
END;
$$;

-- UMA linha, inteira, com a proveniência CAMPO A CAMPO.
--
-- É o ponto do ecrã do §4.2 e a razão de a app existir: `origens` guarda
-- {campo: {o:origem, f:força, em:quando}} desde o primeiro dia e nunca
-- ninguém o viu. Sem isto não há como responder à pergunta que decide se
-- se confia num número — "de onde é que isto veio?".
--
-- Devolve também as linhas que foram FUNDIDAS nesta (`aliases`): quem abre
-- uma ficha tem direito a saber que ela é o resultado de uma decisão de
-- alguém, e a desfazê-la.
CREATE OR REPLACE FUNCTION catalogo.ver(p_id bigint)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'catalogo', 'public'
AS $$
DECLARE
  r catalogo.vinhos%ROWTYPE;
BEGIN
  IF NOT catalogo.pode_ler() THEN
    RAISE EXCEPTION 'Sem acesso ao catálogo.';
  END IF;
  SELECT * INTO r FROM catalogo.vinhos v WHERE v.id = p_id;
  IF r.id IS NULL THEN RETURN NULL; END IF;

  RETURN catalogo.resumo_linha(r) || jsonb_build_object(
    'chaveBase', r.chave_base,
    'chaveNome', r.chave_nome,
    'baseNome',  r.base_nome,
    'ficha',     r.ficha,
    'origens',   r.origens,
    'fontes',    COALESCE(r.fontes, '[]'::jsonb),
    'criadoEm',  r.criado_em,
    'aliases',   COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'chaveDe', a.chave_de, 'nome', a.nome_de, 'ano', a.ano_de,
                 'quem', a.quem, 'quando', a.quando,
                 'campos', jsonb_array_length(
                             COALESCE(jsonb_path_query_array(a.campos_movidos, '$.keyvalue()'), '[]'::jsonb))
               ) ORDER BY a.quando DESC)
          FROM catalogo.alias a WHERE a.id_para = r.id), '[]'::jsonb)
  );
END;
$$;


-- =====================================================================
-- 3. DUPLICADOS: as duas tabelas novas e a fusão MANUAL
--
-- Três coisas que não são negociáveis (§4.3 do doc de arranque):
--
--   · NUNCA AUTOMÁTICA. Uma varredura por semelhança de tokens devolveu
--     29 pares numa base de 162 linhas, e lá dentro havia duplicados a
--     sério (dona-ermelinda-freitas / ermelinda-freitas) E falsos
--     positivos perigosos: `nacional-touriga-vallado` com
--     `esporao-nacional-touriga` — dois produtores diferentes a partilhar
--     o nome de uma CASTA. A semelhança serve para SUGERIR, nunca para
--     DECIDIR.
--
--   · O "NÃO SÃO" TEM DE FICAR GRAVADO (`catalogo.distintos`). Senão a
--     lista volta a propor o mesmo par todas as semanas, e uma lista que
--     insiste em erros deixa de se ler — é o caminho para alguém carregar
--     em "são o mesmo" sem olhar e juntar um Vallado a um Esporão.
--
--   · FUNDIR É REVERSÍVEL. Com texto livre à entrada isso é requisito e
--     não conforto.
--
-- E uma quarta, que é a que segura a nota e o preço: NUNCA FUNDIR
-- COLHEITAS DIFERENTES. As castas de um Papa Figos são as mesmas em 2019
-- e em 2021; a nota do Vivino e o preço não são. `fundir` recusa-o com
-- erro, não com um aviso.
--
-- COMO É QUE A FUSÃO É REVERSÍVEL, e em que é que difere do desenho do
-- documento. Lá propunha-se um alias que a `catalogo.achar()` resolvesse
-- — mas a `achar` vive na FONTE DE VERDADE, no repo Garrafeira, e uma
-- cópia dela aqui era exatamente a avaria contra a qual todo este ficheiro
-- está escrito. Sem lhe tocar, o mesmo resultado consegue-se assim:
--
--   1. os campos da linha perdedora passam para a linha-alvo UM A UM,
--      respeitando a `forca` que cada um já tinha dos dois lados — uma
--      fusão nunca pode ser a porta por onde uma leitura fraca tapa uma
--      pesquisa a sério;
--   2. a linha perdedora fica com as chaves ESTACIONADAS (prefixo
--      `alias:`), e é só isso que a tira do caminho da `achar` — a ficha
--      dela não se toca, não se apaga uma linha;
--   3. o que foi mexido fica escrito em `catalogo.alias.campos_movidos`,
--      com o estado ANTERIOR de cada campo.
--
-- Desfazer (`catalogo.separar`) repõe as chaves e devolve cada campo ao
-- que era — mas SÓ os campos que ninguém reescreveu entretanto (compara
-- a entrada de `origens` com a que a fusão lá pôs). Um campo que outra
-- pesquisa atualizou depois fica como está: desfazer uma fusão de
-- setembro não pode deitar fora uma verificação de outubro.
-- =====================================================================

CREATE TABLE IF NOT EXISTS catalogo.alias (
  chave_de       text NOT NULL,          -- a chave ORIGINAL da linha perdedora
  chave_para     text NOT NULL,
  id_de          bigint NOT NULL,
  id_para        bigint NOT NULL,
  -- o que se estacionou, para a reposição ser exata e não um palpite
  chave_base_de  text,
  chave_nome_de  text,
  base_nome_de   text,
  nome_de        text,
  ano_de         integer,
  -- {campo: {antes: <valor ou null>, antes_origem: <entrada ou null>,
  --          depois_origem: <entrada que a fusão escreveu>}}
  campos_movidos jsonb NOT NULL DEFAULT '{}'::jsonb,
  quem           text,
  quando         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alias_pkey PRIMARY KEY (chave_de)
);
CREATE INDEX IF NOT EXISTS alias_para_idx ON catalogo.alias (id_para);

-- O "não são o mesmo", gravado. O par guarda-se sempre ordenado (a < b)
-- para que marcar (A,B) e marcar (B,A) sejam a mesma linha — senão a
-- lista voltava a propor o par pela ordem contrária, que é a mesma avaria
-- com outra roupa.
CREATE TABLE IF NOT EXISTS catalogo.distintos (
  chave_a text NOT NULL,
  chave_b text NOT NULL,
  quem    text,
  quando  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT distintos_pkey PRIMARY KEY (chave_a, chave_b),
  CONSTRAINT distintos_ordem_chk CHECK (chave_a < chave_b)
);

-- Ambas com RLS e sem policy nenhuma: alcançadas só pelas funções abaixo.
ALTER TABLE catalogo.alias     ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogo.distintos ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------
-- CANDIDATOS: a lista que SUGERE, e que nunca decide
--
-- Os cortes (mesmo ano, >=2 tokens comuns, >=60% de sobreposição) são os
-- que deram os 29 pares que se foram ver à mão — ficam à vista de
-- propósito, e os números de cada par vão para o ecrã com ele, porque é
-- uma pessoa que decide e uma pessoa decide melhor a ver a conta.
--
-- A sobreposição mede-se contra o MENOR dos dois conjuntos: "Crasto" (1
-- token) contra "Crasto Reserva" (2) dá 100% e aparece na lista — que é o
-- que se quer, é um par a olhar. Contra o maior dava 50% e desaparecia.
-- Aparecer a mais é barato (alguém diz "não são" uma vez e nunca mais se
-- fala nisso); desaparecer é o duplicado que fica lá para sempre.
--
-- Fora ficam: pares já marcados como distintos, linhas já estacionadas
-- por uma fusão anterior, e colheitas diferentes (que nunca se fundem).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalogo.candidatos(p_limite integer DEFAULT 40)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'catalogo', 'public'
AS $$
DECLARE
  v_lim integer := LEAST(GREATEST(COALESCE(p_limite, 40), 1), 200);
  v_res jsonb;
BEGIN
  IF NOT catalogo.pode_ler() THEN
    RAISE EXCEPTION 'Sem acesso ao catálogo.';
  END IF;

  WITH linhas AS (
    SELECT v.*, string_to_array(v.chave_base, '-') AS toks
      FROM catalogo.vinhos v
     WHERE v.chave NOT LIKE 'alias:%'
  ), pares AS (
    SELECT a.id AS id_a, b.id AS id_b,
           a.chave AS chave_a, b.chave AS chave_b,
           cardinality(ARRAY(SELECT unnest(a.toks) INTERSECT SELECT unnest(b.toks))) AS comuns,
           LEAST(cardinality(a.toks), cardinality(b.toks)) AS menor
      FROM linhas a
      JOIN linhas b
        ON b.id > a.id
       -- mesma colheita: duas colheitas nunca se fundem, por isso nem
       -- sequer se propõem
       AND b.ano IS NOT DISTINCT FROM a.ano
  ), filtrados AS (
    SELECT p.*, round(p.comuns::numeric / NULLIF(p.menor, 0), 2) AS sobreposicao
      FROM pares p
     WHERE p.comuns >= 2
       AND p.menor > 0
       AND p.comuns::numeric / p.menor >= 0.6
       AND NOT EXISTS (
             SELECT 1 FROM catalogo.distintos d
              WHERE d.chave_a = LEAST(p.chave_a, p.chave_b)
                AND d.chave_b = GREATEST(p.chave_a, p.chave_b))
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'comuns',       f.comuns,
           'sobreposicao', f.sobreposicao,
           'a', catalogo.resumo_linha(va.*),
           'b', catalogo.resumo_linha(vb.*)
         ) ORDER BY f.sobreposicao DESC, f.comuns DESC), '[]'::jsonb)
    INTO v_res
    FROM (SELECT * FROM filtrados ORDER BY sobreposicao DESC, comuns DESC LIMIT v_lim) f
    JOIN catalogo.vinhos va ON va.id = f.id_a
    JOIN catalogo.vinhos vb ON vb.id = f.id_b;

  RETURN v_res;
END;
$$;


-- O "não são". Grava-se pelas CHAVES e não pelos ids: um id é de uma
-- linha, uma chave é de um vinho, e é o vinho que não é o outro.
CREATE OR REPLACE FUNCTION catalogo.marcar_distintos(p_id_a bigint, p_id_b bigint)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'catalogo', 'public'
AS $$
DECLARE
  v_a text; v_b text;
BEGIN
  IF NOT catalogo.sou_admin() THEN
    RAISE EXCEPTION 'Só o admin do catálogo pode decidir isto.';
  END IF;
  SELECT chave INTO v_a FROM catalogo.vinhos WHERE id = p_id_a;
  SELECT chave INTO v_b FROM catalogo.vinhos WHERE id = p_id_b;
  IF v_a IS NULL OR v_b IS NULL OR v_a = v_b THEN
    RAISE EXCEPTION 'Par inválido.';
  END IF;
  INSERT INTO catalogo.distintos (chave_a, chave_b, quem)
  VALUES (LEAST(v_a, v_b), GREATEST(v_a, v_b), auth.email())
  ON CONFLICT (chave_a, chave_b) DO NOTHING;
  RETURN 'ok';
END;
$$;

-- E desfazer o "não são", que também é uma decisão e também se erra.
CREATE OR REPLACE FUNCTION catalogo.desmarcar_distintos(p_chave_a text, p_chave_b text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'catalogo', 'public'
AS $$
BEGIN
  IF NOT catalogo.sou_admin() THEN
    RAISE EXCEPTION 'Só o admin do catálogo pode decidir isto.';
  END IF;
  DELETE FROM catalogo.distintos
   WHERE chave_a = LEAST(p_chave_a, p_chave_b)
     AND chave_b = GREATEST(p_chave_a, p_chave_b);
  RETURN 'ok';
END;
$$;

-- A lista dos "não são" já gravados, para se poder voltar atrás sem ir ao
-- SQL Editor.
CREATE OR REPLACE FUNCTION catalogo.listar_distintos()
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'catalogo', 'public'
AS $$
DECLARE v_res jsonb;
BEGIN
  IF NOT catalogo.pode_ler() THEN
    RAISE EXCEPTION 'Sem acesso ao catálogo.';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'chaveA', d.chave_a, 'chaveB', d.chave_b,
           'nomeA', va.nome, 'nomeB', vb.nome,
           'quem', d.quem, 'quando', d.quando
         ) ORDER BY d.quando DESC), '[]'::jsonb)
    INTO v_res
    FROM catalogo.distintos d
    LEFT JOIN catalogo.vinhos va ON va.chave = d.chave_a
    LEFT JOIN catalogo.vinhos vb ON vb.chave = d.chave_b;
  RETURN v_res;
END;
$$;


-- ---------------------------------------------------------------------
-- FUNDIR: "são o mesmo vinho"
--
-- `p_id_de` é a linha que sai do caminho; `p_id_para` é a que fica. A UI
-- propõe como alvo a mais preenchida, mas quem decide é quem está a olhar.
--
-- Os campos passam UM A UM e só quando a força de quem os tem é >= à de
-- quem lá está — a mesma regra da `catalogo.juntar`, e pela mesma razão:
-- uma fusão não pode ser a porta dos fundos por onde um número escrito à
-- pressa numa garrafeira tapa uma `ws-verificacao` que se pagou. A força
-- não se recalcula (não se sabe aqui de que CAMPO ela veio do outro lado,
-- e inventá-la era pior): usa-se a que já está gravada em `origens`.
--
-- Campos que a linha-alvo não tem entram sempre (uma origem com força 0
-- nunca chegou a entrar em `origens`, por isso não há nada aqui a
-- ressuscitar o que a `forca()` já recusou).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalogo.fundir(p_id_de bigint, p_id_para bigint)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'catalogo', 'public'
AS $$
DECLARE
  de    catalogo.vinhos%ROWTYPE;
  para  catalogo.vinhos%ROWTYPE;
  v_ficha   jsonb;
  v_origens jsonb;
  v_fontes  jsonb;
  v_mov     jsonb := '{}'::jsonb;
  k     text;
  v     jsonb;
  f_de  integer;
  f_para integer;
BEGIN
  IF NOT catalogo.sou_admin() THEN
    RAISE EXCEPTION 'Só o admin do catálogo pode fundir linhas.';
  END IF;
  IF p_id_de IS NULL OR p_id_para IS NULL OR p_id_de = p_id_para THEN
    RAISE EXCEPTION 'Par inválido.';
  END IF;

  SELECT * INTO de   FROM catalogo.vinhos WHERE id = p_id_de   FOR UPDATE;
  SELECT * INTO para FROM catalogo.vinhos WHERE id = p_id_para FOR UPDATE;
  IF de.id IS NULL OR para.id IS NULL THEN
    RAISE EXCEPTION 'Linha não encontrada.';
  END IF;
  IF de.chave LIKE 'alias:%' THEN
    RAISE EXCEPTION 'Essa linha já foi fundida noutra.';
  END IF;

  -- A trave que segura a nota e o preço. Não é um aviso: é um erro.
  IF de.ano IS DISTINCT FROM para.ano
     AND de.ano IS NOT NULL AND para.ano IS NOT NULL THEN
    RAISE EXCEPTION 'São colheitas diferentes (% e %) — essas nunca se fundem.',
      de.ano, para.ano;
  END IF;

  v_ficha   := para.ficha;
  v_origens := para.origens;
  v_fontes  := COALESCE(para.fontes, '[]'::jsonb);

  FOR k, v IN SELECT key, value FROM jsonb_each(de.ficha) LOOP
    CONTINUE WHEN v IS NULL OR jsonb_typeof(v) = 'null'
                  OR v = '""'::jsonb OR v = '[]'::jsonb OR v = '{}'::jsonb;
    f_de   := COALESCE((de.origens   -> k ->> 'f')::integer, 0);
    f_para := COALESCE((v_origens    -> k ->> 'f')::integer, 0);
    IF NOT (v_ficha ? k) OR f_de >= f_para THEN
      v_mov := v_mov || jsonb_build_object(k, jsonb_build_object(
        'antes',         CASE WHEN v_ficha ? k THEN v_ficha -> k END,
        'antes_origem',  v_origens -> k,
        'depois_origem', COALESCE(de.origens -> k, '{}'::jsonb)
      ));
      v_ficha   := v_ficha   || jsonb_build_object(k, v);
      v_origens := v_origens || jsonb_build_object(k, COALESCE(de.origens -> k, '{}'::jsonb));
    END IF;
  END LOOP;

  -- As fontes juntam-se sem repetir e ficam pelas 8, como na `juntar`:
  -- são para se poder ir ver de onde veio isto, não um arquivo.
  SELECT COALESCE(jsonb_agg(f), '[]'::jsonb) INTO v_fontes FROM (
    SELECT DISTINCT ON (f ->> 'url') f
      FROM jsonb_array_elements(v_fontes || COALESCE(de.fontes, '[]'::jsonb)) f
     WHERE COALESCE(f ->> 'url', '') <> ''
     ORDER BY (f ->> 'url')
     LIMIT 8
  ) x;

  UPDATE catalogo.vinhos SET
    ficha    = v_ficha,
    origens  = v_origens,
    fontes   = v_fontes,
    -- o nome mais COMPRIDO fica, como na `juntar`
    nome     = CASE WHEN length(COALESCE(de.nome,'')) > length(nome) THEN de.nome ELSE nome END,
    produtor = CASE WHEN produtor = '' THEN COALESCE(de.produtor,'') ELSE produtor END,
    ano      = COALESCE(ano, de.ano),
    atualizado_em = now()
  WHERE id = para.id;

  -- A linha perdedora NÃO se apaga: estaciona-se. A ficha dela fica
  -- intacta; só as chaves saem do caminho da `catalogo.achar()`, que é a
  -- única coisa que era precisa para as duas apps passarem a acertar na
  -- linha certa.
  UPDATE catalogo.vinhos SET
    chave      = 'alias:' || de.chave,
    chave_base = 'alias:' || de.chave_base,
    chave_nome = CASE WHEN de.chave_nome IS NULL THEN NULL ELSE 'alias:' || de.chave_nome END,
    base_nome  = CASE WHEN de.base_nome  IS NULL THEN NULL ELSE 'alias:' || de.base_nome  END
  WHERE id = de.id;

  INSERT INTO catalogo.alias (chave_de, chave_para, id_de, id_para,
                              chave_base_de, chave_nome_de, base_nome_de,
                              nome_de, ano_de, campos_movidos, quem)
  VALUES (de.chave, para.chave, de.id, para.id,
          de.chave_base, de.chave_nome, de.base_nome,
          de.nome, de.ano, v_mov, auth.email())
  ON CONFLICT (chave_de) DO UPDATE
    SET chave_para = EXCLUDED.chave_para, id_para = EXCLUDED.id_para,
        campos_movidos = EXCLUDED.campos_movidos, quem = EXCLUDED.quem,
        quando = now();

  -- Um par fundido deixa de ser um par por decidir.
  DELETE FROM catalogo.distintos
   WHERE chave_a = LEAST(de.chave, para.chave)
     AND chave_b = GREATEST(de.chave, para.chave);

  RETURN jsonb_build_object(
    'ok', true, 'id', para.id,
    'campos', (SELECT count(*) FROM jsonb_object_keys(v_mov))
  );
END;
$$;


-- ---------------------------------------------------------------------
-- SEPARAR: desfazer uma fusão
--
-- Repõe as chaves da linha estacionada (que volta a existir para a
-- `achar`) e devolve cada campo ao que era ANTES da fusão — mas só os
-- campos que ninguém reescreveu entretanto. A comparação é com a entrada
-- de `origens` que a fusão escreveu: se ela ainda lá está exatamente
-- igual, ninguém tocou; se mudou, foi outra escrita e essa manda.
--
-- Desfazer uma fusão de setembro não pode deitar fora uma verificação de
-- outubro — e é por isso que isto não é um "restaurar a cópia de
-- segurança" em bloco.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalogo.separar(p_chave_de text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'catalogo', 'public'
AS $$
DECLARE
  a     catalogo.alias%ROWTYPE;
  para  catalogo.vinhos%ROWTYPE;
  v_ficha   jsonb;
  v_origens jsonb;
  k     text;
  v     jsonb;
  n_rep integer := 0;
  n_mant integer := 0;
BEGIN
  IF NOT catalogo.sou_admin() THEN
    RAISE EXCEPTION 'Só o admin do catálogo pode desfazer uma fusão.';
  END IF;

  SELECT * INTO a FROM catalogo.alias WHERE chave_de = p_chave_de;
  IF a.chave_de IS NULL THEN RAISE EXCEPTION 'Essa fusão não existe.'; END IF;

  SELECT * INTO para FROM catalogo.vinhos WHERE id = a.id_para FOR UPDATE;
  IF para.id IS NOT NULL THEN
    v_ficha   := para.ficha;
    v_origens := para.origens;
    FOR k, v IN SELECT key, value FROM jsonb_each(a.campos_movidos) LOOP
      IF (v_origens -> k) IS NOT DISTINCT FROM (v -> 'depois_origem') THEN
        IF (v -> 'antes') IS NULL OR jsonb_typeof(v -> 'antes') = 'null' THEN
          v_ficha   := v_ficha   - k;      -- não estava lá: volta a não estar
          v_origens := v_origens - k;
        ELSE
          v_ficha   := v_ficha   || jsonb_build_object(k, v -> 'antes');
          v_origens := v_origens || jsonb_build_object(k, COALESCE(v -> 'antes_origem', '{}'::jsonb));
        END IF;
        n_rep := n_rep + 1;
      ELSE
        n_mant := n_mant + 1;              -- alguém escreveu depois: fica
      END IF;
    END LOOP;
    UPDATE catalogo.vinhos
       SET ficha = v_ficha, origens = v_origens, atualizado_em = now()
     WHERE id = para.id;
  END IF;

  -- A linha volta ao caminho da `achar` com as chaves que tinha.
  UPDATE catalogo.vinhos SET
    chave      = a.chave_de,
    chave_base = a.chave_base_de,
    chave_nome = a.chave_nome_de,
    base_nome  = a.base_nome_de
  WHERE id = a.id_de;

  DELETE FROM catalogo.alias WHERE chave_de = a.chave_de;

  RETURN jsonb_build_object('ok', true, 'repostos', n_rep, 'mantidos', n_mant);
END;
$$;


-- =====================================================================
-- 4. O TAMANHO DO CATÁLOGO, E DE ONDE VEIO CADA CAMPO
--
-- A segunda metade do ecrã de Resumo. "Quantos campos vieram de cada
-- origem" é a pergunta que apanhou a avaria que esteve semanas de pé: os
-- 3106 campos do catálogo estavam TODOS a força 3, nenhum tinha entrado
-- por uma pesquisa, e nenhum podia, porque 3 tapa 2. Um número destes no
-- ecrã tê-la-ia apanhado no primeiro dia.
-- =====================================================================
CREATE OR REPLACE FUNCTION catalogo.resumo()
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'catalogo', 'public'
AS $$
DECLARE v_res jsonb;
BEGIN
  IF NOT catalogo.pode_ler() THEN
    RAISE EXCEPTION 'Sem acesso ao catálogo.';
  END IF;

  WITH vivas AS (
    SELECT * FROM catalogo.vinhos WHERE chave NOT LIKE 'alias:%'
  ), campos AS (
    SELECT o.key AS campo,
           COALESCE(o.value ->> 'o', '(sem origem)') AS origem,
           COALESCE((o.value ->> 'f')::integer, 0)   AS forca
      FROM vivas v, jsonb_each(v.origens) o
  )
  SELECT jsonb_build_object(
    'linhas',        (SELECT count(*) FROM vivas),
    'distintos',     (SELECT count(DISTINCT chave_base) FROM vivas),
    'semAno',        (SELECT count(*) FROM vivas WHERE ano IS NULL),
    'campos',        (SELECT count(*) FROM campos),
    'mediaCampos',   (SELECT round(AVG(n), 1) FROM (
                        SELECT (SELECT count(*) FROM jsonb_object_keys(v.ficha)) AS n
                          FROM vivas v) t),
    'estacionadas',  (SELECT count(*) FROM catalogo.vinhos WHERE chave LIKE 'alias:%'),
    'fusoes',        (SELECT count(*) FROM catalogo.alias),
    'distintosMarcados', (SELECT count(*) FROM catalogo.distintos),
    -- quantos campos por ORIGEM, e a que força entraram
    'origens', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('origem', c.origem, 'forca', c.forca, 'campos', c.n)
                         ORDER BY c.n DESC)
          FROM (SELECT origem, forca, count(*) AS n FROM campos GROUP BY origem, forca) c
      ), '[]'::jsonb),
    -- e quantos campos VOLÁTEIS estão velhos (>30 dias): é o que as apps
    -- vão pedir outra vez à IA na próxima pergunta
    'volateisVelhos', (
        SELECT count(*) FROM vivas v, jsonb_each(v.origens) o
         WHERE catalogo.volatil(o.key)
           AND COALESCE((o.value ->> 'em')::timestamptz, v.criado_em) < now() - interval '30 days')
  ) INTO v_res;

  RETURN v_res;
END;
$$;


-- =====================================================================
-- 5. O CONSUMO DAS OUTRAS DUAS APPS — `catalogo.consumo`
--
-- A pergunta que deu origem ao catálogo ("está a poupar quanto?") tem a
-- resposta em `garrafeira.sync_log` e `wineselection.sync_log` — duas
-- tabelas em dois schemas que a WineCatalog não tem (nem deve ter) que
-- conhecer. A vista põe as duas na mesma forma, e a app fala só com o
-- `catalogo`, sem espreitar para dentro das outras duas.
--
-- AS UNIDADES NÃO SÃO A MESMA COISA, e somá-las era inventar um número:
--   · a `vinho-info` conta CAMPOS   (castas, região, teor…);
--   · a `sugerir-vinho` conta NOTAS (uma por vinho da carta);
--   · a `verificar-vinhos` conta VINHOS.
-- Por isso cada linha diz em que UNIDADE está, e quem soma só soma dentro
-- da mesma. O que atravessa as três e se pode somar é o PEDIDO: um pedido
-- que não foi à IA nenhuma vez (`so_catalogo`) é uma ida poupada, e essa
-- conta-se igual nas três.
--
-- O CUSTO: `custo_estimado_eur` vem dos próprios logs, e onde não vem é
-- porque não houve chamada nenhuma (a `vinho-info` servida pelo catálogo
-- nem sequer escreve o campo) — daí o zero. É uma ESTIMATIVA GROSSEIRA,
-- não um preço publicado, e a pesquisa Google é faturada à parte por
-- pedido. Os TOKENS é que são facto: vêm da API do Gemini. O ecrã tem de
-- dizer as duas coisas.
--
-- SEGURANÇA: uma vista não é `security_invoker`, corre como o DONO, e o
-- dono aqui passa por cima da RLS das duas `sync_log`. Ou seja: esta vista
-- vê tudo, INCLUINDO o `quem` de cada pedido. Por isso não se dá SELECT
-- dela a ninguém (ver os REVOKEs no fim) e quem lhe chega é só a função
-- abaixo, que agrega e NUNCA devolve o `quem` — quanto é que o catálogo
-- poupou não precisa de dizer quem é que andou a usar o quê.
-- =====================================================================

-- Ler um número de um jsonb sem rebentar se lá estiver um texto. Um
-- `(detalhe->>'x')::numeric` seco morre com a linha inteira no dia em que
-- alguém gravar "n/d" — e o ecrã ficava em branco sem se perceber porquê.
CREATE OR REPLACE FUNCTION catalogo.num(p jsonb, k text)
  RETURNS numeric LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN jsonb_typeof(p -> k) = 'number' THEN (p ->> k)::numeric ELSE 0 END;
$$;

CREATE OR REPLACE VIEW catalogo.consumo AS
  -- Garrafeira / vinho-info — conta CAMPOS.
  -- Só `origem='function'`: as linhas com origem 'app' são outro tipo de
  -- registo (a app a anotar-se a si própria) e não são pedidos à IA.
  SELECT 'garrafeira'::text AS app,
         l.acao,
         l.estado,
         l.criado_em,
         COALESCE(l.detalhe ->> 'modo', '')                  AS modo,
         (COALESCE(l.detalhe ->> 'modo', '') = 'catalogo')    AS so_catalogo,
         'campos'::text                                      AS unidade,
         CASE WHEN COALESCE(l.detalhe ->> 'modo', '') = 'catalogo'
              THEN catalogo.num(l.detalhe, 'campos')
              ELSE catalogo.num(l.detalhe, 'catalogo_campos') END AS itens_catalogo,
         catalogo.num(l.detalhe, 'ia_campos')                 AS itens_ia,
         catalogo.num(l.detalhe, 'custo_estimado_eur')        AS custo_eur,
         catalogo.num(l.detalhe -> 'usageMetadata', 'totalTokenCount') AS tokens
    FROM garrafeira.sync_log l
   WHERE l.origem = 'function'

  UNION ALL

  -- WineSelection / sugerir-vinho — conta NOTAS da carta.
  -- `so_catalogo` é sempre falso e não é um esquecimento: esta chamada lê
  -- uma FOTOGRAFIA, e isso não há catálogo que o responda. O que o
  -- catálogo aqui poupa é a SEGUNDA chamada (a das notas), e isso
  -- aparece em `itens_catalogo`.
  SELECT 'wineselection'::text,
         l.acao,
         l.estado,
         l.criado_em,
         COALESCE(l.detalhe ->> 'modelo', ''),
         false,
         'notas'::text,
         catalogo.num(l.detalhe, 'pontuacoes_catalogo'),
         GREATEST(catalogo.num(l.detalhe, 'pontuacoes_aprox')
                  - catalogo.num(l.detalhe, 'pontuacoes_catalogo'), 0),
         catalogo.num(l.detalhe, 'custo_estimado_eur'),
         catalogo.num(l.detalhe -> 'usageMetadata', 'totalTokenCount')
    FROM wineselection.sync_log l
   WHERE l.acao = 'sugerir_vinho'

  UNION ALL

  -- WineSelection / verificar-vinhos — conta VINHOS. É a mais cara das
  -- três (pesquisa Google a sério), e a única da WineSelection que o
  -- catálogo pode servir inteira.
  SELECT 'wineselection'::text,
         l.acao,
         l.estado,
         l.criado_em,
         COALESCE(l.detalhe ->> 'modelo', ''),
         (COALESCE(l.detalhe ->> 'modelo', '') = 'catalogo'),
         'vinhos'::text,
         catalogo.num(l.detalhe, 'catalogo'),
         catalogo.num(l.detalhe, 'gemini'),
         catalogo.num(l.detalhe, 'custo_estimado_eur'),
         catalogo.num(l.detalhe -> 'usageMetadata', 'totalTokenCount')
    FROM wineselection.sync_log l
   WHERE l.acao = 'verificar_vinhos';


-- O Resumo (§4.1), agregado e sem `quem`.
--
-- A POUPANÇA em euros é uma estimativa EM CIMA de uma estimativa e está
-- marcada como tal: um pedido servido pelo catálogo não deixou registo do
-- que TERIA custado, por isso usa-se o custo MÉDIO dos pedidos da mesma
-- ação que foram mesmo à IA. O número que é FACTO — e o que interessa ver
-- a crescer — é a contagem de pedidos servidos sem IA nenhuma.
CREATE OR REPLACE FUNCTION catalogo.consumo_resumo(p_dias integer DEFAULT NULL)
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'catalogo', 'public'
AS $$
DECLARE
  v_desde timestamptz := CASE WHEN COALESCE(p_dias, 0) > 0
                              THEN now() - make_interval(days => p_dias) END;
  v_res jsonb;
BEGIN
  IF NOT catalogo.pode_ler() THEN
    RAISE EXCEPTION 'Sem acesso ao catálogo.';
  END IF;

  WITH base AS (
    SELECT * FROM catalogo.consumo
     WHERE estado <> 'pedido'
       AND (v_desde IS NULL OR criado_em >= v_desde)
  ), medias AS (
    SELECT app, acao, AVG(custo_eur) AS custo_medio
      FROM base WHERE NOT so_catalogo AND custo_eur > 0
     GROUP BY app, acao
  ), porAcao AS (
    SELECT b.app, b.acao, b.unidade,
           count(*)                                        AS pedidos,
           count(*) FILTER (WHERE b.so_catalogo)            AS pedidos_catalogo,
           count(*) FILTER (WHERE b.estado = 'erro')        AS erros,
           sum(b.itens_catalogo)                            AS itens_catalogo,
           sum(b.itens_ia)                                  AS itens_ia,
           sum(b.custo_eur)                                 AS custo,
           sum(b.tokens)                                    AS tokens,
           COALESCE(count(*) FILTER (WHERE b.so_catalogo) * max(m.custo_medio), 0) AS poupado
      FROM base b
      LEFT JOIN medias m ON m.app = b.app AND m.acao = b.acao
     GROUP BY b.app, b.acao, b.unidade
  )
  SELECT jsonb_build_object(
    'desde', v_desde,
    'total', jsonb_build_object(
      'pedidos',          COALESCE((SELECT sum(pedidos)          FROM porAcao), 0),
      'pedidosCatalogo',  COALESCE((SELECT sum(pedidos_catalogo) FROM porAcao), 0),
      'erros',            COALESCE((SELECT sum(erros)            FROM porAcao), 0),
      'custo',            COALESCE((SELECT round(sum(custo), 4)  FROM porAcao), 0),
      'poupado',          COALESCE((SELECT round(sum(poupado), 4) FROM porAcao), 0),
      'tokens',           COALESCE((SELECT sum(tokens)           FROM porAcao), 0)
    ),
    'porAcao', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'app', app, 'acao', acao, 'unidade', unidade,
               'pedidos', pedidos, 'pedidosCatalogo', pedidos_catalogo,
               'erros', erros,
               'itensCatalogo', itens_catalogo, 'itensIA', itens_ia,
               'custo', round(custo, 4), 'poupado', round(poupado, 4),
               'tokens', tokens
             ) ORDER BY app, acao) FROM porAcao), '[]'::jsonb),
    'ultima', COALESCE((
      -- A última chamada de CADA app. É por aqui que se vê se uma delas
      -- está calada — e um log limpo numa app que não corre não é saúde,
      -- é desuso: foi assim que a WineSelection ficou semanas com duas
      -- avarias que a Garrafeira já tinha corrigido.
      SELECT jsonb_agg(jsonb_build_object('app', app, 'acao', acao,
                                          'quando', criado_em, 'estado', estado))
        FROM (SELECT DISTINCT ON (app) app, acao, criado_em, estado
                FROM catalogo.consumo ORDER BY app, criado_em DESC) u), '[]'::jsonb)
  ) INTO v_res;

  RETURN v_res;
END;
$$;


-- =====================================================================
-- 6. QUEM PODE CHAMAR ISTO
--
-- O schema `catalogo` está EXPOSTO na API (é assim que as Edge Functions
-- lhe falam) e uma função SECURITY DEFINER nasce com EXECUTE para PUBLIC.
-- As duas coisas juntas são um caminho direto para dentro se alguém se
-- esquecer do REVOKE — foi essa a razão do REVOKE da `juntar`/`procurar`/
-- `procurar_lote`, e não há razão nenhuma para ser mais frouxo agora que
-- há uma UI.
--
-- A diferença para as três antigas: aquelas são chamadas pela service
-- role (Edge Functions) e por isso `authenticated` fica de fora inteiro.
-- Estas são chamadas por uma PESSOA, com o seu JWT, do browser — por isso
-- `authenticated` tem de poder chamá-las, e é DENTRO de cada uma que se
-- confirma quem é (`pode_ler()` para ler, `sou_admin()` para decidir).
-- O `anon` nunca: não há modo convidado.
--
-- A vista `catalogo.consumo` não se dá a ninguém: corre como o dono e por
-- isso vê as duas `sync_log` inteiras, `quem` incluído. Quem lhe chega é
-- só a `consumo_resumo()`, que agrega.
-- =====================================================================

-- SEM ISTO NADA FUNCIONA, e o erro não diz o que é: "permission denied
-- for schema catalogo" em TODAS as chamadas da app. O ficheiro da
-- Garrafeira só dá USAGE deste schema à service_role, porque até aqui só
-- as Edge Functions é que lhe falavam — a primeira app a falar-lhe com o
-- JWT de uma PESSOA é esta.
--
-- E não abre nada: USAGE num schema deixa REFERENCIAR o que lá está, e
-- cada objeto continua a precisar do seu próprio direito. A tabela
-- `catalogo.vinhos` não tem GRANT nenhum a `authenticated` e tem RLS sem
-- policy nenhuma; a `juntar`/`procurar`/`procurar_lote` estão revogadas.
-- O que `authenticated` passa a alcançar são as funções de baixo — as
-- desta app (que confirmam quem é lá dentro) e as de cálculo da chave
-- (`tokens`, `chave`, `achar`…), que já se contava que alcançasse: são
-- IMMUTABLE/STABLE, correm como quem chama, e as que leem a tabela
-- esbarram na RLS na mesma.
GRANT USAGE ON SCHEMA catalogo TO authenticated;

REVOKE ALL ON catalogo.config    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON catalogo.alias     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON catalogo.distintos FROM PUBLIC, anon, authenticated;
REVOKE ALL ON catalogo.consumo   FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON catalogo.config    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalogo.alias     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalogo.distintos TO service_role;

-- As que a app chama com o JWT de quem está a usá-la.
REVOKE ALL ON FUNCTION catalogo.listar(text, integer, integer)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION catalogo.ver(bigint)                      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION catalogo.candidatos(integer)              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION catalogo.listar_distintos()               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION catalogo.resumo()                         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION catalogo.consumo_resumo(integer)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION catalogo.fundir(bigint, bigint)           FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION catalogo.separar(text)                    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION catalogo.marcar_distintos(bigint, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION catalogo.desmarcar_distintos(text, text)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION catalogo.definir_admin(text)              FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION catalogo.listar(text, integer, integer)   TO authenticated;
GRANT EXECUTE ON FUNCTION catalogo.ver(bigint)                      TO authenticated;
GRANT EXECUTE ON FUNCTION catalogo.candidatos(integer)              TO authenticated;
GRANT EXECUTE ON FUNCTION catalogo.listar_distintos()               TO authenticated;
GRANT EXECUTE ON FUNCTION catalogo.resumo()                         TO authenticated;
GRANT EXECUTE ON FUNCTION catalogo.consumo_resumo(integer)          TO authenticated;
GRANT EXECUTE ON FUNCTION catalogo.fundir(bigint, bigint)           TO authenticated;
GRANT EXECUTE ON FUNCTION catalogo.separar(text)                    TO authenticated;
GRANT EXECUTE ON FUNCTION catalogo.marcar_distintos(bigint, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION catalogo.desmarcar_distintos(text, text)  TO authenticated;
GRANT EXECUTE ON FUNCTION catalogo.definir_admin(text)              TO authenticated;

-- As de apoio: só as duas de identidade é que `authenticated` precisa de
-- chamar (a UI pergunta-lhes que botões mostrar). As outras são chamadas
-- de DENTRO das de cima, onde o SECURITY DEFINER já as alcança.
REVOKE ALL ON FUNCTION catalogo.admin_email()                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION catalogo.sou_admin()                      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION catalogo.pode_ler()                       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION catalogo.resumo_linha(catalogo.vinhos)    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION catalogo.sou_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION catalogo.pode_ler()  TO authenticated;
GRANT EXECUTE ON FUNCTION catalogo.admin_email() TO service_role;

-- ---------------------------------------------------------------------
-- CONFIRMA SEMPRE, depois de correr isto. Cada função nova nasce com
-- EXECUTE para PUBLIC, e um REVOKE esquecido não dá erro nenhum — dá uma
-- porta aberta calada.
--
-- A linha que interessa: `juntar`, `procurar`, `procurar_lote`,
-- `admin_email` e `resumo_linha` têm de estar a `false` para
-- `authenticated`. As desta app, a `true` para `authenticated` e `false`
-- para `anon`.
--
-- As de cálculo da chave (`tokens`, `chave`, `achar`, `forca`, `volatil`,
-- `num`…) aparecem a `true` NOS DOIS, e não é um esquecimento: é como
-- estão na fonte de verdade. São puras sobre os argumentos, e a única que
-- lê a tabela (`achar`) corre como quem chama e esbarra na RLS. O `anon`
-- nem lá chega — não tem USAGE neste schema.
--
--   SELECT p.proname,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
--          has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'catalogo'
--    ORDER BY 1;
--
-- E que a tabela continua fechada (nenhuma policy, como sempre esteve):
--   SELECT count(*) FROM pg_policies WHERE schemaname = 'catalogo';
-- ---------------------------------------------------------------------
