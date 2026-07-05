# NEURO RUSH ⚡ — Cómo sacarlo a servidor

Creado por **Angel Fuentes** · © 2026. Todos los derechos reservados.

Hay dos metas distintas. Elige según lo que quieras:

- **A) Publicarlo en internet** para que cualquiera entre con un enlace → hosting gratuito (Opción 1 o 2). Da HTTPS automático, así que el micrófono funciona sin configurar nada.
- **B) Servirlo en tu red local** (tu PC + tu celular en el mismo WiFi) con micrófono funcionando → servidor local con HTTPS (Opción 3).

En todos los casos, el micrófono necesita HTTPS o localhost. Por eso `http://192.168.1.71:3004` no dejaba usarlo.

---

## Requisito de archivos

Sube/copia siempre estos juntos:
- `neuro-rush.html` (el juego)
- `LICENSE`
- (para servidor local) `server.js`

---

## Opción 1 — Netlify Drop (lo más fácil, gratis, 1 minuto)

1. Entra a https://app.netlify.com/drop
2. Arrastra la carpeta con `neuro-rush.html` (renómbralo `index.html` para que sea la página principal, o deja el nombre y entra a `.../neuro-rush.html`).
3. Netlify te da un enlace público con HTTPS. Listo: el micrófono ya funciona.

Para actualizar: vuelve a arrastrar la carpeta.

---

## Opción 2 — GitHub Pages (gratis, permanente)

1. Crea un repositorio en https://github.com
2. Sube `neuro-rush.html` (renómbralo `index.html`), `LICENSE` y `README.md`.
3. En el repo: **Settings → Pages → Branch: main → /root → Save**.
4. En 1–2 min tendrás una URL tipo `https://tuusuario.github.io/neuro-rush/` con HTTPS.

Alternativas equivalentes: **Vercel**, **Cloudflare Pages**, **Render (Static Site)**. Todas gratis y con HTTPS.

---

## Opción 3 — Servidor local con HTTPS (para jugar desde el celular en tu WiFi)

Necesitas **Node.js** instalado (https://nodejs.org).

### 3.1 Prueba rápida sin certificados (solo desde la misma PC)
```
node server.js
```
Abre `http://localhost:3004`. El micrófono funciona porque `localhost` es seguro.

### 3.2 Con HTTPS para que el micrófono sirva desde el celular

1. Averigua la IP local de tu PC:
   - Windows: `ipconfig` → busca "Dirección IPv4" (ej. 192.168.1.71)
   - Mac/Linux: `ifconfig` o `ip a`

2. Instala **mkcert** (crea certificados de confianza local):
   - Windows (con Chocolatey): `choco install mkcert`
   - Mac (con Homebrew): `brew install mkcert`
   - Linux: ver https://github.com/FiloSottile/mkcert

3. Genera el certificado (una vez):
   ```
   mkcert -install
   mkdir cert
   mkcert -key-file cert/key.pem -cert-file cert/cert.pem localhost 192.168.1.71
   ```
   (Cambia `192.168.1.71` por TU IP.)

4. Arranca el servidor:
   ```
   node server.js
   ```

5. Desde el celular (en el mismo WiFi) entra a:
   ```
   https://192.168.1.71:3443
   ```
   La primera vez el celular puede advertir del certificado: acepta continuar. Ahora el micrófono funcionará.

---

## ¿Cuál elijo?

- Solo quiero que amigos jueguen con un enlace → **Opción 1 (Netlify Drop)**.
- Quiero algo permanente y gratis → **Opción 2 (GitHub Pages)**.
- Quiero jugar con micrófono desde mi celular en casa → **Opción 3.2**.

---

## Nota sobre el micrófono y la música

El detector escucha los graves (bombo/bajo). Para mejores resultados:
- Sube el volumen de la bocina.
- Acerca el equipo a la bocina.
- Usa el deslizador de **Sensibilidad** en la pantalla de inicio: bájalo si salen pocas bolas, súbelo si salen de más.
- Si el ambiente tiene mucho ruido, usa mejor **📁 Cargar canción** (analiza el audio directo, sin micrófono).

---

© 2026 Angel Fuentes. Consulta `LICENSE` para los términos de uso.
