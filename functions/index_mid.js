            folio: ctFolio,
            status: data?.respuestaCT?.estatus || 'Pendiente',
            tipoDeCambio: data?.respuestaCT?.tipoDeCambio,
            errores: ctErrores
        };

    } catch (err) {
        console.error('[CT Connect] Fallo crÃ­tico en la creaciÃ³n de pedido:', err.message);
        throw err;
    }
}

/**
 * FUNCTION 5 â€” mpWebhook
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
            // âš ï¸ Log warning but continue processing â€” do NOT block in sandbox/dev
            console.warn('âš ï¸ MP Webhook Signature mismatch â€” continuing anyway (non-strict mode).');
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

                    console.log(`âœ… Orden ${orderId} marcada como pagada en Firestore.`);

                    // â”€â”€â”€ IntegraciÃ³n Order Entry API de Ingram â”€â”€â”€
                    try {
                        const orderDoc = await admin.firestore().collection('orders').doc(orderId).get();
                        if (orderDoc.exists) {
                            const data = orderDoc.data();

                            // 1) Enviar Correo ElectrÃ³nico al Cliente
                            await enviarCorreoConfirmacion(
                                data.customerInfo.email,
                                data.customerInfo.name,
                                orderId,
                                data.items,
                                data.amountTotal
                            );

                            // 2) Colocar la orden en CT Internacional
                            const ctResult = await placeCTOrder(orderId, data);

                            // 3) Guardar el nÃºmero de orden (folio) de CT en Firestore
                            if (ctResult && ctResult.folio) {
                                await admin.firestore().collection('orders').doc(orderId).update({
                                    ctFolio: ctResult.folio,
                                    ctStatus: ctResult.status || 'placed',
                                    vendor: 'CT'
                                });
                                console.log(`âœ… Orden ${orderId} sincronizada con CT: ${ctResult.folio}`);
                            }
                        }
                    } catch (err) {
                        console.error('âš ï¸ Error en procesamiento post-pago (Email/Ingram):', err.message);
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FUNCTION 7 â€” getInvoiceDetails
// GET â€” Consulta el detalle de una factura de Ingram usando su nÃºmero de factura
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
            return res.status(400).json({ error: 'Se requiere el parÃ¡metro invoiceNumber.' });
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FUNCTION 8 â€” searchInvoices
// GET â€” Busca facturas por nÃºmero de orden de cliente para asociarlas automÃ¡ticamente
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
                    console.log(`âœ… Facturas guardadas en Orden ${customerOrderNumber}`);
                } catch (dbErr) {
                    console.warn('âš ï¸ No se pudo guardar facturas en Firestore:', dbErr.message);
                }
            }

            return res.status(200).json(data);
        } catch (err) {
            console.error('[Invoice] searchInvoices error:', err.message);
            return res.status(500).json({ error: err.message || 'Error al buscar facturas.' });
        }
    });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FUNCTION 9 â€” createOrderV7
// POST â€” Crea una orden ASÃNCRONA en Ingram v7. La respuesta real llega via webhook.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
                notes: 'Orden automÃ¡tica PandishÃº (v7 async)',
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

            console.log(`âœ… Orden v7 enviada. ConfirmaciÃ³n: ${data.confirmationNumber}`);
            return res.status(200).json(data);
        } catch (err) {
            console.error('[OrderV7] createOrderV7 error:', err.message);
            return res.status(500).json({ error: err.message || 'Error al crear la orden v7.' });
        }
    });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FUNCTION 10 â€” getOrderDetails
// GET ?orderNumber=20-RD3QV â€” Detalles completos de una orden de Ingram
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FUNCTION 11 â€” searchOrders
// GET ?customerOrderNumber=... â€” Busca Ã³rdenes de Ingram con mÃºltiples filtros
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
            return res.status(500).json({ error: err.message || 'Error al buscar Ã³rdenes.' });
        }
    });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FUNCTION 12 â€” cancelOrder
// DELETE ?orderNumber=20-RD128 â€” Cancela una orden que estÃ© en customer hold
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

            // Actualizar estado en Firestore si se proporcionÃ³ el ID interno
            if (customerOrderNumber) {
                await admin.firestore().collection('orders').doc(customerOrderNumber).update({
                    status: 'cancelled',
                    ingramStatus: 'cancelled',
                    cancelledAt: FieldValue.serverTimestamp()
                });
            }

            console.log(`âœ… Orden ${orderNumber} cancelada en Ingram.`);
            return res.status(200).json({ status: 'cancelled', orderNumber });
        } catch (err) {
            console.error('[Orders] cancelOrder error:', err.message);
            return res.status(500).json({ error: err.message || 'Error al cancelar la orden.' });
        }
    });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FUNCTION 13 â€” modifyOrder
// PUT ?orderNumber=20-RC1RD â€” Modifica lÃ­neas de una orden en customer hold
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FUNCTION 14 â€” getVendorRequiredInfo
// POST â€” Obtiene los campos obligatorios del vendor (VMF) para una orden o cotizaciÃ³n
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

            // El SDK no tiene wrapper explÃ­cito para esta llamada, usamos fetch directo
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

// NOTA: La API de Ingram Micro para MÃ©xico (v6) no incluye endpoint de estimaciÃ³n de flete.
// El costo de envÃ­o se maneja como tarifa fija de $149 MXN directamente en el checkout.

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// TEST FUNCTION â€” testIpPandishu
// GET â€” Realiza una peticiÃ³n a ipify.org para confirmar que la IP de salida es la estÃ¡tica
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
            // Hacemos la peticiÃ³n a ipify para ver con quÃ© IP estamos saliendo a internet
            const response = await axios.get('https://api.ipify.org?format=json');

            const expectedIp = '34.136.167.161';
            const detectedIp = response.data.ip;

            return res.status(200).json({
                success: true,
                message: detectedIp === expectedIp
                    ? "Â¡Ã‰XITO! El trÃ¡fico estÃ¡ saliendo correctamente por la IP EstÃ¡tica del Cloud NAT."
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FUNCTION â€” syncCTCatalog
// Descarga el JSON de CT vÃ­a FTP y lo guarda en Firestore (colecciÃ³n ct_catalog)
// Invocar manualmente: GET /syncCTCatalog
// Programar: Cloud Scheduler cada 15 minutos apuntando a esta URL
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const Client = require('ssh2-sftp-client'); // Reutilizamos para SFTP de ingram; CT usa FTP bÃ¡sico
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
        console.log('ðŸ”„ [syncCTCatalog] Iniciando sincronizaciÃ³n del catÃ¡logo CT via FTP...');

        const ftpConfig = {
            host: '216.70.82.104',
            user: process.env.CT_FTP_USER || 'DFP2631',
            password: process.env.CT_FTP_PASSWORD || 'hMlrhbEAvy0ungi3UxsvFkQtHmHtYyy5'
        };

        const client = new ftp.Client();
        const localPath = path.join(os.tmpdir(), `ct_stock_${Date.now()}.json`);

        try {
            await client.access(ftpConfig);
            console.log('âœ… FTP conectado.');

            // CT deposita los archivos dentro del subdirectorio catalogo_xml
            await client.cd('catalogo_xml');
            console.log('ðŸ“‚ Navegando a /catalogo_xml ...');

            // Listar directorio para encontrar el archivo JSON correcto
            const list = await client.list();
            console.log('ðŸ“‚ Archivos en /catalogo_xml:', list.map(f => `${f.name} (${(f.size / 1024).toFixed(1)}KB)`).join(', '));

            // Priorizar: archivo .json (stock en tiempo real, generado cada 15 min)
            const jsonFile = list.find(f => f.name.toLowerCase().endsWith('.json')) ||
                list.find(f => f.name.toLowerCase().includes('json'));

            if (!jsonFile) {
                client.close();
                return res.status(404).json({ error: 'No se encontrÃ³ archivo JSON en /catalogo_xml', files: list.map(f => f.name) });
            }

            console.log(`ðŸ“¥ Descargando: ${jsonFile.name} (${(jsonFile.size / 1024).toFixed(1)} KB)`);
            await client.downloadTo(localPath, jsonFile.name);
            client.close();

            // Leer y parsear el JSON
            const raw = fs.readFileSync(localPath, 'utf-8');
            const products = JSON.parse(raw);
            const productArray = Array.isArray(products) ? products : (products.productos || products.data || []);

            console.log(`ðŸ“¦ Productos en JSON: ${productArray.length}`);

            // Mapear al formato unificado de PandishÃº
            const mapped = productArray.map(p => {
                let price = parseFloat(p.precio || p.price || 0);
                const currency = (p.moneda || p.currency || 'USD').toUpperCase();
                if (currency === 'USD') price = Math.round(price * MXN_RATE_SYNC * 100) / 100;
                return {
                    ingramPartNumber: String(p.codigo || p.clave || p.sku || ''),
                    vendorName: p.marca || p.brand || 'CT Internacional',
                    vendorPartNumber: p.numParte || p.numParte || '',
                    description: p.nombre || p.descripcion || p.description || 'Sin descripciÃ³n',
                    productCategory: p.subcategoria || p.categoria || '',
                    image: p.imagen || p.image || '',
                    price: price,
                    currency: 'MXN',
                    availability: { availableQuantity: parseInt(p.existencia || p.stock || 0) },
                    source: 'CT'
                };
            }).filter(p => p.ingramPartNumber); // Solo con cÃ³digo vÃ¡lido

            // Escribir a Firestore en batches de 500
            const db = admin.firestore();
            const BATCH_SIZE = 400;
            let written = 0;

            // Limpiar colecciÃ³n anterior primero
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
                console.log(`  ðŸ’¾ Escritos ${written}/${mapped.length} productos...`);
            }

            // Limpiar temp file
            try { fs.unlinkSync(localPath); } catch (e) { }

            const summary = { success: true, total: mapped.length, written, syncedAt: new Date().toISOString() };
            console.log('âœ… SincronizaciÃ³n CT completada:', summary);
            return res.status(200).json(summary);

        } catch (err) {
            client.close();
            try { if (fs.existsSync(localPath)) fs.unlinkSync(localPath); } catch (e) { }
            console.error('âŒ syncCTCatalog error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });
