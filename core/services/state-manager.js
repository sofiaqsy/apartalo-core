/**
 * APARTALO CORE - State Manager
 * 
 * Gestiona el estado de conversaciones
 * Soporta múltiples negocios (cada usuario puede estar en diferentes negocios)
 * 
 * Clave: {whatsapp}:{businessId}
 */

class StateManager {
  constructor() {
    // Estado de conversación por usuario:negocio
    this.states = new Map();
    
    // Carrito por usuario:negocio
    this.carts = new Map();
    
    // Datos de cliente cacheados
    this.clientCache = new Map();
    
    // Negocio activo por usuario (para número compartido)
    this.activeBusinessByUser = new Map();
    
    // Suscriptores a LIVE por negocio
    this.liveSubscribers = new Map();
  }

  // ============================================
  // KEYS
  // ============================================

  /**
   * Generar key única para usuario + negocio
   */
  getKey(whatsapp, businessId) {
    const cleanPhone = this.cleanPhone(whatsapp);
    return `${cleanPhone}:${businessId}`;
  }

  cleanPhone(phone) {
    return (phone || '')
      .replace('whatsapp:', '')
      .replace('+', '')
      .replace(/[^0-9]/g, '');
  }

  // ============================================
  // ESTADO DE CONVERSACIÓN
  // ============================================

  /**
   * Obtener estado de usuario en un negocio
   */
  getState(whatsapp, businessId) {
    const key = this.getKey(whatsapp, businessId);
    return this.states.get(key) || { step: 'inicio', data: {} };
  }

  /**
   * Establecer estado
   */
  setState(whatsapp, businessId, state) {
    const key = this.getKey(whatsapp, businessId);
    this.states.set(key, state);
  }

  /**
   * Actualizar step manteniendo data
   */
  setStep(whatsapp, businessId, step) {
    const current = this.getState(whatsapp, businessId);
    this.setState(whatsapp, businessId, { ...current, step });
  }

  /**
   * Actualizar data manteniendo step
   */
  updateData(whatsapp, businessId, newData) {
    const current = this.getState(whatsapp, businessId);
    this.setState(whatsapp, businessId, {
      ...current,
      data: { ...current.data, ...newData }
    });
  }

  /**
   * Resetear estado
   */
  resetState(whatsapp, businessId) {
    const key = this.getKey(whatsapp, businessId);
    this.states.delete(key);
    this.carts.delete(key);
  }

  // ============================================
  // CARRITO
  // ============================================

  /**
   * Obtener carrito
   */
  getCart(whatsapp, businessId) {
    const key = this.getKey(whatsapp, businessId);
    return this.carts.get(key) || [];
  }

  /**
   * Agregar item al carrito
   */
  addToCart(whatsapp, businessId, item) {
    const key = this.getKey(whatsapp, businessId);
    const cart = this.carts.get(key) || [];
    
    // Verificar si ya existe el producto
    const existingIndex = cart.findIndex(i => i.codigo === item.codigo);
    
    if (existingIndex >= 0) {
      cart[existingIndex].cantidad += item.cantidad;
    } else {
      cart.push(item);
    }
    
    this.carts.set(key, cart);
    return cart;
  }

  /**
   * Limpiar carrito
   */
  clearCart(whatsapp, businessId) {
    const key = this.getKey(whatsapp, businessId);
    this.carts.delete(key);
  }

  /**
   * Obtener total del carrito
   */
  getCartTotal(whatsapp, businessId) {
    const cart = this.getCart(whatsapp, businessId);
    return cart.reduce((sum, item) => sum + (item.precio * item.cantidad), 0);
  }

  // ============================================
  // NEGOCIO ACTIVO (para número compartido)
  // ============================================

  /**
   * Obtener negocio activo del usuario
   */
  getActiveBusiness(whatsapp) {
    const cleanPhone = this.cleanPhone(whatsapp);
    return this.activeBusinessByUser.get(cleanPhone) || null;
  }

  /**
   * Establecer negocio activo
   */
  setActiveBusiness(whatsapp, businessId) {
    const cleanPhone = this.cleanPhone(whatsapp);
    this.activeBusinessByUser.set(cleanPhone, businessId);
  }

  /**
   * Limpiar negocio activo
   */
  clearActiveBusiness(whatsapp) {
    const cleanPhone = this.cleanPhone(whatsapp);
    this.activeBusinessByUser.delete(cleanPhone);
  }

  // ============================================
  // CACHE DE CLIENTES
  // ============================================

  /**
   * Obtener cliente del cache
   */
  getCachedClient(whatsapp) {
    const cleanPhone = this.cleanPhone(whatsapp);
    return this.clientCache.get(cleanPhone) || null;
  }

  /**
   * Cachear datos de cliente
   */
  cacheClient(whatsapp, clientData) {
    const cleanPhone = this.cleanPhone(whatsapp);
    this.clientCache.set(cleanPhone, {
      ...clientData,
      cachedAt: Date.now()
    });
  }

  /**
   * Invalidar cache de cliente
   */
  invalidateClientCache(whatsapp) {
    const cleanPhone = this.cleanPhone(whatsapp);
    this.clientCache.delete(cleanPhone);
  }

  // ============================================
  // SUSCRIPTORES LIVE
  // ============================================

  /**
   * Suscribir usuario a LIVE de un negocio
   */
  subscribeLive(whatsapp, businessId) {
    if (!this.liveSubscribers.has(businessId)) {
      this.liveSubscribers.set(businessId, new Set());
    }
    this.liveSubscribers.get(businessId).add(this.cleanPhone(whatsapp));
  }

  /**
   * Desuscribir de LIVE
   */
  unsubscribeLive(whatsapp, businessId) {
    if (this.liveSubscribers.has(businessId)) {
      this.liveSubscribers.get(businessId).delete(this.cleanPhone(whatsapp));
    }
  }

  /**
   * Obtener suscriptores de LIVE
   */
  getLiveSubscribers(businessId) {
    return Array.from(this.liveSubscribers.get(businessId) || []);
  }

  /**
   * Verificar si está suscrito
   */
  isSubscribedToLive(whatsapp, businessId) {
    const subscribers = this.liveSubscribers.get(businessId);
    return subscribers ? subscribers.has(this.cleanPhone(whatsapp)) : false;
  }

  // ============================================
  // UTILIDADES
  // ============================================

  /**
   * Obtener estadísticas
   */
  getStats() {
    return {
      activeStates: this.states.size,
      activeCarts: this.carts.size,
      cachedClients: this.clientCache.size,
      activeBusinesses: this.activeBusinessByUser.size,
      liveSubscribers: Array.from(this.liveSubscribers.entries()).map(([biz, subs]) => ({
        business: biz,
        count: subs.size
      }))
    };
  }

  /**
   * Limpiar estados antiguos (llamar periódicamente)
   */
  cleanup(maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    
    // Limpiar cache de clientes antiguos
    for (const [phone, data] of this.clientCache.entries()) {
      if (now - data.cachedAt > maxAgeMs) {
        this.clientCache.delete(phone);
      }
    }
  }
}

module.exports = new StateManager();
