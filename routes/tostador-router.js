/**
 * TOSTADOR ROUTER
 * Endpoints para la app móvil de tostadores.
 * Auth: phone lookup → profile_id stored locally on device.
 * Media: stored in Supabase Storage, URLs tracked in notes as JSON.
 */

const express = require('express');
const router = express.Router();
const axios  = require('axios');

// ── helpers ──────────────────────────────────────────────────────────────────
function base() {
  return (process.env.SUPABASE_URL || '').replace(/\/$/, '').replace(/\/rest\/v1$/, '');
}
function headers(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...extra,
  };
}
function rest(path) { return `${base()}/rest/v1${path}`; }

// Notes are stored as JSON: { text?: string, media?: string[] }
function parseNotes(raw) {
  if (!raw) return { text: '', media: [] };
  try { return { text: '', media: [], ...JSON.parse(raw) }; }
  catch { return { text: raw, media: [] }; }
}
function serializeNotes(obj) { return JSON.stringify(obj); }

// ── POST /api/tostador/login ──────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone requerido' });

    const normalized = String(phone).replace(/^\+?51/, '').replace(/\D/g, '');
    const variants = [normalized, '+51' + normalized, '51' + normalized];

    let profile = null;
    for (const v of variants) {
      const url = rest('/profiles') + `?select=id,full_name,phone&phone=eq.${encodeURIComponent(v)}&limit=1`;
      const { data } = await axios.get(url, { headers: headers() });
      if (data?.[0]) { profile = data[0]; break; }
    }

    if (!profile) {
      return res.status(404).json({ error: 'Tostador no encontrado. Verifica tu número.' });
    }

    const fmUrl = rest('/farm_members') + `?select=farm_id,role&user_id=eq.${profile.id}`;
    const { data: memberships } = await axios.get(fmUrl, { headers: headers() });

    if (!memberships?.length) {
      return res.status(403).json({ error: 'No tienes acceso a ninguna finca.' });
    }

    res.json({
      profile_id: profile.id,
      full_name: profile.full_name || 'Tostador',
      farm_count: memberships.length,
    });
  } catch (err) {
    console.error('[tostador/login]', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /api/tostador/events?profileId=...&statuses=planned,in_progress ───────
router.get('/events', async (req, res) => {
  try {
    const { profileId, statuses } = req.query;
    if (!profileId) return res.status(400).json({ error: 'profileId requerido' });

    const fmUrl = rest('/farm_members') + `?select=farm_id&user_id=eq.${profileId}`;
    const { data: memberships } = await axios.get(fmUrl, { headers: headers() });
    if (!memberships?.length) return res.json([]);

    const farmIds    = memberships.map(m => m.farm_id);
    const statusList = statuses
      ? statuses.split(',').map(s => s.trim()).filter(Boolean)
      : ['planned', 'in_progress'];

    const evUrl = rest('/roast_events')
      + `?select=id,farm_id,status,roasted_at,completed_at,green_in_kg,cached_lot_code,cached_harvest_year,notes,created_at`
      + `&farm_id=in.(${farmIds.join(',')})&status=in.(${statusList.join(',')})`
      + `&order=roasted_at.asc`;

    const { data: events } = await axios.get(evUrl, { headers: headers() });

    const uniqueFarmIds = [...new Set((events || []).map(e => e.farm_id))];
    let farmMap = {};
    if (uniqueFarmIds.length) {
      const { data: farms } = await axios.get(
        rest('/farms') + `?select=id,name&id=in.(${uniqueFarmIds.join(',')})`,
        { headers: headers() }
      );
      for (const f of (farms || [])) farmMap[f.id] = f.name;
    }

    const result = (events || []).map(ev => {
      const notes = parseNotes(ev.notes);
      return { ...ev, farm_name: farmMap[ev.farm_id] || 'Finca', notes_text: notes.text, media_urls: notes.media };
    });

    result.sort((a, b) => {
      const o = { in_progress: 0, planned: 1 };
      return (o[a.status] ?? 2) - (o[b.status] ?? 2);
    });

    res.json(result);
  } catch (err) {
    console.error('[tostador/events]', err.message);
    res.status(500).json({ error: 'Error obteniendo eventos' });
  }
});

// ── GET /api/tostador/history?profileId=...&page=0 ───────────────────────────
router.get('/history', async (req, res) => {
  try {
    const { profileId, page = 0 } = req.query;
    if (!profileId) return res.status(400).json({ error: 'profileId requerido' });

    const fmUrl = rest('/farm_members') + `?select=farm_id&user_id=eq.${profileId}`;
    const { data: memberships } = await axios.get(fmUrl, { headers: headers() });
    if (!memberships?.length) return res.json([]);

    const farmIds = memberships.map(m => m.farm_id);
    const offset  = parseInt(page) * 20;

    const evUrl = rest('/roast_events')
      + `?select=id,farm_id,status,roasted_at,completed_at,green_in_kg,cached_lot_code,cached_harvest_year,notes,created_at`
      + `&farm_id=in.(${farmIds.join(',')})&status=eq.completed`
      + `&order=completed_at.desc&limit=20&offset=${offset}`;

    const { data: events } = await axios.get(evUrl, { headers: headers() });

    const uniqueFarmIds = [...new Set((events || []).map(e => e.farm_id))];
    let farmMap = {};
    if (uniqueFarmIds.length) {
      const { data: farms } = await axios.get(
        rest('/farms') + `?select=id,name&id=in.(${uniqueFarmIds.join(',')})`,
        { headers: headers() }
      );
      for (const f of (farms || [])) farmMap[f.id] = f.name;
    }

    res.json((events || []).map(ev => {
      const notes = parseNotes(ev.notes);
      return { ...ev, farm_name: farmMap[ev.farm_id] || 'Finca', notes_text: notes.text, media_urls: notes.media };
    }));
  } catch (err) {
    console.error('[tostador/history]', err.message);
    res.status(500).json({ error: 'Error obteniendo historial' });
  }
});

// ── POST /api/tostador/events/:id/start ──────────────────────────────────────
router.post('/events/:id/start', async (req, res) => {
  try {
    const { id } = req.params;
    const { profileId } = req.body;
    if (!profileId) return res.status(400).json({ error: 'profileId requerido' });

    const { data: [event] } = await axios.get(
      rest('/roast_events') + `?select=id,farm_id,status&id=eq.${id}`,
      { headers: headers() }
    );
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });
    if (event.status !== 'planned') return res.status(400).json({ error: `Estado inválido: ${event.status}` });

    const { data: fm } = await axios.get(
      rest('/farm_members') + `?select=farm_id&user_id=eq.${profileId}&farm_id=eq.${event.farm_id}`,
      { headers: headers() }
    );
    if (!fm?.length) return res.status(403).json({ error: 'Sin acceso a esta finca' });

    const roastedAt = new Date().toISOString();
    await axios.patch(
      rest('/roast_events') + `?id=eq.${id}`,
      { status: 'in_progress', roasted_at: roastedAt, updated_at: roastedAt },
      { headers: headers() }
    );

    res.json({ ok: true, roasted_at: roastedAt });
  } catch (err) {
    console.error('[tostador/events/start]', err.message);
    res.status(500).json({ error: 'Error iniciando tueste' });
  }
});

// ── POST /api/tostador/events/:id/complete ────────────────────────────────────
router.post('/events/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const { profileId, notesText } = req.body;
    if (!profileId) return res.status(400).json({ error: 'profileId requerido' });

    const { data: [event] } = await axios.get(
      rest('/roast_events') + `?select=id,farm_id,status,notes&id=eq.${id}`,
      { headers: headers() }
    );
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });
    if (event.status !== 'in_progress') return res.status(400).json({ error: `Estado inválido: ${event.status}` });

    const { data: fm } = await axios.get(
      rest('/farm_members') + `?select=farm_id&user_id=eq.${profileId}&farm_id=eq.${event.farm_id}`,
      { headers: headers() }
    );
    if (!fm?.length) return res.status(403).json({ error: 'Sin acceso a esta finca' });

    const completedAt = new Date().toISOString();
    const expiresAt   = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 6);

    // Preserve existing media URLs, update text
    const existing = parseNotes(event.notes);
    const newNotes = serializeNotes({ text: notesText || existing.text, media: existing.media });

    await axios.patch(
      rest('/roast_events') + `?id=eq.${id}`,
      { status: 'completed', completed_at: completedAt, updated_at: completedAt, notes: newNotes },
      { headers: headers() }
    );

    res.json({ ok: true, completed_at: completedAt, expires_at: expiresAt.toISOString() });
  } catch (err) {
    console.error('[tostador/events/complete]', err.message);
    res.status(500).json({ error: 'Error finalizando tueste' });
  }
});

// ── POST /api/tostador/events/:id/media ──────────────────────────────────────
// Body JSON: { profileId, base64: "data:image/jpeg;base64,...", filename? }
router.post('/events/:id/media', async (req, res) => {
  try {
    const { id } = req.params;
    const { profileId, base64, filename } = req.body;
    if (!profileId) return res.status(400).json({ error: 'profileId requerido' });
    if (!base64)    return res.status(400).json({ error: 'base64 requerido' });

    const { data: [event] } = await axios.get(
      rest('/roast_events') + `?select=id,farm_id,notes&id=eq.${id}`,
      { headers: headers() }
    );
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });

    const { data: fm } = await axios.get(
      rest('/farm_members') + `?select=farm_id&user_id=eq.${profileId}&farm_id=eq.${event.farm_id}`,
      { headers: headers() }
    );
    if (!fm?.length) return res.status(403).json({ error: 'Sin acceso a esta finca' });

    // Parse base64
    const matches = base64.match(/^data:([^;]+);base64,(.+)$/s);
    if (!matches) return res.status(400).json({ error: 'base64 inválido' });
    const mimeType   = matches[1];
    const fileBuffer = Buffer.from(matches[2], 'base64');
    const ext        = mimeType.split('/')[1]?.split('+')[0] || 'jpg';
    const fname      = filename || `${Date.now()}.${ext}`;
    const storagePath = `roast-events/${id}/${fname}`;

    // Upload to Supabase Storage (farm-assets bucket)
    const storageUrl = `${base()}/storage/v1/object/farm-assets/${storagePath}`;
    await axios.post(storageUrl, fileBuffer, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': mimeType,
        'x-upsert': 'true',
      },
      maxBodyLength: Infinity,
    });

    const publicUrl = `${base()}/storage/v1/object/public/farm-assets/${storagePath}`;

    // Append to notes JSON
    const existing = parseNotes(event.notes);
    existing.media = [...(existing.media || []), publicUrl];
    const newNotes = serializeNotes(existing);

    await axios.patch(
      rest('/roast_events') + `?id=eq.${id}`,
      { notes: newNotes, updated_at: new Date().toISOString() },
      { headers: headers() }
    );

    res.json({ ok: true, url: publicUrl, media_urls: existing.media });
  } catch (err) {
    console.error('[tostador/events/media]', err.message, err.response?.data);
    res.status(500).json({ error: 'Error subiendo media' });
  }
});

// ── DELETE /api/tostador/events/:id/media ─────────────────────────────────────
// Body: { profileId, url }   — elimina solo si el evento NO está completado
router.delete('/events/:id/media', async (req, res) => {
  try {
    const { id } = req.params;
    const { profileId, url } = req.body;
    if (!profileId) return res.status(400).json({ error: 'profileId requerido' });
    if (!url)       return res.status(400).json({ error: 'url requerido' });

    // Fetch event
    const { data: [event] } = await axios.get(
      rest('/roast_events') + `?select=id,farm_id,status,notes&id=eq.${id}`,
      { headers: headers() }
    );
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });
    if (event.status === 'completed' || event.status === 'discarded') {
      return res.status(400).json({ error: 'No se puede eliminar media de un evento cerrado' });
    }

    // Verify farm membership
    const { data: fm } = await axios.get(
      rest('/farm_members') + `?select=farm_id&user_id=eq.${profileId}&farm_id=eq.${event.farm_id}`,
      { headers: headers() }
    );
    if (!fm?.length) return res.status(403).json({ error: 'Sin acceso a esta finca' });

    // Remove URL from notes JSON
    const existing = parseNotes(event.notes);
    const newMedia  = (existing.media || []).filter(u => u !== url);
    const newNotes  = serializeNotes({ ...existing, media: newMedia });

    await axios.patch(
      rest('/roast_events') + `?id=eq.${id}`,
      { notes: newNotes, updated_at: new Date().toISOString() },
      { headers: headers() }
    );

    // Best-effort: delete the file from Supabase Storage
    try {
      // URL format: .../storage/v1/object/public/farm-assets/roast-events/{id}/{file}
      const marker    = '/farm-assets/';
      const storagePath = url.includes(marker) ? url.split(marker)[1] : null;
      if (storagePath) {
        await axios.delete(
          `${base()}/storage/v1/object/farm-assets/${storagePath}`,
          { headers: headers() }
        );
      }
    } catch (storageErr) {
      console.warn('[tostador/media/delete] Storage delete failed (non-fatal):', storageErr.message);
    }

    res.json({ ok: true, media_urls: newMedia });
  } catch (err) {
    console.error('[tostador/events/media/delete]', err.message);
    res.status(500).json({ error: 'Error eliminando media' });
  }
});

module.exports = router;
