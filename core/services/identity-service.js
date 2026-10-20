/**
 * IDENTITY: maps a verified Firebase identity (Google / Apple) to an existing profile.
 *
 * Authorization is NOT decided here: the user can only act on the businesses listed in
 * farm_members. This service only answers "who is this person" and creates a pending
 * link when a verified email matches exactly one member profile. A pending link grants
 * nothing until it is confirmed (status 'active') by someone with database access.
 *
 * Emails of the form <phone>@whatsapp.apartalo.co are placeholders for WhatsApp
 * customers and are never matched. Phone numbers from the client are never used to link.
 */

const FAKE_EMAIL_DOMAIN = '@whatsapp.apartalo.co';
const MEMBER_ROLES = ['owner', 'staff', 'roaster'];

/** Canonical phone: country code 51 + 9 digits. Returns null when it cannot be trusted. */
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (/^9\d{8}$/.test(digits)) return '51' + digits;
  if (/^519\d{8}$/.test(digits)) return digits;
  return null;
}

const escapeLike = s => String(s).replace(/[\\%_*]/g, c => '\\' + c);

function createIdentityService({ get, post, patch, getNegocios, log = console } = {}) {
  async function businessesFor(profileId) {
    const members = await get('farm_members', {
      user_id: `eq.${profileId}`, role: `in.(${MEMBER_ROLES.join(',')})`, select: 'farm_id,role',
    });
    const negocios = getNegocios();
    return (members || [])
      .map(m => {
        const n = negocios.find(x => x.farmId === m.farm_id);
        return n ? { businessId: n.id, name: n.nombre || n.nombreComercial || n.id, role: m.role } : null;
      })
      .filter(Boolean);
  }

  async function getProfile(profileId) {
    const rows = await get('profiles', { id: `eq.${profileId}`, select: 'id,full_name,phone' });
    return rows && rows[0] ? rows[0] : null;
  }

  /** @returns {{status:'active'|'pending'|'no_invitation'|'revoked', profile?, businesses?}} */
  async function resolveSession(identity) {
    const rows = await get('firebase_identities', { firebase_uid: `eq.${identity.uid}`, select: 'profile_id,status' });
    const link = rows && rows[0];

    if (link) {
      if (link.status === 'active') {
        const profile = await getProfile(link.profile_id);
        return { status: 'active', profile: { id: profile.id, fullName: profile.full_name || '', hasPhone: !!profile.phone }, businesses: await businessesFor(link.profile_id) };
      }
      return { status: link.status === 'revoked' ? 'revoked' : 'pending' };
    }

    const email = identity.email && identity.emailVerified ? String(identity.email).trim().toLowerCase() : null;
    if (!email || email.endsWith(FAKE_EMAIL_DOMAIN)) return { status: 'no_invitation' };

    const matches = await get('profiles', { email: `ilike.${escapeLike(email)}`, select: 'id', limit: 2 });
    if (!matches || matches.length !== 1) return { status: 'no_invitation' };   // none, or ambiguous

    const businesses = await businessesFor(matches[0].id);
    if (businesses.length === 0) return { status: 'no_invitation' };            // a customer, not a member

    await post('firebase_identities', { firebase_uid: identity.uid, profile_id: matches[0].id, provider: identity.provider || null, status: 'pending' });
    log.log('[IDENTITY] pending link created');
    return { status: 'pending' };
  }

  /** Stores the phone on the profile only when it is empty and not used by another profile. */
  async function savePhone(identity, rawPhone) {
    const phone = normalizePhone(rawPhone);
    if (!phone) return { saved: false, reason: 'invalid-phone' };

    const rows = await get('firebase_identities', { firebase_uid: `eq.${identity.uid}`, select: 'profile_id,status' });
    const link = rows && rows[0];
    if (!link || link.status !== 'active') return { saved: false, reason: 'not-active' };

    const profile = await getProfile(link.profile_id);
    if (profile.phone) return { saved: false, reason: 'already-set' };

    const used = await get('profiles', { phone: `eq.${phone}`, select: 'id', limit: 1 });
    if (used && used[0]) return { saved: false, reason: 'phone-in-use' };

    await patch('profiles', { id: `eq.${profile.id}` }, { phone });
    return { saved: true };
  }

  return { resolveSession, savePhone };
}

module.exports = { createIdentityService, normalizePhone, FAKE_EMAIL_DOMAIN };
