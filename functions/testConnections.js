require('dotenv').config();
const { syncIngramCatalog } = require('./services/ingramSftp');
const { syncCTCatalog } = require('./services/ctFtpSync');
const path = require('path');

async function testLiveConnections() {
    console.log('====================================================');
    console.log('🚀 INICIANDO PRUEBAS DE CONEXIÓN EN VIVO (PRODUCCIÓN)');
    console.log(`MODO MOCK: ${process.env.USE_MOCK_DATA}`);
    console.log('====================================================\n');

    const tempDir = path.join(__dirname, 'temp');
    const fs = require('fs');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    // 1. Prueba CT Connect (FTP)
    console.log('--- 1. PROBANDO CT CONNECT (FTP) ---');
    try {
        await syncCTCatalog(tempDir);
        console.log('✅ CT FTP: Conexión Exitosa y listado completado.\n');
    } catch (err) {
        console.error('❌ CT FTP Falló:', err.message, '\n');
    }

    // 2. Prueba Ingram Micro (SFTP)
    console.log('--- 2. PROBANDO INGRAM MICRO (SFTP) ---');
    try {
        // Le pasamos null o temp para que solo liste y no intente descargar un archivo a ciegas todavía
        await syncIngramCatalog('.', path.join(tempDir, 'ingram_test.csv'));
        console.log('✅ INGRAM SFTP: Conexión Exitosa y listado completado.\n');
    } catch (err) {
        console.error('❌ INGRAM SFTP Falló:', err.message, '\n');
    }

    console.log('====================================================');
    console.log('🏁 FIN DE LAS PRUEBAS');
    console.log('====================================================');
}

testLiveConnections();
