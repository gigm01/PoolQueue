// Integration-style tests (rules + presence behavior) using @firebase/rules-unit-testing
// Run with: npm run test:emulator

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');

const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');

let testEnv;

describe('presence & privacy rules', function () {
  this.timeout(20000);

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'test-project',
      firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8') },
    });
  });

  after(async () => {
    await testEnv.cleanup();
  });

  it('prevents other users from reading private presence', async () => {
    const alice = testEnv.authenticatedContext('alice', { uid: 'alice' });
    const bob = testEnv.authenticatedContext('bob', { uid: 'bob' });

    const admin = testEnv.unauthenticatedContext();

    // Admin (emulator admin client) writes a private presence doc under alice via the admin client
    const adminDb = admin.firestore();
    await adminDb.collection('users').doc('alice').collection('private').doc('presence').set({ lastSeenAt: Date.now(), venueId: 'v1' });

    const bobDb = bob.firestore();
    const alicePrivate = bobDb.collection('users').doc('alice').collection('private').doc('presence');

    await assertFails(alicePrivate.get());
  });

  it('allows owner to read their private presence', async () => {
    const alice = testEnv.authenticatedContext('alice', { uid: 'alice' });
    const admin = testEnv.unauthenticatedContext();
    const adminDb = admin.firestore();
    await adminDb.collection('users').doc('alice').collection('private').doc('presence').set({ lastSeenAt: Date.now(), venueId: 'v1' });

    const aliceDb = alice.firestore();
    const alicePrivate = aliceDb.collection('users').doc('alice').collection('private').doc('presence');
    await assertSucceeds(alicePrivate.get());
  });

  it('prevents clients from writing venueStats', async () => {
    const user = testEnv.authenticatedContext('u1', { uid: 'u1' });
    const db = user.firestore();
    const ref = db.collection('venueStats').doc('v1');
    await assertFails(ref.set({ count: 999 }));
  });
});
