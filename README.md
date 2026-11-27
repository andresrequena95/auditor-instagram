# Auditor de respuesta en Instagram (prototipo v2)

Landing estática "¿Cuánto demoras en responder a tus clientes?". 100% client-side: el export de Instagram se analiza en el navegador y nunca se sube. Apta para GitHub Pages.

## Archivos
- `index.html`, `styles.css`, `app.js` (interfaz), `analyzer.js` (parser y métricas; corre en navegador y en node).
- `sample-data.js`: datos sintéticos para el botón "Ver con datos de ejemplo".
- `datos-de-prueba/`: 14 chats de inbox + 1 solicitud ficticios con resultado conocido (`messages/...` y `export-de-prueba.zip`). Se regeneran, junto con `sample-data.js`, con `node test/generar-datos.js` (luego `cd datos-de-prueba && rm export-de-prueba.zip && zip -qr export-de-prueba.zip messages`).
- Lector de ZIP propio en `analyzer.js` (sin dependencias): lee el directorio central con `File.slice()`, soporta ZIP64 y descomprime solo los `message_*.json` con `DecompressionStream`. Acepta varios ZIP a la vez (volúmenes de ~2 GB) sin descomprimir ni cargar el archivo entero.

## Probarlo
- Navegador: abrir `index.html`, soltar `datos-de-prueba/export-de-prueba.zip` (o la carpeta `messages`), o usar el botón de ejemplo (también `index.html#demo`).
- Parser en node: `node test/run-test.js`. Contra el export real: `node test/run-zip-real.js <zip1> <zip2>`.
- Resultado esperado con los datos de prueba (hora Lima): 13 chats analizados, mediana 45 min, 2 sin respuesta, 4 de 11 siguieron la conversación, punto ciego Tarde. El test también valida el demo (curva decreciente, punto ciego Mañana).

## Qué hace
Corrige el latin1-sobre-utf8, une message_N.json por conversación, detecta tu cuenta (selector por si falla), mide la 1ª respuesta en chats iniciados por un tercero (omite grupos), tramos, % sin respuesta, franja de 6 h con más demora. Hora según la zona del navegador.

## Métricas (v2)
Continuidad por tramo de 1ª respuesta (el cliente volvió a escribir después de tu respuesta; tramos con <3 chats = muestra chica), n absolutos en todo, total de mensajes y rango de fechas, franjas horarias (cuándo te escriben y mediana de respuesta por franja, con punto ciego), selector de cuenta por frecuencia. Único dato externo: benchmark de 399 chats de WhatsApp de Mono Kids. Paleta de `5-marca/identidad-visual.md`.

## v5 (27/11/2026)
Métricas principales = respuesta **humana**. Detecta los mensajes automáticos de la cuenta (texto idéntico en ≥10 chats y en <30 s en ≥80% de los casos, más la tarjeta del anuncio) y los lista con checkbox para desmarcar los que no sean bot; las líneas de sistema de Meta ("replied to an ad", asignaciones) no cuentan. Los chats que abren con tarjeta + saludo automático son leads de pauta (la espera se mide desde el primer mensaje real del cliente). Embudo por origen (pauta / orgánico / tú escribiste primero), selector de cuenta discreto si aparece en ≥90% de las conversaciones y conteo de oportunidades (interés sin seguimiento, silencio ≥14 días, sin "gracias" ni WhatsApp). Sin bot detectado el reporte no menciona el tema. Contra el export real de Mono Kids: mediana humana ≈69 min, 5 automáticos (486, 425, 138, 59, 15 chats), ≈1,070 chats de pauta, ≈685 con bot. El demo y `test/run-test.js` cubren todo (incluye un caso sintético con respuestas exactas).

## Falta
- TODO: link de Hotmart en `#cta-hotmart` (hoy `href="#"`).
- TODO: conectar el email a una lista real (hoy solo valida y guarda en localStorage).
- Dominio y publicación (GitHub Pages / tucloncomercial.com).
- Probar con un export real de Instagram (estructura verificada solo con datos sintéticos) y con exports grandes.
- Mejoras posibles: PDF del reporte, WhatsApp .txt.
