/**
 * APARTALO CORE - Handler Unificado v4.0 REFACTORIZADO
 * 
 * Orquestador principal - Delega a módulos especializados
 * 
 * CARACTERÍSTICAS v4.0:
 * - Arquitectura modular (< 200 líneas por archivo)
 * - 100% conversacional (sin menús de botones)
 * - Memoria simulada (RAG) integrada
 * - IA desde el primer mensaje
 * 
 * MÓDULOS:
 * - constants.js: Constantes compartidas
 * - utils.js: Utilidades de formato y parseo
 * - vouchers.js: Manejo de comprobantes de pago
 * - pedidos.js: Flujo de pedidos con IA + RAG
 * - muestras.js: Flujo de muestras con IA + RAG
 */

const { getGreeting } = require('../../core/utils/formatters');
const { KEYWORDS_MUESTRA, COMANDOS_GLOBALES } = require('./constants');
const vouchersModule = require('./vouchers');
const pedidosModule = require('./pedidos');
const muestrasModule = require('./muestras');

/**
 * Handler principal - Orquestador
 */
async function handle(from, message, context) {
  const { whatsapp, stateManager, negocio, hasFeature, asesorService } = context;
  const { text, type, interactiveData, mediaId } = message;

  const state = stateManager.getState(from, negocio.id);
  const mensajeLimpio = (text || '').trim();
  const mensajeNormalizado = mensajeLimpio.toLowerCase();

  // Configuración del negocio
  const cfg = {
    unidad: negocio.configExtra?.unidad || 'unidad',
    minimoCompra: negocio.configExtra?.minimoCompra || 1,
    flujoPago: negocio.configExtra?.flujoPago || 'voucher',
    mostrarFotos: negocio.configExtra?.mostrarFotos !== false,
    prefijoPedido: negocio.configExtra?.prefijoPedido || 'PED',
    usarIA: negocio.configExtra?.usarIA !== false
  };

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🤖 HANDLER UNIFICADO v4.0 - ' + negocio.nombre);
  console.log('   From: ' + from);
  console.log('   Mensaje: "' + mensajeLimpio + '"');
  console.log('   Tipo: ' + type);
  console.log('   Estado: ' + state.step);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ============================================
  // 1. DETECTAR IMAGEN - POSIBLE VOUCHER
  // ============================================
  if (type === 'image' && mediaId) {
    return await vouchersModule.manejarImagenRecibida(from, mediaId, mensajeLimpio, context, cfg);
  }

  // ============================================
  // 2. COMANDOS GLOBALES
  // ============================================
  if (COMANDOS_GLOBALES.MENU.includes(mensajeNormalizado)) {
    stateManager.resetState(from, negocio.id);
    return await mostrarSaludoSimple(from, context);
  }

  if (COMANDOS_GLOBALES.CANCELAR.includes(mensajeNormalizado)) {
    stateManager.resetState(from, negocio.id);
    await whatsapp.sendMessage(from, 'Operación cancelada.\n\n¿En qué más puedo ayudarte?');
    return;
  }

  // ============================================
  // 3. DETECTAR MUESTRAS GRATIS (si feature habilitado)
  // ============================================
  if (hasFeature('cafeGratis') || hasFeature('muestras')) {
    const tienePalabraMuestra = KEYWORDS_MUESTRA.some(k => 
      mensajeNormalizado.includes(k)
    );
    
    // Si está en flujo de muestra, continuar
    if (state.step === 'muestra_conversacional') {
      return await muestrasModule.continuarMuestraConversacional(from, mensajeLimpio, context, cfg);
    }
    
    // Si detectamos intención de muestra, iniciar flujo
    if (tienePalabraMuestra && (state.step === 'inicio' || state.step === 'menu' || state.step === 'pedido_conversacional')) {
      return await muestrasModule.iniciarMuestraConversacional(from, mensajeLimpio, context, cfg);
    }
  }

  // ============================================
  // 4. CONTACTAR FINCA
  // ============================================
  const palabrasContacto = [
    'contactar finca', 'contactar', 'asesor', 'ayuda',
    'hablar con alguien', 'hablar con la finca', 'persona',
    'humano', 'equipo', 'finca'
  ];
  if (palabrasContacto.some(p => mensajeNormalizado.includes(p))) {
    if (hasFeature('asesorHumano') && asesorService) {
      const resultado = await asesorService.activarModoAsesor(from, context);
      await whatsapp.sendMessage(from, resultado.mensaje);
      return;
    } else {
      await whatsapp.sendMessage(from,
        '📞 *Contacto con la Finca*\n\n' +
        'Voy a conectarte con el equipo de ' + negocio.nombre + '.\n\n' +
        'En breve alguien se comunicará contigo. 🌿'
      );
      return;
    }
  }

  // ============================================
  // 5. FLUJO PRINCIPAL - DELEGACIÓN POR ESTADO
  // ============================================
  switch (state.step) {
    case 'inicio':
    case 'menu':
      // NUEVO: Iniciar IA conversacional directamente (sin botones)
      return await pedidosModule.iniciarPedidoConversacionalDirecto(from, mensajeLimpio, context, cfg);

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
      // Por defecto, iniciar conversación con IA
      return await pedidosModule.iniciarPedidoConversacionalDirecto(from, mensajeLimpio, context, cfg);
  }
}

/**
 * Mostrar saludo simple identificando al bot y ofreciendo contacto con la finca
 */
async function mostrarSaludoSimple(from, context) {
  const { whatsapp, negocio } = context;
  
  const saludo = getGreeting();
  const mensaje =
    saludo + ' Soy el asistente virtual de *' + negocio.nombre + '* 🤖\n\n' +
    '¿En qué puedo ayudarte hoy?\n\n' +
    '_Si prefieres hablar directamente con la finca, escribe *CONTACTAR FINCA*._';
  
  await whatsapp.sendMessage(from, mensaje);
}

module.exports = { handle };
