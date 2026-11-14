/**
 * LECTOR DE COMPROBANTES (General Manager, 14 Nov 2026: "in movement maybe you could read the evidence of the photo,
 * the date and match with the movement"). Every 2 minutes, for each business linked to fincas, the vouchers of its
 * store payments not read yet (fincas 0078, proofs_to_read, newest first) are read with Tesseract (the same reader as
 * the BCP extension, /api/ocr/voucher) and what they say is saved (proof_reading_save): the date, the amount and the
 * operation number. Movimientos then suggests first the pedido whose voucher has the bank line's operation number, or
 * its date and amount (bank_movement_detail_v7). A voucher that cannot be read is saved with the error, so it is not
 * tried again and again.
 */

const MESES = {
  ene: 1, enero: 1, feb: 2, febrero: 2, mar: 3, marzo: 3, abr: 4, abril: 4, may: 5, mayo: 5, jun: 6, junio: 6,
  jul: 7, julio: 7, ago: 8, agosto: 8, set: 9, sep: 9, sept: 9, setiembre: 9, septiembre: 9, oct: 10, octubre: 10,
  nov: 11, noviembre: 11, dic: 12, diciembre: 12,
};

function iso(anio, mes, dia) {
  const a = anio < 100 ? 2000 + anio : anio;
  if (!(mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31 && a >= 2020 && a <= 2100)) return null;
  const d = new Date(Date.UTC(a, mes - 1, dia));
  if (d.getUTCMonth() !== mes - 1) return null; // 31 de febrero
  return `${a}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** "Martes, 10 Noviembre 2026", "10 nov. 2026", "10 de noviembre de 2026", "10/11/2026" → "2026-11-10". */
function leerFecha(texto) {
  const t = String(texto || '').toLowerCase();
  const conMes = /\b(\d{1,2})\s*(?:de\s+)?([a-záéíóú]{3,10})\.?\s*(?:de\s+|del\s+)?(\d{4}|\d{2})\b/g;
  for (const m of t.matchAll(conMes)) {
    const mes = MESES[m[2].normalize('NFD').replace(/[̀-ͯ]/g, '')];
    if (mes) {
      const f = iso(Number(m[3]), mes, Number(m[1]));
      if (f) return f;
    }
  }
  const numerica = t.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})\b/);
  return numerica ? iso(Number(numerica[3]), Number(numerica[2]), Number(numerica[1])) : null;
}

/** "1,250.50", "1.250,50", "220", "220.00" → número. */
function numero(s) {
  let t = String(s).trim().replace(/[.,]+$/, '');
  const punto = t.lastIndexOf('.');
  const coma = t.lastIndexOf(',');
  if (punto >= 0 && coma >= 0) {
    t = punto > coma ? t.replace(/,/g, '') : t.replace(/\./g, '').replace(',', '.');
  } else if (coma >= 0) {
    t = /,\d{1,2}$/.test(t) ? t.replace(',', '.') : t.replace(/,/g, '');
  }
  const v = Number(t);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** The amount paid: the "S/" next to monto, importe, total, yapeaste… (never comisión, ITF or saldo); else the largest. */
function leerMonto(texto) {
  const clave = /monto|importe|total|yapeaste|plineaste|pagaste|enviaste|transferi|te yape|recibiste/i;
  const noEs = /comisi[oó]n|itf|saldo|disponible/i;
  const lineas = String(texto || '').split(/[\r\n]+/);
  let conClave = null;
  let mayor = null;
  lineas.forEach((linea, i) => {
    if (noEs.test(linea)) return;
    for (const m of linea.matchAll(/S\s*\/\s*\.?\s*([0-9][0-9.,]*)/gi)) {
      const v = numero(m[1]);
      if (!v) continue;
      if (conClave == null && (clave.test(linea) || (i > 0 && clave.test(lineas[i - 1])))) conClave = v;
      if (mayor == null || v > mayor) mayor = v;
    }
  });
  return conClave != null ? conClave : mayor;
}

/** "Número de operación 05098337", "Nro. de operación: 1234", "Código de operación 99887766" → los dígitos. */
function leerOperacion(texto) {
  const t = String(texto || '');
  const m = t.match(/(?:n[º°o]\.?|nro\.?|n[uú]mero|c[oó]digo|cod\.?)\s*(?:de\s+)?operaci[oó]n\s*:?\s*([0-9][0-9 ]{3,24})/i)
         || t.match(/operaci[oó]n\s*(?:n[º°o]\.?|nro\.?)?\s*:?\s*([0-9][0-9 ]{3,24})/i);
  if (!m) return null;
  const n = m[1].replace(/\s/g, '');
  return n.length >= 4 ? n : null;
}

function leerComprobante(texto) {
  return { fecha: leerFecha(texto), monto: leerMonto(texto), operacion: leerOperacion(texto) };
}

/** Tesseract in Spanish, one worker reused between rounds. */
function crearOcr() {
  let worker = null;
  return async function ocr(buffer) {
    if (!worker) {
      const { createWorker } = require('tesseract.js');
      worker = await createWorker('spa');
    }
    const { data: { text } } = await worker.recognize(buffer);
    return text || '';
  };
}

/**
 * @param {object} deps
 * @param {()=>object[]} deps.negocios    the businesses (each with farmId when it is linked to fincas)
 * @param {(buffer:Buffer)=>Promise<string>} [deps.ocr]
 */
function createLectorComprobantes({
  negocios,
  ocr = crearOcr(),
  fetchImpl = (...a) => fetch(...a),
  supabaseUrl = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '').replace(/\/rest\/v1$/, ''),
  serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  porRonda = 5,
  log = console,
} = {}) {
  async function rpc(fn, body) {
    const res = await fetchImpl(`${supabaseUrl()}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: serviceKey(), Authorization: `Bearer ${serviceKey()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${fn} ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  async function leerUno(c) {
    try {
      const res = await fetchImpl(c.url);
      if (!res.ok) throw new Error(`descarga ${res.status}`);
      const tipo = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      if (tipo.includes('text/html')) throw new Error('no es una imagen');
      const buffer = Buffer.from(await res.arrayBuffer());
      const leido = leerComprobante(await ocr(buffer));
      await rpc('proof_reading_save', { p_proof_id: c.id, p_fecha: leido.fecha, p_monto: leido.monto, p_operacion: leido.operacion, p_error: null });
      return true;
    } catch (err) {
      await rpc('proof_reading_save', { p_proof_id: c.id, p_error: String(err.message || err).slice(0, 200) }).catch(() => null);
      return false;
    }
  }

  /** One round: at most [porRonda] vouchers per business. */
  async function revisar() {
    if (!supabaseUrl() || !serviceKey()) return { leidos: 0, fallidos: 0 };
    let leidos = 0;
    let fallidos = 0;
    for (const n of negocios().filter(x => x && x.farmId)) {
      try {
        const lista = await rpc('proofs_to_read', { p_business_id: n.farmId, p_limit: porRonda });
        for (const c of Array.isArray(lista) ? lista : []) {
          if (await leerUno(c)) leidos++; else fallidos++;
        }
      } catch (err) {
        log.error(`Lector de comprobantes (${n.id}): ${err.message}`);
      }
    }
    if (leidos || fallidos) log.log(`🧾 Comprobantes leídos: ${leidos}${fallidos ? `, sin leer: ${fallidos}` : ''}`);
    return { leidos, fallidos };
  }

  let timer = null;
  let ocupado = false;
  return {
    revisar,
    iniciar(cadaMs = 120000) {
      if (timer) return;
      timer = setInterval(async () => {
        if (ocupado) return;
        ocupado = true;
        try { await revisar(); } finally { ocupado = false; }
      }, cadaMs);
      if (timer.unref) timer.unref();
    },
    detener() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createLectorComprobantes, leerComprobante, leerFecha, leerMonto, leerOperacion };
