'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const cors = require('cors')({ origin: true });
const XiSdk = require('xi_sdk_resellers');
const nodemailer = require('nodemailer');

admin.initializeApp();

// ─── CT CONNECT CONFIG ──────────────────────────────────────────────────────
const CT_API_BASE = process.env.CT_API_BASE || 'https://api.ctonline.mx';
const CT_CLIENT_NUM = process.env.CT_CLIENT_NUMBER;
const CT_EMAIL = process.env.CT_EMAIL;
const CT_RFC = process.env.CT_RFC;

// ─── INGRAM CREDENTIALS (Migration Reference) ──────────────────────────────────
const IM_CLIENT_ID = process.env.INGRAM_CLIENT_ID;
const IM_CLIENT_SECRET = process.env.INGRAM_CLIENT_SECRET;
const IM_SECRET_KEY = process.env.INGRAM_SECRET_KEY;
const IM_CUSTOMER_NUM = process.env.INGRAM_CUSTOMER_NUMBER || 'SBX';
const IM_COUNTRY_CODE = process.env.INGRAM_COUNTRY_CODE || 'MX';

// ─── CONVERSIÓN DE MONEDA (USD → MXN) ───────────────────────────────────────────────────────────
const MXN_RATE = parseFloat(process.env.MXN_EXCHANGE_RATE) || 17.50;
/**
 * Convierte un precio de USD a MXN usando el tipo de cambio en .env.
 * @param {number} usdPrice
 * @returns {{ price: number, currency: string }}
 */
function usdToMxn(usdPrice) {
    if (!usdPrice || isNaN(usdPrice)) return { price: 0, currency: 'MXN' };
    return { price: Math.round(usdPrice * MXN_RATE * 100) / 100, currency: 'MXN' };
}

// ─── TOKEN CACHE (CT CONNECT) ────────────────────────────────────────────────
let cachedCTToken = null;
let ctTokenExpiry = 0;

/**
 * Obtiene (o reutiliza si no venció) el token 'x-auth' de CT Internacional.
 */
async function getCTToken() {
    if (cachedCTToken && Date.now() < ctTokenExpiry) return cachedCTToken;

    console.log('Fetching new CT Connect Token for client:', CT_CLIENT_NUM);

    if (!CT_EMAIL || !CT_CLIENT_NUM || !CT_RFC) {
        throw new Error('CT credentials missing in .env (CT_EMAIL, CT_CLIENT_NUMBER, CT_RFC)');
    }

    try {
        const response = await fetch(`${CT_API_BASE}/cliente/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: CT_EMAIL,
                cliente: CT_CLIENT_NUM,
                rfc: CT_RFC
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`CT Auth Failed (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        if (!data.token) throw new Error('CT Auth response did not contain a token');

        cachedCTToken = data.token;
        // CT tokens suelen durar bastante, pero renovamos cada 2 horas por seguridad o lo que indique la API
        ctTokenExpiry = Date.now() + 2 * 60 * 60 * 1000;

        console.log('CT Token obtained successfully');
        return cachedCTToken;
    } catch (error) {
        console.error('getCTToken error:', error);
        throw error;
    }
}

/**
 * Crea y configura el ApiClient del SDK con el token activo.
 */
async function getApiClient() {
    const token = await getAccessToken();
    const client = XiSdk.ApiClient.instance;

    // Configurar explícitamente la URL de Sandbox
    client.basePath = 'https://api.ingrammicro.com:443/sandbox';

    // OAuth2
    const auth = client.authentications['application'];
    auth.accessToken = token;

    // Headers comunes de Ingram
    client.defaultHeaders = {
        'IM-CustomerNumber': IM_CUSTOMER_NUM,
        'IM-CountryCode': IM_COUNTRY_CODE,
        'IM-SenderID': 'Pandishu',
        'IM-SecretKey': IM_SECRET_KEY, // Requerido para algunas operaciones de catálogo v6
    };

    return client;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURACIÓN DE CORREO (Nodemailer)
// ─────────────────────────────────────────────────────────────────────────────
let mailTransporter = null;
const getMailTransporter = () => {
    if (mailTransporter) return mailTransporter;
    if (process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD) {
        mailTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.SMTP_EMAIL,
                pass: process.env.SMTP_PASSWORD
            }
        });
    }
    return mailTransporter;
};

async function enviarCorreoConfirmacion(toEmail, customerName, orderId, cartItems, totalAmount) {
    const transporter = getMailTransporter();
    if (!transporter) {
        console.warn('⚠️ No se envió correo: SMTP_EMAIL o SMTP_PASSWORD no están configurados.');
        return;
    }

    // Generar la lista de productos en HTML
    let itemsHtml = '';
    cartItems.forEach(item => {
        itemsHtml += `
            <tr>
                <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); color: #e2e8f0;">${item.name} (x${item.quantity})</td>
                <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); color: #e2e8f0; text-align: right;">$${Number(item.price * item.quantity).toFixed(2)} MXN</td>
            </tr>
        `;
    });

    const emailHtml = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 40px 20px; line-height: 1.6;">
        <div style="max-width: 600px; margin: 0 auto; background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 16px; padding: 30px; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
            <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="background: linear-gradient(135deg, #a855f7 0%, #6366f1 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin: 0; font-size: 32px;">PANDISHÚ</h1>
                <p style="color: #94a3b8; font-size: 14px; letter-spacing: 2px;">TECHNOLOGY SOLUTIONS</p>
            </div>
            
            <h2 style="color: #e2e8f0; border-bottom: 2px solid #334155; padding-bottom: 10px;">¡Gracias por tu compra, ${customerName}!</h2>
            <p style="color: #cbd5e1;">Tu orden <strong>#${orderId}</strong> ha sido confirmada y el pago fue procesado exitosamente. Estamos preparando tus productos para el envío.</p>
            
            <div style="margin: 30px 0; background: rgba(15, 23, 42, 0.5); border-radius: 8px; padding: 15px;">
                <h3 style="color: #a855f7; margin-top: 0;">Resumen del Pedido</h3>
                <table style="width: 100%; border-collapse: collapse;">
                    ${itemsHtml}
                    <tr>
                        <td style="padding: 10px; font-weight: bold; color: #fff; text-align: right;">TOTAL:</td>
                        <td style="padding: 10px; font-weight: bold; color: #a855f7; text-align: right; font-size: 18px;">$${Number(totalAmount).toFixed(2)} MXN</td>
                    </tr>
                </table>
            </div>
            
            <p style="color: #94a3b8; font-size: 13px; text-align: center; margin-top: 40px; border-top: 1px solid #334155; padding-top: 20px;">
                Cualquier duda, responde a este correo o contáctanos por WhatsApp.<br>
                © ${new Date().getFullYear()} Pandishú. Todos los derechos reservados.
            </p>
        </div>
    </div>
    `;

    try {
        await transporter.sendMail({
            from: '"Pandishú Tech" <' + process.env.SMTP_EMAIL + '>',
            to: toEmail,
            subject: 'Confirmación de Pedido #' + orderId,
            html: emailHtml
        });
        console.log(`✉️ Correo de confirmación enviado a ${toEmail} para la orden ${orderId}`);
    } catch (error) {
        console.error('Error enviando correo con Nodemailer:', error);
    }
}

/**
 * FUNCTION — enviarCorreoEnvio
 * Notifica al cliente que su pedido ha sido enviado con detalles de rastreo.
 */
async function enviarCorreoEnvio(toEmail, customerName, orderId, trackingNumber) {
    const transporter = getMailTransporter();
    if (!transporter) {
        console.warn('⚠️ No se envió correo de envío: SMTP_EMAIL o SMTP_PASSWORD no están configurados.');
        return;
    }

    const emailHtml = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 40px 20px; line-height: 1.6;">
        <div style="max-width: 600px; margin: 0 auto; background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 16px; padding: 30px; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
            <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="background: linear-gradient(135deg, #a855f7 0%, #6366f1 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin: 0; font-size: 32px;">PANDISHÚ</h1>
                <p style="color: #94a3b8; font-size: 14px; letter-spacing: 2px;">TECHNOLOGY SOLUTIONS</p>
            </div>
            
            <h2 style="color: #e2e8f0; border-bottom: 2px solid #334155; padding-bottom: 10px;">¡Buenas noticias, ${customerName}!</h2>
            <p style="color: #cbd5e1;">Tu pedido <strong>#${orderId}</strong> ha sido enviado. Estamos muy emocionados de que pronto lo tengas en tus manos.</p>
            
            <div style="margin: 30px 0; background: rgba(15, 23, 42, 0.5); border-radius: 8px; padding: 20px; text-align: center; border: 1px dashed #6366f1;">
                <h3 style="color: #a855f7; margin-top: 0;">Número de Guía / Rastreo</h3>
                <p style="font-size: 24px; font-weight: bold; color: #fff; margin: 10px 0; letter-spacing: 1px;">${trackingNumber}</p>
                <p style="color: #94a3b8; font-size: 14px;">Utiliza este número en el portal de la paquetería para seguir tu envío.</p>
            </div>
            
            <p style="color: #94a3b8; font-size: 13px; text-align: center; margin-top: 40px; border-top: 1px solid #334155; padding-top: 20px;">
                Cualquier duda, responde a este correo o contáctanos por WhatsApp.<br>
                © ${new Date().getFullYear()} Pandishú. Todos los derechos reservados.
            </p>
        </div>
    </div>
    `;

    try {
        await transporter.sendMail({
            from: '"Pandishú Tech" <' + process.env.SMTP_EMAIL + '>',
            to: toEmail,
            subject: '¡Tu pedido #' + orderId + ' ha sido enviado! 🚚',
            html: emailHtml
        });
        console.log(`🚚 Correo de envío enviado a ${toEmail} para la orden ${orderId}`);
    } catch (error) {
        console.error('Error enviando correo de envío:', error);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 1 — searchProducts
// GET /resellers/v6/catalog?keyword=...
// Llamado desde tienda.html
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 1 — searchProducts
// GET /existencia/promociones (CT Connect)
// ─────────────────────────────────────────────────────────────────────────────
exports.searchProducts = functions.runWith({
    vpcConnector: 'pandishu-vpc-connector',
    vpcConnectorEgressSettings: 'ALL_TRAFFIC',
    timeoutSeconds: 60,
    labels: {
        "environment": "production",
        "project": "pandishu",
        "owner": "oscar",
        "cost_center": "sales"
    }
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

        try {
            const body = req.body || {};

            if (process.env.USE_MOCK_DATA === 'true') {
                console.log('\uD83D\uDD39 Sirviendo cat\u00e1logo MOCK');
                return res.status(200).json(getMockSearchData(body.keyword));
            }

            // ── LEER DESDE FIRESTORE (ct_catalog) ──────────────────────────
            // La colecci\u00f3n se llena por syncCTCatalog (FTP) cada 15 minutos
            const catalogSnap = await admin.firestore().collection('ct_catalog').limit(500).get();

            if (catalogSnap.empty) {
                console.warn('ct_catalog est\u00e1 vac\u00edo. Ejecuta syncCTCatalog primero.');
                return res.status(200).json({ recordsFound: 0, catalog: [], message: 'Sync pendiente. Intenta en unos minutos.' });
            }

            let fullCatalog = catalogSnap.docs.map(d => d.data());

            // Filtrado por keyword
            let keyword = '';
            if (body.keyword) {
                keyword = Array.isArray(body.keyword) ? body.keyword[0].toString().toLowerCase() : body.keyword.toString().toLowerCase();
            }

            let filteredResults = fullCatalog;
            if (keyword && keyword !== 'all') {
                filteredResults = fullCatalog.filter(p =>
                    (p.description && p.description.toLowerCase().includes(keyword)) ||
                    (p.vendorName && p.vendorName.toLowerCase().includes(keyword)) ||
                    (p.ingramPartNumber && p.ingramPartNumber.toLowerCase().includes(keyword))
                );
            }

            return res.status(200).json({
                recordsFound: filteredResults.length,
                catalog: filteredResults.slice(0, 100)
            });

        } catch (err) {
            console.error('searchProducts error:', err.message);
            if (process.env.USE_MOCK_DATA === 'true') {
                return res.status(200).json(getMockSearchData(req.body?.keyword));
            }
            return res.status(500).json({ error: 'Error al obtener cat\u00e1logo: ' + err.message });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS DE MOCK DATA
// ─────────────────────────────────────────────────────────────────────────────
function getMockSearchData(queryKeyword) {
    const mockCatalog = [
        { ingramPartNumber: "MOCK-UBI-01", vendorName: "UBIQUITI", vendorPartNumber: "UAP-AC-PRO", description: "Ubiquiti UniFi AC Pro AP - Punto de acceso inalámbrico - 802.11a/b/g/n/ac - Banda doble" },
        { ingramPartNumber: "MOCK-CIS-01", vendorName: "CISCO", vendorPartNumber: "CBS350-24T-4G", description: "Cisco Business 350 Series 24-Port Gigabit Managed Switch" },
        { ingramPartNumber: "MOCK-DEL-01", vendorName: "DELL", vendorPartNumber: "XPS-13-9315", description: "Dell XPS 13 9315 - Intel Core i7 1250U - 16GB RAM - 512GB SSD - 13.4\" FHD+" },
        { ingramPartNumber: "MOCK-SAM-01", vendorName: "SAMSUNG", vendorPartNumber: "MZ-V8V1T0B/AM", description: "Samsung 980 SSD 1TB PCle 3.0x4, NVMe M.2 2280" },
        { ingramPartNumber: "MOCK-APP-01", vendorName: "APPLE", vendorPartNumber: "MGN63LA/A", description: "MacBook Air 13.3\" - Apple M1 - 8GB RAM - 256GB SSD - Gris Espacial" },
        { ingramPartNumber: "MOCK-LOG-01", vendorName: "LOGITECH", vendorPartNumber: "910-005620", description: "Logitech MX Master 3S Mouse Inalámbrico, Desplazamiento Ultrarrápido" },
        { ingramPartNumber: "MOCK-APC-01", vendorName: "APC", vendorPartNumber: "BR1500G", description: "APC Back-UPS Pro 1500VA, 865W, 10 Outlets" },
        { ingramPartNumber: "MOCK-LEN-01", vendorName: "LENOVO", vendorPartNumber: "21A400A7US", description: "Lenovo ThinkPad E15 Gen 4 - AMD Ryzen 5 - 16GB RAM - 512GB SSD" },
        { ingramPartNumber: "MOCK-SYN-01", vendorName: "SYNOLOGY", vendorPartNumber: "DS923+", description: "Synology DiskStation DS923+ 4-Bay NAS Enclosure" },
        { ingramPartNumber: "MOCK-HP-01", vendorName: "HP", vendorPartNumber: "400-G9-SFF", description: "HP ProDesk 400 G9 SFF - Intel Core i5 12500 - 16GB RAM - 512GB SSD" }
    ];

    let filteredMocks = mockCatalog;

    // Ensure queryKeyword is a string (it might arrive as an array like ["Tapo"] from the POST body)
    let keyword = '';
    if (queryKeyword) {
        keyword = Array.isArray(queryKeyword) ? queryKeyword[0].toString().toLowerCase() : queryKeyword.toString().toLowerCase();
    }

    if (keyword && keyword !== 'all') {
        filteredMocks = mockCatalog.filter(p =>
            p.description.toLowerCase().includes(keyword) ||
            p.vendorName.toLowerCase().includes(keyword) ||
            p.ingramPartNumber.toLowerCase().includes(keyword)
        );
    }
    return { recordsFound: filteredMocks.length, catalog: filteredMocks };
}

function getMockPricingData(skus) {
    const mockPrices = {
        "MOCK-UBI-01": 149.99, "MOCK-CIS-01": 299.50, "MOCK-DEL-01": 1250.00,
        "MOCK-SAM-01": 85.99, "MOCK-APP-01": 999.00, "MOCK-LOG-01": 99.99,
        "MOCK-APC-01": 215.00, "MOCK-LEN-01": 850.00, "MOCK-SYN-01": 599.99,
        "MOCK-HP-01": 720.00
    };
    return skus.map(sku => {
        const basePrice = mockPrices[sku] || 150.00;
        const mxnPrice = usdToMxn(basePrice);
        const stock = sku.includes('MOCK') ? (sku.charCodeAt(sku.length - 2) * 2) : 5;
        return {
            ingramPartNumber: sku,
            pricing: { customerPrice: mxnPrice.price, customerPriceUSD: basePrice, currencyCode: mxnPrice.currency },
            availability: {
                availableQuantity: stock, totalAvailability: stock,
                availabilityByWarehouse: [{ warehouseId: 'MX', quantityAvailable: stock }]
            }
        };
    });
}


// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 2 — getPriceAndAvailability
// POST body: { skus: ["SKU1", "SKU2"] }  (máx 50)
// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 2 — getPriceAndAvailability
// POST body: { skus: ["SKU1", "SKU2"] }  (CT Connect)
// GET /existencia/promociones/:codigo → { codigo, precio, moneda, almacenes:[{almacen, existencia}] }
// ─────────────────────────────────────────────────────────────────────────────
exports.getPriceAndAvailability = functions.runWith({
    vpcConnector: 'pandishu-vpc-connector',
    vpcConnectorEgressSettings: 'ALL_TRAFFIC',
    timeoutSeconds: 60,
    labels: {
        "environment": "production",
        "project": "pandishu",
        "owner": "oscar",
        "cost_center": "sales"
    }
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        const { skus } = req.body;
        if (!Array.isArray(skus) || skus.length === 0) {
            return res.status(400).json({ error: 'Se requiere el array skus' });
        }

        try {
            if (process.env.USE_MOCK_DATA === 'true') {
                console.log('🔹 Sirviendo precios MOCK por configuración USE_MOCK_DATA=true');
                return res.status(200).json(getMockPricingData(skus));
            }

            const token = await getCTToken();

            // Consultamos cada SKU en paralelo usando el endpoint correcto de CT
            const results = await Promise.all(skus.map(async (sku) => {
                try {
                    // Endpoint correcto: GET /existencia/promociones/:codigo
                    // Respuesta: { codigo, precio, moneda, almacenes: [{almacen, existencia}] }
                    const response = await fetch(`${CT_API_BASE}/existencia/promociones/${sku}`, {
                        headers: { 'x-auth': token }
                    });

                    if (!response.ok) return null;

                    const data = await response.json();

                    // La moneda puede ser USD o MXN según la documentación oficial
                    let precioMXN = data.precio || 0;
                    const moneda = data.moneda || 'USD';

                    if (moneda === 'USD') {
                        // Convertir a MXN usando el tipo de cambio configurado
                        const mxn = usdToMxn(precioMXN);
                        precioMXN = mxn.price;
                    }

                    // Sumar existencias de todos los almacenes
                    const almacenes = Array.isArray(data.almacenes) ? data.almacenes : [];
                    const totalExistencia = almacenes.reduce((sum, alm) => sum + (alm.existencia || 0), 0);

                    return {
                        ingramPartNumber: sku, // key por compatibilidad con el front-end
                        pricing: {
                            customerPrice: precioMXN,
                            customerPriceOriginal: data.precio || 0,
                            currencyCode: 'MXN' // Siempre devolvemos en MXN
                        },
                        availability: {
                            availableQuantity: totalExistencia,
                            totalAvailability: totalExistencia,
                            availabilityByWarehouse: almacenes
                        }
                    };
                } catch (e) {
                    console.error(`Error fetching SKU ${sku} from CT:`, e.message);
                    return null;
                }
            }));

            const safePricing = results.filter(r => r !== null);

            // Actualizar Cache local
            try {
                const batch = admin.firestore().batch();
                safePricing.forEach(item => {
                    const docRef = admin.firestore().collection('products_cache').doc(item.ingramPartNumber);
                    batch.set(docRef, { ...item, lastPaUpdate: FieldValue.serverTimestamp() }, { merge: true });
                });
                await batch.commit();
            } catch (e) { console.warn("Cache warning:", e.message); }

            return res.status(200).json(safePricing);

        } catch (err) {
            console.error('getPriceAndAvailability (CT) error:', err.message);
            return res.status(200).json(getMockPricingData(skus));
        }
    });
});



// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 3 — ingramWebhook
// POST — Ingram Micro envía eventos aquí (OrderStatus, StockUpdate, etc.)
// ESTA URL es la que registras en el portal de Ingram como Destination URL
// ─────────────────────────────────────────────────────────────────────────────
exports.ingramWebhook = functions.https.onRequest(async (req, res) => {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        const crypto = require('crypto');
        const signature = req.headers['x-hub-signature'] || req.headers['authorization'] || '';
        const eventId = req.body.eventId;

        let isValid = false;
        if (IM_SECRET_KEY && eventId) {
            const hmac = crypto.createHmac('sha512', IM_SECRET_KEY);
            hmac.update(eventId, 'utf-8');
            const expectedSignature = hmac.digest('base64');

            if (signature === expectedSignature || signature.includes(expectedSignature)) {
                isValid = true;
            } else {
                console.warn('[Ingram Webhook] Signature mismatch. Expected:', expectedSignature, 'Got:', signature);
            }
        } else {
            console.warn('[Ingram Webhook] Missing IM_SECRET_KEY or eventId in payload.');
        }

        // Permitimos continuar si es local/sandbox por motivos de dev, pero marcamos warning
        if (!isValid) {
            console.warn('⚠️ Webhook Payload no validado por firma SHA512.');
            // return res.status(401).send('Unauthorized webhook'); // Descomentar en Prod Estricto
        }

        const payload = req.body;
        console.log(`[Ingram Webhook] Recibido eventId: ${eventId}`);

        // Guardar raw payload en Firestore para auditoría
        try {
            await admin.firestore().collection('ingram_events').add({
                receivedAt: FieldValue.serverTimestamp(),
                eventId: eventId || 'unknown',
                topic: payload.topic || 'unknown',
                rawPayload: payload,
                isValidSignature: isValid
            });
        } catch (dbErr) {
            console.warn('⚠️ No se pudo guardar auditorio en Firestore (probablemente no inicializado localmente).', dbErr.message);
        }

        // ─── PROCESAMIENTO DE RECURSOS SEGÚN EVENTO ───
        if (payload.resource && Array.isArray(payload.resource)) {
            for (const resource of payload.resource) {
                const eventType = resource.eventType ? resource.eventType.toLowerCase() : '';

                // 1) STOCK_UPDATE: Actualizamos el caché de disponibilidad
                if (eventType === 'im::stock_update') {
                    const sku = resource.ingramPartNumber;
                    const stockStr = resource.totalAvailability;
                    if (sku && stockStr != null) {
                        try {
                            const stockNum = parseInt(stockStr, 10);
                            await admin.firestore().collection('products_cache').doc(sku).set({
                                ingramPartNumber: sku,
                                availableQuantity: stockNum,
                                lastWebhookUpdate: FieldValue.serverTimestamp()
                            }, { merge: true });
                            console.log(`✅ Cache actualizado: SKU ${sku} tiene ${stockNum} en stock.`);
                        } catch (e) { console.error('Error guardando cache:', e.message); }
                    }
                }

                // 2) ACTUALIZACIONES DE ÓRDENES: shipped, invoiced, voided, hold, etc.
                if (eventType.startsWith('im::order_')) {
                    const ingramOrderNumber = resource.orderNumber;
                    const customerOrderNumber = resource.customerOrderNumber; // Este es nuestro orderRefUid de Firestore

                    if (customerOrderNumber) {
                        const updateData = {
                            ingramStatus: eventType.replace('im::order_', ''),
                            ingramOrderNumber: ingramOrderNumber,
                            lastIngramUpdate: FieldValue.serverTimestamp()
                        };

                        // Extraer tracking de shipmentDetails (si existe para order_shipped)
                        if (eventType === 'im::order_shipped' && resource.lines) {
                            let trackingNums = [];
                            resource.lines.forEach(line => {
                                if (line.shipmentDetails) {
                                    line.shipmentDetails.forEach(ship => {
                                        if (ship.packageDetails) {
                                            ship.packageDetails.forEach(pkg => {
                                                if (pkg.trackingNumber) trackingNums.push(pkg.trackingNumber);
                                            });
                                        }
                                    });
                                }
                            });
                            if (trackingNums.length > 0) {
                                updateData.trackingNumbers = trackingNums;

                                // 🚚 Notificar al cliente por correo con el número de guía
                                try {
                                    const orderDoc = await admin.firestore().collection('orders').doc(customerOrderNumber).get();
                                    if (orderDoc.exists) {
                                        const orderData = orderDoc.data();
                                        await enviarCorreoEnvio(
                                            orderData.customerInfo.email,
                                            orderData.customerInfo.name,
                                            customerOrderNumber,
                                            trackingNums[0] // Primer número de guía
                                        );
                                    }
                                } catch (mailErr) {
                                    console.warn('⚠️ No se pudo enviar correo de envío:', mailErr.message);
                                }
                            }
                        }

                        try {
                            // Actualizar la orden de nuestro lado
                            await admin.firestore().collection('orders').doc(customerOrderNumber).update(updateData);
                            console.log(`✅ Orden ${customerOrderNumber} actualizada con estado ${updateData.ingramStatus}`);
                        } catch (e) {
                            console.error(`⚠️ No se pudo actualizar orden ${customerOrderNumber} en Firestore:`, e.message);
                        }
                    }
                }
            }
        }

        // Siempre devolver 200 rápido a Ingram para no causar retries
        return res.status(200).json({ status: 'received', eventId });
    } catch (err) {
        console.error('[Ingram Webhook] Error Crítico:', err);
        return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ─── PAYMENTS: MERCADO PAGO INTEGRATION ──────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const { MercadoPagoConfig, Preference } = require('mercadopago');

const getMercadoPagoClient = () => {
    if (!process.env.MP_ACCESS_TOKEN) {
        console.warn("Missing MP_ACCESS_TOKEN env variable");
        return null;
    }
    // Set up MercadoPago client
    return new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
};

const YOUR_DOMAIN = 'https://www.pandishu.com'; // Production URL

/**
 * FUNCTION 4 — createCheckoutSession
 * POST body: { items: [...], customer: {...} }
 * Crea una preferencia de pago en Mercado Pago y devuelve el init_point para redirigir al usuario.
 */
exports.createCheckoutSession = functions.runWith({
    vpcConnector: 'pandishu-vpc-connector',
    vpcConnectorEgressSettings: 'ALL_TRAFFIC',
    timeoutSeconds: 60,
    labels: {
        "environment": "production",
        "project": "pandishu",
        "owner": "oscar",
        "cost_center": "sales"
    }
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        const client = getMercadoPagoClient();
        if (!client) return res.status(500).json({ error: 'Mercado Pago is not configured in environment variables' });

        try {
            const { items, customer } = req.body;

            if (!items || items.length === 0) {
                return res.status(400).json({ error: 'El carrito está vacío' });
            }

            // Mapear los items del carrito a la estructura de Mercado Pago
            const preferenceItems = items.map(item => {
                return {
                    id: item.sku,
                    title: item.name,
                    description: `Vendor: ${item.vendor || 'Pandishú'}`,
                    quantity: item.quantity,
                    currency_id: 'MXN',
                    unit_price: Number(item.price)
                };
            });

            // Agregamos el costo de envío fijo mandatorio
            const shippingCost = 149.00;
            preferenceItems.push({
                id: 'SHIPPING-01',
                title: 'Envío Estándar',
                description: 'Costo fijo de envío a domicilio',
                quantity: 1,
                currency_id: 'MXN',
                unit_price: shippingCost
            });

            // Metadata must be serialized as external_reference or saved before/after
            // We use external_reference as a unique ID to link back to Firestore
            // Let's create an order document IN ADVANCE with status "pending"
            let orderRefId = `mock-order-${Date.now()}`;
            try {
                const orderRef = await admin.firestore().collection('orders').add({
                    status: 'pending_payment',
                    createdAt: FieldValue.serverTimestamp(),
                    customerInfo: customer,
                    items: items,
                    shippingCost: shippingCost,
                    ingramStatus: 'pending',
                    amountTotal: items.reduce((sum, item) => sum + (item.price * item.quantity), 0) + shippingCost
                });
                orderRefId = orderRef.id;
            } catch (dbErr) {
                console.warn('⚠️ Firestore save failed (likely not initialized). Using mock order ID.', dbErr.message);
            }

            // Crear la preferencia usando la nueva sintaxis (v2)
            const preference = new Preference(client);

            const prefResponse = await preference.create({
                body: {
                    items: preferenceItems,
                    payer: {
                        name: customer.name,
                        email: customer.email,
                        phone: { number: customer.phone },
                        address: {
                            zip_code: customer.address.zip,
                            street_name: customer.address.street,
                        }
                    },
                    back_urls: {
                        success: `${YOUR_DOMAIN}/order-confirmation.html`,
                        failure: `${YOUR_DOMAIN}/checkout.html?error=failed`,
                        pending: `${YOUR_DOMAIN}/order-confirmation.html?status=pending`
                    },
                    auto_return: 'approved',
                    external_reference: orderRefId, // Vínculo con nuestra BD
                    statement_descriptor: 'Pandishu Tech',
                    purpose: 'wallet_purchase', // Obligatorio para Wallet Brick
                    // Redirigir notificaciones de pago aquí
                    notification_url: 'https://us-central1-pandishu-web-1d860.cloudfunctions.net/mpWebhook'
                },
                requestOptions: { idempotencyKey: orderRefId }
            });

            // Retornamos el init_point (o sandbox_init_point si estamos en dev)
            return res.status(200).json({ url: prefResponse.init_point });

        } catch (err) {
            console.error('Error createCheckoutSession MP:', err);
            return res.status(500).json({ error: err.message });
        }
    });
});

/**
 * FUNCTION 6 — processCustomPayment
 * POST body: { token, payment_method_id, installments, issuer_id, customer, items }
 * Crea un Customer en MP, asocia la tarjeta y procesa el pago de inmediato.
 */
exports.processCustomPayment = functions.runWith({
    vpcConnector: 'pandishu-vpc-connector',
    vpcConnectorEgressSettings: 'ALL_TRAFFIC',
    timeoutSeconds: 60,
    labels: {
        "environment": "production",
        "project": "pandishu",
        "owner": "oscar",
        "cost_center": "sales"
    }
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        const client = getMercadoPagoClient();
        if (!client) return res.status(500).json({ error: 'Mercado Pago is not configured' });

        try {
            const { token, payment_method_id, installments, issuer_id, customer, items } = req.body;

            if (!token || !items || !customer) {
                return res.status(400).json({ error: 'Faltan datos requeridos (token, items o customer).' });
            }

            // 1) Calc amount
            const shippingCost = 149.00;
            const amountTotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0) + shippingCost;

            // 2) Buscar o crear Customer en MP
            const { Customer, CustomerCard, Payment } = require('mercadopago');
            const customerClient = new Customer(client);
            let mpCustomerId = null;

            try {
                const searchRes = await customerClient.search({ qs: { email: customer.email } });
                if (searchRes.results && searchRes.results.length > 0) {
                    mpCustomerId = searchRes.results[0].id;
                } else {
                    const newCustomer = await customerClient.create({ body: { email: customer.email } });
                    mpCustomerId = newCustomer.id;
                }
            } catch (err) {
                console.warn("⚠️ No se pudo buscar/crear cliente MP. Continuando sin vincular tarjeta.", err.message);
            }

            // 3) Guardar la tarjeta al Customer usando el token
            // Nota: MP puede rechazar el token en CustomerCard.create si se usa directo en Payment después,
            // pero el flujo de MP permite guardar e intentar. Si falla el save, no bloqueamos el pago.
            if (mpCustomerId && token) {
                try {
                    const customerCardClient = new CustomerCard(client);
                    await customerCardClient.create({ customerId: mpCustomerId, body: { token } });
                } catch (cardErr) {
                    console.warn("⚠️ No se pudo vincular tarjeta.", cardErr.message);
                }
            }

            // 4) Crear orden inicial en Firestore
            let orderRefId = `mock-order-${Date.now()}`;
            try {
                const orderRef = await admin.firestore().collection('orders').add({
                    status: 'processing_payment',
                    createdAt: FieldValue.serverTimestamp(),
                    customerInfo: customer,
                    items: items,
                    shippingCost: shippingCost,
                    amountTotal: amountTotal,
                    ingramStatus: 'pending'
                });
                orderRefId = orderRef.id;
            } catch (dbErr) {
                console.warn('⚠️ Firestore save failed. Using mock ID.', dbErr.message);
            }

            // 5) Procesar el Pago
            const paymentClient = new Payment(client);

            // Mapear items al formato de additional_info (Recomendado para Apparel/Retail)
            const mpItems = items.map(item => ({
                id: item.sku || item.id || 'sku-pandishu',
                title: item.name || 'Producto Pandishú',
                description: item.name || 'Sin descripción',
                category_id: 'apparel', // Categoría recomendada para e-commerce de ropa/retail
                quantity: parseInt(item.quantity) || 1,
                unit_price: parseFloat(item.price)
            }));

            // Dividir nombre si es posible
            const [firstName, ...lastNameParts] = (customer.name || 'Cliente').split(' ');
            const lastName = lastNameParts.join(' ') || 'S/N';

            const paymentData = {
                transaction_amount: amountTotal,
                token: token,
                description: 'Compra en Pandishú',
                installments: Number(installments) || 1,
                payment_method_id: payment_method_id,
                issuer_id: issuer_id,
                payer: {
                    email: customer.email
                },
                external_reference: orderRefId,
                additional_info: {
                    items: mpItems,
                    payer: {
                        first_name: firstName,
                        last_name: lastName,
                        phone: {
                            area_code: "52",
                            number: customer.phone ? customer.phone.replace(/\D/g, '') : ""
                        },
                        address: {
                            zip_code: customer.address.zip,
                            street_name: customer.address.street + (customer.address.colonia ? `, ${customer.address.colonia}` : ''),
                            street_number: 123 // Placeholder o extraer si existiera campo
                        },
                        registration_date: new Date().toISOString()
                    },
                    shipments: {
                        receiver_address: {
                            zip_code: customer.address.zip,
                            street_name: customer.address.street,
                            street_number: 123,
                            state_name: customer.address.state,
                            city_name: customer.address.city
                        }
                    }
                }
            };

            if (mpCustomerId) {
                paymentData.payer.id = mpCustomerId;
            }

            const paymentRes = await paymentClient.create({
                body: paymentData,
                requestOptions: { idempotencyKey: orderRefId }
            });

            // 6) Actualizar status en Firestore
            let finalStatus = paymentRes.status; // approved, in_process, rejected

            try {
                await admin.firestore().collection('orders').doc(orderRefId).update({
                    status: finalStatus === 'approved' ? 'paid' : finalStatus,
                    mpPaymentId: paymentRes.id,
                    paidAt: finalStatus === 'approved' ? FieldValue.serverTimestamp() : null
                });

                if (finalStatus === 'approved') {
                    await enviarCorreoConfirmacion(customer.email, customer.name, orderRefId, items, amountTotal);
                }
            } catch (e) {
                console.warn("Firestore status update failed:", e.message);
            }

            return res.status(200).json({
                status: finalStatus,
                status_detail: paymentRes.status_detail,
                orderId: orderRefId,
                paymentId: paymentRes.id
            });

        } catch (err) {
            console.error('Error processCustomPayment MP:', err);
            return res.status(500).json({ error: err.message, status: 'rejected' });
        }
    });
});

/**
 * FUNCTION — placeCTOrder
 * Crea el pedido real en CT Internacional usando su API Connect (Dropshipping).
 */
async function placeCTOrder(orderId, orderData) {
    console.log(`[CT Connect] Iniciando colocación de pedido para ID: ${orderId}`);
    try {
        const token = await getCTToken();
        const customer = orderData.customerInfo;
        const items = orderData.items || [];

        // Para CT, necesitamos mapear los productos al formato de listado
        const productos = items.map(item => ({
            cantidad: parseInt(item.quantity) || 1,
            clave: item.sku || item.id, // Es la clave única de CT
            precio: parseFloat(item.price) || 0,
            moneda: 'MXN'
        }));

        // Estructura del pedido según documentación de CT Connect
        const pedidoRequest = {
            idPedido: orderId, // Nuestro identificador único
            almacen: "01A", // Por defecto Almacén Principal, CT lo ajusta según stock
            tipoPago: "99", // Crédito CT (estándar para integraciones)
            cfdi: "G01",    // G01 = Adquisición de mercancias (default según docs)
            envio: [
                {
                    nombre: customer.name,
                    direccion: customer.address.street || "Dirección pendiente",
                    entreCalles: "",
                    noExterior: customer.address.ext_number || "S/N",
                    noInterior: customer.address.int_number || "",
                    colonia: customer.address.neighborhood || "Centro",
                    estado: customer.address.state,
                    ciudad: customer.address.city,
                    codigoPostal: parseInt((customer.address.zip || '').replace(/\D/g, '')) || 0,
                    telefono: parseInt((customer.phone || '').replace(/\D/g, '')) || 0
                }
            ],
            producto: productos
        };

        // ─── Paso 1: Crear pedido ───────────────────────────────────────────
        const response = await fetch(`${CT_API_BASE}/pedido`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-auth': token },
            body: JSON.stringify(pedidoRequest)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`CT Order Failed (${response.status}): ${errorText}`);
        }

        const data = await response.json();

        // Respuesta oficial: { idPedido, respuestaCT: { pedidoWeb, tipoDeCambio, estatus, errores } }
        const ctFolio = data?.respuestaCT?.pedidoWeb;
        const ctErrores = data?.respuestaCT?.errores || [];

        if (!ctFolio) {
            console.error('[CT Connect] No se recibió pedidoWeb:', JSON.stringify(data));
            throw new Error('CT no devolvió un folio válido (pedidoWeb)');
        }

        if (ctErrores.length > 0) {
            console.warn('[CT Connect] Pedido con errores:', JSON.stringify(ctErrores));
        }

        console.log(`[CT Connect] Pedido creado. Folio: ${ctFolio}. Confirmando...`);

        // ─── Paso 2: Confirmar (OBLIGATORIO — 48h o CT cancela automáticamente) ─
        const confirmResponse = await fetch(`${CT_API_BASE}/pedido/confirmar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-auth': token },
            body: JSON.stringify({ folio: ctFolio })
        });

        if (!confirmResponse.ok) {
            const confirmError = await confirmResponse.text();
            console.error(`[CT Connect] Error al confirmar ${ctFolio}: ${confirmError}`);
            // No lanzamos error — el folio existe y puede reintentarse confirmación
        } else {
            const confirmData = await confirmResponse.json();
            console.log(`[CT Connect] Pedido ${ctFolio} confirmado: ${confirmData.okMessage}`);
        }

        return {
            folio: ctFolio,
            status: data?.respuestaCT?.estatus || 'Pendiente',
            tipoDeCambio: data?.respuestaCT?.tipoDeCambio,
            errores: ctErrores
        };

    } catch (err) {
        console.error('[CT Connect] Fallo crítico en la creación de pedido:', err.message);
        throw err;
    }
}

/**
 * FUNCTION 5 — mpWebhook
 * Webhook de Mercado Pago para notificaciones IPN/Webhooks
 */
exports.mpWebhook = functions.runWith({
    vpcConnector: 'pandishu-vpc-connector',
    vpcConnectorEgressSettings: 'ALL_TRAFFIC',
    timeoutSeconds: 60,
    labels: {
        "environment": "production",
        "project": "pandishu",
        "owner": "oscar",
        "cost_center": "sales"
    }
}).https.onRequest(async (req, res) => {
    const client = getMercadoPagoClient();
    if (!client) return res.status(500).send('MP is not configured');

    const topic = req.query.topic || req.body.type;
    const paymentId = req.query.id || (req.body.data && req.body.data.id);

    // Validar firma x-signature de Mercado Pago (modo no-bloqueante)
    const xSignature = req.headers['x-signature'];
    const xRequestId = req.headers['x-request-id'];
    const secret = process.env.MP_WEBHOOK_SECRET;

    if (xSignature && xRequestId && paymentId && secret) {
        const crypto = require('crypto');
        const parts = xSignature.split(',');
        let ts, hash;
        parts.forEach(part => {
            const [key, value] = part.split('=');
            if (key === 'ts') ts = value;
            if (key === 'v1') hash = value;
        });

        const manifest = `id:${paymentId};request-id:${xRequestId};ts:${ts};`;
        const hmac = crypto.createHmac('sha256', secret);
        const digest = hmac.update(manifest).digest('hex');

        if (digest !== hash) {
            // ⚠️ Log warning but continue processing — do NOT block in sandbox/dev
            console.warn('⚠️ MP Webhook Signature mismatch — continuing anyway (non-strict mode).');
        }
    } else {
        console.warn('Skipping MP webhook validation (missing headers/secret/id).');
    }

    console.log("MP Webhook received:", req.query, req.body);

    if (topic === 'payment' && paymentId) {
        try {
            // Obtener detalles completos del pago usando la SDK v2
            const { Payment } = require('mercadopago');
            const paymentClient = new Payment(client);

            const paymentInfo = await paymentClient.get({ id: paymentId });

            console.log(`Payment Status: ${paymentInfo.status}, Reference: ${paymentInfo.external_reference}`);

            if (paymentInfo.status === 'approved') {
                const orderId = paymentInfo.external_reference;

                if (orderId) {
                    // Update the order in Firestore
                    await admin.firestore().collection('orders').doc(orderId).update({
                        status: 'paid',
                        mpPaymentId: paymentId,
                        paidAt: FieldValue.serverTimestamp()
                    });

                    console.log(`✅ Orden ${orderId} marcada como pagada en Firestore.`);

                    // ─── Integración Order Entry API de Ingram ───
                    try {
                        const orderDoc = await admin.firestore().collection('orders').doc(orderId).get();
                        if (orderDoc.exists) {
                            const data = orderDoc.data();

                            // 1) Enviar Correo Electrónico al Cliente
                            await enviarCorreoConfirmacion(
                                data.customerInfo.email,
                                data.customerInfo.name,
                                orderId,
                                data.items,
                                data.amountTotal
                            );

                            // 2) Colocar la orden en CT Internacional
                            const ctResult = await placeCTOrder(orderId, data);

                            // 3) Guardar el número de orden (folio) de CT en Firestore
                            if (ctResult && ctResult.folio) {
                                await admin.firestore().collection('orders').doc(orderId).update({
                                    ctFolio: ctResult.folio,
                                    ctStatus: ctResult.status || 'placed',
                                    vendor: 'CT'
                                });
                                console.log(`✅ Orden ${orderId} sincronizada con CT: ${ctResult.folio}`);
                            }
                        }
                    } catch (err) {
                        console.error('⚠️ Error en procesamiento post-pago (Email/Ingram):', err.message);
                    }
                }
            }

            res.status(200).send('OK');

        } catch (error) {
            console.error('Error fetching payment details from MP:', error);
            res.status(500).send('Error processing payment notification');
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 7 — getInvoiceDetails
// GET — Consulta el detalle de una factura de Ingram usando su número de factura
// ─────────────────────────────────────────────────────────────────────────────
exports.getInvoiceDetails = functions.runWith({
    vpcConnector: 'pandishu-vpc-connector',
    vpcConnectorEgressSettings: 'ALL_TRAFFIC',
    timeoutSeconds: 60,
    labels: {
        "environment": "production",
        "project": "pandishu",
        "owner": "oscar",
        "cost_center": "sales"
    }
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed. Use GET.' });

        const invoiceNumber = req.query.invoiceNumber;
        if (!invoiceNumber) {
            return res.status(400).json({ error: 'Se requiere el parámetro invoiceNumber.' });
        }

        try {
            await getApiClient();
            const api = new XiSdk.InvoicesApi();
            const correlationId = `pandishu-inv-${Date.now()}`;

            const data = await new Promise((resolve, reject) => {
                api.getInvoicedetailsV61(
                    invoiceNumber,
                    IM_CUSTOMER_NUM,
                    IM_COUNTRY_CODE,
                    correlationId,
                    'Pandishu', // iMApplicationID
                    { customerType: 'invoice', includeSerialNumbers: false },
                    (err, result) => err ? reject(err) : resolve(result)
                );
            });

            return res.status(200).json(data);
        } catch (err) {
            console.error('[Invoice] getInvoiceDetails error:', err.message);
            return res.status(500).json({ error: err.message || 'Error al consultar la factura.' });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 8 — searchInvoices
// GET — Busca facturas por número de orden de cliente para asociarlas automáticamente
// ─────────────────────────────────────────────────────────────────────────────
exports.searchInvoices = functions.runWith({
    vpcConnector: 'pandishu-vpc-connector',
    vpcConnectorEgressSettings: 'ALL_TRAFFIC',
    timeoutSeconds: 60,
    labels: {
        "environment": "production",
        "project": "pandishu",
        "owner": "oscar",
        "cost_center": "sales"
    }
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed. Use GET.' });

        const { customerOrderNumber, orderNumber } = req.query;
        if (!customerOrderNumber && !orderNumber) {
            return res.status(400).json({ error: 'Se requiere customerOrderNumber o orderNumber.' });
        }

        try {
            await getApiClient();
            const api = new XiSdk.InvoicesApi();
            const correlationId = `pandishu-invsrch-${Date.now()}`;

            const data = await new Promise((resolve, reject) => {
                api.getResellersV6Invoicesearch(
                    'Pandishu',
                    IM_CUSTOMER_NUM,
                    IM_COUNTRY_CODE,
                    correlationId,
                    {
                        customerOrderNumber: customerOrderNumber || undefined,
                        orderNumber: orderNumber || undefined,
                        pageSize: 10,
                        pageNumber: 1
                    },
                    (err, result) => err ? reject(err) : resolve(result)
                );
            });

            // Si hay facturas, guardarlas en Firestore asociadas a la orden
            if (data && data.invoices && data.invoices.length > 0 && customerOrderNumber) {
                try {
                    await admin.firestore().collection('orders').doc(customerOrderNumber).update({
                        invoices: data.invoices.map(inv => ({
                            invoiceNumber: inv.invoiceNumber,
                            invoiceDate: inv.invoiceDate,
                            invoiceStatus: inv.invoiceStatus,
                            invoiceDueDate: inv.invoiceDueDate,
                            invoiceAmount: inv.invoiceAmount
                        }))
                    });
                    console.log(`✅ Facturas guardadas en Orden ${customerOrderNumber}`);
                } catch (dbErr) {
                    console.warn('⚠️ No se pudo guardar facturas en Firestore:', dbErr.message);
                }
            }

            return res.status(200).json(data);
        } catch (err) {
            console.error('[Invoice] searchInvoices error:', err.message);
            return res.status(500).json({ error: err.message || 'Error al buscar facturas.' });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 9 — createOrderV7
// POST — Crea una orden ASÍNCRONA en Ingram v7. La respuesta real llega via webhook.
// ─────────────────────────────────────────────────────────────────────────────
exports.createOrderV7 = functions.runWith({
    vpcConnector: 'pandishu-vpc-connector',
    vpcConnectorEgressSettings: 'ALL_TRAFFIC',
    timeoutSeconds: 60,
    labels: {
        "environment": "production",
        "project": "pandishu",
        "owner": "oscar",
        "cost_center": "sales"
    }
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

        const { orderId, items, customer } = req.body;
        if (!orderId || !items || !customer) {
            return res.status(400).json({ error: 'Se requieren orderId, items y customer.' });
        }

        try {
            await getApiClient();
            const api = new XiSdk.OrdersApi();
            const correlationId = `PO-V7-${orderId}-${Date.now()}`;

            const orderRequest = {
                customerOrderNumber: orderId,
                notes: 'Orden automática Pandishú (v7 async)',
                shipToInfo: {
                    contact: customer.name,
                    companyName: customer.name,
                    addressLine1: customer.address.street,
                    city: customer.address.city,
                    state: customer.address.state,
                    postalCode: customer.address.zip,
                    countryCode: IM_COUNTRY_CODE,
                    email: customer.email,
                    phoneNumber: customer.phone ? customer.phone.replace(/\D/g, '') : ''
                },
                lines: items.map((item, idx) => ({
                    customerLineNumber: (idx + 1).toString(),
                    ingramPartNumber: item.sku || item.id,
                    quantity: parseInt(item.quantity) || 1
                })),
                additionalAttributes: [
                    { attributeName: 'allowDuplicateCustomerOrderNumber', attributeValue: 'true' }
                ]
            };

            const data = await new Promise((resolve, reject) => {
                api.postCreateorderV7(IM_CUSTOMER_NUM, IM_COUNTRY_CODE, correlationId, orderRequest,
                    { iMSenderID: 'Pandishu' },
                    (err, result) => err ? reject(err) : resolve(result)
                );
            });

            // Guardar confirmationNumber en Firestore para luego vincular con el webhook
            await admin.firestore().collection('orders').doc(orderId).update({
                ingramV7ConfirmationNumber: data.confirmationNumber,
                ingramStatus: 'pending_v7'
            });

            console.log(`✅ Orden v7 enviada. Confirmación: ${data.confirmationNumber}`);
            return res.status(200).json(data);
        } catch (err) {
            console.error('[OrderV7] createOrderV7 error:', err.message);
            return res.status(500).json({ error: err.message || 'Error al crear la orden v7.' });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 10 — getOrderDetails
// GET ?orderNumber=20-RD3QV — Detalles completos de una orden de Ingram
// ─────────────────────────────────────────────────────────────────────────────
exports.getOrderDetails = functions.runWith({
    vpcConnector: 'pandishu-vpc-connector',
    vpcConnectorEgressSettings: 'ALL_TRAFFIC',
    timeoutSeconds: 60,
    labels: {
        "environment": "production",
        "project": "pandishu",
        "owner": "oscar",
        "cost_center": "sales"
    }
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed. Use GET.' });

        const { orderNumber } = req.query;
        if (!orderNumber) return res.status(400).json({ error: 'Se requiere orderNumber.' });

        try {
            await getApiClient();
            const api = new XiSdk.OrdersApi();
            const correlationId = `pandishu-od-${Date.now()}`;

            const data = await new Promise((resolve, reject) => {
                api.getOrderdetailsV61(orderNumber, IM_CUSTOMER_NUM, IM_COUNTRY_CODE, correlationId,
                    { iMSenderID: 'Pandishu' },
                    (err, result) => err ? reject(err) : resolve(result)
                );
            });

            return res.status(200).json(data);
        } catch (err) {
            console.error('[Orders] getOrderDetails error:', err.message);
            return res.status(500).json({ error: err.message || 'Error al consultar la orden.' });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 11 — searchOrders
// GET ?customerOrderNumber=... — Busca órdenes de Ingram con múltiples filtros
// ─────────────────────────────────────────────────────────────────────────────
exports.searchOrders = functions.runWith({
    vpcConnector: 'pandishu-vpc-connector',
    vpcConnectorEgressSettings: 'ALL_TRAFFIC',
    timeoutSeconds: 60,
    labels: {
        "environment": "production",
        "project": "pandishu",
        "owner": "oscar",
        "cost_center": "sales"
    }
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed. Use GET.' });

        try {
            await getApiClient();
            const api = new XiSdk.OrdersApi();
            const correlationId = `pandishu-osrch-${Date.now()}`;
            const { customerOrderNumber, ingramOrderNumber, orderStatus, pageSize, pageNumber } = req.query;

            const data = await new Promise((resolve, reject) => {
                api.getResellersV6Ordersearch(IM_CUSTOMER_NUM, IM_COUNTRY_CODE, correlationId, {
                    customerOrderNumber: customerOrderNumber || undefined,
                    ingramOrderNumber: ingramOrderNumber || undefined,
                    orderStatus: orderStatus || undefined,
                    pageSize: parseInt(pageSize) || 25,
                    pageNumber: parseInt(pageNumber) || 1,
                    iMSenderID: 'Pandishu'
                }, (err, result) => err ? reject(err) : resolve(result));
            });

            return res.status(200).json(data);
        } catch (err) {
            console.error('[Orders] searchOrders error:', err.message);
            return res.status(500).json({ error: err.message || 'Error al buscar órdenes.' });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 12 — cancelOrder
// DELETE ?orderNumber=20-RD128 — Cancela una orden que esté en customer hold
// ─────────────────────────────────────────────────────────────────────────────
exports.cancelOrder = functions.runWith({
    vpcConnector: 'pandishu-vpc-connector',
    vpcConnectorEgressSettings: 'ALL_TRAFFIC',
    timeoutSeconds: 60,
    labels: {
        "environment": "production",
        "project": "pandishu",
        "owner": "oscar",
        "cost_center": "sales"
    }
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed. Use DELETE.' });

        const { orderNumber, customerOrderNumber } = req.query;
        if (!orderNumber) return res.status(400).json({ error: 'Se requiere orderNumber (Ingram order number).' });

        try {
            await getApiClient();
            const api = new XiSdk.OrdersApi();
            const correlationId = `pandishu-cancel-${Date.now()}`;

            await new Promise((resolve, reject) => {
                api.deleteOrdercancel(orderNumber, IM_CUSTOMER_NUM, IM_COUNTRY_CODE, correlationId,
                    { iMSenderID: 'Pandishu' },
                    (err) => err ? reject(err) : resolve()
                );
            });

            // Actualizar estado en Firestore si se proporcionó el ID interno
            if (customerOrderNumber) {
                await admin.firestore().collection('orders').doc(customerOrderNumber).update({
                    status: 'cancelled',
                    ingramStatus: 'cancelled',
                    cancelledAt: FieldValue.serverTimestamp()
                });
            }

            console.log(`✅ Orden ${orderNumber} cancelada en Ingram.`);
            return res.status(200).json({ status: 'cancelled', orderNumber });
        } catch (err) {
            console.error('[Orders] cancelOrder error:', err.message);
            return res.status(500).json({ error: err.message || 'Error al cancelar la orden.' });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 13 — modifyOrder
// PUT ?orderNumber=20-RC1RD — Modifica líneas de una orden en customer hold
// ─────────────────────────────────────────────────────────────────────────────
exports.modifyOrder = functions.runWith({
    vpcConnector: 'pandishu-vpc-connector',
    vpcConnectorEgressSettings: 'ALL_TRAFFIC',
    timeoutSeconds: 60,
    labels: {
        "environment": "production",
        "project": "pandishu",
        "owner": "oscar",
        "cost_center": "sales"
    }
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed. Use PUT.' });

        const { orderNumber } = req.query;
        const { lines, notes, actionCode } = req.body;
        if (!orderNumber) return res.status(400).json({ error: 'Se requiere orderNumber en query.' });
        if (!lines || !Array.isArray(lines)) return res.status(400).json({ error: 'Se requiere el array lines en el body.' });

        try {
            await getApiClient();
            const api = new XiSdk.OrdersApi();
            const correlationId = `pandishu-mod-${Date.now()}`;

            const modifyRequest = { lines, notes: notes || '' };

            const data = await new Promise((resolve, reject) => {
                api.putOrdermodify(orderNumber, IM_CUSTOMER_NUM, IM_COUNTRY_CODE, correlationId, modifyRequest,
                    { actionCode: actionCode || undefined, iMSenderID: 'Pandishu' },
                    (err, result) => err ? reject(err) : resolve(result)
                );
            });

            return res.status(200).json(data);
        } catch (err) {
            console.error('[Orders] modifyOrder error:', err.message);
            return res.status(500).json({ error: err.message || 'Error al modificar la orden.' });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 14 — getVendorRequiredInfo
// POST — Obtiene los campos obligatorios del vendor (VMF) para una orden o cotización
// ─────────────────────────────────────────────────────────────────────────────
exports.getVendorRequiredInfo = functions.runWith({
    vpcConnector: 'pandishu-vpc-connector',
    vpcConnectorEgressSettings: 'ALL_TRAFFIC',
    timeoutSeconds: 60,
    labels: {
        "environment": "production",
        "project": "pandishu",
        "owner": "oscar",
        "cost_center": "sales"
    }
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

        const { products, quoteNumber } = req.body;
        if (!products && !quoteNumber) {
            return res.status(400).json({ error: 'Se requiere products (array de SKUs) o quoteNumber.' });
        }

        try {
            const token = await getAccessToken();
            const correlationId = `pandishu-vri-${Date.now()}`;

            // El SDK no tiene wrapper explícito para esta llamada, usamos fetch directo
            const fetch = require('node-fetch');
            const response = await fetch('https://api.ingrammicro.com:443/resellers/v6/orders/vendorrequiredinfo', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'IM-CustomerNumber': IM_CUSTOMER_NUM,
                    'IM-CountryCode': IM_COUNTRY_CODE,
                    'IM-CorrelationID': correlationId,
                    'IM-SenderID': 'Pandishu',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    quoteNumber: quoteNumber || undefined,
                    products: products || []
                })
            });

            if (!response.ok) {
                const errBody = await response.text();
                throw new Error(`Ingram API ${response.status}: ${errBody}`);
            }

            const data = await response.json();
            return res.status(200).json(data);
        } catch (err) {
            console.error('[Orders] getVendorRequiredInfo error:', err.message);
            return res.status(500).json({ error: err.message || 'Error al obtener vendor required info.' });
        }
    });
});

// NOTA: La API de Ingram Micro para México (v6) no incluye endpoint de estimación de flete.
// El costo de envío se maneja como tarifa fija de $149 MXN directamente en el checkout.

// ─────────────────────────────────────────────────────────────────────────────
// TEST FUNCTION — testIpPandishu
// GET — Realiza una petición a ipify.org para confirmar que la IP de salida es la estática
// ─────────────────────────────────────────────────────────────────────────────
const axios = require('axios');

exports.testIpPandishu = functions.runWith({
    vpcConnector: 'pandishu-vpc-connector',
    vpcConnectorEgressSettings: 'ALL_TRAFFIC',
    timeoutSeconds: 60,
    labels: {
        "environment": "production",
        "project": "pandishu",
        "owner": "oscar",
        "cost_center": "sales"
    }
}).https.onRequest(async (req, res) => {
    cors(req, res, async () => {
        try {
            // Hacemos la petición a ipify para ver con qué IP estamos saliendo a internet
            const response = await axios.get('https://api.ipify.org?format=json');

            const expectedIp = '34.136.167.161';
            const detectedIp = response.data.ip;

            return res.status(200).json({
                success: true,
                message: detectedIp === expectedIp
                    ? "¡ÉXITO! El tráfico está saliendo correctamente por la IP Estática del Cloud NAT."
                    : "ADVERTENCIA: La IP detectada no coincide con la esperada.",
                expectedStaticIp: expectedIp,
                detectedEgressIp: detectedIp,
                vpcConnectorUsed: 'pandishu-vpc-connector'
            });
        } catch (error) {
            console.error('Error al probar IP de salida:', error.message);
            return res.status(500).json({
                success: false,
                error: 'Error al contactar api.ipify.org',
                details: error.message
            });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION — syncCTCatalog
// Descarga el JSON de CT vía FTP y lo guarda en Firestore (colección ct_catalog)
// Invocar manualmente: GET /syncCTCatalog
// Programar: Cloud Scheduler cada 15 minutos apuntando a esta URL
// ─────────────────────────────────────────────────────────────────────────────
const Client = require('ssh2-sftp-client'); // Reutilizamos para SFTP de ingram; CT usa FTP básico
const ftp = require('basic-ftp');
const os = require('os');
const path = require('path');
const fs = require('fs');
const MXN_RATE_SYNC = parseFloat(process.env.MXN_EXCHANGE_RATE) || 17.50;

exports.syncCTCatalog = functions.runWith({
    timeoutSeconds: 540,
    memory: '512MB',
    labels: { environment: 'production', project: 'pandishu', owner: 'oscar', cost_center: 'sales' }
}).https.onRequest(async (req, res) => {
    cors(req, res, async () => {
        console.log('🔄 [syncCTCatalog] Iniciando sincronización del catálogo CT via FTP...');

        const ftpConfig = {
            host: '216.70.82.104',
            user: process.env.CT_FTP_USER || 'DFP2631',
            password: process.env.CT_FTP_PASSWORD || 'hMlrhbEAvy0ungi3UxsvFkQtHmHtYyy5'
        };

        const client = new ftp.Client();
        const localPath = path.join(os.tmpdir(), `ct_stock_${Date.now()}.json`);

        try {
            await client.access(ftpConfig);
            console.log('✅ FTP conectado.');

            // Listar directorio para encontrar el archivo JSON correcto
            const list = await client.list();
            console.log('📂 Archivos en FTP:', list.map(f => `${f.name} (${f.size}b)`).join(', '));

            // Priorizar: archivo .json con existencia (tamaño más grande)
            const jsonFile = list.find(f => f.name.toLowerCase().endsWith('.json')) ||
                list.find(f => f.name.toLowerCase().includes('json'));

            if (!jsonFile) {
                await client.close();
                return res.status(404).json({ error: 'No se encontró archivo JSON en el FTP de CT.', files: list.map(f => f.name) });
            }

            console.log(`📥 Descargando: ${jsonFile.name} (${(jsonFile.size / 1024).toFixed(1)} KB)`);
            await client.downloadTo(localPath, jsonFile.name);
            client.close();

            // Leer y parsear el JSON
            const raw = fs.readFileSync(localPath, 'utf-8');
            const products = JSON.parse(raw);
            const productArray = Array.isArray(products) ? products : (products.productos || products.data || []);

            console.log(`📦 Productos en JSON: ${productArray.length}`);

            // Mapear al formato unificado de Pandishú
            const mapped = productArray.map(p => {
                let price = parseFloat(p.precio || p.price || 0);
                const currency = (p.moneda || p.currency || 'USD').toUpperCase();
                if (currency === 'USD') price = Math.round(price * MXN_RATE_SYNC * 100) / 100;
                return {
                    ingramPartNumber: String(p.codigo || p.clave || p.sku || ''),
                    vendorName: p.marca || p.brand || 'CT Internacional',
                    vendorPartNumber: p.numParte || p.numParte || '',
                    description: p.nombre || p.descripcion || p.description || 'Sin descripción',
                    productCategory: p.subcategoria || p.categoria || '',
                    image: p.imagen || p.image || '',
                    price: price,
                    currency: 'MXN',
                    availability: { availableQuantity: parseInt(p.existencia || p.stock || 0) },
                    source: 'CT'
                };
            }).filter(p => p.ingramPartNumber); // Solo con código válido

            // Escribir a Firestore en batches de 500
            const db = admin.firestore();
            const BATCH_SIZE = 400;
            let written = 0;

            // Limpiar colección anterior primero
            const existingDocs = await db.collection('ct_catalog').limit(1000).get();
            const deleteBatch = db.batch();
            existingDocs.docs.forEach(d => deleteBatch.delete(d.ref));
            if (!existingDocs.empty) await deleteBatch.commit();

            for (let i = 0; i < mapped.length; i += BATCH_SIZE) {
                const batch = db.batch();
                const chunk = mapped.slice(i, i + BATCH_SIZE);
                chunk.forEach(product => {
                    const ref = db.collection('ct_catalog').doc(product.ingramPartNumber);
                    batch.set(ref, { ...product, syncedAt: FieldValue.serverTimestamp() });
                });
                await batch.commit();
                written += chunk.length;
                console.log(`  💾 Escritos ${written}/${mapped.length} productos...`);
            }

            // Limpiar temp file
            try { fs.unlinkSync(localPath); } catch (e) { }

            const summary = { success: true, total: mapped.length, written, syncedAt: new Date().toISOString() };
            console.log('✅ Sincronización CT completada:', summary);
            return res.status(200).json(summary);

        } catch (err) {
            client.close();
            try { if (fs.existsSync(localPath)) fs.unlinkSync(localPath); } catch (e) { }
            console.error('❌ syncCTCatalog error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });
});
