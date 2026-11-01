-- ─────────────────────────────────────────────────────────────────────────────
-- ¿De dónde salen las unidades (kg / g / und)? Agregar "ml"
-- Ejecutar consulta por consulta en el SQL Editor de Supabase.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) ¿Qué tipo tiene la columna unit? (text = libre; USER-DEFINED = enum)
SELECT table_name, column_name, data_type, udt_name
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  column_name IN ('unit', 'unidad')
ORDER BY table_name;

-- 2) Si es un ENUM: sus valores permitidos
SELECT t.typname AS enum, e.enumlabel AS valor
FROM   pg_type t
JOIN   pg_enum e ON e.enumtypid = t.oid
WHERE  t.typname ILIKE '%unit%' OR t.typname ILIKE '%unidad%'
ORDER BY t.typname, e.enumsortorder;

-- 3) Si es un CHECK constraint: la regla exacta
SELECT conrelid::regclass AS tabla, conname, pg_get_constraintdef(oid) AS regla
FROM   pg_constraint
WHERE  contype = 'c'
  AND (pg_get_constraintdef(oid) ILIKE '%unit%' OR pg_get_constraintdef(oid) ILIKE '%''kg''%');

-- 4) Si es una tabla de catálogo (FK): ¿existe alguna tabla de unidades?
SELECT table_name
FROM   information_schema.tables
WHERE  table_schema = 'public'
  AND (table_name ILIKE '%unit%' OR table_name ILIKE '%unidad%' OR table_name ILIKE '%measure%');

-- 5) Qué valores se usan de verdad hoy
SELECT unit, count(*) FROM public.product_presentations GROUP BY unit ORDER BY 2 DESC;
