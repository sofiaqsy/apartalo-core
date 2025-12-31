/**
 * APARTALO CORE - Handler Estándar v3
 * 
 * Flujo conversacional con soporte para envío de fotos de productos
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
  const { text, type, interactiveData, mediaId } = message;

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
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // Comandos globales
  if (mensajeNormalizado === 'menu' || mensajeNormalizado === 'menú' || mensajeNormalizado === 'inicio') {
    stateManager.resetState(from, negocio.id);
    return await mostrarMenuPrincipal(from, context);
  }

  if (mensajeNormalizado === 'cancelar') {
    stateManager.resetState(from, negocio.id);
    await whatsapp.sendMessage(from, 'Operación cancelada. ¿En qué más te puedo ayudar? 😊');
    return await mostrarMenuPrincipal(from, context);
  }

  // Pedido desde catálogo WhatsApp
  if (interactiveData?.type === 'order') {
    return await procesarPedidoCatalogo(from, interactiveData.items, context);
  }

  // Flujo según estado
  switch (state.step) {
    case 'inicio':
      return await manejarMensajeConIA(from, message, context);

    case 'menu':
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
      return await manejarMensajeConIA(from, message, context);
  }
}

// ============================================
// MANEJO INTELIGENTE CON IA
// ============================================

async function manejarMensajeConIA(from, message, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const { text, type, mediaId } = message;
  const mensajeLimpio = (text || '').trim();
  const state = stateManager.getState(from, negocio.id);
  
  console.log(`\n🤖 manejarMensajeConIA`);
  console.log(`   Mensaje: "${mensajeLimpio}"`);
  console.log(`   Tipo: ${type}`);
  
  const productos = await sheets.getProductos('PUBLICADO');
  const cliente = await sheets.buscarCliente(from);
  
  const contextoIA = {
    negocio,
    productos,
    estadoActual: state.step,
    tipoMensaje: type,
    datosCliente: cliente || {},
    pedidoActual: state.data?.productoSeleccionado ? {
      producto: state.data.productoSeleccionado.nombre,
      cantidad: state.data.cantidad,
      total: state.data.total
    } : null
  };

  const resultado = await aiService.procesarMensaje(mensajeLimpio, contextoIA);
  console.log(`   🤖 IA: accion=${resultado.accion}`);

  switch (resultado.accion) {
    case 'ver_catalogo':
      if (resultado.respuesta) {
        await whatsapp.sendMessage(from, resultado.respuesta);
      }
      return await mostrarCatalogo(from, context);

    case 'enviar_foto':
      // ✨ NUEVA ACCIÓN: Enviar foto del producto
      if (resultado.datos?.producto) {
        const producto = resultado.datos.producto;
        const imagenUrl = producto.imagenUrl || producto.imagen || producto.ImagenURL;
        
        if (imagenUrl) {
          console.log(`   📷 Enviando foto: ${imagenUrl}`);
          
          // Convertir URL de Google Drive si es necesario
          const urlFinal = convertirUrlGoogleDrive(imagenUrl);
          
          const caption = `*${producto.nombre}*\n💰 S/${producto.precio}\n📦 Stock: ${producto.disponible || producto.stock || 'Disponible'}\n\n¿Te interesa? 😊`;
          
          try {
            await whatsapp.sendImage(from, urlFinal, caption);
          } catch (error) {
            console.error('❌ Error enviando imagen:', error.message);
            // Si falla la imagen, enviar solo texto
            await whatsapp.sendMessage(from, `*${producto.nombre}*\n💰 S/${producto.precio}\n📦 Stock: ${producto.disponible || producto.stock || 'Disponible'}\n\n(No pude cargar la imagen)\n\n¿Te interesa?`);
          }
        } else {
          await whatsapp.sendMessage(from, `*${producto.nombre}*\n💰 S/${producto.precio}\n📦 Stock: ${producto.disponible || producto.stock || 'Disponible'}\n\n¿Te interesa?`);
        }
        return;
      }
      await whatsapp.sendMessage(from, resultado.respuesta || '¿De qué producto quieres ver la foto?');
      return;

    case 'info_producto':
      if (resultado.datos?.producto) {
        await whatsapp.sendMessage(from, resultado.respuesta);
        // Preguntar si quiere comprar
        await whatsapp.sendButtonMessage(from, '¿Qué deseas hacer?', [
          { id: `comprar_${resultado.datos.producto.codigo}`, title: '🛒 Comprar' },
          { id: `foto_${resultado.datos.producto.codigo}`, title: '📷 Ver foto' }
        ]);
        stateManager.updateData(from, negocio.id, { 
          ultimoProducto: resultado.datos.producto,
          productos 
        });
        return;
      }
      await whatsapp.sendMessage(from, resultado.respuesta);
      return;

    case 'confirmar_compra':
      if (resultado.datos?.producto) {
        await whatsapp.sendMessage(from, resultado.respuesta);
        stateManager.setState(from, negocio.id, {
          step: 'cantidad',
          data: { productoSeleccionado: resultado.datos.producto, productos }
        });
        return;
      }
      await whatsapp.sendMessage(from, resultado.respuesta);
      return;

    case 'preguntar':
      await whatsapp.sendMessage(from, resultado.respuesta);
      return;

    case 'contactar':
      await whatsapp.sendMessage(from, resultado.respuesta || 'Te conecto con alguien del equipo 👤');
      await whatsapp.sendMessage(from, 
        `📱 *${negocio.nombre}*\n\n` +
        `Escribe tu consulta y te responderemos pronto.\n\n` +
        `⏰ Horario: Lun-Sab 9am-6pm\n\n` +
        `_Escribe "menu" para volver_`
      );
      return;

    case 'menu':
      return await mostrarMenuPrincipal(from, context);

    case 'procesar_voucher':
      return await manejarVoucher(from, message, context);

    case 'preguntar_imagen':
      await whatsapp.sendButtonMessage(from, resultado.respuesta, [
        { id: 'es_voucher', title: 'Es un comprobante' },
        { id: 'ver_catalogo', title: 'Ver catálogo' }
      ]);
      return;

    case 'seleccionar_numero':
      if (state.step === 'seleccion_producto') {
        return await manejarSeleccionProducto(from, mensajeLimpio, context);
      }
      await whatsapp.sendMessage(from, '¿Qué producto te interesa?');
      return;

    case 'continuar':
    default:
      if (resultado.respuesta) {
        await whatsapp.sendMessage(from, resultado.respuesta);
      }
      
      // Solo mostrar menú si es un saludo explícito
      if (/^(hola|buenos días|buenas tardes|buenas noches)$/i.test(mensajeLimpio)) {
        return await mostrarMenuPrincipal(from, context);
      }
      return;
  }
}

/**
 * Convertir URL de Google Drive a formato directo
 */
function convertirUrlGoogleDrive(url) {
  if (!url) return url;
  
  // Si es thumbnail de Google Drive, convertir a export
  // https://drive.google.com/thumbnail?id=XXX -> https://drive.google.com/uc?export=view&id=XXX
  if (url.includes('drive.google.com/thumbnail')) {
    const idMatch = url.match(/id=([^&]+)/);
    if (idMatch) {
      return `https://drive.google.com/uc?export=view&id=${idMatch[1]}`;
    }
  }
  
  // Si es formato /file/d/XXX/view
  if (url.includes('/file/d/')) {
    const idMatch = url.match(/\/file\/d\/([^/]+)/);
    if (idMatch) {
      return `https://drive.google.com/uc?export=view&id=${idMatch[1]}`;
    }
  }
  
  return url;
}

// ============================================
// MENÚ PRINCIPAL
// ============================================

async function mostrarMenuPrincipal(from, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  const cliente = await sheets.buscarCliente(from);
  const pedidos = await sheets.getPedidosByWhatsapp(from);
  const pedidosActivos = pedidos.filter(p => 
    !['ENTREGADO', 'CANCELADO'].includes(p.estado)
  );

  const saludo = getGreeting();
  let mensaje = '';
  let botones = [];

  if (!cliente && pedidosActivos.length === 0) {
    mensaje = `${saludo}! 👋\n\nBienvenido a *${negocio.nombre}*\n\n¿En qué te puedo ayudar?`;
    botones = [
      { id: 'ver_catalogo', title: 'Ver catálogo 📦' },
      { id: 'contactar', title: 'Contactar 💬' }
    ];
  } else if (pedidosActivos.length > 0) {
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
    const nombreCliente = cliente?.nombre?.split(' ')[0] || '';
    mensaje = `${saludo}${nombreCliente ? ` ${nombreCliente}` : ''}! 👋\n\nBienvenido de vuelta a *${negocio.nombre}*\n\n¿Qué te gustaría hacer?`;
    botones = [
      { id: 'ver_catalogo', title: 'Ver catálogo 📦' },
      { id: 'repetir_pedido', title: 'Repetir pedido 🔄' },
      { id: 'contactar', title: 'Contactar 💬' }
    ];
  }

  await whatsapp.sendButtonMessage(from, mensaje, botones);
  stateManager.setStep(from, negocio.id, 'menu');
}

async function manejarMenu(from, text, interactiveData, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  
  const opcion = interactiveData?.id || text?.toLowerCase() || '';
  const state = stateManager.getState(from, negocio.id);

  // Manejar botones de producto (comprar_XXX, foto_XXX)
  if (opcion.startsWith('comprar_')) {
    const codigo = opcion.replace('comprar_', '');
    const productos = await sheets.getProductos('PUBLICADO');
    const producto = productos.find(p => p.codigo === codigo) || state.data?.ultimoProducto;
    
    if (producto) {
      await whatsapp.sendMessage(from, `¡Perfecto! *${producto.nombre}* a S/${producto.precio}\n\n¿Cuántas unidades deseas?`);
      stateManager.setState(from, negocio.id, {
        step: 'cantidad',
        data: { productoSeleccionado: producto, productos }
      });
      return;
    }
  }

  if (opcion.startsWith('foto_')) {
    const codigo = opcion.replace('foto_', '');
    const productos = await sheets.getProductos('PUBLICADO');
    const producto = productos.find(p => p.codigo === codigo) || state.data?.ultimoProducto;
    
    if (producto) {
      const imagenUrl = producto.imagenUrl || producto.imagen || producto.ImagenURL;
      if (imagenUrl) {
        const urlFinal = convertirUrlGoogleDrive(imagenUrl);
        try {
          await whatsapp.sendImage(from, urlFinal, `*${producto.nombre}*\nS/${producto.precio}`);
        } catch (error) {
          await whatsapp.sendMessage(from, 'No pude cargar la imagen 😅');
        }
      } else {
        await whatsapp.sendMessage(from, 'Este producto no tiene foto disponible 😅');
      }
      return;
    }
  }

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
      `_Escribe "menu" para volver_`
    );
    return;
  }

  if (opcion === 'es_voucher') {
    await whatsapp.sendMessage(from, '📸 Perfecto! Envía la foto de tu comprobante.');
    stateManager.setStep(from, negocio.id, 'esperando_voucher');
    return;
  }

  // Si no es comando conocido, usar IA
  return await manejarMensajeConIA(from, { text, type: 'text', interactiveData }, context);
}

// ============================================
// CATÁLOGO
// ============================================

async function mostrarCatalogo(from, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  const productos = await sheets.getProductos('PUBLICADO');

  if (productos.length === 0) {
    await whatsapp.sendMessage(from, 'No hay productos disponibles en este momento 😅');
    return await mostrarMenuPrincipal(from, context);
  }

  let mensaje = `📦 *CATÁLOGO ${negocio.nombre.toUpperCase()}*\n\n`;

  productos.slice(0, 10).forEach((p, i) => {
    const stock = p.disponible || p.stock || 0;
    const stockInfo = stock > 0 ? `✅ ${stock} disp.` : '⚠️ Agotado';
    const tieneImagen = (p.imagenUrl || p.imagen || p.ImagenURL) ? '📷' : '';
    mensaje += `*${i + 1}.* ${p.nombre} ${tieneImagen}\n`;
    mensaje += `   ${formatPrice(p.precio)} | ${stockInfo}\n\n`;
  });

  if (productos.length > 10) {
    mensaje += `_...y ${productos.length - 10} más_\n\n`;
  }

  mensaje += `Escribe el *número* para ver detalles y foto 👇`;

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

  if (isNaN(numero)) {
    return await manejarMensajeConIA(from, { text, type: 'text' }, context);
  }

  if (numero < 1 || numero > productos.length) {
    await whatsapp.sendMessage(from, `Elige un número del 1 al ${productos.length} 😊`);
    return;
  }

  const producto = productos[numero - 1];
  const imagenUrl = producto.imagenUrl || producto.imagen || producto.ImagenURL;

  // Si tiene imagen, enviarla con botones
  if (imagenUrl) {
    const urlFinal = convertirUrlGoogleDrive(imagenUrl);
    const caption = `*${producto.nombre}*\n\n` +
      (producto.descripcion ? `${producto.descripcion}\n\n` : '') +
      `💰 Precio: ${formatPrice(producto.precio)}\n` +
      `📦 Stock: ${producto.disponible || producto.stock || 'Disponible'}`;
    
    try {
      await whatsapp.sendImage(from, urlFinal, caption);
      await whatsapp.sendButtonMessage(from, '¿Qué deseas hacer?', [
        { id: 'comprar_ahora', title: '🛒 Comprar' },
        { id: 'ver_catalogo', title: '👀 Ver más' }
      ]);
    } catch (error) {
      console.error('❌ Error enviando imagen:', error.message);
      // Fallback sin imagen
      await whatsapp.sendMessage(from, caption + '\n\n(No pude cargar la imagen)');
      await whatsapp.sendButtonMessage(from, '¿Qué deseas hacer?', [
        { id: 'comprar_ahora', title: '🛒 Comprar' },
        { id: 'ver_catalogo', title: '👀 Ver más' }
      ]);
    }
  } else {
    // Sin imagen
    let mensaje = `*${producto.nombre}*\n\n`;
    if (producto.descripcion) mensaje += `${producto.descripcion}\n\n`;
    mensaje += `💰 Precio: ${formatPrice(producto.precio)}\n`;
    mensaje += `📦 Stock: ${producto.disponible || producto.stock || 'Disponible'}`;
    
    await whatsapp.sendMessage(from, mensaje);
    await whatsapp.sendButtonMessage(from, '¿Qué deseas hacer?', [
      { id: 'comprar_ahora', title: '🛒 Comprar' },
      { id: 'ver_catalogo', title: '👀 Ver más' }
    ]);
  }

  stateManager.updateData(from, negocio.id, { productoSeleccionado: producto });
}

async function manejarCantidad(from, text, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const producto = state.data?.productoSeleccionado;

  // Manejar botón "Comprar"
  if (text === 'comprar_ahora') {
    await whatsapp.sendMessage(from, `¿Cuántas unidades de *${producto.nombre}* deseas?`);
    stateManager.setStep(from, negocio.id, 'cantidad');
    return;
  }

  if (!producto) {
    return await mostrarCatalogo(from, context);
  }

  const cantidad = parseInt(text);

  if (isNaN(cantidad) || cantidad < 1) {
    await whatsapp.sendMessage(from, 'Ingresa una cantidad válida (mínimo 1) 😊');
    return;
  }

  const disponible = producto.disponible || producto.stock || 999;
  if (cantidad > disponible) {
    await whatsapp.sendMessage(from, `Solo tenemos ${disponible} disponibles 😅`);
    return;
  }

  const total = cantidad * producto.precio;

  const mensaje = `*📋 RESUMEN*\n\n` +
    `📦 ${producto.nombre}\n` +
    `   Cantidad: ${cantidad}\n` +
    `   Precio: ${formatPrice(producto.precio)} c/u\n\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `*TOTAL: ${formatPrice(total)}*\n` +
    `━━━━━━━━━━━━━━━━━\n\n` +
    `¿Confirmamos? 🛒`;

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
    await whatsapp.sendMessage(from, 'Pedido cancelado. ¿Algo más? 😊');
    return await mostrarMenuPrincipal(from, context);
  }

  if (!opcion.includes('sí') && !opcion.includes('si') && opcion !== 'confirmar_si') {
    await whatsapp.sendMessage(from, 'Usa los botones para confirmar o cancelar 👆');
    return;
  }

  const cliente = await sheets.buscarCliente(from);

  if (cliente && cliente.nombre && cliente.direccion) {
    return await crearPedido(from, context, cliente);
  }

  await whatsapp.sendMessage(from, 
    '*📝 DATOS DE ENVÍO*\n\n' +
    'Necesito algunos datos.\n\n' +
    '¿Cuál es tu *nombre completo*?'
  );
  stateManager.setStep(from, negocio.id, 'datos_nombre');
}

async function manejarDatosNombre(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;

  if (!text || text.length < 3) {
    await whatsapp.sendMessage(from, 'Ingresa tu nombre completo 😊');
    return;
  }

  stateManager.updateData(from, negocio.id, { nombre: text });
  await whatsapp.sendMessage(from, `Gracias ${text.split(' ')[0]}! 😊\n\n¿Tu *teléfono*?`);
  stateManager.setStep(from, negocio.id, 'datos_telefono');
}

async function manejarDatosTelefono(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;
  const telefono = text.replace(/[^0-9]/g, '');

  if (telefono.length < 9) {
    await whatsapp.sendMessage(from, 'Ingresa un teléfono válido (9 dígitos) 📱');
    return;
  }

  stateManager.updateData(from, negocio.id, { telefono });
  await whatsapp.sendMessage(from, '¡Perfecto! 📍\n\n¿Tu *dirección completa* (con distrito)?');
  stateManager.setStep(from, negocio.id, 'datos_direccion');
}

async function manejarDatosDireccion(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;

  if (!text || text.length < 10) {
    await whatsapp.sendMessage(from, 'Dirección más completa por favor (incluye distrito) 📍');
    return;
  }

  stateManager.updateData(from, negocio.id, { direccion: text });
  await whatsapp.sendMessage(from, 'Último dato! 🏙️\n\n¿*Ciudad o distrito*?');
  stateManager.setStep(from, negocio.id, 'datos_ciudad');
}

async function manejarDatosCiudad(from, text, context) {
  const { sheets, stateManager, negocio } = context;

  const departamento = detectarDepartamento(text);
  stateManager.updateData(from, negocio.id, { 
    ciudad: text,
    departamento: departamento || ''
  });

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

  const reserva = await sheets.reservarStock(productoSeleccionado.codigo, cantidad);
  
  if (!reserva.success) {
    await whatsapp.sendMessage(from, `😅 ${reserva.error}\n\n¿Quieres ver otros productos?`);
    return await mostrarMenuPrincipal(from, context);
  }

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
    await whatsapp.sendMessage(from, '😅 Error al crear pedido. Intenta de nuevo.');
    return;
  }

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
  mensajePago += `📸 *Envía foto del comprobante* para confirmar.`;

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
    await whatsapp.sendMessage(from, '📸 Envía una *foto* del comprobante.');
    return;
  }

  const state = stateManager.getState(from, negocio.id);
  const pedidoId = state.data?.pedidoId;

  if (!pedidoId) {
    await whatsapp.sendMessage(from, 
      '🤔 No tienes un pedido pendiente.\n\n¿Quieres hacer uno nuevo?'
    );
    return await mostrarMenuPrincipal(from, context);
  }

  await sheets.updateEstadoPedido(pedidoId, config.orderStates.PENDING_VALIDATION);

  await whatsapp.sendMessage(from,
    `✅ *¡COMPROBANTE RECIBIDO!*\n\n` +
    `Pedido *${pedidoId}* en validación.\n\n` +
    `Te avisamos cuando esté confirmado 📦\n\n` +
    `¡Gracias! 🙏`
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
    await whatsapp.sendMessage(from, 'No tienes pedidos aún 📭');
    return await mostrarMenuPrincipal(from, context);
  }

  let mensaje = `*📋 TUS PEDIDOS*\n\n`;

  pedidos.slice(0, 5).forEach(p => {
    const emoji = p.estado === 'ENTREGADO' ? '✅' : p.estado === 'CANCELADO' ? '❌' : '📦';
    mensaje += `${emoji} *${p.id}*\n`;
    mensaje += `   ${formatOrderStatus(p.estado)} | ${formatPrice(p.total)}\n\n`;
  });

  await whatsapp.sendMessage(from, mensaje);
}

async function repetirUltimoPedido(from, context) {
  const { whatsapp, sheets, negocio } = context;

  const pedidos = await sheets.getPedidosByWhatsapp(from);
  const ultimoPedido = pedidos.find(p => p.estado === 'ENTREGADO');

  if (!ultimoPedido) {
    await whatsapp.sendMessage(from, 'No tienes pedidos anteriores 😅');
    return await mostrarCatalogo(from, context);
  }

  await whatsapp.sendMessage(from, '🔄 Función próximamente disponible.\n\nTe muestro el catálogo:');
  return await mostrarCatalogo(from, context);
}

async function procesarPedidoCatalogo(from, items, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  console.log('🛒 Pedido desde catálogo WhatsApp');

  await whatsapp.sendMessage(from, 
    `✅ Recibí tu selección de ${items.length} producto(s) 🛒\n\n` +
    `Procesando...`
  );

  return await mostrarMenuPrincipal(from, context);
}

module.exports = { handle };
