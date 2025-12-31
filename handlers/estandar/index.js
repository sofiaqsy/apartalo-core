/**
 * APARTALO CORE - Handler Estándar
 * 
 * Flujo de conversación por defecto para negocios
 * Ahora con IA para respuestas más cálidas e inteligentes
 */

const { formatPrice, getGreeting, generateId, formatOrderStatus } = require('../../core/utils/formatters');
const { detectarDepartamento } = require('../../core/utils/ciudades');
const aiService = require('../../core/services/ai-service');
const config = require('../../config');

// Inicializar IA al cargar
aiService.initialize().catch(console.error);

/**
 * Manejar mensaje entrante
 */
async function handle(from, message, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const { text, type, interactiveData } = message;

  const state = stateManager.getState(from, negocio.id);
  const mensajeLimpio = (text || '').trim();
  const mensajeNormalizado = mensajeLimpio.toLowerCase();

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📨 HANDLER ESTÁNDAR`);
  console.log(`   From: ${from}`);
  console.log(`   Negocio: ${negocio.nombre} (${negocio.id})`);
  console.log(`   Mensaje: "${mensajeLimpio}"`);
  console.log(`   Tipo: ${type}`);
  console.log(`   Estado: ${state.step}`);
  console.log(`   InteractiveData:`, interactiveData);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // Comandos globales
  if (mensajeNormalizado === 'menu' || mensajeNormalizado === 'menú' || mensajeNormalizado === 'inicio') {
    console.log('   → Comando: menu');
    stateManager.resetState(from, negocio.id);
    return await mostrarMenuPrincipal(from, context);
  }

  if (mensajeNormalizado === 'cancelar') {
    console.log('   → Comando: cancelar');
    stateManager.resetState(from, negocio.id);
    await whatsapp.sendMessage(from, 'Operación cancelada. ¿En qué más te puedo ayudar? 😊');
    return await mostrarMenuPrincipal(from, context);
  }

  // Manejar pedido desde catálogo WhatsApp
  if (interactiveData?.type === 'order') {
    console.log('   → Procesando order de catálogo');
    return await procesarPedidoCatalogo(from, interactiveData.items, context);
  }

  // Flujo según estado
  console.log(`   → Switch por estado: ${state.step}`);
  switch (state.step) {
    case 'inicio':
      console.log('   → Llamando manejarMensajeInicial');
      return await manejarMensajeInicial(from, mensajeLimpio, context);

    case 'menu':
      console.log('   → Llamando manejarMenu');
      return await manejarMenu(from, text, interactiveData, context);

    case 'seleccion_producto':
      return await manejarSeleccionProducto(from, text, context);

    case 'cantidad':
      return await manejarCantidad(from, text, context);

    case 'confirmar_pedido':
      return await manejarConfirmacion(from, text, interactiveData, context);

    case 'datos_nombre':
      return await manejarDatosNombre(from, text, context);

    case 'datos_telefono':
      return await manejarDatosTelefono(from, text, context);

    case 'datos_direccion':
      return await manejarDatosDireccion(from, text, context);

    case 'datos_ciudad':
      return await manejarDatosCiudad(from, text, context);

    case 'esperando_voucher':
      return await manejarVoucher(from, message, context);

    default:
      console.log('   → Default: llamando manejarMensajeInicial');
      return await manejarMensajeInicial(from, mensajeLimpio, context);
  }
}

// ============================================
// MANEJO INTELIGENTE DE MENSAJES
// ============================================

async function manejarMensajeInicial(from, mensaje, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  
  console.log(`\n🤖 manejarMensajeInicial: "${mensaje}"`);
  
  // Obtener productos para contexto
  const productos = await sheets.getProductos('PUBLICADO');
  console.log(`   Productos encontrados: ${productos.length}`);
  
  // Usar IA para entender el mensaje
  console.log('   Llamando aiService.procesarMensaje...');
  const resultado = await aiService.procesarMensaje(mensaje, {
    negocio,
    productos,
    estadoActual: 'inicio'
  });

  console.log(`   🤖 IA resultado: accion=${resultado.accion}, respuesta="${resultado.respuesta?.substring(0, 50)}..."`);

  // Ejecutar acción según lo que entendió la IA
  switch (resultado.accion) {
    case 'ver_catalogo':
      console.log('   → Acción: ver_catalogo');
      if (resultado.respuesta) {
        await whatsapp.sendMessage(from, resultado.respuesta);
      }
      return await mostrarCatalogo(from, context);

    case 'buscar_producto':
      console.log('   → Acción: buscar_producto');
      if (resultado.datos?.producto) {
        await whatsapp.sendMessage(from, resultado.respuesta);
        stateManager.setState(from, negocio.id, {
          step: 'cantidad',
          data: { productoSeleccionado: resultado.datos.producto, productos }
        });
        return;
      }
      return await buscarProducto(from, resultado.datos?.buscar || mensaje, context);

    case 'contactar':
      console.log('   → Acción: contactar');
      await whatsapp.sendMessage(from, resultado.respuesta || 'Te conecto con alguien del equipo 👤');
      await whatsapp.sendMessage(from, 
        `📱 *${negocio.nombre}*\n\n` +
        `Puedes escribir tu consulta y te responderemos pronto.\n\n` +
        `⏰ Horario de atención: Lun-Sab 9am-6pm\n\n` +
        `_Escribe "menu" para volver al inicio_`
      );
      return;

    case 'menu':
      console.log('   → Acción: menu');
      return await mostrarMenuPrincipal(from, context);

    case 'continuar':
    default:
      console.log('   → Acción: continuar (enviar respuesta)');
      await whatsapp.sendMessage(from, resultado.respuesta);
      
      // Si es saludo o ayuda, mostrar opciones
      if (/hola|ayuda|help/.test(mensaje.toLowerCase())) {
        console.log('   → Es saludo/ayuda, mostrando menú');
        return await mostrarMenuPrincipal(from, context);
      }
      return;
  }
}

async function buscarProducto(from, termino, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  
  const productos = await sheets.getProductos('PUBLICADO');
  const encontrados = productos.filter(p => 
    p.nombre.toLowerCase().includes(termino.toLowerCase())
  );

  if (encontrados.length === 0) {
    await whatsapp.sendMessage(from, 
      `No encontré "${termino}" 😅\n\n` +
      `Te muestro lo que tenemos disponible:`
    );
    return await mostrarCatalogo(from, context);
  }

  if (encontrados.length === 1) {
    const producto = encontrados[0];
    await whatsapp.sendMessage(from, 
      `¡Encontré esto! 🎉\n\n` +
      `*${producto.nombre}*\n` +
      `💰 ${formatPrice(producto.precio)}\n` +
      `📦 Stock: ${producto.disponible || producto.stock || 'Disponible'}\n\n` +
      `¿Cuántas unidades deseas?`
    );
    stateManager.setState(from, negocio.id, {
      step: 'cantidad',
      data: { productoSeleccionado: producto, productos }
    });
    return;
  }

  // Múltiples resultados
  let mensaje = `Encontré ${encontrados.length} productos:\n\n`;
  encontrados.slice(0, 5).forEach((p, i) => {
    mensaje += `*${i + 1}.* ${p.nombre} - ${formatPrice(p.precio)}\n`;
  });
  mensaje += `\nEscribe el *número* del que quieres:`;

  await whatsapp.sendMessage(from, mensaje);
  stateManager.setState(from, negocio.id, {
    step: 'seleccion_producto',
    data: { productos: encontrados }
  });
}

// ============================================
// MENÚ PRINCIPAL
// ============================================

async function mostrarMenuPrincipal(from, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  console.log('   📋 mostrarMenuPrincipal');

  // Buscar cliente existente
  const cliente = await sheets.buscarCliente(from);
  
  // Buscar pedidos activos
  const pedidos = await sheets.getPedidosByWhatsapp(from);
  const pedidosActivos = pedidos.filter(p => 
    !['ENTREGADO', 'CANCELADO'].includes(p.estado)
  );

  const saludo = getGreeting();
  let mensaje = '';
  let botones = [];

  if (!cliente && pedidosActivos.length === 0) {
    // Cliente nuevo
    mensaje = `${saludo}! 👋\n\nBienvenido a *${negocio.nombre}*\n\n¿En qué te puedo ayudar?`;
    botones = [
      { id: 'ver_catalogo', title: 'Ver catálogo 📦' },
      { id: 'contactar', title: 'Contactar 💬' }
    ];
  } else if (pedidosActivos.length > 0) {
    // Cliente con pedidos activos
    mensaje = `${saludo}! 👋\n\nTienes ${pedidosActivos.length} pedido(s) activo(s):\n\n`;
    pedidosActivos.slice(0, 3).forEach(p => {
      mensaje += `• *${p.id}* - ${formatOrderStatus(p.estado)}\n`;
    });
    mensaje += `\n¿Qué deseas hacer?`;
    botones = [
      { id: 'ver_pedidos', title: 'Ver pedidos 📋' },
      { id: 'ver_catalogo', title: 'Nuevo pedido 🛒' }
    ];
  } else {
    // Cliente recurrente sin pedidos activos
    const nombreCliente = cliente?.nombre?.split(' ')[0] || '';
    mensaje = `${saludo}${nombreCliente ? ` ${nombreCliente}` : ''}! 👋\n\nBienvenido de vuelta a *${negocio.nombre}*\n\n¿Qué te gustaría hacer?`;
    botones = [
      { id: 'ver_catalogo', title: 'Ver catálogo 📦' },
      { id: 'repetir_pedido', title: 'Repetir pedido 🔄' },
      { id: 'contactar', title: 'Contactar 💬' }
    ];
  }

  console.log(`   Enviando menú con ${botones.length} botones`);
  await whatsapp.sendButtonMessage(from, mensaje, botones);
  stateManager.setStep(from, negocio.id, 'menu');
}

async function manejarMenu(from, text, interactiveData, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  
  // Priorizar respuesta de botones
  const opcion = interactiveData?.id || text?.toLowerCase() || '';
  console.log(`   manejarMenu opcion: "${opcion}"`);

  if (opcion.includes('catalogo') || opcion.includes('catálogo') || opcion === 'ver_catalogo') {
    return await mostrarCatalogo(from, context);
  }

  if (opcion.includes('pedido') || opcion === 'ver_pedidos') {
    return await mostrarPedidos(from, context);
  }

  if (opcion.includes('repetir') || opcion === 'repetir_pedido') {
    return await repetirUltimoPedido(from, context);
  }

  if (opcion.includes('contactar') || opcion === 'contactar') {
    await whatsapp.sendMessage(from, 
      `📱 *${negocio.nombre}*\n\n` +
      `Escribe tu consulta y te responderemos pronto 😊\n\n` +
      `⏰ Horario: Lun-Sab 9am-6pm\n\n` +
      `_Escribe "menu" para volver al inicio_`
    );
    return;
  }

  // Si no es un comando conocido, usar IA
  console.log('   → Opción no reconocida, usando IA');
  return await manejarMensajeInicial(from, text, context);
}

// ============================================
// CATÁLOGO
// ============================================

async function mostrarCatalogo(from, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  const productos = await sheets.getProductos('PUBLICADO');

  if (productos.length === 0) {
    await whatsapp.sendMessage(from, 'No hay productos disponibles en este momento 😅\n\nVuelve pronto!');
    return await mostrarMenuPrincipal(from, context);
  }

  let mensaje = `📦 *CATÁLOGO ${negocio.nombre.toUpperCase()}*\n\n`;

  productos.slice(0, 10).forEach((p, i) => {
    const stock = p.disponible || p.stock || 0;
    const stockInfo = stock > 0 ? `✅ ${stock} disp.` : '⚠️ Agotado';
    mensaje += `*${i + 1}.* ${p.nombre}\n`;
    mensaje += `   ${formatPrice(p.precio)} | ${stockInfo}\n\n`;
  });

  if (productos.length > 10) {
    mensaje += `_...y ${productos.length - 10} productos más_\n\n`;
  }

  mensaje += `Escribe el *número* del producto que te interesa 👇`;

  await whatsapp.sendMessage(from, mensaje);

  stateManager.setState(from, negocio.id, {
    step: 'seleccion_producto',
    data: { productos }
  });
}

async function manejarSeleccionProducto(from, text, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const productos = state.data?.productos || [];

  const numero = parseInt(text);

  // Si no es número, intentar buscar por nombre con IA
  if (isNaN(numero)) {
    return await manejarMensajeInicial(from, text, context);
  }

  if (numero < 1 || numero > productos.length) {
    await whatsapp.sendMessage(from, `Por favor, elige un número del 1 al ${productos.length} 😊`);
    return;
  }

  const producto = productos[numero - 1];

  // Mostrar detalle del producto
  let mensaje = `*${producto.nombre}*\n\n`;
  if (producto.descripcion) mensaje += `${producto.descripcion}\n\n`;
  mensaje += `💰 Precio: ${formatPrice(producto.precio)}\n`;
  mensaje += `📦 Disponible: ${producto.disponible || producto.stock || 'Sí'} unidades\n\n`;
  mensaje += `¿Cuántas unidades deseas? 🛒`;

  await whatsapp.sendMessage(from, mensaje);

  stateManager.updateData(from, negocio.id, { productoSeleccionado: producto });
  stateManager.setStep(from, negocio.id, 'cantidad');
}

async function manejarCantidad(from, text, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const producto = state.data?.productoSeleccionado;

  if (!producto) {
    return await mostrarCatalogo(from, context);
  }

  const cantidad = parseInt(text);

  if (isNaN(cantidad) || cantidad < 1) {
    await whatsapp.sendMessage(from, 'Por favor, ingresa una cantidad válida (mínimo 1) 😊');
    return;
  }

  const disponible = producto.disponible || producto.stock || 999;
  if (cantidad > disponible) {
    await whatsapp.sendMessage(from, `Solo tenemos ${disponible} unidades disponibles 😅`);
    return;
  }

  const total = cantidad * producto.precio;

  const mensaje = `*📋 RESUMEN DE TU PEDIDO*\n\n` +
    `📦 ${producto.nombre}\n` +
    `   Cantidad: ${cantidad}\n` +
    `   Precio: ${formatPrice(producto.precio)} c/u\n\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `*TOTAL: ${formatPrice(total)}*\n` +
    `━━━━━━━━━━━━━━━━━\n\n` +
    `¿Confirmamos tu pedido? 🛒`;

  await whatsapp.sendButtonMessage(from, mensaje, [
    { id: 'confirmar_si', title: '✅ Sí, confirmar' },
    { id: 'confirmar_no', title: '❌ Cancelar' }
  ]);

  stateManager.updateData(from, negocio.id, { cantidad, total });
  stateManager.setStep(from, negocio.id, 'confirmar_pedido');
}

// ============================================
// CONFIRMACIÓN Y DATOS
// ============================================

async function manejarConfirmacion(from, text, interactiveData, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const opcion = interactiveData?.id || text?.toLowerCase() || '';

  if (opcion.includes('no') || opcion === 'confirmar_no') {
    stateManager.resetState(from, negocio.id);
    await whatsapp.sendMessage(from, 'Pedido cancelado. ¿En qué más te puedo ayudar? 😊');
    return await mostrarMenuPrincipal(from, context);
  }

  if (!opcion.includes('sí') && !opcion.includes('si') && opcion !== 'confirmar_si') {
    await whatsapp.sendMessage(from, 'Por favor, confirma o cancela el pedido usando los botones 👆');
    return;
  }

  // Verificar si ya tenemos datos del cliente
  const cliente = await sheets.buscarCliente(from);

  if (cliente && cliente.nombre && cliente.direccion) {
    // Cliente existente, crear pedido directo
    return await crearPedido(from, context, cliente);
  }

  // Solicitar datos
  await whatsapp.sendMessage(from, 
    '*📝 DATOS DE ENVÍO*\n\n' +
    'Para enviarte tu pedido, necesito algunos datos.\n\n' +
    '¿Cuál es tu *nombre completo*?'
  );
  stateManager.setStep(from, negocio.id, 'datos_nombre');
}

async function manejarDatosNombre(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;

  if (!text || text.length < 3) {
    await whatsapp.sendMessage(from, 'Por favor, ingresa tu nombre completo 😊');
    return;
  }

  stateManager.updateData(from, negocio.id, { nombre: text });
  
  await whatsapp.sendMessage(from, `Gracias ${text.split(' ')[0]}! 😊\n\nAhora ingresa tu *número de teléfono*:`);
  stateManager.setStep(from, negocio.id, 'datos_telefono');
}

async function manejarDatosTelefono(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;
  const telefono = text.replace(/[^0-9]/g, '');

  if (telefono.length < 9) {
    await whatsapp.sendMessage(from, 'Por favor, ingresa un teléfono válido (9 dígitos) 📱');
    return;
  }

  stateManager.updateData(from, negocio.id, { telefono });
  
  await whatsapp.sendMessage(from, '¡Perfecto! 📍\n\nIngresa tu *dirección completa* (con distrito):');
  stateManager.setStep(from, negocio.id, 'datos_direccion');
}

async function manejarDatosDireccion(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;

  if (!text || text.length < 10) {
    await whatsapp.sendMessage(from, 'Por favor, ingresa una dirección más completa (incluye distrito) 📍');
    return;
  }

  stateManager.updateData(from, negocio.id, { direccion: text });
  
  await whatsapp.sendMessage(from, 'Último dato! 🏙️\n\n¿En qué *ciudad o distrito* te encuentras?');
  stateManager.setStep(from, negocio.id, 'datos_ciudad');
}

async function manejarDatosCiudad(from, text, context) {
  const { sheets, stateManager, negocio } = context;

  const departamento = detectarDepartamento(text);
  
  stateManager.updateData(from, negocio.id, { 
    ciudad: text,
    departamento: departamento || ''
  });

  // Crear cliente y pedido
  const state = stateManager.getState(from, negocio.id);
  const datosCliente = {
    whatsapp: from,
    nombre: state.data.nombre,
    telefono: state.data.telefono,
    direccion: state.data.direccion,
    ciudad: state.data.ciudad,
    departamento: state.data.departamento
  };

  await sheets.upsertCliente(datosCliente);
  return await crearPedido(from, context, datosCliente);
}

// ============================================
// CREAR PEDIDO
// ============================================

async function crearPedido(from, context, cliente) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const { productoSeleccionado, cantidad, total } = state.data;

  // Reservar stock
  const reserva = await sheets.reservarStock(productoSeleccionado.codigo, cantidad);
  
  if (!reserva.success) {
    await whatsapp.sendMessage(from, `😅 ${reserva.error}\n\n¿Quieres ver otros productos?`);
    return await mostrarMenuPrincipal(from, context);
  }

  // Crear pedido
  const pedido = await sheets.crearPedido({
    whatsapp: from,
    cliente: cliente.nombre,
    telefono: cliente.telefono,
    direccion: cliente.direccion,
    productos: JSON.stringify([{
      codigo: productoSeleccionado.codigo,
      nombre: productoSeleccionado.nombre,
      cantidad,
      precio: productoSeleccionado.precio
    }]),
    total,
    ciudad: cliente.ciudad,
    departamento: cliente.departamento,
    estado: config.orderStates.PENDING_PAYMENT
  });

  if (!pedido) {
    await whatsapp.sendMessage(from, '😅 Hubo un error creando el pedido. Intenta nuevamente.');
    return;
  }

  // Obtener métodos de pago
  const metodosPago = await sheets.getMetodosPago();
  
  let mensajePago = `🎉 *¡PEDIDO REGISTRADO!*\n\n`;
  mensajePago += `📋 Código: *${pedido.id}*\n`;
  mensajePago += `📦 ${productoSeleccionado.nombre} x${cantidad}\n`;
  mensajePago += `💰 Total: *${formatPrice(total)}*\n\n`;
  mensajePago += `━━━━━━━━━━━━━━━━━\n`;
  mensajePago += `*MÉTODOS DE PAGO:*\n\n`;

  metodosPago.forEach(m => {
    if (m.tipo === 'yape' || m.tipo === 'plin') {
      mensajePago += `📱 *${m.tipo.toUpperCase()}*: ${m.numero}\n`;
    } else {
      mensajePago += `🏦 *${m.tipo.toUpperCase()}*\n`;
      mensajePago += `   Cuenta: ${m.cuenta}\n`;
      if (m.cci) mensajePago += `   CCI: ${m.cci}\n`;
    }
    if (m.titular) mensajePago += `   Titular: ${m.titular}\n`;
    mensajePago += '\n';
  });

  mensajePago += `━━━━━━━━━━━━━━━━━\n\n`;
  mensajePago += `📸 *Envía la foto de tu comprobante* para confirmar el pedido.`;

  await whatsapp.sendMessage(from, mensajePago);

  stateManager.updateData(from, negocio.id, { pedidoId: pedido.id });
  stateManager.setStep(from, negocio.id, 'esperando_voucher');
}

// ============================================
// VOUCHER
// ============================================

async function manejarVoucher(from, message, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  if (message.type !== 'image') {
    await whatsapp.sendMessage(from, '📸 Por favor, envía una *foto* de tu comprobante de pago.');
    return;
  }

  const state = stateManager.getState(from, negocio.id);
  const pedidoId = state.data?.pedidoId;

  // Actualizar estado del pedido
  await sheets.updateEstadoPedido(pedidoId, config.orderStates.PENDING_VALIDATION);

  await whatsapp.sendMessage(from,
    `✅ *¡COMPROBANTE RECIBIDO!*\n\n` +
    `Tu pedido *${pedidoId}* está siendo validado.\n\n` +
    `Te notificaremos cuando sea confirmado 📦\n\n` +
    `¡Gracias por tu compra! 🙏`
  );

  stateManager.resetState(from, negocio.id);
}

// ============================================
// UTILIDADES
// ============================================

async function mostrarPedidos(from, context) {
  const { whatsapp, sheets, negocio } = context;

  const pedidos = await sheets.getPedidosByWhatsapp(from);
  
  if (pedidos.length === 0) {
    await whatsapp.sendMessage(from, 'No tienes pedidos registrados aún 📭\n\n¿Te gustaría hacer uno?');
    return await mostrarMenuPrincipal(from, context);
  }

  let mensaje = `*📋 TUS PEDIDOS*\n\n`;

  pedidos.slice(0, 5).forEach(p => {
    const emoji = p.estado === 'ENTREGADO' ? '✅' : p.estado === 'CANCELADO' ? '❌' : '📦';
    mensaje += `${emoji} *${p.id}*\n`;
    mensaje += `   Estado: ${formatOrderStatus(p.estado)}\n`;
    mensaje += `   Total: ${formatPrice(p.total)}\n`;
    mensaje += `   Fecha: ${p.fecha}\n\n`;
  });

  await whatsapp.sendMessage(from, mensaje);
}

async function repetirUltimoPedido(from, context) {
  const { whatsapp, sheets, negocio } = context;

  const pedidos = await sheets.getPedidosByWhatsapp(from);
  const ultimoPedido = pedidos.find(p => p.estado === 'ENTREGADO');

  if (!ultimoPedido) {
    await whatsapp.sendMessage(from, 'No tienes pedidos anteriores para repetir 😅\n\nTe muestro el catálogo:');
    return await mostrarCatalogo(from, context);
  }

  // TODO: Implementar repetición de pedido completo
  await whatsapp.sendMessage(from, '🔄 Función de repetir pedido próximamente disponible.\n\nMientras tanto, te muestro el catálogo:');
  return await mostrarCatalogo(from, context);
}

async function procesarPedidoCatalogo(from, items, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  console.log('🛒 Procesando pedido desde catálogo WhatsApp');
  console.log(`   Items: ${items.length}`);

  await whatsapp.sendMessage(from, 
    `✅ Recibimos tu selección de ${items.length} producto(s) 🛒\n\n` +
    `Un momento mientras procesamos tu pedido...`
  );

  // TODO: Implementar flujo completo de pedido desde catálogo
  return await mostrarMenuPrincipal(from, context);
}

module.exports = { handle };
