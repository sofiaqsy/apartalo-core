/**
 * APARTALO CORE - Servicio de Negocios
 *
 * Carga la configuración de negocios desde variables de entorno (local).
 * La integración con Google Sheets fue eliminada — toda la data de órdenes,
 * clientes y productos vive en Supabase.
 */

const config = require('./index');

// farmId fijo de Finca Rosal en Supabase (farms.id)
const FINCA_ROSAL_FARM_ID = process.env.FINCA_ROSAL_FARM_ID || 'c1d391b2-31d0-4eb4-a3e5-6986490e4dd3';

class NegociosService {
  constructor() {
    this.negocios = new Map();
    this.initialized = false;
  }

  async initialize() {
    try {
      console.log('📦 Cargando negocios...');
      this.loadFromLocal();
      await this.loadFromFarms();
      this.initialized = true;
      console.log(`✅ ${this.negocios.size} negocio(s) cargado(s)`);
      return true;
    } catch (error) {
      console.error('❌ Error cargando negocios:', error.message);
      return false;
    }
  }

  loadFromLocal() {
    console.log('📦 Cargando negocios desde configuración local...');

    this.negocios.set('BIZ-002', {
      id: 'BIZ-002',
      nombre: 'Finca Rosal',
      direccion: process.env.FINCA_ROSAL_DIRECCION || '',
      ciudad:    process.env.FINCA_ROSAL_CIUDAD    || 'Lima',
      whatsapp: {
        tipo:        'COMPARTIDO',
        phoneId:     config.whatsappShared.phoneId,
        token:       config.whatsappShared.token,
        webhookPath: '/webhook/BIZ-002',
        admin:       process.env.FINCA_ROSAL_ADMIN_PHONE || null,
        prefijo:     'ROSAL'
      },
      flujo:             'CUSTOM',
      features:          ['asesorHumano', 'preciosVIP', 'cafeGratis', 'muestras'],
      estado:            'ACTIVO',
      farmId:            FINCA_ROSAL_FARM_ID,
      plataformaExterna: true,
      configExtra: {
        unidad:       'kg',
        minimoCompra: 5,
        flujoPago:    'contacto',
        mostrarFotos: true,
        prefijoPedido: 'CAF'
      }
    });

    console.log(`   ✅ Finca Rosal (BIZ-002) — Supabase farmId=${FINCA_ROSAL_FARM_ID}`);
  }

  /**
   * Approved farms that are not configured above become businesses with safe defaults
   * (no WhatsApp line, standard flow). A failure here never prevents the server from booting.
   */
  async loadFromFarms() {
    try {
      const supabaseService = require('../core/services/supabase-service');
      const farms = await supabaseService.get('farms', { status: 'eq.approved', select: 'id,slug,name,city' });
      const known = new Set(Array.from(this.negocios.values()).map(n => n.farmId));
      for (const farm of farms || []) {
        if (!farm.slug || known.has(farm.id)) continue;
        const id = `BIZ-${farm.slug.toUpperCase()}`;
        this.negocios.set(id, {
          id, nombre: farm.name, direccion: '', ciudad: farm.city || '',
          whatsapp: { tipo: 'NINGUNO', phoneId: null, token: null, webhookPath: null, admin: null, prefijo: farm.slug.slice(0, 5).toUpperCase() },
          flujo: 'STANDARD', features: [], estado: 'ACTIVO', farmId: farm.id, plataformaExterna: true,
          configExtra: { unidad: 'kg', minimoCompra: 1, flujoPago: 'contacto', mostrarFotos: true, prefijoPedido: 'PED' },
        });
        console.log(`   ✅ ${farm.name} (${id}) — desde farms`);
      }
    } catch (error) {
      console.error('⚠️ No se pudieron cargar negocios desde farms:', error.message);
    }
  }

  getById(id)          { return this.negocios.get(id) || null; }

  getByPhoneId(phoneId) {
    for (const negocio of this.negocios.values()) {
      if (negocio.whatsapp.phoneId === phoneId) return negocio;
    }
    return null;
  }

  getByWebhookPath(path) {
    for (const negocio of this.negocios.values()) {
      if (negocio.whatsapp.webhookPath === path) return negocio;
    }
    return null;
  }

  getAll()            { return Array.from(this.negocios.values()); }
  getSharedNegocios() { return this.getAll().filter(n => n.whatsapp.tipo === 'COMPARTIDO'); }
  getOwnedNegocios()  { return this.getAll().filter(n => n.whatsapp.tipo === 'PROPIO'); }

  hasFeature(negocioId, feature) {
    const negocio = this.getById(negocioId);
    return negocio ? negocio.features.includes(feature) : false;
  }

  async reload() {
    this.negocios.clear();
    return await this.initialize();
  }
}

module.exports = new NegociosService();
