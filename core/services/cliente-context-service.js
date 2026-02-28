/**
 * APARTALO CORE - Cliente Context Service (RAG) v2.5
 * v2.5: Filtrar productos sin precio del catalogo, mostrar unidad claramente
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
        this.obtenerMetodosPago(sheets)
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
        metodosPago,
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
      return Math.floor(diffMs / (1000 * 60 * 60 * 24));
    } catch (e) {
      return 999;
    }
  }

  calcularHorasDesdeUltimoMensaje(conversaciones) {
    if (!conversaciones || conversaciones.length === 0) return 9999;
    try {
      const ultimoMensaje = conversaciones[0];
      if (ultimoMensaje.timestamp) {
        const diffMs = Date.now() - ultimoMensaje.timestamp;
        return Math.floor(diffMs / (1000 * 60 * 60));
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
    if (eliminados > 0) console.log(`Caché limpiado: ${eliminados} entradas expiradas`);
  }

  invalidarCache(negocioId, whatsapp) {
    const cacheKey = `${negocioId}:${whatsapp}`;
    this.cache.delete(cacheKey);
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
      console.log('Error obteniendo configuración:', error.message);
      return { promptNegocio: '', reglasVenta: '', tono: 'amable y profesional', infoAdicional: '', horario: '', departamento: 'Lima' };
    }
  }

  async obtenerDatosCliente(whatsapp, sheets) {
    try {
      const cliente = await sheets.buscarCliente(whatsapp);
      if (!cliente) {
        return { esNuevo: true, whatsapp, nombre: 'No registrado', direccion: 'No registrada', telefono: 'No registrado' };
      }
      return {
        esNuevo: false,
        whatsapp: cliente.whatsapp || whatsapp,
        nombre: cliente.nombre || 'No registrado',
        direccion: cliente.direccion || 'No registrada',
        telefono: cliente.telefono || 'No registrado'
      };
    } catch (error) {
      console.log('Error obteniendo datos del cliente:', error.message);
      return { esNuevo: true, whatsapp };
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
      console.log('Error obteniendo productos:', error.message);
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
      if (!pedidos || pedidos.length === 0) return [];
      
      return pedidos
        .filter(p => p.id && p.fecha)
        .sort((a, b) => this.parsearFecha(b.fecha) - this.parsearFecha(a.fecha))
        .slice(0, 5)
        .map(p => ({
          id: p.id,
          fecha: p.fecha,
          productos: this.extraerNombreProducto(p.productos),
          total: parseFloat(p.total) || 0,
          estado: p.estado || ''
        }));
    } catch (error) {
      console.log('Error obteniendo pedidos:', error.message);
      return [];
    }
  }

  async obtenerMetodosPago(sheets) {
    try {
      return await sheets.getMetodosPago() || [];
    } catch (error) {
      console.log('Error obteniendo métodos de pago:', error.message);
      return [];
    }
  }

  async obtenerUltimasConversaciones(whatsapp, negocioId, firebaseService) {
    try {
      if (!firebaseService || !firebaseService.initialized) return [];
      const mensajes = await firebaseService.getMensajes(negocioId, whatsapp, 8);
      if (!mensajes || mensajes.length === 0) return [];
      return mensajes.map(m => ({
        origen: m.origen || 'cliente',
        texto: m.texto || '',
        timestamp: m.timestamp
      }));
    } catch (error) {
      console.log('Error obteniendo conversaciones:', error.message);
      return [];
    }
  }

  construirContextoEnriquecido(datos) {
    const { configuracion, cliente, productos, pedidos, conversaciones, metodosPago, negocio } = datos;
    
    const horasDesdeUltimoMensaje = this.calcularHorasDesdeUltimoMensaje(conversaciones);
    const pedidosActivos = this.obtenerPedidosActivos(pedidos);
    const pedidoMasReciente = pedidos.length > 0 ? pedidos[0] : null;
    
    let contexto = '\n';

    // Reglas de venta y configuracion del negocio
    if (configuracion.reglasVenta) {
      contexto += 'REGLAS DE VENTA:\n' + configuracion.reglasVenta + '\n\n';
    }
    if (configuracion.infoAdicional) {
      contexto += configuracion.infoAdicional + '\n\n';
    }

    // Metodos de pago
    if (metodosPago && metodosPago.length > 0) {
      contexto += 'METODOS DE PAGO:\n';
      metodosPago.forEach(m => {
        if (m.tipo === 'yape' || m.tipo === 'plin') {
          contexto += `- ${m.tipo.toUpperCase()}: ${m.numero}`;
          if (m.titular) contexto += ` (${m.titular})`;
          contexto += '\n';
        } else {
          contexto += `- ${m.tipo.toUpperCase()}`;
          if (m.cuenta) contexto += ` Cuenta: ${m.cuenta}`;
          if (m.cci) contexto += ` CCI: ${m.cci}`;
          if (m.titular) contexto += ` (${m.titular})`;
          contexto += '\n';
        }
      });
      contexto += '\n';
    }

    // Catalogo — SOLO productos con precio valido
    const productosValidos = productos.filter(p => p.precio && p.precio > 0);
    if (productosValidos.length > 0) {
      contexto += 'CATALOGO (usa SOLO estos productos, con EXACTAMENTE estos precios):\n';
      productosValidos.forEach(p => {
        contexto += `- [${p.codigo}] ${p.nombre}`;
        if (p.descripcion) contexto += ` | ${p.descripcion}`;
        contexto += ` | S/${p.precio} por unidad`;
        if (p.tieneDescuento) contexto += ' [PRECIO ESPECIAL PARA ESTE CLIENTE]';
        contexto += '\n';
      });
      contexto += 'IMPORTANTE: No uses ni menciones productos que no aparezcan en esta lista.\n\n';
    }

    // Contexto temporal
    if (pedidosActivos.length > 0) {
      const pedidoActivo = pedidosActivos[0];
      const diasDesde = this.calcularDiasDesde(pedidoActivo.fecha);
      contexto += `PEDIDO ACTIVO: ${pedidoActivo.productos} (${pedidoActivo.estado}, hace ${diasDesde} dias)\n\n`;
    } else {
      if (horasDesdeUltimoMensaje < 1) {
        contexto += 'Ultima interaccion: AHORA\n\n';
      } else if (horasDesdeUltimoMensaje < 24) {
        contexto += `Ultima interaccion: Hace ${horasDesdeUltimoMensaje} horas\n\n`;
      } else {
        const dias = Math.floor(horasDesdeUltimoMensaje / 24);
        contexto += `Ultima interaccion: Hace ${dias} dias\n\n`;
      }
    }

    // Datos del cliente
    if (!cliente.esNuevo) {
      contexto += `CLIENTE: ${cliente.nombre}\n`;
      if (cliente.direccion !== 'No registrada') contexto += `Direccion guardada: ${cliente.direccion}\n`;
      contexto += '\n';
    }

    // Historial de pedidos
    if (pedidos.length > 0) {
      const pedidosFinalizados = pedidos.filter(p => ESTADOS_FINALIZADOS.includes(p.estado));
      if (pedidosFinalizados.length > 0) {
        contexto += 'PEDIDOS ANTERIORES: ';
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
      if (match) return match[1].trim();
      return productosStr.substring(0, 30);
    } catch (e) {
      return 'Producto';
    }
  }

  parsearFecha(fechaStr) {
    if (!fechaStr) return new Date(0);
    try {
      const partes = fechaStr.split('/');
      if (partes.length === 3) return new Date(partes[2], partes[1] - 1, partes[0]);
      return new Date(fechaStr);
    } catch (e) {
      return new Date(0);
    }
  }

  construirContextoMinimo(negocio) {
    return `\nCLIENTE NUEVO.\nNegocio: ${negocio.nombre}\n`;
  }
}

const instance = new ClienteContextService();
setInterval(() => instance.limpiarCacheExpirado(), 10 * 60 * 1000);

module.exports = instance;
