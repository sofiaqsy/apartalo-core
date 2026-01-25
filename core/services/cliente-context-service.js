/**
 * APARTALO CORE - Cliente Context Service (RAG - Memoria Simulada)
 * 
 * Servicio para construir contexto COMPLETO del cliente recuperando datos de:
 * - Clientes: Datos personales (nombre, empresa, dirección, etc.)
 * - PreciosClientes: Precios personalizados para este cliente
 * - Pedidos: Historial de compras (últimos 5 pedidos)
 * - Inventario: Productos disponibles
 * - Configuracion: Prompt personalizado del negocio
 * - Conversaciones: Historial de mensajes recientes (Firestore)
 * 
 * Esto permite que la IA "recuerde" todo sobre el cliente sin necesidad de fine-tuning.
 */

class ClienteContextService {
  
  /**
   * Obtener contexto COMPLETO del cliente para enriquecer el prompt de la IA
   */
  async obtenerContextoCompleto(whatsapp, context) {
    const { sheets, negocio, firebaseService } = context;
    
    console.log(`📊 Construyendo contexto completo para ${whatsapp}...`);
    
    try {
      // 1. Obtener datos del cliente (tabla Clientes)
      const datosCliente = await this.obtenerDatosCliente(whatsapp, sheets);
      
      // 2. Obtener precios personalizados (tabla PreciosClientes)
      const preciosPersonalizados = await this.obtenerPreciosPersonalizados(
        whatsapp, 
        datosCliente?.id, 
        sheets
      );
      
      // 3. Obtener historial de pedidos (tabla Pedidos)
      const historialPedidos = await this.obtenerHistorialPedidos(whatsapp, sheets);
      
      // 4. Obtener productos disponibles (tabla Inventario)
      const productosDisponibles = await this.obtenerProductosDisponibles(sheets);
      
      // 5. Obtener configuración del negocio (tabla Configuracion)
      const configuracionNegocio = await this.obtenerConfiguracionNegocio(sheets);
      
      // 6. Obtener últimas conversaciones (Firestore)
      const conversacionesRecientes = await this.obtenerConversacionesRecientes(
        whatsapp, 
        negocio.id, 
        firebaseService
      );
      
      // 7. Construir contexto enriquecido
      const contexto = this.construirContextoEnriquecido({
        datosCliente,
        preciosPersonalizados,
        historialPedidos,
        productosDisponibles,
        configuracionNegocio,
        conversacionesRecientes
      });
      
      console.log(`✅ Contexto construido: ${contexto.length} caracteres`);
      
      return contexto;
      
    } catch (error) {
      console.error('❌ Error obteniendo contexto del cliente:', error.message);
      // Si falla, devolver contexto mínimo (no romper el flujo)
      return '\n\n[Cliente nuevo - No hay historial disponible]';
    }
  }

  /**
   * 1. Obtener datos del cliente de la tabla Clientes
   * Columnas: id, whatsapp, nombre, telefono, direccion, fechaRegistro, 
   *           ultimaCompra, departamento, ciudad, empresa, notas
   */
  async obtenerDatosCliente(whatsapp, sheets) {
    try {
      const cliente = await sheets.buscarCliente(whatsapp);
      
      if (cliente) {
        console.log(`   ✓ Cliente encontrado: ${cliente.nombre || cliente.empresa || 'Sin nombre'}`);
      } else {
        console.log(`   ⚠ Cliente nuevo (no registrado)`);
      }
      
      return cliente;
    } catch (e) {
      console.log(`   ⚠ Error buscando cliente:`, e.message);
      return null;
    }
  }

  /**
   * 2. Obtener precios personalizados de la tabla PreciosClientes
   * Columnas: clienteId, codigoProducto, precioPersonalizado, fechaActualizacion, actualizadoPor
   */
  async obtenerPreciosPersonalizados(whatsapp, clienteId, sheets) {
    try {
      if (!clienteId) return {};
      
      const rows = await sheets.getRows('PreciosClientes!A:E');
      const precios = {};
      
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row[0] === clienteId && row[1] && row[2]) {
          const codigoProducto = row[1];
          const precio = parseFloat(row[2]) || 0;
          const fechaActualizacion = row[3] || '';
          
          precios[codigoProducto] = {
            precio,
            fechaActualizacion
          };
        }
      }
      
      const cantidadPrecios = Object.keys(precios).length;
      if (cantidadPrecios > 0) {
        console.log(`   ✓ Precios personalizados: ${cantidadPrecios} productos`);
      }
      
      return precios;
    } catch (e) {
      console.log(`   ⚠ Error obteniendo precios personalizados:`, e.message);
      return {};
    }
  }

  /**
   * 3. Obtener historial de pedidos de la tabla Pedidos
   * Devuelve los últimos 5 pedidos con toda la información
   */
  async obtenerHistorialPedidos(whatsapp, sheets) {
    try {
      const pedidos = await sheets.getPedidosByWhatsapp(whatsapp);
      
      // Ordenar por fecha (más recientes primero)
      const pedidosOrdenados = pedidos.sort((a, b) => {
        return this.compararFechas(b.fecha, a.fecha);
      });
      
      // Devolver solo los últimos 5
      const ultimos5 = pedidosOrdenados.slice(0, 5);
      
      if (ultimos5.length > 0) {
        console.log(`   ✓ Historial de pedidos: ${ultimos5.length} pedidos encontrados`);
      }
      
      return ultimos5;
    } catch (e) {
      console.log(`   ⚠ Error obteniendo pedidos:`, e.message);
      return [];
    }
  }

  /**
   * 4. Obtener productos disponibles del Inventario
   * Solo productos ACTIVOS con stock disponible
   */
  async obtenerProductosDisponibles(sheets) {
    try {
      const productos = await sheets.getProductos('ACTIVO');
      
      // Filtrar solo productos con stock disponible
      const disponibles = productos.filter(p => p.disponible > 0);
      
      console.log(`   ✓ Productos disponibles: ${disponibles.length} productos`);
      
      return disponibles;
    } catch (e) {
      console.log(`   ⚠ Error obteniendo inventario:`, e.message);
      return [];
    }
  }

  /**
   * 5. Obtener configuración del negocio (prompt personalizado, reglas, etc.)
   * Columnas: prompt_negocio, reglas_venta, tono, info_adicional, horario, departamento
   */
  async obtenerConfiguracionNegocio(sheets) {
    try {
      const config = await sheets.getConfiguracion();
      
      if (config && config.prompt_negocio) {
        console.log(`   ✓ Configuración del negocio cargada`);
      }
      
      return config || {};
    } catch (e) {
      console.log(`   ⚠ Error obteniendo configuración:`, e.message);
      return {};
    }
  }

  /**
   * 6. Obtener conversaciones recientes del cliente (Firestore)
   * Últimos 10 mensajes para recordar el contexto de la conversación
   */
  async obtenerConversacionesRecientes(whatsapp, negocioId, firebaseService) {
    try {
      if (!firebaseService || !firebaseService.initialized) {
        return [];
      }
      
      const mensajes = await firebaseService.getMensajes(
        negocioId, 
        whatsapp, 
        10 // Últimos 10 mensajes
      );
      
      if (mensajes && mensajes.length > 0) {
        console.log(`   ✓ Conversaciones recientes: ${mensajes.length} mensajes`);
      }
      
      return mensajes || [];
    } catch (e) {
      console.log(`   ⚠ Error obteniendo conversaciones:`, e.message);
      return [];
    }
  }

  /**
   * 7. Construir contexto enriquecido en formato legible para la IA
   */
  construirContextoEnriquecido(data) {
    const {
      datosCliente,
      preciosPersonalizados,
      historialPedidos,
      productosDisponibles,
      configuracionNegocio,
      conversacionesRecientes
    } = data;
    
    let contexto = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    contexto += '📋 CONTEXTO COMPLETO DEL CLIENTE (MEMORIA)\n';
    contexto += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    
    // ===== SECCIÓN 1: DATOS DEL CLIENTE =====
    if (datosCliente) {
      contexto += '\n👤 DATOS DEL CLIENTE:\n';
      contexto += `   • Nombre: ${datosCliente.nombre || 'No registrado'}\n`;
      if (datosCliente.empresa) {
        contexto += `   • Empresa: ${datosCliente.empresa}\n`;
      }
      if (datosCliente.telefono) {
        contexto += `   • Teléfono: ${datosCliente.telefono}\n`;
      }
      if (datosCliente.direccion) {
        contexto += `   • Dirección: ${datosCliente.direccion}\n`;
      }
      if (datosCliente.ciudad || datosCliente.departamento) {
        contexto += `   • Ubicación: ${datosCliente.ciudad || ''} ${datosCliente.departamento || ''}\n`;
      }
      if (datosCliente.fechaRegistro) {
        contexto += `   • Cliente desde: ${datosCliente.fechaRegistro}\n`;
      }
      if (datosCliente.notas) {
        contexto += `   • Notas: ${datosCliente.notas}\n`;
      }
    } else {
      contexto += '\n👤 CLIENTE NUEVO (sin datos registrados)\n';
    }
    
    // ===== SECCIÓN 2: HISTORIAL DE PEDIDOS =====
    if (historialPedidos && historialPedidos.length > 0) {
      contexto += '\n📦 HISTORIAL DE PEDIDOS (últimos 5):\n';
      
      historialPedidos.forEach((pedido, idx) => {
        const numero = idx + 1;
        contexto += `\n   ${numero}. Pedido ${pedido.id} - ${pedido.fecha}\n`;
        contexto += `      Productos: ${pedido.productos}\n`;
        contexto += `      Total: S/${pedido.total}\n`;
        contexto += `      Estado: ${pedido.estado}\n`;
        if (pedido.observaciones) {
          contexto += `      Obs: ${pedido.observaciones}\n`;
        }
      });
      
      // Análisis de preferencias
      contexto += '\n   💡 PREFERENCIAS DETECTADAS:\n';
      const productosMasComprados = this.analizarProductosFavoritos(historialPedidos);
      productosMasComprados.forEach(p => {
        contexto += `      • ${p.nombre} (comprado ${p.veces} veces)\n`;
      });
      
    } else {
      contexto += '\n📦 Sin pedidos anteriores (cliente nuevo)\n';
    }
    
    // ===== SECCIÓN 3: PRECIOS PERSONALIZADOS =====
    if (preciosPersonalizados && Object.keys(preciosPersonalizados).length > 0) {
      contexto += '\n💰 PRECIOS PERSONALIZADOS PARA ESTE CLIENTE:\n';
      
      for (const [codigo, info] of Object.entries(preciosPersonalizados)) {
        // Buscar nombre del producto
        const producto = productosDisponibles.find(p => p.codigo === codigo);
        const nombre = producto ? producto.nombre : codigo;
        
        contexto += `   • ${nombre}: S/${info.precio} (precio especial)\n`;
      }
      
      contexto += '\n   ⚠️ IMPORTANTE: Usa SIEMPRE estos precios personalizados para este cliente.\n';
    }
    
    // ===== SECCIÓN 4: CATÁLOGO DE PRODUCTOS =====
    if (productosDisponibles && productosDisponibles.length > 0) {
      contexto += '\n🛒 CATÁLOGO DE PRODUCTOS DISPONIBLES:\n';
      
      productosDisponibles.forEach(p => {
        // Verificar si tiene precio personalizado
        const precioPersonalizado = preciosPersonalizados[p.codigo];
        const precio = precioPersonalizado ? precioPersonalizado.precio : p.precio;
        const etiquetaPrecio = precioPersonalizado ? '(PRECIO ESPECIAL)' : '';
        
        contexto += `   • ${p.codigo}: ${p.nombre} - S/${precio} ${etiquetaPrecio}\n`;
        if (p.descripcion) {
          contexto += `     ${p.descripcion}\n`;
        }
        contexto += `     Stock: ${p.disponible} unidades\n`;
      });
    }
    
    // ===== SECCIÓN 5: CONVERSACIONES RECIENTES =====
    if (conversacionesRecientes && conversacionesRecientes.length > 0) {
      contexto += '\n💬 CONVERSACIÓN RECIENTE (últimos mensajes):\n';
      
      conversacionesRecientes.slice(-5).forEach(msg => {
        const rol = msg.origen === 'cliente' ? '👤 Cliente' : '🤖 Bot';
        const fecha = msg.timestamp ? this.formatearFechaHora(msg.timestamp) : '';
        contexto += `   ${rol} (${fecha}): "${msg.texto}"\n`;
      });
      
      contexto += '\n   💡 Usa este contexto para dar continuidad a la conversación.\n';
    }
    
    // ===== SECCIÓN 6: CONFIGURACIÓN DEL NEGOCIO =====
    if (configuracionNegocio && configuracionNegocio.prompt_negocio) {
      contexto += '\n🏪 INFORMACIÓN DEL NEGOCIO:\n';
      contexto += `${configuracionNegocio.prompt_negocio}\n`;
      
      if (configuracionNegocio.reglas_venta) {
        contexto += `\n📋 REGLAS DE VENTA:\n${configuracionNegocio.reglas_venta}\n`;
      }
      
      if (configuracionNegocio.info_adicional) {
        contexto += `\n📌 INFO ADICIONAL:\n${configuracionNegocio.info_adicional}\n`;
      }
      
      if (configuracionNegocio.horario) {
        contexto += `\n🕐 HORARIO: ${configuracionNegocio.horario}\n`;
      }
    }
    
    contexto += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    contexto += '⚠️ INSTRUCCIONES:\n';
    contexto += '• USA toda esta información para personalizar tus respuestas\n';
    contexto += '• Si el cliente ya compró algo, menciónalo naturalmente\n';
    contexto += '• Si tiene precios especiales, úsalos SIEMPRE\n';
    contexto += '• Si hay conversaciones previas, da continuidad\n';
    contexto += '• Sé natural, NO menciones que tienes "memoria" o "historial"\n';
    contexto += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    
    return contexto;
  }

  /**
   * Analizar productos más comprados del historial
   */
  analizarProductosFavoritos(pedidos) {
    const contadorProductos = {};
    
    pedidos.forEach(pedido => {
      const productosStr = pedido.productos || '';
      
      // Parsear productos (formato: "5x Cafe Blend - S/350.00")
      const match = productosStr.match(/\d+x\s+(.+?)\s+-\s+S\//);
      if (match) {
        const nombreProducto = match[1].trim();
        contadorProductos[nombreProducto] = (contadorProductos[nombreProducto] || 0) + 1;
      }
    });
    
    // Convertir a array y ordenar por frecuencia
    const productos = Object.entries(contadorProductos)
      .map(([nombre, veces]) => ({ nombre, veces }))
      .sort((a, b) => b.veces - a.veces)
      .slice(0, 3); // Top 3
    
    return productos;
  }

  /**
   * Comparar fechas en formato DD/MM/YYYY
   */
  compararFechas(fecha1, fecha2) {
    const f1 = this.parsearFecha(fecha1);
    const f2 = this.parsearFecha(fecha2);
    return f1 - f2;
  }

  /**
   * Parsear fecha en formato DD/MM/YYYY a Date
   */
  parsearFecha(fechaStr) {
    if (!fechaStr) return new Date(0);
    
    const partes = fechaStr.split('/');
    if (partes.length === 3) {
      const dia = parseInt(partes[0]);
      const mes = parseInt(partes[1]) - 1;
      const año = parseInt(partes[2]);
      return new Date(año, mes, dia);
    }
    
    return new Date(0);
  }

  /**
   * Formatear fecha/hora de timestamp
   */
  formatearFechaHora(timestamp) {
    if (!timestamp) return '';
    
    try {
      const fecha = timestamp instanceof Date ? timestamp : new Date(timestamp);
      const dia = String(fecha.getDate()).padStart(2, '0');
      const mes = String(fecha.getMonth() + 1).padStart(2, '0');
      const hora = String(fecha.getHours()).padStart(2, '0');
      const min = String(fecha.getMinutes()).padStart(2, '0');
      
      return `${dia}/${mes} ${hora}:${min}`;
    } catch (e) {
      return '';
    }
  }
}

module.exports = new ClienteContextService();
