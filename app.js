(function () {
  'use strict';
  var A = window.Auditor, $ = function (id) { return document.getElementById(id); };
  var state = { convs: null, detect: null, failed: 0 };

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
    state.convs = null; state.failed = 0; $('report').style.display = 'none'; $('owner-box').style.display = 'none';
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
    renderOwner(state.detect.owner);
    run(state.detect.owner);
  }

  function renderOwner(owner) {
    var d = state.detect, box = $('owner-box');
    box.style.display = 'block';
    box.innerHTML = 'Estoy analizando como tu cuenta a <b>' + esc(owner) + '</b> (aparece en ' + d.count[owner] + ' de las ' + d.total + ' conversaciones). ' +
      (d.ambiguous ? '<b>Dos cuentas empatan, confírmala:</b> ' : '¿Es otra? Elígela: ') +
      '<select id="owner-sel" aria-label="Elige tu cuenta">' + d.candidates.map(function (n) {
        return '<option value="' + esc(n) + '"' + (n === owner ? ' selected' : '') + '>' + esc(n) + ' (en ' + d.count[n] + (d.count[n] === 1 ? ' conversación' : ' conversaciones') + ')</option>';
      }).join('') + '</select>';
    $('owner-sel').onchange = function () { renderOwner(this.value); run(this.value); };
  }

  function run(owner) {
    var r = A.analyze(state.convs, owner);
    var warn = '';
    if (state.failed) warn += ' ⚠️ No pude leer ' + state.failed + ' archivos (si la carpeta está en iCloud/Drive, descárgala completa primero o sube el ZIP).';
    if (!r.ownerMsgs) { status('No encontré ningún mensaje tuyo. ¿Subiste la carpeta inbox completa (o el ZIP) y elegiste tu cuenta correcta?' + warn, true); return; }
    if (!r.analyzed) { status('No hay conversaciones iniciadas por clientes para analizar con "' + owner + '" como tu cuenta.', true); return; }
    status('Listo. Esto se calculó en tu computadora.' + warn, !!warn);
    render(r);
  }

  // opts: {bad, small, hl}. 'small' = muestra chica (atenuada, pero visible)
  function bar(label, pct, text, opts) {
    opts = opts || {};
    var cls = 'bar' + (opts.bad ? ' bad' : '') + (opts.small ? ' small' : '') + (opts.hl ? ' hl' : '');
    return '<div class="' + cls + '"><span>' + label + (opts.small ? ' <em>muestra chica</em>' : '') + '</span><div class="track"><div class="fill" style="width:' + Math.max(0, Math.min(100, pct)) + '%"></div></div><span class="v">' + text + '</span></div>';
  }
  function chats(n) { return n + (n === 1 ? ' chat' : ' chats'); }

  function render(r) {
    var rango = r.dateFrom !== null ? ', del ' + A.fmtDate(r.dateFrom) + ' al ' + A.fmtDate(r.dateTo) : '';
    $('scope').textContent = 'Analicé ' + r.analyzed + ' conversaciones iniciadas por clientes (' + r.totalMessages.toLocaleString('es-PE') + ' mensajes en total' + rango + ')' +
      (r.skippedGroups ? ', omití ' + r.skippedGroups + ' grupos' : '') +
      (r.skippedOwnerFirst ? ' y ' + r.skippedOwnerFirst + ' que iniciaste tú' : '') + '.' +
      (r.pendingRequests ? ' Aparte ' + (r.pendingRequests === 1 ? 'hay 1 solicitud de mensaje' : 'hay ' + r.pendingRequests + ' solicitudes de mensaje') + ' sin aceptar (no cuentan aquí; son personas que te escribieron y ni siquiera abriste).' : '') +
      ' 🔒 Esto se calculó en tu computadora.';

    var k = [
      [A.fmtDuration(r.meanMin), 'Tiempo promedio de 1ª respuesta (sobre ' + chats(r.answered) + ' respondidos)'],
      [A.fmtDuration(r.medianMin), 'Mediana (el caso típico)'],
      [Math.round(r.unansweredPct) + '%', r.unanswered + ' de ' + chats(r.analyzed) + ' sin respuesta'],
      [r.continuedPct === null ? '—' : Math.round(r.continuedPct) + '%', r.continued + ' de ' + chats(r.answered) + ' siguieron la conversación tras tu respuesta']
    ];
    $('kpis').innerHTML = k.map(function (x) { return '<div class="kpi"><b>' + x[0] + '</b><span>' + x[1] + '</span></div>'; }).join('');

    // 1. Tiempo de primera respuesta
    $('tramos').innerHTML = r.tramos.map(function (t, i) {
      return bar(t.label, t.pct, Math.round(t.pct) + '% <small>' + t.count + ' de ' + r.answered + '</small>', { bad: i >= 3 });
    }).join('') + (r.unanswered ? bar('Sin respuesta', r.unansweredPct, Math.round(r.unansweredPct) + '% <small>' + r.unanswered + ' de ' + r.analyzed + '</small>', { bad: true }) : '') +
      '<p class="note">Porcentaje sobre los ' + r.answered + ' chats que sí respondiste (los sin respuesta, sobre los ' + r.analyzed + ' analizados).</p>';

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
      advice = '<div class="worst">Tu punto ciego es la <b>' + wz.short + '</b>: ahí demoras una mediana de <b>' + A.fmtDuration(wz.median) + '</b> en responder (' + wz.answered + ' chats respondidos)' +
        (wz.unanswered ? ' y ' + chats(wz.unanswered) + ' se quedaron sin respuesta' : '') + '. Ahí se te van los leads' +
        (bz && bz.id === wz.id ? ', y además es cuando más te escriben' : '') + '.</div>';
    }
    $('horas-demoras').innerHTML = advice + r.franjas.map(function (f) {
      var txt = f.median === null ? '— <small>0 respondidos</small>' : A.fmtDuration(f.median) + ' <small>' + f.answered + ' de ' + f.total + ' respondidos</small>';
      return bar(f.label, f.median ? f.median / maxMed * 100 : 0, txt, { bad: wz && f.id === wz.id, small: f.median !== null && f.small });
    }).join('') + '<p class="note">Mediana de la 1ª respuesta según la hora en que te escribió el cliente. Las franjas con menos de ' + A.MIN_N + ' chats respondidos salen atenuadas.</p>';

    var rep = $('report'); rep.style.display = 'block';
    if (!window.__NO_SCROLL) rep.scrollIntoView({ behavior: 'smooth' });
  }

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
