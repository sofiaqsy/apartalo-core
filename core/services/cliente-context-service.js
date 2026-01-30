/**
 * APARTALO CORE - Cliente Context Service (RAG - Memoria Simulada) v2.4
 * 
 * v2.4: ADD PAYMENT METHODS to context so AI can answer payment questions
 */

const ESTADOS_FINALIZADOS = ['ENTREGADO', 'CANCELADO', 'COMPLETADO'];

class ClienteContextService {
  constructor() {
    this.cache = new Map();
    this.CACHE_TTL = 5 * 60 * 1000;
  }

  async obtenerContextoCompleto(whatsapp, context) {
    const { sheets, negocio, firebaseService } = context;
    
    const cacheKey = `${negocio.id}:${whatsapp}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
      console.log(`⚡ Usando contexto en caché para ${whatsapp} (${Math.round((Date.now() - cached.timestamp) / 1000)}s ago)`);
      return cached.contexto;
    }
    
    console.log(`🧠 Construyendo contexto completo para ${whatsapp}...`);
    
    try {
      const [configuracion, cliente, productos, pedidos, metodosPago] = await Promise.all([
        this.obtenerConfiguracion(sheets),
        this.obtenerDatosCliente(whatsapp, sheets),
        this.obtenerProductosConPrecios(whatsapp, sheets),
        this.obtenerHistorialPedidos(whatsapp, sheets),
        this.obtenerMetodosPago(sheets) // NEW: Fetch payment methods
      ]);
      
      const conversaciones = await this.obtenerUltimasConversaciones(
        whatsapp, 
        negocio.id, 
        firebaseService
      );
      
      const contexto = this.construirContextoEnriquecido({
        configuracion,
        cliente,
        productos,
        pedidos,
        conversaciones,
        metodosPago, // NEW: Include in context
        negocio
      });
      
      this.cache.set(cacheKey, {
        contexto,
        timestamp: Date.now()
      });
      
      console.log(`✅ Contexto construido y cacheado: ${contexto.length} caracteres`);
      
      return contexto;
      
    } catch (error) {
      console.error('❌ Error obteniendo contexto del cliente:', error.message);
      return this.construirContextoMinimo(negocio);
    }
  }

  calcularDiasDesde(fechaStr) {
    try {
      const fecha = this.parsearFecha(fechaStr);
      const ahora = new Date();
      const diffMs = ahora - fecha;
      const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      return diffDias;
    } catch (e) {
      return 999;
    }
  }

  calcularHorasDesdeUltimoMensaje(conversaciones) {
    if (!conversaciones || conversaciones.length === 0) {
      return 9999;
    }

    try {
      const ultimoMensaje = conversaciones[0];
      if (ultimoMensaje.timestamp) {
        const ahora = Date.now();
        const diffMs = ahora - ultimoMensaje.timestamp;
        const diffHoras = diffMs / (1000 * 60 * 60);
        return Math.floor(diffHoras);
      }
    } catch (e) {}
    
    return 9999;
  }

  obtenerPedidosActivos(pedidos) {
    return pedidos.filter(p => !ESTADOS_FINALIZADOS.includes(p.estado));
  }

  limpiarCacheExpirado() {
    const ahora = Date.now();
    let eliminados = 0;
    
    for (const [key, value] of this.cache.entries()) {
      if ((ahora - value.timestamp) >= this.CACHE_TTL) {
        this.cache.delete(key);
        eliminados++;
      }
    }
    
    if (eliminados > 0) {
      console.log(`🧹 Caché limpiado: ${eliminados} entradas expiradas`);
    }
  }

  invalidarCache(negocioId, whatsapp) {
    const cacheKey = `${negocioId}:${whatsapp}`;
    const existia = this.cache.has(cacheKey);
    this.cache.delete(cacheKey);
    
    if (existia) {
      console.log(`🗑️ Caché invalidado para ${whatsapp}`);
    }
  }

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

  async obtenerDatosCliente(whatsapp, sheets) {
    try {
      const cliente = await sheets.buscarCliente(whatsapp);
      
      if (!cliente) {
        return {
          esNuevo: true,
          whatsapp: whatsapp,
          nombre: 'No registrado',
          direccion: 'No registrada',
          telefono: 'No registrado'
        };
      }
      
      return {
        esNuevo: false,
        whatsapp: cliente.whatsapp || whatsapp,
        nombre: cliente.nombre || 'No registrado',
        direccion: cliente.direccion || 'No registrada',
        telefono: cliente.telefono || 'No registrado'
      };
    } catch (error) {
      console.log('⚠️ Error obteniendo datos del cliente:', error.message);
      return { esNuevo: true, whatsapp: whatsapp };
    }
  }

  async obtenerProductosConPrecios(whatsapp, sheets) {
    try {
      const productos = await sheets.getProductosConPrecios(whatsapp);
      
      return productos.map(p => ({
        codigo: p.codigo,
        nombre: p.nombre,
        descripcion: p.descripcion || '',
        precio: p.precio,
        precioOriginal: p.precioOriginal || p.precio,
        tieneDescuento: p.tieneDescuento || false,
        stock: p.disponible || 0
      }));
    } catch (error) {
      console.log('⚠️ Error obteniendo productos:', error.message);
      
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

  async obtenerHistorialPedidos(whatsapp, sheets) {
    try {
      const pedidos = await sheets.getPedidosByWhatsapp(whatsapp);
      
      if (!pedidos || pedidos.length === 0) {
        return [];
      }
      
      const pedidosOrdenados = pedidos
        .filter(p => p.id && p.fecha)
        .sort((a, b) => {
          const fechaA = this.parsearFecha(a.fecha);
          const fechaB = this.parsearFecha(b.fecha);
          return fechaB - fechaA;
        })
        .slice(0, 5);
      
      return pedidosOrdenados.map(p => ({
        id: p.id,
        fecha: p.fecha,
        productos: this.extraerNombreProducto(p.productos),
        total: parseFloat(p.total) || 0,
        estado: p.estado || ''
      }));
    } catch (error) {
      console.log('⚠️ Error obteniendo pedidos:', error.message);
      return [];
    }
  }

  /**
   * NEW: Fetch payment methods from MetodosPago sheet
   */
  async obtenerMetodosPago(sheets) {
    try {
      const metodos = await sheets.getMetodosPago();
      return metodos || [];
    } catch (error) {
      console.log('⚠️ Error obteniendo métodos de pago:', error.message);
      return [];
    }
  }

  async obtenerUltimasConversaciones(whatsapp, negocioId, firebaseService) {
    try {
      if (!firebaseService || !firebaseService.initialized) {
        return [];
      }
      
      const mensajes = await firebaseService.getMensajes(negocioId, whatsapp, 8);
      
      if (!mensajes || mensajes.length === 0) {
        return [];
      }
      
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
   * Build enriched context - SALES RULES FIRST + PAYMENT METHODS
   */
  construirContextoEnriquecido(datos) {
    const { configuracion, cliente, productos, pedidos, conversaciones, metodosPago, negocio } = datos;
    
    const horasDesdeUltimoMensaje = this.calcularHorasDesdeUltimoMensaje(conversaciones);
    const pedidosActivos = this.obtenerPedidosActivos(pedidos);
    const pedidoMasReciente = pedidos.length > 0 ? pedidos[0] : null;
    const diasDesdeUltimoPedido = pedidoMasReciente ? this.calcularDiasDesde(pedidoMasReciente.fecha) : 9999;
    
    let contexto = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    contexto += '📋 REGLAS DE VENTA (LEE ESTO PRIMERO)\n';
    contexto += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    
    // CRITICAL SECTION: SALES RULES
    if (configuracion.reglasVenta) {
      contexto += configuracion.reglasVenta + '\n\n';
    }
    
    if (configuracion.infoAdicional) {
      contexto += configuracion.infoAdicional + '\n\n';
    }
    
    // NEW: PAYMENT METHODS
    if (metodosPago && metodosPago.length > 0) {
      contexto += '💳 MÉTODOS DE PAGO DISPONIBLES\n';
      metodosPago.forEach(m => {
        if (m.tipo === 'yape' || m.tipo === 'plin') {
          contexto += `- ${m.tipo.toUpperCase()}: ${m.numero}\n`;
          if (m.titular) contexto += `  Titular: ${m.titular}\n`;
        } else if (m.tipo === 'bcp' || m.tipo === 'banco') {
          contexto += `- TRANSFERENCIA BANCARIA\n`;
          if (m.cuenta) contexto += `  Cuenta: ${m.cuenta}\n`;
          if (m.cci) contexto += `  CCI: ${m.cci}\n`;
          if (m.titular) contexto += `  Titular: ${m.titular}\n`;
        } else {
          contexto += `- ${m.tipo.toUpperCase()}\n`;
          if (m.numero) contexto += `  ${m.numero}\n`;
          if (m.cuenta) contexto += `  Cuenta: ${m.cuenta}\n`;
          if (m.titular) contexto += `  Titular: ${m.titular}\n`;
        }
      });
      contexto += '\n';
    }
    
    // Product catalog
    if (productos.length > 0) {
      contexto += '🛒 CATÁLOGO DISPONIBLE\n';
      productos.forEach(p => {
        contexto += `- ${p.codigo}: ${p.nombre}`;
        if (p.descripcion) {
          contexto += ` (${p.descripcion})`;
        }
        contexto += ` - S/${p.precio}`;
        if (p.tieneDescuento) {
          contexto += ' [PRECIO ESPECIAL]';
        }
        contexto += '\n';
      });
      contexto += '\n';
    }
    
    // TEMPORAL CONTEXT
    contexto += '⏰ CONTEXTO TEMPORAL\n';
    
    if (pedidosActivos.length > 0) {
      const pedidoActivo = pedidosActivos[0];
      const diasDesde = this.calcularDiasDesde(pedidoActivo.fecha);
      
      contexto += `- PEDIDO ACTIVO: ${pedidoActivo.productos} (${pedidoActivo.estado}, hace ${diasDesde} días)\n`;
      contexto += '- Cliente puede estar preguntando por su pedido activo\n\n';
      
    } else {
      if (horasDesdeUltimoMensaje < 1) {
        contexto += '- Última interacción: AHORA (continúa conversación)\n\n';
      } else if (horasDesdeUltimoMensaje < 24) {
        contexto += `- Última interacción: Hace ${horasDesdeUltimoMensaje} horas\n\n`;
      } else {
        const dias = Math.floor(horasDesdeUltimoMensaje / 24);
        contexto += `- Última interacción: Hace ${dias} días (trata como nueva conversación)\n\n`;
      }
    }
    
    // Customer info
    if (!cliente.esNuevo) {
      contexto += '👤 CLIENTE: ' + cliente.nombre + '\n';
      if (cliente.direccion !== 'No registrada') {
        contexto += '- Dirección guardada: ' + cliente.direccion + '\n';
      }
      contexto += '\n';
    }
    
    // Order history summary
    if (pedidos.length > 0) {
      const pedidosFinalizados = pedidos.filter(p => ESTADOS_FINALIZADOS.includes(p.estado));
      if (pedidosFinalizados.length > 0) {
        contexto += '📜 PEDIDOS ANTERIORES: ';
        contexto += pedidosFinalizados.slice(0, 2).map(p => p.productos).join(', ');
        contexto += '\n\n';
      }
    }
    
    return contexto;
  }

  extraerNombreProducto(productosStr) {
    if (!productosStr) return 'Producto';
    
    try {
      const match = productosStr.match(/\d+x\s+(.+?)\s+-/);
      if (match) {
        return match[1].trim();
      }
      
      return productosStr.substring(0, 30);
    } catch (e) {
      return 'Producto';
    }
  }

  parsearFecha(fechaStr) {
    if (!fechaStr) return new Date(0);
    
    try {
      const partes = fechaStr.split('/');
      if (partes.length === 3) {
        return new Date(partes[2], partes[1] - 1, partes[0]);
      }
      return new Date(fechaStr);
    } catch (e) {
      return new Date(0);
    }
  }

  construirContextoMinimo(negocio) {
    return `\n\nCLIENTE NUEVO.\nNegocio: ${negocio.nombre}\n`;
  }
}

const instance = new ClienteContextService();
setInterval(() => instance.limpiarCacheExpirado(), 10 * 60 * 1000);

module.exports = instance;
