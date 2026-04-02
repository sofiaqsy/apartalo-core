/**
 * APARTALO CORE - Sheets Service
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
        console.log('Google Sheets no configurado');
        return false;
      }
      const credentials = JSON.parse(config.google.serviceAccountKey);
      this.auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
      this.sheets = google.sheets({ version: 'v4', auth: this.auth });
      this.initialized = true;
      console.log('SheetsService inicializado para ' + this.spreadsheetId);
      return true;
    } catch (error) {
      console.error('Error inicializando Sheets:', error.message);
      return false;
    }
  }

  parseDecimal(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') return value;

    let str = String(value).trim();
    str = str.replace(/^[^0-9\-]+/, '').replace(/[^0-9\.,]+$/, '');
    if (str === '') return 0;

    const tienePunto = str.includes('.');
    const tieneComa = str.includes(',');

    if (tienePunto && tieneComa) {
      const idxPunto = str.lastIndexOf('.');
      const idxComa = str.lastIndexOf(',');
      if (idxComa > idxPunto) {
        str = str.replace(/\./g, '').replace(',', '.');
      } else {
        str = str.replace(/,/g, '');
      }
    } else if (tieneComa && !tienePunto) {
      const partesComa = str.split(',');
      const ultimaParte = partesComa[partesComa.length - 1];
      if (partesComa.length === 2 && ultimaParte.length <= 2) {
        str = str.replace(',', '.');
      } else {
        str = str.replace(/,/g, '');
      }
    }

    const num = parseFloat(str);
    return isNaN(num) ? 0 : num;
  }

  parseInt(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') return Math.floor(value);
    return Math.floor(this.parseDecimal(value));
  }

  formatValueForSheets(value) {
    if (value === null || value === undefined) return '';
    return value;
  }

  async getRows(range) {
    if (!this.initialized) { console.log('SheetsService no inicializado'); return []; }
    if (!range) { console.error('Error: range es requerido en getRows()'); return []; }
    try {
      const response = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range });
      return response.data.values || [];
    } catch (error) {
      console.error('Error leyendo ' + range + ':', error.message);
      return [];
    }
  }

  async appendRow(sheetName, values) {
    if (!this.initialized) return false;
    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: sheetName + '!A1',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: [values.map(v => this.formatValueForSheets(v))] }
      });
      console.log('Fila agregada a ' + sheetName + ' con ' + values.length + ' columnas');
      return true;
    } catch (error) {
      console.error('Error agregando fila a ' + sheetName + ':', error.message);
      return false;
    }
  }

  async updateCell(range, value) {
    if (!this.initialized) return false;
    try {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: 'RAW',
        resource: { values: [[this.formatValueForSheets(value)]] }
      });
      return true;
    } catch (error) {
      console.error('Error actualizando ' + range + ':', error.message);
      return false;
    }
  }

  async batchUpdate(updates) {
    if (!this.initialized) return false;
    try {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        resource: {
          data: updates.map(u => ({ range: u.range, values: [[this.formatValueForSheets(u.value)]] })),
          valueInputOption: 'RAW'
        }
      });
      return true;
    } catch (error) {
      console.error('Error en batch update:', error.message);
      return false;
    }
  }

  async deleteSheetRow(sheetName, rowIndex) {
    if (!this.initialized) return false;
    try {
      const meta = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
      const sheet = meta.data.sheets.find(s => s.properties.title === sheetName);
      if (!sheet) return false;
      const sheetId = sheet.properties.sheetId;
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        resource: {
          requests: [{
            deleteDimension: {
              range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex }
            }
          }]
        }
      });
      return true;
    } catch (error) {
      console.error('Error borrando fila de ' + sheetName + ':', error.message);
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
      if (this.cleanPhone(row[1] || '') === numeroLimpio) {
        return {
          id: row[0] || '', whatsapp: row[1] || '', nombre: row[2] || '',
          telefono: row[3] || '', direccion: row[4] || '', fechaRegistro: row[5] || '',
          ultimaCompra: row[6] || '', departamento: row[7] || '', ciudad: row[8] || '',
          empresa: row[2] || '', contacto: row[2] || '', rowIndex: i + 1
        };
      }
    }
    return null;
  }

  async upsertCliente(datosCliente) {
    const clienteExistente = await this.buscarCliente(datosCliente.whatsapp);
    const hoy = new Date().toLocaleDateString('es-PE');

    if (clienteExistente) {
      const row = clienteExistente.rowIndex;
      const actualizaciones = [];
      const nombreNuevo = datosCliente.nombre || datosCliente.empresa || '';
      if (nombreNuevo && nombreNuevo !== clienteExistente.nombre)
        actualizaciones.push({ range: `Clientes!C${row}`, value: nombreNuevo });
      const telefonoNuevo = datosCliente.telefono || '';
      if (telefonoNuevo && telefonoNuevo !== clienteExistente.telefono)
        actualizaciones.push({ range: `Clientes!D${row}`, value: telefonoNuevo });
      const direccionNueva = datosCliente.direccion || '';
      if (direccionNueva && direccionNueva !== clienteExistente.direccion)
        actualizaciones.push({ range: `Clientes!E${row}`, value: direccionNueva });
      actualizaciones.push({ range: `Clientes!G${row}`, value: hoy });
      if (actualizaciones.length > 0) {
        await this.batchUpdate(actualizaciones);
        console.log(`Cliente actualizado (${actualizaciones.length - 1} campos): ${clienteExistente.id}`);
      }
      return { ...clienteExistente, updated: true };
    }

    const nuevoId = 'CLI-' + Date.now().toString().slice(-6);
    await this.appendRow('Clientes', [
      nuevoId, this.cleanPhone(datosCliente.whatsapp),
      datosCliente.nombre || datosCliente.empresa || '',
      datosCliente.telefono || '', datosCliente.direccion || '',
      hoy, hoy, datosCliente.departamento || '', datosCliente.ciudad || ''
    ]);
    console.log(`Cliente nuevo creado: ${nuevoId}`);
    return { id: nuevoId, ...datosCliente, created: true };
  }

  // ============================================
  // PRECIOS CLIENTES
  // ============================================

  async getPreciosCliente(whatsapp) {
    try {
      const rows = await this.getRows('PreciosClientes!A:C');
      if (rows.length <= 1) return {};
      const numeroLimpio = this.cleanPhone(whatsapp);
      const precios = {};
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (this.cleanPhone(row[0] || '') === numeroLimpio) {
          const codigo = row[1] || '';
          const precio = this.parseDecimal(row[2]);
          if (codigo && precio > 0) precios[codigo] = precio;
        }
      }
      return precios;
    } catch (error) {
      console.log('Error obteniendo precios cliente:', error.message);
      return {};
    }
  }

  async getPrecioProducto(whatsapp, codigoProducto) {
    const preciosCliente = await this.getPreciosCliente(whatsapp);
    if (preciosCliente[codigoProducto]) return { precio: preciosCliente[codigoProducto], tipo: 'especial' };
    const productos = await this.getProductos('ACTIVO');
    const producto = productos.find(p => p.codigo === codigoProducto);
    if (producto) return { precio: producto.precio, tipo: 'lista' };
    return null;
  }

  async getProductosConPrecios(whatsapp) {
    const productos = await this.getProductos('ACTIVO');
    const preciosCliente = await this.getPreciosCliente(whatsapp);
    return productos.map(p => ({
      ...p,
      precioOriginal: p.precio,
      precio: preciosCliente[p.codigo] || p.precio,
      tieneDescuento: !!preciosCliente[p.codigo]
    }));
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
      if (this.cleanPhone(row[3] || '') === numeroLimpio) {
        pedidos.push(this.parsePedidoRow(row, i + 1));
      }
    }
    return pedidos;
  }

  async getPedidoById(pedidoId) {
    const rows = await this.getRows('Pedidos!A:S');
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) return this.parsePedidoRow(rows[i], i + 1);
    }
    return null;
  }

  async crearPedido(datosPedido) {
    const pedidoId = datosPedido.id || 'PED-' + Date.now().toString().slice(-6);
    const ahora = new Date();
    const valores = [
      pedidoId, ahora.toLocaleDateString('es-PE'), ahora.toLocaleTimeString('es-PE'),
      this.cleanPhone(datosPedido.whatsapp), datosPedido.cliente || '',
      datosPedido.telefono || '', datosPedido.direccion || '', datosPedido.productos || '',
      this.parseDecimal(datosPedido.total), datosPedido.estado || config.orderStates.PENDING_PAYMENT,
      '', datosPedido.observaciones || '', datosPedido.departamento || '',
      datosPedido.ciudad || '', datosPedido.tipoEnvio || '', datosPedido.metodoEnvio || '',
      datosPedido.detalleEnvio || '', this.parseDecimal(datosPedido.costoEnvio),
      datosPedido.origen || 'APP'
    ];
    const success = await this.appendRow('Pedidos', valores);
    return success ? { id: pedidoId, ...datosPedido } : null;
  }

  async updateEstadoPedido(pedidoId, nuevoEstado) {
    const rows = await this.getRows('Pedidos!A:J');
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) return await this.updateCell('Pedidos!J' + (i + 1), nuevoEstado);
    }
    return false;
  }

  parsePedidoRow(row, rowIndex) {
    return {
      id: row[0] || '', fecha: row[1] || '', hora: row[2] || '', whatsapp: row[3] || '',
      cliente: row[4] || '', telefono: row[5] || '', direccion: row[6] || '',
      productos: row[7] || '', total: this.parseDecimal(row[8]), estado: row[9] || '',
      voucherUrls: row[10] || '', observaciones: row[11] || '', departamento: row[12] || '',
      ciudad: row[13] || '', tipoEnvio: row[14] || '', metodoEnvio: row[15] || '',
      detalleEnvio: row[16] || '', costoEnvio: this.parseDecimal(row[17]),
      origen: row[18] || 'APP', rowIndex
    };
  }

  // ============================================
  // INVENTARIO / PRODUCTOS
  // ============================================

  async getProductos(estado = null) {
    const rows = await this.getRows('Inventario!A:K');
    if (rows.length <= 1) return [];

    const productos = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];

      // Ignorar filas completamente vacías
      if (!row || row.every(cell => !cell || String(cell).trim() === '')) continue;

      const codigo = (row[0] || '').trim();
      const nombre = (row[1] || '').trim();

      // Ignorar filas sin código ni nombre
      if (!codigo && !nombre) continue;

      const productoEstado = (row[7] || 'ACTIVO').trim().toUpperCase();

      if (productoEstado === 'ELIMINADO') continue;
      if (estado && productoEstado !== estado.toUpperCase()) continue;

      const precio = this.parseDecimal(row[3]);
      const stock = this.parseInt(row[4]);
      const stockReservado = this.parseInt(row[5]);

      productos.push({
        codigo: codigo || `PROD-${i}`,
        nombre,
        descripcion: (row[2] || '').trim(),
        precio,
        stock,
        stockReservado,
        imagenUrl: row[6] || '',
        estado: productoEstado,
        categoria: row[8] || '',
        proveedorId: row[9] || '',
        proveedorProductoCodigo: row[10] || '',
        disponible: stock - stockReservado,
        rowIndex: i + 1
      });
    }

    console.log(`[Inventario] Total productos leidos: ${productos.length}, con precio: ${productos.filter(p => p.precio > 0).length}`);
    return productos;
  }

  async reservarStock(codigo, cantidad) {
    const productos = await this.getProductos();
    const producto = productos.find(p => p.codigo === codigo);
    if (!producto) return { success: false, error: 'Producto no encontrado' };
    if (producto.disponible < cantidad) return { success: false, error: 'Stock insuficiente' };
    await this.updateCell('Inventario!F' + producto.rowIndex, producto.stockReservado + cantidad);
    return { success: true };
  }

  async liberarStock(codigo, cantidad) {
    const productos = await this.getProductos();
    const producto = productos.find(p => p.codigo === codigo);
    if (!producto) return { success: false };
    await this.updateCell('Inventario!F' + producto.rowIndex, Math.max(0, producto.stockReservado - cantidad));
    return { success: true };
  }

  // ============================================
  // CONFIGURACION
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
    if (configObj.yape_activo === 'SI')
      metodos.push({ tipo: 'yape', numero: configObj.yape_numero, titular: configObj.yape_titular });
    if (configObj.plin_activo === 'SI')
      metodos.push({ tipo: 'plin', numero: configObj.plin_numero, titular: configObj.plin_titular });
    ['bcp', 'interbank', 'bbva', 'scotiabank'].forEach(banco => {
      if (configObj[banco + '_activo'] === 'SI')
        metodos.push({ tipo: banco, cuenta: configObj[banco + '_cuenta'], cci: configObj[banco + '_cci'], titular: configObj[banco + '_titular'] });
    });
    return metodos;
  }

  cleanPhone(phone) {
    return (phone || '').replace('whatsapp:', '').replace('+', '').replace(/[^0-9]/g, '');
  }
}

module.exports = SheetsService;
