// Integration-style tests (rules + presence behavior) using @firebase/rules-unit-testing
// Run with: npm run test:emulator

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const http = require('http');

const EMULATOR_HOST = '127.0.0.1';
const EMULATOR_PORT = 8080;
const PROJECT_ID = 'demo-no-project';

function base64UrlEncode(obj) {
  const b = Buffer.from(JSON.stringify(obj)).toString('base64');
  return b.replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makeMockJwt(userId, project = PROJECT_ID) {
  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: 'none', type: 'JWT' };
  const payload = Object.assign({
    iss: `https://securetoken.google.com/${project}`,
    aud: project,
    iat: iat,
    exp: iat + 3600,
    auth_time: iat,
    sub: userId,
    user_id: userId,
    firebase: { sign_in_provider: 'custom', identities: {} }
  }, {});
  return `${base64UrlEncode(header)}.${base64UrlEncode(payload)}.`; // empty signature
}

function restGetDocument(docPath, authToken) {
  return new Promise((resolve, reject) => {
  const urlPath = `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${docPath}`;
    const headers = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const req = http.request({ host: EMULATOR_HOST, port: EMULATOR_PORT, path: urlPath, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function restPutDocument(docPath, fieldsObj, authToken) {
  return new Promise((resolve, reject) => {
  const urlPath = `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${docPath}`;
    const body = JSON.stringify({ fields: fieldsObj });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const req = http.request({ host: EMULATOR_HOST, port: EMULATOR_PORT, path: urlPath, method: 'PUT', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');

let testEnv;

describe('presence & privacy rules', function () {
  this.timeout(20000);

  before(async () => {
    // If running under `firebase emulators:exec` the emulator host/port are injected
    // via environment variables. In that case connect to the running emulator by
    // specifying host/port. Otherwise, pass the rules text so the harness starts
    // an ephemeral emulator for the tests.
    const rules = fs.readFileSync(RULES_PATH, 'utf8');
    const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
    if (emulatorHost) {
      // FIRESTORE_EMULATOR_HOST is usually like '127.0.0.1:8080'
      const [host, portStr] = emulatorHost.split(':');
      const port = parseInt(portStr, 10);
      testEnv = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { host, port } });
    } else {
      testEnv = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules } });
    }
  });

  after(async () => {
    await testEnv.cleanup();
  });

  it('prevents other users from reading private presence', async () => {
    // create the private doc as admin (bypass rules)
    await testEnv.withSecurityRulesDisabled(async (adminCtx) => {
      const adminDb = adminCtx.firestore();
      await adminDb.collection('users').doc('alice').collection('private').doc('presence').set({ lastSeenAt: Date.now(), venueId: 'v1' });
    });

    // bob trying to read via REST should get 403
    const bobToken = makeMockJwt('bob');
    const res = await restGetDocument('users/alice/private/presence', bobToken);
    assert(res.status === 403 || res.status === 404);
  });

  it('allows owner to read their private presence', async () => {
    // create the private doc as admin (bypass rules)
    await testEnv.withSecurityRulesDisabled(async (adminCtx) => {
      const adminDb = adminCtx.firestore();
      await adminDb.collection('users').doc('alice').collection('private').doc('presence').set({ lastSeenAt: Date.now(), venueId: 'v1' });
    });

    // alice reading via REST with a mock JWT should succeed (200)
  const aliceToken = makeMockJwt('alice');
  const res = await restGetDocument('users/alice/private/presence', aliceToken);
  assert(res.status === 200);
  });

  it('prevents clients from writing venueStats', async () => {
    // try to write venueStats using an authenticated client SDK context — this should be rejected by rules
    const user = testEnv.authenticatedContext({ sub: 'u1' });
    const db = user.firestore();
    await assertFails(db.collection('venueStats').doc('v1').set({ count: 999 }));
  });
});
