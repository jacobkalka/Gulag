import {
  EmailAuthProvider,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  linkWithCredential,
  linkWithPopup,
  onAuthStateChanged,
  signInAnonymously,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth';
import { doc, getDoc, onSnapshot, serverTimestamp, updateDoc, writeBatch, type Unsubscribe } from 'firebase/firestore';
import { DEFAULT_LOADOUT, sanitizeLoadout, levelForXp, type Loadout } from '@/data/progression';
import { emptyProfileStats, profile, pushToast, randomFriendCode, type Profile } from '@/app/state';
import { account, type AccountInfo } from '@/app/social';
import type { Fb } from './firebase';

// Authentication (anonymous guest by default, upgradeable to Google or email without losing
// progress) and the player's Firestore profile.

export const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function cleanName(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
}

function accountInfo(u: User): AccountInfo {
  const pid = u.providerData[0]?.providerId;
  return {
    uid: u.uid,
    anonymous: u.isAnonymous,
    provider: u.isAnonymous ? 'anonymous' : pid === 'google.com' ? 'google' : 'password',
    email: u.email ?? undefined,
  };
}

export class AccountService {
  private unsubProfile: Unsubscribe | null = null;
  private readyResolve: (() => void) | null = null;
  readonly ready: Promise<void>;
  /** Called whenever the signed-in user changes (after their profile exists). */
  onUser: ((u: User) => void) | null = null;
  /** Called with the input mode stored in the profile (when the profile loads or changes). */
  onPrefs: ((mode: 'mouse' | 'touchpad' | undefined) => void) | null = null;

  constructor(private fb: Fb) {
    this.ready = new Promise((r) => (this.readyResolve = r));
  }

  get user(): User | null {
    return this.fb.auth.currentUser;
  }

  start(): void {
    onAuthStateChanged(this.fb.auth, (u) => {
      if (!u) {
        account.value = null;
        this.unsubProfile?.();
        this.unsubProfile = null;
        signInAnonymously(this.fb.auth).catch((e) => {
          console.warn('anonymous sign-in failed', e);
          pushToast({ title: 'OFFLINE', body: 'Could not reach the account service. Progress is saved on this device.', kind: 'error' });
        });
        return;
      }
      void this.bootstrap(u);
    });
  }

  private async bootstrap(u: User): Promise<void> {
    try {
      await this.ensureProfile(u);
    } catch (e) {
      console.warn('profile bootstrap failed', e);
      pushToast({ title: 'PROFILE ERROR', body: String((e as Error).message ?? e), kind: 'error' });
      return;
    }
    account.value = accountInfo(u);
    this.unsubProfile?.();
    this.unsubProfile = onSnapshot(doc(this.fb.db, 'users', u.uid), (snap) => {
      const d = snap.data();
      if (!d) return;
      const p: Profile = {
        uid: u.uid,
        username: d.username,
        friendCode: d.friendCode,
        xp: d.xp ?? 0,
        loadout: sanitizeLoadout(d.loadout, levelForXp(d.xp ?? 0).level),
        stats: { ...emptyProfileStats(), ...(d.stats ?? {}) },
        guest: u.isAnonymous,
        inputMode: d.prefs?.inputMode === 'touchpad' ? 'touchpad' : d.prefs?.inputMode === 'mouse' ? 'mouse' : undefined,
      };
      profile.value = p;
      this.onPrefs?.(p.inputMode);
      this.readyResolve?.();
      this.readyResolve = null;
    });
    this.onUser?.(u);
  }

  /** First sign-in: claim a unique name (based on the local guest name) and friend code. */
  private async ensureProfile(u: User): Promise<void> {
    const db = this.fb.db;
    const ref = doc(db, 'users', u.uid);
    if ((await getDoc(ref)).exists()) return;
    const local = profile.value;
    const base = cleanName(local.username).length >= 3 ? cleanName(local.username) : 'Inmate';
    for (let attempt = 0; attempt < 8; attempt++) {
      const name = attempt === 0 ? base : `${base.slice(0, 11)}${Math.floor(Math.random() * 90000 + 10000)}`;
      const code = randomFriendCode();
      const b = writeBatch(db);
      b.set(ref, {
        username: name,
        usernameLower: name.toLowerCase(),
        friendCode: code,
        xp: 0,
        loadout: sanitizeLoadout(local.loadout ?? DEFAULT_LOADOUT, 1),
        stats: { kills: 0, deaths: 0, assists: 0, damage: 0, headshots: 0, shots: 0, hits: 0, captures: 0, roundsWon: 0, wins: 0, losses: 0, matches: 0 },
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        lastClaim: '',
        lastClaimAt: serverTimestamp(),
      });
      b.set(doc(db, 'usernames', name.toLowerCase()), { uid: u.uid });
      b.set(doc(db, 'friendCodes', code), { uid: u.uid });
      try {
        await b.commit();
        return;
      } catch (e) {
        // permission-denied here means the name or code is taken: try another
        if ((e as { code?: string }).code !== 'permission-denied') throw e;
      }
    }
    throw new Error('Could not reserve a username. Try again later.');
  }

  async rename(name: string): Promise<void> {
    const u = this.user;
    if (!u) throw new Error('Not signed in');
    if (!NAME_RE.test(name)) throw new Error('Names are 3-16 letters, digits or _');
    const db = this.fb.db;
    const old = profile.value.username.toLowerCase();
    const lower = name.toLowerCase();
    const b = writeBatch(db);
    b.update(doc(db, 'users', u.uid), { username: name, usernameLower: lower, updatedAt: serverTimestamp() });
    if (lower !== old) {
      b.set(doc(db, 'usernames', lower), { uid: u.uid });
      b.delete(doc(db, 'usernames', old));
    }
    try {
      await b.commit();
    } catch (e) {
      if ((e as { code?: string }).code === 'permission-denied') throw new Error('That name is taken', { cause: e });
      throw e;
    }
  }

  /** Stores account-level preferences (the input mode follows the player between devices). */
  async savePrefs(prefs: { inputMode: 'mouse' | 'touchpad' }): Promise<void> {
    const u = this.user;
    if (!u) return;
    await updateDoc(doc(this.fb.db, 'users', u.uid), { prefs, updatedAt: serverTimestamp() });
  }

  async saveLoadout(l: Loadout): Promise<void> {
    const u = this.user;
    if (!u) return;
    await updateDoc(doc(this.fb.db, 'users', u.uid), { loadout: l, updatedAt: serverTimestamp() });
  }

  async signInWithGoogle(): Promise<void> {
    const auth = this.fb.auth;
    const provider = new GoogleAuthProvider();
    const cur = auth.currentUser;
    if (cur?.isAnonymous) {
      try {
        // keeps the guest's uid and progress
        await linkWithPopup(cur, provider);
        account.value = accountInfo(auth.currentUser!);
        return;
      } catch (e) {
        if ((e as { code?: string }).code !== 'auth/credential-already-in-use') throw e;
        const cred = GoogleAuthProvider.credentialFromError(e as never);
        if (!cred) throw e;
        pushToast({ title: 'SWITCHED ACCOUNT', body: 'That Google account already had a LOCKDOWN profile. Guest progress from this session stays with the guest.', kind: 'info' });
        await signInWithCredential(auth, cred);
        return;
      }
    }
    await signInWithPopup(auth, provider);
  }

  async signInWithEmail(email: string, password: string, create: boolean): Promise<void> {
    const auth = this.fb.auth;
    const cur = auth.currentUser;
    if (create) {
      if (cur?.isAnonymous) {
        await linkWithCredential(cur, EmailAuthProvider.credential(email, password));
        await cur.reload();
        account.value = accountInfo(auth.currentUser!);
      } else await createUserWithEmailAndPassword(auth, email, password);
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  }

  async signOut(): Promise<void> {
    await fbSignOut(this.fb.auth);
  }
}
