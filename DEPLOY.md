# Pandishu — Instrucciones de Despliegue

## Arquitectura Final (Costo $0)

```
┌─────────────────────────┐     POST /contact_form     ┌──────────────────────┐
│   Firebase Hosting      │ ──────────────────────────► │  Cloud Function      │
│   (Static HTML/CSS/JS)  │                             │  (Python 3.12)       │
│   $0 — Spark Plan       │                             │  Gen2, 256MB         │
└─────────────────────────┘                             └──────────┬───────────┘
                                                                   │
                                                                   ▼
                                                        ┌──────────────────────┐
                                                        │  Telegram Bot API    │
                                                        │  (Notificacion)      │
                                                        └──────────────────────┘
```

---

## Paso 1: Deploy del Sitio Estatico (Firebase Hosting)

```bash
# Desde la raiz del proyecto
firebase deploy --only hosting
```

Eso sube todo el contenido de `public/` al CDN de Firebase.
Plan Spark = gratuito (10 GB transfer/mes, 1 GB storage).

---

## Paso 2: Deploy de la Cloud Function (Python)

```bash
cd cloud-function

gcloud functions deploy contact_form \
    --gen2 \
    --runtime python312 \
    --trigger-http \
    --allow-unauthenticated \
    --region us-central1 \
    --memory 256MB \
    --timeout 30s \
    --set-env-vars TELEGRAM_BOT_TOKEN=8503642999:AAH3xebf-Ur8VdFnfKxO-Ie-6z7f9dv8aiE,TELEGRAM_CHAT_ID=1326251215 \
    --project pandishu-web-1d860 \
    --source .
```

> **Nota:** Cloud Functions Gen2 incluye 2M invocaciones/mes gratis en el tier gratuito.
> Con un landing page de leads, es practicamente imposible superar ese limite.

---

## Paso 3: Verificar la URL de la Function

Despues del deploy, la CLI imprime la URL. Debe ser algo como:

```
https://us-central1-pandishu-web-1d860.cloudfunctions.net/contact_form
```

Esa URL ya esta configurada en el `index.html` (variable `FUNCTION_URL`).

---

## Paso 4: Probar el Flujo Completo

1. Abre el sitio en el navegador
2. Llena el formulario de cotizacion
3. Verifica que llegue la notificacion a Telegram
4. Verifica en Google Analytics que el evento `generate_lead` se registre

---

## Paso 5 (Opcional): Google Ads Conversion Tracking

En el `index.html`, busca esta linea en el script del formulario:

```js
gtag('event', 'conversion', { send_to: 'AW-XXXXXXX/XXXXXX' });
```

Reemplaza `AW-XXXXXXX/XXXXXX` con tu Conversion ID real de Google Ads.

---

## Archivos que se pueden eliminar (e-commerce legacy)

Estos archivos ya no son necesarios y pueden borrarse del directorio `public/`:

- `tienda.html`
- `checkout.html`
- `pedidos.html`
- `pedido.html`
- `admin.html`
- `success.html`
- `failure.html`
- `pending.html`
- `order-confirmation.html`
- `gracias.html`
- `soluciones.html`
- `globals.css`
- `temp_script.js`
- `PerfilRHPrueba.html`
- `index_old.html`

El directorio `functions/` (Node.js backend) tambien puede archivarse o eliminarse
ya que la unica funcion activa es la de Python en `cloud-function/`.

---

## Costos Mensuales Estimados

| Servicio              | Costo        |
|-----------------------|-------------|
| Firebase Hosting      | $0 (Spark)  |
| Cloud Function Gen2   | $0 (free tier) |
| Telegram Bot API      | $0          |
| **TOTAL**             | **$0 USD**  |
