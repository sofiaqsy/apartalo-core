/**
 * Supabase adapter that mirrors SheetsService interface.
 * Used when negocio.plataformaExterna = true.
 * Handlers call the same method names — no changes needed in handlers.
 */

const supabase = require('./supabase-service');
const config = require('../../config');

class SupabaseSheetsAdapter {
  constructor(farmId) {
    this.farmId = farmId;
    this.initialized = false;
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
      console.error('Error inicializando SupabaseSheetsAdapter:', error.message);
      console.error('Stack:', error.stack);
      // Initialize anyway so the adapter doesn't block the request
      this.farm = { id: this.farmId, name: this.farmId, commission_rate: 0.10 };
      this.initialized = true;
      return true;
    }
  }

  // ─── PRODUCTOS ───────────────────────────────────────────────────────────────

  async getProductos(estado = null) {
    const rows = await supabase.getProducts(this.farmId);
    return rows
      .filter(p => !estado || p.status.toUpperCase() === estado.toUpperCase())
      .map(p => ({
        codigo:                  p.id,
        nombre:                  p.name,
        descripcion:             p.description || '',
        precio:                  p.price_cents / 100,
        stock:                   p.stock || 0,
        stockReservado:          0,
        imagenUrl:               (p.images && p.images[0]) ? p.images[0] : '',
        estado:                  p.status.toUpperCase(),
        categoria:               '',
        proveedorId:             '',
        proveedorProductoCodigo: '',
        precioMayor:             p.b2b_price_cents ? p.b2b_price_cents / 100 : 0,
        cantidadMayor:           p.min_order_qty || 1,
        disponible:              p.stock || 0,
        unit:                    p.unit || 'unidad'
      }));
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
      commissionRate:  this.farm?.commission_rate || 0.10
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
      currency:      'USD'
    });

    return order ? { id: order.order_number, supabaseId: order.id, ...datosPedido } : null;
  }

  async getPedidosByWhatsapp(whatsapp) {
    const cliente = await supabase.getCustomerByPhone(whatsapp);
    if (!cliente) return [];
    const orders = await supabase.getOrdersByCustomer(cliente.id);
    return orders.map(o => ({
      id:        o.order_number,
      fecha:     new Date(o.created_at).toLocaleDateString('es-CO'),
      whatsapp,
      cliente:   o.customer_name || '',
      productos: (o.order_items || []).map(i => `${i.quantity} ${i.product_name}`).join(', '),
      total:     o.total_cents / 100,
      estado:    o.status
    }));
  }

  async getPedidoById(pedidoId) {
    return null;
  }

  async updateEstadoPedido(pedidoId, nuevoEstado) {
    return false;
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
