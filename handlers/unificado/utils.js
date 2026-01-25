/**
 * APARTALO CORE - Handler Unificado - Utilidades
 * 
 * Funciones de utilidad compartidas entre módulos
 */

/**
 * Merge inteligente de datos (no sobrescribe con null)
 */
function mergeDatasSinNull(acumulado, nuevo) {
  if (!nuevo) return acumulado;
  
  const resultado = { ...acumulado };
  
  for (const key in nuevo) {
    if (nuevo[key] !== null && nuevo[key] !== undefined && nuevo[key] !== '') {
      resultado[key] = nuevo[key];
    }
  }
  
  return resultado;
}

/**
 * Formatear productos para Google Sheets
 * Formato: "6x Cafe 250g - S/90.00" (legible y parseable)
 */
function formatearProductosParaSheets(productos) {
  if (!Array.isArray(productos)) {
    productos = [productos];
  }
  
  return productos.map(p => {
    const cantidad = p.cantidad || 1;
    const nombre = p.nombre || 'Producto';
    const subtotal = (p.precio || 0) * cantidad;
    return cantidad + 'x ' + nombre + ' - S/' + subtotal.toFixed(2);
  }).join(', ');
}

/**
 * Parsear detalle completo de un pedido
 * Extrae: producto, cantidad, precioUnitario, total
 */
function parsearDetallePedido(pedido) {
  const resultado = {
    producto: 'Producto',
    cantidad: '1',
    precioUnitario: 0,
    total: parseFloat(pedido.total) || 0
  };
  
  const productosStr = pedido.productos || '';
  
  try {
    // Formato: "5x Cafe Blend de tipico, caturra, pache - S/350.00"
    const match = productosStr.match(/^(\d+)x\s+(.+?)\s+-\s+S\/(\d+\.?\d*)/);
    if (match) {
      const cantidadNum = parseFloat(match[1]);
      resultado.cantidad = match[1];
      resultado.producto = match[2];
      const subtotal = parseFloat(match[3]);
      resultado.precioUnitario = cantidadNum > 0 ? subtotal / cantidadNum : subtotal;
      resultado.total = subtotal;
      return resultado;
    }
    
    // Intentar parsear como JSON
    if (productosStr.startsWith('[') || productosStr.startsWith('{')) {
      const productos = JSON.parse(productosStr);
      if (Array.isArray(productos) && productos.length > 0) {
        const p = productos[0];
        resultado.producto = p.nombre || p.name || 'Producto';
        resultado.cantidad = String(p.cantidad || p.qty || 1);
        resultado.precioUnitario = parseFloat(p.precio || p.price || 0);
        resultado.total = resultado.precioUnitario * parseFloat(resultado.cantidad);
        return resultado;
      }
    }
    
    // Si no se pudo parsear, usar el texto como nombre
    resultado.producto = productosStr.substring(0, 50) || 'Pedido';
    
  } catch (e) {
    resultado.producto = productosStr.substring(0, 50) || 'Pedido';
  }
  
  // Calcular precio unitario si tenemos total y cantidad
  const cantNum = parseFloat(resultado.cantidad) || 1;
  if (resultado.precioUnitario === 0 && resultado.total > 0) {
    resultado.precioUnitario = resultado.total / cantNum;
  }
  
  return resultado;
}

/**
 * Extraer nombre de producto de cualquier formato
 * Soporta JSON y texto plano
 */
function extraerNombreProducto(productosStr) {
  if (!productosStr) return 'Pedido';
  
  try {
    // Intentar parsear como JSON
    if (productosStr.startsWith('[') || productosStr.startsWith('{')) {
      const productos = JSON.parse(productosStr);
      if (Array.isArray(productos) && productos.length > 0) {
        const p = productos[0];
        const nombre = p.nombre || p.name || 'Producto';
        const cantidad = p.cantidad || p.qty || 1;
        return nombre + ' x' + cantidad;
      }
    }
    
    // Si es texto plano tipo "3x Cafe - S/45.00"
    const match = productosStr.match(/^(\d+)x\s+(.+?)\s+-/);
    if (match) {
      return match[2] + ' x' + match[1];
    }
    
    return productosStr.substring(0, 30);
  } catch (e) {
    return productosStr.substring(0, 30) || 'Pedido';
  }
}

module.exports = {
  mergeDatasSinNull,
  formatearProductosParaSheets,
  parsearDetallePedido,
  extraerNombreProducto
};
