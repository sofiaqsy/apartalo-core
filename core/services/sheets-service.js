/**
 * APARTALO CORE - Sheets Service
 * 
 * Servicio unificado para Google Sheets
 * Cada negocio tiene su propio spreadsheet
 */

const { google } = require('googleapis');
const config = require('../../config');

class SheetsService {
  constructor(spreadsheetId) {
    this.spreadsheetId = spreadsheetId;
    this.sheets = null;
    this.auth = null;
    this.initialized = false;
  }

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
  // UTILIDADES DE CONVERSIÓN
  // ============================================

  parseDecimal(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') return value;
    const str = String(value).trim().replace(',', '.');
    const num = parseFloat(str);
    return isNaN(num) ? 0 : num;
  }

  parseInt(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') return Math.floor(value);
    const str = String(value).trim().replace(',', '.');
    const num = parseInt(str, 10);
    return isNaN(num) ? 0 : num;
  }

  formatValueForSheets(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return value;
    return value;
  }

  // ============================================
  // OPERACIONES GENÉRICAS
  // ============================================

  /**
   * Obtener filas de un rango
   * @param {string} range - Rango (ej: 'Clientes!A:I')
   * @returns {Array} - Filas
   */
  async getRows(range) {
    if (!this.initialized) {
      console.log('⚠️ SheetsService no inicializado');
      return [];
    }

    if (!range) {
      console.error('❌ Error: range es requerido en getRows()');
      return [];
    }

    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range
      });
      return response.data.values || [];
    } catch (error) {
      console.error(`❌ Error leyendo ${range}:`, error.message);
      return [];
    }
  }

  /**
   * Agregar fila al final de una hoja
   */
  async appendRow(sheetName, values) {
    if (!this.initialized) return false;

    try {
      const formattedValues = values.map(v => this.formatValueForSheets(v));
      
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'RAW',
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
        valueInputOption: 'RAW',
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
          valueInputOption: 'RAW'
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

  async buscarCliente(whatsapp) {
    const rows = await this.getRows('Clientes!A:I');
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
          // Alias para compatibilidad con handler BIZ-002
          empresa: row[2] || '',
          contacto: row[2] || '',
          rowIndex: i + 1
        };
      }
    }

    return null;
  }

  async upsertCliente(datosCliente) {
    const clienteExistente = await this.buscarCliente(datosCliente.whatsapp);

    if (clienteExistente) {
      await this.updateCell(
        `Clientes!G${clienteExistente.rowIndex}`,
        new Date().toLocaleDateString('es-PE')
      );
      return { ...clienteExistente, updated: true };
    }

    const nuevoId = `CLI-${Date.now().toString().slice(-6)}`;
    const valores = [
      nuevoId,
      this.cleanPhone(datosCliente.whatsapp),
      datosCliente.nombre || datosCliente.empresa || '',
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

  async getPedidosByWhatsapp(whatsapp) {
    const rows = await this.getRows('Pedidos!A:S');
    if (rows.length <= 1) return [];

    const numeroLimpio = this.cleanPhone(whatsapp);
    const pedidos = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const pedidoWhatsapp = this.cleanPhone(row[3] || '');

      if (pedidoWhatsapp === numeroLimpio) {
        pedidos.push(this.parsePedidoRow(row, i + 1));
      }
    }

    return pedidos;
  }

  async getPedidoById(pedidoId) {
    const rows = await this.getRows('Pedidos!A:S');
    
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        return this.parsePedidoRow(rows[i], i + 1);
      }
    }

    return null;
  }

  async crearPedido(datosPedido) {
    const pedidoId = datosPedido.id || `PED-${Date.now().toString().slice(-6)}`;
    const ahora = new Date();

    const valores = [
      pedidoId,
      ahora.toLocaleDateString('es-PE'),
      ahora.toLocaleTimeString('es-PE'),
      this.cleanPhone(datosPedido.whatsapp),
      datosPedido.cliente || '',
      datosPedido.telefono || '',
      datosPedido.direccion || '',
      datosPedido.productos || '',
      this.parseDecimal(datosPedido.total),
      datosPedido.estado || config.orderStates.PENDING_PAYMENT,
      '',
      datosPedido.observaciones || '',
      datosPedido.departamento || '',
      datosPedido.ciudad || '',
      datosPedido.tipoEnvio || '',
      datosPedido.metodoEnvio || '',
      datosPedido.detalleEnvio || '',
      this.parseDecimal(datosPedido.costoEnvio),
      datosPedido.origen || 'APP'
    ];

    const success = await this.appendRow('Pedidos', valores);
    return success ? { id: pedidoId, ...datosPedido } : null;
  }

  async updateEstadoPedido(pedidoId, nuevoEstado) {
    const rows = await this.getRows('Pedidos!A:J');
    
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        return await this.updateCell(`Pedidos!J${i + 1}`, nuevoEstado);
      }
    }

    return false;
  }

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
      total: this.parseDecimal(row[8]),
      estado: row[9] || '',
      voucherUrls: row[10] || '',
      observaciones: row[11] || '',
      departamento: row[12] || '',
      ciudad: row[13] || '',
      tipoEnvio: row[14] || '',
      metodoEnvio: row[15] || '',
      detalleEnvio: row[16] || '',
      costoEnvio: this.parseDecimal(row[17]),
      origen: row[18] || 'APP',
      rowIndex
    };
  }

  // ============================================
  // INVENTARIO / PRODUCTOS
  // ============================================

  async getProductos(estado = null) {
    const rows = await this.getRows('Inventario!A:I');
    if (rows.length <= 1) return [];

    const productos = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const productoEstado = row[7] || 'ACTIVO';
      
      if (productoEstado === 'ELIMINADO') continue;

      if (!estado || productoEstado === estado) {
        const stock = this.parseInt(row[4]);
        const stockReservado = this.parseInt(row[5]);
        
        productos.push({
          codigo: row[0] || '',
          nombre: row[1] || '',
          descripcion: row[2] || '',
          precio: this.parseDecimal(row[3]),
          stock: stock,
          stockReservado: stockReservado,
          imagenUrl: row[6] || '',
          estado: productoEstado,
          categoria: row[8] || '',
          disponible: stock - stockReservado,
          rowIndex: i + 1
        });
      }
    }

    return productos;
  }

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

  async getConfiguracion() {
    const rows = await this.getRows('Configuracion!A:B');
    const configObj = {};

    for (let i = 1; i < rows.length; i++) {
      const key = rows[i][0];
      const value = rows[i][1];
      if (key) configObj[key] = value;
    }

    return configObj;
  }

  async getMetodosPago() {
    const configObj = await this.getConfiguracion();
    const metodos = [];

    if (configObj.yape_activo === 'true') {
      metodos.push({
        tipo: 'yape',
        numero: configObj.yape_numero,
        titular: configObj.yape_titular
      });
    }

    if (configObj.plin_activo === 'true') {
      metodos.push({
        tipo: 'plin',
        numero: configObj.plin_numero,
        titular: configObj.plin_titular
      });
    }

    ['bcp', 'interbank', 'bbva', 'scotiabank'].forEach(banco => {
      if (configObj[`${banco}_activo`] === 'true') {
        metodos.push({
          tipo: banco,
          cuenta: configObj[`${banco}_cuenta`],
          cci: configObj[`${banco}_cci`],
          titular: configObj[`${banco}_titular`]
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
