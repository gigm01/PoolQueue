const functions = require('firebase-functions');
const admin = require('firebase-admin');
const geofire = require('geofire-common');

admin.initializeApp();
const db = admin.firestore();

// Callable: returns nearby venues for given coords. Does NOT store the coords.
exports.getNearbyVenues = functions.https.onCall(async (data, context) => {
  if (!data || typeof data.lat !== 'number' || typeof data.lng !== 'number') {
    throw new functions.https.HttpsError('invalid-argument', 'lat and lng required');
  }
  const { lat, lng, radiusMeters = 1000 } = data;

  // Compute geohash query bounds
  const center = [lat, lng];
  const bounds = geofire.geohashQueryBounds(center, radiusMeters);
  const promises = [];
  for (const b of bounds) {
    const q = db.collection('venues')
      .orderBy('geohash')
      .startAt(b[0])
      .endAt(b[1])
      .limit(50);
    promises.push(q.get());
  }

  const snapshots = await Promise.all(promises);
  const matching = [];
  for (const snap of snapshots) {
    snap.forEach(doc => {
      const data = doc.data();
      if (!data.location || !data.geohash) return;
      const distance = geofire.distanceBetween([lat, lng], [data.location.latitude, data.location.longitude]) * 1000; // km->m
      if (distance <= radiusMeters) {
        matching.push({ id: doc.id, ...data, distanceMeters: Math.round(distance) });
      }
    });
  }

  // Sort by distance and return limited set
  matching.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return { venues: matching.slice(0, 30) };
});

// Callable: user checks in to a venue. Server validates proximity using provided coords (if present)
// and updates aggregated venueStats. Per-user presence is written to users/{uid}/presence (admin write).
exports.checkIn = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }
  const uid = context.auth.uid;
  const { venueId, lat, lng } = data || {};
  if (!venueId) {
    throw new functions.https.HttpsError('invalid-argument', 'venueId is required');
  }

  const venueRef = db.collection('venues').doc(venueId);
  const venueSnap = await venueRef.get();
  if (!venueSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Venue not found');
  }
  const venue = venueSnap.data();

  // If client provided coords, do a proximity check (best-effort). If not provided, we accept check-in but mark unverified.
  let verified = false;
  if (typeof lat === 'number' && typeof lng === 'number' && venue.location && venue.location.latitude && venue.location.longitude) {
    const distance = geofire.distanceBetween([lat, lng], [venue.location.latitude, venue.location.longitude]) * 1000; // meters
    // allow check-in within 200 meters by default
    if (distance <= 200) verified = true;
  }

  // Update aggregated stats: increment activeCount and set lastUpdated
  const statsRef = db.collection('venueStats').doc(venueId);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(statsRef);
    if (!s.exists) {
      tx.set(statsRef, { count: 1, lastUpdated: admin.firestore.FieldValue.serverTimestamp() });
    } else {
      tx.update(statsRef, { count: admin.firestore.FieldValue.increment(1), lastUpdated: admin.firestore.FieldValue.serverTimestamp() });
    }

    // Write per-user presence privately under users/{uid}/presence using admin SDK (bypasses rules)
    const presenceRef = db.collection('users').doc(uid).collection('private').doc('presence');
    tx.set(presenceRef, {
      venueId,
      verified,
      checkedInAt: admin.firestore.FieldValue.serverTimestamp()
    });
    // Also maintain presenceIndex for scheduled cleanup and quick lookup
    const indexRef = db.collection('presenceIndex').doc(uid);
    tx.set(indexRef, {
      uid,
      venueId,
      lastSeenAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return { success: true, verified };
});

// Callable: user checks out of their current venue. Decrements venueStats and removes presence.
exports.checkOut = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }
  const uid = context.auth.uid;
  // optional: venueId can be provided to validate
  const { venueId: requestedVenueId } = data || {};

  const presenceRef = db.collection('users').doc(uid).collection('private').doc('presence');
  const presenceSnap = await presenceRef.get();
  if (!presenceSnap.exists) {
    return { success: false, message: 'No active presence' };
  }
  const presence = presenceSnap.data();
  const venueId = presence.venueId;
  if (requestedVenueId && requestedVenueId !== venueId) {
    // mismatch — optionally ignore or return error
    throw new functions.https.HttpsError('failed-precondition', 'Venue ID mismatch');
  }

  const statsRef = db.collection('venueStats').doc(venueId);
  const indexRef = db.collection('presenceIndex').doc(uid);

  await db.runTransaction(async (tx) => {
    // decrement count but never below zero
    const s = await tx.get(statsRef);
    if (s.exists && s.data().count && s.data().count > 0) {
      tx.update(statsRef, { count: admin.firestore.FieldValue.increment(-1), lastUpdated: admin.firestore.FieldValue.serverTimestamp() });
    }
    tx.delete(presenceRef);
    tx.delete(indexRef);
  });

  return { success: true };
});

// Scheduled function: expire presences older than TTL_MINUTES and decrement venueStats accordingly.
const TTL_MINUTES = 30; // presence expiry in minutes
exports.expireOldPresences = functions.pubsub.schedule('every 1 minutes').onRun(async (context) => {
  const cutoff = admin.firestore.Timestamp.fromDate(new Date(Date.now() - TTL_MINUTES * 60 * 1000));
  const expiredQuery = db.collection('presenceIndex').where('lastSeenAt', '<=', cutoff).limit(500);
  let batch = db.batch();
  let processed = 0;
  const snapshots = await expiredQuery.get();
  if (snapshots.empty) return null;
  for (const doc of snapshots.docs) {
    const data = doc.data();
    const uid = data.uid;
    const venueId = data.venueId;
    const statsRef = db.collection('venueStats').doc(venueId);
    const presenceRef = db.collection('users').doc(uid).collection('private').doc('presence');
    // decrement count safely via transaction per doc to avoid race conditions
    try {
      await db.runTransaction(async (tx) => {
        const s = await tx.get(statsRef);
        if (s.exists && s.data().count && s.data().count > 0) {
          tx.update(statsRef, { count: admin.firestore.FieldValue.increment(-1), lastUpdated: admin.firestore.FieldValue.serverTimestamp() });
        }
        tx.delete(presenceRef);
        tx.delete(db.collection('presenceIndex').doc(uid));
      });
      processed++;
    } catch (e) {
      console.error('Failed to expire presence for', uid, e);
    }
  }
  console.log('Expired presences processed:', processed);
  return null;
});

// Lightweight callable to refresh presence timestamp without changing counts.
exports.refreshPresence = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }
  const uid = context.auth.uid;
  const { venueId } = data || {};
  if (!venueId) throw new functions.https.HttpsError('invalid-argument', 'venueId required');

  const presenceRef = db.collection('users').doc(uid).collection('private').doc('presence');
  const indexRef = db.collection('presenceIndex').doc(uid);

  await db.runTransaction(async (tx) => {
    // Only refresh if presence exists and matches the venueId
    const p = await tx.get(presenceRef);
    if (!p.exists) {
      throw new functions.https.HttpsError('failed-precondition', 'No active presence to refresh');
    }
    const pdata = p.data();
    if (pdata.venueId !== venueId) {
      throw new functions.https.HttpsError('failed-precondition', 'Venue ID mismatch');
    }
    tx.update(presenceRef, { lastSeenAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(indexRef, { lastSeenAt: admin.firestore.FieldValue.serverTimestamp() });
  });

  return { success: true };
});

// Scheduled reconciliation: recompute venueStats counts from presenceIndex to recover from drift.
exports.reconcileVenueStats = functions.pubsub.schedule('every 15 minutes').onRun(async (context) => {
  console.log('Reconciliation job started');
  const counts = {};
  const snapshot = await db.collection('presenceIndex').get();
  snapshot.forEach(doc => {
    const data = doc.data();
    if (data && data.venueId) {
      counts[data.venueId] = (counts[data.venueId] || 0) + 1;
    }
  });

  // Write computed counts to venueStats (batched)
  const batch = db.batch();
  let writes = 0;
  for (const venueId of Object.keys(counts)) {
    const statsRef = db.collection('venueStats').doc(venueId);
    batch.set(statsRef, { count: counts[venueId], lastUpdated: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    writes++;
    if (writes >= 400) {
      await batch.commit();
      writes = 0;
    }
  }
  if (writes > 0) await batch.commit();
  console.log('Reconciliation job finished, venues:', Object.keys(counts).length);
  return null;
});

// Regional leaderboard reconciliation
// Top 25 players per larger-region (city/town level). We keep venue geohash precision
// at VENUE_GEOHASH_PRECISION (used for venue searches and busy-ness) and compute
// leaderboard regions using LEADERBOARD_REGION_HASH_LENGTH (coarser, e.g., 5 => ~5km cells).
const VENUE_GEOHASH_PRECISION = 8; // used for venue geohash storage/search
const LEADERBOARD_REGION_HASH_LENGTH = 5; // coarser region for leaderboards (city/town)
const WINDOW_DAYS = 30;
const MIN_GAMES = 10;
const LEADERBOARD_SIZE = 25;

exports.reconcileRegionalLeaderboards = functions.pubsub.schedule('every 15 minutes').onRun(async (context) => {
  console.log('Starting regional leaderboard reconciliation');
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const gamesSnap = await db.collection('games').where('playedAt', '>=', admin.firestore.Timestamp.fromDate(cutoff)).get();
  if (gamesSnap.empty) {
    console.log('No recent games found');
    return null;
  }

  // We'll aggregate: region -> playerId -> count
  const regionPlayerCounts = {};
  const venueCache = {};

  for (const gameDoc of gamesSnap.docs) {
    const g = gameDoc.data();
    const venueId = g.venueId;
    if (!venueId) continue;

    // get venue (cached)
    let venue = venueCache[venueId];
    if (!venue) {
      const vSnap = await db.collection('venues').doc(venueId).get();
      if (!vSnap.exists) continue;
      venue = vSnap.data();
      venueCache[venueId] = venue;
    }

    // determine region geohash prefix
    let region = null;
    if (venue.geohash) {
      region = venue.geohash.substring(0, LEADERBOARD_REGION_HASH_LENGTH);
    } else if (venue.location && venue.location.latitude && venue.location.longitude) {
      const gh = geofire.geohashForLocation([venue.location.latitude, venue.location.longitude]);
      region = gh.substring(0, LEADERBOARD_REGION_HASH_LENGTH);
    } else {
      continue;
    }

    // determine players in this game: support multiple shapes
    let players = [];
    if (Array.isArray(g.players) && g.players.length) players = g.players;
    else if (g.playerA && g.playerB) players = [g.playerA, g.playerB];
    else if (g.winner && g.loser) players = [g.winner, g.loser];
    else continue;

    regionPlayerCounts[region] = regionPlayerCounts[region] || {};
    for (const pid of players) {
      regionPlayerCounts[region][pid] = (regionPlayerCounts[region][pid] || 0) + 1;
    }
  }

  // For each region, pick players meeting MIN_GAMES and sort by current rating
  for (const region of Object.keys(regionPlayerCounts)) {
    const counts = regionPlayerCounts[region];
    const candidates = [];
    for (const [pid, cnt] of Object.entries(counts)) {
      if (cnt < MIN_GAMES) continue;
      // fetch user rating (best-effort cache)
      const uSnap = await db.collection('users').doc(pid).get();
      if (!uSnap.exists) continue;
      const u = uSnap.data();
      const rating = typeof u.rating === 'number' ? u.rating : 1200;
      const displayName = u.displayName || null;
      candidates.push({ uid: pid, rating, displayName, gamesPlayed: cnt });
    }

    // sort by rating desc
    candidates.sort((a, b) => b.rating - a.rating);
    const top = candidates.slice(0, LEADERBOARD_SIZE);

    // write leaderboard doc
    const lbRef = db.collection('leaderboards').doc(region);
    await lbRef.set({
      region,
      generatedAt: admin.firestore.FieldValue.serverTimestamp(),
      players: top
    });
    console.log('Wrote leaderboard for region', region, 'entries', top.length);
  }

  console.log('Regional leaderboard reconciliation complete');
  return null;
});
