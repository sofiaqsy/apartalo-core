/**
 * JOIN: staff invitations with owner approval.
 *
 *   owner creates a temporary code  ->  person enters it  ->  pending request
 *   owner approves  ->  only now are the profile, identity link and farm_members row created
 *
 * A business can opt in to join without approval (table farm_join_settings, VR Coffee 3 Nov 2026):
 * then entering its code gives staff access at once, and the request is saved as approved by the
 * code's creator. Without that row, a code identifies a business and never grants access by itself. Codes are stored hashed,
 * expire, can be revoked and have a use limit. Everything here assumes the caller already
 * proved who they are (verified Firebase identity).
 */
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';        // no 0/O/1/I
// farm_members.role only allows 'owner' and 'staff' (database CHECK constraint).
const INVITABLE_ROLES = ['staff'];

class JoinError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

const normalizeCode = raw => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = code => crypto.createHash('sha256').update(code).digest('hex');
function generateCode() {
  const bytes = crypto.randomBytes(8);
  const chars = Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function createJoinService({ get, post, patch, getNegocios, createProfile, log = console, now = () => new Date() } = {}) {
  const negocioById = id => getNegocios().find(n => n.id === id) || null;
  const farmName = farmId => { const n = getNegocios().find(x => x.farmId === farmId); return n ? (n.nombre || n.id) : ''; };

  async function activeProfileId(uid) {
    const rows = await get('firebase_identities', { firebase_uid: `eq.${uid}`, select: 'profile_id,status' });
    return rows && rows[0] && rows[0].status === 'active' ? rows[0].profile_id : null;
  }

  /** Throws unless the caller is an active owner of the business. */
  async function requireOwner(identity, businessId) {
    const negocio = negocioById(businessId);
    if (!negocio || !negocio.farmId) throw new JoinError(404, 'unknown-business', 'Negocio no encontrado');
    const profileId = await activeProfileId(identity.uid);
    if (!profileId) throw new JoinError(403, 'forbidden', 'Sin acceso');
    const m = await get('farm_members', { user_id: `eq.${profileId}`, farm_id: `eq.${negocio.farmId}`, role: 'eq.owner', select: 'role', limit: 1 });
    if (!m || !m[0]) throw new JoinError(403, 'forbidden', 'Sin acceso');
    return { profileId, farmId: negocio.farmId };
  }

  async function createCode(identity, { businessId, role = 'staff', ttlHours = 48, maxUses = 1 } = {}) {
    const { profileId, farmId } = await requireOwner(identity, businessId);
    if (!INVITABLE_ROLES.includes(role)) throw new JoinError(400, 'invalid-role', 'Rol no válido');
    const ttl = Math.min(Math.max(parseInt(ttlHours, 10) || 48, 1), 168);
    const uses = Math.min(Math.max(parseInt(maxUses, 10) || 1, 1), 20);
    const code = generateCode();
    const expiresAt = new Date(now().getTime() + ttl * 3600 * 1000).toISOString();
    await post('join_codes', { farm_id: farmId, code_hash: hashCode(normalizeCode(code)), role, max_uses: uses, expires_at: expiresAt, created_by: profileId });
    return { code, role, maxUses: uses, expiresAt };       // the only time the code is visible
  }

  async function submit(identity, rawCode) {
    const code = normalizeCode(rawCode);
    if (code.length !== 8) throw new JoinError(400, 'invalid-code', 'Código no válido');
    const rows = await get('join_codes', { code_hash: `eq.${hashCode(code)}`, select: 'id,farm_id,role,max_uses,uses,expires_at,revoked_at,created_by', limit: 1 });
    const c = rows && rows[0];
    // One generic answer for unknown, expired, revoked or used-up codes: no hints to guessers.
    if (!c || c.revoked_at || new Date(c.expires_at) <= now() || c.uses >= c.max_uses) {
      throw new JoinError(400, 'invalid-code', 'Código no válido o vencido');
    }

    const profileId = await activeProfileId(identity.uid);
    if (profileId) {
      const m = await get('farm_members', { user_id: `eq.${profileId}`, farm_id: `eq.${c.farm_id}`, select: 'role', limit: 1 });
      if (m && m[0]) return { status: 'already_member' };
    }
    const open = await get('join_requests', { farm_id: `eq.${c.farm_id}`, firebase_uid: `eq.${identity.uid}`, status: 'eq.pending', select: 'id', limit: 1 });
    if (open && open[0]) return { status: 'join_pending', businessName: farmName(c.farm_id) };

    // Take one use only if nobody else did meanwhile.
    const taken = await patch('join_codes', { id: `eq.${c.id}`, uses: `eq.${c.uses}` }, { uses: c.uses + 1 });
    if (!taken || taken.length === 0) throw new JoinError(400, 'invalid-code', 'Código no válido o vencido');

    const created = await post('join_requests', {
      farm_id: c.farm_id, code_id: c.id, firebase_uid: identity.uid,
      display_name: identity.name || null, email: identity.email || null, requested_role: c.role,
    });
    log.log('[JOIN] request created');
    const request = created && created[0];
    if (request && await joinsWithoutApproval(c.farm_id)) {
      try {
        await grant({ ...request, status: 'pending' }, c.farm_id, c.created_by || null);
        log.log('[JOIN] joined without approval');
        return { status: 'joined', businessName: farmName(c.farm_id) };
      } catch (err) {
        // The request stays pending, so an owner can still approve it by hand.
        log.error('[JOIN] could not join without approval:', err.code || err.message);
      }
    }
    return { status: 'join_pending', businessName: farmName(c.farm_id) };
  }

  async function joinsWithoutApproval(farmId) {
    const rows = await get('farm_join_settings', { farm_id: `eq.${farmId}`, select: 'join_without_approval', limit: 1 });
    return !!(rows && rows[0] && rows[0].join_without_approval === true);
  }

  /** Creates the profile, identity link and membership for a pending request, then marks it approved. */
  async function grant(r, farmId, deciderId) {
    let profileId = await activeProfileId(r.firebase_uid);
    if (!profileId) {
      const existing = await get('firebase_identities', { firebase_uid: `eq.${r.firebase_uid}`, select: 'status', limit: 1 });
      if (existing && existing[0]) throw new JoinError(409, 'identity-unresolved', 'Esta cuenta tiene un vínculo sin resolver');
      if (!r.email) throw new JoinError(422, 'no-email', 'La cuenta no tiene correo para crear el perfil');
      profileId = await createProfile({ email: r.email, fullName: r.display_name || '' });
      if (!profileId) throw new JoinError(502, 'profile-failed', 'No se pudo crear el perfil');
      await post('firebase_identities', { firebase_uid: r.firebase_uid, profile_id: profileId, provider: null, status: 'active', confirmed_at: now().toISOString() });
    }
    await post('farm_members', { farm_id: farmId, user_id: profileId, role: r.requested_role });
    await patch('join_requests', { id: `eq.${r.id}` }, { status: 'approved', decided_at: now().toISOString(), decided_by: deciderId });
  }

  async function pendingFor(uid) {
    const rows = await get('join_requests', { firebase_uid: `eq.${uid}`, status: 'eq.pending', select: 'farm_id' });
    return (rows || []).map(r => ({ businessName: farmName(r.farm_id) }));
  }

  async function listRequests(identity, businessId) {
    const { farmId } = await requireOwner(identity, businessId);
    const rows = await get('join_requests', { farm_id: `eq.${farmId}`, status: 'eq.pending', select: 'id,display_name,email,requested_role,created_at', order: 'created_at.asc' });
    return (rows || []).map(r => ({ id: r.id, name: r.display_name || '', email: r.email || '', role: r.requested_role, createdAt: r.created_at }));
  }

  async function decide(identity, businessId, requestId, approve) {
    const { profileId: ownerId, farmId } = await requireOwner(identity, businessId);
    const rows = await get('join_requests', { id: `eq.${requestId}`, select: 'id,farm_id,firebase_uid,display_name,email,requested_role,status', limit: 1 });
    const r = rows && rows[0];
    if (!r || r.farm_id !== farmId) throw new JoinError(404, 'not-found', 'Solicitud no encontrada');   // another business's request looks missing
    if (r.status !== 'pending') throw new JoinError(409, 'already-decided', 'La solicitud ya fue resuelta');

    if (approve) {
      await grant(r, farmId, ownerId);
      return { status: 'approved' };
    }
    await patch('join_requests', { id: `eq.${r.id}` }, { status: 'rejected', decided_at: now().toISOString(), decided_by: ownerId });
    return { status: 'rejected' };
  }

  return { createCode, submit, pendingFor, listRequests, decide };
}

module.exports = { createJoinService, JoinError, normalizeCode, hashCode, generateCode, INVITABLE_ROLES };
