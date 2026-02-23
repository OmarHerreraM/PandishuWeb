require('dotenv').config();
const { MercadoPagoConfig, Preference } = require('mercadopago');

const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

async function createTestLink() {
    try {
        const preference = new Preference(client);

        const prefResponse = await preference.create({
            body: {
                items: [
                    {
                        id: 'TEST-SKU',
                        title: 'Producto de Prueba Pandishú',
                        description: 'Generado desde script de prueba',
                        quantity: 1,
                        currency_id: 'USD',
                        unit_price: 10.00
                    }
                ],
                back_urls: {
                    success: 'https://pandishu-web-1d860.web.app/order-confirmation.html',
                    failure: 'https://pandishu-web-1d860.web.app/checkout.html?error=failed',
                    pending: 'https://pandishu-web-1d860.web.app/order-confirmation.html?status=pending'
                },
                auto_return: 'approved',
                external_reference: 'ORDER-TEST-123',
                statement_descriptor: 'Pandishu Tech',
            }
        });

        console.log('\n=============================================');
        console.log('✅ ENLACE DE PAGO GENERADO CON ÉXITO');
        console.log('=============================================');
        console.log('Abre este enlace en tu navegador para probar el flujo de Mercado Pago:');
        console.log('');
        console.log(prefResponse.init_point);
        console.log('');
        console.log(`(Asegúrate de iniciar sesión con una cuenta de "Comprador de prueba" de Mercado Pago, no con tu cuenta de vendedor)`);

    } catch (error) {
        console.error('Error generando el enlace:', error);
    }
}

createTestLink();
