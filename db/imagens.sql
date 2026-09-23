-- ════════════════════════════════════════════════════════════════════
-- AS FOTOGRAFIAS DO CATÁLOGO — bucket `winecatalog-rotulos`
--
-- Corre DEPOIS do `catalogo.sql` (usa a `winecatalog.sou_admin()`).
-- Idempotente.
--
-- Até aqui a imagem de um vinho no catálogo só podia ser um LINK
-- (`imagem_url`) para uma fotografia noutro sítio — uma loja, o Vivino.
-- Quando nenhum servia, não havia imagem nenhuma. Isto deixa o admin
-- tirar/carregar uma fotografia do rótulo no "Editar" e no "Vinho novo";
-- a app encolhe-a no browser (1000px, JPEG), manda-a para aqui, e o
-- `imagem_url` passa a apontar para o endereço PÚBLICO dela.
--
-- PORQUE É PÚBLICO. As três apps mostram o `imagem_url` num <img src>
-- simples, e a Garrafeira e a WineSelection nem têm login nesta app: um
-- bucket privado obrigava cada uma a pedir links assinados a um schema
-- que não é seu. E não contradiz a invariante 1 — o que lá diz que
-- nunca entra é o `imagem_path` da Garrafeira, a fotografia tirada em
-- casa por QUALQUER pessoa e levada para o catálogo sem ela escolher.
-- Aqui é o ADMIN a escolher, uma a uma, a fotografia do RÓTULO que quer
-- mostrar — o mesmo que colar um link de uma loja. Quem a tira sabe que
-- é pública; o ecrã di-lo ao lado do botão.
--
-- QUEM ESCREVE: só o admin do catálogo, e é a policy que o diz (não o
-- botão escondido). Ler não precisa de policy: um bucket público serve
-- `/object/public/...` sem passar pela RLS.
-- ════════════════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('winecatalog-rotulos', 'winecatalog-rotulos', true, 2097152,
        ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "winecatalog rotulos: admin envia"  ON storage.objects;
DROP POLICY IF EXISTS "winecatalog rotulos: admin muda"   ON storage.objects;
DROP POLICY IF EXISTS "winecatalog rotulos: admin apaga"  ON storage.objects;

CREATE POLICY "winecatalog rotulos: admin envia" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'winecatalog-rotulos' AND winecatalog.sou_admin());

CREATE POLICY "winecatalog rotulos: admin muda" ON storage.objects
  FOR UPDATE TO authenticated
  USING      (bucket_id = 'winecatalog-rotulos' AND winecatalog.sou_admin())
  WITH CHECK (bucket_id = 'winecatalog-rotulos' AND winecatalog.sou_admin());

CREATE POLICY "winecatalog rotulos: admin apaga" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'winecatalog-rotulos' AND winecatalog.sou_admin());
