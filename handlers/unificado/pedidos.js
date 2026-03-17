/**
 * APARTALO CORE - Handler Unificado - Pedidos
 *
 * v4.5:
 * - Imagen se envía solo una vez por producto (no repetir si ya se mostró)
 * - Si el cliente ya está registrado, no pedir datos — solo confirmar los existentes
 */

const { getGreeting, generateId } = require('../../core/utils/formatters');
const aiOrderService = require('../../core/services/ai-order-service');
const config = require('../../config');
const { mergeDatasSinNull, formatearProductosParaSheets } = require('./utils');
const negociosService = require('../../config/negocios');
const deliveryService = require('../../core/services/delivery-service');

async function iniciarPedidoConversacionalDirecto(from, mensaje, context, cfg) {
  const { whatsapp, stateManager, negocio } = context;
  
  console.log('Starting direct conversation with AI + RAG (no buttons)');
  
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
    saludo + ' Soy el asistente virtual de *' + negocio.nombre + '*\n\n' +
    '¿En qué puedo ayudarte hoy?\n\n' +
    '_Si prefieres hablar directamente con la finca, escribe *CONTACTAR FINCA*._'
  );
}

async function continuarPedidoConversacional(from, mensaje, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);

  const historial = state.data?.historial || [];
  const datosCliente = state.data?.datosCliente || null;
  let datosAcumulados = state.data?.datosExtraidos || {};
  const ultimoProductoMostrado = state.data?.ultimoProductoMostrado || null;

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

  if (resultado.datosExtraidos) {
    datosAcumulados = mergeDatasSinNull(datosAcumulados, resultado.datosExtraidos);
  }

  console.log('Accumulated data:', JSON.stringify(datosAcumulados));

  historial.push({ rol: 'cliente', texto: mensaje });
  historial.push({ rol: 'asistente', texto: resultado.respuesta });

  // Determinar si hay un producto activo en la conversación
  const productoCodigoActual = datosAcumulados.producto_codigo || 
    (datosAcumulados.productos && datosAcumulados.productos[0]?.codigo);

  let productoParaMostrar = null;
  let debeEnviarImagen = false;

  if (productoCodigoActual && cfg.mostrarFotos) {
    // Solo mostrar imagen si es un producto DISTINTO al último mostrado
    if (productoCodigoActual !== ultimoProductoMostrado) {
      try {
        const productos = await sheets.getProductosConPrecios(from);
        productoParaMostrar = productos.find(p => p.codigo === productoCodigoActual);
        if (productoParaMostrar?.imagenUrl) {
          debeEnviarImagen = true;
        }
      } catch (e) {
        console.log('Error finding product for image:', e.message);
      }
    }
  }

  const tieneProductos = (datosAcumulados.productos && datosAcumulados.productos.length > 0) ||
                         (datosAcumulados.producto_codigo && datosAcumulados.cantidad);
  
  if (resultado.pedidoCompleto && tieneProductos) {
    stateManager.updateData(from, negocio.id, {
      historial,
      datosExtraidos: datosAcumulados,
      ultimoProductoMostrado: debeEnviarImagen ? productoCodigoActual : ultimoProductoMostrado
    });
    
    // Enviar imagen antes de pasar a confirmar, si corresponde
    if (debeEnviarImagen && productoParaMostrar?.imagenUrl) {
      try {
        await whatsapp.sendImage(from, productoParaMostrar.imagenUrl, resultado.respuesta);
      } catch (e) {
        await whatsapp.sendMessage(from, resultado.respuesta);
      }
    }

    return await confirmarPedidoIA(from, context, cfg, datosAcumulados);
  }

  stateManager.updateData(from, negocio.id, {
    historial,
    datosExtraidos: datosAcumulados,
    ultimoProductoMostrado: debeEnviarImagen ? productoCodigoActual : ultimoProductoMostrado
  });

  if (debeEnviarImagen && productoParaMostrar?.imagenUrl) {
    try {
      await whatsapp.sendImage(from, productoParaMostrar.imagenUrl, resultado.respuesta);
      console.log('Image sent with caption');
    } catch (e) {
      console.log('Error sending image:', e.message);
      await whatsapp.sendMessage(from, resultado.respuesta);
    }
  } else {
    await whatsapp.sendMessage(from, resultado.respuesta);
  }
}

async function confirmarPedidoIA(from, context, cfg, datos) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  console.log('confirmarPedidoIA - received data:', JSON.stringify(datos));

  // ============================================
  // RESOLVER DATOS DEL CLIENTE
  // Primero buscar en Sheets; si ya existe, usar sus datos guardados.
  // Solo pedir datos si el cliente no está registrado.
  // ============================================
  let clienteRegistrado = null;
  try {
    clienteRegistrado = await sheets.buscarCliente(from);
  } catch (e) {
    console.log('Error buscando cliente:', e.message);
  }

  // Prioridad: datos que la IA recogió en esta conversación > datos guardados en Sheets
  const nombreFinal    = datos.nombre_cliente || clienteRegistrado?.nombre || null;
  const direccionFinal = datos.direccion       || clienteRegistrado?.direccion || null;
  const telefonoFinal  = datos.telefono        || clienteRegistrado?.telefono || null;
  const clienteYaExiste = !!clienteRegistrado;

  // ============================================
  // RESOLVER PRODUCTOS
  // ============================================
  let productosParaPedido = [];
  let total = 0;

  const resolverProductos = async (items) => {
    let productosDisponibles = [];
    try {
      productosDisponibles = await sheets.getProductosConPrecios(from);
    } catch (e) {
      try { productosDisponibles = await sheets.getProductos('ACTIVO'); } catch {}
    }

    for (const item of items) {
      const producto = productosDisponibles.find(p => p.codigo === item.codigo);
      const cantidad = parseFloat(item.cantidad) || 1;
      const precio   = producto?.precio ?? parseFloat(item.precio) ?? 0;
      const nombre   = producto?.nombre ?? item.nombre ?? 'Producto';
      productosParaPedido.push({ codigo: item.codigo, nombre, cantidad, precio });
      total += cantidad * precio;
    }
  };

  if (datos.productos?.length > 0) {
    await resolverProductos(datos.productos);
  } else if (datos.producto_codigo) {
    await resolverProductos([{
      codigo: datos.producto_codigo,
      nombre: datos.producto_nombre,
      cantidad: datos.cantidad || cfg.minimoCompra || 1,
      precio: datos.precio_unitario || 0
    }]);
  }

  if (productosParaPedido.length === 0) {
    await whatsapp.sendMessage(from, '¿Podrías indicarme nuevamente qué producto deseas?');
    return;
  }

  if (datos.total_calculado > 0) total = datos.total_calculado;

  stateManager.updateData(from, negocio.id, {
    productosParaPedido,
    total,
    nombreCliente: nombreFinal,
    direccion: direccionFinal,
    telefono: telefonoFinal,
    clienteYaExiste
  });

  // ============================================
  // ARMAR RESUMEN
  // ============================================
  let mensaje = 'RESUMEN DE TU PEDIDO\n\n';
  
  productosParaPedido.forEach(p => {
    const unidadTexto = cfg.unidad === 'kg' ? 'kg' : (p.cantidad === 1 ? 'unidad' : 'unidades');
    mensaje += `${p.nombre}\n`;
    mensaje += `  ${p.cantidad} ${unidadTexto} x S/${p.precio} = S/${(p.cantidad * p.precio).toFixed(2)}\n\n`;
  });

  mensaje += `Total: S/${total.toFixed(2)}\n\n`;
  mensaje += 'Entrega:\n';

  if (clienteYaExiste && nombreFinal) {
    // Cliente registrado: mostrar datos existentes para confirmar, no pedirlos
    mensaje += `Nombre: ${nombreFinal}\n`;
    if (direccionFinal) mensaje += `Dirección: ${direccionFinal}\n`;
    if (telefonoFinal)  mensaje += `Teléfono: ${telefonoFinal}\n`;
    mensaje += '\n¿Confirmas el pedido con estos datos?';
  } else {
    // Cliente nuevo: aún no tenemos sus datos completos
    if (nombreFinal)    mensaje += `Nombre: ${nombreFinal}\n`;
    if (direccionFinal) mensaje += `Dirección: ${direccionFinal}\n`;
    if (telefonoFinal)  mensaje += `Teléfono: ${telefonoFinal}\n`;
    mensaje += '\n¿Confirmas el pedido?';
  }

  await whatsapp.sendButtonMessage(from, mensaje, [
    { id: 'confirmar_si', title: 'Sí, confirmar' },
    { id: 'confirmar_no', title: 'Cancelar' }
  ]);

  stateManager.setStep(from, negocio.id, 'confirmar_pedido');
}

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

  const { productosParaPedido, total, nombreCliente, direccion, telefono, clienteYaExiste } = state.data || {};

  if (!productosParaPedido || productosParaPedido.length === 0) {
    await whatsapp.sendMessage(from, 'Ocurrió un error. Por favor intenta de nuevo.');
    stateManager.resetState(from, negocio.id);
    return;
  }

  // Si es cliente nuevo y faltan datos, solicitarlos
  if (!clienteYaExiste && (!nombreCliente || !direccion)) {
    await whatsapp.sendMessage(from,
      'Para completar el pedido necesito tu nombre completo, dirección de entrega (incluye distrito) y teléfono de contacto.'
    );
    stateManager.setStep(from, negocio.id, 'pedido_conversacional');
    return;
  }

  const pedidoId = generateId(cfg.prefijoPedido);
  const estadoInicial = cfg.flujoPago === 'contacto'
    ? config.orderStates?.IN_PREPARATION || 'EN_PREPARACION'
    : config.orderStates?.PENDING_PAYMENT || 'PENDIENTE_PAGO';

  try {
    await sheets.upsertCliente({
      whatsapp: from,
      nombre: nombreCliente,
      telefono: telefono || '',
      direccion: direccion
    });

    await sheets.crearPedido({
      id: pedidoId,
      whatsapp: from,
      cliente: nombreCliente,
      telefono: telefono || '',
      direccion: direccion,
      productos: formatearProductosParaSheets(productosParaPedido),
      total,
      estado: estadoInicial,
      observaciones: 'WhatsApp Bot IA + RAG'
    });
    
    console.log('Order created:', pedidoId);

    // 🚚 Notificar al negocio delivery si aplica (fire-and-forget)
    const productosStr = productosParaPedido.map(p => `${p.nombre} x${p.cantidad}`).join(', ');
    deliveryService.notificarNuevoDelivery(
      { id: pedidoId, whatsapp: from, cliente: nombreCliente || '', telefono: telefono || '', direccion: direccion || '', ciudad: '', departamento: '', productos: productosStr, total },
      negocio,
      negociosService
    ).catch(e => console.error('⚠️ [Delivery] Error in delivery hook (unificado):', e.message));

  } catch (e) {
    console.error('Error guardando pedido:', e.message);
  }

  if (cfg.flujoPago === 'contacto') {
    let mensaje = 'PEDIDO CONFIRMADO\n\n';
    mensaje += `Código: ${pedidoId}\n\n`;
    productosParaPedido.forEach(p => {
      const unidadTexto = cfg.unidad === 'kg' ? 'kg' : (p.cantidad === 1 ? 'unidad' : 'unidades');
      mensaje += `${p.nombre} x${p.cantidad} ${unidadTexto}\n`;
    });
    mensaje += `\nTotal: S/${total.toFixed(2)}\n\n`;
    mensaje += `Entrega en: ${direccion}\n\n`;
    mensaje += 'Te contactaremos pronto para coordinar el pago y la entrega.\n\n';
    mensaje += 'Gracias por tu compra.';

    await whatsapp.sendMessage(from, mensaje);
    stateManager.resetState(from, negocio.id);
  } else {
    const metodosPago = await sheets.getMetodosPago();
    
    let mensajePago = 'PEDIDO REGISTRADO\n\n';
    mensajePago += `Código: ${pedidoId}\n\n`;
    productosParaPedido.forEach(p => {
      const unidadTexto = cfg.unidad === 'kg' ? 'kg' : (p.cantidad === 1 ? 'unidad' : 'unidades');
      mensajePago += `${p.nombre} x${p.cantidad} ${unidadTexto}\n`;
    });
    mensajePago += `\nTotal: S/${total.toFixed(2)}\n\n`;
    mensajePago += 'METODOS DE PAGO:\n\n';

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
  }
}

module.exports = {
  iniciarPedidoConversacionalDirecto,
  continuarPedidoConversacional,
  confirmarPedidoIA,
  manejarConfirmacion
};
