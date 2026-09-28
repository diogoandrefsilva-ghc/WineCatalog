-- =====================================================================
-- WineCatalog — o nome e o produtor do catálogo chegam às garrafeiras
-- (28/09/2026, o dono das apps)
--
-- A decisão já era de 27/09 ("o nome é o mesmo no catálogo e em todas as
-- garrafeiras"), mas não havia como a cumprir: um vinho de uma garrafeira
-- não sabia qual era a sua linha do catálogo — achava-a pelo NOME, de cada
-- vez, e por isso um nome corrigido aqui partia a ligação em vez de chegar
-- lá. A migração 28 do repo Garrafeira (`db/migracao-catalogo-id.sql`)
-- guarda a ligação (`garrafeira.vinhos.catalogo_id`) e traz as funções que
-- escrevem do lado de lá; isto são os dois triggers do lado de cá.
--
-- 1. `vinhos_garrafeiras` — o nome ou o produtor de uma linha mudou: passa
--    a todos os vinhos ligados a ela (`garrafeira.receber_identidade`). Num
--    trigger e não em cada função que escreve, pela razão do histórico: são
--    muitas portas (a `editar` da app e do painel, os Nomes, os Produtores,
--    o "é o mesmo que…", a `fundir`, o produtor da página do Vivino), e a
--    que se esquecesse era um buraco calado.
--    A EXCEÇÃO é a `juntar` (marca `winecatalog.juntar`, em
--    `cor-na-chave.sql`): o nome mais comprido e o produtor que enche um
--    vazio vêm de quem calhou escrever — uma carta, uma pesquisa com IA, uma
--    garrafeira —, não de uma decisão. Foi assim que "Quinta das
--    Carvalhas" passou a "Quintas das Carvalhas" e "Vallado Douro Superior"
--    a "Quinta do Vallado Douro Superior"; levado a todas as garrafeiras,
--    era a IA a mudar o nome do vinho em casa de toda a gente.
--    Os erros NÃO se engolem: uma mudança que o admin decidiu e que não
--    chega às garrafeiras tem de se ver (a lição do trigger dos nomes, que
--    engoliu um erro seu durante horas).
-- 2. `alias_garrafeiras` — uma fusão desfeita (`separar`) ou mudada de
--    alvo: os vinhos ligados à linha que ficava procuram-se outra vez pelo
--    nome (`garrafeira.religar_catalogo`), e o da linha que saiu volta a ela.
--    A fusão não leva o nome da que fica aos vinhos ligados à que sai (a
--    fusão é reversível; um nome levado lá não o era), mas esses passam a
--    receber o nome da que fica da próxima vez que ele mudar — é o mesmo
--    vinho, decidiu o admin.
--
-- Nunca vai o ano (a ligação pode ser a outra colheita do mesmo vinho) nem
-- a cor (cor diferente é outro vinho). Um produtor vazio aqui não apaga o
-- de lá. Sem o schema `garrafeira` (ou sem a migração 28), os triggers não
-- fazem nada.
--
-- Correr DEPOIS da migração 28 da Garrafeira e da `juntar` com a marca
-- (`cor-na-chave.sql`, 28/09/2026). Idempotente.
-- =====================================================================

CREATE OR REPLACE FUNCTION winecatalog.identidade_para_garrafeiras()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF COALESCE(current_setting('winecatalog.juntar', true), '') = 'sim' THEN
    RETURN NULL;
  END IF;
  IF to_regprocedure('garrafeira.receber_identidade(bigint,text,text)') IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM garrafeira.receber_identidade(NEW.id, NEW.nome, NEW.produtor);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.identidade_para_garrafeiras() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS vinhos_garrafeiras ON winecatalog.vinhos;
CREATE TRIGGER vinhos_garrafeiras
  AFTER UPDATE ON winecatalog.vinhos
  FOR EACH ROW
  WHEN (OLD.nome IS DISTINCT FROM NEW.nome OR OLD.produtor IS DISTINCT FROM NEW.produtor)
  EXECUTE FUNCTION winecatalog.identidade_para_garrafeiras();

CREATE OR REPLACE FUNCTION winecatalog.alias_para_garrafeiras()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.id_para IS NOT DISTINCT FROM NEW.id_para THEN
    RETURN NULL;
  END IF;
  IF to_regprocedure('garrafeira.religar_catalogo(bigint)') IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM garrafeira.religar_catalogo(OLD.id_para);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.alias_para_garrafeiras() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS alias_garrafeiras ON winecatalog.alias;
CREATE TRIGGER alias_garrafeiras
  AFTER UPDATE OR DELETE ON winecatalog.alias
  FOR EACH ROW EXECUTE FUNCTION winecatalog.alias_para_garrafeiras();
