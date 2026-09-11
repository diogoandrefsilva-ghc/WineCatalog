-- =====================================================================
-- MIGRAÇÃO: o catálogo muda-se do schema `catalogo` para `winecatalog`
--
-- Correr UMA vez, no SQL Editor do Supabase, e **antes** de `schema.sql`
-- e `catalogo.sql`. Só é preciso se já tens o schema `catalogo` a
-- funcionar (162 linhas, setembro de 2026). Numa base nova, salta este
-- ficheiro e corre só a ordem normal do db/README.md.
--
-- PORQUÊ. O `catalogo` nasceu num schema só dele porque não era de
-- nenhuma das duas apps que o liam, e pendurá-lo num delas era dar a uma
-- a chave da casa da outra. Isso resolvia o governo mas deixava-o ÓRFÃO:
-- sem ecrã, sem dono, e com a fonte de verdade dentro do repo de uma das
-- consumidoras (Garrafeira) — que é precisamente o que se queria evitar.
-- A WineCatalog existe para ser esse dono. Com ela, o catálogo passa a ter
-- uma casa a sério: um schema, um repo, um admin próprio
-- (`winecatalog.config.admin_email`, que NÃO é o da Garrafeira nem o da
-- WineSelection).
--
-- O QUE MUDA PARA AS OUTRAS DUAS APPS: uma linha em cada Edge Function —
-- o `Accept-Profile`/`Content-Profile` passa de "catalogo" para
-- "winecatalog". Mais nada: os nomes das funções (`juntar`, `procurar`,
-- `procurar_lote`), os argumentos e as respostas são os mesmos.
--
-- ⚠ ESTA MIGRAÇÃO É UM BIG BANG. Entre correr isto e ter as TRÊS Edge
-- Functions redeployadas, elas chamam um schema que já não existe. E
-- falham CALADAS: os `try/catch` que as protegem engolem o erro (por
-- desenho — o catálogo é uma poupança, não uma dependência), por isso a
-- app segue para a IA e paga. Não se vê um erro; vê-se a conta a subir.
-- Por isso:
--
--   1. tem as três funções prontas para deploy ANTES de correres isto;
--   2. corre isto;
--   3. faz deploy das três a seguir, sem intervalo:
--        supabase functions deploy vinho-info        (Garrafeira)
--        supabase functions deploy sugerir-vinho     (WineSelection)
--        supabase functions deploy verificar-vinhos  (WineSelection)
--   4. confirma no passo 6 lá em baixo que voltaram a acertar.
--
-- É REVERSÍVEL enquanto não correres `catalogo.sql`: o passo 7 comentado
-- no fim desfaz a mudança de nome.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. ANTES: guarda o que lá está, para se poder comparar no fim.
--    Se estes números não baterem certo no passo 5, alguma coisa correu
--    mal e o COMMIT não deve acontecer.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE _antes AS
SELECT (SELECT count(*) FROM catalogo.vinhos)                       AS linhas,
       (SELECT count(DISTINCT chave) FROM catalogo.vinhos)          AS chaves,
       (SELECT count(*) FROM catalogo.vinhos v, jsonb_each(v.ficha)) AS campos;
SELECT * FROM _antes;

-- ---------------------------------------------------------------------
-- 2. A mudança de casa.
--
--    `ALTER SCHEMA ... RENAME` move a TABELA com os dados, os índices e
--    as constraints de uma vez — ninguém copia 162 linhas à mão. O que
--    NÃO acompanha são os CORPOS das funções: ficam com `catalogo.` lá
--    dentro escrito em texto, e o `search_path` fixo a apontar para um
--    schema que deixou de existir. Por isso as funções apagam-se aqui e
--    nascem outra vez, corrigidas, quando correres o `catalogo.sql`.
--
--    O `winecatalog` não pode existir já quando isto corre. Se correste
--    o `schema.sql` antes (não devias, mas acontece), o bloco apanha-o e
--    pára com uma mensagem em vez de deixar meio caminho andado.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'catalogo') THEN
    RAISE EXCEPTION 'Não há schema `catalogo` para migrar. Numa base nova salta este ficheiro.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'winecatalog') THEN
    RAISE EXCEPTION 'O schema `winecatalog` já existe. Corre esta migração ANTES do schema.sql, numa base onde ele ainda não exista.';
  END IF;
END $$;

-- As funções antigas vão embora: os corpos delas falam de um schema que
-- deixa de existir, e o `catalogo.sql` cria-as todas de novo.
DROP FUNCTION IF EXISTS catalogo.juntar(text, text, integer, jsonb, text, jsonb);
DROP FUNCTION IF EXISTS catalogo.procurar(text, text, integer, integer);
DROP FUNCTION IF EXISTS catalogo.procurar_lote(jsonb, integer);
DROP FUNCTION IF EXISTS catalogo.achar(text, text, integer, boolean, bigint);
DROP FUNCTION IF EXISTS catalogo.achar(text, text, integer, boolean);
DROP FUNCTION IF EXISTS catalogo.forca(text, text);
DROP FUNCTION IF EXISTS catalogo.forca(text);
DROP FUNCTION IF EXISTS catalogo.volatil(text);
DROP FUNCTION IF EXISTS catalogo.chave(text, text, integer);
DROP FUNCTION IF EXISTS catalogo.chave_base(text, text);
DROP FUNCTION IF EXISTS catalogo.chave_nome(text, integer);
DROP FUNCTION IF EXISTS catalogo.base_nome(text);
DROP FUNCTION IF EXISTS catalogo.tokens(text);

ALTER SCHEMA catalogo RENAME TO winecatalog;

-- ---------------------------------------------------------------------
-- 3. O gancho da Garrafeira aponta para o sítio novo.
--
--    `garrafeira.catalogar_vinho` chama a `juntar` e é ela que leva cada
--    vinho gravado numa garrafeira para o catálogo. Continua a viver no
--    repo Garrafeira (pendura-se em `garrafeira.vinhos`, que é dela) —
--    mas o corpo dela tem `catalogo.juntar` escrito em texto, e sem isto
--    o trigger passava a falhar. Falhava calado, ainda por cima: o
--    `EXCEPTION WHEN OTHERS` do trigger engole tudo, de propósito, para
--    que alimentar o catálogo nunca impeça alguém de guardar uma garrafa.
--
--    A definição completa desta função está em
--    `db/catalogo-partilhado.sql` no repo Garrafeira. Aqui só se troca a
--    chamada, para a base não ficar partida entre correr esta migração e
--    correr o ficheiro de lá.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_src text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'garrafeira' AND p.proname = 'catalogar_vinho') THEN
    SELECT pg_get_functiondef(p.oid) INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'garrafeira' AND p.proname = 'catalogar_vinho'
     LIMIT 1;
    v_src := replace(v_src, 'catalogo.juntar',  'winecatalog.juntar');
    v_src := replace(v_src, '''garrafeira'', ''catalogo'', ''public''',
                            '''garrafeira'', ''winecatalog'', ''public''');
    EXECUTE v_src;
    RAISE NOTICE 'garrafeira.catalogar_vinho passou a chamar winecatalog.juntar';
  ELSE
    RAISE NOTICE 'Não há garrafeira.catalogar_vinho nesta base — nada a fazer.';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4. A `alias` ganha as colunas que lhe faltam, se já existir.
--
--    Só interessa a quem chegou a correr a primeira versão do
--    `catalogo-winecatalog.sql` (a que estacionava as chaves). Nessa, a
--    linha perdedora ficava com as chaves mexidas; agora não se lhes toca
--    e é a `achar` que resolve. O bloco repõe as chaves originais e
--    deita fora as colunas que deixaram de fazer falta.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='winecatalog' AND table_name='alias'
                AND column_name='chave_base_de') THEN
    UPDATE winecatalog.vinhos v SET
      chave      = a.chave_de,
      chave_base = a.chave_base_de,
      chave_nome = a.chave_nome_de,
      base_nome  = a.base_nome_de
      FROM winecatalog.alias a
     WHERE v.id = a.id_de AND v.chave LIKE 'alias:%';
    ALTER TABLE winecatalog.alias
      DROP COLUMN IF EXISTS chave_base_de,
      DROP COLUMN IF EXISTS chave_nome_de,
      DROP COLUMN IF EXISTS base_nome_de;
    RAISE NOTICE 'Chaves estacionadas repostas — agora é a achar() que resolve os aliases.';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5. DEPOIS: os números têm de ser os mesmos. Se não forem, ROLLBACK.
-- ---------------------------------------------------------------------
DO $$
DECLARE a _antes%ROWTYPE; l bigint; c bigint; f bigint;
BEGIN
  SELECT * INTO a FROM _antes;
  SELECT count(*) INTO l FROM winecatalog.vinhos;
  SELECT count(DISTINCT chave) INTO c FROM winecatalog.vinhos;
  SELECT count(*) INTO f FROM winecatalog.vinhos v, jsonb_each(v.ficha);
  IF (l, c) IS DISTINCT FROM (a.linhas, a.chaves) THEN
    RAISE EXCEPTION 'A conta não bate: antes %/% linhas/chaves, agora %/%. Nada foi gravado.',
      a.linhas, a.chaves, l, c;
  END IF;
  RAISE NOTICE 'OK: % linhas, % chaves, % campos (antes: % campos).', l, c, f, a.campos;
END $$;

COMMIT;

-- ---------------------------------------------------------------------
-- 6. A SEGUIR (fora desta transação):
--
--    a) correr, por esta ordem:
--         db/schema.sql          (cria as tabelas da app no schema já existente)
--         db/catalogo.sql        (recria TODAS as funções, agora corrigidas)
--         db/functions.sql
--         db/policies.sql
--         db/admin_pass_temp.sql
--       e, do repo Garrafeira, o `db/catalogo-partilhado.sql` novo (que
--       passou a ser só o gancho da Garrafeira).
--
--    b) no painel: Settings -> API -> Data API -> Exposed schemas —
--       acrescentar `winecatalog` e TIRAR `catalogo`.
--
--    c) deploy das três Edge Functions.
--
--    d) confirmar que as três voltaram a acertar no catálogo. É isto que
--       diz a verdade, e não o facto de não haver erros no ecrã:
--
--         SELECT 'garrafeira' AS app, criado_em, detalhe ->> 'modo' AS modo,
--                detalhe ->> 'catalogo_campos' AS do_catalogo
--           FROM garrafeira.sync_log
--          WHERE origem = 'function' ORDER BY criado_em DESC LIMIT 5;
--
--         SELECT 'wineselection' AS app, criado_em, acao,
--                COALESCE(detalhe ->> 'pontuacoes_catalogo',
--                         detalhe ->> 'catalogo') AS do_catalogo
--           FROM wineselection.sync_log ORDER BY criado_em DESC LIMIT 5;
--
--       Um `do_catalogo` sempre a zero depois do deploy é o sintoma de
--       que alguma delas não está a chegar lá — e é o único sintoma que
--       vais ter.
--
--    e) o ecrã Resumo da WineCatalog mostra o mesmo, sem SQL.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 7. VOLTAR ATRÁS (só enquanto não tiveres corrido o `catalogo.sql`):
--
--      ALTER SCHEMA winecatalog RENAME TO catalogo;
--
--    e depois correr o `db/catalogo-partilhado.sql` ANTIGO do repo
--    Garrafeira, que recria as funções como estavam. As Edge Functions
--    voltam ao deploy anterior.
-- ---------------------------------------------------------------------
