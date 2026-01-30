/**
 * APARTALO CORE - Handler Unificado - Pedidos
 * 
 * v4.1: Send product image when customer asks for characteristics/details
 */

const { getGreeting, generateId } = require('../../core/utils/formatters');
const aiOrderService = require('../../core/services/ai-order-service');
const config = require('../../config');
const { mergeDatasSinNull, formatearProductosParaSheets } = require('./utils');

/**
 * Start conversational order flow DIRECTLY (no button menu)
 * Uses simulated memory (RAG) from first message
 */
async function iniciarPedidoConversacionalDirecto(from, mensaje, context, cfg) {
  const { whatsapp, stateManager, negocio } = context;
  
  console.log('🤖 Starting direct conversation with AI + RAG (no buttons)');
  
  stateManager.setState(from, negocio.id, {
    step: 'pedido_conversacional',
    data: {
      historial: [],
      datosCliente: null,
      datosExtraidos: {},
      ultimoProductoMostrado: null
    }
  });
  
  if (mensaje && mensaje.trim() !== '') {
    console.log('   → Processing message with AI: "' + mensaje + '"');
    return await continuarPedidoConversacional(from, mensaje, context, cfg);
  }
  
  const saludo = getGreeting();
  await whatsapp.sendMessage(from, 
    saludo + '\n\n' +
    'Bienvenido a ' + negocio.nombre + '. ¿En qué puedo ayudarte?'
  );
}

/**
 * Continue conversational order with AI + RAG
 */
async function continuarPedidoConversacional(from, mensaje, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);

  const historial = state.data?.historial || [];
  const datosCliente = state.data?.datosCliente || null;
  let datosAcumulados = state.data?.datosExtraidos || {};
  const ultimoProductoMostrado = state.data?.ultimoProductoMostrado || null;

  // Call AI with simulated memory (RAG)
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

  // Intelligent merge
  if (resultado.datosExtraidos) {
    datosAcumulados = mergeDatasSinNull(datosAcumulados, resultado.datosExtraidos);
  }

  console.log('📊 Accumulated data:', JSON.stringify(datosAcumulados));

  historial.push({ rol: 'cliente', texto: mensaje });
  historial.push({ rol: 'asistente', texto: resultado.respuesta });

  // Check if customer is asking about product details/characteristics
  const mensajeLower = mensaje.toLowerCase();
  const preguntaCaracteristicas = 
    mensajeLower.includes('caracteristica') ||
    mensajeLower.includes('característica') ||
    mensajeLower.includes('detalle') ||
    mensajeLower.includes('información') ||
    mensajeLower.includes('informacion') ||
    mensajeLower.includes('descrip') ||
    mensajeLower.includes('que tiene') ||
    mensajeLower.includes('qué tiene') ||
    mensajeLower.includes('como es') ||
    mensajeLower.includes('cómo es');

  // Determine which product to show
  const productoCodigoActual = datosAcumulados.producto_codigo;
  let productoParaMostrar = null;
  let debeEnviarImagen = false;

  if (productoCodigoActual && cfg.mostrarFotos) {
    try {
      const productos = await sheets.getProductosConPrecios(from);
      productoParaMostrar = productos.find(p => p.codigo === productoCodigoActual);
      
      // Send image if:
      // 1. New product identified (different from last shown)
      // 2. Customer asks for characteristics (even if same product)
      if (productoParaMostrar) {
        debeEnviarImagen = 
          (productoCodigoActual !== ultimoProductoMostrado) || 
          preguntaCaracteristicas;
      }
    } catch (e) {
      console.log('⚠️ Error finding product for image:', e.message);
    }
  }

  // Check if order complete
  if (resultado.pedidoCompleto && datosAcumulados.producto_codigo && datosAcumulados.cantidad) {
    stateManager.updateData(from, negocio.id, {
      historial,
      datosExtraidos: datosAcumulados,
      ultimoProductoMostrado: productoCodigoActual
    });
    
    return await confirmarPedidoIA(from, context, cfg, datosAcumulados);
  }

  // Update state
  stateManager.updateData(from, negocio.id, {
    historial,
    datosExtraidos: datosAcumulados,
    ultimoProductoMostrado: debeEnviarImagen ? productoCodigoActual : ultimoProductoMostrado
  });

  // Send image WITH text as caption (1 single message)
  if (debeEnviarImagen && productoParaMostrar && productoParaMostrar.imagenUrl) {
    try {
      await whatsapp.sendImage(from, productoParaMostrar.imagenUrl, resultado.respuesta);
      console.log('✅ Image sent with caption (characteristics request or new product)');
    } catch (e) {
      console.log('⚠️ Error sending image with caption:', e.message);
      await whatsapp.sendMessage(from, resultado.respuesta);
    }
  } else {
    // No image, send text only
    await whatsapp.sendMessage(from, resultado.respuesta);
  }
}

/**
 * Confirm order with AI
 */
async function confirmarPedidoIA(from, context, cfg, datos) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  console.log('✅ confirmarPedidoIA - received data:', JSON.stringify(datos));

  // Get products with personalized prices
  let productos = [];
  try {
    productos = await sheets.getProductosConPrecios(from);
  } catch (e) {
    productos = await sheets.getProductos('ACTIVO');
  }

  // Find product
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
    console.log('❌ Product not found. Code:', datos.producto_codigo, 'Name:', datos.producto_nombre);
    
    await whatsapp.sendMessage(from, 
      'No pude identificar el producto. ¿Podrías indicarme nuevamente cuál deseas?'
    );
    return;
  }

  const cantidad = parseFloat(datos.cantidad) || cfg.minimoCompra;
  const precioUnitario = producto.precio;
  const total = cantidad * precioUnitario;
  const unidadTexto = cfg.unidad === 'kg' ? 'kg' : (cantidad === 1 ? 'unidad' : 'unidades');

  // Save data
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
 * Handle order confirmation
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

  // If missing data, request it
  if (!nombreCliente || !direccion) {
    await whatsapp.sendMessage(from, 
      'Para completar el pedido, necesito tu nombre completo, dirección de entrega (incluye distrito) y teléfono de contacto.'
    );
    stateManager.setStep(from, negocio.id, 'pedido_conversacional');
    return;
  }

  const pedidoId = generateId(cfg.prefijoPedido);
  const unidadTexto = cfg.unidad === 'kg' ? 'kg' : (cantidad === 1 ? 'unidad' : 'unidades');

  // Unified states
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
    // Update or create customer
    await sheets.upsertCliente({
      whatsapp: from,
      nombre: nombreCliente,
      telefono: telefono || '',
      direccion: direccion
    });

    // Create order
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
    
    console.log('✅ Order created:', pedidoId);
  } catch (e) {
    console.error('❌ Error creating order:', e.message);
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
