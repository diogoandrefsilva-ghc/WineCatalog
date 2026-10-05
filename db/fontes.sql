-- =====================================================================
-- As FONTES de um vinho: retirar um link errado, e o histórico aos
-- curadores (05/10/2026, o dono das apps: "os links dos vinhos que se
-- capturaram nas pesquisas (com opções de poder remover um ou outro que
-- esteja errado) … é uma cena pública, para todos (só não podem remover,
-- só curadores). O histórico seria só para curadores.").
--
-- Quem os mostra é a página do vinho da Garrafeira (a leitura é a
-- `garrafeira.catalogo_fontes`, migração 42 de lá). Aqui ficam as ESCRITAS
-- e as regras do catálogo.
--
-- RETIRAR NÃO É SÓ TIRAR DO ARRAY. As `fontes` juntam-se em cinco portas
-- (a `juntar`, a `pesquisa_aplicar`, a `aplicar_fontes`, a `fundir`, a
-- `criar`), e a pesquisa seguinte ao mesmo vinho voltava a trazer o mesmo
-- link errado. Por isso o link retirado fica numa lista
-- (`fontes_retiradas`) e um trigger na própria `vinhos` tira-o de qualquer
-- escrita — na tabela e não em cada porta, pela razão do histórico: a
-- porta que se esquecesse era um buraco calado. "Devolver" desfaz — e NÃO
-- apaga a linha: marca-a (`devolvido_em`/`devolvido_por`), que fica o
-- registo de quem retirou e de quem devolveu. Retirar outra vez reabre-a.
--
-- O HISTÓRICO passa a ser também dos curadores, mas só o de UM vinho (a
-- página dele); o do catálogo todo continua só do admin (Alertas, o
-- Backoffice). E o "Repor" também — passa pela `editar`, que já aceita os
-- curadores com a força deles.
--
-- Corre depois do `historico.sql` e do `curadores.sql`. Idempotente.
-- =====================================================================

CREATE TABLE IF NOT EXISTS winecatalog.fontes_retiradas (
  vinho_id bigint      NOT NULL,
  url      text        NOT NULL,
  titulo   text,
  quem     text,
  quando   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vinho_id, url)
);
ALTER TABLE winecatalog.fontes_retiradas ADD COLUMN IF NOT EXISTS devolvido_em  timestamptz;
ALTER TABLE winecatalog.fontes_retiradas ADD COLUMN IF NOT EXISTS devolvido_por text;
ALTER TABLE winecatalog.fontes_retiradas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON winecatalog.fontes_retiradas FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON winecatalog.fontes_retiradas TO service_role;

-- O trigger: um link retirado deste vinho não entra, venha de onde vier.
CREATE OR REPLACE FUNCTION winecatalog.fontes_sem_retiradas()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF NEW.fontes IS NULL OR jsonb_typeof(NEW.fontes) <> 'array'
     OR NOT EXISTS (SELECT 1 FROM winecatalog.fontes_retiradas r
                     WHERE r.vinho_id = NEW.id AND r.devolvido_em IS NULL) THEN
    RETURN NEW;
  END IF;
  NEW.fontes := COALESCE((
    SELECT jsonb_agg(f ORDER BY i)
      FROM jsonb_array_elements(NEW.fontes) WITH ORDINALITY x(f, i)
     WHERE NOT EXISTS (SELECT 1 FROM winecatalog.fontes_retiradas r
                        WHERE r.vinho_id = NEW.id AND r.url = f ->> 'url' AND r.devolvido_em IS NULL)
  ), '[]'::jsonb);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS vinhos_fontes ON winecatalog.vinhos;
CREATE TRIGGER vinhos_fontes
  BEFORE INSERT OR UPDATE OF fontes ON winecatalog.vinhos
  FOR EACH ROW EXECUTE FUNCTION winecatalog.fontes_sem_retiradas();

-- Uma linha fundida responde pela que ficou.
CREATE OR REPLACE FUNCTION winecatalog.fonte_alvo(p_id bigint)
  RETURNS bigint LANGUAGE sql STABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT COALESCE((SELECT id_para FROM winecatalog.alias WHERE id_de = p_id), p_id);
$$;

CREATE OR REPLACE FUNCTION winecatalog.fonte_retirar(p_id bigint, p_url text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_id  bigint := winecatalog.fonte_alvo(p_id);
  v_tit text;
BEGIN
  IF NOT (winecatalog.sou_admin() OR winecatalog.sou_curador()) THEN
    RAISE EXCEPTION 'Só os curadores do catálogo retiram links.';
  END IF;
  IF COALESCE(p_url, '') = '' THEN RAISE EXCEPTION 'Falta o link.'; END IF;
  SELECT f ->> 'titulo' INTO v_tit
    FROM winecatalog.vinhos v, jsonb_array_elements(v.fontes) f
   WHERE v.id = v_id AND f ->> 'url' = p_url LIMIT 1;
  INSERT INTO winecatalog.fontes_retiradas (vinho_id, url, titulo, quem)
  VALUES (v_id, p_url, v_tit, lower(auth.email()))
  ON CONFLICT (vinho_id, url) DO UPDATE
     SET titulo = COALESCE(EXCLUDED.titulo, fontes_retiradas.titulo), quem = EXCLUDED.quem,
         quando = now(), devolvido_em = NULL, devolvido_por = NULL;
  -- Reescrever as fontes é quanto basta: o trigger tira o link.
  UPDATE winecatalog.vinhos SET fontes = fontes WHERE id = v_id;
  RETURN jsonb_build_object('ok', true, 'vinho', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION winecatalog.fonte_devolver(p_id bigint, p_url text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_id  bigint := winecatalog.fonte_alvo(p_id);
  v_tit text;
  v_ha  boolean;
BEGIN
  IF NOT (winecatalog.sou_admin() OR winecatalog.sou_curador()) THEN
    RAISE EXCEPTION 'Só os curadores do catálogo devolvem links.';
  END IF;
  UPDATE winecatalog.fontes_retiradas
     SET devolvido_em = now(), devolvido_por = lower(auth.email())
   WHERE vinho_id = v_id AND url = p_url AND devolvido_em IS NULL
  RETURNING true, titulo INTO v_ha, v_tit;
  IF v_ha IS NULL THEN RETURN jsonb_build_object('ok', false); END IF;
  UPDATE winecatalog.vinhos
     SET fontes = COALESCE(fontes, '[]'::jsonb) || jsonb_build_array(
           jsonb_strip_nulls(jsonb_build_object('url', p_url, 'titulo', v_tit)))
   WHERE id = v_id
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(fontes, '[]'::jsonb)) f WHERE f ->> 'url' = p_url);
  RETURN jsonb_build_object('ok', true, 'vinho', v_id);
END;
$$;

-- ---------------------------------------------------------------------
-- O HISTÓRICO: o de um vinho também aos curadores (substitui a versão do
-- `historico.sql`, igual em tudo o resto).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.historico(p_vinho_id bigint DEFAULT NULL, p_limite integer DEFAULT 100)
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT (winecatalog.sou_admin() OR (p_vinho_id IS NOT NULL AND winecatalog.sou_curador())) THEN
    RAISE EXCEPTION 'Só os curadores do catálogo veem o histórico de um vinho (e o admin, o de todos).';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', a.id, 'vinhoId', a.vinho_id, 'campo', a.campo,
      'antes', a.antes, 'depois', a.depois, 'origem', a.origem,
      'quem', a.quem, 'quando', a.quando,
      'nome', v.nome, 'ano', v.ano,
      'agora', v.ficha -> a.campo)
      ORDER BY a.quando DESC, a.id DESC)
    FROM (
      SELECT * FROM winecatalog.alteracoes
       WHERE p_vinho_id IS NULL OR vinho_id = p_vinho_id
          -- As linhas fundidas nesta também contam a história dela.
          OR vinho_id IN (SELECT id_de FROM winecatalog.alias WHERE id_para = p_vinho_id)
       ORDER BY quando DESC, id DESC
       LIMIT GREATEST(1, LEAST(COALESCE(p_limite, 100), 500))
    ) a
    LEFT JOIN winecatalog.vinhos v ON v.id = a.vinho_id
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION winecatalog.repor_alteracao(p_id bigint)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  a      winecatalog.alteracoes%ROWTYPE;
  v_alvo bigint;
BEGIN
  IF NOT (winecatalog.sou_admin() OR winecatalog.sou_curador()) THEN
    RAISE EXCEPTION 'Só os curadores do catálogo repõem valores.';
  END IF;
  SELECT * INTO a FROM winecatalog.alteracoes WHERE id = p_id;
  IF a.id IS NULL THEN RAISE EXCEPTION 'Alteração não encontrada.'; END IF;
  IF a.campo IN ('nome', 'produtor', 'ano', '_criado') THEN
    RAISE EXCEPTION 'A identidade não se repõe daqui — usa o Editar (interruptor de identidade).';
  END IF;
  v_alvo := COALESCE((SELECT id_para FROM winecatalog.alias WHERE id_de = a.vinho_id), a.vinho_id);
  RETURN winecatalog.editar(v_alvo, jsonb_build_object(a.campo, COALESCE(a.antes, 'null'::jsonb)));
END;
$$;

REVOKE ALL ON FUNCTION winecatalog.fontes_sem_retiradas()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION winecatalog.fonte_alvo(bigint)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION winecatalog.fonte_retirar(bigint, text)    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION winecatalog.fonte_devolver(bigint, text)   FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.fonte_retirar(bigint, text)  TO authenticated;
GRANT EXECUTE ON FUNCTION winecatalog.fonte_devolver(bigint, text) TO authenticated;
-- historico/repor: os GRANTs do `historico.sql` continuam a valer.
