/*
Backfill venue geohashes script.
Run from functions/ after installing deps:
  cd functions
  npm install
  node scripts/backfill_geohashes.js --precision=8

This script will iterate the `venues` collection and write `geohash` (string) using geofire-common.
It will skip docs that already have the same geohash.

When running against the emulator, set FIRESTORE_EMULATOR_HOST and FIREBASE_CONFIG or use projectId env.
*/

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const geofire = require('geofire-common');

const argv = require('minimist')(process.argv.slice(2));
const PRECISION = parseInt(argv.precision || 8, 10);

const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || 'demo-project';

if (!admin.apps.length) {
  admin.initializeApp({ projectId });
}

const db = admin.firestore();

async function run() {
  console.log('Backfill geohashes, precision=', PRECISION);

  const batchSize = 500;
  let processed = 0;
  let updated = 0;

  const snapshot = await db.collection('venues').get();
  console.log('Found', snapshot.size, 'venues');

  // We'll do simple per-doc updates. For very large collections, implement pagination.
  for (const doc of snapshot.docs) {
    processed++;
    const data = doc.data();
    const loc = data.location; // expect { latitude, longitude } or Firestore GeoPoint
    if (!loc || (loc.latitude == null && loc._lat == null)) {
      console.warn('Skipping', doc.id, 'no location');
      continue;
    }
    // normalize
    const lat = loc.latitude != null ? loc.latitude : loc._lat;
    const lng = loc.longitude != null ? loc.longitude : loc._long || loc._long || loc.longitude;
    if (lat == null || lng == null) {
      console.warn('Skipping', doc.id, 'bad coords', loc);
      continue;
    }
    const gh = geofire.geohashForLocation([lat, lng]).substring(0, PRECISION);
    if (data.geohash === gh) {
      // no change
      continue;
    }
    await doc.ref.update({ geohash: gh });
    updated++;
    console.log('Updated', doc.id, '->', gh);
  }

  console.log(`Done. Processed=${processed} updated=${updated}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
