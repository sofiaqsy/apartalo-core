/**
 * APARTALO CORE - Servicio de Negocios
 * 
 * Gestiona la configuración de cada negocio:
 * - Carga desde Google Sheets (Master)
 * - Cache en memoria
 * - Validación de credenciales
 */

const config = require('./index');

class NegociosService {
  constructor() {
    this.negocios = new Map();
    this.initialized = false;
  }

  /**
   * Inicializar servicio cargando negocios desde Sheets o config local
   */
  async initialize(sheetsService) {
    try {
      console.log('📊 Cargando negocios...');

      if (sheetsService && config.google.masterSpreadsheetId) {
        // Cargar desde Google Sheets Master
        await this.loadFromSheets(sheetsService);
      } else {
        // Cargar desde config local (desarrollo)
        this.loadFromLocal();
      }

      this.initialized = true;
      console.log(`✅ ${this.negocios.size} negocio(s) cargado(s)`);
      
      return true;
    } catch (error) {
      console.error('❌ Error cargando negocios:', error.message);
      return false;
    }
  }

  /**
   * Cargar negocios desde Google Sheets Master
   */
  async loadFromSheets(sheetsService) {
    const rows = await sheetsService.getRows(
      config.google.masterSpreadsheetId,
      'Negocios!A:L'
    );

    if (!rows || rows.length <= 1) {
      console.log('⚠️ No hay negocios en el Master Spreadsheet');
      return;
    }

    // Procesar cada fila (saltar header)
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const negocio = this.parseNegocioRow(row);
      
      if (negocio && negocio.estado === 'ACTIVO') {
        this.negocios.set(negocio.id, negocio);
        console.log(`   ✅ ${negocio.nombre} (${negocio.whatsapp.tipo})`);
      }
    }
  }

  /**
   * Parsear fila de Sheets a objeto negocio
   * Columnas esperadas:
   * A: ID, B: Nombre, C: WhatsappTipo, D: PhoneId, E: Token,
   * F: SpreadsheetId, G: WebhookPath, H: Flujo, I: Features,
   * J: Prefijo, K: Estado, L: ConfigExtra (JSON)
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
        prefijo: row[9] || row[0].substring(0, 4).toUpperCase()
      },
      
      spreadsheetId: row[5],
      flujo: row[7] || 'ESTANDAR',
      features: this.parseFeatures(row[8]),
      estado: row[10] || 'ACTIVO',
      configExtra: this.parseJSON(row[11])
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
   * Cargar negocios desde configuración local (desarrollo)
   */
  loadFromLocal() {
    // Negocio de ejemplo: Finca Rosal
    if (process.env.FINCA_ROSAL_SPREADSHEET_ID) {
      this.negocios.set('finca-rosal', {
        id: 'finca-rosal',
        nombre: 'Finca Rosal',
        whatsapp: {
          tipo: 'PROPIO',
          phoneId: process.env.FINCA_ROSAL_WHATSAPP_PHONE_ID,
          token: process.env.FINCA_ROSAL_WHATSAPP_TOKEN,
          webhookPath: '/webhook/finca-rosal',
          prefijo: 'ROSAL'
        },
        spreadsheetId: process.env.FINCA_ROSAL_SPREADSHEET_ID,
        flujo: 'CUSTOM',
        features: ['asesorHumano', 'preciosVIP', 'cafeGratis'],
        estado: 'ACTIVO',
        configExtra: {
          deliveryMin: 5,
          productoMuestraId: 'CAT-001'
        }
      });
    }

    // Negocio demo compartido
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
      flujo: 'ESTANDAR',
      features: ['liveCommerce', 'catalogoWeb'],
      estado: 'ACTIVO',
      configExtra: {}
    });
  }

  // ============================================
  // GETTERS
  // ============================================

  /**
   * Obtener negocio por ID
   */
  getById(id) {
    return this.negocios.get(id) || null;
  }

  /**
   * Obtener negocio por PhoneId de WhatsApp
   */
  getByPhoneId(phoneId) {
    for (const negocio of this.negocios.values()) {
      if (negocio.whatsapp.phoneId === phoneId) {
        return negocio;
      }
    }
    return null;
  }

  /**
   * Obtener negocio por webhook path
   */
  getByWebhookPath(path) {
    for (const negocio of this.negocios.values()) {
      if (negocio.whatsapp.webhookPath === path) {
        return negocio;
      }
    }
    return null;
  }

  /**
   * Obtener todos los negocios activos
   */
  getAll() {
    return Array.from(this.negocios.values());
  }

  /**
   * Obtener negocios que usan número compartido
   */
  getSharedNegocios() {
    return this.getAll().filter(n => n.whatsapp.tipo === 'COMPARTIDO');
  }

  /**
   * Obtener negocios con número propio
   */
  getOwnedNegocios() {
    return this.getAll().filter(n => n.whatsapp.tipo === 'PROPIO');
  }

  /**
   * Verificar si un negocio tiene una feature habilitada
   */
  hasFeature(negocioId, feature) {
    const negocio = this.getById(negocioId);
    return negocio ? negocio.features.includes(feature) : false;
  }

  /**
   * Recargar negocios (útil para actualizar sin reiniciar)
   */
  async reload(sheetsService) {
    this.negocios.clear();
    return await this.initialize(sheetsService);
  }
}

module.exports = new NegociosService();
