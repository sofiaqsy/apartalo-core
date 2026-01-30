/**
 * APARTALO CORE - Handler Unificado - Pedidos
 * 
 * v4.2: MULTI-PRODUCT ORDER SUPPORT - Handle both array and legacy formats
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

  // Determine which product to show image for
  const productoCodigoActual = datosAcumulados.producto_codigo || 
    (datosAcumulados.productos && datosAcumulados.productos[0]?.codigo);
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

  // Check if order complete - handle both formats
  const tieneProductos = (datosAcumulados.productos && datosAcumulados.productos.length > 0) ||
                         (datosAcumulados.producto_codigo && datosAcumulados.cantidad);
  
  if (resultado.pedidoCompleto && tieneProductos) {
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
 * Confirm order with AI - SUPPORTS MULTI-PRODUCT
 */
async function confirmarPedidoIA(from, context, cfg, datos) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  console.log('✅ confirmarPedidoIA - received data:', JSON.stringify(datos));

  // Get products with personalized prices
  let productosDisponibles = [];
  try {
    productosDisponibles = await sheets.getProductosConPrecios(from);
  } catch (e) {
    productosDisponibles = await sheets.getProductos('ACTIVO');
  }

  let productosParaPedido = [];
  let total = 0;

  // NEW: Multi-product support
  if (datos.productos && Array.isArray(datos.productos) && datos.productos.length > 0) {
    console.log('🛒 Processing MULTI-PRODUCT order:', datos.productos.length, 'items');
    
    for (const item of datos.productos) {
      const producto = productosDisponibles.find(p => p.codigo === item.codigo);
      
      if (producto) {
        const cantidad = parseFloat(item.cantidad) || 1;
        const precioUnitario = producto.precio;
        const subtotal = cantidad * precioUnitario;
        
        productosParaPedido.push({
          codigo: producto.codigo,
          nombre: producto.nombre,
          cantidad: cantidad,
          precio: precioUnitario
        });
        
        total += subtotal;
      } else {
        console.log('⚠️ Product not found:', item.codigo);
      }
    }
  } 
  // LEGACY: Single product support
  else if (datos.producto_codigo) {
    console.log('📦 Processing SINGLE product order:', datos.producto_codigo);
    
    const producto = productosDisponibles.find(p => p.codigo === datos.producto_codigo);
    
    if (!producto && datos.producto_nombre) {
      producto = productosDisponibles.find(p => 
        p.nombre.toLowerCase().includes(datos.producto_nombre.toLowerCase())
      );
    }
    
    if (producto) {
      const cantidad = parseFloat(datos.cantidad) || cfg.minimoCompra || 1;
      const precioUnitario = producto.precio;
      
      productosParaPedido.push({
        codigo: producto.codigo,
        nombre: producto.nombre,
        cantidad: cantidad,
        precio: precioUnitario
      });
      
      total = cantidad * precioUnitario;
    }
  }

  // Validate we have products
  if (productosParaPedido.length === 0) {
    console.log('❌ No valid products found');
    await whatsapp.sendMessage(from, 
      'No pude identificar los productos. ¿Podrías indicarme nuevamente qué deseas?'
    );
    return;
  }

  // Use calculated total or from AI if available
  if (datos.total_calculado && datos.total_calculado > 0) {
    total = datos.total_calculado;
  }

  // Save data
  stateManager.updateData(from, negocio.id, {
    productosParaPedido,
    total,
    nombreCliente: datos.nombre_cliente,
    direccion: datos.direccion,
    telefono: datos.telefono
  });

  // Build summary message
  let mensaje = 'RESUMEN DE TU PEDIDO\n\n';
  
  productosParaPedido.forEach(p => {
    const subtotal = p.cantidad * p.precio;
    const unidadTexto = cfg.unidad === 'kg' ? 'kg' : (p.cantidad === 1 ? 'unidad' : 'unidades');
    mensaje += `${p.nombre}\n`;
    mensaje += `  ${p.cantidad} ${unidadTexto} x S/${p.precio} = S/${subtotal.toFixed(2)}\n\n`;
  });

  mensaje += `Total: S/${total.toFixed(2)}\n\n`;
  
  mensaje += 'Entrega:\n';
  if (datos.nombre_cliente) mensaje += `Nombre: ${datos.nombre_cliente}\n`;
  if (datos.direccion) mensaje += `Dirección: ${datos.direccion}\n`;
  if (datos.telefono) mensaje += `Teléfono: ${datos.telefono}\n`;
  mensaje += '\n¿Confirmas el pedido?';

  await whatsapp.sendButtonMessage(from, mensaje, [
    { id: 'confirmar_si', title: 'Sí, confirmar' },
    { id: 'confirmar_no', title: 'Cancelar' }
  ]);

  stateManager.setStep(from, negocio.id, 'confirmar_pedido');
}

/**
 * Handle order confirmation - MULTI-PRODUCT SUPPORT
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

  const { productosParaPedido, total, nombreCliente, direccion, telefono } = state.data || {};

  if (!productosParaPedido || productosParaPedido.length === 0) {
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

  // Unified states
  const estadoInicial = cfg.flujoPago === 'contacto' 
    ? config.orderStates?.IN_PREPARATION || 'EN_PREPARACION'
    : config.orderStates?.PENDING_PAYMENT || 'PENDIENTE_PAGO';

  // Format products for Google Sheets
  const productosTexto = formatearProductosParaSheets(productosParaPedido);

  try {
    // Update or create customer
    await sheets.upsertCliente({
      whatsapp: from,
      nombre: nombreCliente,
      telefono: telefono || '',
      direccion: direccion
    });

    // Create order with ALL products
    await sheets.crearPedido({
      id: pedidoId,
      whatsapp: from,
      cliente: nombreCliente,
      telefono: telefono || '',
      direccion: direccion,
      productos: productosTexto,
      total,
      estado: estadoInicial,
      observaciones: 'WhatsApp Bot IA + RAG (Multi-product)'
    });
    
    console.log('✅ Multi-product order created:', pedidoId, '- Products:', productosParaPedido.length);
  } catch (e) {
    console.error('❌ Error creating order:', e.message);
  }

  if (cfg.flujoPago === 'contacto') {
    let mensaje = '✅ PEDIDO CONFIRMADO\n\n';
    mensaje += `Código: ${pedidoId}\n\n`;
    
    productosParaPedido.forEach(p => {
      mensaje += `${p.nombre} x${p.cantidad}\n`;
    });
    
    mensaje += `\nTotal: S/${total.toFixed(2)}\n\n`;
    mensaje += `Entrega en: ${direccion}\n\n`;
    mensaje += 'Te contactaremos pronto para coordinar el pago y la entrega.\n\n';
    mensaje += 'Gracias por tu compra.';

    await whatsapp.sendMessage(from, mensaje);
    stateManager.resetState(from, negocio.id);
  } else {
    const metodosPago = await sheets.getMetodosPago();
    
    let mensajePago = '✅ PEDIDO REGISTRADO\n\n';
    mensajePago += `Código: ${pedidoId}\n\n`;
    
    productosParaPedido.forEach(p => {
      const unidadTexto = cfg.unidad === 'kg' ? 'kg' : (p.cantidad === 1 ? 'unidad' : 'unidades');
      mensajePago += `${p.nombre} x${p.cantidad} ${unidadTexto}\n`;
    });
    
    mensajePago += `\nTotal: S/${total.toFixed(2)}\n\n`;
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
