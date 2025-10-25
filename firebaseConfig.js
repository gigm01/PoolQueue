// Lightweight Firebase client initializer for Expo apps.
// Reads config from Expo Constants.expoConfig.extra (recommended) or process.env for bare workflows.
import Constants from 'expo-constants';
import { initializeApp, getApps } from 'firebase/app';

function getConfig() {
  // Priority: app.json extra (Expo managed) -> process.env
  const extras = Constants.expoConfig?.extra || {};
  return {
    apiKey: extras.FIREBASE_API_KEY || process.env.FIREBASE_API_KEY,
    authDomain: extras.FIREBASE_AUTH_DOMAIN || process.env.FIREBASE_AUTH_DOMAIN,
    projectId: extras.FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID,
    storageBucket: extras.FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: extras.FIREBASE_MESSAGING_SENDER_ID || process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: extras.FIREBASE_APP_ID || process.env.FIREBASE_APP_ID,
  };
}

export function initFirebase() {
  const config = getConfig();
  if (!config || !config.projectId) {
    // Don't throw — allow app to run so the developer can fill in the config.
    console.warn('Firebase config incomplete. Set values in app.json extras or environment variables.');
    return null;
  }

  if (!getApps().length) {
    return initializeApp(config);
  }

  return getApps()[0];
}

export default initFirebase;
