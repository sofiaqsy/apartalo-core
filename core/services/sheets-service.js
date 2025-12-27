/**
 * APARTALO CORE - Sheets Service
 * 
 * Servicio unificado para Google Sheets
 * Cada negocio tiene su propio spreadsheet
 * 
 * USO:
 *   const sheets = new SheetsService(negocio.spreadsheetId);
 *   await sheets.initialize();
 *   const pedidos = await sheets.getPedidos();
 */

const { google } = require('googleapis');
const config = require('../../config');

class SheetsService {
  /**
   * @param {string} spreadsheetId - ID del spreadsheet del negocio
   */
  constructor(spreadsheetId) {
    this.spreadsheetId = spreadsheetId;
    this.sheets = null;
    this.auth = null;
    this.initialized = false;
  }

  /**
   * Inicializar conexión con Google Sheets
   */
  async initialize() {
    try {
      if (!config.google.serviceAccountKey) {
        console.log('⚠️ Google Sheets no configurado');
        return false;
      }

      const credentials = JSON.parse(config.google.serviceAccountKey);

      this.auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });

      this.sheets = google.sheets({ version: 'v4', auth: this.auth });
      this.initialized = true;

      console.log(`✅ SheetsService inicializado para ${this.spreadsheetId}`);
      return true;
    } catch (error) {
      console.error('❌ Error inicializando Sheets:', error.message);
      return false;
    }
  }

  // ============================================
  // OPERACIONES GENÉRICAS
  // ============================================

  /**
   * Obtener filas de un rango
   */
  async getRows(spreadsheetId, range) {
    if (!this.initialized) return [];

    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId || this.spreadsheetId,
        range
      });
      return response.data.values || [];
    } catch (error) {
      console.error(`❌ Error leyendo ${range}:`, error.message);
      return [];
    }
  }

  /**
   * Formatear valor para Google Sheets
   * Asegura que los números se envíen correctamente con decimales
   */
  formatValueForSheets(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') {
      // Forzar formato con punto decimal para números
      return value;
    }
    return value;
  }

  /**
   * Agregar fila al final de una hoja
   * IMPORTANTE: Usa rango A1 para asegurar que siempre empiece desde columna A
   */
  async appendRow(sheetName, values) {
    if (!this.initialized) return false;

    try {
      // Formatear todos los valores
      const formattedValues = values.map(v => this.formatValueForSheets(v));
      
      // Usar rango A1 notation específico para forzar inserción desde columna A
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'RAW', // Cambiado a RAW para preservar números exactos
        insertDataOption: 'INSERT_ROWS',
        resource: { values: [formattedValues] }
      });
      console.log(`✅ Fila agregada a ${sheetName} con ${values.length} columnas`);
      return true;
    } catch (error) {
      console.error(`❌ Error agregando fila a ${sheetName}:`, error.message);
      return false;
    }
  }

  /**
   * Actualizar celda específica
   */
  async updateCell(range, value) {
    if (!this.initialized) return false;

    try {
      const formattedValue = this.formatValueForSheets(value);
      
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: 'RAW', // Cambiado a RAW para preservar números exactos
        resource: { values: [[formattedValue]] }
      });
      return true;
    } catch (error) {
      console.error(`❌ Error actualizando ${range}:`, error.message);
      return false;
    }
  }

  /**
   * Actualizar múltiples celdas
   */
  async batchUpdate(updates) {
    if (!this.initialized) return false;

    try {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        resource: {
          data: updates.map(u => ({
            range: u.range,
            values: [[this.formatValueForSheets(u.value)]]
          })),
          valueInputOption: 'RAW' // Cambiado a RAW para preservar números exactos
        }
      });
      return true;
    } catch (error) {
      console.error('❌ Error en batch update:', error.message);
      return false;
    }
  }

  // ============================================
  // CLIENTES
  // ============================================

  /**
   * Buscar cliente por WhatsApp
   * Estructura esperada: ID, WhatsApp, Nombre, Telefono, Direccion, FechaRegistro, UltimaCompra, Departamento, Ciudad
   */
  async buscarCliente(whatsapp) {
    const rows = await this.getRows(this.spreadsheetId, 'Clientes!A:I');
    if (rows.length <= 1) return null;

    const numeroLimpio = this.cleanPhone(whatsapp);

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const clienteWhatsapp = this.cleanPhone(row[1] || '');

      if (clienteWhatsapp === numeroLimpio) {
        return {
          id: row[0] || '',
          whatsapp: row[1] || '',
          nombre: row[2] || '',
          telefono: row[3] || '',
          direccion: row[4] || '',
          fechaRegistro: row[5] || '',
          ultimaCompra: row[6] || '',
          departamento: row[7] || '',
          ciudad: row[8] || '',
          rowIndex: i + 1
        };
      }
    }

    return null;
  }

  /**
   * Crear o actualizar cliente
   */
  async upsertCliente(datosCliente) {
    const clienteExistente = await this.buscarCliente(datosCliente.whatsapp);

    if (clienteExistente) {
      // Actualizar última compra
      await this.updateCell(
        `Clientes!G${clienteExistente.rowIndex}`,
        new Date().toLocaleDateString('es-PE')
      );
      return { ...clienteExistente, updated: true };
    }

    // Crear nuevo
    const nuevoId = `CLI-${Date.now().toString().slice(-6)}`;
    const valores = [
      nuevoId,
      this.cleanPhone(datosCliente.whatsapp),
      datosCliente.nombre || '',
      datosCliente.telefono || '',
      datosCliente.direccion || '',
      new Date().toLocaleDateString('es-PE'),
      new Date().toLocaleDateString('es-PE'),
      datosCliente.departamento || '',
      datosCliente.ciudad || ''
    ];

    await this.appendRow('Clientes', valores);
    return { id: nuevoId, ...datosCliente, created: true };
  }

  // ============================================
  // PEDIDOS
  // ============================================

  /**
   * Obtener pedidos de un cliente por WhatsApp
   */
  async getPedidosByWhatsapp(whatsapp) {
    const rows = await this.getRows(this.spreadsheetId, 'Pedidos!A:S');
    if (rows.length <= 1) return [];

    const numeroLimpio = this.cleanPhone(whatsapp);
    const pedidos = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const pedidoWhatsapp = this.cleanPhone(row[3] || ''); // Columna D = WhatsApp

      if (pedidoWhatsapp === numeroLimpio) {
        pedidos.push(this.parsePedidoRow(row, i + 1));
      }
    }

    return pedidos;
  }

  /**
   * Obtener pedido por ID
   */
  async getPedidoById(pedidoId) {
    const rows = await this.getRows(this.spreadsheetId, 'Pedidos!A:S');
    
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        return this.parsePedidoRow(rows[i], i + 1);
      }
    }

    return null;
  }

  /**
   * Crear pedido
   * Estructura: A-S (19 columnas)
   */
  async crearPedido(datosPedido) {
    const pedidoId = datosPedido.id || `PED-${Date.now().toString().slice(-6)}`;
    const ahora = new Date();

    const valores = [
      pedidoId,                                    // A: ID
      ahora.toLocaleDateString('es-PE'),           // B: Fecha
      ahora.toLocaleTimeString('es-PE'),           // C: Hora
      this.cleanPhone(datosPedido.whatsapp),       // D: WhatsApp
      datosPedido.cliente || '',                   // E: Cliente
      datosPedido.telefono || '',                  // F: Teléfono
      datosPedido.direccion || '',                 // G: Dirección
      datosPedido.productos || '',                 // H: Productos (JSON o texto)
      parseFloat(datosPedido.total) || 0,          // I: Total (asegurar número)
      datosPedido.estado || config.orderStates.PENDING_PAYMENT, // J: Estado
      '',                                          // K: VoucherURLs
      datosPedido.observaciones || '',             // L: Observaciones
      datosPedido.departamento || '',              // M: Departamento
      datosPedido.ciudad || '',                    // N: Ciudad
      datosPedido.tipoEnvio || '',                 // O: TipoEnvio
      datosPedido.metodoEnvio || '',               // P: MetodoEnvio
      datosPedido.detalleEnvio || '',              // Q: DetalleEnvio
      parseFloat(datosPedido.costoEnvio) || 0,     // R: CostoEnvio (asegurar número)
      datosPedido.origen || 'APP'                  // S: Origen
    ];

    const success = await this.appendRow('Pedidos', valores);
    return success ? { id: pedidoId, ...datosPedido } : null;
  }

  /**
   * Actualizar estado de pedido
   */
  async updateEstadoPedido(pedidoId, nuevoEstado) {
    const rows = await this.getRows(this.spreadsheetId, 'Pedidos!A:J');
    
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        return await this.updateCell(`Pedidos!J${i + 1}`, nuevoEstado);
      }
    }

    return false;
  }

  /**
   * Parsear fila de pedido a objeto
   * Estructura: A-S (19 columnas)
   */
  parsePedidoRow(row, rowIndex) {
    return {
      id: row[0] || '',
      fecha: row[1] || '',
      hora: row[2] || '',
      whatsapp: row[3] || '',
      cliente: row[4] || '',
      telefono: row[5] || '',
      direccion: row[6] || '',
      productos: row[7] || '',
      total: parseFloat(row[8]) || 0,
      estado: row[9] || '',
      voucherUrls: row[10] || '',
      observaciones: row[11] || '',
      departamento: row[12] || '',
      ciudad: row[13] || '',
      tipoEnvio: row[14] || '',
      metodoEnvio: row[15] || '',
      detalleEnvio: row[16] || '',
      costoEnvio: parseFloat(row[17]) || 0,
      origen: row[18] || 'APP',
      rowIndex
    };
  }

  // ============================================
  // INVENTARIO / PRODUCTOS
  // ============================================

  /**
   * Obtener productos activos
   * Estructura: Codigo, Nombre, Descripcion, Precio, Stock, StockReservado, ImagenUrl, Estado, Categoria
   */
  async getProductos(estado = null) {
    const rows = await this.getRows(this.spreadsheetId, 'Inventario!A:I');
    if (rows.length <= 1) return [];

    const productos = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const productoEstado = row[7] || 'ACTIVO';
      
      // Ignorar productos eliminados
      if (productoEstado === 'ELIMINADO') continue;

      if (!estado || productoEstado === estado) {
        productos.push({
          codigo: row[0] || '',
          nombre: row[1] || '',
          descripcion: row[2] || '',
          precio: parseFloat(row[3]) || 0,
          stock: parseInt(row[4]) || 0,
          stockReservado: parseInt(row[5]) || 0,
          imagenUrl: row[6] || '',
          estado: productoEstado,
          categoria: row[8] || '',
          disponible: (parseInt(row[4]) || 0) - (parseInt(row[5]) || 0),
          rowIndex: i + 1
        });
      }
    }

    return productos;
  }

  /**
   * Reservar stock de producto
   */
  async reservarStock(codigo, cantidad) {
    const productos = await this.getProductos();
    const producto = productos.find(p => p.codigo === codigo);

    if (!producto) {
      return { success: false, error: 'Producto no encontrado' };
    }

    if (producto.disponible < cantidad) {
      return { success: false, error: 'Stock insuficiente' };
    }

    const nuevoReservado = producto.stockReservado + cantidad;
    await this.updateCell(`Inventario!F${producto.rowIndex}`, nuevoReservado);

    return { success: true, nuevoReservado };
  }

  /**
   * Liberar stock reservado
   */
  async liberarStock(codigo, cantidad) {
    const productos = await this.getProductos();
    const producto = productos.find(p => p.codigo === codigo);

    if (!producto) return { success: false };

    const nuevoReservado = Math.max(0, producto.stockReservado - cantidad);
    await this.updateCell(`Inventario!F${producto.rowIndex}`, nuevoReservado);

    return { success: true, nuevoReservado };
  }

  // ============================================
  // CONFIGURACIÓN DEL NEGOCIO
  // ============================================

  /**
   * Obtener configuración (key-value)
   */
  async getConfiguracion() {
    const rows = await this.getRows(this.spreadsheetId, 'Configuracion!A:B');
    const config = {};

    for (let i = 1; i < rows.length; i++) {
      const key = rows[i][0];
      const value = rows[i][1];
      if (key) config[key] = value;
    }

    return config;
  }

  /**
   * Obtener métodos de pago activos
   */
  async getMetodosPago() {
    const config = await this.getConfiguracion();
    const metodos = [];

    if (config.yape_activo === 'true') {
      metodos.push({
        tipo: 'yape',
        numero: config.yape_numero,
        titular: config.yape_titular
      });
    }

    if (config.plin_activo === 'true') {
      metodos.push({
        tipo: 'plin',
        numero: config.plin_numero,
        titular: config.plin_titular
      });
    }

    // BCP, Interbank, BBVA, Scotiabank...
    ['bcp', 'interbank', 'bbva', 'scotiabank'].forEach(banco => {
      if (config[`${banco}_activo`] === 'true') {
        metodos.push({
          tipo: banco,
          cuenta: config[`${banco}_cuenta`],
          cci: config[`${banco}_cci`],
          titular: config[`${banco}_titular`]
        });
      }
    });

    return metodos;
  }

  // ============================================
  // UTILIDADES
  // ============================================

  cleanPhone(phone) {
    return (phone || '')
      .replace('whatsapp:', '')
      .replace('+', '')
      .replace(/[^0-9]/g, '');
  }
}

module.exports = SheetsService;
