/**
 * BUSINESS REGISTRATION: "I own a business".
 *
 * Uses the platform's existing farm workflow instead of a parallel table:
 *   - a person asks to register -> a farm is inserted with status 'pending' (same as the website)
 *   - a platform admin (profiles.is_admin = true) approves it -> farms.status = 'approved'
 *   - the database trigger handle_farm_approved() then creates the wallet and the owner
 *     membership in farm_members. This service never writes farm_members itself.
 *
 * Nothing grants access until the farm is approved: a pending farm has no membership row.
 */
const { normalizePhone } = require('./identity-service');
const { JoinError } = require('./join-service');

const slugify = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function createBusinessService({ get, post, patch, createProfile, onApproved = async () => {}, log = console, randomSuffix = () => Math.random().toString(36).slice(2, 6) } = {}) {
  async function identityRow(uid) {
    const rows = await get('firebase_identities', { firebase_uid: `eq.${uid}`, select: 'profile_id,status', limit: 1 });
    return rows && rows[0] ? rows[0] : null;
  }
  async function activeProfileId(uid) {
    const row = await identityRow(uid);
    return row && row.status === 'active' ? row.profile_id : null;
  }

  async function requireAdmin(identity) {
    const profileId = await activeProfileId(identity.uid);
    if (!profileId) throw new JoinError(403, 'forbidden', 'Sin acceso');
    const rows = await get('profiles', { id: `eq.${profileId}`, is_admin: 'eq.true', select: 'id', limit: 1 });
    if (!rows || !rows[0]) throw new JoinError(403, 'forbidden', 'Sin acceso');
    return profileId;
  }

  /** The person's profile: the linked one, or a new one. Never takes over a member's or admin's profile. */
  async function ensureProfile(identity) {
    const existing = await identityRow(identity.uid);
    if (existing) {
      if (existing.status !== 'active') throw new JoinError(409, 'identity-unresolved', 'Esta cuenta tiene un vínculo sin resolver');
      return existing.profile_id;
    }
    if (!identity.email || !identity.emailVerified) throw new JoinError(422, 'email-required', 'Necesitas una cuenta con correo verificado');

    const matches = await get('profiles', { email: `eq.${identity.email}`, select: 'id,is_admin', limit: 1 });
    let profileId;
    if (matches && matches[0]) {
      const m = await get('farm_members', { user_id: `eq.${matches[0].id}`, select: 'farm_id', limit: 1 });
      if (matches[0].is_admin || (m && m[0])) throw new JoinError(409, 'identity-unresolved', 'Esta cuenta ya existe y debe vincularla el administrador');
      profileId = matches[0].id;
    } else {
      profileId = await createProfile({ email: identity.email, fullName: identity.name || '' });
      if (!profileId) throw new JoinError(502, 'profile-failed', 'No se pudo crear el perfil');
    }
    await post('firebase_identities', { firebase_uid: identity.uid, profile_id: profileId, provider: identity.provider || null, status: 'active', confirmed_at: new Date().toISOString() });
    return profileId;
  }

  async function uniqueSlug(name) {
    const base = slugify(name) || 'negocio';
    for (const candidate of [base, `${base}-${randomSuffix()}`, `${base}-${randomSuffix()}`]) {
      const taken = await get('farms', { slug: `eq.${candidate}`, select: 'id', limit: 1 });
      if (!taken || !taken[0]) return candidate;
    }
    throw new JoinError(409, 'slug-taken', 'No se pudo generar un identificador único');
  }

  async function submit(identity, { name, city, phone } = {}) {
    const businessName = String(name || '').trim();
    const cityName = String(city || '').trim();
    // The business phone is optional; when given it must be a valid number.
    const rawPhone = String(phone || '').trim();
    const contactPhone = rawPhone ? normalizePhone(rawPhone) : null;
    if (businessName.length < 3 || businessName.length > 80) throw new JoinError(400, 'invalid-name', 'Escribe el nombre del negocio (3 a 80 caracteres)');
    if (cityName.length < 2 || cityName.length > 60) throw new JoinError(400, 'invalid-city', 'Escribe la ciudad');
    if (rawPhone && !contactPhone) throw new JoinError(400, 'invalid-phone', 'Número inválido. Usa 9 dígitos, por ejemplo 987654321.');

    const profileId = await ensureProfile(identity);
    const open = await get('farms', { owner_id: `eq.${profileId}`, status: 'eq.pending', select: 'id', limit: 1 });
    if (open && open[0]) return { status: 'business_pending' };

    await post('farms', {
      slug: await uniqueSlug(businessName), name: businessName, city: cityName, country: 'Perú', currency: 'PEN', kind: 'hybrid',
      contact_email: identity.email || null, contact_phone: contactPhone, owner_id: profileId, status: 'pending',
    });
    log.log('[BUSINESS] pending farm created');
    return { status: 'business_pending' };
  }

  async function pendingFor(uid) {
    const profileId = await activeProfileId(uid);
    if (!profileId) return [];
    const rows = await get('farms', { owner_id: `eq.${profileId}`, status: 'eq.pending', select: 'name' });
    return (rows || []).map(r => ({ businessName: r.name }));
  }

  async function listPending(identity) {
    await requireAdmin(identity);
    const farms = await get('farms', { status: 'eq.pending', select: 'id,name,city,contact_phone,contact_email,owner_id,created_at', order: 'created_at.asc' });
    const out = [];
    for (const f of farms || []) {
      const owner = await get('profiles', { id: `eq.${f.owner_id}`, select: 'full_name', limit: 1 });
      out.push({ id: f.id, name: (owner && owner[0] && owner[0].full_name) || '', email: f.contact_email || '', businessName: f.name, city: f.city || '', phone: f.contact_phone || '', createdAt: f.created_at });
    }
    return out;
  }

  async function decide(identity, farmId, approve) {
    await requireAdmin(identity);
    const rows = await get('farms', { id: `eq.${farmId}`, select: 'id,status', limit: 1 });
    const farm = rows && rows[0];
    if (!farm) throw new JoinError(404, 'not-found', 'Solicitud no encontrada');
    if (farm.status !== 'pending') throw new JoinError(409, 'already-decided', 'La solicitud ya fue resuelta');
    await patch('farms', { id: `eq.${farm.id}`, status: 'eq.pending' }, { status: approve ? 'approved' : 'rejected' });
    if (approve) await onApproved();
    return { status: approve ? 'approved' : 'rejected' };
  }

  return { submit, pendingFor, listPending, decide };
}

module.exports = { createBusinessService, slugify };
