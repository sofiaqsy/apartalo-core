/**
 * APARTALO CORE - Handler Unificado v4.1
 *
 * Fix: al volver al bot después de una sesión, notificar pedidos activos/pendientes.
 */

const { getGreeting } = require('../../core/utils/formatters');
const { KEYWORDS_MUESTRA, COMANDOS_GLOBALES, ESTADOS_FINALIZADOS } = require('./constants');
const { parsearDetallePedido } = require('./utils');
const vouchersModule = require('./vouchers');
const pedidosModule = require('./pedidos');
const muestrasModule = require('./muestras');

async function handle(from, message, context) {
  const { whatsapp, sheets, stateManager, negocio, hasFeature, asesorService } = context;
  const { text, type, interactiveData, mediaId } = message;

  const state = stateManager.getState(from, negocio.id);
  const mensajeLimpio = (text || '').trim();
  const mensajeNormalizado = mensajeLimpio.toLowerCase();

  const cfg = {
    unidad: negocio.configExtra?.unidad || 'unidad',
    minimoCompra: negocio.configExtra?.minimoCompra || 1,
    flujoPago: negocio.configExtra?.flujoPago || 'voucher',
    mostrarFotos: negocio.configExtra?.mostrarFotos !== false,
    prefijoPedido: negocio.configExtra?.prefijoPedido || 'PED',
    usarIA: negocio.configExtra?.usarIA !== false
  };

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🤖 HANDLER UNIFICADO v4.1 - ' + negocio.nombre);
  console.log('   From: ' + from);
  console.log('   Mensaje: "' + mensajeLimpio + '"');
  console.log('   Tipo: ' + type);
  console.log('   Estado: ' + state.step);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ============================================
  // 1. IMAGEN — posible voucher
  // ============================================
  if (type === 'image' && mediaId) {
    return await vouchersModule.manejarImagenRecibida(from, mediaId, mensajeLimpio, context, cfg);
  }

  // ============================================
  // 2. COMANDOS GLOBALES
  // ============================================
  if (COMANDOS_GLOBALES.MENU.includes(mensajeNormalizado)) {
    stateManager.resetState(from, negocio.id);
    return await mostrarSaludoConPendientes(from, context, sheets);
  }

  if (COMANDOS_GLOBALES.CANCELAR.includes(mensajeNormalizado)) {
    stateManager.resetState(from, negocio.id);
    await whatsapp.sendMessage(from, 'Operación cancelada.\n\n¿En qué más puedo ayudarte?');
    return;
  }

  // ============================================
  // 3. MUESTRAS
  // ============================================
  if (hasFeature('cafeGratis') || hasFeature('muestras')) {
    const tienePalabraMuestra = KEYWORDS_MUESTRA.some(k => mensajeNormalizado.includes(k));

    if (state.step === 'muestra_conversacional') {
      return await muestrasModule.continuarMuestraConversacional(from, mensajeLimpio, context, cfg);
    }

    if (tienePalabraMuestra && ['inicio', 'menu', 'pedido_conversacional'].includes(state.step)) {
      return await muestrasModule.iniciarMuestraConversacional(from, mensajeLimpio, context, cfg);
    }
  }

  // ============================================
  // 4. CONTACTAR FINCA
  // ============================================
  const palabrasContacto = ['contactar finca', 'contactar', 'asesor', 'ayuda', 'hablar con alguien', 'hablar con la finca', 'persona', 'humano', 'equipo', 'finca'];
  if (palabrasContacto.some(p => mensajeNormalizado.includes(p))) {
    if (hasFeature('asesorHumano') && asesorService) {
      const resultado = await asesorService.activarModoAsesor(from, context);
      await whatsapp.sendMessage(from, resultado.mensaje);
    } else {
      await whatsapp.sendMessage(from,
        '*Contacto con la Finca*\n\nVoy a conectarte con el equipo de ' + negocio.nombre + '.\n\nEn breve alguien se comunicará contigo.'
      );
    }
    return;
  }

  // ============================================
  // 5. FLUJO POR ESTADO
  // ============================================
  switch (state.step) {
    case 'inicio':
    case 'menu':
      return await iniciarConPendientes(from, mensajeLimpio, context, cfg, sheets);

    case 'pedido_conversacional':
      return await pedidosModule.continuarPedidoConversacional(from, mensajeLimpio, context, cfg);

    case 'confirmar_pedido':
      return await pedidosModule.manejarConfirmacion(from, text, interactiveData, context, cfg);

    case 'esperando_voucher':
      return await vouchersModule.manejarVoucher(from, message, context, cfg);

    case 'seleccionar_pedido_voucher':
      return await vouchersModule.manejarSeleccionPedidoVoucher(from, text, context, cfg);

    case 'muestra_conversacional':
      return await muestrasModule.continuarMuestraConversacional(from, mensajeLimpio, context, cfg);

    default:
      return await iniciarConPendientes(from, mensajeLimpio, context, cfg, sheets);
  }
}

/**
 * Al iniciar sesión (estado 'inicio'), mostrar pedidos en curso si los hay.
 * Filtro: todo lo que NO esté en ESTADOS_FINALIZADOS.
 */
async function iniciarConPendientes(from, mensajeLimpio, context, cfg, sheets) {
  const { whatsapp, stateManager, negocio } = context;

  let pedidosPendientes = [];
  try {
    const pedidos = await sheets.getPedidosByWhatsapp(from);
    // Mostrar TODOS los que no están finalizados — sin filtro de estado específico
    pedidosPendientes = pedidos.filter(p =>
      !ESTADOS_FINALIZADOS.includes((p.estado || '').toUpperCase().trim())
    );
    console.log(`[Pendientes] Total pedidos: ${pedidos.length}, en curso: ${pedidosPendientes.length}`);
    if (pedidos.length > 0) {
      console.log(`[Pendientes] Estados encontrados: ${pedidos.map(p => p.estado).join(', ')}`);
    }
  } catch (e) {
    console.log('Error verificando pedidos pendientes:', e.message);
  }

  if (pedidosPendientes.length > 0) {
    let aviso = pedidosPendientes.length === 1
      ? 'Tienes un pedido en curso:\n\n'
      : `Tienes ${pedidosPendientes.length} pedidos en curso:\n\n`;

    pedidosPendientes.forEach((p, idx) => {
      const d = parsearDetallePedido(p);
      aviso += `${idx + 1}. ${d.producto}\n`;
      aviso += `   Total: S/${d.total.toFixed(2)} | Estado: ${formatearEstado(p.estado)}\n`;
      aviso += `   Código: ${p.id}\n\n`;
    });

    aviso += 'Si quieres enviar tu comprobante de pago, envía la foto directamente.\nSi tienes otra consulta, escríbela a continuación.';
    await whatsapp.sendMessage(from, aviso);
  }

  return await pedidosModule.iniciarPedidoConversacionalDirecto(from, mensajeLimpio, context, cfg);
}

function formatearEstado(estado) {
  const mapa = {
    'PENDIENTE': 'Pendiente de pago',
    'PENDIENTE_PAGO': 'Pendiente de pago',
    'PENDIENTE_ENVIO': 'Listo para envío',
    'EN_PREPARACION': 'En preparación',
    'EN_CAMINO': 'En camino',
  };
  return mapa[(estado || '').toUpperCase().trim()] || estado || 'En proceso';
}

async function mostrarSaludoConPendientes(from, context, sheets) {
  const { whatsapp, negocio } = context;
  const saludo = getGreeting();
  const mensaje =
    saludo + ' Soy el asistente virtual de *' + negocio.nombre + '*\n\n' +
    '¿En qué puedo ayudarte hoy?\n\n' +
    '_Si prefieres hablar directamente con la finca, escribe *CONTACTAR FINCA*._';
  await whatsapp.sendMessage(from, mensaje);
}

module.exports = { handle };
