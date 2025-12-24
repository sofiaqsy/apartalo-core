/**
 * APARTALO CORE - Configuración Principal
 * 
 * Carga configuración desde variables de entorno
 * y define defaults para la plataforma
 */

require('dotenv').config();

module.exports = {
  // ============================================
  // APP
  // ============================================
  app: {
    name: process.env.PLATFORM_NAME || 'ApartaLo',
    port: parseInt(process.env.PORT) || 3000,
    env: process.env.NODE_ENV || 'development',
    isDevelopment: process.env.NODE_ENV !== 'production'
  },

  // ============================================
  // WHATSAPP COMPARTIDO
  // Para negocios sin número propio
  // ============================================
  whatsappShared: {
    token: process.env.WHATSAPP_SHARED_TOKEN,
    phoneId: process.env.WHATSAPP_SHARED_PHONE_ID,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'APARTALO_VERIFY_2024',
    apiVersion: 'v21.0',
    apiUrl: 'https://graph.facebook.com'
  },

  // ============================================
  // GOOGLE
  // ============================================
  google: {
    serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    masterSpreadsheetId: process.env.MASTER_SPREADSHEET_ID,
    driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID
  },

  // ============================================
  // FEATURES DISPONIBLES
  // Cada negocio puede habilitar/deshabilitar
  // ============================================
  availableFeatures: [
    'liveCommerce',      // Ventas en vivo (LIVE)
    'catalogoWeb',       // Catálogo web público
    'asesorHumano',      // Derivar a humano
    'preciosVIP',        // Precios personalizados por cliente
    'cafeGratis',        // Promoción muestra gratis (Finca Rosal)
    'shipping',          // Sistema de envíos
    'payments',          // Validación de pagos
    'notifications'      // Notificaciones Telegram/Email
  ],

  // ============================================
  // TIPOS DE FLUJO
  // ============================================
  flowTypes: {
    ESTANDAR: 'ESTANDAR',   // Flujo ApartaLo genérico
    CUSTOM: 'CUSTOM'         // Flujo personalizado por negocio
  },

  // ============================================
  // TIPOS DE NÚMERO WHATSAPP
  // ============================================
  whatsappTypes: {
    COMPARTIDO: 'COMPARTIDO',  // Usa número de la plataforma
    PROPIO: 'PROPIO'           // Número propio del negocio
  },

  // ============================================
  // ESTADOS DE PEDIDO (compartidos)
  // ============================================
  orderStates: {
    PENDING_PAYMENT: 'PENDIENTE_PAGO',
    PENDING_VALIDATION: 'PENDIENTE_VALIDACION',
    CONFIRMED: 'CONFIRMADO',
    IN_PREPARATION: 'EN_PREPARACION',
    SHIPPED: 'ENVIADO',
    DELIVERED: 'ENTREGADO',
    CANCELLED: 'CANCELADO'
  },

  // ============================================
  // ESTADOS DE PRODUCTO
  // ============================================
  productStates: {
    ACTIVE: 'ACTIVO',
    PUBLISHED: 'PUBLICADO',
    INACTIVE: 'INACTIVO'
  }
};
