'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const cors = require('cors')({ origin: true });
const XiSdk = require('xi_sdk_resellers');
const nodemailer = require('nodemailer');

admin.initializeApp();

// ─── CT CONNECT CONFIG ────────────────────────────────────────────────────────
const CT_API_BASE = process.env.CT_API_BASE || 'https://api.ctonline.mx';
const CT_CLIENT_NUM = process.env.CT_CLIENT_NUMBER;
const CT_EMAIL = process.env.CT_EMAIL;
const CT_RFC = process.env.CT_RFC;

// ─── CONVERSIÓN DE MONEDA ───────────────────────────────────────────────────
const MXN_RATE = parseFloat(process.env.MXN_EXCHANGE_RATE) || 17.50;
function usdToMxn(usdPrice) {
    if (!usdPrice || isNaN(usdPrice)) return { price: 0, currency: 'MXN' };
    return { price: Math.round(usdPrice * MXN_RATE * 100) / 100, currency: 'MXN' };
}

// ─── TOKEN CT CONNECT AUTOMATIZATION ──────────────────────────────────────────
const { generateCTToken } = require('./services/ctConnect');

// Scheduled function to run every day to keep the CT Token fresh for dropshipping
exports.scheduledCTTokenRefresh = functions.pubsub.schedule('every 23 hours').onRun(async (context) => {
    console.log('Running scheduled CT Token refresh...');
    const newToken = await generateCTToken();
    if (newToken) {
        // Save the token to Firestore so all instances can use it
        await admin.firestore().collection('system_config').doc('ct_auth').set({
            token: newToken,
            updatedAt: FieldValue.serverTimestamp()
        });
        console.log('CT Token successfully refreshed and stored in Firestore.');
    } else {
        console.error('Failed to generate new CT Token during scheduled refresh.');
    }
    return null;
});

// Helper function to dynamically retrieve the fresh CT token inside APIs
async function getCTToken() {
    const doc = await admin.firestore().collection('system_config').doc('ct_auth').get();
    if (doc.exists && doc.data().token) {
        return doc.data().token;
    }
    // Fallback: Generate it right now if it doesn't exist
    const newToken = await generateCTToken();
    if (newToken) {
        await admin.firestore().collection('system_config').doc('ct_auth').set({
            token: newToken,
            updatedAt: FieldValue.serverTimestamp()
        });
        return newToken;
    }
    throw new Error('No se pudo generar un token de CT.');
}

// ─── CONFIGURACIÓN DE CORREO ──────────────────────────────────────────────────
let mailTransporter = null;
const getMailTransporter = () => {
    if (mailTransporter) return mailTransporter;
    if (process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD) {
        mailTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.SMTP_EMAIL, pass: process.env.SMTP_PASSWORD }
        });
    }
    return mailTransporter;
};

// ─── SERVICIOS DE ENVÍO ────────────────────────────────────────────────────────
const { getSkydropxQuoteForCart } = require('./services/shipping');

async function enviarCorreoConfirmacion(toEmail, customerName, orderId, cartItems, totalAmount) {
    const transporter = getMailTransporter();
    if (!transporter) return;

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
    <div style="font-family: sans-serif; background-color: #0f172a; color: #f8fafc; padding: 40px 20px;">
        <div style="max-width: 600px; margin: 0 auto; background: #1e293b; border-radius: 16px; padding: 30px;">
            <h1 style="color: #a855f7; text-align: center;">PANDISHÚ</h1>
            <h2>¡Gracias por tu compra, ${customerName}!</h2>
            <p>Tu orden #<strong>${orderId}</strong> ha sido recibida.</p>
            <table style="width: 100%; border-collapse: collapse;">${itemsHtml}</table>
            <h3 style="text-align: right;">Total: $${Number(totalAmount).toFixed(2)} MXN</h3>
        </div>
    </div>`;

    try {
        await transporter.sendMail({
            from: '"Pandishú Tech" <' + process.env.SMTP_EMAIL + '>',
            to: [toEmail, process.env.SMTP_EMAIL],
            subject: 'Confirmación de Pedido #' + orderId,
            html: emailHtml
        });
    } catch (e) { console.error('Email error:', e); }
}

// ─── MERCADO PAGO CONFIG ──────────────────────────────────────────────────────
const { MercadoPagoConfig, Preference: MPPreference, Payment: MPPayment } = require('mercadopago');

const getMercadoPagoClient = () => {
    const accessToken = process.env.MP_ACCESS_TOKEN;
    if (!accessToken) return null;
    return new MercadoPagoConfig({ accessToken: accessToken });
};

const YOUR_DOMAIN = 'https://www.pandishu.com';

// ─── FUNCTIONS ────────────────────────────────────────────────────────────────

exports.getConfig = functions.https.onRequest(async (req, res) => {
    cors(req, res, async () => {
        return res.status(200).json({
            MP_PUBLIC_KEY: process.env.MP_PUBLIC_KEY || 'TEST-2f0becf0-afe4-4c79-bea8-317ccc152d84'
        });
    });
});

exports.createCheckoutSession = functions.runWith({
    timeoutSeconds: 60,
    memory: '256MB',
    secrets: ['SKYDROPX_CLIENT_ID', 'SKYDROPX_CLIENT_SECRET']
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        const client = getMercadoPagoClient();
        if (!client) return res.status(500).json({ error: 'MP not configured' });
        try {
            const { items, customer, zipCode } = req.body;

            // 1. Array de items base para Mercado Pago
            const preferenceItems = items.map(p => ({
                id: p.sku || 'SKU', title: p.name, quantity: p.quantity, unit_price: Number(p.price), currency_id: 'MXN'
            }));

            // 2. Envío gestionado por CT
            const destinoCp = zipCode || '64000';
            const shippingCost = 0; // Se delega a la gestión de Dropshipping de CT

            // 3. Añadir el costo de envío a los items que el cliente pagará (si fuera necesario)
            preferenceItems.push({ id: 'ENVIO', title: 'Costo de Envío', quantity: 1, unit_price: shippingCost, currency_id: 'MXN' });

            const amountTotal = items.reduce((s, i) => s + (i.price * i.quantity), 0) + shippingCost;

            const now = new Date();
            const yearStr = now.getFullYear().toString();
            const monthStr = (now.getMonth() + 1).toString().padStart(2, '0');
            const orderRef = admin.firestore().collection('orders').doc(yearStr).collection(monthStr).doc();

            await orderRef.set({
                status: 'pending_payment',
                createdAt: FieldValue.serverTimestamp(),
                customerInfo: customer,
                shippingInfo: {
                    zipCode: destinoCp,
                    cost: shippingCost,
                    provider: 'CT'
                },
                items,
                amountTotal: amountTotal
            });

            const preference = new MPPreference(client);
            const response = await preference.create({
                body: {
                    items: preferenceItems,
                    payer: { email: customer.email, name: customer.name },
                    back_urls: {
                        success: `${YOUR_DOMAIN}/success.html`,
                        failure: `${YOUR_DOMAIN}/failure.html`,
                        pending: `${YOUR_DOMAIN}/pending.html`
                    },
                    auto_return: 'approved',
                    external_reference: `${yearStr}/${monthStr}/${orderRef.id}`,
                    notification_url: 'https://us-central1-pandishu-web-1d860.cloudfunctions.net/mpWebhook'
                }
            });
            return res.status(200).json({ url: response.init_point });
        } catch (e) { return res.status(500).json({ error: e.message }); }
    });
});

exports.processPayment = functions.runWith({
    timeoutSeconds: 60,
    memory: '256MB',
    secrets: ['SKYDROPX_CLIENT_ID', 'SKYDROPX_CLIENT_SECRET']
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        const client = getMercadoPagoClient();
        const { token, payment_method_id, installments, issuer_id, customer, items, zipCode } = req.body;

        try {
            // 1. Costo base de los items
            let amount = items.reduce((s, i) => s + (i.price * i.quantity), 0);

            // 2. Envío gestionado por CT
            const destinoCp = zipCode || '64000';
            const shippingCost = 0;

            // 3. Sumar el costo al monto a cobrar en la tarjeta
            amount += shippingCost;

            const now = new Date();
            const yearStr = now.getFullYear().toString();
            const monthStr = (now.getMonth() + 1).toString().padStart(2, '0');
            const orderRef = admin.firestore().collection('orders').doc(yearStr).collection(monthStr).doc();

            await orderRef.set({
                status: 'processing',
                customerInfo: customer,
                shippingInfo: {
                    zipCode: destinoCp,
                    cost: shippingCost,
                    provider: 'CT'
                },
                items,
                amountTotal: amount,
                createdAt: FieldValue.serverTimestamp()
            });

            const payment = new MPPayment(client);
            const response = await payment.create({
                body: {
                    transaction_amount: amount,
                    token,
                    description: 'Compra Pandishu',
                    installments: Number(installments),
                    payment_method_id,
                    issuer_id,
                    payer: { email: customer.email },
                    external_reference: `${yearStr}/${monthStr}/${orderRef.id}`
                }
            });

            await orderRef.update({ mpStatus: response.status, mpPaymentId: response.id });
            if (response.status === 'approved') {
                await enviarCorreoConfirmacion(customer.email, customer.name, orderRef.id, items, amount);
            }
            return res.status(200).json(response);
        } catch (e) { return res.status(500).json({ error: e.message }); }
    });
});



exports.mpWebhook = functions.https.onRequest(async (req, res) => {
    const client = getMercadoPagoClient();
    const paymentId = req.query.id || (req.body.data && req.body.data.id);
    if (!paymentId) return res.status(200).send('OK');

    try {
        const mpPayment = new MPPayment(client);
        const payInfo = await mpPayment.get({ id: paymentId });
        const orderId = payInfo.external_reference;

        if (payInfo.status === 'approved' && orderId) {
            const orderRef = admin.firestore().collection('orders').doc(orderId);
            const orderDoc = await orderRef.get();
            if (orderDoc.exists && orderDoc.data().status !== 'paid') {
                const data = orderDoc.data();

                // Asignar almacén CT óptimo
                const { getCTItemStock } = require('./services/ctConnect');
                const { getOptimalWarehouse } = require('./services/warehouseManager');
                let resolvedItems = data.items;

                try {
                    const token = await getCTToken();
                    resolvedItems = [];
                    for (let item of data.items) {
                        if (item.source === 'CT' || !item.vendorName || item.vendorName === 'CT') {
                            const ctStock = await getCTItemStock(item.sku, token);
                            const bestAlmacen = getOptimalWarehouse(data.shippingInfo.zipCode, ctStock);
                            resolvedItems.push({ ...item, assignedWarehouse: bestAlmacen || 'PENDING' });
                        } else {
                            resolvedItems.push(item);
                        }
                    }
                } catch (err) {
                    console.error("Error asignando almacén:", err);
                }

                await orderRef.update({
                    status: 'paid',
                    mpPaymentId: paymentId,
                    paidAt: FieldValue.serverTimestamp(),
                    items: resolvedItems
                });

                await enviarCorreoConfirmacion(data.customerInfo.email, data.customerInfo.name, orderId, resolvedItems, data.amountTotal);
            }
        }
        return res.status(200).send('OK');
    } catch (e) { return res.status(200).send('OK'); }
});

exports.searchProducts = functions.runWith({ timeoutSeconds: 60, memory: '1GB' }).https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            const db = admin.firestore();

            // Fetch both CT and Ingram catalogs concurrently
            const [ctSnap, ingramSnap] = await Promise.all([
                db.collection('ct_catalog').get(),
                db.collection('ingram_catalog').get()
            ]);

            const ctProducts = ctSnap.docs.map(d => {
                const data = { ...d.data() };
                const stock = parseInt(data.availability?.availableQuantity || data.existencia || 0, 10);
                delete data.costoInterno;
                delete data.gananciaBruta;
                delete data.margenUtilidad;
                delete data.costo;
                return { ...data, source: 'CT', vendorName: data.vendorName || 'CT', stock };
            });

            const ingramProducts = ingramSnap.docs.map(d => {
                const data = { ...d.data() };
                const stock = parseInt(data.availability?.availableQuantity || data.existencia || 0, 10);
                delete data.costoInterno;
                delete data.gananciaBruta;
                delete data.margenUtilidad;
                delete data.costo;
                return { ...data, source: 'Ingram', vendorName: data.vendorName || 'Ingram', stock };
            });

            const products = [...ctProducts, ...ingramProducts];

            const keyword = (req.body.keyword || '').toLowerCase();
            const filtered = keyword ? products.filter(p => (p.description || '').toLowerCase().includes(keyword) || (p.sku || '').toLowerCase().includes(keyword)) : products;

            return res.status(200).json({ recordsFound: filtered.length, catalog: filtered });
        } catch (e) { return res.status(500).json({ error: e.message }); }
    });
});

exports.getPriceAndAvailability = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        const { skus } = req.body;
        const token = await getCTToken();
        const results = await Promise.all(skus.map(async (sku) => {
            const response = await fetch(`${CT_API_BASE}/existencia/promociones/${sku}`, { headers: { 'x-auth': token } });
            if (!response.ok) return null;
            const data = await response.json();
            return {
                ingramPartNumber: sku,
                pricing: { customerPrice: data.precio, currencyCode: data.moneda },
                availability: { totalAvailability: (data.almacenes || []).reduce((s, a) => s + (a.existencia || 0), 0) }
            };
        }));
        return res.status(200).json(results.filter(r => r));
    });
});

exports.syncCTCatalog = functions.runWith({ timeoutSeconds: 540, memory: '512MB' }).https.onRequest(async (req, res) => {
    cors(req, res, async () => {
        const { execSync } = require('child_process');
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const localPath = path.join(os.tmpdir(), 'ct_stock.json');

        try {
            // Usar PROXY_URL de env vars, fallback a string vacía si no existe para no fallar el comando cat/curl sin auth
            const proxyUrl = process.env.PROXY_URL || '';
            const proxyCmd = proxyUrl ? `-x ${proxyUrl}` : '';
            const authStr = `${process.env.CT_FTP_USER}:${process.env.CT_FTP_PASSWORD}`;
            const ftpBase = `ftp://${authStr}@216.70.82.104/catalogo_xml/`;

            // 1. Obtener listado de archivos (Squid retorna HTML)
            console.log('Listando directorio FTP via Proxy Squid...');
            const listHtml = execSync(`curl -s ${proxyCmd} "${ftpBase}"`).toString();

            // 2. Extraer nomrbes de archivo JSON .json y tomar el ultimo
            const matches = [...listHtml.matchAll(/href="([^"]+\.json)"/g)].map(m => m[1]);
            const targetFile = matches.sort().pop();

            if (!targetFile) throw new Error("No se encontraron archivos .json en el catalogo_xml");

            // 3. Descargar el archivo
            console.log(`Descargando ${targetFile} via Proxy...`);
            execSync(`curl -s ${proxyCmd} "${ftpBase}${targetFile}" -o ${localPath}`, { stdio: 'ignore' });

            const products = JSON.parse(fs.readFileSync(localPath, 'utf8'));
            const productArray = Array.isArray(products) ? products : (products.productos || []);
            const mapped = productArray.map(p => {
                let totalStock = 0;
                if (typeof p.existencia === 'object' && p.existencia !== null) {
                    totalStock = Object.values(p.existencia).reduce((sum, val) => sum + (parseInt(val, 10) || 0), 0);
                } else {
                    totalStock = parseInt(p.existencia || p.disponible || 0, 10) || 0;
                }
                return {
                    ingramPartNumber: String(p.clave || p.codigo || ''),
                    description: p.nombre || '',
                    price: parseFloat(p.precio) * (p.moneda === 'USD' ? MXN_RATE : 1),
                    currency: 'MXN',
                    image: p.imagen || '',
                    existencia: totalStock,
                    availability: { availableQuantity: totalStock }
                };
            }).filter(p => p.ingramPartNumber);

            const db = admin.firestore();
            for (let i = 0; i < mapped.length; i += 400) {
                const batch = db.batch();
                mapped.slice(i, i + 400).forEach(p => batch.set(db.collection('ct_catalog').doc(p.ingramPartNumber), p));
                await batch.commit();
            }
            return res.status(200).json({ success: true, count: mapped.length });
        } catch (e) { return res.status(500).json({ error: e.message }); }
    });
});

exports.syncIngramCatalog = functions.runWith({ timeoutSeconds: 540, memory: '1GB' }).https.onRequest(async (req, res) => {
    cors(req, res, async () => {
        try {
            const path = require('path');
            const os = require('os');
            const { syncIngramCatalog } = require('./services/ingramSftp');
            const { processProviderFile } = require('./process_providers');

            const tempZipUrl = path.join(os.tmpdir(), 'PRICE.ZIP');

            console.log('Descargando PRICE.ZIP via SFTP...');
            const downloadedFile = await syncIngramCatalog('.', tempZipUrl);

            if (!downloadedFile) {
                return res.status(404).json({ error: "No se encontro archivo PRICE.ZIP en SFTP" });
            }

            console.log('Procesando CSV en Firestore...');
            await processProviderFile(downloadedFile, 'Ingram');

            return res.status(200).json({ success: true, message: 'Ingram catalog synced successfully.' });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ error: e.message });
        }
    });
});

// ─── ORDER DASHBOARD (GET PEDIDOS) ────────────────────────────────────────────
exports.getPedidos = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            // -- TEMP PROXY TEST
            if (req.body && req.body.testProxy) {
                const axios = require('axios');
                const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;

                const proxyUrl = process.env.PROXY_URL;
                const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

                const noProxyRes = await axios.get('https://api.ipify.org?format=json');

                const proxyRes = await axios.get('https://api.ipify.org?format=json', {
                    httpAgent: proxyAgent,
                    httpsAgent: proxyAgent
                });

                return res.status(200).json({
                    success: true,
                    ip_normal_cloud_nat: noProxyRes.data.ip,
                    ip_tunnel_squid_vm: proxyRes.data.ip
                });
            }

            const { year, month } = req.body;
            if (!year || !month) return res.status(400).json({ error: 'Falta year y month en body' });

            const monthStr = month.toString().padStart(2, '0');
            const ordersRef = admin.firestore().collection('orders').doc(year.toString()).collection(monthStr);
            const snap = await ordersRef.orderBy('createdAt', 'desc').get();

            const pedidos = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            return res.status(200).json({ recordsFound: pedidos.length, pedidos });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });
});

// ─── GROWTH MARKETING: LEAD MAGNET WELCOME EMAIL ─────────────────────────────
exports.onLeadCreated = functions.firestore
    .document('newsletter_leads/{docId}')
    .onCreate(async (snap, context) => {
        const lead = snap.data();
        const transporter = getMailTransporter();
        if (!transporter) {
            console.error("Transporter SMTP no configurado.");
            return;
        }

        const mailOptions = {
            from: '"Pandishú Premium Hardware" <pandipandishu@gmail.com>', // Coincide con SMTP_EMAIL por defecto o process.env
            to: lead.correo,
            subject: '🚀 Bienvenido a Pandishú Tech Updates',
            html: `
            <div style="font-family: sans-serif; background-color: #020617; color: #f8fafc; padding: 40px 20px;">
                <div style="max-width: 600px; margin: 0 auto; background: #0f172a; border: 1px solid #d946ef; border-radius: 16px; padding: 30px; box-shadow: 0 0 20px rgba(217, 70, 239, 0.2);">
                    <h1 style="color: #d946ef; text-align: center; font-style: italic; letter-spacing: 2px;">PANDISHÚ</h1>
                    <h2 style="text-align: center;">¡Hola ${lead.nombre}! Bienvenido a la Elite Tech</h2>
                    
                    <p style="color: #cbd5e1; line-height: 1.6; text-align: center;">Gracias por suscribirte. Estás oficialmente en la lista VIP para recibir las mejores tendencias en Redes Enterprise, descubrimientos en Ciberseguridad IA y lanzamientos de Hardware High-End.</p>
                    
                    <hr style="border: 0; height: 1px; background: linear-gradient(90deg, transparent, #d946ef, transparent); margin: 30px 0;">
                    
                    <h3 style="color: #38bdf8;">¿Sabías qué? ⚡ Entrega Inmediata en CDMX</h3>
                    <p style="color: #94a3b8; font-size: 14px; line-height: 1.6;">
                        No esperes semanas por tu hardware. En Pandishú operamos los almacenes corporativos más robustos del país. 
                        <strong>Si compras antes de las 12 PM, recibe tus componentes el MISMO DÍA, o te ensamblamos la PC a domicilio en toda la CDMX.</strong>
                    </p>
                    <p style="text-align: center; font-size: 12px; color: #475569; margin-top: 40px;">
                        Has recibido esto porque te suscribiste a nuestro boletín.<br> 
                        Pandishú Tech Solutions | CDMX
                    </p>
                </div>
            </div>
            `
        };

        try {
            await transporter.sendMail(mailOptions);
            console.log(`Email de Lead Magnet enviado exitosamente a ${lead.correo}`);
        } catch (error) {
            console.error(`Fallo al enviar el correo a ${lead.correo}:`, error);
        }
    });
