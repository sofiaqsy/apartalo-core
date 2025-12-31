/**
 * APARTALO CORE - Formatters
 * 
 * Funciones de formateo reutilizables (sin emojis)
 */

/**
 * Formatear precio en soles
 */
function formatPrice(amount, currency = 'S/') {
  const num = parseFloat(amount) || 0;
  return `${currency} ${num.toFixed(2)}`;
}

/**
 * Formatear fecha en formato peruano
 */
function formatDate(date) {
  if (!date) return '';
  
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  
  return d.toLocaleDateString('es-PE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

/**
 * Formatear fecha y hora
 */
function formatDateTime(date) {
  if (!date) return '';
  
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  
  return d.toLocaleString('es-PE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Formatear hora
 */
function formatTime(date) {
  if (!date) return '';
  
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  
  return d.toLocaleTimeString('es-PE', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Obtener saludo según hora del día
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Buenos días';
  if (hour < 18) return 'Buenas tardes';
  return 'Buenas noches';
}

/**
 * Generar ID único
 */
function generateId(prefix = 'ID') {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${prefix}-${timestamp}${random}`;
}

/**
 * Limpiar número de teléfono
 */
function cleanPhone(phone) {
  return (phone || '')
    .replace('whatsapp:', '')
    .replace('+', '')
    .replace(/[^0-9]/g, '');
}

/**
 * Formatear número de teléfono para mostrar
 */
function formatPhone(phone) {
  const clean = cleanPhone(phone);
  
  // Formato peruano: +51 999 999 999
  if (clean.length === 11 && clean.startsWith('51')) {
    return `+${clean.slice(0, 2)} ${clean.slice(2, 5)} ${clean.slice(5, 8)} ${clean.slice(8)}`;
  }
  
  // Formato con código de país
  if (clean.length > 9) {
    return `+${clean}`;
  }
  
  return clean;
}

/**
 * Truncar texto con ellipsis
 */
function truncate(text, maxLength = 50) {
  if (!text || text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Capitalizar primera letra
 */
function capitalize(text) {
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

/**
 * Formatear lista de productos para mensaje
 */
function formatProductList(productos) {
  return productos.map((p, i) => {
    const nombre = typeof p === 'string' ? p : p.nombre;
    const cantidad = p.cantidad ? ` x${p.cantidad}` : '';
    const precio = p.precio ? ` - ${formatPrice(p.precio)}` : '';
    return `${i + 1}. ${nombre}${cantidad}${precio}`;
  }).join('\n');
}

/**
 * Formatear estado de pedido (sin emojis)
 */
function formatOrderStatus(estado) {
  const statusMap = {
    'PENDIENTE_PAGO': 'Pendiente de pago',
    'PENDIENTE_VALIDACION': 'Validando pago',
    'CONFIRMADO': 'Confirmado',
    'EN_PREPARACION': 'En preparación',
    'ENVIADO': 'Enviado',
    'ENTREGADO': 'Entregado',
    'CANCELADO': 'Cancelado'
  };
  
  return statusMap[estado] || estado;
}

module.exports = {
  formatPrice,
  formatDate,
  formatDateTime,
  formatTime,
  getGreeting,
  generateId,
  cleanPhone,
  formatPhone,
  truncate,
  capitalize,
  formatProductList,
  formatOrderStatus
};
