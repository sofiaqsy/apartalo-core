/**
 * APARTALO CORE - Handler Unificado v2.7
 * 
 * Handler conversacional con IA para toma de pedidos natural.
 * 
 * CARACTERISTICAS:
 * - Flujo conversacional con IA (no menus rigidos)
 * - Precios personalizados por cliente (PreciosClientes)
 * - Reutiliza datos del cliente registrado (direccion, telefono)
 * - Envio de imagen solo al identificar producto (no en resumen)
 */

const { formatPrice, getGreeting, generateId } = require('../../core/utils/formatters');
const aiOrderService = require('../../core/services/ai-order-service');
const config = require('../../config');

/**
 * Manejar mensaje entrante
 */
async function handle(from, message, context) {
  const { whatsapp, sheets, stateManager, negocio, hasFeature, asesorService } = context;
  const { text, type, interactiveData } = message;

  const state = stateManager.getState(from, negocio.id);
  const mensajeLimpio = (text || '').trim();
  const mensajeNormalizado = mensajeLimpio.toLowerCase();

  // Configuracion del negocio
  const cfg = {
    unidad: negocio.configExtra?.unidad || 'unidad',
    minimoCompra: negocio.configExtra?.minimoCompra || 1,
    flujoPago: negocio.configExtra?.flujoPago || 'voucher',
    mostrarFotos: negocio.configExtra?.mostrarFotos !== false,
    prefijoPedido: negocio.configExtra?.prefijoPedido || 'PED',
    usarIA: negocio.configExtra?.usarIA !== false
  };

  console.log('\n------------------------------------');
  console.log('HANDLER UNIFICADO - ' + negocio.nombre);
  console.log('   From: ' + from);
  console.log('   Mensaje: "' + mensajeLimpio + '"');
  console.log('   Estado: ' + state.step);
  console.log('------------------------------------\n');

  // ============================================
  // COMANDOS GLOBALES
  // ============================================
  if (mensajeNormalizado === 'menu' || mensajeNormalizado === 'inicio') {
    stateManager.resetState(from, negocio.id);
    return await mostrarMenuPrincipal(from, context, cfg);
  }

  if (mensajeNormalizado === 'cancelar') {
    stateManager.resetState(from, negocio.id);
    await whatsapp.sendMessage(from, 'Operacion cancelada.');
    return await mostrarMenuPrincipal(from, context, cfg);
  }

  // ============================================
  // TRIGGERS ESPECIALES (por features)
  // ============================================
  
  // Muestras gratis
  if (hasFeature('cafeGratis') || hasFeature('muestras')) {
    const triggersMuestra = ['SOLICITO MUESTRA', 'SOLICITAR MUESTRA', 'MUESTRA GRATIS', 'PROMOCAFE', 'PROMO1KG'];
    if (triggersMuestra.some(t => mensajeLimpio.toUpperCase().includes(t))) {
      return await procesarMuestraGratis(from, context, cfg);
    }
    if (state.step?.startsWith('muestra_')) {
      return await continuarFlujoMuestra(from, mensajeLimpio, context, cfg);
    }
  }

  // ============================================
  // CONTACTAR ASESOR
  // ============================================
  if (mensajeNormalizado.includes('contactar') || 
      mensajeNormalizado.includes('asesor') ||
      mensajeNormalizado === 'ayuda' ||
      mensajeNormalizado === 'hablar con alguien') {
    if (hasFeature('asesorHumano') && asesorService) {
      const resultado = await asesorService.activarModoAsesor(from, context);
      await whatsapp.sendMessage(from, resultado.mensaje);
      return;
    } else {
      await whatsapp.sendMessage(from, 
        negocio.nombre + '\n\n' +
        'Escribe tu consulta y te responderemos pronto.\n\n' +
        'Escribe "menu" para volver.'
      );
      return;
    }
  }

  // ============================================
  // FLUJO PRINCIPAL
  // ============================================
  switch (state.step) {
    case 'inicio':
      return await mostrarMenuPrincipal(from, context, cfg);

    case 'menu':
      return await manejarMenu(from, text, interactiveData, context, cfg);

    case 'pedido_conversacional':
      return await continuarPedidoConversacional(from, mensajeLimpio, context, cfg);

    case 'confirmar_pedido':
      return await manejarConfirmacion(from, text, interactiveData, context, cfg);

    case 'esperando_voucher':
      return await manejarVoucher(from, message, context, cfg);

    default:
      return await mostrarMenuPrincipal(from, context, cfg);
  }
}

// ============================================
// UTILIDAD: Merge inteligente (no sobrescribe con null)
// ============================================
function mergeDatasSinNull(acumulado, nuevo) {
  if (!nuevo) return acumulado;
  
  const resultado = { ...acumulado };
  
  for (const key in nuevo) {
    if (nuevo[key] !== null && nuevo[key] !== undefined && nuevo[key] !== '') {
      resultado[key] = nuevo[key];
    }
  }
  
  return resultado;
}

// ============================================
// UTILIDAD: Extraer nombre de producto de JSON
// ============================================
function extraerNombreProducto(productosStr) {
  if (!productosStr) return 'Pedido';
  
  try {
    if (productosStr.startsWith('[') || productosStr.startsWith('{')) {
      const productos = JSON.parse(productosStr);
      if (Array.isArray(productos) && productos.length > 0) {
        const p = productos[0];
        const nombre = p.nombre || p.name || 'Producto';
        const cantidad = p.cantidad || p.qty || 1;
        return nombre + ' x' + cantidad;
      }
    }
    return productosStr.substring(0, 30);
  } catch (e) {
    return productosStr.substring(0, 30) || 'Pedido';
  }
}

// ============================================
// MENU PRINCIPAL
// ============================================

async function mostrarMenuPrincipal(from, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio, hasFeature } = context;

  let cliente = null;
  let pedidosActivos = [];
  
  try {
    cliente = await sheets.buscarCliente(from);
  } catch (e) {}
  
  try {
    const pedidos = await sheets.getPedidosByWhatsapp(from);
    pedidosActivos = (pedidos || []).filter(p => 
      !['ENTREGADO', 'CANCELADO', 'Completado'].includes(p.estado)
    );
  } catch (e) {}

  const saludo = getGreeting();
  let mensaje = '';
  let botones = [];

  if (!cliente && pedidosActivos.length === 0) {
    mensaje = saludo + '\n\nBienvenido a ' + negocio.nombre + '\n\nQue deseas hacer?';
    
    botones = [
      { id: 'pedir', title: 'Hacer pedido' },
      { id: 'contactar', title: 'Contactar' }
    ];

  } else if (pedidosActivos.length > 0) {
    mensaje = saludo + ' Tienes ' + pedidosActivos.length + ' pedido(s) activo(s):\n\n';
    
    pedidosActivos.slice(0, 2).forEach(p => {
      const nombreProd = extraerNombreProducto(p.productos);
      mensaje += '- ' + nombreProd + '\n';
      mensaje += '  Estado: ' + p.estado + '\n\n';
    });
    
    mensaje += 'Que deseas hacer?';

    botones = [
      { id: 'ver_pedidos', title: 'Ver pedidos' },
      { id: 'pedir', title: 'Nuevo pedido' },
      { id: 'contactar', title: 'Contactar' }
    ];

  } else {
    const nombreCliente = cliente?.nombre?.split(' ')[0] || cliente?.empresa || '';
    mensaje = saludo + (nombreCliente ? ' ' + nombreCliente : '') + '\n\n' +
      'Bienvenido de vuelta a ' + negocio.nombre + '\n\nQue deseas hacer?';

    botones = [
      { id: 'pedir', title: 'Nuevo pedido' },
      { id: 'ver_pedidos', title: 'Mis pedidos' },
      { id: 'contactar', title: 'Contactar' }
    ];
  }

  await whatsapp.sendButtonMessage(from, mensaje, botones);
  stateManager.setStep(from, negocio.id, 'menu');
}

async function manejarMenu(from, text, interactiveData, context, cfg) {
  const { asesorService, whatsapp, hasFeature, stateManager, negocio, sheets } = context;
  const opcion = (interactiveData?.id || text || '').toLowerCase();

  if (opcion.includes('pedir') || opcion === 'pedir' || opcion.includes('catalogo')) {
    return await iniciarPedidoConversacional(from, context, cfg);
  }

  if (opcion.includes('pedido') || opcion === 'ver_pedidos') {
    return await mostrarPedidosActivos(from, context, cfg);
  }

  if (opcion === 'enviar_voucher') {
    await whatsapp.sendMessage(from, 'Envia una foto de tu comprobante de pago.');
    stateManager.setStep(from, negocio.id, 'esperando_voucher');
    return;
  }

  if (opcion.includes('contactar') || opcion === 'contactar') {
    if (hasFeature('asesorHumano') && asesorService) {
      const resultado = await asesorService.activarModoAsesor(from, context);
      await whatsapp.sendMessage(from, resultado.mensaje);
      return;
    } else {
      await whatsapp.sendMessage(from, 
        negocio.nombre + '\n\n' +
        'Escribe tu consulta y te responderemos pronto.\n\n' +
        'Escribe "menu" para volver.'
      );
      return;
    }
  }

  return await mostrarMenuPrincipal(from, context, cfg);
}

// ============================================
// PEDIDO CONVERSACIONAL CON IA
// ============================================

async function iniciarPedidoConversacional(from, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  // Buscar cliente existente para reutilizar sus datos
  let cliente = null;
  try {
    cliente = await sheets.buscarCliente(from);
  } catch (e) {}

  const mensajeInicial = 'Con gusto te ayudo.\n\n' +
    'Cuentame, que producto te interesa? Puedes preguntarme por opciones disponibles o decirme directamente lo que necesitas.';

  await whatsapp.sendMessage(from, mensajeInicial);

  // Inicializar con datos del cliente si existen
  const datosIniciales = {};
  if (cliente) {
    if (cliente.nombre) datosIniciales.nombre_cliente = cliente.nombre;
    if (cliente.direccion) datosIniciales.direccion = cliente.direccion;
    if (cliente.telefono) datosIniciales.telefono = cliente.telefono;
  }

  stateManager.setState(from, negocio.id, {
    step: 'pedido_conversacional',
    data: {
      historial: [],
      datosCliente: cliente,
      datosExtraidos: datosIniciales,  // Pre-cargar datos del cliente
      ultimoProductoMostrado: null
    }
  });
}

async function continuarPedidoConversacional(from, mensaje, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);

  const historial = state.data?.historial || [];
  const datosCliente = state.data?.datosCliente || null;
  let datosAcumulados = state.data?.datosExtraidos || {};
  const ultimoProductoMostrado = state.data?.ultimoProductoMostrado || null;

  // Llamar a IA
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

  console.log('Datos acumulados:', JSON.stringify(datosAcumulados));

  historial.push({ rol: 'cliente', texto: mensaje });
  historial.push({ rol: 'asistente', texto: resultado.respuesta });

  // Verificar si se identifico un producto nuevo
  const productoCodigoActual = datosAcumulados.producto_codigo;
  let productoParaMostrar = null;

  if (productoCodigoActual && productoCodigoActual !== ultimoProductoMostrado && cfg.mostrarFotos) {
    try {
      const productos = await sheets.getProductosConPrecios(from);
      productoParaMostrar = productos.find(p => p.codigo === productoCodigoActual);
    } catch (e) {
      console.log('Error buscando producto para imagen:', e.message);
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

  // Enviar imagen del producto si hay una nueva identificacion
  if (productoParaMostrar && productoParaMostrar.imagenUrl) {
    try {
      await whatsapp.sendImage(from, productoParaMostrar.imagenUrl, productoParaMostrar.nombre);
    } catch (e) {
      console.log('Error enviando imagen:', e.message);
    }
  }

  // Enviar respuesta de texto
  await whatsapp.sendMessage(from, resultado.respuesta);
}

async function confirmarPedidoIA(from, context, cfg, datos) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  console.log('confirmarPedidoIA - datos recibidos:', JSON.stringify(datos));

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
    console.log('Producto no encontrado. Codigo:', datos.producto_codigo, 'Nombre:', datos.producto_nombre);
    
    await whatsapp.sendMessage(from, 
      'No pude identificar el producto. Podrias indicarme nuevamente cual deseas?'
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

  // NO enviar imagen en el resumen (ya se mostro antes)

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
    (datos.direccion ? 'Direccion: ' + datos.direccion + '\n' : '') +
    (datos.telefono ? 'Telefono: ' + datos.telefono + '\n' : '') +
    '\nConfirmas el pedido?';

  await whatsapp.sendButtonMessage(from, mensaje, [
    { id: 'confirmar_si', title: 'Si, confirmar' },
    { id: 'confirmar_no', title: 'Cancelar' }
  ]);

  stateManager.setStep(from, negocio.id, 'confirmar_pedido');
}

// ============================================
// CONFIRMACION Y CREACION DE PEDIDO
// ============================================

async function manejarConfirmacion(from, text, interactiveData, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const opcion = (interactiveData?.id || text || '').toLowerCase();

  if (opcion.includes('no') || opcion === 'confirmar_no') {
    stateManager.resetState(from, negocio.id);
    await whatsapp.sendMessage(from, 'Pedido cancelado. Escribe "menu" para volver al inicio.');
    return;
  }

  if (!opcion.includes('si') && opcion !== 'confirmar_si') {
    await whatsapp.sendMessage(from, 'Por favor usa los botones para confirmar o cancelar.');
    return;
  }

  const { productoSeleccionado, cantidad, total, precioFinal, nombreCliente, direccion, telefono } = state.data || {};

  if (!productoSeleccionado) {
    await whatsapp.sendMessage(from, 'Ocurrio un error. Escribe "menu" para comenzar de nuevo.');
    stateManager.resetState(from, negocio.id);
    return;
  }

  // Si faltan datos, pedirlos
  if (!nombreCliente || !direccion) {
    await whatsapp.sendMessage(from, 
      'Para completar el pedido, necesito algunos datos.\n\n' +
      'Por favor indicame tu nombre completo, direccion de entrega (incluye distrito) y un telefono de contacto.'
    );
    stateManager.setStep(from, negocio.id, 'pedido_conversacional');
    return;
  }

  const pedidoId = generateId(cfg.prefijoPedido);
  const unidadTexto = cfg.unidad === 'kg' ? 'kg' : (cantidad === 1 ? 'unidad' : 'unidades');

  const estadoInicial = cfg.flujoPago === 'contacto' 
    ? 'En preparacion' 
    : config.orderStates?.PENDING_PAYMENT || 'PENDIENTE_PAGO';

  try {
    // Actualizar o crear cliente con los datos del pedido
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
      productos: JSON.stringify([{
        codigo: productoSeleccionado.codigo,
        nombre: productoSeleccionado.nombre,
        cantidad,
        precio: precioFinal
      }]),
      total,
      estado: estadoInicial
    });
  } catch (e) {
    console.error('Error creando pedido:', e.message);
  }

  if (cfg.flujoPago === 'contacto') {
    const mensaje = 'PEDIDO CONFIRMADO\n\n' +
      'Codigo: ' + pedidoId + '\n' +
      'Producto: ' + productoSeleccionado.nombre + '\n' +
      'Cantidad: ' + cantidad + ' ' + unidadTexto + '\n' +
      'Total: S/' + total.toFixed(2) + '\n\n' +
      'Entrega en: ' + direccion + '\n\n' +
      'Te contactaremos en las proximas horas para coordinar el pago y la entrega.\n\n' +
      'Gracias por tu compra.';

    await whatsapp.sendMessage(from, mensaje);
  } else {
    const metodosPago = await sheets.getMetodosPago();
    
    let mensajePago = 'PEDIDO REGISTRADO\n\n';
    mensajePago += 'Codigo: ' + pedidoId + '\n';
    mensajePago += productoSeleccionado.nombre + ' x' + cantidad + ' ' + unidadTexto + '\n';
    mensajePago += 'Total: S/' + total.toFixed(2) + '\n\n';
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

    mensajePago += 'Envia foto del comprobante para confirmar.';

    await whatsapp.sendMessage(from, mensajePago);
    stateManager.updateData(from, negocio.id, { pedidoId });
    stateManager.setStep(from, negocio.id, 'esperando_voucher');
    return;
  }

  stateManager.resetState(from, negocio.id);
}

// ============================================
// VOUCHER
// ============================================

async function manejarVoucher(from, message, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  if (message.type !== 'image') {
    await whatsapp.sendMessage(from, 'Por favor, envia una foto del comprobante.');
    return;
  }

  const state = stateManager.getState(from, negocio.id);
  let pedidoId = state.data?.pedidoId;

  if (!pedidoId) {
    const pedidos = await sheets.getPedidosByWhatsapp(from);
    const pendiente = pedidos.find(p => 
      p.estado === 'PENDIENTE_PAGO' || p.estado === config.orderStates?.PENDING_PAYMENT
    );
    if (pendiente) {
      pedidoId = pendiente.id;
    }
  }

  if (!pedidoId) {
    await whatsapp.sendMessage(from, 'No tienes un pedido pendiente de pago.');
    return await mostrarMenuPrincipal(from, context, cfg);
  }

  const nuevoEstado = config.orderStates?.PENDING_VALIDATION || 'PENDIENTE_VALIDACION';
  await sheets.updateEstadoPedido(pedidoId, nuevoEstado);

  await whatsapp.sendMessage(from,
    'COMPROBANTE RECIBIDO\n\n' +
    'Pedido ' + pedidoId + ' en validacion.\n\n' +
    'Te avisamos cuando este confirmado.\n\n' +
    'Gracias.'
  );

  stateManager.resetState(from, negocio.id);
}

// ============================================
// VER PEDIDOS
// ============================================

async function mostrarPedidosActivos(from, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  let pedidos = [];
  try {
    pedidos = await sheets.getPedidosByWhatsapp(from);
  } catch (e) {}

  const activos = (pedidos || []).filter(p => 
    !['ENTREGADO', 'CANCELADO', 'Completado'].includes(p.estado)
  );

  if (activos.length === 0) {
    await whatsapp.sendButtonMessage(from,
      'No tienes pedidos activos.\n\nTe gustaria hacer uno?',
      [
        { id: 'pedir', title: 'Hacer pedido' },
        { id: 'contactar', title: 'Contactar' }
      ]
    );
    stateManager.setStep(from, negocio.id, 'menu');
    return;
  }

  let mensaje = 'TUS PEDIDOS ACTIVOS\n';
  mensaje += '------------------------\n\n';
  
  activos.forEach(p => {
    const nombreProd = extraerNombreProducto(p.productos);
    mensaje += nombreProd + '\n';
    mensaje += 'Codigo: ' + p.id + '\n';
    mensaje += 'Estado: ' + p.estado + '\n';
    mensaje += 'Total: S/' + p.total + '\n';
    
    if (p.direccion) {
      mensaje += 'Entrega: ' + p.direccion + '\n';
    }
    
    if (p.cliente) {
      mensaje += 'Cliente: ' + p.cliente + '\n';
    }
    
    mensaje += '\n';
  });

  let botones = [];
  const pendientesPago = activos.filter(p => 
    p.estado === 'PENDIENTE_PAGO' || p.estado === config.orderStates?.PENDING_PAYMENT
  );

  if (pendientesPago.length > 0 && cfg.flujoPago === 'voucher') {
    botones.push({ id: 'enviar_voucher', title: 'Enviar voucher' });
  }
  botones.push({ id: 'pedir', title: 'Nuevo pedido' });
  botones.push({ id: 'contactar', title: 'Ayuda' });

  await whatsapp.sendButtonMessage(from, mensaje, botones);
  stateManager.setStep(from, negocio.id, 'menu');
}

// ============================================
// MUESTRAS GRATIS (Feature) - 500g
// ============================================

async function procesarMuestraGratis(from, context, cfg) {
  const { whatsapp, stateManager, negocio } = context;

  await whatsapp.sendMessage(from,
    'MUESTRA GRATIS DE CAFE 500g\n\n' +
    'Gracias por tu interes en nuestro cafe.\n\n' +
    'Para solicitar tu muestra, necesitamos algunos datos.\n\n' +
    'Cual es el nombre de tu cafeteria o negocio?'
  );

  stateManager.setState(from, negocio.id, {
    step: 'muestra_empresa',
    data: { tipo: 'MUESTRA' }
  });
}

async function continuarFlujoMuestra(from, text, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);

  switch (state.step) {
    case 'muestra_empresa':
      stateManager.updateData(from, negocio.id, { empresa: text });
      await whatsapp.sendMessage(from, 'Cual es tu nombre completo?');
      stateManager.setStep(from, negocio.id, 'muestra_nombre');
      break;

    case 'muestra_nombre':
      stateManager.updateData(from, negocio.id, { nombre: text });
      await whatsapp.sendMessage(from, 'Cual es tu direccion completa para el envio? (incluye distrito)');
      stateManager.setStep(from, negocio.id, 'muestra_direccion');
      break;

    case 'muestra_direccion':
      stateManager.updateData(from, negocio.id, { direccion: text });
      await whatsapp.sendMessage(from, 'Cual es tu numero de telefono?');
      stateManager.setStep(from, negocio.id, 'muestra_telefono');
      break;

    case 'muestra_telefono':
      const data = state.data;
      data.telefono = text;

      const pedidoId = generateId('MUE');
      
      try {
        await sheets.crearPedido({
          id: pedidoId,
          whatsapp: from,
          cliente: data.empresa,
          telefono: data.telefono,
          direccion: data.direccion,
          productos: 'Muestra Cafe 500g',
          total: 0,
          estado: 'Pendiente envio',
          observaciones: 'MUESTRA GRATIS 500g'
        });
      } catch (e) {}

      await whatsapp.sendMessage(from,
        'MUESTRA SOLICITADA\n\n' +
        'Tu codigo es ' + pedidoId + '\n\n' +
        'Enviaremos tu muestra de 500g a:\n' + data.direccion + '\n\n' +
        'Te contactaremos para coordinar la entrega.\n\n' +
        'Gracias por tu interes en Finca Rosal.'
      );

      stateManager.resetState(from, negocio.id);
      break;
  }
}

module.exports = { handle };
