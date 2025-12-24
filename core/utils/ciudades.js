/**
 * APARTALO CORE - Ciudades de Perú
 * 
 * Mapeo de ciudades a departamentos
 * Usado para detectar departamento desde ciudad ingresada
 */

const DEPARTAMENTOS = {
  'AMAZONAS': ['CHACHAPOYAS', 'BAGUA', 'BONGARA', 'CONDORCANQUI', 'LUYA', 'RODRIGUEZ DE MENDOZA', 'UTCUBAMBA'],
  'ANCASH': ['HUARAZ', 'AIJA', 'ANTONIO RAYMONDI', 'ASUNCION', 'BOLOGNESI', 'CARHUAZ', 'CARLOS FERMIN FITZCARRALD', 'CASMA', 'CORONGO', 'HUARI', 'HUARMEY', 'HUAYLAS', 'MARISCAL LUZURIAGA', 'OCROS', 'PALLASCA', 'POMABAMBA', 'RECUAY', 'SANTA', 'SIHUAS', 'YUNGAY', 'CHIMBOTE'],
  'APURIMAC': ['ABANCAY', 'ANDAHUAYLAS', 'ANTABAMBA', 'AYMARAES', 'COTABAMBAS', 'CHINCHEROS', 'GRAU'],
  'AREQUIPA': ['AREQUIPA', 'CAMANA', 'CARAVELI', 'CASTILLA', 'CAYLLOMA', 'CONDESUYOS', 'ISLAY', 'LA UNION', 'MOLLENDO', 'MEJIA'],
  'AYACUCHO': ['HUAMANGA', 'AYACUCHO', 'CANGALLO', 'HUANCA SANCOS', 'HUANTA', 'LA MAR', 'LUCANAS', 'PARINACOCHAS', 'PAUCAR DEL SARA SARA', 'SUCRE', 'VICTOR FAJARDO', 'VILCAS HUAMAN'],
  'CAJAMARCA': ['CAJAMARCA', 'CAJABAMBA', 'CELENDIN', 'CHOTA', 'CONTUMAZA', 'CUTERVO', 'HUALGAYOC', 'JAEN', 'SAN IGNACIO', 'SAN MARCOS', 'SAN MIGUEL', 'SAN PABLO', 'SANTA CRUZ'],
  'CALLAO': ['CALLAO', 'BELLAVISTA', 'CARMEN DE LA LEGUA', 'LA PERLA', 'LA PUNTA', 'VENTANILLA', 'MI PERU'],
  'CUSCO': ['CUSCO', 'ACOMAYO', 'ANTA', 'CALCA', 'CANAS', 'CANCHIS', 'CHUMBIVILCAS', 'ESPINAR', 'LA CONVENCION', 'PARURO', 'PAUCARTAMBO', 'QUISPICANCHI', 'URUBAMBA', 'SICUANI', 'QUILLABAMBA'],
  'HUANCAVELICA': ['HUANCAVELICA', 'ACOBAMBA', 'ANGARAES', 'CASTROVIRREYNA', 'CHURCAMPA', 'HUAYTARA', 'TAYACAJA'],
  'HUANUCO': ['HUANUCO', 'AMBO', 'DOS DE MAYO', 'HUACAYBAMBA', 'HUAMALIES', 'LEONCIO PRADO', 'MARANON', 'PACHITEA', 'PUERTO INCA', 'LAURICOCHA', 'YAROWILCA', 'TINGO MARIA'],
  'ICA': ['ICA', 'CHINCHA', 'NASCA', 'NAZCA', 'PALPA', 'PISCO', 'CHINCHA ALTA'],
  'JUNIN': ['HUANCAYO', 'CONCEPCION', 'CHANCHAMAYO', 'JAUJA', 'JUNIN', 'SATIPO', 'TARMA', 'YAULI', 'CHUPACA', 'LA OROYA', 'LA MERCED', 'SAN RAMON'],
  'LA LIBERTAD': ['TRUJILLO', 'ASCOPE', 'BOLIVAR', 'CHEPEN', 'JULCAN', 'OTUZCO', 'PACASMAYO', 'PATAZ', 'SANCHEZ CARRION', 'SANTIAGO DE CHUCO', 'GRAN CHIMU', 'VIRU', 'HUAMACHUCO'],
  'LAMBAYEQUE': ['CHICLAYO', 'FERREÑAFE', 'LAMBAYEQUE', 'MORROPE', 'TUCUME', 'OLMOS', 'MOTUPE'],
  'LIMA': ['LIMA', 'BARRANCA', 'CAJATAMBO', 'CANTA', 'CAÑETE', 'HUARAL', 'HUAROCHIRI', 'HUAURA', 'OYON', 'YAUYOS', 'MIRAFLORES', 'SAN ISIDRO', 'SURCO', 'LA MOLINA', 'SAN BORJA', 'JESUS MARIA', 'LINCE', 'PUEBLO LIBRE', 'MAGDALENA', 'SAN MIGUEL', 'BREÑA', 'LA VICTORIA', 'RIMAC', 'CERCADO', 'ATE', 'SANTA ANITA', 'EL AGUSTINO', 'SAN JUAN DE LURIGANCHO', 'COMAS', 'INDEPENDENCIA', 'LOS OLIVOS', 'SAN MARTIN DE PORRES', 'VILLA EL SALVADOR', 'VILLA MARIA DEL TRIUNFO', 'SAN JUAN DE MIRAFLORES', 'CHORRILLOS', 'BARRANCO', 'SURQUILLO', 'LURIN', 'PACHACAMAC', 'PUCUSANA', 'PUNTA HERMOSA', 'PUNTA NEGRA', 'SAN BARTOLO', 'SANTA MARIA DEL MAR', 'CHACLACAYO', 'CHOSICA', 'LURIGANCHO', 'CARABAYLLO', 'PUENTE PIEDRA', 'ANCON', 'SANTA ROSA', 'HUACHO', 'CHANCAY', 'ASIA', 'MALA', 'SAN VICENTE', 'IMPERIAL'],
  'LORETO': ['IQUITOS', 'MAYNAS', 'ALTO AMAZONAS', 'LORETO', 'MARISCAL RAMON CASTILLA', 'REQUENA', 'UCAYALI', 'DATEM DEL MARAÑON', 'PUTUMAYO', 'YURIMAGUAS', 'NAUTA'],
  'MADRE DE DIOS': ['PUERTO MALDONADO', 'MANU', 'TAHUAMANU', 'TAMBOPATA'],
  'MOQUEGUA': ['MOQUEGUA', 'GENERAL SANCHEZ CERRO', 'ILO', 'MARISCAL NIETO'],
  'PASCO': ['CERRO DE PASCO', 'PASCO', 'DANIEL ALCIDES CARRION', 'OXAPAMPA'],
  'PIURA': ['PIURA', 'AYABACA', 'HUANCABAMBA', 'MORROPON', 'PAITA', 'SULLANA', 'TALARA', 'SECHURA', 'CATACAOS', 'CASTILLA', 'TAMBOGRANDE'],
  'PUNO': ['PUNO', 'AZANGARO', 'CARABAYA', 'CHUCUITO', 'EL COLLAO', 'HUANCANE', 'LAMPA', 'MELGAR', 'MOHO', 'SAN ANTONIO DE PUTINA', 'SAN ROMAN', 'SANDIA', 'YUNGUYO', 'JULIACA', 'AYAVIRI', 'ILAVE'],
  'SAN MARTIN': ['MOYOBAMBA', 'BELLAVISTA', 'EL DORADO', 'HUALLAGA', 'LAMAS', 'MARISCAL CACERES', 'PICOTA', 'RIOJA', 'SAN MARTIN', 'TOCACHE', 'TARAPOTO', 'JUANJUI'],
  'TACNA': ['TACNA', 'CANDARAVE', 'JORGE BASADRE', 'TARATA'],
  'TUMBES': ['TUMBES', 'CONTRALMIRANTE VILLAR', 'ZARUMILLA'],
  'UCAYALI': ['PUCALLPA', 'CORONEL PORTILLO', 'ATALAYA', 'PADRE ABAD', 'PURUS', 'AGUAYTIA']
};

/**
 * Detectar departamento desde texto de ciudad
 */
function detectarDepartamento(ciudad) {
  if (!ciudad) return null;
  
  const ciudadUpper = ciudad.toUpperCase().trim();
  
  // Buscar coincidencia exacta o parcial
  for (const [departamento, ciudades] of Object.entries(DEPARTAMENTOS)) {
    // Coincidencia exacta con departamento
    if (ciudadUpper === departamento) {
      return departamento;
    }
    
    // Buscar en ciudades del departamento
    for (const c of ciudades) {
      if (ciudadUpper === c || ciudadUpper.includes(c) || c.includes(ciudadUpper)) {
        return departamento;
      }
    }
  }
  
  // Búsqueda más flexible (primeras letras)
  for (const [departamento, ciudades] of Object.entries(DEPARTAMENTOS)) {
    for (const c of ciudades) {
      if (c.startsWith(ciudadUpper) || ciudadUpper.startsWith(c.substring(0, 4))) {
        return departamento;
      }
    }
  }
  
  return null;
}

/**
 * Obtener lista de departamentos
 */
function getDepartamentos() {
  return Object.keys(DEPARTAMENTOS).sort();
}

/**
 * Obtener ciudades de un departamento
 */
function getCiudadesByDepartamento(departamento) {
  return DEPARTAMENTOS[departamento.toUpperCase()] || [];
}

/**
 * Verificar si es Lima Metropolitana
 */
function esLimaMetropolitana(ciudad) {
  const ciudadUpper = (ciudad || '').toUpperCase();
  const distritosLima = DEPARTAMENTOS['LIMA'];
  const distritosCallao = DEPARTAMENTOS['CALLAO'];
  
  return distritosLima.includes(ciudadUpper) || distritosCallao.includes(ciudadUpper);
}

/**
 * Normalizar nombre de ciudad
 */
function normalizarCiudad(ciudad) {
  if (!ciudad) return '';
  
  return ciudad
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Quitar acentos
    .trim();
}

module.exports = {
  DEPARTAMENTOS,
  detectarDepartamento,
  getDepartamentos,
  getCiudadesByDepartamento,
  esLimaMetropolitana,
  normalizarCiudad
};
