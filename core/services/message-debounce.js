/**
 * APARTALO CORE - Message Debounce Service
 *
 * Agrupa mensajes consecutivos del mismo usuario en una sola respuesta.
 * Si el usuario envía varios mensajes en menos de DEBOUNCE_MS, se concatenan
 * y el bot responde una sola vez con el contexto completo.
 */

const DEBOUNCE_MS = 1500; // esperar 1.5s desde el último mensaje

// Map: `${negocioId}:${from}` → { timer, messages: [], resolve }
const pending = new Map();

/**
 * Encola un mensaje. Si ya hay uno pendiente del mismo usuario,
 * cancela el timer anterior y agrega el texto.
 *
 * @returns {Promise<string>} - texto concatenado final cuando el debounce se resuelve
 */
function enqueue(negocioId, from, texto) {
  const key = `${negocioId}:${from}`;

  return new Promise((resolve) => {
    let entry = pending.get(key);

    if (entry) {
      // Cancelar timer anterior
      clearTimeout(entry.timer);
      // Agregar texto al acumulado (separado por espacio)
      if (texto && texto.trim()) {
        entry.messages.push(texto.trim());
      }
    } else {
      // Primera entrada
      entry = { messages: texto && texto.trim() ? [texto.trim()] : [], resolve: null, timer: null };
      pending.set(key, entry);
    }

    // Siempre usar el resolve del último mensaje (el que dispara el procesamiento)
    entry.resolve = resolve;

    // Nuevo timer
    entry.timer = setTimeout(() => {
      const textoFinal = entry.messages.join(' ');
      pending.delete(key);
      entry.resolve(textoFinal);
    }, DEBOUNCE_MS);
  });
}

/**
 * Si el usuario envía solo 1 mensaje y no hay nada pendiente,
 * el debounce de 1.5s es el único overhead. Es aceptable para un bot.
 *
 * Para mensajes especiales (imagen, audio, botón interactivo) llamar
 * con texto vacío o el tipo — igual espera el debounce por si hay texto
 * complementario justo después.
 */

module.exports = { enqueue };
