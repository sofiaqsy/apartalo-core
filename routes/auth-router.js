/**
 * AUTH ROUTER: session bootstrap for Google / Apple sign-in (Firebase).
 * Each call verifies the Firebase ID token itself, so it works whatever AUTH_MODE is.
 */
const express = require('express');
const { extractBearer } = require('../core/middleware/auth');
const { createIdentityService } = require('../core/services/identity-service');
const supabaseService = require('../core/services/supabase-service');
const negociosService = require('../config/negocios');
const firebaseService = require('../core/services/firebase-service');

const identityService = createIdentityService({
  get: supabaseService.get, post: supabaseService.post, patch: supabaseService.patch,
  getNegocios: () => negociosService.getAll(),
});

function createAuthRouter({ service = identityService, verifyToken = t => firebaseService.verifyIdToken(t) } = {}) {
  const router = express.Router();

  async function authenticate(req, res, next) {
    const token = extractBearer(req);
    if (!token) return res.status(401).json({ error: 'No autenticado' });
    try {
      req.identity = await verifyToken(token);
      return next();
    } catch (err) {
      if (err && err.code === 'auth/not-initialized') return res.status(503).json({ error: 'Autenticación no disponible' });
      return res.status(401).json({ error: 'Token inválido o vencido' });
    }
  }

  // POST /api/auth/session -> { status, profile?, businesses? }
  router.post('/session', authenticate, async (req, res) => {
    try {
      res.json(await service.resolveSession(req.identity));
    } catch (err) {
      console.error('[auth/session]', err.message);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // POST /api/auth/phone { phone } -> { saved, reason? }
  router.post('/phone', authenticate, async (req, res) => {
    try {
      const result = await service.savePhone(req.identity, req.body && req.body.phone);
      res.status(result.saved || result.reason === 'already-set' ? 200 : 400).json(result);
    } catch (err) {
      console.error('[auth/phone]', err.message);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  return router;
}

module.exports = createAuthRouter();
module.exports.createAuthRouter = createAuthRouter;
