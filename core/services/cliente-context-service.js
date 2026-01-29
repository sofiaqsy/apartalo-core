/**
 * APARTALO CORE - Cliente Context Service (RAG - Memoria Simulada) v2.2
 * 
 * v2.2: Contexto temporal INTELIGENTE con estados de pedidos
 *       - Considera si hay pedidos ACTIVOS vs FINALIZADOS
 *       - Si hay pedido activo, mantiene contexto aunque pasen días
 *       - Si no hay pedido activo, trata como nueva conversación
 * 
 * OPTIMIZADO CON CACHÉ para evitar exceder límite de Google Sheets API
 * CACHÉ: 5 minutos en memoria para reducir lecturas a Sheets
 */

// Estados finalizados - pedidos que ya no están activos
const ESTADOS_FINALIZADOS = ['ENTREGADO', 'CANCELADO', 'COMPLETADO'];

class ClienteContextService {
  constructor() {
    this.cache = new Map();
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutos
  }

  /**
   * Obtener contexto COMPLETO del cliente con CACHÉ
   */
  async obtenerContextoCompleto(whatsapp, context) {
    const { sheets, negocio, firebaseService } = context;
    
    // Verificar caché primero
    const cacheKey = `${negocio.id}:${whatsapp}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
      console.log(`⚡ Usando contexto en caché para ${whatsapp} (${Math.round((Date.now() - cached.timestamp) / 1000)}s ago)`);
      return cached.contexto;
    }
    
    console.log(`🧠 Construyendo contexto completo para ${whatsapp}...`);
    
    try {
      const [configuracion, cliente, productos, pedidos] = await Promise.all([
        this.obtenerConfiguracion(sheets),
        this.obtenerDatosCliente(whatsapp, sheets),
        this.obtenerProductosConPrecios(whatsapp, sheets),
        this.obtenerHistorialPedidos(whatsapp, sheets)
      ]);
      
      const conversaciones = await this.obtenerUltimasConversaciones(
        whatsapp, 
        negocio.id, 
        firebaseService
      );
      
      // Construir contexto
      const contexto = this.construirContextoEnriquecido({
        configuracion,
        cliente,
        productos,
        pedidos,
        conversaciones,
        negocio
      });
      
      // Guardar en caché
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

  /**
   * Calcular días desde fecha
   */
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

  /**
   * Calcular horas desde último mensaje
   */
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

  /**
   * Identificar pedidos activos (no finalizados)
   */
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
        stock: p.disponible || 0,
        imagenUrl: p.imagenUrl || '',
        categoria: p.categoria || ''
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
        estado: p.estado || '',
        observaciones: p.observaciones || ''
      }));
    } catch (error) {
      console.log('⚠️ Error obteniendo pedidos:', error.message);
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
   * Construir contexto enriquecido CON INTELIGENCIA TEMPORAL
   */
  construirContextoEnriquecido(datos) {
    const { configuracion, cliente, productos, pedidos, conversaciones, negocio } = datos;
    
    // Calcular contexto temporal
    const horasDesdeUltimoMensaje = this.calcularHorasDesdeUltimoMensaje(conversaciones);
    const pedidosActivos = this.obtenerPedidosActivos(pedidos);
    const pedidoMasReciente = pedidos.length > 0 ? pedidos[0] : null;
    const diasDesdeUltimoPedido = pedidoMasReciente ? this.calcularDiasDesde(pedidoMasReciente.fecha) : 9999;
    
    let contexto = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    contexto += '📊 CONTEXTO DEL CLIENTE\n';
    contexto += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    
    // CONTEXTO TEMPORAL INTELIGENTE
    contexto += '⏰ CONTEXTO TEMPORAL\n';
    
    // Caso 1: Hay pedidos ACTIVOS (no finalizados)
    if (pedidosActivos.length > 0) {
      const pedidoActivo = pedidosActivos[0];
      const diasDesde = this.calcularDiasDesde(pedidoActivo.fecha);
      
      contexto += `- ⚠️ PEDIDO ACTIVO: ${pedidoActivo.productos} (${pedidoActivo.estado})\n`;
      contexto += `- Pedido creado hace ${diasDesde} día(s)\n`;
      contexto += '- INSTRUCCIÓN: Cliente puede estar preguntando por su pedido activo\n';
      contexto += '- Si pregunta vagamente ("Hola", "¿Cómo va?"), menciona su pedido activo\n';
      contexto += '- Si pregunta por otro producto, ayúdale con el nuevo pedido\n\n';
      
    } else {
      // Caso 2: NO hay pedidos activos - usar lógica temporal normal
      if (horasDesdeUltimoMensaje < 1) {
        contexto += '- Última interacción: AHORA (misma sesión)\n';
        contexto += '- INSTRUCCIÓN: Continúa conversación actual\n\n';
      } else if (horasDesdeUltimoMensaje < 24) {
        contexto += `- Última interacción: Hace ${horasDesdeUltimoMensaje} hora(s)\n`;
        contexto += '- INSTRUCCIÓN: Saluda brevemente, puede haber continuidad\n\n';
      } else {
        const dias = Math.floor(horasDesdeUltimoMensaje / 24);
        contexto += `- Última interacción: Hace ${dias} día(s)\n`;
        
        if (pedidoMasReciente && diasDesdeUltimoPedido < 30) {
          contexto += `- Último pedido (FINALIZADO): Hace ${diasDesdeUltimoPedido} día(s)\n`;
          if (diasDesdeUltimoPedido <= 7) {
            contexto += '- INSTRUCCIÓN: Pregunta si quedó satisfecho, puede querer repetir\n\n';
          } else {
            contexto += '- INSTRUCCIÓN: Mucho tiempo pasó, NO asumas que quiere repetir\n\n';
          }
        } else {
          contexto += '- INSTRUCCIÓN: Trata como NUEVA conversación\n\n';
        }
      }
    }
    
    // Información del cliente
    if (!cliente.esNuevo) {
      contexto += '👤 CLIENTE REGISTRADO\n';
      contexto += '- Nombre: ' + cliente.nombre + '\n';
      if (cliente.direccion !== 'No registrada') {
        contexto += '- Dirección guardada: ' + cliente.direccion + '\n';
      }
      contexto += '\n';
    }
    
    // Historial de pedidos (separando activos de finalizados)
    if (pedidos.length > 0) {
      if (pedidosActivos.length > 0) {
        contexto += '📦 PEDIDOS ACTIVOS\n';
        pedidosActivos.forEach(p => {
          const diasDesde = this.calcularDiasDesde(p.fecha);
          contexto += `- ${p.productos} (${p.estado}, hace ${diasDesde} días) - S/${p.total.toFixed(2)}\n`;
        });
        contexto += '\n';
      }
      
      const pedidosFinalizados = pedidos.filter(p => ESTADOS_FINALIZADOS.includes(p.estado));
      if (pedidosFinalizados.length > 0) {
        contexto += '📜 HISTORIAL (Pedidos completados)\n';
        pedidosFinalizados.slice(0, 3).forEach(p => {
          const diasDesde = this.calcularDiasDesde(p.fecha);
          contexto += `- ${p.productos} (hace ${diasDesde} días)\n`;
        });
        contexto += '\n';
      }
    }
    
    // Catálogo de productos
    if (productos.length > 0) {
      contexto += '🛒 CATÁLOGO\n';
      productos.forEach(p => {
        contexto += `- ${p.codigo}: ${p.nombre} - S/${p.precio}`;
        if (p.tieneDescuento) {
          contexto += ' [ESPECIAL]';
        }
        contexto += '\n';
      });
      contexto += '\n';
    }
    
    // Configuración del negocio
    if (configuracion.promptNegocio) {
      contexto += '🏪 INFO DEL NEGOCIO\n';
      contexto += configuracion.promptNegocio + '\n\n';
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
