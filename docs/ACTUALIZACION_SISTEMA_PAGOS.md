# Actualización: Sistema de Pagos en ApartaLo Core

## 📋 Resumen de Cambios

Se ha actualizado el sistema de pedidos para soportar **estado de pago** y **registro de monto pagado** (parcial o total). Esto permite que la app móvil pueda marcar pedidos como pagados y registrar pagos parciales.

## 🆕 Nuevos Campos en Google Sheets

La hoja **`Pedidos`** ahora debe tener las siguientes columnas adicionales:

| Columna | Campo | Tipo | Descripción | Ejemplo |
|---------|-------|------|-------------|---------|
| **P** | `estadoPago` | String | Estado del pago | `PENDIENTE_PAGO`, `PARCIAL`, `PAGADO` |
| **Q** | `montoPagado` | Number | Monto que ya se ha pagado | `50.00` |
| **R** | `fechaPago` | String (ISO) | Fecha en que se completó el pago | `2026-02-02T15:30:00.000Z` |

### Estados de Pago Disponibles:

- **`PENDIENTE_PAGO`**: No se ha recibido ningún pago
- **`PARCIAL`**: Se ha recibido un pago parcial (montoPagado < total)
- **`PAGADO`**: Pago completado (montoPagado >= total)

## 🔧 Cambios en el Backend

### Archivo Actualizado: `routes/pedidos-router.js`

#### 1. **GET Pedidos** - Ahora incluye campos de pago

```javascript
// Antes (columnas A:O)
const rows = await sheets.getRows('Pedidos!A:O');

// Ahora (columnas A:R)
const rows = await sheets.getRows('Pedidos!A:R');

// Objeto pedido ahora incluye:
{
  // ... campos existentes
  estadoPago: row[15] || 'PENDIENTE_PAGO',
  montoPagado: parseFloat(row[16]) || 0,
  fechaPago: row[17] || ''
}
```

#### 2. **POST Crear Pedido** - Inicializa campos de pago

```javascript
const valores = [
  // ... campos existentes
  estadoPago || 'PENDIENTE_PAGO',  // P
  montoPagado || 0,                 // Q
  ''                                // R (fechaPago vacío)
];
```

#### 3. **PUT Actualizar Pedido** - Soporta actualización de estado de pago

```javascript
// Nuevos parámetros aceptados:
{
  estadoPago: 'PAGADO',      // Actualiza estado de pago
  montoPagado: 150.50,       // Actualiza monto pagado
  fechaPago: '2026-02-02...' // Actualiza fecha (opcional)
}

// Si se marca como PAGADO sin fecha, se registra automáticamente
if (estadoPago === 'PAGADO' && !fechaPago) {
  fechaPago = new Date().toISOString();
}
```

## 📱 Integración con la App Móvil

La app móvil ya está configurada para usar estos endpoints. El método `actualizarEstadoPago` en `api_service.dart` hace lo siguiente:

```dart
// Cuando el usuario marca como pagado:
ApiService.actualizarEstadoPago(
  pedidoId: 'PED-12345',
  estadoPago: 'PAGADO',      // o 'PARCIAL'
  montoPagado: 150.00,       // monto ingresado
);
```

### Flujo de Uso en la App:

1. Usuario abre el detalle de un pedido **COMPLETADO**
2. Ve la sección "Estado de Pago" con el botón **"Marcar como Pagado"**
3. Ingresa el monto recibido
4. La app determina automáticamente:
   - `PAGADO` si `monto >= total`
   - `PARCIAL` si `0 < monto < total`
5. Se actualiza en Google Sheets vía API

## 🔄 Endpoints Actualizados

### PUT `/api/pedidos/:businessId/:pedidoId`

**Body (nuevos campos opcionales):**
```json
{
  "estadoPago": "PAGADO",
  "montoPagado": 150.00,
  "fechaPago": "2026-02-02T15:30:00.000Z"
}
```

**Respuesta:**
```json
{
  "success": true,
  "mensaje": "Pedido actualizado",
  "pedidoId": "PED-12345"
}
```

### GET `/api/pedidos/:businessId/:pedidoId`

**Respuesta (campos adicionales):**
```json
{
  "id": "PED-12345",
  "total": 150.00,
  "estado": "COMPLETADO",
  "estadoPago": "PAGADO",
  "montoPagado": 150.00,
  "fechaPago": "2026-02-02T15:30:00.000Z",
  // ... otros campos
}
```

## ✅ Pasos para Implementar

### 1. Actualizar Google Sheets

Agrega las columnas en la hoja **Pedidos**:

| A | B | ... | O | **P** | **Q** | **R** |
|---|---|-----|---|-------|-------|-------|
| ID | Fecha | ... | Origen | **estadoPago** | **montoPagado** | **fechaPago** |

### 2. Actualizar el Código

Reemplaza el archivo `routes/pedidos-router.js` con la versión actualizada.

### 3. Reiniciar el Servidor

```bash
npm start
# o si estás en desarrollo
npm run dev
```

### 4. Verificar

Prueba desde la app móvil:
- Crea un pedido
- Márcalo como COMPLETADO
- Registra un pago parcial o total
- Verifica que se actualice en Google Sheets

## 📊 Ejemplo de Datos en Sheets

| ID | Total | Estado | **estadoPago** | **montoPagado** | **fechaPago** |
|----|-------|--------|----------------|-----------------|---------------|
| PED-001 | 100.00 | COMPLETADO | PENDIENTE_PAGO | 0 | |
| PED-002 | 150.00 | COMPLETADO | PARCIAL | 50.00 | |
| PED-003 | 200.00 | COMPLETADO | PAGADO | 200.00 | 2026-02-02T15:30:00.000Z |

## 🎯 Beneficios

1. **Control de pagos**: Sabe qué pedidos están pendientes de pago
2. **Pagos parciales**: Soporta abonos y pagos en cuotas
3. **Historial**: Registra fecha exacta del pago completo
4. **Alertas**: La app muestra días sin pago para pedidos pendientes
5. **Reportes**: Fácil filtrar pedidos por estado de pago

## 🔍 Compatibilidad

- ✅ Pedidos antiguos sin estos campos se tratan como `PENDIENTE_PAGO` con `montoPagado = 0`
- ✅ La app móvil ya está actualizada y lista para usar estos campos
- ✅ No afecta el funcionamiento de pedidos creados desde WhatsApp Bot
- ✅ Compatible con el sistema de evidencias existente

---

**Autor**: Keyla Cusi - RosalCafe  
**Fecha**: Febrero 2026  
**Versión**: 1.1.0
