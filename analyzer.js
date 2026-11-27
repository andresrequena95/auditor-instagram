/* Auditor de respuesta en Instagram — motor de analisis (100% local, sin red).
   Funciona en navegador (window.Auditor) y en node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Auditor = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Meta exporta texto UTF-8 leido como latin1: "MarÃ­a" -> "María".
  function fixText(s) {
    if (typeof s !== 'string' || !/[Â-ô]/.test(s)) return s;
    try {
      var bytes = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c > 255) return s; // ya es texto correcto
        bytes[i] = c;
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) { return s; }
  }

  var TRAMOS = [
    { id: 't1', label: 'Menos de 15 min', max: 15 },
    { id: 't2', label: '15 – 60 min', max: 60 },
    { id: 't3', label: '1 – 3 h', max: 180 },
    { id: 't4', label: '3 – 12 h', max: 720 },
    { id: 't5', label: '12 – 24 h', max: 1440 },
    { id: 't6', label: 'Más de 24 h', max: Infinity }
  ];
  var FRANJAS = [
    { id: 'madrugada', short: 'madrugada', label: 'Madrugada (12 am – 6 am)', from: 0, to: 6 },
    { id: 'manana', short: 'mañana', label: 'Mañana (6 am – 12 pm)', from: 6, to: 12 },
    { id: 'tarde', short: 'tarde', label: 'Tarde (12 pm – 6 pm)', from: 12, to: 18 },
    { id: 'noche', short: 'noche', label: 'Noche (6 pm – 12 am)', from: 18, to: 24 }
  ];
  var MIN_N = 3; // menos de 3 casos = muestra chica (se muestra, pero atenuada)

  function parseConversation(json) {
    if (!json || !Array.isArray(json.messages)) return null;
    var participants = (json.participants || []).map(function (p) { return fixText(p.name); });
    var msgs = [];
    json.messages.forEach(function (m) {
      if (!m || typeof m.timestamp_ms !== 'number' || !m.sender_name) return;
      msgs.push({ sender: fixText(m.sender_name), ts: m.timestamp_ms, content: fixText(m.content || '') });
    });
    msgs.sort(function (a, b) { return a.ts - b.ts; }); // el export viene del mas nuevo al mas viejo
    return { title: fixText(json.title || ''), participants: participants, messages: msgs };
  }

  // Une message_1.json, message_2.json... de una misma carpeta/conversacion.
  function buildConversations(entries) {
    var groups = {};
    entries.forEach(function (e) {
      var json;
      try { json = JSON.parse(e.text); } catch (err) { return; }
      var conv = parseConversation(json);
      if (!conv) return;
      var slash = e.path.lastIndexOf('/');
      var key = slash > 0 ? e.path.slice(0, slash) : 'json:' + conv.participants.slice().sort().join('|') + '|' + conv.title;
      var sm = /(?:^|\/)(inbox|message_requests|filtered_threads|archived_threads|broadcast)\//i.exec(e.path);
      if (!groups[key]) groups[key] = { title: conv.title, participants: conv.participants, messages: [], source: sm ? sm[1].toLowerCase() : 'otro' };
      groups[key].messages = groups[key].messages.concat(conv.messages);
      conv.participants.forEach(function (p) {
        if (groups[key].participants.indexOf(p) < 0) groups[key].participants.push(p);
      });
    });
    return Object.keys(groups).map(function (k) {
      var g = groups[k];
      g.messages.sort(function (a, b) { return a.ts - b.ts; });
      return g;
    });
  }

  // El dueno de la cuenta es quien aparece en mas conversaciones.
  function detectOwner(convs) {
    var count = {};
    convs.forEach(function (c) {
      var names = {};
      c.messages.forEach(function (m) { names[m.sender] = 1; });
      c.participants.forEach(function (p) { names[p] = 1; });
      Object.keys(names).forEach(function (n) { count[n] = (count[n] || 0) + 1; });
    });
    var arr = Object.keys(count).sort(function (a, b) { return count[b] - count[a] || (a < b ? -1 : 1); });
    var ambiguous = arr.length > 1 && count[arr[0]] === count[arr[1]];
    return { owner: arr[0] || null, ambiguous: ambiguous, candidates: arr.slice(0, 10), count: count, total: convs.length };
  }

  function median(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }

  function analyze(convs, owner, opts) {
    opts = opts || {};
    var hourOf = opts.hourOf || function (ts) { return new Date(ts).getHours(); };
    var pendingRequests = 0, skippedChannels = 0, ownerMsgs = 0;
    var times = [], unanswered = 0, analyzed = 0, skippedGroups = 0, skippedOwnerFirst = 0;
    var continued = 0, totalMessages = 0, dateFrom = null, dateTo = null;
    var tramos = TRAMOS.map(function (t) { return { id: t.id, label: t.label, count: 0, continued: 0 }; });
    var franjas = FRANJAS.map(function (f) { return { id: f.id, short: f.short, label: f.label, times: [], unanswered: 0, total: 0 }; });

    convs.forEach(function (c) {
      c.messages.forEach(function (m) { if (m.sender === owner) ownerMsgs++; });
      // Solicitudes de mensaje sin aceptar y canales de difusion no cuentan como "chats atendidos"
      if (c.source === 'message_requests') { pendingRequests++; return; }
      if (c.source === 'broadcast') { skippedChannels++; return; }
      var others = {};
      c.messages.forEach(function (m) { if (m.sender !== owner) others[m.sender] = 1; });
      if (Object.keys(others).length > 1 || c.participants.length > 2) { skippedGroups++; return; }
      if (!c.messages.length) return;
      var first = c.messages[0];
      if (first.sender === owner) { skippedOwnerFirst++; return; } // la inicio el dueno, no un tercero
      analyzed++;
      totalMessages += c.messages.length;
      var last = c.messages[c.messages.length - 1];
      if (dateFrom === null || first.ts < dateFrom) dateFrom = first.ts;
      if (dateTo === null || last.ts > dateTo) dateTo = last.ts;
      var h = hourOf(first.ts), fr = franjas[Math.min(3, Math.floor(h / 6))];
      fr.total++;
      var replyIdx = -1;
      for (var i = 1; i < c.messages.length; i++) {
        if (c.messages[i].sender === owner) { replyIdx = i; break; }
      }
      if (replyIdx < 0) { unanswered++; fr.unanswered++; return; }
      var reply = c.messages[replyIdx];
      var min = (reply.ts - first.ts) / 60000;
      times.push(min); fr.times.push(min);
      // "continuo" = el cliente volvio a escribir DESPUES de tu primera respuesta
      var cont = false;
      for (var k = replyIdx + 1; k < c.messages.length; k++) {
        if (c.messages[k].sender !== owner && c.messages[k].ts > reply.ts) { cont = true; break; }
      }
      if (cont) continued++;
      for (var j = 0; j < TRAMOS.length; j++) {
        if (min < TRAMOS[j].max) { tramos[j].count++; if (cont) tramos[j].continued++; break; }
      }
    });

    var answered = times.length;
    franjas.forEach(function (f) {
      f.mean = mean(f.times); f.median = median(f.times); f.answered = f.times.length;
      f.small = f.answered < MIN_N; f.pctOfFirsts = analyzed ? f.total / analyzed * 100 : 0;
    });
    // punto ciego: la franja con mayor mediana (prefiere franjas con muestra suficiente)
    function pickWorst(onlyBig) {
      var w = null;
      franjas.forEach(function (f) {
        if (f.median === null || (onlyBig && f.small)) return;
        if (!w || f.median > w.median || (f.median === w.median && f.unanswered > w.unanswered)) w = f;
      });
      return w;
    }
    var worst = pickWorst(true) || pickWorst(false);
    var busiest = null;
    franjas.forEach(function (f) { if (f.total && (!busiest || f.total > busiest.total)) busiest = f; });
    tramos.forEach(function (t) {
      t.pct = answered ? t.count / answered * 100 : 0;
      t.contPct = t.count ? t.continued / t.count * 100 : null;
      t.small = t.count < MIN_N;
    });

    return {
      owner: owner,
      analyzed: analyzed, answered: answered, unanswered: unanswered,
      unansweredPct: analyzed ? unanswered / analyzed * 100 : 0,
      continued: continued, continuedPct: answered ? continued / answered * 100 : null,
      meanMin: mean(times), medianMin: median(times),
      tramos: tramos, franjas: franjas, worstFranja: worst, busiestFranja: busiest,
      totalMessages: totalMessages, dateFrom: dateFrom, dateTo: dateTo,
      pendingRequests: pendingRequests, skippedChannels: skippedChannels, ownerMsgs: ownerMsgs, totalConvs: convs.length,
      skippedGroups: skippedGroups, skippedOwnerFirst: skippedOwnerFirst
    };
  }

  var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function fmtDate(ts, tzOpts) {
    if (ts === null || ts === undefined) return '—';
    var d = new Date(ts);
    return d.getDate() + ' ' + MESES[d.getMonth()] + ' ' + d.getFullYear();
  }

  function fmtDuration(min) {
    if (min === null || min === undefined) return '—';
    if (min < 1) return 'menos de 1 min';
    if (min < 60) return Math.round(min) + ' min';
    if (min < 1440) {
      var h = Math.floor(min / 60), m = Math.round(min - h * 60);
      return h + ' h' + (m ? ' ' + m + ' min' : '');
    }
    var d = Math.floor(min / 1440), hh = Math.round((min - d * 1440) / 60);
    return d + ' d' + (hh ? ' ' + hh + ' h' : '');
  }

  // ---------- Lector de ZIP por acceso aleatorio (sin cargar el archivo entero) ----------
  // reader = { size, read(start, end) -> Promise<Uint8Array> }. En navegador sale de File.slice();
  // en node, de fs por rangos (ver test/run-zip-real.js). Soporta ZIP64 y entradas deflate/stored.
  function blobReader(blob) {
    return { size: blob.size, read: async function (a, b) { return new Uint8Array(await blob.slice(a, b).arrayBuffer()); } };
  }
  function dv(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
  function u64(v, o) { return v.getUint32(o, true) + v.getUint32(o + 4, true) * 4294967296; }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  async function readCentralDirectory(reader) {
    var size = reader.size, tailLen = Math.min(size, 65557 + 20 + 56);
    var tail = await reader.read(size - tailLen, size), v = dv(tail), eocd = -1, i;
    for (i = tail.length - 22; i >= 0; i--) { if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error('El archivo no parece un ZIP válido (o está incompleto).');
    var total = v.getUint16(eocd + 10, true), cdSize = v.getUint32(eocd + 12, true), cdOff = v.getUint32(eocd + 16, true);
    if (total === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) {
      var loc = eocd - 20; // localizador ZIP64 justo antes del EOCD
      if (loc < 0 || v.getUint32(loc, true) !== 0x07064b50) throw new Error('ZIP64 no reconocido.');
      var z64 = u64(v, loc + 8), rec;
      var recStart = z64 - (size - tailLen);
      if (recStart >= 0 && recStart + 56 <= tail.length) rec = tail.subarray(recStart, recStart + 56);
      else rec = await reader.read(z64, z64 + 56);
      var rv = dv(rec);
      if (rv.getUint32(0, true) !== 0x06064b50) throw new Error('ZIP64 corrupto.');
      total = u64(rv, 32); cdSize = u64(rv, 40); cdOff = u64(rv, 48);
    }
    var cd = await reader.read(cdOff, cdOff + cdSize), cv = dv(cd), entries = [], p = 0;
    var dec = new TextDecoder('utf-8');
    while (p + 46 <= cd.length && cv.getUint32(p, true) === 0x02014b50) {
      var method = cv.getUint16(p + 10, true), crc = cv.getUint32(p + 16, true);
      var csize = cv.getUint32(p + 20, true), usize = cv.getUint32(p + 24, true);
      var nlen = cv.getUint16(p + 28, true), elen = cv.getUint16(p + 30, true), clen = cv.getUint16(p + 32, true);
      var off = cv.getUint32(p + 42, true);
      var name = dec.decode(cd.subarray(p + 46, p + 46 + nlen));
      if (usize === 0xFFFFFFFF || csize === 0xFFFFFFFF || off === 0xFFFFFFFF) {
        var q = p + 46 + nlen, end = q + elen;
        while (q + 4 <= end) {
          var id = cv.getUint16(q, true), len = cv.getUint16(q + 2, true);
          if (id === 1) {
            var r = q + 4;
            if (usize === 0xFFFFFFFF) { usize = u64(cv, r); r += 8; }
            if (csize === 0xFFFFFFFF) { csize = u64(cv, r); r += 8; }
            if (off === 0xFFFFFFFF) { off = u64(cv, r); }
            break;
          }
          q += 4 + len;
        }
      }
      entries.push({ name: name, method: method, crc: crc, csize: csize, usize: usize, offset: off });
      p += 46 + nlen + elen + clen;
    }
    return entries;
  }

  async function inflateRaw(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readEntryText(reader, e) {
    var lh = await reader.read(e.offset, e.offset + 30), v = dv(lh);
    if (v.getUint32(0, true) !== 0x04034b50) throw new Error('Cabecera local inválida: ' + e.name);
    var start = e.offset + 30 + v.getUint16(26, true) + v.getUint16(28, true);
    var raw = await reader.read(start, start + e.csize);
    var data = e.method === 0 ? raw : e.method === 8 ? await inflateRaw(raw) : null;
    if (!data) throw new Error('Compresión no soportada (' + e.method + '): ' + e.name);
    return new TextDecoder('utf-8').decode(data);
  }

  function isMessageEntry(name) {
    if (/\/$/.test(name) || !/\.json$/i.test(name)) return false;
    // solo mensajes: ignora fotos, videos, audios y los demas JSON del export
    return /(?:^|\/)message_?\d*[^\/]*\.json$/i.test(name) || /(?:^|\/)inbox\//i.test(name) || /(?:^|\/)message_requests\//i.test(name);
  }

  // Lee de un ZIP (File/Blob o reader) SOLO los message_*.json. opts.onProgress({done,total}), opts.seen (Set para dedup entre volumenes).
  async function collectFromZip(source, opts) {
    opts = opts || {};
    var reader = typeof source.read === 'function' ? source : blobReader(source);
    var all = await readCentralDirectory(reader);
    var wanted = all.filter(function (e) { return isMessageEntry(e.name); });
    var out = [], failed = 0, seen = opts.seen || new Set();
    for (var i = 0; i < wanted.length; i++) {
      var e = wanted[i], key = e.name + '|' + e.crc + '|' + e.usize;
      if (!seen.has(key)) {
        seen.add(key);
        try { out.push({ path: e.name, text: await readEntryText(reader, e) }); } catch (err) { failed++; }
      }
      if (i % 20 === 19) { if (opts.onProgress) opts.onProgress({ done: i + 1, total: wanted.length }); await tick(); }
    }
    if (opts.onProgress) opts.onProgress({ done: wanted.length, total: wanted.length });
    out.failed = failed; out.totalEntries = all.length; out.messageFiles = wanted.length;
    return out;
  }

  return {
    fixText: fixText, parseConversation: parseConversation, buildConversations: buildConversations,
    detectOwner: detectOwner, analyze: analyze, fmtDuration: fmtDuration, fmtDate: fmtDate, collectFromZip: collectFromZip, blobReader: blobReader,
    TRAMOS: TRAMOS, FRANJAS: FRANJAS, MIN_N: MIN_N
  };
});
