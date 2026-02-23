require('dotenv').config();

async function createTestUser() {
    try {
        console.log('Solicitando un nuevo usuario de prueba (Comprador) a Mercado Pago...');

        const response = await fetch('https://api.mercadopago.com/users/test_user', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`
            },
            body: JSON.stringify({
                site_id: 'MLM' // México
            })
        });

        const user = await response.json();

        if (!response.ok) {
            console.error('Mercado Pago devolvió un error:', user);
            return;
        }

        console.log('\n=============================================');
        console.log('✅ USUARIO DE PRUEBA (COMPRADOR) CREADO CON ÉXITO');
        console.log('=============================================');
        console.log(`Usuario: ${user.nickname}`);
        console.log(`Email de Ingreso: ${user.email}`);
        console.log(`Contraseña: ${user.password}`);
        console.log('=============================================');
        console.log('Utiliza ESTOS datos para iniciar sesión en el enlace del Checkout Pro.\n');

    } catch (error) {
        console.error('Error:', error);
    }
}

createTestUser();
