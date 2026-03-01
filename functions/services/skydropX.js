'use strict';

const axios = require('axios');

const SKYDROPX_BASE = 'https://api.skydropx.com';

/**
 * Obtiene un access token OAuth2 de SkydropX (client_credentials).
 */
async function getSkydropXToken() {
    const clientId = process.env.SKYDROPX_CLIENT_ID;
    const clientSecret = process.env.SKYDROPX_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.error('[SkydropX] Missing SKYDROPX_CLIENT_ID or SKYDROPX_CLIENT_SECRET in env');
        return null;
    }

    try {
        const response = await axios.post(`${SKYDROPX_BASE}/api/v1/oauth/token`, {
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });

        return response.data?.access_token || null;
    } catch (error) {
        console.error('[SkydropX Token] Error:', error.response?.data || error.message);
        return null;
    }
}

/**
 * Obtiene cotización de envío en SkydropX.
 * @param {Object} opts
 * @param {string} opts.fromZip - CP origen (almacén CT)
 * @param {string} opts.toZip  - CP destino (cliente)
 * @param {Object} opts.parcel - { weight_kg, length_cm, width_cm, height_cm }
 * @returns {Array} rates ordenadas por precio
 */
async function getSkydropXQuote({ fromZip, toZip, parcel }) {
    const token = await getSkydropXToken();
    if (!token) return [];

    try {
        const response = await axios.post(`${SKYDROPX_BASE}/api/v1/quotations`, {
            zip_from: fromZip,
            zip_to: toZip,
            parcel: {
                weight: parcel.weight_kg || 1,
                length: parcel.length_cm || 20,
                width: parcel.width_cm || 20,
                height: parcel.height_cm || 10
            }
        }, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 20000
        });

        const rates = response.data?.data?.rates || response.data?.rates || [];
        // Sort by price ascending
        return rates.sort((a, b) => parseFloat(a.total_price || a.price || 0) - parseFloat(b.total_price || b.price || 0));
    } catch (error) {
        console.error('[SkydropX Quote] Error:', error.response?.data || error.message);
        return [];
    }
}

/**
 * Crea un envío en SkydropX y obtiene el número de guía + URL de etiqueta.
 * @param {Object} opts
 * @param {string} opts.quotationId
 * @param {string} opts.rateId
 * @param {Object} opts.sender   - { name, company, email, phone, street, number, district, city, state, zipCode, country }
 * @param {Object} opts.recipient - Same structure
 * @param {Object} opts.parcel   - { weight_kg, length_cm, width_cm, height_cm, description }
 * @param {string} opts.reference - Internal order ID reference
 * @returns {{ tracking_number, label_url, carrier, shipment_id }}
 */
async function createSkydropXShipment({ quotationId, rateId, sender, recipient, parcel, reference }) {
    const token = await getSkydropXToken();
    if (!token) return null;

    try {
        const response = await axios.post(`${SKYDROPX_BASE}/api/v1/shipments`, {
            quotation_id: quotationId,
            rate_id: rateId,
            address_from: {
                name: sender.name || 'Pandishú',
                company: sender.company || 'Pandishú Tech',
                email: sender.email || process.env.SMTP_EMAIL,
                phone: sender.phone || '0000000000',
                street1: sender.street || 'Almacén CT',
                number: sender.number || 'S/N',
                district: sender.district || 'Centro',
                city: sender.city || 'Ciudad de Mexico',
                state: sender.state || 'CMX',
                zip: sender.zipCode || '06600',
                country: 'MX'
            },
            address_to: {
                name: recipient.name,
                email: recipient.email,
                phone: (recipient.phone || '').replace(/\D/g, '').slice(0, 10) || '0000000000',
                street1: recipient.street,
                number: recipient.ext_number || 'S/N',
                district: recipient.colonia || 'Centro',
                city: recipient.city,
                state: recipient.state,
                zip: recipient.zipCode,
                country: 'MX'
            },
            parcel: {
                weight: parcel.weight_kg || 1,
                length: parcel.length_cm || 20,
                width: parcel.width_cm || 20,
                height: parcel.height_cm || 10,
                distance_unit: 'CM',
                mass_unit: 'KG',
                name: parcel.description || 'Producto Pandishú'
            },
            reference_number: reference || ''
        }, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 25000
        });

        const shipment = response.data?.data || response.data;
        const trackingNumber = shipment?.tracking_number || shipment?.attributes?.tracking_number;
        const labelUrl = shipment?.label_url || shipment?.attributes?.label_url;
        const carrier = shipment?.carrier || shipment?.attributes?.carrier || '';
        const shipmentId = shipment?.id || shipment?.attributes?.id;

        console.log(`[SkydropX Shipment] Created: tracking=${trackingNumber}, carrier=${carrier}`);

        return {
            tracking_number: trackingNumber,
            label_url: labelUrl,
            carrier: carrier,
            shipment_id: shipmentId
        };
    } catch (error) {
        console.error('[SkydropX Shipment] Error:', error.response?.data || error.message);
        return null;
    }
}

module.exports = { getSkydropXToken, getSkydropXQuote, createSkydropXShipment };
