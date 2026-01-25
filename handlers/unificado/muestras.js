/**
 * APARTALO CORE - Handler Unificado - Muestras
 * 
 * Módulo para flujo de muestras gratis con IA + Memoria Simulada (RAG)
 */

const { generateId } = require('../../core/utils/formatters');
const aiMuestraService = require('../../core/services/ai-muestra-service');
const config = require('../../config');
const { mergeDatasSinNull } = require('./utils');

/**
 * Iniciar flujo conversacional de muestra gratis con IA + RAG
 */
async function iniciarMuestraConversacional(from, mensajeInicial, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  console.log('🎁 Iniciando flujo de muestra conversacional con IA + RAG');

  // Validar: ¿Ya tiene una muestra registrada?
  let muestraPrev = null;
  try {
    const pedidos = await sheets.getPedidosByWhatsapp(from);
    muestraPrev = pedidos.find(p => 
      p.id.startsWith('MUE-') && 
      !['CANCELADO'].includes(p.estado)
    );
  } catch (e) {
    console.log('⚠️ Error verificando muestras previas:', e.message);
  }

  // Si ya tiene una muestra, rechazar
  if (muestraPrev) {
    const estadoTexto = muestraPrev.estado === 'ENTREGADO' 
      ? 'ya recibiste una muestra' 
      : 'ya tienes una muestra en proceso de envío';
    
    await whatsapp.sendMessage(from, 
      `Veo que ${estadoTexto} (código ${muestraPrev.id}).\n\n` +
      `Nuestro programa permite solo 1 muestra por negocio para que más personas puedan conocer nuestro café.\n\n` +
      `Si quedaste satisfecho con la calidad, ¡nos encantaría que hagas tu primer pedido!\n\n` +
      `Escribe lo que necesites.`
    );
    stateManager.resetState(from, negocio.id);
    return;
  }

  // Buscar datos del cliente
  let cliente = null;
  try {
    cliente = await sheets.buscarCliente(from);
  } catch (e) {}

  // Inicializar estado conversacional
  stateManager.setState(from, negocio.id, {
    step: 'muestra_conversacional',
    data: {
      historial: [],
      datosCliente: cliente,
      datosExtraidos: {},
      iniciado: new Date().toISOString()
    }
  });

  // Procesar mensaje inicial con IA
  return await continuarMuestraConversacional(from, mensajeInicial, context, cfg);
}

/**
 * Continuar conversación de muestra con IA + RAG
 */
async function continuarMuestraConversacional(from, mensaje, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);

  const historial = state.data?.historial || [];
  const datosCliente = state.data?.datosCliente || null;
  let datosAcumulados = state.data?.datosExtraidos || {};

  // Llamar a IA especializada en muestras con memoria
  const resultado = await aiMuestraService.procesarMensajeMuestra(
    mensaje,
    context,
    historial,
    datosCliente
  );

  if (resultado.error) {
    await whatsapp.sendMessage(from, resultado.respuesta);
    return;
  }

  // Merge inteligente de datos
  if (resultado.datosExtraidos) {
    datosAcumulados = mergeDatasSinNull(datosAcumulados, resultado.datosExtraidos);
  }

  console.log('📊 Datos muestra acumulados:', JSON.stringify(datosAcumulados));

  // Actualizar historial
  historial.push({ rol: 'cliente', texto: mensaje });
  historial.push({ rol: 'asistente', texto: resultado.respuesta });

  // Si la muestra está completa, crear pedido
  if (resultado.muestraCompleta && 
      datosAcumulados.empresa && 
      datosAcumulados.nombre_contacto &&
      datosAcumulados.direccion &&
      datosAcumulados.telefono) {
    
    return await confirmarMuestraGratis(from, context, cfg, datosAcumulados);
  }

  // Actualizar estado
  stateManager.updateData(from, negocio.id, {
    historial,
    datosExtraidos: datosAcumulados
  });

  // Enviar respuesta
  await whatsapp.sendMessage(from, resultado.respuesta);
}

/**
 * Confirmar y crear pedido de muestra gratis
 */
async function confirmarMuestraGratis(from, context, cfg, datos) {
  const { whatsapp, sheets, stateManager, negocio, firebaseService } = context;

  const pedidoId = generateId('MUE');
  const estadoMuestra = config.orderStates?.PENDING_SHIPMENT || 'PENDIENTE_ENVIO';

  console.log(`✅ Creando muestra ${pedidoId} para ${datos.empresa}`);

  try {
    // Crear o actualizar cliente
    await sheets.upsertCliente({
      whatsapp: from,
      nombre: datos.nombre_contacto,
      telefono: datos.telefono,
      direccion: datos.direccion,
      empresa: datos.empresa
    });

    // Crear pedido de muestra
    await sheets.crearPedido({
      id: pedidoId,
      whatsapp: from,
      cliente: datos.empresa,
      telefono: datos.telefono,
      direccion: datos.direccion,
      productos: '1x Muestra Cafe Premium 500g - S/0.00',
      total: 0,
      estado: estadoMuestra,
      observaciones: `MUESTRA GRATIS 500g - Contacto: ${datos.nombre_contacto} - WhatsApp Bot IA + RAG`
    });

    console.log(`✅ Muestra creada: ${pedidoId} para ${datos.empresa}`);

    // Notificar al negocio
    if (firebaseService) {
      try {
        await firebaseService.enviarNotificacion(negocio.id, {
          title: '🎁 Nueva Solicitud de Muestra',
          body: `${datos.empresa} - ${datos.nombre_contacto}`,
          data: {
            type: 'muestra_gratis',
            pedidoId: pedidoId,
            empresa: datos.empresa
          }
        });
      } catch (e) {
        console.log('⚠️ Error enviando notificación:', e.message);
      }
    }

  } catch (e) {
    console.error('❌ Error creando muestra:', e.message);
  }

  // Mensaje de confirmación
  const mensajeConfirmacion = 
    '✅ MUESTRA CONFIRMADA\n\n' +
    `Código: ${pedidoId}\n` +
    `Negocio: ${datos.empresa}\n` +
    `Contacto: ${datos.nombre_contacto}\n` +
    `Dirección: ${datos.direccion}\n` +
    `Teléfono: ${datos.telefono}\n\n` +
    `Te enviaremos 500g de nuestro café premium de Villa Rica.\n\n` +
    `Te contactaremos pronto para coordinar la entrega.\n\n` +
    `¡Gracias por tu interés en ${negocio.nombre}!`;

  await whatsapp.sendMessage(from, mensajeConfirmacion);
  
  stateManager.resetState(from, negocio.id);
}

module.exports = {
  iniciarMuestraConversacional,
  continuarMuestraConversacional,
  confirmarMuestraGratis
};
