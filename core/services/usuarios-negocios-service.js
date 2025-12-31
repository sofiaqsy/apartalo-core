/**
 * APARTALO CORE - Servicio de Usuarios-Negocios
 * 
 * Guarda la relación usuario-negocio en Google Sheets (Spreadsheet Maestro)
 * para que persista entre reinicios de Heroku
 * 
 * Hoja: UsuariosNegocios
 * Estructura: WhatsApp | NegocioId | FechaRegistro | UltimaInteraccion
 */

const { google } = require('googleapis');
const config = require('../../config');

// Spreadsheet Maestro de ApartaLo
const SPREADSHEET_MAESTRO_ID = '1OXHLdVth3oW7IAbnK_WBUAbhmToieMuemWbcMdoOeRE';
const HOJA_USUARIOS = 'UsuariosNegocios';

class UsuariosNegociosService {
  constructor() {
    this.sheets = null;
    this.auth = null;
    this.initialized = false;
    this.cache = new Map(); // Cache en memoria para reducir llamadas
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutos
  }

  /**
   * Inicializar conexión con Google Sheets
   */
  async initialize() {
    if (this.initialized) return true;

    try {
      if (!config.google.serviceAccountKey) {
        console.log('⚠️ UsuariosNegocios: Google Sheets no configurado');
        return false;
      }

      const credentials = JSON.parse(config.google.serviceAccountKey);

      this.auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });

      this.sheets = google.sheets({ version: 'v4', auth: this.auth });
      this.initialized = true;

      console.log('✅ UsuariosNegociosService inicializado');
      return true;
    } catch (error) {
      console.error('❌ Error inicializando UsuariosNegocios:', error.message);
      return false;
    }
  }

  /**
   * Limpiar número de teléfono
   */
  cleanPhone(phone) {
    return (phone || '')
      .replace('whatsapp:', '')
      .replace('+', '')
      .replace(/[^0-9]/g, '');
  }

  /**
   * Obtener negocio vinculado a un usuario
   * @param {string} whatsapp - Número de WhatsApp
   * @returns {string|null} - ID del negocio o null
   */
  async getNegocioUsuario(whatsapp) {
    const numeroLimpio = this.cleanPhone(whatsapp);
    
    // Revisar cache primero
    const cached = this.cache.get(numeroLimpio);
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      console.log(`   📋 Cache hit: ${numeroLimpio} -> ${cached.negocioId}`);
      return cached.negocioId;
    }

    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.sheets) return null;

    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_MAESTRO_ID,
        range: `${HOJA_USUARIOS}!A:D`
      });

      const rows = response.data.values || [];
      
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const rowWhatsapp = this.cleanPhone(row[0] || '');
        
        if (rowWhatsapp === numeroLimpio) {
          const negocioId = row[1] || null;
          
          // Guardar en cache
          this.cache.set(numeroLimpio, {
            negocioId,
            timestamp: Date.now(),
            rowIndex: i + 1
          });
          
          console.log(`   📋 Usuario encontrado: ${numeroLimpio} -> ${negocioId}`);
          return negocioId;
        }
      }

      console.log(`   📋 Usuario no encontrado: ${numeroLimpio}`);
      return null;
    } catch (error) {
      console.error('❌ Error buscando usuario:', error.message);
      return null;
    }
  }

  /**
   * Vincular usuario a un negocio
   * @param {string} whatsapp - Número de WhatsApp
   * @param {string} negocioId - ID del negocio
   */
  async vincularUsuario(whatsapp, negocioId) {
    const numeroLimpio = this.cleanPhone(whatsapp);
    
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.sheets) return false;

    try {
      const ahora = new Date().toISOString();
      
      // Verificar si ya existe
      const cached = this.cache.get(numeroLimpio);
      
      if (cached && cached.rowIndex) {
        // Actualizar fila existente
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_MAESTRO_ID,
          range: `${HOJA_USUARIOS}!B${cached.rowIndex}:D${cached.rowIndex}`,
          valueInputOption: 'RAW',
          resource: {
            values: [[negocioId, cached.fechaRegistro || ahora, ahora]]
          }
        });
        console.log(`   ✅ Usuario actualizado: ${numeroLimpio} -> ${negocioId}`);
      } else {
        // Buscar si existe en sheets
        const existente = await this.buscarFilaUsuario(numeroLimpio);
        
        if (existente) {
          // Actualizar
          await this.sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_MAESTRO_ID,
            range: `${HOJA_USUARIOS}!B${existente.rowIndex}:D${existente.rowIndex}`,
            valueInputOption: 'RAW',
            resource: {
              values: [[negocioId, existente.fechaRegistro, ahora]]
            }
          });
          console.log(`   ✅ Usuario actualizado: ${numeroLimpio} -> ${negocioId}`);
        } else {
          // Crear nuevo
          await this.sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_MAESTRO_ID,
            range: `${HOJA_USUARIOS}!A1`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            resource: {
              values: [[numeroLimpio, negocioId, ahora, ahora]]
            }
          });
          console.log(`   ✅ Usuario creado: ${numeroLimpio} -> ${negocioId}`);
        }
      }

      // Actualizar cache
      this.cache.set(numeroLimpio, {
        negocioId,
        timestamp: Date.now()
      });

      return true;
    } catch (error) {
      console.error('❌ Error vinculando usuario:', error.message);
      return false;
    }
  }

  /**
   * Buscar fila de usuario en sheets
   */
  async buscarFilaUsuario(numeroLimpio) {
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_MAESTRO_ID,
        range: `${HOJA_USUARIOS}!A:D`
      });

      const rows = response.data.values || [];
      
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const rowWhatsapp = this.cleanPhone(row[0] || '');
        
        if (rowWhatsapp === numeroLimpio) {
          return {
            rowIndex: i + 1,
            negocioId: row[1] || null,
            fechaRegistro: row[2] || '',
            ultimaInteraccion: row[3] || ''
          };
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Actualizar última interacción
   */
  async actualizarInteraccion(whatsapp) {
    const numeroLimpio = this.cleanPhone(whatsapp);
    const cached = this.cache.get(numeroLimpio);
    
    if (!cached || !cached.rowIndex) return;

    try {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_MAESTRO_ID,
        range: `${HOJA_USUARIOS}!D${cached.rowIndex}`,
        valueInputOption: 'RAW',
        resource: {
          values: [[new Date().toISOString()]]
        }
      });
    } catch (error) {
      // Silencioso - no es crítico
    }
  }

  /**
   * Desvincular usuario (para cambiar de tienda)
   */
  async desvincularUsuario(whatsapp) {
    const numeroLimpio = this.cleanPhone(whatsapp);
    this.cache.delete(numeroLimpio);
    
    // No borramos de Sheets, solo del cache
    // Así puede volver a seleccionar
    console.log(`   🔄 Usuario desvinculado del cache: ${numeroLimpio}`);
    return true;
  }
}

// Singleton
module.exports = new UsuariosNegociosService();
