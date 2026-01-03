/**
 * APARTALO CORE - Mensaje Logger
 * 
 * Servicio para registrar TODOS los mensajes de las conversaciones.
 * Útil para:
 * - Historial de conversaciones
 * - Soporte y debugging
 * - Análisis de interacciones
 * - Dashboard de administración
 * 
 * Tipos de mensaje:
 * - CLIENTE: Mensaje enviado por el cliente
 * - BOT: Respuesta automática del bot
 * - ASESOR: Respuesta del asesor humano
 * - SISTEMA: Mensajes del sistema (resúmenes, alertas)
 */

const asesorService = require('./asesor-service');

class MensajeLogger {
  constructor() {
    this.enabled = true; // Puede deshabilitarse por negocio
  }

  /**
   * Registrar mensaje del cliente
   */
  async logMensajeCliente(from, mensaje, sheets, nombreCliente = 'Cliente') {
    if (!this.enabled) return;
    
    try {
      await asesorService.guardarMensajeAuto(from, mensaje, 'CLIENTE', sheets, nombreCliente);
    } catch (error) {
      console.log('⚠️ Error logging mensaje cliente:', error.message);
    }
  }

  /**
   * Registrar respuesta del bot
   */
  async logMensajeBot(from, mensaje, sheets) {
    if (!this.enabled) return;
    
    try {
      // Truncar mensajes muy largos para el log
      const mensajeTruncado = mensaje.length > 500 
        ? mensaje.substring(0, 500) + '...[truncado]' 
        : mensaje;
      
      await asesorService.guardarMensajeAuto(from, mensajeTruncado, 'BOT', sheets);
    } catch (error) {
      console.log('⚠️ Error logging mensaje bot:', error.message);
    }
  }

  /**
   * Registrar respuesta del asesor
   */
  async logMensajeAsesor(from, mensaje, sheets, nombreAsesor = 'Asesor') {
    if (!this.enabled) return;
    
    try {
      const conversacionId = await asesorService.obtenerConversacionId(from, sheets);
      if (conversacionId) {
        await asesorService.guardarMensaje(conversacionId, from, mensaje, 'ASESOR', sheets);
      }
    } catch (error) {
      console.log('⚠️ Error logging mensaje asesor:', error.message);
    }
  }

  /**
   * Habilitar/deshabilitar logging
   */
  setEnabled(enabled) {
    this.enabled = enabled;
  }
}

module.exports = new MensajeLogger();
