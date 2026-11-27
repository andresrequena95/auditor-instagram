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
      var share = '';
      if (m.share) {
        var lk = String(m.share.link || '');
        share = /\/stories\//.test(lk) ? 'story' : /instagram\.com\/(p|reel|reels|tv)\//.test(lk) ? 'post' : lk ? 'otro' : 'otro';
      }
      var media = !!(m.photos || m.videos || m.audio_files || m.sticker || m.share);
      msgs.push({ sender: fixText(m.sender_name), ts: m.timestamp_ms, content: fixText(m.content || ''), media: media, share: share });
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
    return { owner: arr[0] || null, ambiguous: ambiguous, share: arr.length && convs.length ? count[arr[0]] / convs.length : 0, candidates: arr.slice(0, 10), count: count, total: convs.length };
  }

  function median(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }

  // ---------- Limpieza y clasificacion de mensajes ----------
  var BOT_MIN_CHATS = 10;      // un texto del dueno identico en >=10 chats...
  var BOT_FAST_MS = 30000;     // ...que llega <30 s despues de un mensaje del cliente...
  var BOT_FAST_RATIO = 0.8;    // ...en >=80% de los casos, es automatico.
  var BTN_RATIO = 0.5;         // boton del anuncio: el bot le responde en >=50% de los chats donde es el 1er mensaje
  var SEGUIMIENTO_MS = 12 * 3600000, SILENCIO_MS = 14 * 86400000;

  // Lineas de sistema de Meta: vienen como mensajes del dueno ("X replied to an ad", asignaciones...). No son respuesta ni mensaje del cliente.
  var SYS_RE = /(assigned this conversation|replied to an ad|can.?t receive your message|can.?t reply to this conversation|started an? (audio|video) (call|chat)|missed an? (audio|video) (call|chat)|asign[oó] (esta|la) conversaci[oó]n|respondi[oó] a un anuncio|no puede recibir (tu|tus) mensaje)/i;
  var AD_RE = /(replied to an ad|respondi[oó] a un anuncio)/i;
  var LIKE_RE = /^(liked a message|le gust[oó] un mensaje|reacted .+ to a message|reaccion[oó] .+)$/i;
  var ATT_RE = /^(enviaste un archivo adjunto|you sent an attachment)/i;
  var PRIV_RE = /^(enviaste una respuesta privada|you sent a private reply)/i;
  var CLOSE_RE = /^(gracias|muchas gracias|mil gracias|ok|okey|okay|oki|listo|perfecto|genial|dale|vale|super|súper|excelente|buenísimo|👍|🙏|❤️|🤍|igualmente|hasta luego|chau|bye|entendido|claro|sí|si|sii|no gracias)[\s!.,😊🤍🙏❤️👍🙌🥰]*$/i;
  var INT_RE = /precio|cu[aá]nto|costo|cuesta|valor|medida|disponib|stock|\bquiero\b|cat[aá]logo|delivery|env[ií]o|enviar|despacho|cotiza|comprar|colores|color\b|showroom|ubicaci|direcci[oó]n|entrega|plazo/i;
  var PHONE_RE = /(\+?51[\s-]?)?\b9\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/;
  var COMMIT_RE = /ahi te escribo|ahí te escribo|te contacto de este tel|te escribo por whatsapp|te escribo al/i;

  function norm(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
  function shortText(t, n) {
    var w = t.split(' ');
    return w.length > n ? w.slice(0, n).join(' ') + '…' : t;
  }
  function isMediaMsg(x) { return x.o && (!x.text || ATT_RE.test(x.text)); }

  // Mensajes limpios de una conversacion (sin lineas de sistema ni "me gusta"), cacheados por dueno.
  function prep(c, owner) {
    if (c._p && c._p.owner === owner) return c._p;
    var msgs = [], adLine = false;
    c.messages.forEach(function (m) {
      var text = norm(m.content), isOwner = m.sender === owner;
      if (SYS_RE.test(text)) { if (AD_RE.test(text)) adLine = true; return; }
      if (LIKE_RE.test(text)) return;
      msgs.push({ o: isOwner, ts: m.ts, text: text, media: !!m.media, share: m.share || '' });
    });
    c._p = { owner: owner, msgs: msgs, adLine: adLine };
    return c._p;
  }

  // Textos automaticos del propio visitante: lista de candidatos para que el dueno confirme.
  function detectBots(convs, owner) {
    var st = Object.create(null);
    convs.forEach(function (c, ci) {
      if (c.source === 'broadcast') return;
      var m = prep(c, owner).msgs;
      for (var i = 0; i < m.length; i++) {
        var x = m[i];
        if (!x.o || !x.text || ATT_RE.test(x.text) || PRIV_RE.test(x.text)) continue;
        var s = st[x.text] || (st[x.text] = { chats: 0, last: -1, occ: 0, trig: 0, fast: 0 });
        if (s.last !== ci) { s.chats++; s.last = ci; }
        s.occ++;
        var p = i > 0 ? m[i - 1] : null;
        // disparador: mensaje del cliente, o la tarjeta de plantilla (adjunto del dueno) al abrir el chat
        if (p && (!p.o || (i === 1 && isMediaMsg(p)))) { s.trig++; if (x.ts - p.ts < BOT_FAST_MS) s.fast++; }
      }
    });
    var candidates = [];
    Object.keys(st).forEach(function (k) {
      var s = st[k];
      if (s.chats >= BOT_MIN_CHATS && s.trig >= BOT_MIN_CHATS && s.fast / s.trig >= BOT_FAST_RATIO) {
        candidates.push({ key: k, text: shortText(k, 12), chats: s.chats, fastPct: s.fast / s.trig * 100 });
      }
    });
    candidates.sort(function (a, b) { return b.chats - a.chats || (a.key < b.key ? -1 : 1); });
    return { candidates: candidates };
  }

  // Tipo de cada mensaje: C cliente · sys n/a (ya filtrado) · bot · priv (respuesta privada a comentario) · media · hum
  function classify(msgs, botSet) {
    var k = msgs.map(function (x) {
      if (!x.o) return 'C';
      if (x.text && botSet[x.text]) return 'bot';
      if (PRIV_RE.test(x.text)) return 'priv';
      if (isMediaMsg(x)) return 'media';
      return 'hum';
    });
    // la tarjeta del anuncio (adjunto del dueno al abrir el chat) seguida del saludo automatico tambien es automatica
    if (k.length > 1 && k[0] === 'media' && k[1] === 'bot' && msgs[1].ts - msgs[0].ts < BOT_FAST_MS) k[0] = 'bot';
    return k;
  }
  function isHuman(kind) { return kind === 'hum' || kind === 'priv' || kind === 'media'; }

  function analyze(convs, owner, opts) {
    opts = opts || {};
    var hourOf = opts.hourOf || function (ts) { return new Date(ts).getHours(); };
    var candidates = opts.candidates || detectBots(convs, owner).candidates;
    var keys = opts.botKeys || candidates.map(function (c) { return c.key; });
    var botSet = Object.create(null);
    keys.forEach(function (k) { botSet[k] = 1; });

    var pendingRequests = 0, skippedChannels = 0, ownerMsgs = 0, refTs = 0;
    var times = [], unanswered = 0, analyzed = 0, skippedGroups = 0, skippedOwnerFirst = 0, botOnly = 0;
    var continued = 0, totalMessages = 0, dateFrom = null, dateTo = null;
    var tramos = TRAMOS.map(function (t) { return { id: t.id, label: t.label, count: 0, continued: 0 }; });
    var franjas = FRANJAS.map(function (f) { return { id: f.id, short: f.short, label: f.label, times: [], unanswered: 0, total: 0 }; });
    function newOrigin() { return { n: 0, times: [], unanswered: 0, continued: 0, directo: 0, story: 0, post: 0 }; }
    var origins = { pauta: newOrigin(), organico: newOrigin(), tu: { n: 0, replied: 0 } };
    var botSecs = [], anyMins = [], chatsWithBot = 0;
    var leads = []; // para el conteo de oportunidades
    var pre = [];   // chats comparables, para detectar los botones del anuncio

    convs.forEach(function (c) {
      c.messages.forEach(function (m) { if (m.sender === owner) ownerMsgs++; });
      if (c.messages.length && c.messages[c.messages.length - 1].ts > refTs) refTs = c.messages[c.messages.length - 1].ts;
    });

    // Pasada 1: filtros por tipo de conversacion y clasificacion
    convs.forEach(function (c) {
      // Solicitudes de mensaje sin aceptar y canales de difusion no cuentan como "chats atendidos"
      if (c.source === 'message_requests') { pendingRequests++; return; }
      if (c.source === 'broadcast') { skippedChannels++; return; }
      var others = {};
      c.messages.forEach(function (m) { if (m.sender !== owner) others[m.sender] = 1; });
      if (Object.keys(others).length > 1 || c.participants.length > 2) { skippedGroups++; return; }
      var p = prep(c, owner);
      if (!p.msgs.length) return;
      pre.push({ msgs: p.msgs, adLine: p.adLine, k: classify(p.msgs, botSet) });
    });

    // Botones del anuncio: primer mensaje del cliente (en >=10 chats) al que el bot responde en segundos
    var btn = Object.create(null), buttonSet = Object.create(null);
    pre.forEach(function (ch) {
      var ci = -1, i;
      for (i = 0; i < ch.msgs.length; i++) if (!ch.msgs[i].o) { ci = i; break; }
      if (ci < 0 || !ch.msgs[ci].text) return;
      var b = btn[ch.msgs[ci].text] || (btn[ch.msgs[ci].text] = { n: 0, bot: 0 });
      b.n++;
      var nx = ch.msgs[ci + 1];
      if (nx && nx.o && ch.k[ci + 1] === 'bot' && nx.ts - ch.msgs[ci].ts < BOT_FAST_MS) b.bot++;
    });
    Object.keys(btn).forEach(function (t) { if (btn[t].n >= BOT_MIN_CHATS && btn[t].bot / btn[t].n >= BTN_RATIO) buttonSet[t] = 1; });

    // Pasada 2: metricas
    pre.forEach(function (ch) {
      var m = ch.msgs, k = ch.k, i, ci = -1;
      for (i = 0; i < m.length; i++) if (!m[i].o) { ci = i; break; }
      var humanFirst = m[0].o && k[0] !== 'bot' && !ch.adLine; // con linea "replied to an ad" el cliente abrio desde un anuncio
      var last = m[m.length - 1];

      // oportunidades: sobre cualquier chat donde el cliente escribio, sin importar quien abrio
      if (ci >= 0) {
        var lastC = null, interest = false, wa = false;
        m.forEach(function (x, j) {
          if (!x.o) { lastC = x; if (x.text && !buttonSet[x.text] && INT_RE.test(x.text)) interest = true; if (PHONE_RE.test(x.text)) wa = true; }
          else if (isHuman(k[j]) && COMMIT_RE.test(x.text)) wa = true;
        });
        var bursts = 0, prev = null;
        m.forEach(function (x, j) {
          if (x.o && isHuman(k[j]) && x.ts > lastC.ts) { if (prev === null || x.ts - prev >= SEGUIMIENTO_MS) bursts++; prev = x.ts; }
        });
        leads.push({ ts: lastC.ts, closure: !lastC.text || CLOSE_RE.test(lastC.text), interest: interest, wa: wa, bursts: bursts });
      }

      if (humanFirst) { // la abrio una persona (texto personalizado, respuesta privada a comentario): no es un lead entrante
        skippedOwnerFirst++; origins.tu.n++;
        if (ci >= 0) origins.tu.replied++;
        return;
      }
      if (ci < 0) { botOnly++; return; } // solo hablo la plantilla; el cliente nunca escribio
      analyzed++;
      totalMessages += m.length;
      var t0 = m[ci].ts, first = m[0];
      if (dateFrom === null || first.ts < dateFrom) dateFrom = first.ts;
      if (dateTo === null || last.ts > dateTo) dateTo = last.ts;
      var h = hourOf(t0), fr = franjas[Math.min(3, Math.floor(h / 6))];
      fr.total++;

      var origin;
      if (ch.adLine || k[0] === 'bot' || buttonSet[m[ci].text]) origin = origins.pauta;
      else {
        origin = origins.organico;
        origin[m[ci].share === 'story' ? 'story' : m[ci].share === 'post' ? 'post' : 'directo']++;
      }
      origin.n++;

      var hIdx = -1, bIdx = -1, aIdx = -1;
      for (i = ci + 1; i < m.length; i++) {
        if (!m[i].o) continue;
        if (aIdx < 0) aIdx = i;
        if (bIdx < 0 && k[i] === 'bot') bIdx = i;
        if (hIdx < 0 && isHuman(k[i])) hIdx = i;
        if (hIdx >= 0 && bIdx >= 0) break;
      }
      if (bIdx >= 0) { chatsWithBot++; botSecs.push((m[bIdx].ts - t0) / 1000); }
      if (aIdx >= 0) anyMins.push((m[aIdx].ts - t0) / 60000);
      if (hIdx < 0) { unanswered++; fr.unanswered++; origin.unanswered++; return; }
      var reply = m[hIdx];
      var min = (reply.ts - t0) / 60000;
      times.push(min); fr.times.push(min); origin.times.push(min);
      // "continuo" = el cliente volvio a escribir DESPUES de tu primera respuesta humana
      var cont = false;
      for (var q = hIdx + 1; q < m.length; q++) {
        if (!m[q].o && m[q].ts > reply.ts) { cont = true; break; }
      }
      if (cont) { continued++; origin.continued++; }
      for (var j2 = 0; j2 < TRAMOS.length; j2++) {
        if (min < TRAMOS[j2].max) { tramos[j2].count++; if (cont) tramos[j2].continued++; break; }
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
    ['pauta', 'organico'].forEach(function (id) {
      var o = origins[id];
      o.answered = o.times.length; o.median = median(o.times);
      o.pct = analyzed ? o.n / analyzed * 100 : 0;
      o.answeredPct = o.n ? o.answered / o.n * 100 : null;
      o.continuedPct = o.answered ? o.continued / o.answered * 100 : null;
      o.small = o.n < MIN_N;
    });
    origins.tu.repliedPct = origins.tu.n ? origins.tu.replied / origins.tu.n * 100 : null;

    // Oportunidades: leads con senal de interes, silenciosos hace >=14 dias, sin cierre, que no pasaron a WhatsApp y sin ningun seguimiento humano
    var opps = 0, interested = 0;
    leads.forEach(function (l) {
      if (!l.interest) return;
      interested++;
      if (refTs - l.ts >= SILENCIO_MS && !l.closure && !l.wa && l.bursts <= 1) opps++;
    });

    var selected = candidates.filter(function (c) { return botSet[c.key]; });
    var bot = {
      detected: candidates.length > 0,            // hay candidatos: se muestra la lista para confirmar
      active: selected.length > 0 && chatsWithBot > 0, // el bot cuenta en este reporte
      candidates: candidates.map(function (c) { return { key: c.key, text: c.text, chats: c.chats, fastPct: c.fastPct, on: !!botSet[c.key] }; }),
      chatsWithBot: chatsWithBot, chatsWithBotPct: analyzed ? chatsWithBot / analyzed * 100 : 0,
      medianSec: median(botSecs), medianWithBotMin: median(anyMins)
    };

    return {
      owner: owner,
      analyzed: analyzed, answered: answered, unanswered: unanswered,
      unansweredPct: analyzed ? unanswered / analyzed * 100 : 0,
      continued: continued, continuedPct: answered ? continued / answered * 100 : null,
      meanMin: mean(times), medianMin: median(times),
      tramos: tramos, franjas: franjas, worstFranja: worst, busiestFranja: busiest,
      totalMessages: totalMessages, dateFrom: dateFrom, dateTo: dateTo,
      pendingRequests: pendingRequests, skippedChannels: skippedChannels, ownerMsgs: ownerMsgs, totalConvs: convs.length,
      skippedGroups: skippedGroups, skippedOwnerFirst: skippedOwnerFirst, botOnly: botOnly,
      bot: bot, origins: origins,
      opps: { count: opps, interested: interested, refTs: refTs }
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

  function fmtSeconds(sec) {
    if (sec === null || sec === undefined) return '—';
    if (sec < 1) return 'menos de 1 seg';
    if (sec < 60) return Math.round(sec) + ' seg';
    return fmtDuration(sec / 60);
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
    detectOwner: detectOwner, detectBots: detectBots, analyze: analyze, fmtDuration: fmtDuration, fmtSeconds: fmtSeconds, fmtDate: fmtDate, collectFromZip: collectFromZip, blobReader: blobReader,
    TRAMOS: TRAMOS, FRANJAS: FRANJAS, MIN_N: MIN_N
  };
});
