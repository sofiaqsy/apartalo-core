/**
 * APARTALO CORE - Main Application
 * 
 * Plataforma multi-tenant para comercio por WhatsApp
 * Soporta negocios con número propio y compartido
 * 
 * @version 1.0.0
 * @author Keyla Cusi - RosalCafe
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Configuración
const config = require('./config');
const negociosService = require('./config/negocios');

// Servicios core
const SheetsService = require('./core/services/sheets-service');
const DriveService = require('./core/services/drive-service');
const firebaseService = require('./core/services/firebase-service');
const stateManager = require('./core/services/state-manager');

// Rutas
const webhookRouter = require('./routes/webhook-router');
const apiRouter = require('./routes/api-router');
const uploadRouter = require('./routes/upload-router');
const clientesRouter = require('./routes/clientes-router');
const pedidosRouter = require('./routes/pedidos-router');
const botConversationsRouter = require('./routes/bot-conversations-router');
const ocrRouter = require('./routes/ocr-router');
const trackRouter = require('./routes/track-router');

// Inicializar Express
const app = express();
const server = http.createServer(app);

// Inicializar Socket.IO (para catálogo web en tiempo real)
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(express.json({ limit: '50mb' })); // Aumentar límite para imágenes base64
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS para la app móvil
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============================================
// RUTAS
// ============================================

// Health check
app.get('/', (req, res) => {
  res.json({
    platform: config.app.name,
    version: '1.0.0',
    status: 'running',
    env: config.app.env,
    timestamp: new Date().toISOString(),
    endpoints: {
      webhook: '/webhook/:businessId',
      webhookShared: '/webhook',
      health: '/health',
      api: '/api',
      clientes: '/api/clientes/:businessId',
      pedidos: '/api/pedidos/:businessId',
      upload: '/api/upload/:businessId',
      bot: '/api/bot'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    negocios: negociosService.getAll().length,
    states: stateManager.getStats(),
    firebase: firebaseService.initialized
  });
});

// Webhook de WhatsApp
app.use('/webhook', webhookRouter);

// IMPORTANTE: Registrar rutas específicas ANTES de las generales
// API específica para clientes (con estructura extendida)
app.use('/api/clientes', clientesRouter);

// API específica para pedidos (con creación desde app)
app.use('/api/pedidos', pedidosRouter);

// API para conversaciones del bot WhatsApp
app.use('/api/bot', botConversationsRouter);

// OCR para comprobantes BCP (usado por extensión Chrome)
app.use('/api/ocr', ocrRouter);

// Upload de imágenes a Google Drive
app.use('/api/upload', uploadRouter);

// API general (productos, negocios, etc.) - DESPUÉS de las específicas
app.use('/api', apiRouter);

// Track API (public — no auth required)
app.use('/api/track', trackRouter);

// Tracking page — serves HTML; JS inside fetches /api/track/:businessId/:pedidoId
app.get('/track/:businessId/:pedidoId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'track', 'index.html'));
});

// Catálogo web público
app.get('/catalogo/:businessId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'catalog', 'index.html'));
});

// Admin panel
app.get('/admin/:businessId?', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// ============================================
// SOCKET.IO - Tiempo real para catálogo
// ============================================

io.on('connection', (socket) => {
  console.log(`🔌 Socket conectado: ${socket.id}`);

  // Unirse a sala de un negocio
  socket.on('join-catalog', (businessId) => {
    socket.join(`catalog:${businessId}`);
    console.log(`   → Unido a catalog:${businessId}`);
  });

  socket.on('join-admin', (businessId) => {
    socket.join(`admin:${businessId}`);
    console.log(`   → Unido a admin:${businessId}`);
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Socket desconectado: ${socket.id}`);
  });
});

// Hacer io disponible globalmente para broadcasts
app.set('io', io);

// ============================================
// INICIALIZACIÓN
// ============================================

async function initialize() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║     █████╗ ██████╗  █████╗ ██████╗ ████████╗ █████╗     ║
║    ██╔══██╗██╔══██╗██╔══██╗██╔══██╗╚══██╔══╝██╔══██╗    ║
║    ███████║██████╔╝███████║██████╔╝   ██║   ███████║    ║
║    ██╔══██║██╔═══╝ ██╔══██║██╔══██╗   ██║   ██╔══██║    ║
║    ██║  ██║██║     ██║  ██║██║  ██║   ██║   ██║  ██║    ║
║    ╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝    ║
║                     CORE v1.0.0                          ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
  `);

  console.log('🚀 Inicializando plataforma...\n');

  // 1. Inicializar servicios
  console.log('📦 Cargando servicios...');
  
  // Google Drive
  try {
    const driveService = new DriveService();
    await driveService.initialize();
    console.log('   ✅ Google Drive');
  } catch (e) {
    console.log('   ⚠️ Google Drive:', e.message);
  }

  // Firebase (Firestore + FCM)
  const firebaseOk = await firebaseService.initialize();
  console.log(`   ${firebaseOk ? '✅' : '⚠️'} Firebase (Firestore + FCM)`);

  // 2. Cargar negocios
  console.log('\n🏪 Cargando negocios...');
  
  if (config.google.masterSpreadsheetId) {
    const masterSheets = new SheetsService(config.google.masterSpreadsheetId);
    const sheetsOk = await masterSheets.initialize();
    
    if (sheetsOk) {
      await negociosService.initialize(masterSheets);
    } else {
      negociosService.loadFromLocal();
    }
  } else {
    negociosService.loadFromLocal();
  }

  // Mostrar negocios cargados
  const negocios = negociosService.getAll();
  console.log(`\n📋 Negocios activos: ${negocios.length}`);
  negocios.forEach(n => {
    const tipo = n.whatsapp.tipo === 'PROPIO' ? '📱' : '🔗';
    console.log(`   ${tipo} ${n.nombre} (${n.id}) - ${n.flujo}`);
  });

  // 3. Inicializar handlers
  console.log('\n⚙️ Cargando handlers...');
  webhookRouter.initializeHandlers();

  // 4. Iniciar servidor
  const PORT = config.app.port;
  
  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                   SERVIDOR INICIADO                      ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║   🌐 URL: http://localhost:${PORT.toString().padEnd(29)}║
║   📱 Webhook: /webhook/:businessId                       ║
║   📱 Webhook compartido: /webhook                        ║
║   📊 Admin: /admin/:businessId                           ║
║   🛒 Catálogo: /catalogo/:businessId                     ║
║   📤 Upload: /api/upload/:businessId                     ║
║   👥 Clientes: /api/clientes/:businessId                 ║
║   📦 Pedidos: /api/pedidos/:businessId                   ║
║   🤖 Bot: /api/bot                                       ║
║   🔥 Firebase: ${firebaseOk ? 'ACTIVO' : 'NO CONFIGURADO'}                              ║
║   ❤️ Health: /health                                     ║
║                                                          ║
║   📦 Negocios: ${negocios.length.toString().padEnd(40)}║
║   🔧 Modo: ${(config.app.isDevelopment ? 'DESARROLLO' : 'PRODUCCIÓN').padEnd(39)}║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
    `);
  });
}

// ============================================
// ERROR HANDLING
// ============================================

app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: config.app.isDevelopment ? err.message : 'Something went wrong'
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.url}`
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n🔄 SIGTERM recibido, cerrando...');
  server.close(() => {
    console.log('✅ Servidor cerrado');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n🔄 SIGINT recibido, cerrando...');
  server.close(() => {
    console.log('✅ Servidor cerrado');
    process.exit(0);
  });
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Rejection:', error);
});

// Iniciar
initialize();

module.exports = app;
