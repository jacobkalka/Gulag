// Firebase configuration comes from build-time environment variables (never committed):
//   VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID,
//   VITE_FIREBASE_DATABASE_URL, VITE_FIREBASE_APP_ID  (see SETUP.md)
// Without them the game runs offline: guest profile in localStorage, rooms between local tabs.
// `?emulators=1` (or VITE_FIREBASE_EMULATORS=1) talks to the local Firebase Emulator Suite
// with a demo project, which needs no real Firebase project at all.

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  databaseURL: string;
  appId: string;
}

export function useEmulators(): boolean {
  return import.meta.env.VITE_FIREBASE_EMULATORS === '1' || new URLSearchParams(location.search).get('emulators') === '1';
}

export const EMULATOR_HOST = '127.0.0.1';
export const EMULATOR_PORTS = { auth: 9099, firestore: 8080, database: 9000 } as const;

export function firebaseConfig(): FirebaseWebConfig | null {
  if (new URLSearchParams(location.search).get('offline') === '1') return null;
  if (useEmulators()) {
    return {
      apiKey: 'demo-key',
      authDomain: 'demo-lockdown.firebaseapp.com',
      projectId: 'demo-lockdown',
      databaseURL: `http://${EMULATOR_HOST}:${EMULATOR_PORTS.database}?ns=demo-lockdown`,
      appId: 'demo-app',
    };
  }
  const e = import.meta.env;
  if (!e.VITE_FIREBASE_API_KEY || !e.VITE_FIREBASE_PROJECT_ID || !e.VITE_FIREBASE_DATABASE_URL) return null;
  return {
    apiKey: e.VITE_FIREBASE_API_KEY,
    authDomain: e.VITE_FIREBASE_AUTH_DOMAIN || `${e.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`,
    projectId: e.VITE_FIREBASE_PROJECT_ID,
    databaseURL: e.VITE_FIREBASE_DATABASE_URL,
    appId: e.VITE_FIREBASE_APP_ID || '',
  };
}
