/**
 * APARTALO CORE - Handler Unificado - Constantes
 * 
 * Constantes compartidas entre módulos del handler
 */

// Estados finalizados - no mostrar como activos
const ESTADOS_FINALIZADOS = ['ENTREGADO', 'CANCELADO', 'COMPLETADO'];

// Keywords para detección de muestras gratis
const KEYWORDS_MUESTRA = [
  'muestra', 'promocafe', 'promo', 'gratis', 'gratuito', 
  'prueba', 'degustacion', 'degustación', 'sample', '500g', 'medio kilo'
];

// Comandos globales
const COMANDOS_GLOBALES = {
  MENU: ['menu', 'inicio'],
  CANCELAR: ['cancelar'],
  AYUDA: ['ayuda', 'contactar', 'asesor', 'hablar con alguien']
};

module.exports = {
  ESTADOS_FINALIZADOS,
  KEYWORDS_MUESTRA,
  COMANDOS_GLOBALES
};
