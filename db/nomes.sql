-- =====================================================================
-- WineCatalog — os NOMES com maiúsculas de gente, nunca em CAPS LOCK
--
-- Correr DEPOIS de `catalogo.sql` (usa a `tokens` e a `generico`) e do
-- `historico.sql` (a correção do que já lá estava fica no histórico).
-- Idempotente. Do repo Garrafeira, a `db/migracao-nomes.sql` (migração 20)
-- corre DEPOIS deste: é o mesmo trigger em `garrafeira.vinhos`, a chamar a
-- MESMA função — a regra vive só aqui.
--
-- PORQUÊ. A 26/09/2026 o dono deu com a "HERDADE DO SOBROSO RESERVA TINTO"
-- (e a "PÊRA-MANCA VINHO TINTO", a "TABOADELLA 1255 GRANDE VILLAE BRANCO",
-- a "CARTUXA", a "CASA ERMELINDA FREITAS") nas duas bases: vinham de
-- rótulos lidos por fotografia, que escrevem como o rótulo está impresso.
-- A regra dele: Herdades, Montes, Quintas… sempre com maiúscula, e o "do",
-- o "da", o "de" sempre em minúsculas.
--
-- COMO. Um trigger na própria tabela, e não uma chamada em cada porta — a
-- lição do `historico.sql`: são seis portas a escrever no catálogo (juntar,
-- editar, criar, fundir, aplicar_fontes, vivino_*) e mais cinco a escrever
-- numa garrafeira (formulário, importação por fotos, wishlist, IA,
-- atualização massiva). Uma que se esquecesse era um buraco calado. A
-- `normalizar_regiao` (catalogo.sql) seguiu o outro caminho, e é por isso
-- que tem de ser chamada à mão em quatro sítios.
--
-- A CHAVE NÃO MUDA: a `tokens` passa tudo a minúsculas antes de cortar,
-- por isso "HERDADE DO SOBROSO" e "Herdade do Sobroso" já eram o mesmo
-- vinho. Isto é só o que se LÊ no ecrã.
-- =====================================================================

-- ---------------------------------------------------------------------
-- UMA PALAVRA com maiúscula inicial: "PÊRA-MANCA" → "Pêra-Manca",
-- "D'HONOR" → "d'Honor", "GRAHAM'S" → "Graham's", "(MONTE" → "(Monte".
--
-- Não é o `initcap()`: esse põe maiúscula depois de QUALQUER sinal
-- ("Graham'S") e não sabe que o "do" fica pequeno. A maiúscula vai para a
-- primeira LETRA (há parêntesis e aspas à frente), para cada pedaço de um
-- hífen ("Trás-os-Montes": as ligações ficam pequenas), e para a letra a
-- seguir a uma plica de uma letra só ("d'Honor", "O'Neill").
--
-- `p_inicio`: a primeira palavra do nome. Aí até o "Da"/"D'" é maiúsculo.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.nome_palavra(p_palavra text, p_inicio boolean)
  RETURNS text LANGUAGE plpgsql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  pequenas text[] := ARRAY['de','da','do','das','dos','e'];
  ligacoes text[] := ARRAY['de','da','do','das','dos','e','o','a','os','as','em','no','na','nos','nas'];
  partes   text[] := string_to_array(lower(COALESCE(p_palavra, '')), '-');
  k        integer;
  m        text[];
  meio     boolean;
BEGIN
  FOR k IN 1..COALESCE(array_length(partes, 1), 0) LOOP
    meio := k > 1 OR NOT p_inicio;
    CONTINUE WHEN meio AND partes[k] = ANY(CASE WHEN k > 1 THEN ligacoes ELSE pequenas END);
    m := regexp_match(partes[k], '^([^[:alpha:]]*)([[:alpha:]])([''’])([[:alpha:]])(.*)$');
    IF m IS NOT NULL THEN
      partes[k] := m[1] || CASE WHEN m[2] = 'd' AND meio THEN 'd' ELSE upper(m[2]) END
                        || m[3] || upper(m[4]) || m[5];
    ELSE
      m := regexp_match(partes[k], '^([^[:alpha:]]*)([[:alpha:]])(.*)$');
      IF m IS NOT NULL THEN
        partes[k] := m[1] || upper(m[2]) || m[3];
      END IF;
    END IF;
  END LOOP;
  RETURN array_to_string(partes, '-');
END;
$$;

-- ---------------------------------------------------------------------
-- O NOME inteiro. O difícil não é pôr maiúsculas — é saber quando NÃO
-- mexer, porque o catálogo tem siglas a sério: "CARM — Casa Agrícola
-- Roboredo Madeira", "SIVIPA — …", "Mal Acompanhado JCA", "Diálogo Douro
-- DOC". Uma palavra em maiúsculas sozinha no meio de um nome normal é
-- quase sempre uma sigla; duas SEGUIDAS são quase sempre CAPS LOCK. Daí:
--
--   1. tudo em minúsculas ("valedevila", "herdade do sobroso") → cada
--      palavra com maiúscula (as siglas conhecidas voltam a sê-lo);
--   2. uma palavra em maiúsculas muda se tiver outra em maiúsculas ao lado
--      ("HERDADE DO SOBROSO Grande Reserva" — os números e os travessões
--      não contam como vizinhos nem cortam a sequência), se for a ÚNICA
--      palavra do nome e tiver 4 letras ou mais ("CARTUXA"; "JCA" fica), ou
--      se for uma palavra genérica, que nunca é sigla ("… Reserva TINTO" —
--      a mesma lista da `generico` dos Duplicados, mais as vazias e as de
--      casa da `tokens`: vinho, quinta, herdade, casa, adega, monte…);
--   3. as siglas da lista (DOC, LBV, VT…) e os números romanos nunca mudam;
--   4. a meio do nome, "de/da/do/das/dos/e" e o "d'" vão SEMPRE em
--      minúsculas ("Quinta Do Crasto" → "Quinta do Crasto"; "Clefs D'or" →
--      "Clefs d'Or", que o que vem a seguir ao "d'" é um nome), e as
--      palavras de lugar (quinta, herdade, monte, casa…) SEMPRE com
--      maiúscula.
--
-- Nada mais se toca: um nome já com maiúsculas e minúsculas misturadas
-- ("Leo d'Honor", "Carm Grande Reserva") está como alguém o quis, e é esse
-- o nome que fica. Espaços a mais saem.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.nome_proprio(p_texto text)
  RETURNS text LANGUAGE plpgsql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v        text := btrim(regexp_replace(COALESCE(p_texto, ''), '\s+', ' ', 'g'));
  pequenas text[] := ARRAY['de','da','do','das','dos','e'];
  lugares  text[] := ARRAY['quinta','quintas','herdade','herdades','monte','montes',
                           'casa','adega','solar','paço','tapada','morgado','convento',
                           'palácio','castelo'];
  siglas   text[] := ARRAY['DOC','DOP','IGP','IG','LBV','VT','VR','VQPRD','VLQPRD',
                           'VEQPRD','VFQPRD','VV','SA','CRL','AOC','NV','USA','UK'];
  romano   text := '^(X{0,3})(IX|IV|V?I{0,3})$';
  pal      text[];
  letras   text[] := '{}';
  grita    boolean[] := '{}';
  sigla    boolean[] := '{}';
  n        integer;
  n_letras integer := 0;
  tudo_min boolean;
  inicio   boolean := true;
  mexer    boolean;
  i        integer;
  j        integer;
  w        text;
  low      text;
  saida    text[] := '{}';
BEGIN
  IF v = '' THEN RETURN p_texto; END IF;
  pal      := string_to_array(v, ' ');
  n        := array_length(pal, 1);
  tudo_min := v = lower(v) AND v <> upper(v);

  FOR i IN 1..n LOOP
    letras[i] := regexp_replace(pal[i], '[^[:alpha:]]', '', 'g');
    grita[i]  := letras[i] <> '' AND letras[i] = upper(letras[i]) AND letras[i] <> lower(letras[i]);
    sigla[i]  := grita[i] AND (letras[i] = ANY(siglas) OR letras[i] ~ romano);
    IF letras[i] <> '' THEN n_letras := n_letras + 1; END IF;
  END LOOP;

  FOR i IN 1..n LOOP
    w := pal[i];
    IF letras[i] = '' THEN            -- "1255", "—", "&": ficam como estão
      saida := saida || w;
      CONTINUE;
    END IF;
    low := lower(w);

    IF tudo_min THEN
      mexer := true;
    ELSIF grita[i] AND NOT sigla[i] THEN
      mexer := (n_letras = 1 AND length(letras[i]) >= 4)
            OR COALESCE((SELECT bool_and(winecatalog.generico(t))
                           FROM unnest(winecatalog.tokens(w)) t), true);
      j := i - 1;
      WHILE j >= 1 AND letras[j] = '' LOOP j := j - 1; END LOOP;
      IF j >= 1 AND grita[j] THEN mexer := true; END IF;
      j := i + 1;
      WHILE j <= n AND letras[j] = '' LOOP j := j + 1; END LOOP;
      IF j <= n AND grita[j] THEN mexer := true; END IF;
    ELSE
      mexer := false;
    END IF;

    IF tudo_min AND length(letras[i]) >= 2
       AND (upper(letras[i]) = ANY(siglas) OR upper(letras[i]) ~ romano) THEN
      w := upper(w);                                   -- "porto lbv" → "Porto LBV"
    ELSIF mexer THEN
      w := winecatalog.nome_palavra(w, inicio);
    ELSIF NOT inicio AND low = ANY(pequenas) THEN
      w := low;                                        -- "Herdade DO Sobroso", "Quinta Do Crasto"
    ELSIF NOT inicio AND w ~* '^d[''’][[:alpha:]]' THEN
      w := 'd' || substr(w, 2, 1) || upper(substr(w, 3, 1)) || substr(w, 4);  -- "Leo D'Honor", "Clefs D'or"
    ELSIF w = low AND low = ANY(lugares) THEN
      w := winecatalog.nome_palavra(w, inicio);        -- "Crasto quinta" não, "quinta" sim
    END IF;

    saida  := saida || w;
    inicio := false;
  END LOOP;

  RETURN array_to_string(saida, ' ');
END;
$$;

-- Só os triggers as chamam (SECURITY DEFINER, abaixo e na Garrafeira). A
-- `generico` que a `nome_proprio` usa não é de quem tem login, e por isso
-- esta também não: chamada por uma sessão falhava na `generico` — e o
-- trigger, que engole o erro, deixava o nome em maiúsculas sem uma palavra.
REVOKE ALL ON FUNCTION winecatalog.nome_palavra(text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION winecatalog.nome_proprio(text)          FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- O TRIGGER do catálogo. SECURITY DEFINER porque quem escreve aqui tanto
-- pode ser uma função do dono como a `service_role` do script do PC, e a
-- `nome_proprio` não se dá a nenhuma das sessões. E se falhar, grava-se o
-- nome como veio: é arrumação, nunca pode deitar uma escrita abaixo
-- (invariante 7).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.vinhos_nomes()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  BEGIN
    NEW.nome     := winecatalog.nome_proprio(NEW.nome);
    NEW.produtor := winecatalog.nome_proprio(NEW.produtor);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;

-- Um trigger dispara sem olhar ao EXECUTE (só o CREATE TRIGGER o pede), e
-- sem isto o linter do Supabase lista-a como SECURITY DEFINER aberta.
REVOKE ALL ON FUNCTION winecatalog.vinhos_nomes() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS vinhos_nomes ON winecatalog.vinhos;
CREATE TRIGGER vinhos_nomes
  BEFORE INSERT OR UPDATE OF nome, produtor ON winecatalog.vinhos
  FOR EACH ROW EXECUTE FUNCTION winecatalog.vinhos_nomes();

-- ---------------------------------------------------------------------
-- E o que já lá estava (26/09/2026: as três Herdade do Sobroso, a
-- Pêra-Manca, a Taboadella, a Cartuxa, a Casa Ermelinda Freitas, o
-- "valedevila", e o "D'" da Clefs d'Or e do Foral d'Évora — 9 linhas).
-- Fica no histórico, com quem a fez. Não mexe no `origens`
-- nem no `atualizado_em`: é o mesmo nome, escrito como deve ser — não é
-- uma escrita nova e não compete por força com nada.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  PERFORM set_config('winecatalog.quem', 'correção: nomes em maiúsculas', true);
  UPDATE winecatalog.vinhos
     SET nome     = winecatalog.nome_proprio(nome),
         produtor = winecatalog.nome_proprio(produtor)
   WHERE nome     IS DISTINCT FROM winecatalog.nome_proprio(nome)
      OR produtor IS DISTINCT FROM winecatalog.nome_proprio(produtor);
  PERFORM set_config('winecatalog.quem', '', true);
END;
$$;
