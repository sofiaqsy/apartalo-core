/**
 * APARTALO CORE - Handler Custom: Finca Rosal
 * 
 * Flujo personalizado para Finca Rosal:
 * - Asesor humano
 * - Precios VIP por cliente
 * - Café gratis (muestra)
 * - Pedido mínimo 5kg
 */

const { formatPrice, getGreeting, generateId } = require('../../core/utils/formatters');
const config = require('../../config');

// Triggers para café gratis
const TRIGGERS_CAFE_GRATIS = [
  'SOLICITO MUESTRA',
  'SOLICITAR MUESTRA',
  'MUESTRA GRATIS',
  'PROMOCAFE',
  'PROMO1KG',
  'QUIERO UNA MUESTRA GRATIS'
];

/**
 * Manejar mensaje entrante
 */
async function handle(from, message, context) {
  const { whatsapp, sheets, stateManager, negocio, hasFeature } = context;
  const { text, type, interactiveData } = message;

  const state = stateManager.getState(from, negocio.id);
  const mensajeLimpio = (text || '').trim();
  const mensajeUpper = mensajeLimpio.toUpperCase();

  console.log(`   Estado: ${state.step}`);
  console.log(`   Features: ${negocio.features.join(', ')}`);

  // ============================================
  // MODO ASESOR - Tiene prioridad absoluta
  // ============================================
  if (hasFeature('asesorHumano')) {
    const estadoAsesor = await verificarModoAsesor(from, context);
    
    if (estadoAsesor === 'ACTIVA') {
      // Modo asesor activo - solo guardar mensaje, no responder
      await guardarMensajeAsesor(from, mensajeLimpio, 'CLIENTE', context);
      
      // Verificar si quiere salir
      if (mensajeLimpio.toLowerCase() === 'menu' || mensajeLimpio.toLowerCase() === 'salir') {
        await cerrarConversacionAsesor(from, context);
        return await mostrarMenuPrincipal(from, context);
      }
      
      console.log('👤 Mensaje guardado para asesor - BOT NO RESPONDE');
      return; // No responder, asesor responderá
    }
  }

  // ============================================
  // COMANDOS GLOBALES
  // ============================================
  if (mensajeLimpio.toLowerCase() === 'menu' || mensajeLimpio.toLowerCase() === 'menú') {
    stateManager.resetState(from, negocio.id);
    return await mostrarMenuPrincipal(from, context);
  }

  // ============================================
  // CAFÉ GRATIS
  // ============================================
  if (hasFeature('cafeGratis')) {
    if (TRIGGERS_CAFE_GRATIS.some(t => mensajeUpper.includes(t))) {
      return await procesarCafeGratis(from, context);
    }

    // Continuar flujo de café gratis si está en proceso
    if (state.step.startsWith('cafe_gratis_')) {
      return await continuarFlujoCafeGratis(from, mensajeLimpio, context);
    }
  }

  // ============================================
  // CONTACTAR FINCA / ASESOR
  // ============================================
  if (mensajeLimpio.toLowerCase().includes('contactar') || 
      mensajeLimpio.toLowerCase().includes('asesor') ||
      mensajeLimpio.toLowerCase() === 'finca') {
    if (hasFeature('asesorHumano')) {
      return await activarModoAsesor(from, context);
    }
  }

  // ============================================
  // FLUJO NORMAL DE PEDIDOS
  // ============================================
  switch (state.step) {
    case 'inicio':
      return await mostrarMenuPrincipal(from, context);

    case 'menu':
      return await manejarMenu(from, text, interactiveData, context);

    case 'seleccion_producto':
      return await manejarSeleccionProducto(from, text, context);

    case 'cantidad':
      return await manejarCantidad(from, text, context);

    case 'confirmar_pedido':
      return await manejarConfirmacion(from, text, context);

    case 'datos_empresa':
      return await manejarDatosEmpresa(from, text, context);

    case 'datos_direccion':
      return await manejarDatosDireccion(from, text, context);

    case 'datos_contacto':
      return await manejarDatosContacto(from, text, context);

    case 'datos_telefono':
      return await manejarDatosTelefono(from, text, context);

    default:
      return await mostrarMenuPrincipal(from, context);
  }
}

// ============================================
// MENÚ PRINCIPAL
// ============================================

async function mostrarMenuPrincipal(from, context) {
  const { whatsapp, sheets, stateManager, negocio, hasFeature } = context;

  const cliente = await sheets.buscarCliente(from);
  const pedidos = await sheets.getPedidosByWhatsapp(from);
  const pedidosActivos = pedidos.filter(p => 
    !['ENTREGADO', 'CANCELADO', 'Completado'].includes(p.estado)
  );

  const saludo = getGreeting();
  let mensaje = '';
  let botones = [];

  // Verificar precios VIP
  let tieneVIP = false;
  if (hasFeature('preciosVIP') && cliente) {
    // TODO: Cargar precios personalizados
    tieneVIP = false; // Por ahora
  }

  if (!cliente && pedidosActivos.length === 0) {
    // Cliente nuevo
    mensaje = `${saludo}! 👋\n\nBienvenido a *Finca Rosal*\n\n` +
      `Ofrecemos café orgánico premium de Villa Rica directamente a tu cafetería.\n\n` +
      `¿Qué deseas hacer?`;
    
    botones = [
      { id: 'pedir', title: 'Hacer pedido' },
      { id: 'contactar', title: 'Contactar Finca' }
    ];

  } else if (pedidosActivos.length > 0) {
    // Con pedidos activos
    mensaje = `${saludo}! Tienes ${pedidosActivos.length} pedido(s) activo(s):\n\n`;
    pedidosActivos.slice(0, 2).forEach(p => {
      mensaje += `• *${p.id}* - ${p.estado}\n`;
    });
    mensaje += `\n¿Qué deseas hacer?`;

    botones = [
      { id: 'ver_pedidos', title: 'Ver pedidos' },
      { id: 'pedir', title: 'Nuevo pedido' },
      { id: 'contactar', title: 'Contactar Finca' }
    ];

  } else {
    // Cliente recurrente
    const nombreCliente = cliente?.contacto || cliente?.empresa || '';
    mensaje = `${saludo}${nombreCliente ? ` ${nombreCliente}` : ''}! 👋\n\n` +
      `Bienvenido de vuelta a *Finca Rosal*\n\n`;
    
    if (tieneVIP) {
      mensaje += `💎 Tienes precios especiales disponibles.\n\n`;
    }
    
    mensaje += `¿Qué deseas hacer?`;

    botones = [
      { id: 'repetir', title: 'Volver a pedir' },
      { id: 'pedir', title: 'Nuevo pedido' },
      { id: 'contactar', title: 'Contactar Finca' }
    ];
  }

  await whatsapp.sendButtonMessage(from, mensaje, botones);
  stateManager.setStep(from, negocio.id, 'menu');
}

async function manejarMenu(from, text, interactiveData, context) {
  const { stateManager, negocio } = context;
  const opcion = (interactiveData?.id || text || '').toLowerCase();

  if (opcion.includes('pedir') || opcion === 'pedir') {
    return await mostrarCatalogo(from, context);
  }

  if (opcion.includes('repetir') || opcion === 'repetir') {
    return await mostrarHistorialPedidos(from, context);
  }

  if (opcion.includes('pedido') || opcion === 'ver_pedidos') {
    return await mostrarPedidosActivos(from, context);
  }

  if (opcion.includes('contactar') || opcion === 'contactar') {
    return await activarModoAsesor(from, context);
  }

  return await mostrarMenuPrincipal(from, context);
}

// ============================================
// CATÁLOGO
// ============================================

async function mostrarCatalogo(from, context) {
  const { whatsapp, sheets, stateManager, negocio, hasFeature } = context;

  // Obtener productos
  const productos = await sheets.getProductos('ACTIVO');
  
  if (productos.length === 0) {
    await whatsapp.sendMessage(from, 'No hay productos disponibles en este momento.');
    return await mostrarMenuPrincipal(from, context);
  }

  // Verificar precios VIP
  let preciosVIP = {};
  if (hasFeature('preciosVIP')) {
    const cliente = await sheets.buscarCliente(from);
    if (cliente?.id) {
      // TODO: Cargar desde CatalogoPersonalizado
      preciosVIP = {};
    }
  }

  let mensaje = `☕ *CATÁLOGO FINCA ROSAL*\n\n`;

  productos.forEach((p, i) => {
    const precioFinal = preciosVIP[p.codigo] || p.precio;
    const descuento = preciosVIP[p.codigo] ? ` ~~S/${p.precio}~~` : '';
    
    mensaje += `*${i + 1}.* ${p.nombre}\n`;
    mensaje += `   S/${precioFinal}/kg${descuento}\n`;
    if (p.descripcion) mensaje += `   _${p.descripcion}_\n`;
    mensaje += '\n';
  });

  mensaje += `📦 Pedido mínimo: 5kg\n\n`;
  mensaje += `Escribe el *número* del café que deseas:`;

  await whatsapp.sendMessage(from, mensaje);

  stateManager.setState(from, negocio.id, {
    step: 'seleccion_producto',
    data: { productos, preciosVIP }
  });
}

async function manejarSeleccionProducto(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const { productos, preciosVIP } = state.data;

  const numero = parseInt(text);

  if (isNaN(numero) || numero < 1 || numero > productos.length) {
    await whatsapp.sendMessage(from, 'Por favor, ingresa un número válido del catálogo.');
    return;
  }

  const producto = productos[numero - 1];
  const precioFinal = preciosVIP?.[producto.codigo] || producto.precio;

  let mensaje = `✅ Has seleccionado:\n\n`;
  mensaje += `*${producto.nombre}*\n`;
  if (producto.descripcion) mensaje += `${producto.descripcion}\n`;
  mensaje += `\nPrecio: S/${precioFinal}/kg\n\n`;
  mensaje += `*¿Cuántos kilos necesitas?*\n`;
  mensaje += `_Pedido mínimo: 5kg_`;

  await whatsapp.sendMessage(from, mensaje);

  stateManager.updateData(from, negocio.id, { 
    productoSeleccionado: producto,
    precioFinal 
  });
  stateManager.setStep(from, negocio.id, 'cantidad');
}

async function manejarCantidad(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const { productoSeleccionado, precioFinal } = state.data;

  const cantidad = parseFloat(text);
  const minimo = context.config?.deliveryMin || 5;

  if (isNaN(cantidad) || cantidad < minimo) {
    await whatsapp.sendMessage(from, `El pedido mínimo es de *${minimo}kg*. Por favor, ingresa una cantidad mayor.`);
    return;
  }

  const total = cantidad * precioFinal;

  const mensaje = `*RESUMEN DE PEDIDO*\n\n` +
    `☕ ${productoSeleccionado.nombre}\n` +
    `   Cantidad: *${cantidad}kg*\n` +
    `   Precio: S/${precioFinal}/kg\n\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `*TOTAL: S/${total.toFixed(2)}*\n` +
    `━━━━━━━━━━━━━━━━━\n\n` +
    `*¿Confirmar pedido?*`;

  await whatsapp.sendButtonMessage(from, mensaje, [
    { id: 'confirmar_si', title: 'Sí, confirmar' },
    { id: 'confirmar_no', title: 'Cancelar' }
  ]);

  stateManager.updateData(from, negocio.id, { cantidad, total });
  stateManager.setStep(from, negocio.id, 'confirmar_pedido');
}

// ============================================
// CONFIRMACIÓN Y DATOS (similar al café-bot original)
// ============================================

async function manejarConfirmacion(from, text, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const opcion = text.toLowerCase();

  if (opcion.includes('no') || opcion === 'confirmar_no') {
    stateManager.resetState(from, negocio.id);
    await whatsapp.sendMessage(from, 'Pedido cancelado.');
    return await mostrarMenuPrincipal(from, context);
  }

  if (!opcion.includes('sí') && !opcion.includes('si') && opcion !== 'confirmar_si') {
    return;
  }

  // Verificar cliente existente
  const cliente = await sheets.buscarCliente(from);

  if (cliente?.empresa && cliente?.direccion) {
    return await crearPedidoDirecto(from, context, cliente);
  }

  // Solicitar datos
  await whatsapp.sendMessage(from,
    `*DATOS DEL CLIENTE*\n\n` +
    `Por favor, ingresa el *nombre de tu empresa o negocio*:`
  );
  stateManager.setStep(from, negocio.id, 'datos_empresa');
}

async function manejarDatosEmpresa(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;

  stateManager.updateData(from, negocio.id, { empresa: text });
  
  await whatsapp.sendMessage(from, 
    `✅ Empresa: *${text}*\n\n` +
    `Ahora ingresa la *dirección completa de tu cafetería*:\n` +
    `_Incluye distrito y referencia_`
  );
  stateManager.setStep(from, negocio.id, 'datos_direccion');
}

async function manejarDatosDireccion(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;

  stateManager.updateData(from, negocio.id, { direccion: text });
  
  await whatsapp.sendMessage(from, 
    `✅ Dirección: *${text}*\n\n` +
    `¿Cuál es tu *nombre completo*?`
  );
  stateManager.setStep(from, negocio.id, 'datos_contacto');
}

async function manejarDatosContacto(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;

  stateManager.updateData(from, negocio.id, { contacto: text });
  
  await whatsapp.sendMessage(from, 
    `✅ Contacto: *${text}*\n\n` +
    `Por último, ingresa un *número de teléfono* para coordinar la entrega:`
  );
  stateManager.setStep(from, negocio.id, 'datos_telefono');
}

async function manejarDatosTelefono(from, text, context) {
  const { sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);

  const datosCliente = {
    whatsapp: from,
    nombre: state.data.contacto,
    telefono: text,
    direccion: state.data.direccion,
    empresa: state.data.empresa
  };

  // Guardar cliente
  await sheets.upsertCliente(datosCliente);

  // Crear pedido
  return await crearPedidoDirecto(from, context, datosCliente);
}

async function crearPedidoDirecto(from, context, cliente) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const { productoSeleccionado, cantidad, total, precioFinal } = state.data;

  const pedidoId = generateId('CAF');

  const pedido = await sheets.crearPedido({
    id: pedidoId,
    whatsapp: from,
    cliente: cliente.empresa || cliente.nombre,
    telefono: cliente.telefono,
    direccion: cliente.direccion,
    productos: JSON.stringify([{
      codigo: productoSeleccionado.codigo,
      nombre: productoSeleccionado.nombre,
      cantidad,
      precio: precioFinal
    }]),
    total,
    estado: 'En preparación'
  });

  const mensaje = `✅ *¡Pedido recibido!*\n\n` +
    `☕ *${productoSeleccionado.nombre}*\n` +
    `${cantidad}kg - S/${total.toFixed(2)}\n\n` +
    `Tu código de pedido es *${pedidoId}* y será entregado en:\n` +
    `*${cliente.direccion}*\n\n` +
    `En las próximas horas te contactaremos para coordinar el pago y confirmar tu entrega.\n\n` +
    `¡Gracias por tu confianza! ☕`;

  await whatsapp.sendMessage(from, mensaje);
  stateManager.resetState(from, negocio.id);
}

// ============================================
// MODO ASESOR
// ============================================

async function verificarModoAsesor(from, context) {
  const { sheets } = context;
  
  try {
    // Buscar conversación activa en Conversaciones_Asesor
    const rows = await sheets.getRows(sheets.spreadsheetId, 'Conversaciones_Asesor!A:E');
    const cleanFrom = from.replace('whatsapp:', '').replace('+', '').replace(/[^0-9]/g, '');
    
    for (let i = 1; i < rows.length; i++) {
      const whatsappRow = (rows[i][3] || '').replace(/[^0-9]/g, '');
      const estado = rows[i][4] || '';
      
      if (whatsappRow === cleanFrom && estado === 'ACTIVA') {
        return 'ACTIVA';
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error verificando modo asesor:', error.message);
    return null;
  }
}

async function activarModoAsesor(from, context) {
  const { whatsapp, sheets, negocio } = context;

  try {
    const cliente = await sheets.buscarCliente(from);
    const cleanFrom = from.replace('whatsapp:', '').replace('+', '').replace(/[^0-9]/g, '');
    const timestamp = new Date().toISOString();
    const convId = `CONV-${Date.now()}`;

    // Crear conversación
    await sheets.appendRow('Conversaciones_Asesor', [
      convId,
      timestamp,
      cliente?.empresa || cliente?.nombre || 'Cliente',
      cleanFrom,
      'ACTIVA',
      timestamp
    ]);

    await whatsapp.sendMessage(from,
      `👤 *CONECTANDO CON FINCA ROSAL*\n\n` +
      `Un momento, te estamos conectando con un asesor.\n\n` +
      `Mientras tanto, puedes escribir tu consulta y te responderemos a la brevedad.\n\n` +
      `_Escribe "menu" para volver al menú principal_`
    );

    console.log(`✅ Modo asesor activado para ${from}`);
  } catch (error) {
    console.error('Error activando modo asesor:', error.message);
    await whatsapp.sendMessage(from, 'Error conectando con asesor. Intenta más tarde.');
  }
}

async function guardarMensajeAsesor(from, mensaje, tipo, context) {
  const { sheets } = context;
  
  try {
    const cleanFrom = from.replace('whatsapp:', '').replace('+', '').replace(/[^0-9]/g, '');
    const timestamp = new Date().toISOString();
    const msgId = `MSG-${Date.now()}`;

    // Obtener conversación activa
    const rows = await sheets.getRows(sheets.spreadsheetId, 'Conversaciones_Asesor!A:E');
    let convId = null;
    
    for (let i = 1; i < rows.length; i++) {
      const whatsappRow = (rows[i][3] || '').replace(/[^0-9]/g, '');
      const estado = rows[i][4] || '';
      
      if (whatsappRow === cleanFrom && estado === 'ACTIVA') {
        convId = rows[i][0];
        break;
      }
    }

    if (convId) {
      await sheets.appendRow('Mensajes', [
        msgId,
        convId,
        timestamp,
        tipo,
        mensaje,
        cleanFrom
      ]);
    }
  } catch (error) {
    console.error('Error guardando mensaje asesor:', error.message);
  }
}

async function cerrarConversacionAsesor(from, context) {
  const { sheets } = context;
  
  try {
    const cleanFrom = from.replace('whatsapp:', '').replace('+', '').replace(/[^0-9]/g, '');
    const rows = await sheets.getRows(sheets.spreadsheetId, 'Conversaciones_Asesor!A:E');
    
    for (let i = 1; i < rows.length; i++) {
      const whatsappRow = (rows[i][3] || '').replace(/[^0-9]/g, '');
      const estado = rows[i][4] || '';
      
      if (whatsappRow === cleanFrom && estado === 'ACTIVA') {
        await sheets.updateCell(`Conversaciones_Asesor!E${i + 1}`, 'CERRADA');
        console.log(`✅ Conversación cerrada para ${from}`);
        break;
      }
    }
  } catch (error) {
    console.error('Error cerrando conversación:', error.message);
  }
}

// ============================================
// CAFÉ GRATIS
// ============================================

/**
 * Returns the re-prompt question for the current muestra step.
 */
function getPreguntaActualMuestra(step) {
  switch (step) {
    case 'cafe_gratis_empresa':   return '¿Cuál es el nombre de tu cafetería o negocio?';
    case 'cafe_gratis_nombre':    return '¿Cuál es tu nombre completo?';
    case 'cafe_gratis_direccion': return '¿Cuál es tu dirección completa para el envío?\n_Incluye distrito_';
    case 'cafe_gratis_telefono':  return '¿Cuál es tu número de teléfono?';
    default: return '¿En qué te puedo ayudar?';
  }
}

async function procesarCafeGratis(from, context) {
  const { whatsapp, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);

  // Already collecting muestra data — just re-prompt the current question
  // instead of sending the intro again (prevents duplicate intro messages).
  if (state.step.startsWith('cafe_gratis_')) {
    await whatsapp.sendMessage(from, getPreguntaActualMuestra(state.step));
    return;
  }

  await whatsapp.sendMessage(from,
    `🎁 *¡MUESTRA GRATIS!*\n\n` +
    `Gracias por tu interés en nuestro café.\n\n` +
    `Para solicitar tu muestra gratis de 250g, necesitamos algunos datos.\n\n` +
    `¿Cuál es el *nombre de tu cafetería o negocio*?`
  );

  stateManager.setState(from, negocio.id, {
    step: 'cafe_gratis_empresa',
    data: { tipo: 'MUESTRA' }
  });
}

async function continuarFlujoCafeGratis(from, text, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);

  // ── Context-switch detection ──────────────────────────────────────────────
  // If the user asks about prices or the catalog while we're collecting muestra
  // data, show the info briefly and then re-ask the current question.
  const esConsultaPrecios = /precio|costo|cuanto|catálogo|catalogo|tarifas?/i.test(text);
  const esContactar = /contactar|asesor|hablar con|persona/i.test(text);

  if (esConsultaPrecios) {
    try {
      const productos = await sheets.getProductos('ACTIVO');
      let respuesta = `*PRECIOS FINCA ROSAL*\n\n`;
      productos.forEach(p => {
        respuesta += `• ${p.nombre}: S/${p.precio}/kg\n`;
      });
      respuesta += `\nPedido mínimo: 5kg\n`;
      respuesta += `\n---\n${getPreguntaActualMuestra(state.step)}`;
      await whatsapp.sendMessage(from, respuesta);
    } catch (e) {
      await whatsapp.sendMessage(from,
        `Para consultar precios completos escribe *CONTACTAR FINCA*.\n\n` +
        getPreguntaActualMuestra(state.step)
      );
    }
    return;
  }

  if (esContactar) {
    await whatsapp.sendMessage(from,
      `Para hablar con un asesor escribe *CONTACTAR FINCA*.\n\n` +
      getPreguntaActualMuestra(state.step)
    );
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

  switch (state.step) {
    case 'cafe_gratis_empresa':
      stateManager.updateData(from, negocio.id, { empresa: text });
      await whatsapp.sendMessage(from, '¿Cuál es tu *nombre completo*?');
      stateManager.setStep(from, negocio.id, 'cafe_gratis_nombre');
      break;

    case 'cafe_gratis_nombre':
      stateManager.updateData(from, negocio.id, { nombre: text });
      await whatsapp.sendMessage(from, '¿Cuál es tu *dirección completa* para el envío?\n_Incluye distrito_');
      stateManager.setStep(from, negocio.id, 'cafe_gratis_direccion');
      break;

    case 'cafe_gratis_direccion':
      stateManager.updateData(from, negocio.id, { direccion: text });
      await whatsapp.sendMessage(from, '¿Cuál es tu *número de teléfono*?');
      stateManager.setStep(from, negocio.id, 'cafe_gratis_telefono');
      break;

    case 'cafe_gratis_telefono':
      const data = state.data;
      data.telefono = text;

      // Crear pedido de muestra
      const pedidoId = generateId('MUE');
      
      await sheets.crearPedido({
        id: pedidoId,
        whatsapp: from,
        cliente: data.empresa,
        telefono: data.telefono,
        direccion: data.direccion,
        productos: 'Muestra Café 250g',
        total: 0,
        estado: 'Pendiente envío',
        observaciones: 'MUESTRA GRATIS'
      });

      await whatsapp.sendMessage(from,
        `✅ *¡MUESTRA SOLICITADA!*\n\n` +
        `Tu código es *${pedidoId}*\n\n` +
        `Enviaremos tu muestra de 250g de café a:\n` +
        `*${data.direccion}*\n\n` +
        `Te contactaremos para coordinar la entrega.\n\n` +
        `¡Gracias por tu interés en Finca Rosal! ☕`
      );

      stateManager.resetState(from, negocio.id);
      break;
  }
}

// ============================================
// UTILIDADES
// ============================================

async function mostrarPedidosActivos(from, context) {
  const { whatsapp, sheets, negocio } = context;

  const pedidos = await sheets.getPedidosByWhatsapp(from);
  const activos = pedidos.filter(p => !['ENTREGADO', 'CANCELADO', 'Completado'].includes(p.estado));

  if (activos.length === 0) {
    await whatsapp.sendMessage(from, 'No tienes pedidos activos.');
    return await mostrarMenuPrincipal(from, context);
  }

  let mensaje = `*📋 TUS PEDIDOS ACTIVOS*\n\n`;

  activos.forEach(p => {
    mensaje += `*${p.id}*\n`;
    mensaje += `   Estado: ${p.estado}\n`;
    mensaje += `   Total: S/${p.total}\n`;
    mensaje += `   Fecha: ${p.fecha}\n\n`;
  });

  await whatsapp.sendMessage(from, mensaje);
}

async function mostrarHistorialPedidos(from, context) {
  const { whatsapp, sheets, negocio } = context;

  const pedidos = await sheets.getPedidosByWhatsapp(from);
  const completados = pedidos.filter(p => ['ENTREGADO', 'Completado'].includes(p.estado));

  if (completados.length === 0) {
    await whatsapp.sendMessage(from, 'No tienes pedidos anteriores para repetir.');
    return await mostrarCatalogo(from, context);
  }

  // Por ahora, mostrar catálogo
  await whatsapp.sendMessage(from, 'Función de repetir pedido próximamente. Mientras tanto, aquí está nuestro catálogo:');
  return await mostrarCatalogo(from, context);
}

module.exports = { handle };
