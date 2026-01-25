/**
 * APARTALO CORE - Handler Unificado - Pedidos
 * 
 * Módulo para flujo de pedidos conversacionales con IA + Memoria Simulada (RAG)
 */

const { getGreeting, generateId } = require('../../core/utils/formatters');
const aiOrderService = require('../../core/services/ai-order-service');
const config = require('../../config');
const { mergeDatasSinNull, formatearProductosParaSheets } = require('./utils');

/**
 * Iniciar pedido conversacional DIRECTO (sin menú de botones)
 * Usa memoria simulada (RAG) desde el primer mensaje
 */
async function iniciarPedidoConversacionalDirecto(from, mensaje, context, cfg) {
  const { whatsapp, stateManager, negocio } = context;
  
  console.log('🤖 Iniciando conversación directa con IA + RAG (sin botones)');
  
  // Iniciar estado conversacional
  stateManager.setState(from, negocio.id, {
    step: 'pedido_conversacional',
    data: {
      historial: [],
      datosCliente: null,
      datosExtraidos: {},
      ultimoProductoMostrado: null
    }
  });
  
  // Si el cliente ya escribió algo, procesarlo con IA
  if (mensaje && mensaje.trim() !== '') {
    console.log('   → Procesando mensaje con IA: "' + mensaje + '"');
    return await continuarPedidoConversacional(from, mensaje, context, cfg);
  }
  
  // Si no hay mensaje, enviar saludo genérico
  const saludo = getGreeting();
  await whatsapp.sendMessage(from, 
    saludo + '\n\n' +
    'Bienvenido a ' + negocio.nombre + '. ¿En qué puedo ayudarte?'
  );
}

/**
 * Continuar pedido conversacional con IA + RAG
 */
async function continuarPedidoConversacional(from, mensaje, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);

  const historial = state.data?.historial || [];
  const datosCliente = state.data?.datosCliente || null;
  let datosAcumulados = state.data?.datosExtraidos || {};
  const ultimoProductoMostrado = state.data?.ultimoProductoMostrado || null;

  // Llamar a IA con memoria simulada (RAG)
  const resultado = await aiOrderService.procesarMensajePedido(
    mensaje,
    context,
    historial,
    datosCliente,
    from
  );

  if (resultado.error) {
    await whatsapp.sendMessage(from, resultado.respuesta);
    return;
  }

  // Merge inteligente
  if (resultado.datosExtraidos) {
    datosAcumulados = mergeDatasSinNull(datosAcumulados, resultado.datosExtraidos);
  }

  console.log('📊 Datos acumulados:', JSON.stringify(datosAcumulados));

  historial.push({ rol: 'cliente', texto: mensaje });
  historial.push({ rol: 'asistente', texto: resultado.respuesta });

  // Verificar si se identificó un producto nuevo
  const productoCodigoActual = datosAcumulados.producto_codigo;
  let productoParaMostrar = null;

  if (productoCodigoActual && productoCodigoActual !== ultimoProductoMostrado && cfg.mostrarFotos) {
    try {
      const productos = await sheets.getProductosConPrecios(from);
      productoParaMostrar = productos.find(p => p.codigo === productoCodigoActual);
    } catch (e) {
      console.log('⚠️ Error buscando producto para imagen:', e.message);
    }
  }

  // Verificar si pedido completo
  if (resultado.pedidoCompleto && datosAcumulados.producto_codigo && datosAcumulados.cantidad) {
    stateManager.updateData(from, negocio.id, {
      historial,
      datosExtraidos: datosAcumulados,
      ultimoProductoMostrado: productoCodigoActual
    });
    
    return await confirmarPedidoIA(from, context, cfg, datosAcumulados);
  }

  // Actualizar estado
  stateManager.updateData(from, negocio.id, {
    historial,
    datosExtraidos: datosAcumulados,
    ultimoProductoMostrado: productoCodigoActual
  });

  // Enviar imagen del producto si hay una nueva identificación
  if (productoParaMostrar && productoParaMostrar.imagenUrl) {
    try {
      await whatsapp.sendImage(from, productoParaMostrar.imagenUrl, productoParaMostrar.nombre);
    } catch (e) {
      console.log('⚠️ Error enviando imagen:', e.message);
    }
  }

  // Enviar respuesta de texto
  await whatsapp.sendMessage(from, resultado.respuesta);
}

/**
 * Confirmar pedido con IA
 */
async function confirmarPedidoIA(from, context, cfg, datos) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  console.log('✅ confirmarPedidoIA - datos recibidos:', JSON.stringify(datos));

  // Obtener productos con precios personalizados
  let productos = [];
  try {
    productos = await sheets.getProductosConPrecios(from);
  } catch (e) {
    productos = await sheets.getProductos('ACTIVO');
  }

  // Buscar producto
  let producto = null;
  
  if (datos.producto_codigo) {
    producto = productos.find(p => p.codigo === datos.producto_codigo);
  }
  
  if (!producto && datos.producto_nombre) {
    producto = productos.find(p => 
      p.nombre.toLowerCase().includes(datos.producto_nombre.toLowerCase())
    );
  }

  if (!producto) {
    console.log('❌ Producto no encontrado. Codigo:', datos.producto_codigo, 'Nombre:', datos.producto_nombre);
    
    await whatsapp.sendMessage(from, 
      'No pude identificar el producto. ¿Podrías indicarme nuevamente cuál deseas?'
    );
    return;
  }

  const cantidad = parseFloat(datos.cantidad) || cfg.minimoCompra;
  const precioUnitario = producto.precio;
  const total = cantidad * precioUnitario;
  const unidadTexto = cfg.unidad === 'kg' ? 'kg' : (cantidad === 1 ? 'unidad' : 'unidades');

  // Guardar datos
  stateManager.updateData(from, negocio.id, {
    productoSeleccionado: producto,
    cantidad,
    total,
    precioFinal: precioUnitario,
    nombreCliente: datos.nombre_cliente,
    direccion: datos.direccion,
    telefono: datos.telefono
  });

  let mensaje = 'RESUMEN DE TU PEDIDO\n\n' +
    'Producto: ' + producto.nombre + '\n' +
    'Cantidad: ' + cantidad + ' ' + unidadTexto + '\n' +
    'Precio unitario: S/' + precioUnitario + '\n' +
    'Total: S/' + total.toFixed(2) + '\n';

  if (producto.tieneDescuento) {
    mensaje += '(Precio especial aplicado)\n';
  }

  mensaje += '\nEntrega:\n' +
    (datos.nombre_cliente ? 'Nombre: ' + datos.nombre_cliente + '\n' : '') +
    (datos.direccion ? 'Dirección: ' + datos.direccion + '\n' : '') +
    (datos.telefono ? 'Teléfono: ' + datos.telefono + '\n' : '') +
    '\n¿Confirmas el pedido?';

  await whatsapp.sendButtonMessage(from, mensaje, [
    { id: 'confirmar_si', title: 'Sí, confirmar' },
    { id: 'confirmar_no', title: 'Cancelar' }
  ]);

  stateManager.setStep(from, negocio.id, 'confirmar_pedido');
}

/**
 * Manejar confirmación del pedido
 */
async function manejarConfirmacion(from, text, interactiveData, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const opcion = (interactiveData?.id || text || '').toLowerCase();

  if (opcion.includes('no') || opcion === 'confirmar_no') {
    stateManager.resetState(from, negocio.id);
    await whatsapp.sendMessage(from, 'Pedido cancelado.\n\n¿Necesitas algo más?');
    return;
  }

  if (!opcion.includes('si') && opcion !== 'confirmar_si') {
    await whatsapp.sendMessage(from, 'Por favor usa los botones para confirmar o cancelar.');
    return;
  }

  const { productoSeleccionado, cantidad, total, precioFinal, nombreCliente, direccion, telefono } = state.data || {};

  if (!productoSeleccionado) {
    await whatsapp.sendMessage(from, 'Ocurrió un error. Por favor intenta de nuevo.');
    stateManager.resetState(from, negocio.id);
    return;
  }

  // Si faltan datos, pedirlos
  if (!nombreCliente || !direccion) {
    await whatsapp.sendMessage(from, 
      'Para completar el pedido, necesito tu nombre completo, dirección de entrega (incluye distrito) y teléfono de contacto.'
    );
    stateManager.setStep(from, negocio.id, 'pedido_conversacional');
    return;
  }

  const pedidoId = generateId(cfg.prefijoPedido);
  const unidadTexto = cfg.unidad === 'kg' ? 'kg' : (cantidad === 1 ? 'unidad' : 'unidades');

  // Estados unificados
  const estadoInicial = cfg.flujoPago === 'contacto' 
    ? config.orderStates?.IN_PREPARATION || 'EN_PREPARACION'
    : config.orderStates?.PENDING_PAYMENT || 'PENDIENTE_PAGO';

  const productosTexto = formatearProductosParaSheets([{
    codigo: productoSeleccionado.codigo,
    nombre: productoSeleccionado.nombre,
    cantidad,
    precio: precioFinal
  }]);

  try {
    // Actualizar o crear cliente
    await sheets.upsertCliente({
      whatsapp: from,
      nombre: nombreCliente,
      telefono: telefono || '',
      direccion: direccion
    });

    // Crear pedido
    await sheets.crearPedido({
      id: pedidoId,
      whatsapp: from,
      cliente: nombreCliente,
      telefono: telefono || '',
      direccion: direccion,
      productos: productosTexto,
      total,
      estado: estadoInicial,
      observaciones: 'WhatsApp Bot IA + RAG'
    });
    
    console.log('✅ Pedido creado:', pedidoId);
  } catch (e) {
    console.error('❌ Error creando pedido:', e.message);
  }

  if (cfg.flujoPago === 'contacto') {
    const mensaje = '✅ PEDIDO CONFIRMADO\n\n' +
      'Código: ' + pedidoId + '\n' +
      'Producto: ' + productoSeleccionado.nombre + '\n' +
      'Cantidad: ' + cantidad + ' ' + unidadTexto + '\n' +
      'Total: S/' + total.toFixed(2) + '\n\n' +
      'Entrega en: ' + direccion + '\n\n' +
      'Te contactaremos pronto para coordinar el pago y la entrega.\n\n' +
      'Gracias por tu compra.';

    await whatsapp.sendMessage(from, mensaje);
    stateManager.resetState(from, negocio.id);
  } else {
    const metodosPago = await sheets.getMetodosPago();
    
    let mensajePago = '✅ PEDIDO REGISTRADO\n\n';
    mensajePago += 'Código: ' + pedidoId + '\n';
    mensajePago += productoSeleccionado.nombre + ' x' + cantidad + ' ' + unidadTexto + '\n';
    mensajePago += 'Total: S/' + total.toFixed(2) + '\n\n';
    mensajePago += 'MÉTODOS DE PAGO:\n\n';

    if (metodosPago.length > 0) {
      metodosPago.forEach(m => {
        if (m.tipo === 'yape' || m.tipo === 'plin') {
          mensajePago += m.tipo.toUpperCase() + ': ' + m.numero + '\n';
        } else {
          mensajePago += m.tipo.toUpperCase() + '\n';
          mensajePago += 'Cuenta: ' + m.cuenta + '\n';
          if (m.cci) mensajePago += 'CCI: ' + m.cci + '\n';
        }
        if (m.titular) mensajePago += 'Titular: ' + m.titular + '\n';
        mensajePago += '\n';
      });
    } else {
      mensajePago += 'Yape/Plin: (consultar)\n\n';
    }

    mensajePago += 'Envía foto del comprobante para confirmar.';

    await whatsapp.sendMessage(from, mensajePago);
    stateManager.updateData(from, negocio.id, { pedidoId });
    stateManager.setStep(from, negocio.id, 'esperando_voucher');
    return;
  }
}

module.exports = {
  iniciarPedidoConversacionalDirecto,
  continuarPedidoConversacional,
  confirmarPedidoIA,
  manejarConfirmacion
};
