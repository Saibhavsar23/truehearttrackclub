/* Public Firebase web config. These values are NOT secrets (they identify the project; access is enforced by
   Firestore/Storage rules and Cloud Functions). Replace the REPLACE_ME values with the ones from
   Firebase console > Project settings > Your apps > Web app. See README "Firebase setup". */
export const firebaseConfig = {
  apiKey: 'AIzaSyB5rsrkQ2ckS9WucdOTgGoQiO7m8GU54Yw',
  authDomain: 'trueheart-fe921.firebaseapp.com',
  projectId: 'trueheart-fe921',
  storageBucket: 'trueheart-fe921.firebasestorage.app',
  appId: '1:180876246711:web:6463e9cfe384f5bece1732',
};

/* Optional: reCAPTCHA v3 site key for Firebase App Check (public). Leave empty until App Check is set up. */
export const appCheckSiteKey = '';

/* Must match REGION in functions/index.js */
export const functionsRegion = 'us-east1';

/* Local development against the Firebase Emulator Suite: open any page on localhost with ?emulator=1
   (remembered in localStorage until you visit with ?emulator=0). Never active on a real domain. */
export const emulatorProjectId = 'demo-thtc-store';
