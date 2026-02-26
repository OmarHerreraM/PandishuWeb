const admin = require('firebase-admin');
const fs = require('fs');

if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

async function checkStock() {
    try {
        const snap = await db.collection('ct_catalog').limit(5).get();
        const results = snap.docs.map(d => ({ id: d.id, data: d.data() }));
        fs.writeFileSync('check_stock_output.json', JSON.stringify(results, null, 2));
        console.log('Stock check complete. Results in check_stock_output.json');
    } catch (e) {
        console.error('Error checking stock:', e);
    }
}

checkStock();
