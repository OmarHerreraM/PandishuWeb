/**
 * createScheduler.js — Crea el job de Cloud Scheduler para sync de CT cada 4 horas
 */
const { GoogleAuth } = require('google-auth-library');

const PROJECT_ID = 'pandishu-web-1d860';
const LOCATION = 'us-central1';
const JOB_NAME = 'sync-ct-catalog';

async function createSchedulerJob() {
    const auth = new GoogleAuth({
        keyFilename: 'C:\\Users\\herre\\AppData\\Roaming\\firebase\\pandipandishu_gmail_com_application_default_credentials.json',
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    const client = await auth.getClient();
    const token = await client.getAccessToken();

    const parentUrl = `https://cloudscheduler.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/jobs`;

    const jobBody = {
        name: `projects/${PROJECT_ID}/locations/${LOCATION}/jobs/${JOB_NAME}`,
        description: 'Sincroniza el catálogo de CT Internacional desde FTP a Firestore cada 4 horas',
        schedule: '0 */4 * * *',
        timeZone: 'America/Mexico_City',
        httpTarget: {
            uri: `https://${LOCATION}-${PROJECT_ID}.cloudfunctions.net/syncCTCatalog`,
            httpMethod: 'GET',
        },
        retryConfig: {
            retryCount: 1,
            maxRetryDuration: '600s',
        }
    };

    console.log('🔄 Creando Cloud Scheduler job...');
    console.log('   URL del job:', jobBody.httpTarget.uri);
    console.log('   Cron:', jobBody.schedule, '(cada 4 horas)');

    const response = await fetch(parentUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token.token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(jobBody)
    });

    const data = await response.json();

    if (!response.ok) {
        if (data.error?.status === 'ALREADY_EXISTS') {
            console.log('⚠️  El job ya existe. Actualizando...');
            // Si ya existe, PATCH para actualizar
            const patchUrl = `https://cloudscheduler.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/jobs/${JOB_NAME}`;
            const patchResponse = await fetch(patchUrl, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${token.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(jobBody)
            });
            const patchData = await patchResponse.json();
            if (!patchResponse.ok) {
                console.error('❌ Error al actualizar:', JSON.stringify(patchData, null, 2));
            } else {
                console.log('✅ Job actualizado exitosamente!');
                console.log('   Nombre:', patchData.name);
                console.log('   Cron:', patchData.schedule);
                console.log('   Zona:', patchData.timeZone);
                console.log('   Estado:', patchData.state);
            }
        } else {
            console.error('❌ Error:', JSON.stringify(data, null, 2));
        }
        return;
    }

    console.log('\n✅ ¡Cloud Scheduler job creado exitosamente!');
    console.log('   Nombre:', data.name);
    console.log('   Horario:', data.schedule, '→ cada 4 horas');
    console.log('   Zona horaria:', data.timeZone);
    console.log('   URL:', data.httpTarget?.uri);
    console.log('   Estado:', data.state);
    console.log('\n🎯 El catálogo de CT se sincronizará automáticamente a las: 0am, 4am, 8am, 12pm, 4pm, 8pm hora México');

    process.exit(0);
}

createSchedulerJob().catch(err => {
    console.error('❌ Error fatal:', err.message);
    process.exit(1);
});
