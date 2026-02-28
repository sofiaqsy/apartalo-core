/**
 * APARTALO CORE - Servicio de Negocios
 *
 * Columnas del Spreadsheet Maestro (Negocios!A:N):
 * A: ID
 * B: Nombre
 * C: WhatsappTipo  → PROPIO | COMPARTIDO
 * D: PhoneId       → phoneId del número propio (vacío si COMPARTIDO)
 * E: Token         → token del número propio (vacío si COMPARTIDO)
 * F: SpreadsheetId → ID del spreadsheet del negocio
 * G: WebhookPath   → ej: /webhook/BIZ-002
 * H: WhatsappAdmin → número admin para notificaciones
 * I: Flujo         → CUSTOM | ESTANDAR | UNIFICADO
 * J: Features      → lista separada por comas
 * K: Prefijo       → ej: ROSAL, CAFE, FINCA
 * L: Estado        → ACTIVO | INACTIVO
 * M: ConfigExtra   → JSON con configuración adicional
 */

const config = require('./index');
const { google } = require('googleapis');

class NegociosService {
  constructor() {
    this.negocios = new Map();
    this.initialized = false;
  }

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
      this.loadFromLocal();
      return false;
    }
  }

  async loadFromSheets() {
    try {
      const credentials = JSON.parse(config.google.serviceAccountKey);
      const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
      const sheets = google.sheets({ version: 'v4', auth });

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: config.google.masterSpreadsheetId,
        range: 'Negocios!A:N'
      });

      const rows = response.data.values || [];
      if (rows.length <= 1) {
        console.log('⚠️ No hay negocios en el Master Spreadsheet');
        return;
      }

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const negocio = this.parseNegocioRow(row);
        if (negocio && negocio.estado === 'ACTIVO') {
          this.negocios.set(negocio.id, negocio);
          console.log(`   ✅ ${negocio.nombre} (${negocio.id}) - ${negocio.flujo} [WhatsApp: ${negocio.whatsapp.tipo}]`);
        }
      }
    } catch (error) {
      console.error('❌ Error leyendo negocios desde Sheets:', error.message);
      throw error;
    }
  }

  /**
   * Parsear fila del Maestro.
   *
   * Lógica de WhatsApp:
   * - COMPARTIDO: siempre usa las credenciales compartidas (config.whatsappShared)
   * - PROPIO con phoneId+token: usa sus propias credenciales Y su propio webhook /webhook/:id
   * - PROPIO sin credenciales: degradado a COMPARTIDO automáticamente
   */
  parseNegocioRow(row) {
    if (!row[0]) return null;

    const id           = (row[0] || '').trim();
    const nombre       = (row[1] || id).trim();
    const whatsappTipo = (row[2] || 'COMPARTIDO').trim().toUpperCase();
    const phoneId      = (row[3] || '').trim();
    const token        = (row[4] || '').trim();
    const spreadsheetId= (row[5] || '').trim();
    const webhookPath  = (row[6] || `/webhook/${id}`).trim();
    const admin        = (row[7] || '').trim() || null;
    const flujo        = (row[8] || 'UNIFICADO').trim().toUpperCase();
    const featuresStr  = (row[9] || '').trim();
    const prefijo      = (row[10] || id.substring(0, 4)).trim().toUpperCase();
    const estado       = (row[11] || 'ACTIVO').trim().toUpperCase();
    const configExtra  = this.parseJSON(row[12]);

    // Determinar si realmente puede usar número propio
    const esPropio = whatsappTipo === 'PROPIO' && phoneId && token;

    return {
      id,
      nombre,
      whatsapp: {
        tipo: esPropio ? 'PROPIO' : 'COMPARTIDO',
        phoneId: esPropio ? phoneId : config.whatsappShared.phoneId,
        token:   esPropio ? token   : config.whatsappShared.token,
        webhookPath,
        admin,
        prefijo
      },
      spreadsheetId,
      flujo,
      features: this.parseFeatures(featuresStr),
      estado,
      configExtra
    };
  }

  parseFeatures(featuresStr) {
    if (!featuresStr) return [];
    return featuresStr.split(',').map(f => f.trim()).filter(f => f);
  }

  parseJSON(jsonStr) {
    if (!jsonStr) return {};
    try { return JSON.parse(jsonStr); }
    catch { return {}; }
  }

  loadFromLocal() {
    console.log('📦 Cargando negocios desde configuración local...');
    
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
        flujo: 'CUSTOM',
        features: ['asesorHumano', 'preciosVIP', 'cafeGratis', 'muestras'],
        estado: 'ACTIVO',
        configExtra: { unidad: 'kg', minimoCompra: 5, flujoPago: 'contacto', mostrarFotos: true, prefijoPedido: 'CAF' }
      });
      console.log('   ✅ Finca Rosal (BIZ-002) - CUSTOM');
    }
  }

  // ============================================
  // GETTERS
  // ============================================

  getById(id) { return this.negocios.get(id) || null; }

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

  getAll() { return Array.from(this.negocios.values()); }

  /**
   * Negocios que usan el número compartido.
   * Un negocio PROPIO también puede recibir mensajes por el número compartido
   * si el usuario llega por ahí (multi-tenant) — se incluyen todos.
   */
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
