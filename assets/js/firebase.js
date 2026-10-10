import { firebaseConfig, appCheckSiteKey, functionsRegion, emulatorProjectId } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/11.10.0';
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

function emulatorOn() {
  if (!isLocal) return false;
  try {
    const q = new URLSearchParams(location.search).get('emulator');
    if (q === '1') localStorage.setItem('thtc_emulator', '1');
    if (q === '0') localStorage.removeItem('thtc_emulator');
    return localStorage.getItem('thtc_emulator') === '1';
  } catch (_) { return false; }
}

export const useEmulator = emulatorOn();
export const isConfigured = useEmulator || !String(firebaseConfig.apiKey).startsWith('REPLACE');

let corePromise;
let adminPromise;

/** Firebase app + Firestore + callable Functions (everything the public storefront needs). */
export function loadCore() {
  if (!isConfigured) return Promise.reject(Object.assign(new Error('not_configured'), { code: 'not_configured' }));
  corePromise ??= (async () => {
    const [{ initializeApp, getApps }, fs, fn] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-firestore.js`),
      import(`${SDK}/firebase-functions.js`),
    ]);
    const cfg = useEmulator ? { projectId: emulatorProjectId, apiKey: 'demo', appId: 'demo', authDomain: 'localhost', storageBucket: `${emulatorProjectId}.appspot.com` } : firebaseConfig;
    const app = getApps().length ? getApps()[0] : initializeApp(cfg);
    if (appCheckSiteKey && !useEmulator) {
      try {
        const ac = await import(`${SDK}/firebase-app-check.js`);
        ac.initializeAppCheck(app, { provider: new ac.ReCaptchaV3Provider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
      } catch (e) { console.warn('App Check unavailable', e); }
    }
    const db = fs.getFirestore(app);
    const functions = fn.getFunctions(app, functionsRegion);
    if (useEmulator) {
      fs.connectFirestoreEmulator(db, '127.0.0.1', 8080);
      fn.connectFunctionsEmulator(functions, '127.0.0.1', 5001);
    }
    return { app, db, functions, fs, fn };
  })();
  return corePromise;
}

/** Core + Auth + Storage for the admin dashboard. */
export function loadAdmin() {
  adminPromise ??= (async () => {
    const core = await loadCore();
    const [au, st] = await Promise.all([import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-storage.js`)]);
    const auth = au.getAuth(core.app);
    const storage = st.getStorage(core.app);
    if (useEmulator) {
      au.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      st.connectStorageEmulator(storage, '127.0.0.1', 9199);
    }
    return { ...core, auth, storage, au, st };
  })();
  return adminPromise;
}

export async function callable(name, data) {
  const { functions, fn } = await loadCore();
  const res = await fn.httpsCallable(functions, name)(data);
  return res.data;
}
