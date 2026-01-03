/**
 * APARTALO CORE - Asesor Service
 * 
 * Servicio común para manejo de conversaciones con asesor humano.
 * 
 * REGLA IMPORTANTE: Solo 1 conversación por cliente (WhatsApp)
 * - Si ya existe una conversación (cualquier estado), se reutiliza
 * - Nunca se crean duplicados
 * 
 * Estados de conversación:
 * - LISTENING: Bot activo, mensajes se registran para monitoreo
 * - ACTIVA: Asesor humano activo, bot NO responde
 * - CERRADA: Conversación finalizada (puede reactivarse)
 */

class AsesorService {
  constructor() {
    this.conversacionesActivas = new Map();
  }

  /**
   * Verificar estado de conversación del usuario
   * @returns {string|null} - 'ACTIVA', 'LISTENING', 'CERRADA' o null
   */
  async verificarEstado(from, sheets) {
    try {
      const cleanFrom = this.limpiarWhatsapp(from);
      const rows = await sheets.getRows('Conversaciones_Asesor!A:E');
      
      if (!rows || rows.length <= 1) return null;

      // Buscar conversación del usuario (cualquier estado)
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const whatsappRow = this.limpiarWhatsapp(row[3] || '');
        const estado = row[4] || '';

        if (whatsappRow === cleanFrom) {
          return estado; // Retorna el estado actual
        }
      }

      return null;
    } catch (error) {
      console.log('⚠️ Error verificando estado asesor:', error.message);
      return null;
    }
  }

  /**
   * Verificar si debe bloquear el bot (SOLO si estado es ACTIVA)
   */
  async debeBloquerBot(from, sheets) {
    const estado = await this.verificarEstado(from, sheets);
    const bloquear = estado === 'ACTIVA';
    
    if (bloquear) {
      console.log(`🛑 [ASESOR] Bot BLOQUEADO para ${from} - Estado: ${estado}`);
    }
    
    return bloquear;
  }

  /**
   * Obtener conversación existente del usuario (cualquier estado)
   * @returns {object|null} - { id, estado, rowIndex } o null
   */
  async obtenerConversacionExistente(from, sheets) {
    try {
      const cleanFrom = this.limpiarWhatsapp(from);
      const rows = await sheets.getRows('Conversaciones_Asesor!A:E');
      
      if (!rows || rows.length <= 1) return null;

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const whatsappRow = this.limpiarWhatsapp(row[3] || '');

        if (whatsappRow === cleanFrom) {
          return {
            id: row[0],
            estado: row[4] || '',
            rowIndex: i + 1 // Para actualizar después
          };
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Activar modo asesor para un cliente
   * - Si no existe conversación, la crea
   * - Si existe (cualquier estado), la cambia a ACTIVA
   */
  async activarModoAsesor(from, context) {
    const { sheets, whatsapp, negocio } = context;
    
    try {
      const cleanFrom = this.limpiarWhatsapp(from);
      const timestamp = new Date().toISOString();

      // Buscar nombre del cliente
      let nombreCliente = 'Cliente';
      try {
        const cliente = await sheets.buscarCliente(from);
        if (cliente) {
          nombreCliente = cliente.contacto || cliente.empresa || 'Cliente';
        }
      } catch (e) {}

      // Verificar si ya existe conversación
      const conversacionExistente = await this.obtenerConversacionExistente(from, sheets);
      
      let conversacionId;
      let yaEstabActiva = false;

      if (conversacionExistente) {
        conversacionId = conversacionExistente.id;
        
        if (conversacionExistente.estado === 'ACTIVA') {
          // Ya está activa, no hacer nada
          yaEstabActiva = true;
          console.log(`👤 [ASESOR] Usuario ${cleanFrom} ya tiene conversación ACTIVA: ${conversacionId}`);
        } else {
          // Cambiar estado a ACTIVA
          await sheets.updateCell(`Conversaciones_Asesor!E${conversacionExistente.rowIndex}`, 'ACTIVA');
          await sheets.updateCell(`Conversaciones_Asesor!F${conversacionExistente.rowIndex}`, timestamp);
          console.log(`🔄 [ASESOR] Conversación ${conversacionId} cambiada de ${conversacionExistente.estado} a ACTIVA`);
        }
      } else {
        // Crear nueva conversación (primera vez del cliente)
        conversacionId = `CONV-${Date.now()}`;
        
        await sheets.appendRow('Conversaciones_Asesor', [
          conversacionId,
          timestamp,
          nombreCliente,
          cleanFrom,
          'ACTIVA',
          timestamp,
          1,
          ''
        ]);
        
        console.log(`✅ [ASESOR] Nueva conversación creada: ${conversacionId}`);

        // Guardar resumen de contexto
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

      const mensaje = yaEstabActiva
        ? `✅ *Reconectado con Asesoría*\n\nTu conversación continúa activa.\n\nEscribe tus consultas y te responderemos pronto.\n\n_Escribe "menu" para volver al menú._`
        : `✅ *Conectado con Asesoría*\n\n¡Hola ${nombreCliente}!\n\nEstás conectado con el equipo de *${negocio.nombre}*.\n\nEscribe tu consulta y te responderemos pronto.\n\n_Escribe "menu" para volver al menú._`;

      return {
        success: true,
        conversacionId,
        exists: yaEstabActiva,
        mensaje
      };

    } catch (error) {
      console.error('❌ [ASESOR] Error activando modo asesor:', error.message);
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
      const conversacion = await this.obtenerConversacionExistente(from, sheets);
      
      if (conversacion && conversacion.estado === 'ACTIVA') {
        const timestamp = new Date().toISOString();
        await sheets.updateCell(`Conversaciones_Asesor!E${conversacion.rowIndex}`, 'LISTENING');
        await sheets.updateCell(`Conversaciones_Asesor!F${conversacion.rowIndex}`, timestamp);
        await sheets.updateCell(`Conversaciones_Asesor!H${conversacion.rowIndex}`, timestamp);
        console.log(`🔄 [ASESOR] Conversación ${conversacion.id} cerrada (ahora LISTENING)`);
      }

      this.conversacionesActivas.delete(from);
      return { success: true };
    } catch (error) {
      console.error('❌ [ASESOR] Error desactivando:', error.message);
      return { success: false };
    }
  }

  /**
   * Guardar mensaje en hoja Mensajes
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

      // Actualizar última actividad
      const conversacion = await this.obtenerConversacionExistente(from, sheets);
      if (conversacion) {
        await sheets.updateCell(`Conversaciones_Asesor!F${conversacion.rowIndex}`, timestamp);
      }

      return { success: true, messageId: msgId };
    } catch (error) {
      console.log('⚠️ Error guardando mensaje:', error.message);
      return { success: false };
    }
  }

  /**
   * Guardar mensaje automático (para tracking)
   * IMPORTANTE: Reutiliza conversación existente, solo crea si no existe ninguna
   */
  async guardarMensajeAuto(from, mensaje, tipo, sheets, nombreCliente = 'Cliente') {
    try {
      const cleanFrom = this.limpiarWhatsapp(from);
      
      // Buscar conversación existente (cualquier estado)
      let conversacionExistente = await this.obtenerConversacionExistente(from, sheets);
      let conversacionId;
      
      if (conversacionExistente) {
        // Reutilizar conversación existente
        conversacionId = conversacionExistente.id;
      } else {
        // Crear nueva conversación LISTENING (primera vez)
        conversacionId = `CONV-${Date.now()}`;
        const timestamp = new Date().toISOString();
        
        await sheets.appendRow('Conversaciones_Asesor', [
          conversacionId,
          timestamp,
          nombreCliente,
          cleanFrom,
          'LISTENING',
          timestamp,
          0,
          ''
        ]);
        
        console.log(`📝 [ASESOR] Conversación LISTENING creada: ${conversacionId}`);
      }

      // Guardar mensaje
      return await this.guardarMensaje(conversacionId, from, mensaje, tipo, sheets);
    } catch (error) {
      console.log('⚠️ Error en guardarMensajeAuto:', error.message);
      return { success: false };
    }
  }

  /**
   * Obtener ID de conversación (compatibilidad)
   */
  async obtenerConversacionId(from, sheets) {
    const conv = await this.obtenerConversacionExistente(from, sheets);
    return conv ? conv.id : null;
  }

  /**
   * Generar resumen de contexto del cliente
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

    try {
      const cliente = await sheets.buscarCliente(from);
      if (cliente) {
        if (cliente.empresa) lineas.push(`Empresa: ${cliente.empresa}`);
        if (cliente.contacto) lineas.push(`Contacto: ${cliente.contacto}`);
        if (cliente.telefono) lineas.push(`Teléfono: ${cliente.telefono}`);
        if (cliente.direccion) lineas.push(`Dirección: ${cliente.direccion}`);
      } else {
        lineas.push(`Cliente nuevo - WhatsApp: ${cleanFrom}`);
      }
    } catch (e) {
      lineas.push(`WhatsApp: ${cleanFrom}`);
    }

    lineas.push('');
    lineas.push('PEDIDOS RECIENTES:');
    try {
      const pedidos = await sheets.getPedidosByWhatsapp(from);
      if (pedidos && pedidos.length > 0) {
        pedidos.slice(-3).reverse().forEach((p, i) => {
          lineas.push(`${i + 1}. ${p.fecha || 'N/A'} - S/${p.total || 0} - ${p.estado || 'N/A'}`);
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
