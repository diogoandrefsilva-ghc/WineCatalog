-- =====================================================================
-- Os produtores que ficam no nome, e as chaves dos fundidos (27/09/2026)
--
-- Correr DEPOIS de `nomes-normalizar.sql` e `cor-na-chave.sql`, e voltar a
-- correr a seguir a `nome_normal`/`nomes_rever` (nomes-normalizar.sql), o
-- trigger `vinhos_nomes` (cor-na-chave.sql) e a `produtor_definir`
-- (produtores.sql) — as três usam o que está aqui.
--
-- 1. PRODUTORES QUE FICAM NO NOME. A regra tira o produtor da frente
--    quando o resto "se aguenta sozinho" — uma palavra que não é gama, cor,
--    casta nem região. Há casas em que isso é verdade para a regra e falso
--    para quem lê: "1836 Grande Reserva" (Companhia das Lezírias), "Clássico
--    80 anos" (Caves Primavera), "1255 Grande Villae" (Taboadella),
--    "Colecção da Família" (Quinta do Piloto). Um número ou uma expressão
--    comum passam por distintivos e não o são. O dono das apps: "eu sei que é
--    complicado fazer uma regra a partir disto" — por isso não há regra: há
--    uma LISTA DE PRODUTORES, escolhida por ele no painel. Nos vinhos de um
--    produtor da lista, o produtor fica à frente do nome — e, desde
--    28/09/2026, ENTRA à frente quando o nome não o diz ("nos vinhos deste
--    produtor, o nome do produtor deve aparecer no nome do vinho"; a regra
--    está na `nome_normal`). Liga-se por produtor no separador Produtores
--    do painel, que mostra logo os nomes que mudam. O ano e a cor no
--    fim continuam a sair (a cor diz-se ao lado do nome, em itálico).
--    Vale para o catálogo, as garrafeiras e as escritas futuras: a
--    `nome_normal` é a mesma para todos (a `identidade` chama-a). A chave é
--    a do produtor OFICIAL (`chave_produtor(produtor_oficial(…))`), por isso
--    apanha as grafias dele.
--    (Houve umas horas uma lista de NOMES, `nomes_manter`; o dono preferiu
--    a do produtor — um vinho novo da mesma casa já nasce certo.)
--
-- 2. A CHAVE DE UM FUNDIDO NÃO TRAVA A ALVO. Uma linha fundida (perdedora
--    de um `alias`) guarda as chaves que tinha — é por elas que a grafia
--    antiga continua a achar a alvo. Mas a `chave` é ÚNICA, e quando a alvo
--    passava a ter essa mesma chave (o "Carlos Alonso Piano 17" #92 a ficar
--    "Piano 17" com o produtor oficial, que é exatamente o #116 fundido
--    nele), a mudança era recusada como "duplicado" — de si própria. A
--    `libertar_chave` estaciona a `chave` da perdedora (acrescenta `~<id>`):
--    a `achar` casa pela `chave_base`/`base_nome`, que não mudam, e a
--    própria alvo passa a ter a chave. Só para perdedoras dessa alvo; uma
--    linha viva com a mesma chave continua a ser um duplicado a juntar.
-- =====================================================================

DROP FUNCTION IF EXISTS winecatalog.nomes_manter_marcar(jsonb);
DROP FUNCTION IF EXISTS winecatalog.nomes_manter_tirar(text);
DROP FUNCTION IF EXISTS winecatalog.nomes_manter_listar();
DROP FUNCTION IF EXISTS winecatalog.chave_manter(text[]);
DROP TABLE IF EXISTS winecatalog.nomes_manter;

CREATE TABLE IF NOT EXISTS winecatalog.produtores_no_nome (
  chave    text PRIMARY KEY,         -- chave_produtor do produtor oficial
  produtor text NOT NULL,            -- como se escreve (o oficial)
  quem     text,
  quando   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE winecatalog.produtores_no_nome ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON winecatalog.produtores_no_nome FROM PUBLIC, anon, authenticated;

-- O produtor fica no nome dos seus vinhos?
CREATE OR REPLACE FUNCTION winecatalog.produtor_no_nome(p_produtor text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT EXISTS (SELECT 1 FROM winecatalog.produtores_no_nome m
                  WHERE m.chave = winecatalog.chave_produtor(winecatalog.produtor_oficial(p_produtor))
                    AND m.chave <> '');
$$;
REVOKE ALL ON FUNCTION winecatalog.produtor_no_nome(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.produtor_no_nome(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- A chave `p_chave` pode ser da linha `p_id`? Sim se ninguém a tiver, ou
-- se quem a tem é uma linha FUNDIDA nesta (e aí estaciona-a). Não se é de
-- outra linha viva: isso é um duplicado.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.libertar_chave(p_chave text, p_id bigint)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  o bigint;
BEGIN
  SELECT v.id INTO o FROM winecatalog.vinhos v
   WHERE v.chave = p_chave AND v.id IS DISTINCT FROM p_id;
  IF o IS NULL THEN RETURN true; END IF;
  IF p_id IS NOT NULL AND EXISTS (SELECT 1 FROM winecatalog.alias a WHERE a.id_de = o AND a.id_para = p_id) THEN
    UPDATE winecatalog.vinhos SET chave = p_chave || '~' || o WHERE id = o;
    RETURN true;
  END IF;
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.libertar_chave(text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION winecatalog.libertar_chave(text, bigint) TO service_role;

-- ---------------------------------------------------------------------
-- O painel: marcar/desmarcar e ver a lista. Marcar recebe itens da
-- simulação ([{fonte, id}]) e guarda o produtor de cada um, ou nomes de
-- produtores diretamente ([{produtor}]).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.produtores_no_nome_marcar(p_itens jsonb)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'garrafeira', 'public'
AS $$
DECLARE
  it  jsonb;
  p   text;
  k   text;
  n   integer := 0;
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_itens, '[]'::jsonb)) LOOP
    p := NULL;
    IF it ? 'produtor' THEN
      p := it ->> 'produtor';
    ELSIF it ->> 'fonte' = 'garrafeira' THEN
      SELECT gv.produtor INTO p FROM garrafeira.vinhos gv WHERE gv.id = (it ->> 'id')::bigint;
    ELSE
      SELECT v.produtor INTO p FROM winecatalog.vinhos v WHERE v.id = (it ->> 'id')::bigint;
    END IF;
    p := winecatalog.produtor_oficial(btrim(COALESCE(p, '')));
    k := winecatalog.chave_produtor(p);
    CONTINUE WHEN COALESCE(k, '') = '';
    INSERT INTO winecatalog.produtores_no_nome (chave, produtor, quem)
    VALUES (k, p, COALESCE(NULLIF(auth.email(), ''), 'painel do PC'))
    ON CONFLICT (chave) DO NOTHING;
    IF FOUND THEN n := n + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'marcados', n);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.produtores_no_nome_marcar(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.produtores_no_nome_marcar(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION winecatalog.produtores_no_nome_tirar(p_chave text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  DELETE FROM winecatalog.produtores_no_nome WHERE chave = p_chave;
  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.produtores_no_nome_tirar(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.produtores_no_nome_tirar(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION winecatalog.produtores_no_nome_listar()
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('chave', chave, 'produtor', produtor, 'quando', quando) ORDER BY lower(produtor))
                     FROM winecatalog.produtores_no_nome), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.produtores_no_nome_listar() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.produtores_no_nome_listar() TO authenticated, service_role;
