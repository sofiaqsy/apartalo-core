/**
 * BUSINESS REQUESTS: "I own a business".
 *
 * A signed-in person asks to register a business. Nothing is created until a platform
 * admin (profiles.role = 'admin', linked to an active Firebase identity) approves it.
 * Approval creates the farm, the owner membership and the identity link.
 */
const { normalizePhone } = require('./identity-service');
const { JoinError } = require('./join-service');

const slugify = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function createBusinessService({ get, post, patch, createProfile, onApproved = async () => {}, log = console, now = () => new Date(), randomSuffix = () => Math.random().toString(36).slice(2, 6) } = {}) {
  async function activeProfileId(uid) {
    const rows = await get('firebase_identities', { firebase_uid: `eq.${uid}`, select: 'profile_id,status', limit: 1 });
    return rows && rows[0] && rows[0].status === 'active' ? rows[0].profile_id : null;
  }

  async function requireAdmin(identity) {
    const profileId = await activeProfileId(identity.uid);
    if (!profileId) throw new JoinError(403, 'forbidden', 'Sin acceso');
    const rows = await get('profiles', { id: `eq.${profileId}`, role: 'eq.admin', select: 'id', limit: 1 });
    if (!rows || !rows[0]) throw new JoinError(403, 'forbidden', 'Sin acceso');
    return profileId;
  }

  async function submit(identity, { name, city, phone } = {}) {
    const businessName = String(name || '').trim();
    const cityName = String(city || '').trim();
    const contactPhone = normalizePhone(phone);
    if (businessName.length < 3 || businessName.length > 80) throw new JoinError(400, 'invalid-name', 'Escribe el nombre del negocio (3 a 80 caracteres)');
    if (cityName.length < 2 || cityName.length > 60) throw new JoinError(400, 'invalid-city', 'Escribe la ciudad');
    if (!contactPhone) throw new JoinError(400, 'invalid-phone', 'Número inválido. Usa 9 dígitos, por ejemplo 987654321.');

    const open = await get('business_requests', { firebase_uid: `eq.${identity.uid}`, status: 'eq.pending', select: 'id', limit: 1 });
    if (open && open[0]) return { status: 'business_pending' };

    await post('business_requests', {
      firebase_uid: identity.uid, display_name: identity.name || null, email: identity.email || null,
      business_name: businessName, city: cityName, contact_phone: contactPhone,
    });
    log.log('[BUSINESS] request created');
    return { status: 'business_pending' };
  }

  async function pendingFor(uid) {
    const rows = await get('business_requests', { firebase_uid: `eq.${uid}`, status: 'eq.pending', select: 'business_name' });
    return (rows || []).map(r => ({ businessName: r.business_name }));
  }

  async function listPending(identity) {
    await requireAdmin(identity);
    const rows = await get('business_requests', { status: 'eq.pending', select: 'id,display_name,email,business_name,city,contact_phone,created_at', order: 'created_at.asc' });
    return (rows || []).map(r => ({ id: r.id, name: r.display_name || '', email: r.email || '', businessName: r.business_name, city: r.city, phone: r.contact_phone, createdAt: r.created_at }));
  }

  async function uniqueSlug(name) {
    const base = slugify(name) || 'negocio';
    for (const candidate of [base, `${base}-${randomSuffix()}`, `${base}-${randomSuffix()}`]) {
      const taken = await get('farms', { slug: `eq.${candidate}`, select: 'id', limit: 1 });
      if (!taken || !taken[0]) return candidate;
    }
    throw new JoinError(409, 'slug-taken', 'No se pudo generar un identificador único');
  }

  async function decide(identity, requestId, approve) {
    const adminId = await requireAdmin(identity);
    const rows = await get('business_requests', { id: `eq.${requestId}`, select: 'id,firebase_uid,display_name,email,business_name,city,contact_phone,status', limit: 1 });
    const r = rows && rows[0];
    if (!r) throw new JoinError(404, 'not-found', 'Solicitud no encontrada');
    if (r.status !== 'pending') throw new JoinError(409, 'already-decided', 'La solicitud ya fue resuelta');

    let farmId = null;
    if (approve) {
      let profileId = await activeProfileId(r.firebase_uid);
      if (!profileId) {
        const existing = await get('firebase_identities', { firebase_uid: `eq.${r.firebase_uid}`, select: 'status', limit: 1 });
        if (existing && existing[0]) throw new JoinError(409, 'identity-unresolved', 'Esta cuenta tiene un vínculo sin resolver');
        if (!r.email) throw new JoinError(422, 'no-email', 'La cuenta no tiene correo para crear el perfil');
        profileId = await createProfile({ email: r.email, fullName: r.display_name || '' });
        if (!profileId) throw new JoinError(502, 'profile-failed', 'No se pudo crear el perfil');
        await post('firebase_identities', { firebase_uid: r.firebase_uid, profile_id: profileId, provider: null, status: 'active', confirmed_at: now().toISOString() });
      }
      const slug = await uniqueSlug(r.business_name);
      const farm = await post('farms', {
        slug, name: r.business_name, city: r.city, country: 'Perú', currency: 'PEN', kind: 'hybrid',
        contact_email: r.email, contact_phone: r.contact_phone, owner_id: profileId, status: 'approved',
      });
      farmId = Array.isArray(farm) ? farm[0].id : farm.id;
      await post('farm_members', { farm_id: farmId, user_id: profileId, role: 'owner' });
      await onApproved();
    }
    await patch('business_requests', { id: `eq.${r.id}` }, { status: approve ? 'approved' : 'rejected', farm_id: farmId, decided_at: now().toISOString(), decided_by: adminId });
    return { status: approve ? 'approved' : 'rejected' };
  }

  return { submit, pendingFor, listPending, decide };
}

module.exports = { createBusinessService, slugify };
