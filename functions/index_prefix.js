'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const cors = require('cors')({ origin: true });
const XiSdk = require('xi_sdk_resellers');
const nodemailer = require('nodemailer');

admin.initializeApp();

// â”€â”€â”€ CT CONNECT CONFIG â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const CT_API_BASE = process.env.CT_API_BASE || 'https://api.ctonline.mx';
const CT_CLIENT_NUM = process.env.CT_CLIENT_NUMBER;
const CT_EMAIL = process.env.CT_EMAIL;
const CT_RFC = process.env.CT_RFC;

// â”€â”€â”€ INGRAM CREDENTIALS (Migration Reference) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const IM_CLIENT_ID = process.env.INGRAM_CLIENT_ID;
const IM_CLIENT_SECRET = process.env.INGRAM_CLIENT_SECRET;
const IM_SECRET_KEY = process.env.INGRAM_SECRET_KEY;
const IM_CUSTOMER_NUM = process.env.INGRAM_CUSTOMER_NUMBER || 'SBX';
const IM_COUNTRY_CODE = process.env.INGRAM_COUNTRY_CODE || 'MX';

// â”€â”€â”€ CONVERSIÃ“N DE MONEDA (USD â†’ MXN) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ TOKEN CACHE (CT CONNECT) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let cachedCTToken = null;
let ctTokenExpiry = 0;

/**
 * Obtiene (o reutiliza si no venciÃ³) el token 'x-auth' de CT Internacional.
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

    // Configurar explÃ­citamente la URL de Sandbox
    client.basePath = 'https://api.ingrammicro.com:443/sandbox';

    // OAuth2
    const auth = client.authentications['application'];
    auth.accessToken = token;

    // Headers comunes de Ingram
    client.defaultHeaders = {
        'IM-CustomerNumber': IM_CUSTOMER_NUM,
        'IM-CountryCode': IM_COUNTRY_CODE,
        'IM-SenderID': 'Pandishu',
        'IM-SecretKey': IM_SECRET_KEY, // Requerido para algunas operaciones de catÃ¡logo v6
    };

    return client;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// CONFIGURACIÃ“N DE CORREO (Nodemailer)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        console.warn('âš ï¸ No se enviÃ³ correo: SMTP_EMAIL o SMTP_PASSWORD no estÃ¡n configurados.');
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
                <h1 style="background: linear-gradient(135deg, #a855f7 0%, #6366f1 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin: 0; font-size: 32px;">PANDISHÃš</h1>
                <p style="color: #94a3b8; font-size: 14px; letter-spacing: 2px;">TECHNOLOGY SOLUTIONS</p>
            </div>
            
            <h2 style="color: #e2e8f0; border-bottom: 2px solid #334155; padding-bottom: 10px;">Â¡Gracias por tu compra, ${customerName}!</h2>
            <p style="color: #cbd5e1;">Tu orden <strong>#${orderId}</strong> ha sido confirmada y el pago fue procesado exitosamente. Estamos preparando tus productos para el envÃ­o.</p>
            
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
                Cualquier duda, responde a este correo o contÃ¡ctanos por WhatsApp.<br>
                Â© ${new Date().getFullYear()} PandishÃº. Todos los derechos reservados.
            </p>
        </div>
    </div>
    `;

    try {
        await transporter.sendMail({
            from: '"PandishÃº Tech" <' + process.env.SMTP_EMAIL + '>',
            to: toEmail,
            subject: 'ConfirmaciÃ³n de Pedido #' + orderId,
            html: emailHtml
        });
        console.log(`âœ‰ï¸ Correo de confirmaciÃ³n enviado a ${toEmail} para la orden ${orderId}`);
    } catch (error) {
        console.error('Error enviando correo con Nodemailer:', error);
    }
}

/**
 * FUNCTION â€” enviarCorreoEnvio
 * Notifica al cliente que su pedido ha sido enviado con detalles de rastreo.
 */
async function enviarCorreoEnvio(toEmail, customerName, orderId, trackingNumber) {
    const transporter = getMailTransporter();
    if (!transporter) {
        console.warn('âš ï¸ No se enviÃ³ correo de envÃ­o: SMTP_EMAIL o SMTP_PASSWORD no estÃ¡n configurados.');
        return;
    }

    const emailHtml = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 40px 20px; line-height: 1.6;">
        <div style="max-width: 600px; margin: 0 auto; background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 16px; padding: 30px; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
            <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="background: linear-gradient(135deg, #a855f7 0%, #6366f1 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin: 0; font-size: 32px;">PANDISHÃš</h1>
                <p style="color: #94a3b8; font-size: 14px; letter-spacing: 2px;">TECHNOLOGY SOLUTIONS</p>
            </div>
            
            <h2 style="color: #e2e8f0; border-bottom: 2px solid #334155; padding-bottom: 10px;">Â¡Buenas noticias, ${customerName}!</h2>
            <p style="color: #cbd5e1;">Tu pedido <strong>#${orderId}</strong> ha sido enviado. Estamos muy emocionados de que pronto lo tengas en tus manos.</p>
            
            <div style="margin: 30px 0; background: rgba(15, 23, 42, 0.5); border-radius: 8px; padding: 20px; text-align: center; border: 1px dashed #6366f1;">
                <h3 style="color: #a855f7; margin-top: 0;">NÃºmero de GuÃ­a / Rastreo</h3>
                <p style="font-size: 24px; font-weight: bold; color: #fff; margin: 10px 0; letter-spacing: 1px;">${trackingNumber}</p>
                <p style="color: #94a3b8; font-size: 14px;">Utiliza este nÃºmero en el portal de la paqueterÃ­a para seguir tu envÃ­o.</p>
            </div>
            
            <p style="color: #94a3b8; font-size: 13px; text-align: center; margin-top: 40px; border-top: 1px solid #334155; padding-top: 20px;">
                Cualquier duda, responde a este correo o contÃ¡ctanos por WhatsApp.<br>
                Â© ${new Date().getFullYear()} PandishÃº. Todos los derechos reservados.
            </p>
        </div>
    </div>
    `;

    try {
        await transporter.sendMail({
            from: '"PandishÃº Tech" <' + process.env.SMTP_EMAIL + '>',
            to: toEmail,
            subject: 'Â¡Tu pedido #' + orderId + ' ha sido enviado! ðŸšš',
            html: emailHtml
        });
        console.log(`ðŸšš Correo de envÃ­o enviado a ${toEmail} para la orden ${orderId}`);
    } catch (error) {
        console.error('Error enviando correo de envÃ­o:', error);
    }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FUNCTION 1 â€” searchProducts
// GET /resellers/v6/catalog?keyword=...
// Llamado desde tienda.html
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FUNCTION 1 â€” searchProducts
// GET /existencia/promociones (CT Connect)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

            // â”€â”€ LEER DESDE FIRESTORE (ct_catalog) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// HELPERS DE MOCK DATA
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getMockSearchData(queryKeyword) {
    const mockCatalog = [
        { ingramPartNumber: "MOCK-UBI-01", vendorName: "UBIQUITI", vendorPartNumber: "UAP-AC-PRO", description: "Ubiquiti UniFi AC Pro AP - Punto de acceso inalÃ¡mbrico - 802.11a/b/g/n/ac - Banda doble" },
        { ingramPartNumber: "MOCK-CIS-01", vendorName: "CISCO", vendorPartNumber: "CBS350-24T-4G", description: "Cisco Business 350 Series 24-Port Gigabit Managed Switch" },
        { ingramPartNumber: "MOCK-DEL-01", vendorName: "DELL", vendorPartNumber: "XPS-13-9315", description: "Dell XPS 13 9315 - Intel Core i7 1250U - 16GB RAM - 512GB SSD - 13.4\" FHD+" },
        { ingramPartNumber: "MOCK-SAM-01", vendorName: "SAMSUNG", vendorPartNumber: "MZ-V8V1T0B/AM", description: "Samsung 980 SSD 1TB PCle 3.0x4, NVMe M.2 2280" },
        { ingramPartNumber: "MOCK-APP-01", vendorName: "APPLE", vendorPartNumber: "MGN63LA/A", description: "MacBook Air 13.3\" - Apple M1 - 8GB RAM - 256GB SSD - Gris Espacial" },
        { ingramPartNumber: "MOCK-LOG-01", vendorName: "LOGITECH", vendorPartNumber: "910-005620", description: "Logitech MX Master 3S Mouse InalÃ¡mbrico, Desplazamiento UltrarrÃ¡pido" },
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


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FUNCTION 2 â€” getPriceAndAvailability
// POST body: { skus: ["SKU1", "SKU2"] }  (mÃ¡x 50)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FUNCTION 2 â€” getPriceAndAvailability
// POST body: { skus: ["SKU1", "SKU2"] }  (CT Connect)
// GET /existencia/promociones/:codigo â†’ { codigo, precio, moneda, almacenes:[{almacen, existencia}] }
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
                console.log('ðŸ”¹ Sirviendo precios MOCK por configuraciÃ³n USE_MOCK_DATA=true');
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

                    // La moneda puede ser USD o MXN segÃºn la documentaciÃ³n oficial
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



// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FUNCTION 3 â€” ingramWebhook
// POST â€” Ingram Micro envÃ­a eventos aquÃ­ (OrderStatus, StockUpdate, etc.)
// ESTA URL es la que registras en el portal de Ingram como Destination URL
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
            console.warn('âš ï¸ Webhook Payload no validado por firma SHA512.');
            // return res.status(401).send('Unauthorized webhook'); // Descomentar en Prod Estricto
        }

        const payload = req.body;
        console.log(`[Ingram Webhook] Recibido eventId: ${eventId}`);

        // Guardar raw payload en Firestore para auditorÃ­a
        try {
            await admin.firestore().collection('ingram_events').add({
                receivedAt: FieldValue.serverTimestamp(),
                eventId: eventId || 'unknown',
                topic: payload.topic || 'unknown',
                rawPayload: payload,
                isValidSignature: isValid
            });
        } catch (dbErr) {
            console.warn('âš ï¸ No se pudo guardar auditorio en Firestore (probablemente no inicializado localmente).', dbErr.message);
        }

        // â”€â”€â”€ PROCESAMIENTO DE RECURSOS SEGÃšN EVENTO â”€â”€â”€
        if (payload.resource && Array.isArray(payload.resource)) {
            for (const resource of payload.resource) {
                const eventType = resource.eventType ? resource.eventType.toLowerCase() : '';

                // 1) STOCK_UPDATE: Actualizamos el cachÃ© de disponibilidad
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
                            console.log(`âœ… Cache actualizado: SKU ${sku} tiene ${stockNum} en stock.`);
                        } catch (e) { console.error('Error guardando cache:', e.message); }
                    }
                }

                // 2) ACTUALIZACIONES DE Ã“RDENES: shipped, invoiced, voided, hold, etc.
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

                                // ðŸšš Notificar al cliente por correo con el nÃºmero de guÃ­a
                                try {
                                    const orderDoc = await admin.firestore().collection('orders').doc(customerOrderNumber).get();
                                    if (orderDoc.exists) {
                                        const orderData = orderDoc.data();
                                        await enviarCorreoEnvio(
                                            orderData.customerInfo.email,
                                            orderData.customerInfo.name,
                                            customerOrderNumber,
                                            trackingNums[0] // Primer nÃºmero de guÃ­a
                                        );
                                    }
                                } catch (mailErr) {
                                    console.warn('âš ï¸ No se pudo enviar correo de envÃ­o:', mailErr.message);
                                }
                            }
                        }

                        try {
                            // Actualizar la orden de nuestro lado
                            await admin.firestore().collection('orders').doc(customerOrderNumber).update(updateData);
                            console.log(`âœ… Orden ${customerOrderNumber} actualizada con estado ${updateData.ingramStatus}`);
                        } catch (e) {
                            console.error(`âš ï¸ No se pudo actualizar orden ${customerOrderNumber} en Firestore:`, e.message);
                        }
                    }
                }
            }
        }

        // Siempre devolver 200 rÃ¡pido a Ingram para no causar retries
        return res.status(200).json({ status: 'received', eventId });
    } catch (err) {
        console.error('[Ingram Webhook] Error CrÃ­tico:', err);
        return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â”€â”€â”€ PAYMENTS: MERCADO PAGO INTEGRATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
 * FUNCTION 4 â€” createCheckoutSession
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
                return res.status(400).json({ error: 'El carrito estÃ¡ vacÃ­o' });
            }

            // Mapear los items del carrito a la estructura de Mercado Pago
            const preferenceItems = items.map(item => {
                return {
                    id: item.sku,
                    title: item.name,
                    description: `Vendor: ${item.vendor || 'PandishÃº'}`,
                    quantity: item.quantity,
                    currency_id: 'MXN',
                    unit_price: Number(item.price)
                };
            });

            // Agregamos el costo de envÃ­o fijo mandatorio
            const shippingCost = 149.00;
            preferenceItems.push({
                id: 'SHIPPING-01',
                title: 'EnvÃ­o EstÃ¡ndar',
                description: 'Costo fijo de envÃ­o a domicilio',
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
                console.warn('âš ï¸ Firestore save failed (likely not initialized). Using mock order ID.', dbErr.message);
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
                    external_reference: orderRefId, // VÃ­nculo con nuestra BD
                    statement_descriptor: 'Pandishu Tech',
                    purpose: 'wallet_purchase', // Obligatorio para Wallet Brick
                    // Redirigir notificaciones de pago aquÃ­
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
 * FUNCTION 6 â€” processCustomPayment
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
                console.warn("âš ï¸ No se pudo buscar/crear cliente MP. Continuando sin vincular tarjeta.", err.message);
            }

            // 3) Guardar la tarjeta al Customer usando el token
            // Nota: MP puede rechazar el token en CustomerCard.create si se usa directo en Payment despuÃ©s,
            // pero el flujo de MP permite guardar e intentar. Si falla el save, no bloqueamos el pago.
            if (mpCustomerId && token) {
                try {
                    const customerCardClient = new CustomerCard(client);
                    await customerCardClient.create({ customerId: mpCustomerId, body: { token } });
                } catch (cardErr) {
                    console.warn("âš ï¸ No se pudo vincular tarjeta.", cardErr.message);
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
                console.warn('âš ï¸ Firestore save failed. Using mock ID.', dbErr.message);
            }

            // 5) Procesar el Pago
            const paymentClient = new Payment(client);

            // Mapear items al formato de additional_info (Recomendado para Apparel/Retail)
            const mpItems = items.map(item => ({
                id: item.sku || item.id || 'sku-pandishu',
                title: item.name || 'Producto PandishÃº',
                description: item.name || 'Sin descripciÃ³n',
                category_id: 'apparel', // CategorÃ­a recomendada para e-commerce de ropa/retail
                quantity: parseInt(item.quantity) || 1,
                unit_price: parseFloat(item.price)
            }));

            // Dividir nombre si es posible
            const [firstName, ...lastNameParts] = (customer.name || 'Cliente').split(' ');
            const lastName = lastNameParts.join(' ') || 'S/N';

            const paymentData = {
                transaction_amount: amountTotal,
                token: token,
                description: 'Compra en PandishÃº',
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
 * FUNCTION — placeCTOrderFromWebhook
 * Crea el pedido real en CT Internacional usando su API Connect y lo autoconfirma.
 */
async function placeCTOrderFromWebhook(orderId, orderData, itemsForWh, almacen) {
    console.log(`[CT Connect] Iniciando colocación de pedido ID: ${orderId} para almacén: ${almacen}`);

    let result = {
        almacen,
        idPedido: orderId,
        status: 'failed',
        folio: null,
        errorDev: null
    };

    try {
        const { createCTOrder, confirmCTOrder, getCTToken } = require('./services/ctConnect');
        const token = await getCTToken();
        const customer = orderData.customerInfo;
        const address = customer.address || {};

        const productos = itemsForWh.map(item => ({
            cantidad: parseInt(item.quantity) || 1,
            clave: item.sku || item.id,
            precio: parseFloat(item.price) || 0,
            moneda: 'MXN'
        }));

        const pedidoRequest = {
            idPedido: orderId,
            almacen: almacen,
            tipoPago: "99",
            cfdi: "G01",
            envio: [
                {
                    nombre: customer.name || "Cliente Pandishu",
                    direccion: address.street || "Conocido",
                    entreCalles: address.notes || "",
                    noExterior: address.ext_number || "S/N",
                    noInterior: address.int_number || "",
                    colonia: address.colonia || address.neighborhood || "Centro",
                    estado: address.state || "CMX",
                    ciudad: address.city || "Ciudad de Mexico",
                    codigoPostal: parseInt((address.zip || orderData.shippingInfo?.zipCode || '06000').replace(/\D/g, '')) || 0,
                    telefono: parseInt((customer.phone || '0000000000').replace(/\D/g, '')) || 0
                }
            ],
            producto: productos
        };

        const ctRes = await createCTOrder(pedidoRequest, token);
        result.ctResponse = ctRes;

        const ctFolio = ctRes?.respuestaCT?.pedidoWeb;

        if (ctFolio) {
            result.folio = ctFolio;
            result.status = 'created';

            try {
                const confRes = await confirmCTOrder(ctFolio, token);
                if (confRes && confRes.okCode === "2000") {
                    result.status = 'confirmed';
                } else {
                    result.status = 'created (pending confirmation)';
                    result.errorDev = confRes;
                }
            } catch (e) {
                result.status = 'created (confirmation failed)';
                result.errorDev = e.message;
            }
        } else {
            result.errorDev = "CT no devolvió un folio válido (pedidoWeb)";
        }
    } catch (e) {
        console.error(`[CT Connect] Exception en placeCTOrderFromWebhook:`, e);
        result.errorDev = e.message;
    }

    return result;
