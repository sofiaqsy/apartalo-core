/**
 * APARTALO CORE - Servicio de Negocios
 * 
 * Gestiona la configuración de cada negocio:
 * - Carga desde Google Sheets (Master)
 * - Cache en memoria
 * - Validación de credenciales
 * 
 * FLUJOS DISPONIBLES:
 * - UNIFICADO: Handler unificado configurable (nuevo, recomendado)
 * - CUSTOM: Handler específico en /handlers/{negocioId}
 * - ESTANDAR: Handler legacy con IA
 */

const config = require('./index');
const { google } = require('googleapis');

class NegociosService {
  constructor() {
    this.negocios = new Map();
    this.initialized = false;
  }

  /**
   * Inicializar servicio cargando negocios desde Sheets
   */
  async initialize() {
    try {
      console.log('📊 Cargando negocios...');

      if (config.google.serviceAccountKey && config.google.masterSpreadsheetId) {
        await this.loadFromSheets();
      } else {
        this.loadFromLocal();
      }

      this.initialized = true;
      console.log(`✅ ${this.negocios.size} negocio(s) cargado(s)`);

      return true;
    } catch (error) {
      console.error('❌ Error cargando negocios:', error.message);
      // Cargar local como fallback
      this.loadFromLocal();
      return false;
    }
  }

  /**
   * Cargar negocios desde Google Sheets Master
   */
  async loadFromSheets() {
    try {
      const credentials = JSON.parse(config.google.serviceAccountKey);

      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
      });

      const sheets = google.sheets({ version: 'v4', auth });

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: config.google.masterSpreadsheetId,
        range: 'Negocios!A:M'
      });

      const rows = response.data.values || [];

      if (rows.length <= 1) {
        console.log('⚠️ No hay negocios en el Master Spreadsheet');
        return;
      }

      // Procesar cada fila (saltar header)
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const negocio = this.parseNegocioRow(row);

        if (negocio && negocio.estado === 'ACTIVO') {
          this.negocios.set(negocio.id, negocio);
          console.log(`   ✅ ${negocio.nombre} (${negocio.id}) - ${negocio.flujo}`);
        }
      }
    } catch (error) {
      console.error('❌ Error leyendo negocios desde Sheets:', error.message);
      throw error;
    }
  }

  /**
   * Parsear fila de Sheets a objeto negocio
   * Columnas esperadas:
   * A: ID, B: Nombre, C: WhatsappTipo, D: PhoneId, E: Token,
   * F: SpreadsheetId, G: WebhookPath, H: WhatsappAdmin, I: Flujo,
   * J: Features, K: Prefijo, L: Estado, M: ConfigExtra (JSON)
   */
  parseNegocioRow(row) {
    if (!row[0]) return null;

    const whatsappTipo = row[2] || 'COMPARTIDO';

    return {
      id: row[0],
      nombre: row[1] || row[0],

      whatsapp: {
        tipo: whatsappTipo,
        phoneId: whatsappTipo === 'PROPIO'
          ? row[3]
          : config.whatsappShared.phoneId,
        token: whatsappTipo === 'PROPIO'
          ? row[4]
          : config.whatsappShared.token,
        webhookPath: row[6] || `/webhook/${row[0]}`,
        admin: row[7] || null,
        prefijo: row[10] || row[0].substring(0, 4).toUpperCase()
      },

      spreadsheetId: row[5],
      flujo: row[8] || 'UNIFICADO',  // Default cambiado a UNIFICADO
      features: this.parseFeatures(row[9]),
      estado: row[11] || 'ACTIVO',
      configExtra: this.parseJSON(row[12])
    };
  }

  /**
   * Parsear features desde string separado por comas
   */
  parseFeatures(featuresStr) {
    if (!featuresStr) return [];
    return featuresStr.split(',').map(f => f.trim()).filter(f => f);
  }

  /**
   * Parsear JSON de forma segura
   */
  parseJSON(jsonStr) {
    if (!jsonStr) return {};
    try {
      return JSON.parse(jsonStr);
    } catch {
      return {};
    }
  }

  /**
   * Cargar negocios desde configuración local (desarrollo/fallback)
   */
  loadFromLocal() {
    console.log('📦 Cargando negocios desde configuración local...');
    
    // Negocio: Finca Rosal (B2B - café)
    if (process.env.FINCA_ROSAL_SPREADSHEET_ID) {
      this.negocios.set('BIZ-002', {
        id: 'BIZ-002',
        nombre: 'Finca Rosal',
        whatsapp: {
          tipo: 'COMPARTIDO',
          phoneId: config.whatsappShared.phoneId,
          token: config.whatsappShared.token,
          webhookPath: '/webhook/BIZ-002',
          prefijo: 'ROSAL'
        },
        spreadsheetId: process.env.FINCA_ROSAL_SPREADSHEET_ID,
        flujo: 'UNIFICADO',  // Ahora usa handler unificado
        features: ['asesorHumano', 'preciosVIP', 'cafeGratis', 'muestras'],
        estado: 'ACTIVO',
        configExtra: {
          // Configuración específica para café B2B
          unidad: 'kg',
          minimoCompra: 5,
          flujoPago: 'contacto',  // No usa voucher, contactan después
          mostrarFotos: true,
          prefijoPedido: 'CAF'
        }
      });
      console.log('   ✅ Finca Rosal (BIZ-002) - UNIFICADO [kg, min:5, pago:contacto]');
    }

    // Negocio demo: Tienda genérica (B2C - productos)
    this.negocios.set('demo-tienda', {
      id: 'demo-tienda',
      nombre: 'Demo Tienda',
      whatsapp: {
        tipo: 'COMPARTIDO',
        phoneId: config.whatsappShared.phoneId,
        token: config.whatsappShared.token,
        webhookPath: '/webhook/apartalo',
        prefijo: 'DEMO'
      },
      spreadsheetId: process.env.DEMO_SPREADSHEET_ID || config.google.masterSpreadsheetId,
      flujo: 'UNIFICADO',
      features: ['liveCommerce', 'catalogoWeb'],
      estado: 'ACTIVO',
      configExtra: {
        // Configuración estándar B2C
        unidad: 'unidad',
        minimoCompra: 1,
        flujoPago: 'voucher',  // Pide voucher
        mostrarFotos: true,
        prefijoPedido: 'PED'
      }
    });
    console.log('   ✅ Demo Tienda (demo-tienda) - UNIFICADO [unidad, min:1, pago:voucher]');
  }

  // ============================================
  // GETTERS
  // ============================================

  getById(id) {
    return this.negocios.get(id) || null;
  }

  getByPhoneId(phoneId) {
    for (const negocio of this.negocios.values()) {
      if (negocio.whatsapp.phoneId === phoneId) {
        return negocio;
      }
    }
    return null;
  }

  getByWebhookPath(path) {
    for (const negocio of this.negocios.values()) {
      if (negocio.whatsapp.webhookPath === path) {
        return negocio;
      }
    }
    return null;
  }

  getAll() {
    return Array.from(this.negocios.values());
  }

  getSharedNegocios() {
    return this.getAll().filter(n => n.whatsapp.tipo === 'COMPARTIDO');
  }

  getOwnedNegocios() {
    return this.getAll().filter(n => n.whatsapp.tipo === 'PROPIO');
  }

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
