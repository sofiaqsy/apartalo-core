# ApartaLo Core

Plataforma multi-tenant para comercio por WhatsApp. Soporta negocios con número propio y número compartido.

## 🏗️ Arquitectura

```
┌─────────────────────────────────────────────────────────────────┐
│                    APARTALO CORE PLATFORM                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   WEBHOOK ROUTER                                                │
│   ├── /webhook/:businessId  →  Número PROPIO                   │
│   └── /webhook              →  Número COMPARTIDO               │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │                    CORE ENGINE                           │  │
│   │  • WhatsApp Service    • Sheets Service                  │  │
│   │  • State Manager       • Drive Service                   │  │
│   │  • Formatters          • Ciudades (Perú)                 │  │
│   └─────────────────────────────────────────────────────────┘  │
│                              │                                  │
│              ┌───────────────┴───────────────┐                 │
│              ▼                               ▼                 │
│   ┌─────────────────────┐      ┌─────────────────────┐        │
│   │  HANDLER ESTÁNDAR   │      │  HANDLERS CUSTOM    │        │
│   │     (ApartaLo)      │      │  • finca-rosal      │        │
│   │                     │      │  • tu-negocio       │        │
│   └─────────────────────┘      └─────────────────────┘        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 🚀 Instalación

```bash
# Clonar repositorio
git clone https://github.com/tu-usuario/apartalo-core.git
cd apartalo-core

# Instalar dependencias
npm install

# Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales

# Iniciar servidor
npm start

# Desarrollo con auto-reload
npm run dev
```

## ⚙️ Configuración

### Variables de Entorno

```env
# App
NODE_ENV=development
PORT=3000

# WhatsApp Compartido
WHATSAPP_SHARED_TOKEN=tu_token
WHATSAPP_SHARED_PHONE_ID=tu_phone_id
WHATSAPP_VERIFY_TOKEN=APARTALO_VERIFY_2024

# Google
GOOGLE_SERVICE_ACCOUNT_KEY={"type":"service_account",...}
MASTER_SPREADSHEET_ID=tu_spreadsheet_id
GOOGLE_DRIVE_FOLDER_ID=tu_folder_id
```

### Google Sheets Master

El spreadsheet maestro debe tener una hoja `Negocios` con las columnas:

| A | B | C | D | E | F | G | H | I | J | K |
|---|---|---|---|---|---|---|---|---|---|---|
| ID | Nombre | WhatsappTipo | PhoneId | Token | SpreadsheetId | WebhookPath | Flujo | Features | Prefijo | Estado |

Ejemplo:
```
finca-rosal | Finca Rosal | PROPIO | 123456 | TOKEN... | SHEET_ID | /webhook/finca-rosal | CUSTOM | asesorHumano,preciosVIP | ROSAL | ACTIVO
tienda-demo | Demo Tienda | COMPARTIDO | | | SHEET_ID | /webhook | ESTANDAR | liveCommerce | DEMO | ACTIVO
```

## 📁 Estructura

```
apartalo-core/
├── app.js                    # Entry point
├── config/
│   ├── index.js             # Configuración global
│   └── negocios.js          # Servicio de negocios
├── core/
│   ├── services/
│   │   ├── whatsapp-service.js
│   │   ├── sheets-service.js
│   │   ├── drive-service.js
│   │   └── state-manager.js
│   └── utils/
│       ├── formatters.js
│       └── ciudades.js
├── routes/
│   └── webhook-router.js    # Router de webhooks
├── handlers/
│   ├── estandar/            # Flujo por defecto
│   │   └── index.js
│   └── finca-rosal/         # Flujo custom
│       └── index.js
└── public/
    ├── catalog/             # Web catálogo
    └── admin/               # Panel admin
```

## 🔌 Agregar un nuevo negocio

### Opción 1: Número Compartido (usa el número de ApartaLo)

1. Agregar fila en `Negocios` del Master Spreadsheet
2. Crear spreadsheet para el negocio con hojas: `Clientes`, `Pedidos`, `Inventario`, `Configuracion`
3. El negocio usará el flujo estándar automáticamente

### Opción 2: Número Propio

1. Crear app en Meta Business Suite
2. Configurar webhook apuntando a `/webhook/tu-negocio`
3. Agregar fila en `Negocios` con tipo `PROPIO` y credenciales
4. (Opcional) Crear handler custom en `handlers/tu-negocio/index.js`

### Opción 3: Handler Personalizado

```javascript
// handlers/tu-negocio/index.js

async function handle(from, message, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  
  // Tu lógica personalizada
  await whatsapp.sendMessage(from, 'Hola desde tu negocio!');
}

module.exports = { handle };
```

## 🎯 Features disponibles

| Feature | Descripción |
|---------|-------------|
| `liveCommerce` | Ventas en vivo con reserva FIFO |
| `catalogoWeb` | Catálogo público con Socket.IO |
| `asesorHumano` | Derivar a humano vía Sheets |
| `preciosVIP` | Precios personalizados por cliente |
| `cafeGratis` | Promoción muestra gratis |
| `shipping` | Sistema de envíos con courier |
| `payments` | Validación de comprobantes |

## 📊 API Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/` | Info de la plataforma |
| GET | `/health` | Estado del servidor |
| POST | `/webhook/:businessId` | Webhook número propio |
| POST | `/webhook` | Webhook número compartido |
| GET | `/api/negocios` | Lista de negocios |
| POST | `/api/negocios/reload` | Recargar negocios |
| GET | `/catalogo/:businessId` | Web catálogo |
| GET | `/admin/:businessId` | Panel admin |

## 🚀 Deploy

### Heroku

```bash
heroku create tu-apartalo-core
heroku config:set WHATSAPP_SHARED_TOKEN=...
heroku config:set GOOGLE_SERVICE_ACCOUNT_KEY=...
git push heroku main
```

### Railway / Render

Similar a Heroku, configura las variables de entorno y despliega.

## 📝 Licencia

MIT - Keyla Cusi / RosalCafe
