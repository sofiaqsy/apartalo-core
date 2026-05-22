/**
 * Supabase adapter that mirrors SheetsService interface.
 * Used when negocio.plataformaExterna = true.
 * Handlers call the same method names — no changes needed in handlers.
 */

const supabase = require('./supabase-service');
const config = require('../../config');

class SupabaseSheetsAdapter {
  constructor(farmId, spreadsheetId = null) {
    this.farmId = farmId;
    this.spreadsheetId = spreadsheetId;
    this.initialized = false;
    this._sheets = null;
  }

  async initialize() {
    try {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      console.log(`[Supabase] URL: ${url ? url.substring(0, 40) + '...' : 'NO DEFINIDA'}`);
      console.log(`[Supabase] KEY: ${key ? 'SET' : 'NO DEFINIDA'}`);
      console.log(`[Supabase] farmId: ${this.farmId}`);

      const farm = await supabase.getFarm(this.farmId);
      this.farm = farm || { id: this.farmId, name: this.farmId, commission_rate: 0.10 };

      this.initialized = true;
      console.log(`SupabaseSheetsAdapter inicializado para farm ${this.farmId} (${this.farm.name})`);
      return true;
    } catch (error) {
      console.error('Error inicializando SupabaseSheetsAdapter:', JSON.stringify(error));
      this.farm = { id: this.farmId, name: this.farmId, commission_rate: 0.10 };
      this.initialized = true;
      return true;
    }
  }

  // ─── PRODUCTOS ───────────────────────────────────────────────────────────────

  async getProductos(estado = null) {
    const APP_TO_DB = { ACTIVO: 'active', INACTIVO: 'archived', ELIMINADO: 'archived' };
    const DB_TO_APP = { active: 'ACTIVO', archived: 'INACTIVO', draft: 'BORRADOR' };
    const dbStatus = estado ? (APP_TO_DB[estado.toUpperCase()] || null) : null;

    const products = await supabase.getProductsWithPresentations(this.farmId);
    return products
      .filter(p => !dbStatus || p.status === dbStatus)
      .map(p => {
        const defaultPres = p.presentations.find(pp => pp.is_default) || p.presentations[0] || null;
        return {
          codigo:       p.id,
          nombre:       p.name,
          descripcion:  p.description || '',
          precio:       defaultPres ? defaultPres.price_cents / 100 : 0,
          stock:        defaultPres ? (defaultPres.stock || 0) : 0,
          stockReservado: 0,
          imagenUrl:    (p.images && p.images[0]) ? p.images[0] : '',
          estado:       DB_TO_APP[p.status] || p.status.toUpperCase(),
          categoria:    '',
          precioMayor:  defaultPres?.b2b_price_cents ? defaultPres.b2b_price_cents / 100 : null,
          cantidadMayor: defaultPres?.min_order_qty ? Math.round(defaultPres.min_order_qty) : null,
          pedidoMinimo: defaultPres?.min_order_qty || 1,
          disponible:   defaultPres ? (defaultPres.stock || 0) : 0,
          unit:         defaultPres?.unit || 'unidad',
          presentaciones: p.presentations.map(pp => ({
            id:           pp.id,
            contenido:    pp.pack_size,
            unidad:       pp.unit,
            precio:       pp.price_cents / 100,
            precioB2b:    pp.b2b_price_cents ? pp.b2b_price_cents / 100 : null,
            stock:        pp.stock || 0,
            pedidoMinimo: pp.min_order_qty || 1,
            predeterminada: pp.is_default || false,
            molienda:     pp.grind || []
          }))
        };
      });
  }

  async getProductosConPrecios(whatsapp) {
    const productos = await this.getProductos('active');
    return productos.map(p => ({ ...p, precioOriginal: p.precio, tieneDescuento: false }));
  }

  // ─── CLIENTES ─────────────────────────────────────────────────────────────────

  async buscarCliente(whatsapp) {
    const cliente = await supabase.getCustomerByPhone(whatsapp);
    if (!cliente) return null;
    return {
      id:            cliente.id,
      whatsapp:      cliente.phone,
      nombre:        cliente.full_name || '',
      telefono:      cliente.phone,
      direccion:     '',
      fechaRegistro: '',
      ultimaCompra:  '',
      departamento:  '',
      ciudad:        '',
      empresa:       cliente.full_name || '',
      contacto:      cliente.full_name || ''
    };
  }

  async upsertCliente(datosCliente) {
    const existente = await supabase.getCustomerByPhone(datosCliente.whatsapp);
    if (existente) {
      const updates = {};
      if (datosCliente.nombre || datosCliente.empresa)
        updates.full_name = datosCliente.nombre || datosCliente.empresa;
      if (Object.keys(updates).length > 0)
        await supabase.updateCustomer(existente.id, updates);
      return { id: existente.id, ...datosCliente, updated: true };
    }
    const nuevo = await supabase.createCustomer({
      fullName: datosCliente.nombre || datosCliente.empresa || '',
      phone:    datosCliente.whatsapp,
      email:    datosCliente.email || null
    });
    return { id: nuevo.id, ...datosCliente, created: true };
  }

  // ─── PEDIDOS ──────────────────────────────────────────────────────────────────

  async crearPedido(datosPedido) {
    const cliente = await supabase.getCustomerByPhone(datosPedido.whatsapp);

    const productosRaw = datosPedido.productosDetalle || [];
    const items = productosRaw.map(p => ({
      productId:       p.codigo || p.id,
      productName:     p.nombre || p.name,
      unit:            p.unit || p.unidad || 'unidad',
      quantity:        p.cantidad || p.quantity || 1,
      unitPriceCents:  Math.round((p.precio || p.price || 0) * 100),
      lineTotalCents:  Math.round((p.subtotal || (p.precio || 0) * (p.cantidad || 1)) * 100),
      commissionRate:  this.farm?.commission_rate || 0.10,
      presentacionId:  p.presentacionId || null,
      grind:           p.grind || null
    }));

    const order = await supabase.createOrder({
      customer: {
        id:       cliente?.id || null,
        email:    cliente?.email || `${datosPedido.whatsapp}@whatsapp.apartalo.co`,
        fullName: datosPedido.cliente || datosPedido.nombre || '',
        phone:    datosPedido.whatsapp
      },
      farmId:          this.farmId,
      items,
      shippingAddress: {
        address:    datosPedido.direccion || '',
        city:       datosPedido.ciudad || '',
        department: datosPedido.departamento || '',
        type:       datosPedido.tipoEnvio || 'LOCAL'
      },
      notes:         datosPedido.observaciones || '',
      paymentMethod: datosPedido.metodoPago || null,
      currency:      'USD',
      shippingCents: Math.round((parseFloat(datosPedido.costoEnvio) || 0) * 100)
    });

    if (!order) return null;
    const { fecha, hora } = (() => {
      const d = new Date(order.created_at || Date.now());
      const lima = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
      const get = t => (lima.find(p => p.type === t) || {}).value || '';
      return { fecha: `${get('day')}/${get('month')}/${get('year')}`, hora: `${get('hour')}:${get('minute')}` };
    })();
    return {
      id: order.order_number, supabaseId: order.id,
      fecha, hora,
      estado: 'PENDIENTE',
      ...datosPedido
    };
  }

  async getPedidosByWhatsapp(whatsapp) {
    const cliente = await supabase.getCustomerByPhone(whatsapp);
    if (!cliente) return [];
    const orders = await supabase.getOrdersByCustomer(cliente.id);
    return orders.map(o => ({
      id:          o.order_number,
      fecha:       new Date(o.created_at).toLocaleDateString('es-CO'),
      whatsapp,
      cliente:     o.customer_name || '',
      productos:   (o.order_items || []).map(i => `${i.quantity} ${i.product_name}`).join(', '),
      subtotal:    (o.subtotal_cents || 0) / 100,
      costoEnvio:  (o.shipping_cents || 0) / 100,
      total:       o.total_cents / 100,
      estado:      o.status
    }));
  }

  async getPedidoById(pedidoId) {
    return null;
  }

  async updateEstadoPedido(pedidoId, nuevoEstado) {
    return false;
  }

  // ─── SHEETS-COMPATIBLE METHODS FOR PRODUCT CRUD ──────────────────────────────

  async getRows(range) {
    if (range && range.startsWith('Inventario')) {
      const products = await supabase.getAllProducts(this.farmId);
      this._productRowCache = [];
      const rows = [['codigo', 'nombre', 'descripcion', 'precio', 'stock', 'stockReservado', 'imagenUrl', 'estado', 'categoria', '', '', 'precioMayor', 'cantidadMayor']];
      products.forEach((p, i) => {
        const rowIndex = i + 2;
        this._productRowCache.push({ id: p.id, rowIndex });
        rows.push([
          p.id,
          p.name,
          p.description || '',
          p.price_cents / 100,
          p.stock || 0,
          0,
          (p.images && p.images[0]) ? p.images[0] : '',
          p.status === 'active' ? 'ACTIVO' : p.status === 'archived' ? 'INACTIVO' : p.status.toUpperCase(),
          '',
          '', '', '',
          p.b2b_price_cents ? p.b2b_price_cents / 100 : 0,
          p.min_order_qty || 1
        ]);
      });
      return rows;
    }
    return [];
  }

  async appendRow(sheetName, values) {
    if (sheetName === 'Inventario') {
      const statusRaw = (values[7] || 'ACTIVO').toUpperCase();
      const product = await supabase.createProduct(this.farmId, {
        name:               values[1],
        description:        values[2] || '',
        priceCents:         Math.round((parseFloat(values[3]) || 0) * 100),
        stock:              parseFloat(values[4]) || 0,
        images:             values[6] ? [values[6]] : [],
        status:             statusRaw === 'ACTIVO' ? 'active' : 'draft',
        unit:               'unidad',
        b2bPriceCents: values[12] ? Math.round((parseFloat(values[12]) || 0) * 100) : null,
        minOrderQty:   values[13] ? parseFloat(values[13]) || 1 : 1,
        minQtyForB2b:  values[14] ? Math.round(parseFloat(values[14])) || null : null
      });

      // Mirror to sheet: register Supabase ID in col A, rest empty for future sync
      if (product && this._sheets) {
        try {
          const supabaseId = product.id;
          await this._sheets.appendRow('Inventario', [supabaseId, '', '', '', '', '', '', '', '', '', '', '', '']);
          console.log(`[Supabase] Producto registrado en Sheets con ID ${supabaseId}`);
        } catch (sheetsErr) {
          console.warn('[Supabase] No se pudo registrar en Sheets:', sheetsErr.message);
        }
      }

      return true;
    }
    return false;
  }

  async updateCell(range, value) {
    const match = (range || '').match(/^Inventario!([A-Z]+)(\d+)$/);
    if (!match) return false;
    const col = match[1];
    const rowNum = parseInt(match[2]);
    if (!this._productRowCache) this._productRowCache = [];
    const cached = this._productRowCache.find(r => r.rowIndex === rowNum);
    if (!cached) return false;

    // J and K (B2B Business, B2B Product) live only in the sheet
    // Must find the actual sheet row by searching column A for the Supabase ID
    if (col === 'J' || col === 'K') {
      if (this._sheets && cached) {
        try {
          const colA = await this._sheets.getRows('Inventario!A:A');
          const actualRow = colA.findIndex((r, idx) => idx > 0 && r[0] === cached.id);
          if (actualRow > 0) {
            await this._sheets.updateCell(`Inventario!${col}${actualRow + 1}`, value);
          } else {
            console.warn(`[Supabase] ID ${cached.id} no encontrado en col A del sheet para actualizar ${col}`);
          }
        } catch (e) {
          console.warn(`[Supabase] No se pudo actualizar ${col} en Sheets:`, e.message);
        }
      }
      return true;
    }

    const colMap = {
      B: 'name', C: 'description', D: 'price_cents', E: 'stock',
      G: 'images', H: 'status', I: 'category',
      L: 'b2b_price_cents', M: 'min_order_qty', N: 'min_qty_for_b2b'
    };
    const field = colMap[col];
    if (!field) return false;

    let dbValue = value;
    if (['price_cents', 'b2b_price_cents'].includes(field)) dbValue = Math.round((parseFloat(value) || 0) * 100);
    if (field === 'min_qty_for_b2b') dbValue = value ? Math.round(parseFloat(value)) || null : null;
    if (field === 'stock' || field === 'min_order_qty') dbValue = parseFloat(value) || 0;
    if (field === 'images') dbValue = value ? [value] : [];
    if (field === 'status') {
      const v = (value || '').toUpperCase();
      dbValue = v === 'ACTIVO' ? 'active' : v === 'ELIMINADO' ? 'archived' : 'archived';
    }

    await supabase.updateProduct(cached.id, { [field]: dbValue });
    return true;
  }

  async batchUpdate(updates) {
    for (const u of updates) await this.updateCell(u.range, u.value);
    return true;
  }

  // ─── MÉTODOS VACÍOS (no aplican en Supabase) ─────────────────────────────────

  async getMetodosPago() { return []; }
  async getConfiguracion() { return {}; }
  async reservarStock() { return { success: true }; }
  async liberarStock() { return { success: true }; }
  async getPreciosCliente() { return {}; }
  async logMensaje() { return true; }
}

module.exports = SupabaseSheetsAdapter;
