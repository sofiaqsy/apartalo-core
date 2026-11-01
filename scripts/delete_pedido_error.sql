-- ─────────────────────────────────────────────────────────────────────────────
-- Eliminar permanentemente ORD-20260901-7bc381ef (pedido creado por error)
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DELETE FROM public.order_items
WHERE  order_id = '5d69fcf3-ae65-42d0-b539-bd94a114ec0e';

DELETE FROM public.orders
WHERE  id = '5d69fcf3-ae65-42d0-b539-bd94a114ec0e';

COMMIT;

-- Verificación: debe devolver 0 filas
SELECT * FROM public.orders WHERE id = '5d69fcf3-ae65-42d0-b539-bd94a114ec0e';
