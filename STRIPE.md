# NEURO RUSH ⚡ — Configurar pagos con Stripe

Guía paso a paso para conectar la tienda de monedas. Hay dos etapas:

- **Etapa A — Desarrollo (modo prueba):** pagos falsos con tarjetas de test, en tu PC. No necesitas webhook.
- **Etapa B — Producción (modo real):** pagos reales en tu servidor de Railway. Aquí sí se usa webhook.

Empieza SIEMPRE por la Etapa A.

---

## Etapa A — Modo prueba (tu PC)

### A1. Crear la cuenta

1. Entra a **https://dashboard.stripe.com/register**
2. Registra tu correo y contraseña. Confirma el correo.
3. Cuando entres al panel, arriba a la derecha hay un interruptor **"Test mode" / "Modo de prueba"**. Debe estar **ENCENDIDO** (naranja). En modo prueba no se cobra dinero real.

> No necesitas completar los datos del negocio todavía. Eso solo hace falta para cobrar de verdad (Etapa B).

### A2. Copiar tu llave secreta de prueba

1. Entra directo a: **https://dashboard.stripe.com/test/apikeys**
   (o en el panel: menú **Developers → API keys**)
2. Verás dos llaves:
   - **Publishable key** → `pk_test_...` (esta NO se usa aquí)
   - **Secret key** → `sk_test_...` ← **esta es la que necesitas**
3. En la fila de la Secret key, haz clic en **"Reveal test key"** y cópiala completa.

### A3. Ponerla en tu archivo `.env`

Abre el archivo `.env` de la carpeta del proyecto y agrega estas dos líneas
(reemplaza con tu llave real):

```dotenv
STRIPE_SECRET_KEY=sk_test_51AbCd...tu_llave_completa
SHOP_CURRENCY=mxn
```

Guarda el archivo.

### A4. Probar la compra

1. En la terminal del proyecto: `npm start`
2. Abre **http://localhost:3004**, regístrate con un nombre y abre **🛒 TIENDA**.
3. Elige un pack de monedas → te lleva a la página de pago de Stripe.
4. Paga con la **tarjeta de prueba universal**:

   | Campo | Valor |
   |-------|-------|
   | Número | `4242 4242 4242 4242` |
   | Fecha | cualquiera futura (ej. `12/34`) |
   | CVC | cualquiera (ej. `123`) |
   | Nombre / código postal | cualquier cosa |

5. Al terminar, Stripe te devuelve al juego y las monedas se acreditan solas.

> ¿Por qué funciona sin webhook aquí? Porque al volver, el juego llama a
> `/api/shop/confirm`, que le pregunta a Stripe si el pago se completó y
> acredita las monedas. Es el respaldo pensado para desarrollo local.

Con esto la Etapa A está lista. Ya puedes vender monedas en pruebas.

---

## Etapa B — Modo real (producción en Railway)

Haz esto solo cuando quieras cobrar de verdad.

### B1. Activar tu cuenta para cobros reales

1. Entra a **https://dashboard.stripe.com/account/onboarding**
   (o el botón **"Activate account" / "Activar cuenta"** en el panel)
2. Completa los datos que pide: tipo de negocio (puedes ser persona física),
   tu nombre, dirección, y una **cuenta bancaria (CLABE)** donde recibir el dinero.
3. Espera la validación (suele ser inmediata o unos minutos).

### B2. Copiar tu llave secreta REAL

1. **APAGA** el interruptor "Test mode" (arriba a la derecha) → ahora estás en modo real.
2. Entra a **https://dashboard.stripe.com/apikeys** (sin el `/test/`)
3. Copia la **Secret key** que ahora empieza con **`sk_live_...`**

### B3. Cargar las variables en Railway

1. Entra a tu proyecto en **https://railway.app**
2. Abre tu servicio → pestaña **"Variables"**
3. Agrega (botón **"New Variable"**):

   | Variable | Valor |
   |----------|-------|
   | `STRIPE_SECRET_KEY` | tu `sk_live_...` |
   | `SHOP_CURRENCY` | `mxn` |

   *(el `STRIPE_WEBHOOK_SECRET` lo agregas en el paso B5)*

### B4. Crear el webhook

El webhook es la llamada que Stripe le hace a tu servidor para avisar
"este pago se completó" — así las monedas se acreditan aunque el jugador
cierre el navegador antes de volver.

1. Ten a la mano la URL pública de tu app en Railway
   (algo como `https://neuro-rush-production.up.railway.app`).
2. Entra a **https://dashboard.stripe.com/webhooks** (modo real, sin `/test/`)
3. Clic en **"Add endpoint" / "Agregar destino"**.
4. En **"Endpoint URL"** escribe tu URL + `/api/stripe/webhook`, por ejemplo:
   ```
   https://neuro-rush-production.up.railway.app/api/stripe/webhook
   ```
5. En **"Select events" / "Seleccionar eventos"**, busca y marca únicamente:
   ```
   checkout.session.completed
   ```
6. Clic en **"Add endpoint"** para guardarlo.

### B5. Copiar el secreto de firma del webhook

1. Ya creado el webhook, en su página verás **"Signing secret"**.
2. Clic en **"Reveal"** y copia el valor que empieza con **`whsec_...`**
3. Vuelve a Railway → Variables y agrega:

   | Variable | Valor |
   |----------|-------|
   | `STRIPE_WEBHOOK_SECRET` | tu `whsec_...` |

4. Railway reinicia el servicio solo. Listo.

### B6. (Opcional pero recomendado en México) Activar OXXO

Para jugadores sin tarjeta, puedes cobrar en efectivo por OXXO:

1. Entra a **https://dashboard.stripe.com/settings/payment_methods**
2. Busca **OXXO** y actívalo.

No hay que tocar código: Stripe Checkout lo mostrará automáticamente.

---

## Cómo sé que quedó bien

- **Prueba (Etapa A):** compras con `4242...` y ves las monedas en el juego.
- **Real (Etapa B):** en **https://dashboard.stripe.com/payments** aparece cada
  pago; en **https://dashboard.stripe.com/webhooks** el endpoint muestra
  entregas con estado `200`.

## Resumen de variables de entorno

| Variable | Etapa A (prueba) | Etapa B (real) |
|----------|------------------|----------------|
| `STRIPE_SECRET_KEY` | `sk_test_...` | `sk_live_...` |
| `SHOP_CURRENCY` | `mxn` | `mxn` |
| `STRIPE_WEBHOOK_SECRET` | *(no hace falta)* | `whsec_...` |
| `DEV_FREE_SHOP` | `true` *(opcional)* | *(NUNCA)* |

## Tienda de desarrollo: todo gratis (`DEV_FREE_SHOP`)

Para probar poderes, temas y emotes sin gastar monedas, agrega a tu `.env` **local**:

```dotenv
DEV_FREE_SHOP=true
```

Con la bandera activa, **toda compra con monedas cuesta 0** (poderes, revividas,
temas, emotes, ofertas y loadout del duelo). Los **topes** y las **compras únicas**
se siguen respetando (no podés tener 4 escudos ni comprar dos veces un tema).

Al arrancar, el servidor imprime un aviso: `⚠️ DEV_FREE_SHOP ACTIVO…`.

> ⚠️ **Nunca la pongas en producción (Railway).** Si la variable no existe o no
> es exactamente `true`, la tienda cobra normal. Por defecto está apagada.

## Precios actuales (editables en `shop.js` → `PACKS`)

| Pack | Monedas | Precio |
|------|---------|--------|
| small | 200 | $29 MXN |
| medium | 700 | $89 MXN |
| large | 1600 | $179 MXN |

Los montos están en **centavos** dentro de `shop.js` (ej. `2900` = $29.00).
