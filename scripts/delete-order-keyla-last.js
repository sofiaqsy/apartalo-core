/**
 * Script: Eliminar último pedido de Keyla
 *
 * Pedido: ORD-20260529-f0255017
 * ID:     877d8ad6-7309-4ea4-bbe6-976ad53d16ba
 * Tipo:   PRE-VENTA (event 5eb4d292-50b8-438a-955f-0580a738431c)
 * Items:  2 unidades (2 kg) → restaurar kg_reserved
 *
 * Pasos:
 *   1. Mostrar resumen del pedido (dry-run preview)
 *   2. Restaurar kg_reserved en event_offers (-2 kg)
 *   3. Eliminar order_payments (si existen)
 *   4. Eliminar order_items
 *   5. Eliminar el pedido
 *
 * Uso:
 *   node scripts/delete-order-keyla-last.js          ← dry run (solo muestra)
 *   node scripts/delete-order-keyla-last.js --confirm ← ejecuta la eliminación
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const ORDER_ID    = '877d8ad6-7309-4ea4-bbe6-976ad53d16ba';
const ORDER_NUM   = 'ORD-20260529-f0255017';
const ITEM_ID     = 'd562046b-9eb9-47c0-b571-e4f0100f0355';
const EVENT_ID    = '5eb4d292-50b8-438a-955f-0580a738431c';
const FARM_ID     = 'c1d391b2-31d0-4eb4-a3e5-6986490e4dd3';
const QTY_KG      = 2; // cantidad a restaurar en kg_reserved

const DRY_RUN = !process.argv.includes('--confirm');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log(`  Eliminar pedido ${ORDER_NUM}`);
  console.log(`  Modo: ${DRY_RUN ? '🔍 DRY RUN (sin cambios)' : '⚠️  EJECUCIÓN REAL'}`);
  console.log('══════════════════════════════════════════════════\n');

  // ── 1. Verificar que el pedido existe ──────────────────────────────────────
  console.log('1. Verificando pedido...');
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('id, order_number, status, payment_status, total_cents, notes, customer_name')
    .eq('id', ORDER_ID)
    .single();

  if (orderErr || !order) {
    console.error('   ❌ Pedido no encontrado:', orderErr?.message || 'no data');
    process.exit(1);
  }
  console.log(`   ✅ Encontrado: ${order.order_number}`);
  console.log(`      Cliente:  ${order.customer_name}`);
  console.log(`      Estado:   ${order.status} / pago: ${order.payment_status}`);
  console.log(`      Total:    S/${(order.total_cents / 100).toFixed(2)}`);
  console.log(`      Notas:    ${order.notes}`);

  // ── 2. Ver items ──────────────────────────────────────────────────────────
  console.log('\n2. Items del pedido...');
  const { data: items, error: itemsErr } = await supabase
    .from('order_items')
    .select('id, product_name, quantity, source_event_id')
    .eq('order_id', ORDER_ID);

  if (itemsErr) {
    console.error('   ❌ Error leyendo items:', itemsErr.message);
    process.exit(1);
  }
  items.forEach(it => {
    console.log(`   • ${it.product_name} × ${it.quantity}  [${it.id}]`);
    if (it.source_event_id) console.log(`     source_event_id: ${it.source_event_id}`);
  });

  // ── 3. Ver pagos ──────────────────────────────────────────────────────────
  console.log('\n3. Pagos del pedido...');
  const { data: payments, error: paymentsErr } = await supabase
    .from('order_payments')
    .select('id, amount_cents, status, created_at')
    .eq('order_id', ORDER_ID);

  if (paymentsErr) {
    console.warn('   ⚠️  No se pudo leer order_payments:', paymentsErr.message);
  } else if (!payments?.length) {
    console.log('   (sin registros de pago)');
  } else {
    payments.forEach(p => console.log(`   • S/${(p.amount_cents/100).toFixed(2)} — ${p.status} [${p.id}]`));
  }

  // ── 4. Ver event_offers actual ────────────────────────────────────────────
  console.log('\n4. Estado actual de event_offers...');
  const { data: offers, error: offersErr } = await supabase
    .from('event_offers')
    .select('id, kg_offered, kg_reserved')
    .eq('event_id', EVENT_ID)
    .eq('farm_id', FARM_ID);

  if (offersErr) {
    console.warn('   ⚠️  No se pudo leer event_offers:', offersErr.message);
  } else if (!offers?.length) {
    console.log('   (sin event_offers para este evento/finca)');
  } else {
    offers.forEach(o => {
      const newReserved = Math.max(0, (o.kg_reserved || 0) - QTY_KG);
      console.log(`   • offer ${o.id}`);
      console.log(`     kg_offered:  ${o.kg_offered}`);
      console.log(`     kg_reserved: ${o.kg_reserved}  →  ${newReserved} (restamos ${QTY_KG} kg)`);
    });
  }

  // ── Resumen / confirmación ────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════');
  if (DRY_RUN) {
    console.log('  DRY RUN completado. Para ejecutar la eliminación:');
    console.log('  node scripts/delete-order-keyla-last.js --confirm');
    console.log('══════════════════════════════════════════════════\n');
    return;
  }

  console.log('  ⚠️  EJECUTANDO ELIMINACIÓN...');
  console.log('══════════════════════════════════════════════════\n');

  // ── PASO A: Restaurar kg_reserved ─────────────────────────────────────────
  if (offers?.length) {
    for (const offer of offers) {
      const newReserved = Math.max(0, (offer.kg_reserved || 0) - QTY_KG);
      const { error: upErr } = await supabase
        .from('event_offers')
        .update({ kg_reserved: newReserved, updated_at: new Date().toISOString() })
        .eq('id', offer.id);

      if (upErr) {
        console.error(`   ❌ Error restaurando kg_reserved [${offer.id}]:`, upErr.message);
        process.exit(1);
      }
      console.log(`   ✅ kg_reserved restaurado: ${offer.kg_reserved} → ${newReserved}`);
    }
  } else {
    console.log('   ℹ️  Sin event_offers que restaurar.');
  }

  // ── PASO B: Eliminar order_payments ───────────────────────────────────────
  if (payments?.length) {
    const { error: delPayErr } = await supabase
      .from('order_payments')
      .delete()
      .eq('order_id', ORDER_ID);

    if (delPayErr) {
      console.error('   ❌ Error eliminando pagos:', delPayErr.message);
      process.exit(1);
    }
    console.log(`   ✅ ${payments.length} pago(s) eliminado(s)`);
  }

  // ── PASO C: Eliminar order_items ──────────────────────────────────────────
  const { error: delItemsErr } = await supabase
    .from('order_items')
    .delete()
    .eq('order_id', ORDER_ID);

  if (delItemsErr) {
    console.error('   ❌ Error eliminando items:', delItemsErr.message);
    process.exit(1);
  }
  console.log(`   ✅ ${items.length} item(s) eliminado(s)`);

  // ── PASO D: Cancelar y eliminar el pedido ────────────────────────────────
  // Primero cancelar para dejar rastro limpio
  await supabase
    .from('orders')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', ORDER_ID);

  const { error: delOrderErr } = await supabase
    .from('orders')
    .delete()
    .eq('id', ORDER_ID);

  if (delOrderErr) {
    console.error('   ❌ Error eliminando pedido:', delOrderErr.message);
    process.exit(1);
  }
  console.log(`   ✅ Pedido ${ORDER_NUM} eliminado`);

  // ── Verificación final ────────────────────────────────────────────────────
  const { data: check } = await supabase
    .from('orders')
    .select('id')
    .eq('id', ORDER_ID)
    .single();

  if (!check) {
    console.log('\n══════════════════════════════════════════════════');
    console.log('  ✅ Eliminación completada exitosamente.');
    console.log('══════════════════════════════════════════════════\n');
  } else {
    console.error('\n   ⚠️  El pedido aún existe en la base de datos. Revisar manualmente.');
  }
}

main().catch(err => {
  console.error('\n❌ Error inesperado:', err.message);
  process.exit(1);
});
