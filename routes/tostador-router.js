/**
 * TOSTADOR ROUTER
 * Endpoints para la app móvil de tostadores.
 * Auth: phone lookup → profile_id stored locally on device.
 * Media: stored in Supabase Storage, URLs tracked in notes as JSON.
 */

const express = require('express');
const router = express.Router();
const axios  = require('axios');
const negociosService = require('../config/negocios');

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

// ── Enriquece un array de eventos con stats de ventas ─────────────────────────
// Añade: kg_offered, kg_reserved, preventa_count a cada evento.
async function enrichEventsWithStats(events) {
  if (!events?.length) return events;

  const eventIds = events.map(e => e.id);

  // Paralelo: event_offers + conteo de pre-ventas por evento
  const [offersRes, ...preventaCounts] = await Promise.all([
    axios.get(
      rest('/event_offers') + `?select=event_id,kg_offered,kg_reserved&event_id=in.(${eventIds.join(',')})`,
      { headers: headers() }
    ).catch(() => ({ data: [] })),
    ...eventIds.map(id =>
      axios.get(
        rest('/orders') + `?select=id&notes=like.[PRE-VENTA:${id}]%25&status=neq.cancelled`,
        { headers: headers() }
      ).then(r => ({ id, count: r.data?.length ?? 0 }))
      .catch(() => ({ id, count: 0 }))
    ),
  ]);

  // Mapa: eventId → { kg_offered, kg_reserved }
  const offersMap = {};
  for (const o of offersRes.data || []) {
    if (!offersMap[o.event_id]) offersMap[o.event_id] = { kg_offered: 0, kg_reserved: 0 };
    offersMap[o.event_id].kg_offered  += parseFloat(o.kg_offered)  || 0;
    offersMap[o.event_id].kg_reserved += parseFloat(o.kg_reserved) || 0;
  }

  // Mapa: eventId → preventa_count
  const preventaMap = Object.fromEntries(preventaCounts.map(p => [p.id, p.count]));

  return events.map(ev => ({
    ...ev,
    kg_offered:     offersMap[ev.id]?.kg_offered  ?? 0,
    kg_reserved:    offersMap[ev.id]?.kg_reserved ?? 0,
    preventa_count: preventaMap[ev.id] ?? 0,
  }));
}

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
      + `?select=id,farm_id,status,roasted_at,completed_at,green_in_kg,roasted_out_kg,weight_loss_pct,cached_lot_code,cached_harvest_year,notes,created_at`
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

    const mapped = (events || []).map(ev => {
      const notes = parseNotes(ev.notes);
      return { ...ev, farm_name: farmMap[ev.farm_id] || 'Finca', notes_text: notes.text, media_urls: notes.media };
    });

    mapped.sort((a, b) => {
      const o = { in_progress: 0, planned: 1 };
      return (o[a.status] ?? 2) - (o[b.status] ?? 2);
    });

    const result = await enrichEventsWithStats(mapped);
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
      + `?select=id,farm_id,status,roasted_at,completed_at,green_in_kg,roasted_out_kg,weight_loss_pct,cached_lot_code,cached_harvest_year,notes,created_at`
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

    const historyMapped = (events || []).map(ev => {
      const notes = parseNotes(ev.notes);
      return { ...ev, farm_name: farmMap[ev.farm_id] || 'Finca', notes_text: notes.text, media_urls: notes.media };
    });
    const historyResult = await enrichEventsWithStats(historyMapped);
    res.json(historyResult);
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
    const { profileId, notesText, outKg } = req.body;
    if (!profileId) return res.status(400).json({ error: 'profileId requerido' });
    if (outKg === undefined || outKg === null || isNaN(Number(outKg))) {
      return res.status(400).json({ error: 'outKg requerido (kg de café tostado)' });
    }

    const { data: [event] } = await axios.get(
      rest('/roast_events') + `?select=id,farm_id,status,notes,green_in_kg&id=eq.${id}`,
      { headers: headers() }
    );
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });
    if (event.status !== 'in_progress') return res.status(400).json({ error: `Estado inválido: ${event.status}` });

    const { data: fm } = await axios.get(
      rest('/farm_members') + `?select=farm_id&user_id=eq.${profileId}&farm_id=eq.${event.farm_id}`,
      { headers: headers() }
    );
    if (!fm?.length) return res.status(403).json({ error: 'Sin acceso a esta finca' });

    const completedAt  = new Date().toISOString();
    const expiresAt    = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 6);

    const roastedOutKg = Number(outKg);

    // Preserve existing media URLs, update text
    const existing = parseNotes(event.notes);
    const newNotes = serializeNotes({ text: notesText || existing.text, media: existing.media });

    // weight_loss_pct es columna generada en Postgres — se calcula sola, no se escribe
    const patchBody = {
      status: 'completed',
      completed_at: completedAt,
      updated_at: completedAt,
      notes: newNotes,
      roasted_out_kg: roastedOutKg,
    };
    console.log('[complete] outKg recibido:', outKg, '→ roastedOutKg:', roastedOutKg, '| merma calculada por DB');

    try {
      await axios.patch(
        rest('/roast_events') + `?id=eq.${id}`,
        patchBody,
        { headers: headers() }
      );
    } catch (patchErr) {
      console.error('[complete] Supabase PATCH 400 data:', JSON.stringify(patchErr.response?.data));
      throw patchErr;
    }

    // ── Al completar el evento solo contar pre-ventas activas (sin cambiar su estado) ──
    // El estado de las pre-ventas lo gestiona manualmente el vendedor desde apartalo-app.
    let preventasConfirmadas = 0;
    try {
      const preventasUrl = rest('/orders')
        + `?select=id&notes=like.[PRE-VENTA:${id}]%25&status=in.(pending,confirmed)`;
      const { data: preventas } = await axios.get(preventasUrl, { headers: headers() });
      preventasConfirmadas = preventas?.length ?? 0;
      if (preventasConfirmadas > 0) {
        console.log(`[complete] Evento ${id} completado con ${preventasConfirmadas} pre-ventas activas (estado sin cambiar)`);
      }
    } catch (preventaErr) {
      console.error('[complete] Error contando pre-ventas:', preventaErr.message);
    }

    res.json({
      ok: true,
      completed_at: completedAt,
      expires_at: expiresAt.toISOString(),
      roasted_out_kg: roastedOutKg,
      preventasConfirmadas,
    });
  } catch (err) {
    console.error('[tostador/events/complete]', err.message);
    res.status(500).json({ error: 'Error finalizando tueste' });
  }
});

// ── GET /api/tostador/events/:eventId/preventas ──────────────────────────────
// Returns all orders that are pre-ventas for this roast event.
// Includes nested order_items for product detail.
router.get('/events/:eventId/preventas', async (req, res) => {
  try {
    const { eventId } = req.params;

    const url = rest('/orders')
      + `?select=id,order_number,customer_name,customer_phone,total_cents,status,notes,order_items(product_name,quantity,unit,pack_size)`
      + `&notes=like.[PRE-VENTA:${eventId}]%`
      + `&order=created_at.desc`;

    const { data: orders } = await axios.get(url, { headers: headers() });

    res.json(orders || []);
  } catch (err) {
    console.error('[tostador/events/preventas]', err.message);
    res.status(500).json({ error: 'Error obteniendo pre-ventas' });
  }
});

// ── Auth helper: accepts profileId (tostador) OR businessId (admin) ──────────
async function hasEventAccess(farmId, { profileId, businessId }) {
  if (businessId) {
    const negocio = negociosService.getById(businessId);
    return negocio?.farmId === farmId;
  }
  if (profileId) {
    const { data: fm } = await axios.get(
      rest('/farm_members') + `?select=farm_id&user_id=eq.${profileId}&farm_id=eq.${farmId}`,
      { headers: headers() }
    );
    return !!fm?.length;
  }
  return false;
}

// ── POST /api/tostador/events/:id/media/sign ─────────────────────────────────
// Genera una URL firmada de Supabase Storage para que Flutter suba directo.
// Body: { profileId, filename, mimeType }
// Returns: { signedUrl, publicUrl, path }
router.post('/events/:id/media/sign', async (req, res) => {
  try {
    const { id } = req.params;
    const { profileId, businessId, filename, mimeType } = req.body;
    if (!profileId && !businessId) return res.status(400).json({ error: 'profileId o businessId requerido' });
    if (!filename)  return res.status(400).json({ error: 'filename requerido' });

    const { data: [event] } = await axios.get(
      rest('/roast_events') + `?select=id,farm_id&id=eq.${id}`,
      { headers: headers() }
    );
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });

    if (!await hasEventAccess(event.farm_id, { profileId, businessId })) {
      return res.status(403).json({ error: 'Sin acceso a esta finca' });
    }

    const storagePath = `roast-events/${id}/${filename}`;
    const storageKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

    // Pedir URL firmada a Supabase Storage (válida 120 segundos)
    const signRes = await axios.post(
      `${base()}/storage/v1/object/upload/sign/farm-assets/${storagePath}`,
      {},
      {
        headers: {
          apikey: storageKey,
          Authorization: `Bearer ${storageKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // Supabase devuelve { url: "/object/upload/sign/farm-assets/...?token=..." }
    // El path es relativo a /storage/v1 — hay que prefijar correctamente.
    const rawPath   = signRes.data.signedURL || signRes.data.url || signRes.data.signedUrl;
    if (!rawPath) throw new Error('Supabase no retornó URL firmada: ' + JSON.stringify(signRes.data));
    const signedUrl = rawPath.startsWith('http') ? rawPath : `${base()}/storage/v1${rawPath}`;
    const publicUrl = `${base()}/storage/v1/object/public/farm-assets/${storagePath}`;

    res.json({ signedUrl, publicUrl, path: storagePath });
  } catch (err) {
    console.error('[tostador/media/sign]', err.message, err.response?.data);
    res.status(500).json({ error: 'Error generando URL firmada' });
  }
});

// ── POST /api/tostador/events/:id/media/register ──────────────────────────────
// Registra una URL ya subida a Storage en el campo notes del evento.
// Body: { profileId, url }
// Returns: { ok, url, media_urls }
router.post('/events/:id/media/register', async (req, res) => {
  try {
    const { id } = req.params;
    const { profileId, businessId, url } = req.body;
    if (!profileId && !businessId) return res.status(400).json({ error: 'profileId o businessId requerido' });
    if (!url)       return res.status(400).json({ error: 'url requerido' });

    const { data: [event] } = await axios.get(
      rest('/roast_events') + `?select=id,farm_id,notes&id=eq.${id}`,
      { headers: headers() }
    );
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });

    if (!await hasEventAccess(event.farm_id, { profileId, businessId })) {
      return res.status(403).json({ error: 'Sin acceso a esta finca' });
    }

    const existing  = parseNotes(event.notes);
    existing.media  = [...(existing.media || []), url];
    const newNotes  = serializeNotes(existing);

    await axios.patch(
      rest('/roast_events') + `?id=eq.${id}`,
      { notes: newNotes, updated_at: new Date().toISOString() },
      { headers: headers() }
    );

    res.json({ ok: true, url, media_urls: existing.media });
  } catch (err) {
    console.error('[tostador/media/register]', err.message);
    res.status(500).json({ error: 'Error registrando media' });
  }
});

// ── DELETE /api/tostador/events/:id/media ─────────────────────────────────────
// Body: { profileId, url }   — elimina solo si el evento NO está completado
router.delete('/events/:id/media', async (req, res) => {
  try {
    const { id } = req.params;
    const { profileId, businessId, url } = req.body;
    if (!profileId && !businessId) return res.status(400).json({ error: 'profileId o businessId requerido' });
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

    if (!await hasEventAccess(event.farm_id, { profileId, businessId })) {
      return res.status(403).json({ error: 'Sin acceso a esta finca' });
    }

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

// ── POST /api/tostador/events/:id/start-admin ────────────────────────────────
// Admin version: authorizes via businessId instead of profileId
router.post('/events/:id/start-admin', async (req, res) => {
  try {
    const { id } = req.params;
    const { businessId } = req.body;
    if (!businessId) return res.status(400).json({ error: 'businessId requerido' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const { data: [event] } = await axios.get(
      rest('/roast_events') + `?select=id,farm_id,status&id=eq.${id}`,
      { headers: headers() }
    );
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });
    if (event.farm_id !== negocio.farmId) return res.status(403).json({ error: 'Sin acceso a este evento' });
    if (event.status !== 'planned') return res.status(400).json({ error: `Estado inválido: ${event.status}` });

    const roastedAt = new Date().toISOString();
    await axios.patch(
      rest('/roast_events') + `?id=eq.${id}`,
      { status: 'in_progress', roasted_at: roastedAt, updated_at: roastedAt },
      { headers: headers() }
    );

    res.json({ ok: true, roasted_at: roastedAt });
  } catch (err) {
    console.error('[tostador/events/start-admin]', err.message);
    res.status(500).json({ error: 'Error iniciando tueste' });
  }
});

// ── POST /api/tostador/events/:id/complete-admin ──────────────────────────────
// Admin version: authorizes via businessId instead of profileId
router.post('/events/:id/complete-admin', async (req, res) => {
  try {
    const { id } = req.params;
    const { businessId, notesText, outKg } = req.body;
    if (!businessId) return res.status(400).json({ error: 'businessId requerido' });
    if (outKg === undefined || outKg === null || isNaN(Number(outKg))) {
      return res.status(400).json({ error: 'outKg requerido (kg de café tostado)' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const { data: [event] } = await axios.get(
      rest('/roast_events') + `?select=id,farm_id,status,notes,green_in_kg&id=eq.${id}`,
      { headers: headers() }
    );
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });
    if (event.farm_id !== negocio.farmId) return res.status(403).json({ error: 'Sin acceso a este evento' });
    if (event.status !== 'in_progress') return res.status(400).json({ error: `Estado inválido: ${event.status}` });

    const completedAt = new Date().toISOString();
    const expiresAt   = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 6);

    const existing = parseNotes(event.notes);
    const newNotes = serializeNotes({ text: notesText || existing.text, media: existing.media });

    await axios.patch(
      rest('/roast_events') + `?id=eq.${id}`,
      { status: 'completed', completed_at: completedAt, updated_at: completedAt,
        notes: newNotes, roasted_out_kg: Number(outKg) },
      { headers: headers() }
    );

    res.json({ ok: true, completed_at: completedAt, roasted_out_kg: Number(outKg) });
  } catch (err) {
    console.error('[tostador/events/complete-admin]', err.message);
    res.status(500).json({ error: 'Error finalizando tueste' });
  }
});

// ── GET /api/tostador/green-lots?businessId=... ───────────────────────────────
// Lista lotes verdes disponibles para el negocio (para crear eventos desde apartalo-app)
router.get('/green-lots', async (req, res) => {
  try {
    const { businessId } = req.query;
    if (!businessId) return res.status(400).json({ error: 'businessId requerido' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const url = rest('/green_lots') + `?select=id,lot_code,current_kg,harvest_year,variety:coffee_varieties(name)&roastery_farm_id=eq.${negocio.farmId}&status=eq.available&current_kg=gt.0&order=created_at.desc`;
    console.log('[tostador/green-lots] url:', url);
    const response = await axios.get(url, { headers: headers() });
    console.log('[tostador/green-lots] status:', response.status, 'count:', response.data?.length);

    res.json(response.data || []);
  } catch (err) {
    console.error('[tostador/green-lots] error:', err.message);
    console.error('[tostador/green-lots] response data:', JSON.stringify(err.response?.data));
    console.error('[tostador/green-lots] response status:', err.response?.status);
    res.status(500).json({ error: 'Error obteniendo lotes verdes' });
  }
});

// ── POST /api/tostador/events/create ─────────────────────────────────────────
// Crea un evento de tueste planificado y lo vincula al producto via event_offers
// Body: { businessId, green_lot_id, green_in_kg, roasted_at, product_id }
router.post('/events/create', async (req, res) => {
  try {
    const { businessId, green_lot_id, green_in_kg, roasted_at, product_id, roasted_out_kg } = req.body;
    if (!businessId)   return res.status(400).json({ error: 'businessId requerido' });
    if (!green_lot_id) return res.status(400).json({ error: 'green_lot_id requerido' });
    if (!green_in_kg)  return res.status(400).json({ error: 'green_in_kg requerido' });
    if (!roasted_at)   return res.status(400).json({ error: 'roasted_at requerido' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    // Crear evento planificado
    const { data: events } = await axios.post(
      rest('/roast_events'),
      {
        farm_id:      negocio.farmId,
        green_lot_id,
        green_in_kg:  parseFloat(green_in_kg),
        roasted_at,
        status:       'planned',
        sensory_notes: [],
        roaster_id:      '56f794e4-d159-4c6b-9336-87ce97e4e590',
        operator_id:     'd0f1b4bb-bf9f-469d-b461-1080e4e80150',
        profile_id:      '1855fce0-2600-45ad-a619-de93ba9dae17',
        ...(roasted_out_kg != null ? { roasted_out_kg: parseFloat(roasted_out_kg) } : {}),
      },
      { headers: headers() }
    );
    const event = Array.isArray(events) ? events[0] : events;
    if (!event?.id) return res.status(500).json({ error: 'Error al crear evento' });

    // Vincular producto via event_offers si se proporcionó
    if (product_id) {
      const kgOffered = roasted_out_kg != null ? parseFloat(roasted_out_kg) : parseFloat(green_in_kg);
      await axios.post(
        rest('/event_offers'),
        { event_id: event.id, product_id, kg_offered: kgOffered },
        { headers: headers() }
      ).catch(e => console.warn('[tostador/events/create] event_offer warn:', e.message));
    }

    res.status(201).json({ ok: true, eventId: event.id });
  } catch (err) {
    console.error('[tostador/events/create] error:', err.message);
    console.error('[tostador/events/create] response:', JSON.stringify(err.response?.data));
    res.status(500).json({ error: err.response?.data?.message || 'Error creando evento' });
  }
});

module.exports = router;
