/**
 * APARTALO CORE - WhatsApp Service
 * 
 * Servicio unificado para WhatsApp Cloud API
 * Funciona con cualquier negocio (propio o compartido)
 * 
 * USO:
 *   const wa = new WhatsAppService(negocio.whatsapp);
 *   await wa.sendMessage(to, 'Hola!');
 */

const axios = require('axios');
const config = require('../../config');

class WhatsAppService {
  /**
   * @param {Object} whatsappConfig - Configuración del negocio
   * @param {string} whatsappConfig.phoneId - Phone Number ID
   * @param {string} whatsappConfig.token - Access Token
   */
  constructor(whatsappConfig) {
    this.phoneId = whatsappConfig.phoneId;
    this.token = whatsappConfig.token;
    this.apiVersion = config.whatsappShared.apiVersion || 'v21.0';
    this.baseUrl = `${config.whatsappShared.apiUrl}/${this.apiVersion}/${this.phoneId}`;
  }

  /**
   * Headers para las peticiones
   */
  get headers() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json'
    };
  }

  // ============================================
  // MENSAJES BÁSICOS
  // ============================================

  /**
   * Enviar mensaje de texto
   */
  async sendMessage(to, text) {
    try {
      const cleanTo = this.cleanPhone(to);
      
      const response = await axios.post(
        `${this.baseUrl}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanTo,
          type: 'text',
          text: { body: text }
        },
        { headers: this.headers }
      );

      console.log(`✅ Mensaje enviado a ${cleanTo}`);
      return response.data;
    } catch (error) {
      console.error('❌ Error enviando mensaje:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Enviar mensaje con botones (máximo 3)
   */
  async sendButtonMessage(to, bodyText, buttons) {
    try {
      const cleanTo = this.cleanPhone(to);
      
      const buttonObjects = buttons.slice(0, 3).map((btn, index) => ({
        type: 'reply',
        reply: {
          id: btn.id || `btn_${index}`,
          title: btn.title.substring(0, 20) // Max 20 chars
        }
      }));

      const response = await axios.post(
        `${this.baseUrl}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanTo,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: bodyText },
            action: { buttons: buttonObjects }
          }
        },
        { headers: this.headers }
      );

      console.log(`✅ Mensaje con botones enviado a ${cleanTo}`);
      return response.data;
    } catch (error) {
      console.error('❌ Error enviando botones:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Enviar mensaje con lista de opciones
   */
  async sendListMessage(to, headerText, bodyText, buttonText, sections) {
    try {
      const cleanTo = this.cleanPhone(to);

      const response = await axios.post(
        `${this.baseUrl}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanTo,
          type: 'interactive',
          interactive: {
            type: 'list',
            header: { type: 'text', text: headerText },
            body: { text: bodyText },
            action: {
              button: buttonText,
              sections: sections
            }
          }
        },
        { headers: this.headers }
      );

      console.log(`✅ Lista enviada a ${cleanTo}`);
      return response.data;
    } catch (error) {
      console.error('❌ Error enviando lista:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Enviar imagen con caption
   */
  async sendImage(to, imageUrl, caption = '') {
    try {
      const cleanTo = this.cleanPhone(to);

      const response = await axios.post(
        `${this.baseUrl}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanTo,
          type: 'image',
          image: {
            link: imageUrl,
            caption: caption
          }
        },
        { headers: this.headers }
      );

      console.log(`✅ Imagen enviada a ${cleanTo}`);
      return response.data;
    } catch (error) {
      console.error('❌ Error enviando imagen:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Enviar imagen con botones (para productos LIVE)
   */
  async sendImageWithButtons(to, imageUrl, bodyText, buttons, headerText = '') {
    try {
      const cleanTo = this.cleanPhone(to);

      const buttonObjects = buttons.slice(0, 3).map((btn, index) => ({
        type: 'reply',
        reply: {
          id: btn.id || `btn_${index}`,
          title: btn.title.substring(0, 20)
        }
      }));

      const interactive = {
        type: 'button',
        header: {
          type: 'image',
          image: { link: imageUrl }
        },
        body: { text: bodyText },
        action: { buttons: buttonObjects }
      };

      const response = await axios.post(
        `${this.baseUrl}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanTo,
          type: 'interactive',
          interactive: interactive
        },
        { headers: this.headers }
      );

      console.log(`✅ Imagen con botones enviada a ${cleanTo}`);
      return response.data;
    } catch (error) {
      console.error('❌ Error enviando imagen con botones:', error.response?.data || error.message);
      throw error;
    }
  }

  // ============================================
  // CATÁLOGO DE PRODUCTOS
  // ============================================

  /**
   * Enviar lista de productos del catálogo
   */
  async sendProductListMessage(to, catalogId, options = {}) {
    try {
      const cleanTo = this.cleanPhone(to);

      const response = await axios.post(
        `${this.baseUrl}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanTo,
          type: 'interactive',
          interactive: {
            type: 'product_list',
            header: { type: 'text', text: options.header || 'Catálogo' },
            body: { text: options.body || 'Selecciona un producto' },
            footer: { text: options.footer || '' },
            action: {
              catalog_id: catalogId,
              sections: options.sections || []
            }
          }
        },
        { headers: this.headers }
      );

      console.log(`✅ Catálogo enviado a ${cleanTo}`);
      return response.data;
    } catch (error) {
      console.error('❌ Error enviando catálogo:', error.response?.data || error.message);
      throw error;
    }
  }

  // ============================================
  // UTILIDADES
  // ============================================

  /**
   * Marcar mensaje como leído
   */
  async markAsRead(messageId) {
    try {
      await axios.post(
        `${this.baseUrl}/messages`,
        {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId
        },
        { headers: this.headers }
      );
      return true;
    } catch (error) {
      console.error('⚠️ Error marcando como leído:', error.message);
      return false;
    }
  }

  /**
   * Descargar media (imagen, documento, etc)
   */
  async downloadMedia(mediaId) {
    try {
      // Obtener URL del media
      const urlResponse = await axios.get(
        `${config.whatsappShared.apiUrl}/${this.apiVersion}/${mediaId}`,
        { headers: this.headers }
      );

      const mediaUrl = urlResponse.data.url;

      // Descargar el archivo
      const mediaResponse = await axios.get(mediaUrl, {
        headers: { 'Authorization': `Bearer ${this.token}` },
        responseType: 'arraybuffer'
      });

      return {
        data: mediaResponse.data,
        contentType: mediaResponse.headers['content-type']
      };
    } catch (error) {
      console.error('❌ Error descargando media:', error.message);
      throw error;
    }
  }

  /**
   * Limpiar número de teléfono
   */
  cleanPhone(phone) {
    return phone
      .replace('whatsapp:', '')
      .replace('+', '')
      .replace(/[^0-9]/g, '');
  }

  /**
   * Formatear número para almacenar
   */
  formatPhoneForStorage(phone) {
    const clean = this.cleanPhone(phone);
    return `+${clean}`;
  }
}

module.exports = WhatsAppService;
