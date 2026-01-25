/**
 * APARTALO CORE - Cliente Context Service (RAG - Memoria Simulada)
 * 
 * Servicio para construir contexto enriquecido del cliente usando:
 * - Inventario: Productos disponibles
 * - PreciosClientes: Precios personalizados por cliente
 * - Clientes: Datos completos del cliente
 * - Pedidos: Historial de compras
 * - Configuracion: Prompt personalizado del negocio
 * - Firestore: Últimas conversaciones
 * 
 * Esto permite que la IA "recuerde" al cliente sin necesidad de fine-tuning.
 */

class ClienteContextService {
  /**
   * Obtener contexto COMPLETO del cliente para enriquecer el prompt de la IA
   */
  async obtenerContextoCompleto(whatsapp, context) {
    const { sheets, negocio, firebaseService } = context;
    
    console.log(`🧠 Construyendo contexto completo para ${whatsapp}...`);
    
    try {
      // 1. Configuración del negocio (prompt personalizado)
      const configuracion = await this.obtenerConfiguracion(sheets);
      
      // 2. Datos completos del cliente
      const cliente = await this.obtenerDatosCliente(whatsapp, sheets);
      
      // 3. Productos con precios personalizados
      const productos = await this.obtenerProductosConPrecios(whatsapp, sheets);
      
      // 4. Historial de pedidos
      const pedidos = await this.obtenerHistorialPedidos(whatsapp, sheets);
      
      // 5. Últimas conversaciones
      const conversaciones = await this.obtenerUltimasConversaciones(
        whatsapp, 
        negocio.id, 
        firebaseService
      );
      
      // 6. Construir contexto enriquecido
      const contexto = this.construirContextoEnriquecido({
        configuracion,
        cliente,
        productos,
        pedidos,
        conversaciones,
        negocio
      });
      
      console.log(`✅ Contexto construido: ${contexto.length} caracteres`);
      
      return contexto;
      
    } catch (error) {
      console.error('❌ Error obteniendo contexto del cliente:', error.message);
      // Si falla, devolver contexto mínimo
      return this.construirContextoMinimo(negocio);
    }
  }

  /**
   * 1. Obtener configuración del negocio (hoja Configuracion)
   */
  async obtenerConfiguracion(sheets) {
    try {
      const config = await sheets.getConfiguracion();
      return {
        promptNegocio: config.prompt_negocio || '',
        reglasVenta: config.reglas_venta || '',
        tono: config.tono || 'amable y profesional',
        infoAdicional: config.info_adicional || '',
        horario: config.horario || '',
        departamento: config.departamento || 'Lima'
      };
    } catch (error) {
      console.log('⚠️ Error obteniendo configuración:', error.message);
      return {
        promptNegocio: '',
        reglasVenta: '',
        tono: 'amable y profesional',
        infoAdicional: '',
        horario: '',
        departamento: 'Lima'
      };
    }
  }

  /**
   * 2. Obtener datos completos del cliente (hoja Clientes)
   */
  async obtenerDatosCliente(whatsapp, sheets) {
    try {
      const cliente = await sheets.buscarCliente(whatsapp);
      
      if (!cliente) {
        return {
          esNuevo: true,
          whatsapp: whatsapp,
          nombre: 'No registrado',
          empresa: 'No registrado',
          direccion: 'No registrada',
          telefono: 'No registrado',
          departamento: 'No registrado',
          ciudad: 'No registrado',
          fechaRegistro: null,
          ultimaCompra: null,
          notas: ''
        };
      }
      
      return {
        esNuevo: false,
        whatsapp: cliente.whatsapp || whatsapp,
        nombre: cliente.nombre || 'No registrado',
        empresa: cliente.empresa || 'No registrado',
        direccion: cliente.direccion || 'No registrada',
        telefono: cliente.telefono || 'No registrado',
        departamento: cliente.departamento || 'No registrado',
        ciudad: cliente.ciudad || 'No registrado',
        fechaRegistro: cliente.fechaRegistro || null,
        ultimaCompra: cliente.ultimaCompra || null,
        notas: cliente.notas || ''
      };
    } catch (error) {
      console.log('⚠️ Error obteniendo datos del cliente:', error.message);
      return { esNuevo: true, whatsapp: whatsapp };
    }
  }

  /**
   * 3. Obtener productos CON precios personalizados (Inventario + PreciosClientes)
   */
  async obtenerProductosConPrecios(whatsapp, sheets) {
    try {
      // Usar el método que ya existe en sheets-service
      const productos = await sheets.getProductosConPrecios(whatsapp);
      
      return productos.map(p => ({
        codigo: p.codigo,
        nombre: p.nombre,
        descripcion: p.descripcion || '',
        precio: p.precio,
        precioOriginal: p.precioOriginal || p.precio,
        tieneDescuento: p.tieneDescuento || false,
        stock: p.disponible || 0,
        imagenUrl: p.imagenUrl || '',
        categoria: p.categoria || ''
      }));
    } catch (error) {
      console.log('⚠️ Error obteniendo productos:', error.message);
      
      // Fallback: obtener productos sin precios personalizados
      try {
        const productosBase = await sheets.getProductos('ACTIVO');
        return productosBase.map(p => ({
          codigo: p.codigo,
          nombre: p.nombre,
          descripcion: p.descripcion || '',
          precio: p.precio,
          stock: p.disponible || 0
        }));
      } catch (e) {
        return [];
      }
    }
  }

  /**
   * 4. Obtener historial de pedidos (hoja Pedidos)
   */
  async obtenerHistorialPedidos(whatsapp, sheets) {
    try {
      const pedidos = await sheets.getPedidosByWhatsapp(whatsapp);
      
      if (!pedidos || pedidos.length === 0) {
        return [];
      }
      
      // Ordenar por fecha (más recientes primero) y tomar últimos 5
      const pedidosOrdenados = pedidos
        .filter(p => p.id && p.fecha) // Solo pedidos válidos
        .sort((a, b) => {
          const fechaA = this.parsearFecha(a.fecha);
          const fechaB = this.parsearFecha(b.fecha);
          return fechaB - fechaA;
        })
        .slice(0, 5); // Últimos 5 pedidos
      
      return pedidosOrdenados.map(p => ({
        id: p.id,
        fecha: p.fecha,
        productos: this.extraerNombreProducto(p.productos),
        total: parseFloat(p.total) || 0,
        estado: p.estado || '',
        observaciones: p.observaciones || ''
      }));
    } catch (error) {
      console.log('⚠️ Error obteniendo pedidos:', error.message);
      return [];
    }
  }

  /**
   * 5. Obtener últimas conversaciones (Firestore)
   */
  async obtenerUltimasConversaciones(whatsapp, negocioId, firebaseService) {
    try {
      if (!firebaseService || !firebaseService.initialized) {
        return [];
      }
      
      const mensajes = await firebaseService.getMensajes(
        negocioId, 
        whatsapp, 
        8 // Últimos 8 mensajes (4 intercambios cliente-bot)
      );
      
      if (!mensajes || mensajes.length === 0) {
        return [];
      }
      
      // Formatear mensajes
      return mensajes.map(m => ({
        origen: m.origen || 'cliente',
        texto: m.texto || '',
        timestamp: m.timestamp
      }));
    } catch (error) {
      console.log('⚠️ Error obteniendo conversaciones:', error.message);
      return [];
    }
  }

  /**
   * 6. Construir contexto enriquecido en formato legible para la IA
   */
  construirContextoEnriquecido(datos) {
    const { configuracion, cliente, productos, pedidos, conversaciones, negocio } = datos;
    
    let contexto = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    contexto += '📊 CONTEXTO DEL CLIENTE (Memoria del Sistema)\n';
    contexto += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    
    // SECCIÓN 1: Información del cliente
    if (cliente.esNuevo) {
      contexto += '👤 CLIENTE NUEVO\n';
      contexto += '- Sin historial previo en el sistema\n';
      contexto += '- WhatsApp: ' + cliente.whatsapp + '\n\n';
    } else {
      contexto += '👤 INFORMACIÓN DEL CLIENTE\n';
      contexto += '- Nombre: ' + cliente.nombre + '\n';
      if (cliente.empresa !== 'No registrado') {
        contexto += '- Empresa: ' + cliente.empresa + '\n';
      }
      contexto += '- Dirección: ' + cliente.direccion + '\n';
      contexto += '- Teléfono: ' + cliente.telefono + '\n';
      if (cliente.departamento !== 'No registrado') {
        contexto += '- Ubicación: ' + cliente.ciudad + ', ' + cliente.departamento + '\n';
      }
      if (cliente.fechaRegistro) {
        contexto += '- Cliente desde: ' + cliente.fechaRegistro + '\n';
      }
      if (cliente.ultimaCompra) {
        contexto += '- Última compra: ' + cliente.ultimaCompra + '\n';
      }
      if (cliente.notas) {
        contexto += '- Notas importantes: ' + cliente.notas + '\n';
      }
      contexto += '\n';
    }
    
    // SECCIÓN 2: Historial de pedidos
    if (pedidos.length > 0) {
      contexto += '📦 HISTORIAL DE PEDIDOS (Últimos ' + pedidos.length + ')\n';
      pedidos.forEach((p, idx) => {
        contexto += `${idx + 1}. [${p.fecha}] ${p.productos} - S/${p.total.toFixed(2)} (${p.estado})`;
        if (p.observaciones) {
          contexto += ` - Nota: ${p.observaciones}`;
        }
        contexto += '\n';
      });
      
      // Análisis de preferencias
      const productosComprados = this.analizarPreferencias(pedidos);
      if (productosComprados.length > 0) {
        contexto += '\n💡 Productos que más compra:\n';
        productosComprados.slice(0, 3).forEach(p => {
          contexto += `   - ${p.nombre} (${p.veces} veces)\n`;
        });
      }
      contexto += '\n';
    } else {
      contexto += '📦 SIN PEDIDOS ANTERIORES\n';
      contexto += '- Este cliente no ha realizado compras previas\n\n';
    }
    
    // SECCIÓN 3: Productos disponibles CON precios personalizados
    if (productos.length > 0) {
      const tieneDescuentos = productos.some(p => p.tieneDescuento);
      
      contexto += '🛒 CATÁLOGO DE PRODUCTOS';
      if (tieneDescuentos) {
        contexto += ' (CON PRECIOS ESPECIALES PARA ESTE CLIENTE)';
      }
      contexto += '\n';
      
      productos.forEach(p => {
        contexto += `- ${p.codigo}: ${p.nombre}`;
        
        if (p.tieneDescuento) {
          contexto += ` - S/${p.precio} [PRECIO ESPECIAL, antes S/${p.precioOriginal}]`;
        } else {
          contexto += ` - S/${p.precio}`;
        }
        
        if (p.descripcion) {
          contexto += ` (${p.descripcion})`;
        }
        
        if (p.stock !== undefined) {
          contexto += ` | Stock: ${p.stock}`;
        }
        
        contexto += '\n';
      });
      contexto += '\n';
    }
    
    // SECCIÓN 4: Últimas conversaciones
    if (conversaciones.length > 0) {
      contexto += '💬 ÚLTIMAS CONVERSACIONES\n';
      conversaciones.forEach(conv => {
        const emoji = conv.origen === 'cliente' ? '👤' : '🤖';
        contexto += `${emoji} ${conv.origen}: "${conv.texto}"\n`;
      });
      contexto += '\n';
    }
    
    // SECCIÓN 5: Configuración del negocio
    if (configuracion.promptNegocio) {
      contexto += '🏪 INFORMACIÓN DEL NEGOCIO\n';
      contexto += configuracion.promptNegocio + '\n\n';
    }
    
    if (configuracion.reglasVenta) {
      contexto += '📋 REGLAS DE VENTA\n';
      contexto += configuracion.reglasVenta + '\n\n';
    }
    
    if (configuracion.infoAdicional) {
      contexto += '💡 INFORMACIÓN ADICIONAL\n';
      contexto += configuracion.infoAdicional + '\n\n';
    }
    
    contexto += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    contexto += 'IMPORTANTE: Usa esta información para personalizar tu respuesta.\n';
    contexto += 'Si el cliente ya tiene pedidos, menciona sus preferencias.\n';
    contexto += 'Si tiene precios especiales, menciónalo como beneficio.\n';
    contexto += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    
    return contexto;
  }

  /**
   * Analizar preferencias del cliente basado en pedidos
   */
  analizarPreferencias(pedidos) {
    const contador = {};
    
    pedidos.forEach(p => {
      const producto = this.extraerNombreProducto(p.productos);
      contador[producto] = (contador[producto] || 0) + 1;
    });
    
    return Object.entries(contador)
      .map(([nombre, veces]) => ({ nombre, veces }))
      .sort((a, b) => b.veces - a.veces);
  }

  /**
   * Extraer nombre simple de producto del formato "5x Cafe - S/350"
   */
  extraerNombreProducto(productosStr) {
    if (!productosStr) return 'Producto';
    
    try {
      // Formato: "5x Cafe Blend - S/350.00"
      const match = productosStr.match(/\d+x\s+(.+?)\s+-/);
      if (match) {
        return match[1].trim();
      }
      
      // Si no coincide, devolver primeros 30 caracteres
      return productosStr.substring(0, 30);
    } catch (e) {
      return 'Producto';
    }
  }

  /**
   * Parsear fecha en formato DD/MM/YYYY
   */
  parsearFecha(fechaStr) {
    if (!fechaStr) return new Date(0);
    
    try {
      const partes = fechaStr.split('/');
      if (partes.length === 3) {
        // DD/MM/YYYY
        return new Date(partes[2], partes[1] - 1, partes[0]);
      }
      return new Date(fechaStr);
    } catch (e) {
      return new Date(0);
    }
  }

  /**
   * Construir contexto mínimo si falla la carga completa
   */
  construirContextoMinimo(negocio) {
    return `\n\nCLIENTE NUEVO sin historial.\nNegocio: ${negocio.nombre}\n`;
  }
}

module.exports = new ClienteContextService();
