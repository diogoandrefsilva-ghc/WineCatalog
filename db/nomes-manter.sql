-- =====================================================================
-- Os nomes que ficam como estão, e as chaves dos fundidos (27/09/2026)
--
-- Correr DEPOIS de `nomes-normalizar.sql` e `cor-na-chave.sql`, e voltar a
-- correr a seguir a `nome_normal`/`nomes_rever` (nomes-normalizar.sql), o
-- trigger `vinhos_nomes` (cor-na-chave.sql) e a `produtor_definir`
-- (produtores.sql) — as três usam o que está aqui.
--
-- 1. NOMES A MANTER. A regra do nome tira o produtor da frente quando o
--    resto "se aguenta sozinho" — uma palavra que não é gama, cor, casta
--    nem região. Há nomes em que isso é verdade para a regra e falso para
--    quem lê: "1836 Grande Reserva" (Companhia das Lezírias), "Clássico 80
--    anos" (Caves Primavera), "1255 Grande Villae" (Taboadella), "Colecção
--    da Família" (Quinta do Piloto). Um número ou uma expressão comum
--    passam por distintivos e não o são. O dono das apps: "eu sei que é
--    complicado fazer uma regra a partir disto" — e é, por isso não há
--    regra: há uma LISTA, escolhida por ele no painel, com o nome como está.
--    Um nome da lista não perde o produtor da frente. O ano e a cor no fim
--    continuam a sair (a cor diz-se ao lado do nome, em itálico).
--    Vale para o catálogo, as garrafeiras e as escritas futuras: a
--    `nome_normal` é a mesma para todos (a `identidade` chama-a).
--    A chave da lista é o nome SEM o ano e a cor do fim, palavra a palavra
--    normalizada (`nome_normal` devolve-a em `chave_manter`).
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

CREATE TABLE IF NOT EXISTS winecatalog.nomes_manter (
  chave  text PRIMARY KEY,           -- o nome sem ano nem cor no fim, normalizado
  nome   text NOT NULL,              -- como estava escrito quando se escolheu
  quem   text,
  quando timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE winecatalog.nomes_manter ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON winecatalog.nomes_manter FROM PUBLIC, anon, authenticated;

-- A chave de uma lista de palavras.
CREATE OR REPLACE FUNCTION winecatalog.chave_manter(p_palavras text[])
  RETURNS text LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT COALESCE(string_agg(k, ' ' ORDER BY i), '')
    FROM unnest(p_palavras) WITH ORDINALITY AS u(w, i),
         LATERAL (SELECT winecatalog.palavra_norm(w) AS k) x
   WHERE k <> '';
$$;

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
-- O painel: marcar/desmarcar e ver a lista. Marcar recebe os itens da
-- simulação ([{fonte, id}]) e guarda a `chave_manter` de cada um.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.nomes_manter_marcar(p_itens jsonb)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'garrafeira', 'public'
AS $$
DECLARE
  it  jsonb;
  r   record;
  nn  jsonb;
  n   integer := 0;
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_itens, '[]'::jsonb)) LOOP
    r := NULL;
    IF it ->> 'fonte' = 'garrafeira' THEN
      SELECT gv.nome, gv.produtor, gv.tipo, gv.ano INTO r
        FROM garrafeira.vinhos gv WHERE gv.id = (it ->> 'id')::bigint;
    ELSE
      SELECT v.nome, v.produtor, v.ficha ->> 'tipo' AS tipo, v.ano INTO r
        FROM winecatalog.vinhos v WHERE v.id = (it ->> 'id')::bigint;
    END IF;
    CONTINUE WHEN r.nome IS NULL;
    nn := winecatalog.nome_normal(r.nome, r.produtor, r.tipo, r.ano);
    CONTINUE WHEN COALESCE(nn ->> 'chave_manter', '') = '';
    INSERT INTO winecatalog.nomes_manter (chave, nome, quem)
    VALUES (nn ->> 'chave_manter', r.nome, COALESCE(NULLIF(auth.email(), ''), 'painel do PC'))
    ON CONFLICT (chave) DO NOTHING;
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'marcados', n);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.nomes_manter_marcar(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.nomes_manter_marcar(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION winecatalog.nomes_manter_tirar(p_chave text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  DELETE FROM winecatalog.nomes_manter WHERE chave = p_chave;
  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.nomes_manter_tirar(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.nomes_manter_tirar(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION winecatalog.nomes_manter_listar()
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('chave', chave, 'nome', nome, 'quando', quando) ORDER BY lower(nome))
                     FROM winecatalog.nomes_manter), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.nomes_manter_listar() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.nomes_manter_listar() TO authenticated, service_role;
