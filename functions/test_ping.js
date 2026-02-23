'use strict';
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors')({ origin: true });

admin.initializeApp();

exports.ping = functions.https.onRequest((req, res) => {
    cors(req, res, () => {
        res.status(200).json({ status: 'ok', message: 'Firebase Functions are live!' });
    });
});
