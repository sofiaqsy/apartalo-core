/**
 * APARTALO CORE - Asesor Service
 * 
 * Servicio común para manejo de conversaciones con asesor humano.
 * Funcionalidades:
 * - Crear/gestionar conversaciones
 * - Bloquear bot cuando asesor está activo
 * - Guardar todos los mensajes (tracking)
 * - Compatible con todos los negocios
 * 
 * Estados de conversación:
 * - LISTENING: Bot activo, mensajes se registran para monitoreo
 * - ACTIVA: Asesor humano activo, bot NO responde
 * - CERRADA: Conversación finalizada
 */

const SheetsService = require('./sheets-service');

class AsesorService {
  constructor() {
    this.conversacionesActivas = new Map(); // whatsapp -> { negocioId, conversacionId }
  }

  /**
   * Verificar si un usuario tiene conversación activa con asesor
   * @param {string} from - Número de WhatsApp
   * @param {SheetsService} sheets - Instancia de SheetsService del negocio
   * @returns {string|null} - Estado de la conversación o null
   */
  async verificarEstado(from, sheets) {
    try {
      const cleanFrom = this.limpiarWhatsapp(from);
      
      const rows = await sheets.getRows('Conversaciones_Asesor!A:E');
      if (!rows || rows.length <= 1) return null;

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const whatsappRow = this.limpiarWhatsapp(row[3] || '');
        const estado = row[4] || '';

        if (whatsappRow === cleanFrom) {
          if (estado === 'ACTIVA') {
            return 'ACTIVA';
          } else if (estado === 'LISTENING') {
            return 'LISTENING';
          }
        }
      }

      return null;
    } catch (error) {
      console.log('⚠️ Error verificando estado asesor:', error.message);
      return null;
    }
  }

  /**
   * Verificar si debe bloquear el bot (asesor activo)
   */
  async debeBloquerBot(from, sheets) {
    const estado = await this.verificarEstado(from, sheets);
    return estado === 'ACTIVA';
  }

  /**
   * Activar modo asesor para un cliente
   * @param {string} from - Número de WhatsApp
   * @param {object} context - Contexto del handler (sheets, whatsapp, negocio)
   * @returns {object} - { success, conversacionId, mensaje }
   */
  async activarModoAsesor(from, context) {
    const { sheets, whatsapp, negocio } = context;
    
    try {
      const cleanFrom = this.limpiarWhatsapp(from);
      const timestamp = new Date().toISOString();

      // Buscar cliente para obtener nombre
      let nombreCliente = 'Cliente';
      try {
        const cliente = await sheets.buscarCliente(from);
        if (cliente) {
          nombreCliente = cliente.contacto || cliente.empresa || 'Cliente';
        }
      } catch (e) {}

      // Verificar si ya tiene conversación activa o listening
      const estadoActual = await this.verificarEstado(from, sheets);
      
      if (estadoActual === 'ACTIVA') {
        // Ya está en modo asesor
        console.log(`👤 Usuario ${from} ya tiene conversación ACTIVA`);
        return {
          success: true,
          exists: true,
          mensaje: `✅ *Reconectado con Asesoría*\n\nTu conversación continúa activa.\n\nEscribe tus consultas y un asesor te responderá pronto.\n\n_Escribe "menu" para volver al menú principal._`
        };
      }

      let conversacionId;
      
      if (estadoActual === 'LISTENING') {
        // Actualizar LISTENING -> ACTIVA
        conversacionId = await this.obtenerConversacionId(from, sheets);
        await this.cambiarEstado(conversacionId, 'ACTIVA', sheets);
        console.log(`🔄 Conversación ${conversacionId} cambiada de LISTENING a ACTIVA`);
      } else {
        // Crear nueva conversación
        conversacionId = `CONV-${Date.now()}`;
        
        await sheets.appendRow('Conversaciones_Asesor', [
          conversacionId,
          timestamp,
          nombreCliente,
          cleanFrom,
          'ACTIVA',
          timestamp,
          1,  // Veces_Atendida
          ''  // Ultima_Cierre
        ]);
        
        console.log(`✅ Conversación creada: ${conversacionId}`);

        // Guardar resumen de contexto como primer mensaje
        await this.guardarMensaje(conversacionId, from, 
          await this.generarResumenContexto(from, context),
          'SISTEMA', sheets
        );
      }

      // Guardar en memoria
      this.conversacionesActivas.set(from, {
        negocioId: negocio.id,
        conversacionId,
        cliente: nombreCliente
      });

      return {
        success: true,
        conversacionId,
        exists: false,
        mensaje: `✅ *Conectado con Asesoría*\n\n¡Hola ${nombreCliente}!\n\nEstás conectado con nuestro equipo de *${negocio.nombre}*.\n\nEscribe tu consulta y te responderemos pronto.\n\n_Escribe "menu" para volver al menú._`
      };

    } catch (error) {
      console.error('❌ Error activando modo asesor:', error.message);
      return {
        success: false,
        mensaje: 'Error conectando con asesor. Intenta más tarde.'
      };
    }
  }

  /**
   * Desactivar modo asesor (cuando cliente escribe "menu")
   */
  async desactivarModoAsesor(from, sheets) {
    try {
      const conversacionId = await this.obtenerConversacionId(from, sheets);
      
      if (conversacionId) {
        // Cambiar a LISTENING (no CERRADA, para mantener historial accesible)
        await this.cambiarEstado(conversacionId, 'LISTENING', sheets);
        console.log(`🔄 Conversación ${conversacionId} cerrada (ahora LISTENING)`);
      }

      // Limpiar memoria
      this.conversacionesActivas.delete(from);

      return { success: true };
    } catch (error) {
      console.error('❌ Error desactivando modo asesor:', error.message);
      return { success: false };
    }
  }

  /**
   * Guardar mensaje en hoja Mensajes
   * @param {string} conversacionId - ID de la conversación
   * @param {string} from - Número de WhatsApp
   * @param {string} mensaje - Contenido del mensaje
   * @param {string} tipo - CLIENTE, BOT, ASESOR, SISTEMA
   * @param {SheetsService} sheets - Instancia de SheetsService
   */
  async guardarMensaje(conversacionId, from, mensaje, tipo, sheets) {
    try {
      const cleanFrom = this.limpiarWhatsapp(from);
      const timestamp = new Date().toISOString();
      const msgId = `MSG-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

      await sheets.appendRow('Mensajes', [
        msgId,
        conversacionId,
        timestamp,
        tipo,
        mensaje,
        cleanFrom
      ]);

      // Actualizar última actividad de la conversación
      await this.actualizarUltimaActividad(conversacionId, sheets);

      return { success: true, messageId: msgId };
    } catch (error) {
      console.log('⚠️ Error guardando mensaje:', error.message);
      return { success: false };
    }
  }

  /**
   * Guardar mensaje automáticamente (para tracking)
   * Crea conversación LISTENING si no existe
   */
  async guardarMensajeAuto(from, mensaje, tipo, sheets, nombreCliente = 'Cliente') {
    try {
      const cleanFrom = this.limpiarWhatsapp(from);
      
      // Obtener o crear conversación LISTENING
      let conversacionId = await this.obtenerConversacionId(from, sheets);
      
      if (!conversacionId) {
        // Crear conversación LISTENING
        conversacionId = `CONV-${Date.now()}`;
        const timestamp = new Date().toISOString();
        
        await sheets.appendRow('Conversaciones_Asesor', [
          conversacionId,
          timestamp,
          nombreCliente,
          cleanFrom,
          'LISTENING',
          timestamp,
          0,  // Veces_Atendida
          ''  // Ultima_Cierre
        ]);
        
        console.log(`📝 Conversación LISTENING creada: ${conversacionId}`);
      }

      // Guardar mensaje
      return await this.guardarMensaje(conversacionId, from, mensaje, tipo, sheets);
    } catch (error) {
      console.log('⚠️ Error en guardarMensajeAuto:', error.message);
      return { success: false };
    }
  }

  /**
   * Obtener ID de conversación activa o listening
   */
  async obtenerConversacionId(from, sheets) {
    try {
      const cleanFrom = this.limpiarWhatsapp(from);
      
      const rows = await sheets.getRows('Conversaciones_Asesor!A:E');
      if (!rows || rows.length <= 1) return null;

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const whatsappRow = this.limpiarWhatsapp(row[3] || '');
        const estado = row[4] || '';

        if (whatsappRow === cleanFrom && (estado === 'ACTIVA' || estado === 'LISTENING')) {
          return row[0]; // ID de conversación
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Cambiar estado de conversación
   */
  async cambiarEstado(conversacionId, nuevoEstado, sheets) {
    try {
      const timestamp = new Date().toISOString();
      const rows = await sheets.getRows('Conversaciones_Asesor!A:H');
      
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] === conversacionId) {
          // Actualizar Estado (E) y Ultima_Act (F)
          await sheets.updateCell(`Conversaciones_Asesor!E${i + 1}`, nuevoEstado);
          await sheets.updateCell(`Conversaciones_Asesor!F${i + 1}`, timestamp);
          
          // Si es cierre, actualizar Ultima_Cierre (H)
          if (nuevoEstado === 'LISTENING' || nuevoEstado === 'CERRADA') {
            await sheets.updateCell(`Conversaciones_Asesor!H${i + 1}`, timestamp);
          }
          
          return { success: true };
        }
      }
      
      return { success: false };
    } catch (error) {
      console.log('⚠️ Error cambiando estado:', error.message);
      return { success: false };
    }
  }

  /**
   * Actualizar última actividad de conversación
   */
  async actualizarUltimaActividad(conversacionId, sheets) {
    try {
      const timestamp = new Date().toISOString();
      const rows = await sheets.getRows('Conversaciones_Asesor!A:F');
      
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] === conversacionId) {
          await sheets.updateCell(`Conversaciones_Asesor!F${i + 1}`, timestamp);
          break;
        }
      }
    } catch (error) {
      // Silencioso
    }
  }

  /**
   * Generar resumen de contexto del cliente para el asesor
   */
  async generarResumenContexto(from, context) {
    const { sheets, negocio } = context;
    const lineas = [];
    const fecha = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
    const cleanFrom = this.limpiarWhatsapp(from);

    lineas.push('═══════════════════════════════════════');
    lineas.push('RESUMEN DE CLIENTE');
    lineas.push(`Negocio: ${negocio.nombre}`);
    lineas.push(`Fecha: ${fecha}`);
    lineas.push('═══════════════════════════════════════');
    lineas.push('');

    // Datos del cliente
    try {
      const cliente = await sheets.buscarCliente(from);
      if (cliente) {
        if (cliente.empresa) lineas.push(`Empresa: ${cliente.empresa}`);
        if (cliente.contacto) lineas.push(`Contacto: ${cliente.contacto}`);
        if (cliente.telefono) lineas.push(`Teléfono: ${cliente.telefono}`);
        if (cliente.direccion) lineas.push(`Dirección: ${cliente.direccion}`);
        if (cliente.totalPedidos) lineas.push(`Total pedidos: ${cliente.totalPedidos}`);
      } else {
        lineas.push(`Cliente nuevo - WhatsApp: ${cleanFrom}`);
      }
    } catch (e) {
      lineas.push(`WhatsApp: ${cleanFrom}`);
    }

    // Pedidos recientes
    lineas.push('');
    lineas.push('PEDIDOS RECIENTES:');
    try {
      const pedidos = await sheets.getPedidosByWhatsapp(from);
      if (pedidos && pedidos.length > 0) {
        pedidos.slice(-3).reverse().forEach((p, i) => {
          lineas.push(`${i + 1}. ${p.fecha || 'N/A'} - ${p.productos || 'N/A'} - S/${p.total || 0} - ${p.estado || 'N/A'}`);
        });
      } else {
        lineas.push('Sin pedidos registrados');
      }
    } catch (e) {
      lineas.push('Sin pedidos');
    }

    lineas.push('');
    lineas.push('═══════════════════════════════════════');

    return lineas.join('\n');
  }

  /**
   * Limpiar número de WhatsApp
   */
  limpiarWhatsapp(numero) {
    return (numero || '').replace('whatsapp:', '').replace('+', '').replace(/[^0-9]/g, '');
  }
}

module.exports = new AsesorService();
