const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

async function count() {
    console.log("Counting ct_catalog docs...");
    const snap = await db.collection('ct_catalog').count().get();
    console.log("Total docs:", snap.data().count);
    const snap2 = await db.collection('ct_catalog').limit(500).get();
    let size = 0;
    snap2.forEach(d => size += JSON.stringify(d.data()).length);
    console.log("Avg size per doc:", size / 500, "bytes");
    process.exit(0);
}
count().catch(console.error);
