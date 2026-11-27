/* Excel con los datos del reporte — se genera 100% en el navegador, sin librerias y sin red.
   Un .xlsx es un ZIP de XMLs: aqui se ESCRIBE un ZIP minimo (sin compresion) con CRC32.
   Funciona en navegador (window.Exporter) y en node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Exporter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CRC_T = null;
  function crc32(u8) {
    if (!CRC_T) { CRC_T = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; } }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) crc = CRC_T[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  var enc = new TextEncoder();
  // files: [{name, data: string}] -> Uint8Array de un ZIP "stored"
  function zip(files) {
    var parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
      var lh = new Uint8Array(30 + name.length), v = new DataView(lh.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
      v.setUint16(10, 0, true); v.setUint16(12, 0x21, true); v.setUint32(14, crc, true); v.setUint32(18, data.length, true); v.setUint32(22, data.length, true);
      v.setUint16(26, name.length, true); v.setUint16(28, 0, true); lh.set(name, 30);
      var ch = new Uint8Array(46 + name.length), c = new DataView(ch.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true); ch.set(name, 46);
      parts.push(lh, data); central.push(ch); offset += lh.length + data.length;
    });
    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    var all = parts.concat(central, [end]), total = all.reduce(function (a, b) { return a + b.length; }, 0), out = new Uint8Array(total), p = 0;
    all.forEach(function (b) { out.set(b, p); p += b.length; });
    return out;
  }

  function xmlEsc(s) {
    return String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function colLetter(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

  // cell: string | number | {f: formula, v: valor} ; style 1 = encabezado
  function cellXml(ref, val, style) {
    var st = style ? ' s="' + style + '"' : '';
    if (val === '' || val === null || val === undefined) return '';
    if (typeof val === 'number') return '<c r="' + ref + '"' + st + '><v>' + val + '</v></c>';
    if (typeof val === 'object') return '<c r="' + ref + '"' + st + '><f>' + xmlEsc(val.f) + '</f><v>' + val.v + '</v></c>';
    return '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(val) + '</t></is></c>';
  }
  function sheetXml(grid, widths, opts) {
    opts = opts || {};
    var x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"' + (opts.first ? ' tabSelected="1"' : '') + '>' +
      (opts.freeze ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : '') + '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>';
    x += '<cols>' + widths.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols><sheetData>';
    grid.forEach(function (row, ri) {
      x += '<row r="' + (ri + 1) + '"' + (ri === 0 && opts.header ? ' ht="45" customHeight="1"' : '') + '>';
      row.forEach(function (v, ci) { x += cellXml(colLetter(ci) + (ri + 1), v, ri === 0 && opts.header ? 1 : (opts.boldCol0 && ci === 0 && v ? 0 : 0)); });
      x += '</row>';
    });
    x += '</sheetData>';
    if (opts.filter && grid.length) x += '<autoFilter ref="A1:' + colLetter(widths.length - 1) + grid.length + '"/>';
    return x + '</worksheet>';
  }

  var STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFAF6EE"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F2A44"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs></styleSheet>';

  // sheets: [{name, grid: [[...]], widths, header, freeze, filter}] -> Uint8Array (.xlsx)
  function buildXlsx(sheets) {
    var files = [
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') + '</Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map(function (s, i) { return '<sheet name="' + xmlEsc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') + '</sheets>' +
        '<calcPr fullCalcOnLoad="1"/></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
        '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: 'xl/styles.xml', data: STYLES }
    ];
    sheets.forEach(function (s, i) { files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(s.grid, s.widths, { header: s.header, freeze: s.freeze, filter: s.filter, first: i === 0 }) }); });
    return zip(files);
  }

  // ---------- Contenido: hoja "Datos" (una fila por conversacion) + hoja "Resumen" con formulas ----------
  function countIf(rows, key, pred) { return rows.filter(function (r) { return pred(r[key]); }).length; }
  function eq(v) { return function (x) { return x === v; }; }

  // Cada linea del resumen: la formula que ve el visitante en Excel, el valor que da sobre las filas y lo que muestra el reporte.
  function summaryLines(r, A) {
    var rows = r.rows, cols = {}, O = A.ORIGEN;
    A.COLUMNS.forEach(function (c, i) { cols[c.key] = colLetter(i) + ':' + colLetter(i); });
    function cif(key, text, pred) { return { f: 'COUNTIF(Datos!' + cols[key] + ',"' + text + '")', v: countIf(rows, key, pred) }; }
    var L = [];
    function add(label, cnt, report, group) { L.push({ label: label, f: cnt.f, v: cnt.v, report: report === undefined ? null : report, group: group || false }); }
    function head(label) { L.push({ label: label, head: true }); }
    var o = r.origins;
    head('Origen de los chats');
    add('Anuncios (pauta)', cif('origen', O.pauta, eq(O.pauta)), o.pauta.n);
    add('Orgánico — directo', cif('origen', O.directo, eq(O.directo)), o.organico.directo);
    add('Orgánico — desde una story', cif('origen', O.story, eq(O.story)), o.organico.story);
    add('Orgánico — desde un post compartido', cif('origen', O.post, eq(O.post)), o.organico.post);
    add('Tú escribiste primero', cif('origen', O.tu, eq(O.tu)), o.tu.n);
    add('Solicitudes de mensaje sin aceptar', cif('origen', O.sol, eq(O.sol)), r.pendingRequests);
    head('Atención');
    add('Chats analizados (clientes que escribieron)', { f: [O.pauta, O.directo, O.story, O.post].map(function (t) { return 'COUNTIF(Datos!' + cols.origen + ',"' + t + '")'; }).join('+'), v: rows.filter(function (x) { return x.origen !== O.tu && x.origen !== O.sol; }).length }, r.analyzed);
    add('Respondidos por una persona', { f: 'COUNT(Datos!' + cols.minutos + ')', v: rows.filter(function (x) { return x.minutos !== ''; }).length }, r.answered);
    add('Sin respuesta de una persona', cif('tramo', 'Sin respuesta', eq('Sin respuesta')), r.unanswered);
    add('Siguieron la conversación tras tu respuesta', cif('siguio', 'Sí', eq('Sí')), r.continued);
    add('Chats donde intervino el bot', cif('bot', 'Sí', eq('Sí')), r.bot.chatsWithBot);
    head('Tiempo hasta la primera respuesta de una persona');
    r.tramos.forEach(function (t) { add(t.label, cif('tramo', t.label, eq(t.label)), t.count); });
    head('Hora a la que te escribió el cliente');
    r.franjas.forEach(function (f) { add(f.label, cif('franja', f.label, eq(f.label)), f.total); });
    head('Oportunidades');
    add('Chats con señal de interés (incluye los que abriste tú)', { f: 'COUNTIF(Datos!' + cols.interes + ',"Sí*")', v: countIf(rows, 'interes', function (x) { return /^Sí/.test(x); }) }, r.opps.interested);
    add('Oportunidades que se quedaron en el camino', cif('oportunidad', 'Sí', eq('Sí')), r.opps.count);
    return L;
  }

  function buildSheets(r, A) {
    var cols = A.COLUMNS;
    var datos = [cols.map(function (c) { return c.title; })].concat(r.rows.map(function (row) { return cols.map(function (c) { return row[c.key]; }); }));
    var lines = summaryLines(r, A);
    var res = [['Cómo contarlo tú mismo', '', ''],
      ['Cada número del reporte sale de la hoja "Datos" (una fila por conversación). Aquí tienes cada conteo como fórmula de Excel: puedes filtrar la hoja Datos y comprobarlo.', '', ''],
      ['', '', ''],
      ['Concepto', 'En tu Excel (fórmula)', 'En el reporte']];
    lines.forEach(function (l) { res.push(l.head ? [l.label, '', ''] : [l.label, { f: l.f, v: l.v }, l.report === null ? '' : l.report]); });
    return [
      { name: 'Datos', grid: datos, widths: cols.map(function (c) { return c.width; }), header: true, freeze: true, filter: true },
      { name: 'Resumen', grid: res, widths: [58, 22, 16], header: false }
    ];
  }

  // Respaldo sin Excel: CSV con BOM UTF-8 (Excel lo abre con tildes bien)
  function toCsv(r, A) {
    function q(v) { v = String(v === undefined || v === null ? '' : v); if (/^[=+\-@]/.test(v) && isNaN(Number(v))) v = "'" + v; return /[",\n\r;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    var out = [A.COLUMNS.map(function (c) { return q(c.title); }).join(',')];
    r.rows.forEach(function (row) { out.push(A.COLUMNS.map(function (c) { return q(row[c.key]); }).join(',')); });
    return '﻿' + out.join('\r\n');
  }

  function fileName(ext, now) {
    var d = now || new Date();
    return 'auditoria-instagram-DATOS-' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '.' + ext;
  }

  return { buildXlsx: buildXlsx, buildSheets: buildSheets, summaryLines: summaryLines, toCsv: toCsv, fileName: fileName, crc32: crc32, zip: zip };
});
