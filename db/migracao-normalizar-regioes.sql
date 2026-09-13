-- ---------------------------------------------------------------------
-- Migração — normalizar as REGIÕES já gravadas no catálogo
--
-- A `winecatalog.normalizar_regiao()` (em `catalogo.sql`) já está chamada
-- de dentro de `juntar` e de `editar`/`criar` (em `curadoria.sql`) — uma
-- região nova nunca mais entra como "DOURO" ou "Península de Setúbal".
-- Mas nenhuma dessas chamadas toca no que já estava escrito antes de
-- existirem. Este ficheiro é o ÚNICO SÍTIO que corrige isso, e corre uma
-- vez só.
--
-- Antes desta migração (2026-09-13): 66 "Douro" + 2 "DOURO", e 8
-- "Setúbal" + 6 "Península de Setúbal" — a mesma região a responder por
-- facetas diferentes no Catálogo.
--
-- Correr DEPOIS de `catalogo.sql` (precisa de `winecatalog.normalizar_regiao`
-- já existir). Idempotente: a segunda vez não encontra nada para mudar.
-- Não mexe em `origens` nem em `atualizado_em` — é uma correção de
-- formatação do valor que já lá estava, não uma escrita nova, e não deve
-- competir por força com nada.
-- ---------------------------------------------------------------------
UPDATE winecatalog.vinhos
   SET ficha = jsonb_set(ficha, '{regiao}', to_jsonb(winecatalog.normalizar_regiao(ficha->>'regiao')))
 WHERE ficha ? 'regiao'
   AND ficha->>'regiao' IS DISTINCT FROM winecatalog.normalizar_regiao(ficha->>'regiao')
   AND winecatalog.normalizar_regiao(ficha->>'regiao') IS NOT NULL;
