/**
 * APARTALO CORE - Firebase Service
 * 
 * Servicio para manejar conversaciones en Firestore
 * y enviar Push Notifications con FCM
 * 
 * USO:
 *   const firebase = require('./firebase-service');
 *   await firebase.initialize();
 *   await firebase.guardarMensaje(businessId, whatsapp, mensaje);
 */

const admin = require('firebase-admin');

class FirebaseService {
  constructor() {
    this.db = null;
    this.messaging = null;
    this.initialized = false;
  }

  /**
   * Inicializar Firebase Admin SDK
   */
  async initialize() {
    try {
      if (this.initialized) return true;

      // Obtener credenciales de variable de entorno
      const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      
      if (!serviceAccountKey) {
        console.log('⚠️ Firebase no configurado (falta FIREBASE_SERVICE_ACCOUNT_KEY)');
        return false;
      }

      const serviceAccount = JSON.parse(serviceAccountKey);

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id
      });

      this.db = admin.firestore();
      this.messaging = admin.messaging();
      this.initialized = true;

      console.log('✅ Firebase inicializado correctamente');
      return true;
    } catch (error) {
      console.error('❌ Error inicializando Firebase:', error.message);
      return false;
    }
  }

  // ============================================
  // CONVERSACIONES
  // ============================================

  /**
   * Obtener referencia a conversaciones de un negocio
   */
  conversacionesRef(businessId) {
    return this.db.collection('negocios').doc(businessId).collection('conversaciones');
  }

  /**
   * Obtener referencia a mensajes de una conversación
   */
  mensajesRef(businessId, whatsapp) {
    return this.conversacionesRef(businessId).doc(whatsapp).collection('mensajes');
  }

  /**
   * Limpiar objeto de valores undefined
   */
  limpiarUndefined(obj) {
    const limpio = {};
    for (const key in obj) {
      if (obj[key] !== undefined && obj[key] !== null) {
        limpio[key] = obj[key];
      }
    }
    return limpio;
  }

  /**
   * Crear o actualizar conversación
   */
  async actualizarConversacion(businessId, whatsapp, datos) {
    if (!this.initialized) return null;

    try {
      const docRef = this.conversacionesRef(businessId).doc(whatsapp);
      const doc = await docRef.get();

      // Limpiar datos de valores undefined
      const datosLimpios = this.limpiarUndefined(datos);

      if (doc.exists) {
        // Actualizar existente - solo campos definidos
        const updateData = {
          ...datosLimpios,
          ultimoMensaje: admin.firestore.FieldValue.serverTimestamp()
        };
        await docRef.update(updateData);
      } else {
        // Crear nueva
        await docRef.set({
          whatsapp,
          nombre: datosLimpios.nombre || whatsapp,
          modo: datosLimpios.modo || 'bot',
          ultimoTexto: datosLimpios.ultimoTexto || '',
          ultimoMensaje: admin.firestore.FieldValue.serverTimestamp(),
          noLeidos: datosLimpios.noLeidos || 0,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      return true;
    } catch (error) {
      console.error('❌ Error actualizando conversación:', error.message);
      return false;
    }
  }

  /**
   * Incrementar contador de mensajes no leídos
   */
  async incrementarNoLeidos(businessId, whatsapp) {
    if (!this.initialized) return;

    try {
      const docRef = this.conversacionesRef(businessId).doc(whatsapp);
      const doc = await docRef.get();
      
      if (doc.exists) {
        await docRef.update({
          noLeidos: admin.firestore.FieldValue.increment(1)
        });
      }
    } catch (error) {
      console.error('❌ Error incrementando no leídos:', error.message);
    }
  }

  /**
   * Cambiar modo de conversación (bot, soporte, ayuda)
   */
  async cambiarModo(businessId, whatsapp, modo) {
    if (!this.initialized) return false;

    try {
      const docRef = this.conversacionesRef(businessId).doc(whatsapp);
      const doc = await docRef.get();
      
      if (doc.exists) {
        await docRef.update({ modo });
      } else {
        // Crear conversación si no existe
        await docRef.set({
          whatsapp,
          nombre: whatsapp,
          modo: modo || 'bot',
          ultimoTexto: '',
          ultimoMensaje: admin.firestore.FieldValue.serverTimestamp(),
          noLeidos: 0,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      return true;
    } catch (error) {
      console.error('❌ Error cambiando modo:', error.message);
      return false;
    }
  }

  // ============================================
  // MENSAJES
  // ============================================

  /**
   * Guardar mensaje en Firestore (CON PREVENCIÓN DE DUPLICADOS - SIN ÍNDICE)
   */
  async guardarMensaje(businessId, whatsapp, mensaje) {
    if (!this.initialized) return null;

    try {
      const texto = mensaje.texto || '';
      const origen = mensaje.origen || 'cliente';

      // 🔥 PREVENCIÓN DE DUPLICADOS - Query simple sin índice compuesto
      // Solo filtramos por timestamp, luego verificamos en memoria
      const hace10Seg = new Date(Date.now() - 10000);
      
      try {
        const mensajesRecientes = await this.mensajesRef(businessId, whatsapp)
          .where('timestamp', '>=', hace10Seg)
          .limit(20)
          .get();

        // Buscar duplicado en memoria
        for (const doc of mensajesRecientes.docs) {
          const data = doc.data();
          if (data.texto === texto && data.origen === origen) {
            console.log(`⚠️ Mensaje duplicado detectado (${whatsapp}): "${texto.substring(0, 30)}..."`);
            return doc.id;
          }
        }
      } catch (queryError) {
        // Si falla la query, continuar sin verificar (mejor guardar que perder el mensaje)
        console.log(`⚠️ No se pudo verificar duplicados: ${queryError.message}`);
      }

      // No es duplicado, guardar mensaje
      const ahora = admin.firestore.FieldValue.serverTimestamp();

      const docRef = await this.mensajesRef(businessId, whatsapp).add({
        texto: texto,
        origen: origen, // 'cliente', 'negocio', 'bot'
        tipo: mensaje.tipo || 'text', // 'text', 'image', 'audio', 'document', 'location'
        mediaUrl: mensaje.mediaUrl || null,
        metadata: mensaje.metadata || null,
        timestamp: ahora,
        leido: origen !== 'cliente'
      });

      console.log(`✅ Mensaje guardado en Firestore (${whatsapp}): "${texto.substring(0, 30)}..." [${docRef.id}]`);

      // Actualizar conversación - solo con valores definidos
      const esDelCliente = origen === 'cliente';
      const datosConv = {
        ultimoTexto: this.truncarTexto(texto, 100)
      };
      
      // Solo agregar si están definidos
      if (mensaje.nombreCliente) {
        datosConv.nombre = mensaje.nombreCliente;
      }
      if (mensaje.modo) {
        datosConv.modo = mensaje.modo;
      }
      
      await this.actualizarConversacion(businessId, whatsapp, datosConv);

      // Incrementar no leídos si es del cliente
      if (esDelCliente) {
        await this.incrementarNoLeidos(businessId, whatsapp);
      }

      return docRef.id;
    } catch (error) {
      console.error('❌ Error guardando mensaje:', error.message);
      return null;
    }
  }

  /**
   * Obtener historial de mensajes
   */
  async getMensajes(businessId, whatsapp, limite = 50) {
    if (!this.initialized) return [];

    try {
      const snapshot = await this.mensajesRef(businessId, whatsapp)
        .orderBy('timestamp', 'desc')
        .limit(limite)
        .get();

      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        timestamp: doc.data().timestamp?.toDate()
      })).reverse();
    } catch (error) {
      console.error('❌ Error obteniendo mensajes:', error.message);
      return [];
    }
  }

  // ============================================
  // PUSH NOTIFICATIONS
  // ============================================

  /**
   * Guardar token FCM de un dispositivo
   */
  async guardarTokenPush(businessId, token, metadata = {}) {
    if (!this.initialized) return false;

    try {
      await this.db
        .collection('negocios')
        .doc(businessId)
        .collection('push_tokens')
        .doc(token)
        .set({
          token,
          platform: metadata.platform || 'unknown',
          appVersion: metadata.appVersion || '1.0.0',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          lastUsed: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

      console.log(`✅ Token FCM guardado para ${businessId}`);
      return true;
    } catch (error) {
      console.error('❌ Error guardando token FCM:', error.message);
      return false;
    }
  }

  /**
   * Eliminar token FCM
   */
  async eliminarTokenPush(businessId, token) {
    if (!this.initialized) return false;

    try {
      await this.db
        .collection('negocios')
        .doc(businessId)
        .collection('push_tokens')
        .doc(token)
        .delete();

      return true;
    } catch (error) {
      console.error('❌ Error eliminando token FCM:', error.message);
      return false;
    }
  }

  /**
   * Obtener todos los tokens FCM de un negocio
   */
  async getTokensPush(businessId) {
    if (!this.initialized) return [];

    try {
      const snapshot = await this.db
        .collection('negocios')
        .doc(businessId)
        .collection('push_tokens')
        .get();

      return snapshot.docs.map(doc => doc.data().token);
    } catch (error) {
      console.error('❌ Error obteniendo tokens FCM:', error.message);
      return [];
    }
  }

  /**
   * Enviar notificación push a un negocio
   */
  async enviarNotificacion(businessId, notificacion) {
    if (!this.initialized || !this.messaging) {
      console.log('⚠️ FCM no disponible');
      return { success: 0, failure: 0 };
    }

    try {
      const tokens = await this.getTokensPush(businessId);

      if (tokens.length === 0) {
        console.log(`⚠️ No hay tokens FCM para ${businessId}`);
        return { success: 0, failure: 0 };
      }

      const mensaje = {
        notification: {
          title: notificacion.title,
          body: notificacion.body
        },
        data: notificacion.data || {},
        tokens
      };

      // Agregar configuración para iOS
      if (notificacion.badge !== undefined) {
        mensaje.apns = {
          payload: {
            aps: {
              badge: notificacion.badge,
              sound: 'default'
            }
          }
        };
      }

      const response = await this.messaging.sendEachForMulticast(mensaje);

      console.log(`📤 Notificación enviada: ${response.successCount} ok, ${response.failureCount} failed`);

      // Limpiar tokens inválidos
      if (response.failureCount > 0) {
        const tokensInvalidos = [];
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const errorCode = resp.error?.code;
            if (errorCode === 'messaging/invalid-registration-token' ||
                errorCode === 'messaging/registration-token-not-registered') {
              tokensInvalidos.push(tokens[idx]);
            }
          }
        });

        // Eliminar tokens inválidos
        for (const token of tokensInvalidos) {
          await this.eliminarTokenPush(businessId, token);
        }
      }

      return {
        success: response.successCount,
        failure: response.failureCount
      };
    } catch (error) {
      console.error('❌ Error enviando notificación:', error.message);
      return { success: 0, failure: 0 };
    }
  }

  /**
   * Notificar nuevo mensaje en modo soporte
   */
  async notificarMensajeSoporte(businessId, datos) {
    return await this.enviarNotificacion(businessId, {
      title: `💬 ${datos.nombreCliente || 'Cliente'}`,
      body: this.truncarTexto(datos.texto, 100),
      data: {
        type: 'mensaje_soporte',
        whatsapp: datos.whatsapp || '',
        nombreCliente: datos.nombreCliente || ''
      },
      badge: datos.noLeidos || 1
    });
  }

  /**
   * Notificar nuevo pedido
   */
  async notificarNuevoPedido(businessId, pedido) {
    return await this.enviarNotificacion(businessId, {
      title: '🛒 Nuevo Pedido',
      body: `${pedido.cliente} - S/ ${pedido.total.toFixed(2)}`,
      data: {
        type: 'nuevo_pedido',
        pedidoId: pedido.id || '',
        cliente: pedido.cliente || '',
        total: pedido.total?.toString() || '0'
      }
    });
  }

  /**
   * Notificar voucher recibido
   */
  async notificarVoucherRecibido(businessId, pedido) {
    return await this.enviarNotificacion(businessId, {
      title: '📸 Voucher Recibido',
      body: `Pedido ${pedido.id} - Validar pago`,
      data: {
        type: 'voucher_recibido',
        pedidoId: pedido.id || ''
      }
    });
  }

  // ============================================
  // UTILIDADES
  // ============================================

  truncarTexto(texto, maxLen) {
    if (!texto) return '';
    if (texto.length <= maxLen) return texto;
    return texto.substring(0, maxLen - 3) + '...';
  }
}

// Exportar instancia singleton
const firebaseService = new FirebaseService();
module.exports = firebaseService;