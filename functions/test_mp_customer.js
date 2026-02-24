require('dotenv').config();
const { MercadoPagoConfig, Customer, CustomerCard } = require('mercadopago');

async function testCustomerCreation() {
    try {
        console.log('Iniciando prueba de creación de Cliente en Mercado Pago...');

        const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
        const customerClient = new Customer(client);

        const email = `test_user_${Date.now()}@example.com`;
        console.log(`Intentando crear cliente con email: ${email}`);

        const customer = await customerClient.create({
            body: {
                email: email
            }
        });

        console.log('\n✅ ¡Cliente creado exitosamente!');
        console.log(`ID del cliente: ${customer.id}`);
        console.log(`Email del cliente: ${customer.email}`);

        console.log('\nPara probar la creación de la TARJETA (CustomerCard), necesitaríamos un "token" válido generado desde el frontend usando el CardForm o SecureFields de Mercado Pago.');
        console.log('El flujo SDK sería exactamente el que compartiste:');
        console.log(`
const customerCard = new CustomerCard(client);
customerCard.create({ 
    customerId: '${customer.id}', 
    body: { 
        token: 'AQUÍ_IRÍA_EL_TOKEN_DE_LA_TARJETA' 
    } 
});
        `);

    } catch (error) {
        console.error('Error durante la prueba:', error.message || error);
    }
}

testCustomerCreation();
