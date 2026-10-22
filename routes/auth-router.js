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
const axios = require('axios');
const { createJoinService, JoinError } = require('../core/services/join-service');
const { createBusinessService } = require('../core/services/business-service');

/** profiles.id is a FK to auth.users.id, so a person without a profile needs an auth user first. */
async function createMemberProfile({ email, fullName }) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '').replace(/\/rest\/v1$/, '');
  try {
    const { data } = await axios.post(`${base}/auth/v1/admin/users`, {
      email, email_confirm: true, user_metadata: { full_name: fullName || '' },
    }, { headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
    if (data && data.id) {
      if (fullName) await supabaseService.patch('profiles', { id: `eq.${data.id}` }, { full_name: fullName });
      return data.id;
    }
  } catch (err) {
    if (err.response && err.response.data && err.response.data.error_code === 'email_exists') {
      const rows = await supabaseService.get('profiles', { email: `eq.${email}`, select: 'id', limit: 1 });
      return rows && rows[0] ? rows[0].id : null;
    }
    console.error('[auth] createMemberProfile failed');
  }
  return null;
}

const identityService = createIdentityService({
  get: supabaseService.get, post: supabaseService.post, patch: supabaseService.patch,
  getNegocios: () => negociosService.getAll(), refreshNegocios: () => negociosService.loadFromFarms(),
});

const joinService = createJoinService({
  get: supabaseService.get, post: supabaseService.post, patch: supabaseService.patch,
  getNegocios: () => negociosService.getAll(), createProfile: createMemberProfile,
});

const businessService = createBusinessService({
  get: supabaseService.get, post: supabaseService.post, patch: supabaseService.patch,
  createProfile: createMemberProfile, onApproved: () => negociosService.loadFromFarms(),
});

function createAuthRouter({ service = identityService, join = joinService, business = businessService, verifyToken = t => firebaseService.verifyIdToken(t) } = {}) {
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

  function sendError(res, tag, err) {
    if (err instanceof JoinError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error(`[auth/${tag}]`, err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }

  // POST /api/auth/session -> { status, profile?, businesses? }
  router.post('/session', authenticate, async (req, res) => {
    try {
      const session = await service.resolveSession(req.identity);
      // Linked but without any business yet (for example right after asking to register one):
      // report an open request instead of sending the person back to the start.
      const noAccessYet = session.status === 'no_invitation' || (session.status === 'active' && (session.businesses || []).length === 0);
      if (noAccessYet) {
        const pending = await join.pendingFor(req.identity.uid);
        if (pending.length) return res.json({ status: 'join_pending', businessName: pending[0].businessName });
        const requested = await business.pendingFor(req.identity.uid);
        if (requested.length) return res.json({ status: 'business_pending', businessName: requested[0].businessName });
      }
      // Someone who already has businesses may also be waiting on other requests: list them.
      if (session.status === 'active') {
        const joins = await join.pendingFor(req.identity.uid);
        const requested = await business.pendingFor(req.identity.uid);
        session.pending = [
          ...joins.map(p => ({ kind: 'join', businessName: p.businessName })),
          ...requested.map(p => ({ kind: 'business', businessName: p.businessName })),
        ];
      }
      res.json(session);
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

  // POST /api/auth/join { code } -> { status: join_pending | already_member }
  router.post('/join', authenticate, async (req, res) => {
    try { res.json(await join.submit(req.identity, req.body && req.body.code)); }
    catch (err) { sendError(res, 'join', err); }
  });

  // POST /api/auth/join-codes { businessId, role?, ttlHours?, maxUses? } -> { code, expiresAt, ... } (owner)
  router.post('/join-codes', authenticate, async (req, res) => {
    try { res.json(await join.createCode(req.identity, req.body || {})); }
    catch (err) { sendError(res, 'join-codes', err); }
  });

  // GET /api/auth/join-requests?businessId=BIZ-002 (owner)
  router.get('/join-requests', authenticate, async (req, res) => {
    try { res.json({ requests: await join.listRequests(req.identity, req.query.businessId) }); }
    catch (err) { sendError(res, 'join-requests', err); }
  });

  // POST /api/auth/join-requests/:id/decision { businessId, approve } (owner)
  router.post('/join-requests/:id/decision', authenticate, async (req, res) => {
    try {
      const b = req.body || {};
      res.json(await join.decide(req.identity, b.businessId, req.params.id, b.approve === true));
    } catch (err) { sendError(res, 'join-decision', err); }
  });

  // POST /api/auth/business-requests { name, city, phone } -> { status: business_pending }
  router.post('/business-requests', authenticate, async (req, res) => {
    try { res.json(await business.submit(req.identity, req.body || {})); }
    catch (err) { sendError(res, 'business-requests', err); }
  });

  // GET /api/auth/admin/business-requests (platform admin)
  router.get('/admin/business-requests', authenticate, async (req, res) => {
    try { res.json({ requests: await business.listPending(req.identity) }); }
    catch (err) { sendError(res, 'admin-business-requests', err); }
  });

  // POST /api/auth/admin/business-requests/:id/decision { approve } (platform admin)
  router.post('/admin/business-requests/:id/decision', authenticate, async (req, res) => {
    try { res.json(await business.decide(req.identity, req.params.id, (req.body || {}).approve === true)); }
    catch (err) { sendError(res, 'admin-business-decision', err); }
  });

  return router;
}

module.exports = createAuthRouter();
module.exports.createAuthRouter = createAuthRouter;
