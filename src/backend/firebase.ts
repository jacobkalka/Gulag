import { initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, initializeFirestore, type Firestore } from 'firebase/firestore';
import { connectDatabaseEmulator, getDatabase, type Database } from 'firebase/database';
import { EMULATOR_HOST, EMULATOR_PORTS, firebaseConfig, useEmulators } from './config';

export interface Fb {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  rtdb: Database;
  emulated: boolean;
}

let fb: Fb | null = null;

/** Initializes Firebase once. Returns null when no configuration is available (offline mode). */
export function getFirebase(): Fb | null {
  if (fb) return fb;
  const cfg = firebaseConfig();
  if (!cfg) return null;
  const app = initializeApp(cfg);
  const auth = getAuth(app);
  // long polling auto-detection keeps Firestore working behind strict proxies
  const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true, ignoreUndefinedProperties: true });
  const rtdb = getDatabase(app);
  const emulated = useEmulators();
  if (emulated) {
    connectAuthEmulator(auth, `http://${EMULATOR_HOST}:${EMULATOR_PORTS.auth}`, { disableWarnings: true });
    connectFirestoreEmulator(db, EMULATOR_HOST, EMULATOR_PORTS.firestore);
    connectDatabaseEmulator(rtdb, EMULATOR_HOST, EMULATOR_PORTS.database);
  }
  fb = { app, auth, db, rtdb, emulated };
  return fb;
}
