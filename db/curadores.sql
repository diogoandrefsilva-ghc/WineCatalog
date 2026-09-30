-- =====================================================================
-- Os CURADORES do catálogo (30/09/2026, o dono das apps: "eu quero definir
-- quem cria novos vinhos no catálogo… e se esses utilizadores fizerem
-- alguma alteração num vinho da sua garrafeira, essa correção deverá
-- atualizar também o vinho no catálogo").
--
-- Um curador é alguém a quem o ADMIN DO CATÁLOGO deu a palavra sobre ele:
-- pode criar uma linha (`criar`) e corrigir uma (`editar`), com a mesma
-- força do admin (a origem `catalogo-curador` vale o mesmo que a
-- `catalogo-admin` na `forca()`, em `catalogo.sql`). As duas funções
-- aceitam-no em `cor-na-chave.sql`, que é onde elas valem.
--
-- A lista vive AQUI e não em `garrafeira.allowed_users`, pela razão de
-- sempre: o catálogo não é de nenhuma das apps, e quem a enche é o admin
-- do catálogo (`sou_admin()`), não o da Garrafeira. É a Garrafeira que a
-- mostra (Definições › Utilizadores), só a quem é o admin do catálogo.
--
-- O que um curador corrige na SUA garrafeira chega à linha ligada
-- (`garrafeira.vinhos.catalogo_id`) pelo trigger de lá — migração 32 da
-- Garrafeira (`db/migracao-curadores.sql`).
--
-- Passar o admin do catálogo (`definir_admin`) NÃO apaga a lista: os
-- curadores são pessoas que o admin escolheu, e o próximo vê-os e decide.
-- Idempotente. Corre DEPOIS do `cor-na-chave.sql`.
-- =====================================================================

CREATE TABLE IF NOT EXISTS winecatalog.curadores (
  email     text PRIMARY KEY,
  criado_em timestamptz NOT NULL DEFAULT now(),
  por       text
);
ALTER TABLE winecatalog.curadores ENABLE ROW LEVEL SECURITY;
-- Zero policies e nenhum GRANT: só se chega pelas funções abaixo.
REVOKE ALL ON winecatalog.curadores FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION winecatalog.sou_curador()
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT auth.email() IS NOT NULL
     AND EXISTS (SELECT 1 FROM winecatalog.curadores c
                  WHERE c.email = lower(auth.email()));
$$;
REVOKE ALL ON FUNCTION winecatalog.sou_curador() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.sou_curador() TO authenticated, service_role;

-- A lista, só ao admin do catálogo.
CREATE OR REPLACE FUNCTION winecatalog.curadores_listar()
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT winecatalog.sou_admin() THEN
    RAISE EXCEPTION 'Só o admin do catálogo vê os curadores.';
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(c.email ORDER BY c.email) FROM winecatalog.curadores c),
                  '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.curadores_listar() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.curadores_listar() TO authenticated;

CREATE OR REPLACE FUNCTION winecatalog.curador_definir(p_email text, p_sim boolean)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  e text := lower(btrim(COALESCE(p_email, '')));
BEGIN
  IF NOT winecatalog.sou_admin() THEN
    RAISE EXCEPTION 'Só o admin do catálogo escolhe os curadores.';
  END IF;
  IF e !~ '^[^@\s]+@[^@\s]+$' THEN
    RAISE EXCEPTION 'Email inválido.';
  END IF;
  IF p_sim THEN
    INSERT INTO winecatalog.curadores (email, por) VALUES (e, auth.email())
    ON CONFLICT (email) DO NOTHING;
  ELSE
    DELETE FROM winecatalog.curadores WHERE email = e;
  END IF;
  INSERT INTO winecatalog.sync_log (origem, acao, estado, quem, detalhe)
  VALUES ('app', 'curador', 'ok', auth.email(),
          jsonb_build_object('email', e, 'curador', p_sim));
  RETURN jsonb_build_object('ok', true, 'email', e, 'curador', p_sim);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.curador_definir(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.curador_definir(text, boolean) TO authenticated;
