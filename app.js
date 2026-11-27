(function () {
  'use strict';
  var A = window.Auditor, $ = function (id) { return document.getElementById(id); };
  var state = { result: null, convs: null, detect: null, failed: 0, cands: [], botKeys: null, ownerOpen: false, owner: null };

  function status(msg, err) { var s = $('status'); s.textContent = msg || ''; s.className = err ? 'err' : ''; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function readText(file) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsText(file); }); }

  async function entriesFromFiles(files) {
    var entries = [], seen = new Set();
    for (var i = 0; i < files.length; i++) {
      var f = files[i], name = f.webkitRelativePath || f._path || f.name;
      if (/\.zip$/i.test(f.name)) {
        var zips = files.filter(function (x) { return /\.zip$/i.test(x.name); }), zi = zips.indexOf(f) + 1;
        var res = await A.collectFromZip(f, { seen: seen, onProgress: function (p) {
          status('Leyendo archivo ' + zi + ' de ' + zips.length + '… ' + (p.total ? Math.round(100 * p.done / p.total) : 100) + '% (' + p.done + ' de ' + p.total + ' archivos de chat)');
        } });
        state.failed += res.failed || 0;
        entries = entries.concat(res);
      } else if (/\.json$/i.test(f.name)) {
        try { entries.push({ path: name, text: await readText(f) }); }
        catch (err) { state.failed++; }
      }
    }
    return entries;
  }

  // Recorre carpetas soltadas con drag & drop
  function walk(entry, out) {
    return new Promise(function (resolve) {
      if (entry.isFile) {
        entry.file(function (f) { f._path = entry.fullPath.replace(/^\//, ''); out.push(f); resolve(); }, function () { state.failed++; resolve(); });
      } else if (entry.isDirectory) {
        var rd = entry.createReader(), all = [];
        (function more() {
          rd.readEntries(function (batch) {
            if (!batch.length) { Promise.all(all.map(function (e) { return walk(e, out); })).then(resolve); return; }
            all = all.concat(Array.prototype.slice.call(batch)); more();
          }, resolve);
        })();
      } else resolve();
    });
  }
  async function filesFromDrop(dt) {
    var items = dt.items, out = [];
    if (items && items.length && items[0].webkitGetAsEntry) {
      var ents = [];
      for (var i = 0; i < items.length; i++) { var e = items[i].webkitGetAsEntry(); if (e) ents.push(e); }
      await Promise.all(ents.map(function (e) { return walk(e, out); }));
      return out;
    }
    return Array.prototype.slice.call(dt.files);
  }

  async function handleFiles(files) {
    state.convs = null; state.result = null; state.failed = 0; $('report').style.display = 'none'; $('owner-box').style.display = 'none';
    if (!files.length) return;
    status('Leyendo tus mensajes en tu navegador…');
    try { handleEntries(await entriesFromFiles(files)); }
    catch (e) { status((e && e.message) || 'No pude leer ese archivo. Si es muy pesado, descomprímelo y suelta la carpeta messages.', true); }
  }

  function handleEntries(entries) {
    var convs = A.buildConversations(entries);
    if (!convs.length) { status('No encontré conversaciones. Busca el archivo message_1.json dentro de messages/inbox/ (o sube el ZIP completo en formato JSON, no HTML).', true); return; }
    state.convs = convs;
    state.detect = A.detectOwner(convs);
    state.ownerOpen = false;
    setOwner(state.detect.owner, true);
  }

  // Cambia de cuenta: re-detecta los mensajes automaticos de esa cuenta y recalcula.
  function setOwner(owner, scroll) {
    state.owner = owner;
    state.cands = A.detectBots(state.convs, owner).candidates;
    state.botKeys = null; // todos los detectados, hasta que el dueno desmarque alguno
    renderOwner(owner);
    run(owner, scroll);
  }

  function renderOwner(owner) {
    var d = state.detect, box = $('owner-box');
    box.style.display = 'block';
    // Si tu cuenta aparece en casi todas las conversaciones, no hace falta preguntar.
    if (!state.ownerOpen && !d.ambiguous && d.share >= 0.9) {
      box.innerHTML = 'Analizando la cuenta <b>' + esc(owner) + '</b>. <a href="#" id="owner-change" class="small-link">¿No es tu cuenta?</a>';
      $('owner-change').onclick = function (e) { e.preventDefault(); state.ownerOpen = true; renderOwner(owner); };
      return;
    }
    box.innerHTML = 'Estoy analizando como tu cuenta a <b>' + esc(owner) + '</b> (aparece en ' + d.count[owner] + ' de las ' + d.total + ' conversaciones). ' +
      (d.ambiguous ? '<b>Dos cuentas empatan, confírmala:</b> ' : '¿Es otra? Elígela: ') +
      '<select id="owner-sel" aria-label="Elige tu cuenta">' + d.candidates.map(function (n) {
        return '<option value="' + esc(n) + '"' + (n === owner ? ' selected' : '') + '>' + esc(n) + ' (en ' + d.count[n] + (d.count[n] === 1 ? ' conversación' : ' conversaciones') + ')</option>';
      }).join('') + '</select>';
    $('owner-sel').onchange = function () { setOwner(this.value, true); };
  }

  function run(owner, scroll) {
    var r = A.analyze(state.convs, owner, { candidates: state.cands, botKeys: state.botKeys });
    var warn = '';
    if (state.failed) warn += ' ⚠️ No pude leer ' + state.failed + ' archivos (si la carpeta está en iCloud/Drive, descárgala completa primero o sube el ZIP).';
    if (!r.ownerMsgs) { status('No encontré ningún mensaje tuyo. ¿Subiste la carpeta inbox completa (o el ZIP) y elegiste tu cuenta correcta?' + warn, true); return; }
    if (!r.analyzed) { status('No hay conversaciones iniciadas por clientes para analizar con "' + owner + '" como tu cuenta.', true); return; }
    status('Listo. Esto se calculó en tu computadora.' + warn, !!warn);
    render(r, scroll);
  }

  // opts: {bad, small, hl}. 'small' = muestra chica (atenuada, pero visible)
  function bar(label, pct, text, opts) {
    opts = opts || {};
    var cls = 'bar' + (opts.bad ? ' bad' : '') + (opts.small ? ' small' : '') + (opts.hl ? ' hl' : '');
    return '<div class="' + cls + '"><span>' + label + (opts.small ? ' <em>muestra chica</em>' : '') + '</span><div class="track"><div class="fill" style="width:' + Math.max(0, Math.min(100, pct)) + '%"></div></div><span class="v">' + text + '</span></div>';
  }
  function chats(n) { return n + (n === 1 ? ' chat' : ' chats'); }

  function pct(x) { return Math.round(x) + '%'; }

  function renderBot(r) {
    var b = r.bot, box = $('bot-box'), wrap = $('bot-section');
    if (!b.detected) { wrap.style.display = 'none'; box.innerHTML = ''; return; } // cuentas sin automatizacion: ni se menciona
    wrap.style.display = 'block';
    var html = '';
    if (b.active) {
      html += '<div class="vs"><div class="vs-a"><b>' + A.fmtSeconds(b.medianSec) + '</b><span>en lo que responde tu bot</span></div>' +
        '<div class="vs-x">vs</div>' +
        '<div class="vs-b"><b>' + A.fmtDuration(r.medianMin) + '</b><span>en lo que responde una persona</span></div></div>' +
        '<p class="lead-note">Tu bot responde en <b>' + A.fmtSeconds(b.medianSec) + '</b>, pero eso no es atención: el cliente recibe un menú, no a alguien que lo ayude. ' +
        'El bot intervino en <b>' + b.chatsWithBot.toLocaleString('es-PE') + ' de ' + r.analyzed.toLocaleString('es-PE') + ' chats</b> (' + pct(b.chatsWithBotPct) + '). ' +
        (b.medianWithBotMin !== null ? 'Si lo cuentas como respuesta, tu tiempo típico parece de <b>' + A.fmtDuration(b.medianWithBotMin) + '</b>; el real, el de una persona, es <b>' + A.fmtDuration(r.medianMin) + '</b>.' : '') + '</p>';
    }
    html += '<p class="note" style="margin:' + (b.active ? '14px' : '0') + ' 0 8px">Detecté <b>' + b.candidates.length + (b.candidates.length === 1 ? ' mensaje automático' : ' mensajes automáticos') + '</b> en tu cuenta: textos que repites idénticos en 10 chats o más y que salen en segundos tras el mensaje del cliente. Cada cuenta es distinta: <b>desmarca los que en realidad escribe una persona</b> y recalculo al toque.</p><ul class="botlist">';
    b.candidates.forEach(function (c, i) {
      html += '<li><label><input type="checkbox" data-i="' + i + '"' + (c.on ? ' checked' : '') + '><span class="bt">' + esc(c.text) + '</span><small>en ' + c.chats + ' chats</small></label></li>';
    });
    html += '</ul><p class="note" style="margin:8px 0 0">La tarjeta del anuncio que acompaña al saludo automático también cuenta como automática.</p>';
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('input[type=checkbox]'), function (cb) {
      cb.onchange = function () {
        state.botKeys = Array.prototype.filter.call(box.querySelectorAll('input[type=checkbox]'), function (x) { return x.checked; })
          .map(function (x) { return r.bot.candidates[+x.getAttribute('data-i')].key; });
        run(state.owner, false);
      };
    });
  }

  function renderOrigenes(r) {
    var o = r.origins, rows = [], wrap = $('origen-section');
    function row(title, sub, d, extra) {
      return '<div class="origin"><div class="oh"><b>' + title + '</b><span>' + sub + '</span></div><div class="ogrid">' +
        '<div><b>' + d.n.toLocaleString('es-PE') + '</b><span>' + (extra && extra.l1 || 'llegaron') + '</span></div>' +
        '<div><b>' + (d.answeredPct === null || d.answeredPct === undefined ? '—' : pct(d.answeredPct)) + '</b><span>' + (d.answered !== undefined ? d.answered.toLocaleString('es-PE') + ' con respuesta de una persona' : 'a los que respondió una persona') + '</span></div>' +
        '<div><b>' + (d.continuedPct === null || d.continuedPct === undefined ? '—' : pct(d.continuedPct)) + '</b><span>siguieron la conversación</span></div>' +
        '<div><b>' + (d.median === null || d.median === undefined ? '—' : A.fmtDuration(d.median)) + '</b><span>espera típica hasta que responde una persona</span></div></div></div>';
    }
    var subOrg = [];
    if (o.organico.directo) subOrg.push(o.organico.directo + ' directos');
    if (o.organico.story) subOrg.push(o.organico.story + ' desde una story');
    if (o.organico.post) subOrg.push(o.organico.post + ' desde un post compartido');
    if (o.pauta.n) rows.push(row('Anuncios (pauta)', pct(o.pauta.pct) + ' de tus leads · chats que abren desde un anuncio', o.pauta));
    if (o.organico.n) rows.push(row('Orgánico', pct(o.organico.pct) + ' de tus leads · ' + (subOrg.join(', ') || 'te escribieron por su cuenta'), o.organico));
    if (o.tu.n) rows.push('<div class="origin"><div class="oh"><b>Tú escribiste primero</b><span>respuestas a comentarios y mensajes personalizados</span></div><div class="ogrid">' +
      '<div><b>' + o.tu.n.toLocaleString('es-PE') + '</b><span>chats que abriste tú</span></div>' +
      '<div><b>' + (o.tu.repliedPct === null ? '—' : pct(o.tu.repliedPct)) + '</b><span>' + o.tu.replied.toLocaleString('es-PE') + ' contestaron</span></div>' +
      '<div><b>—</b><span>no se mide espera: escribiste tú</span></div><div><b>—</b><span></span></div></div></div>');
    // lectura automatica
    var read = '';
    if (o.pauta.n && o.organico.n && o.pauta.median !== null) {
      read = 'El <b>' + pct(o.pauta.pct) + '</b> de tus leads viene de pauta y típicamente espera <b>' + A.fmtDuration(o.pauta.median) + '</b> a una persona' +
        (o.organico.median !== null ? ' (los orgánicos, <b>' + A.fmtDuration(o.organico.median) + '</b>)' : '') + '.' +
        (o.pauta.continuedPct !== null && o.organico.continuedPct !== null && o.pauta.continuedPct < o.organico.continuedPct - 3 ? ' Y de los de pauta sigue la conversación el <b>' + pct(o.pauta.continuedPct) + '</b>, contra <b>' + pct(o.organico.continuedPct) + '</b> en los orgánicos.' : '');
    } else if (o.pauta.n && o.pauta.median !== null) {
      read = 'El <b>' + pct(o.pauta.pct) + '</b> de tus leads viene de pauta y típicamente espera <b>' + A.fmtDuration(o.pauta.median) + '</b> a una persona.';
    } else if (o.organico.n && o.organico.median !== null) {
      read = 'Todos tus leads llegan de forma orgánica y típicamente esperan <b>' + A.fmtDuration(o.organico.median) + '</b> a una persona.';
    }
    wrap.style.display = rows.length ? 'block' : 'none';
    $('origen').innerHTML = (read ? '<div class="worst">' + read + '</div>' : '') + rows.join('') +
      '<p class="note">Pauta = el chat trae la línea “replied to an ad”, abre con la tarjeta del anuncio o el primer mensaje es un botón del anuncio. Orgánico = el cliente escribió de la nada, por una story o con un post compartido.</p>';
  }

  function renderOportunidades(r) {
    var n = r.opps.count;
    $('oportunidades').innerHTML = n > 0
      ? '<div class="opp"><b>' + n.toLocaleString('es-PE') + '</b><span>leads con señal de interés (precio, medidas, disponible, “quiero”, catálogo, cotización…) se quedaron sin ningún seguimiento tuyo.</span></div>' +
        '<p class="lead-note" style="margin:12px 0 4px">La lista con nombres y el mensaje sugerido para cada uno es parte del método. <a class="small-link" href="#cta-hotmart">Ver cómo funciona</a></p>'
      : '<p class="lead-note" style="margin:0">No encontré leads con señal de interés que se hayan quedado sin seguimiento. Buen trabajo.</p>';
    $('oportunidades').innerHTML += '<p class="note" style="margin:6px 0 0">Cuento los chats donde el cliente preguntó por algo concreto y dejó de escribir hace 14 días o más, sin despedirse ni pasar a WhatsApp, y tú no volviste a escribirle pasadas 12 horas de su último mensaje.</p>';
  }

  function render(r, scroll) {
    var rango = r.dateFrom !== null ? ', del ' + A.fmtDate(r.dateFrom) + ' al ' + A.fmtDate(r.dateTo) : '';
    $('scope').textContent = 'Analicé ' + r.analyzed.toLocaleString('es-PE') + ' conversaciones de clientes (' + r.totalMessages.toLocaleString('es-PE') + ' mensajes en total' + rango + ')' +
      (r.skippedGroups ? ', omití ' + r.skippedGroups + ' grupos' : '') +
      (r.skippedOwnerFirst ? (r.skippedGroups ? ' y ' : ', omití ') + r.skippedOwnerFirst.toLocaleString('es-PE') + ' que abriste tú con un mensaje personalizado' : '') + '.' +
      (r.pendingRequests ? ' Aparte ' + (r.pendingRequests === 1 ? 'hay 1 solicitud de mensaje' : 'hay ' + r.pendingRequests + ' solicitudes de mensaje') + ' sin aceptar (no cuentan aquí; son personas que te escribieron y ni siquiera abriste).' : '') +
      ' 🔒 Esto se calculó en tu computadora.' +
      (r.bot.active ? ' Los tiempos son de la primera respuesta de una persona: el bot y las líneas de sistema de Meta no cuentan.' : '');

    var hum = r.bot.active;
    var k = [
      [A.fmtDuration(r.meanMin), 'Tiempo promedio de 1ª respuesta' + (hum ? ' humana' : '') + ' (sobre ' + chats(r.answered) + ' respondidos)'],
      [A.fmtDuration(r.medianMin), 'Tu tiempo típico de respuesta' + (hum ? ' humana' : '') + ' (la mitad de tus clientes esperó más que esto)'],
      [Math.round(r.unansweredPct) + '%', r.unanswered + ' de ' + chats(r.analyzed) + ' sin respuesta' + (hum ? ' de una persona' : '')],
      [r.continuedPct === null ? '—' : Math.round(r.continuedPct) + '%', r.continued + ' de ' + chats(r.answered) + ' siguieron la conversación tras tu respuesta']
    ];
    $('kpis').innerHTML = k.map(function (x, i) { return '<div class="kpi' + (hum && i === 1 ? ' star' : '') + '"><b>' + x[0] + '</b><span>' + x[1] + '</span></div>'; }).join('');

    renderBot(r);
    renderOrigenes(r);
    renderOportunidades(r);

    // 1. Tiempo de primera respuesta
    $('tramos').innerHTML = r.tramos.map(function (t, i) {
      return bar(t.label, t.pct, Math.round(t.pct) + '% <small>' + t.count + ' de ' + r.answered + '</small>', { bad: i >= 3 });
    }).join('') + (r.unanswered ? bar('Sin respuesta', r.unansweredPct, Math.round(r.unansweredPct) + '% <small>' + r.unanswered + ' de ' + r.analyzed + '</small>', { bad: true }) : '') +
      '<p class="note">Porcentaje sobre los ' + r.answered + ' chats que sí respondiste' + (r.bot.active ? ' (una persona; el bot no cuenta)' : '') + ' (los sin respuesta, sobre los ' + r.analyzed + ' analizados).</p>';

    // 2. Curva: ¿siguieron la conversación según tu velocidad?
    var big = r.tramos.filter(function (t) { return !t.small; });
    var takeaway;
    if (big.length >= 2 && big[0].id !== big[big.length - 1].id) {
      var f = big[0], l = big[big.length - 1];
      takeaway = 'En tus chats: cuando respondiste en <b>' + f.label.toLowerCase() + '</b> siguió la conversación el <b>' + Math.round(f.contPct) + '%</b> (' + f.continued + ' de ' + f.count + '); con <b>' + l.label.toLowerCase() + '</b>, el <b>' + Math.round(l.contPct) + '%</b> (' + l.continued + ' de ' + l.count + ').';
    } else {
      takeaway = 'Todavía hay pocos chats por tramo para sacar una conclusión firme; mientras más historial subas, más clara se ve tu curva.';
    }
    $('continuidad').innerHTML = '<p class="note" style="margin-top:0">Se calcula con <b>tus propios datos</b>: de los chats que respondiste, cuántos clientes <b>volvieron a escribir</b> después de tu primera respuesta, según cuánto demoraste.</p>' +
      r.tramos.map(function (t) {
        var txt = t.count ? Math.round(t.contPct) + '% <small>' + t.continued + ' de ' + t.count + '</small>' : '— <small>0 chats</small>';
        return bar(t.label, t.count ? t.contPct : 0, txt, { small: t.small });
      }).join('') +
      '<div class="worst">' + takeaway + '</div>' +
      '<p class="note">Los tramos con menos de ' + A.MIN_N + ' chats salen atenuados: el dato está, pero con tan pocos casos no es una conclusión.</p>';

    // 3. Horas
    var bz = r.busiestFranja, wz = r.worstFranja;
    $('horas-escriben').innerHTML = (bz ? '<div class="worst">Te escriben más en la <b>' + bz.short + '</b>: ' + bz.total + ' de ' + r.analyzed + ' chats (' + Math.round(bz.pctOfFirsts) + '%) empezaron en ese horario.</div>' : '') +
      r.franjas.map(function (f) {
        return bar(f.label, f.pctOfFirsts, Math.round(f.pctOfFirsts) + '% <small>' + f.total + ' de ' + r.analyzed + '</small>', { hl: bz && f.id === bz.id });
      }).join('') + '<p class="note">Según la hora del primer mensaje del cliente (hora de tu computadora).</p>';

    var maxMed = Math.max.apply(null, r.franjas.map(function (f) { return f.median || 0; })) || 1;
    var advice = '';
    if (wz) {
      advice = '<div class="worst">Tu punto ciego es la <b>' + wz.short + '</b>: ahí demoras típicamente <b>' + A.fmtDuration(wz.median) + '</b> en responder (' + wz.answered + ' chats respondidos)' +
        (wz.unanswered ? ' y ' + chats(wz.unanswered) + ' se quedaron sin respuesta' : '') + '. Ahí se te van los leads' +
        (bz && bz.id === wz.id ? ', y además es cuando más te escriben' : '') + '.</div>';
    }
    $('horas-demoras').innerHTML = advice + r.franjas.map(function (f) {
      var txt = f.median === null ? '— <small>0 respondidos</small>' : A.fmtDuration(f.median) + ' <small>' + f.answered + ' de ' + f.total + ' respondidos</small>';
      return bar(f.label, f.median ? f.median / maxMed * 100 : 0, txt, { bad: wz && f.id === wz.id, small: f.median !== null && f.small });
    }).join('') + '<p class="note">Tiempo típico de la 1ª respuesta según la hora en que te escribió el cliente. Las franjas con menos de ' + A.MIN_N + ' chats respondidos salen atenuadas.</p>';

    state.result = r;
    var rep = $('report'); rep.style.display = 'block';
    if (scroll !== false && !window.__NO_SCROLL) rep.scrollIntoView({ behavior: 'smooth' });
  }

  // Descarga del Excel (se arma en el navegador; nada sale de la computadora)
  function saveBlob(blob, name) {
    var a = document.createElement('a'), url = URL.createObjectURL(blob);
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }
  $('export-btn').onclick = function () {
    var r = state.result, msg = $('export-msg');
    if (!r) return;
    try {
      var bytes = window.Exporter.buildXlsx(window.Exporter.buildSheets(r, A));
      saveBlob(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), window.Exporter.fileName('xlsx'));
      msg.textContent = '✅ Listo: se descargaron ' + r.rows.length.toLocaleString('es-PE') + ' filas (una por conversación). Se generó en tu computadora; no viajó a ningún servidor. En la hoja “Resumen” están los conteos como fórmula.';
    } catch (err) {
      try {
        saveBlob(new Blob([window.Exporter.toCsv(r, A)], { type: 'text/csv;charset=utf-8' }), window.Exporter.fileName('csv'));
        msg.textContent = 'No pude armar el .xlsx, así que te descargué un CSV con las mismas columnas (ábrelo con Excel o Google Sheets). Sigue siendo local: no viajó a ningún servidor.';
      } catch (e2) { msg.textContent = 'No pude generar el archivo en este navegador. Prueba con Chrome o Edge actualizado.'; }
    }
  };

  // Eventos de carga
  var drop = $('drop'), fileIn = $('file'), dirIn = $('dir');
  $('pick').onclick = function (e) { e.stopPropagation(); fileIn.click(); };
  $('pick-dir').onclick = function (e) { e.stopPropagation(); dirIn.click(); };
  $('demo').onclick = function (e) { e.stopPropagation(); startDemo(); };
  drop.onclick = function () { fileIn.click(); };
  drop.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } };
  fileIn.onchange = function () { handleFiles(Array.prototype.slice.call(fileIn.files)); fileIn.value = ''; };
  dirIn.onchange = function () { handleFiles(Array.prototype.slice.call(dirIn.files)); dirIn.value = ''; };
  ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', async function (e) { handleFiles(await filesFromDrop(e.dataTransfer)); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  function startDemo() { state.convs = null; status('Datos de ejemplo (personas ficticias).'); handleEntries(window.SAMPLE_ENTRIES); }
  if (location.hash === '#demo') { window.__NO_SCROLL = true; startDemo(); }

  // CTA: correo (solo valida y guarda local; sin backend)
  $('mail-form').onsubmit = function (e) {
    e.preventDefault();
    var v = $('mail').value.trim(), msg = $('mail-msg');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) { msg.textContent = 'Revisa tu correo: parece que le falta algo.'; msg.style.color = '#8a6046'; return; }
    try { localStorage.setItem('auditor_email', v); } catch (err) { /* sin storage: seguimos */ }
    // TODO conectar a lista (ESP/Hotmart/Sheets). Hoy el correo NO sale de este navegador.
    msg.style.color = ''; msg.textContent = '¡Gracias! Anotado. TODO conectar a lista (por ahora solo queda en tu navegador).';
  };
})();
