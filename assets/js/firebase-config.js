/* Public Firebase web config. These values are NOT secrets (they identify the project; access is enforced by
   Firestore/Storage rules and Cloud Functions). Replace the REPLACE_ME values with the ones from
   Firebase console > Project settings > Your apps > Web app. See README "Firebase setup". */
export const firebaseConfig = {
  apiKey: 'REPLACE_ME',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  projectId: 'REPLACE_ME',
  storageBucket: 'REPLACE_ME.firebasestorage.app',
  appId: 'REPLACE_ME',
};

/* Optional: reCAPTCHA v3 site key for Firebase App Check (public). Leave empty until App Check is set up. */
export const appCheckSiteKey = '';

/* Must match REGION in functions/index.js */
export const functionsRegion = 'us-east1';

/* Local development against the Firebase Emulator Suite: open any page on localhost with ?emulator=1
   (remembered in localStorage until you visit with ?emulator=0). Never active on a real domain. */
export const emulatorProjectId = 'demo-thtc-store';
