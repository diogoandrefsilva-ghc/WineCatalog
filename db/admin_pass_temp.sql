-- =====================================================================
-- WineCatalog — Password temporária dada pelo admin
-- (winecatalog.admin_pass_temp)
--
-- Correr DEPOIS de schema.sql -> catalogo-winecatalog.sql -> functions.sql
-- -> policies.sql. É IDEMPOTENTE.
--
-- Mesma razão das outras apps do projeto: este projeto Supabase não tem
-- SMTP próprio, e sem ele o painel não deixa editar templates de email —
-- o "Esqueci-me da password" fica só com o template genérico (sem código
-- de 6 dígitos). Em vez de depender disso, o admin gera aqui uma
-- password, dita-a por telefone, e a pessoa troca-a assim que entra
-- (Definições › Conta).
--
-- SEGURANÇA — o que a função garante, do lado do SERVIDOR (nunca a UI):
--   · só o DONO DA CONTA SUPABASE a pode executar — e repara que não é o
--     admin da app. Isto mexe em `auth.users`, que é a CONTA, e a conta é
--     de quem a paga mesmo depois de o catálogo passar a outra pessoa por
--     `winecatalog.definir_admin()`. O admin novo vê "Utilizadores" e aprova
--     quem entra; mudar a password de alguém não é dele. Mesma distinção
--     que a Garrafeira faz com o `SUPABASE_DONO_EMAIL`;
--   · só para contas que já têm acesso à app (allowed_users);
--   · não mexe na conta do próprio dono (essa muda-se no Supabase);
--   · search_path fixo.
--
-- Tolerante: sem esta migração, o botão na app diz que falta correr este
-- ficheiro e mais nada muda.
-- =====================================================================

CREATE OR REPLACE FUNCTION winecatalog.admin_pass_temp(p_email text, p_password text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public', 'extensions'
AS $$
DECLARE
  v_dono  text := 'diogo.andre.f.silva@gmail.com';   -- o dono da CONTA, fixo
  v_email text := lower(trim(p_email));
  v_id    uuid;
BEGIN
  IF lower(COALESCE(auth.email(), '')) <> v_dono THEN
    RAISE EXCEPTION 'Só o dono da conta Supabase pode gerar passwords temporárias';
  END IF;
  IF v_email IS NULL OR v_email = '' OR p_password IS NULL OR length(p_password) < 8 THEN
    RAISE EXCEPTION 'Email em falta ou password demasiado curta (mínimo 8)';
  END IF;
  IF v_email = v_dono THEN
    RAISE EXCEPTION 'A password do dono muda-se no Supabase';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM winecatalog.allowed_users WHERE lower(email) = v_email) THEN
    RAISE EXCEPTION 'Essa conta não tem acesso à app';
  END IF;

  UPDATE auth.users
     SET encrypted_password = crypt(p_password, gen_salt('bf', 10)),
         email_confirmed_at = COALESCE(email_confirmed_at, now()),
         updated_at         = now()
   WHERE lower(email) = v_email
   RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Não existe nenhuma conta com esse email';
  END IF;
  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION winecatalog.admin_pass_temp(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.admin_pass_temp(text, text) TO authenticated;
