import { effect } from '@preact/signals';
import type { GameController } from '@/app/GameController';
import { setOnlineSignaling, roomView } from '@/app/rooms';
import { backendError, backendState, matchmaking, social, type PresenceState } from '@/app/social';
import { profile, pushToast, screen } from '@/app/state';
import { setProfilePersistence } from '@/app/progressionService';
import { getFirebase } from './firebase';
import { AccountService } from './account';
import { PresenceService } from './presence';
import { FriendsService } from './friends';
import { PartyService } from './party';
import { FirebaseSignaling } from './firebaseSignaling';
import { Matchmaker, matchmakingError } from './matchmaking';
import { claimMatchXp, installMatchRecorder } from './matches';
import { setLoadoutSaver, setPrefsSaver } from '@/app/state';
import { inputModePatch, settings, updateSettings } from '@/app/settings';

/**
 * Connects to Firebase when configured (see SETUP.md). Without configuration the game stays
 * fully playable offline: guest profile in localStorage, practice vs bots, and private rooms
 * between tabs on the same device.
 */
export async function initBackend(game: GameController): Promise<void> {
  let fb;
  try {
    fb = getFirebase();
  } catch (e) {
    backendState.value = 'error';
    backendError.value = String((e as Error).message ?? e);
    console.warn('Firebase init failed', e);
    return;
  }
  if (!fb) {
    backendState.value = 'offline';
    return;
  }
  const firebase = fb;
  backendState.value = 'connecting';
  const account = new AccountService(firebase);

  installMatchRecorder(game, firebase);
  setProfilePersistence(async (_p, _award, summary) => (summary.matchId ? claimMatchXp(firebase, summary.matchId) : null), true);
  setLoadoutSaver((l) => account.saveLoadout(l));
  setPrefsSaver((p) => account.savePrefs(p));
  account.onPrefs = (mode) => {
    // a fresh device adopts the input mode saved with the account
    const st = settings.value;
    if (mode && !st.seenInputHint && st.inputMode !== mode) {
      updateSettings(inputModePatch(mode));
      game.applyInputSettings();
    }
  };

  let stopUser: (() => void) | null = null;
  let presence: PresenceService | null = null;

  account.onUser = (u) => {
    stopUser?.();
    presence = new PresenceService(firebase);
    presence.start(u.uid, profile.value.username);
    const friendsSvc = new FriendsService(firebase, u.uid);
    friendsSvc.start();
    const partySvc = new PartyService(firebase, u.uid);
    partySvc.start();
    const signaling = new FirebaseSignaling(firebase, u.uid);
    setOnlineSignaling(() => signaling);
    const mm = new Matchmaker(firebase, u.uid, game.rooms, { isLeader: () => partySvc.isLeader, setRoom: (c, st) => partySvc.setRoom(c, st) });
    const pres = presence;

    // party members follow the leader into rooms
    partySvc.onRoomCode = (code) => {
      const cur = roomView.value;
      if (cur?.room.code === code) return;
      if (game.inMatch) return; // finish the current match first
      if (cur) game.rooms.leaveRoom();
      void game.rooms.joinRoom(code, { auto: true });
    };
    partySvc.onPartyChange = (pid) => pres.set(presenceFor(), { party: pid ?? '' });
    game.rooms.onHostedRoom = (code) => {
      if (partySvc.isLeader) void partySvc.setRoom(code).catch(() => {});
    };

    const fail = (title: string) => (e: unknown) => {
      pushToast({ title, body: (e as Error).message ?? String(e), kind: 'error' });
      throw e;
    };
    social.value = {
      signInWithGoogle: () => account.signInWithGoogle().catch(fail('SIGN-IN FAILED')),
      signInWithEmail: (e, p, c) => account.signInWithEmail(e, p, c).catch(fail(c ? 'COULD NOT CREATE ACCOUNT' : 'SIGN-IN FAILED')),
      signOut: () => account.signOut(),
      rename: (n) => account.rename(n).catch(fail('RENAME FAILED')),
      addFriend: async (s) => {
        try {
          const msg = await friendsSvc.add(s);
          pushToast({ title: msg.toUpperCase(), kind: 'success' });
        } catch (e) {
          fail('FRIEND REQUEST')(e);
        }
      },
      acceptFriend: (pair) => friendsSvc.accept(pair).catch(fail('FRIENDS')),
      removeFriend: (pair) => friendsSvc.remove(pair).catch(fail('FRIENDS')),
      createParty: () => partySvc.create().catch(fail('PARTY')) as Promise<string>,
      invite: async (uid) => {
        await partySvc.invite(uid).catch(fail('INVITE FAILED'));
        pushToast({ title: 'INVITE SENT', kind: 'success', ttl: 2000 });
      },
      joinParty: (pid) => partySvc.join(pid).catch(fail('PARTY')),
      leaveParty: () => partySvc.leave().catch(fail('PARTY')),
      kickFromParty: (uid) => partySvc.kick(uid).catch(fail('PARTY')),
      sendPartyChat: (t) => partySvc.chat(t).catch(fail('CHAT')),
      setPartyPlaylist: (id) => partySvc.setPlaylist(id).catch(fail('PARTY')),
      findMatch: (pl) =>
        mm.find(pl).catch((e) => {
          matchmakingError(e);
        }),
      cancelMatchmaking: () => mm.cancel(),
    };
    backendState.value = 'online';
    stopUser = () => {
      mm.stop();
      partySvc.stop();
      friendsSvc.stop();
      pres.stop();
      signaling.shutdown();
      setOnlineSignaling(null);
      social.value = null;
    };
  };

  function presenceFor(): PresenceState {
    if (screen.value === 'match') return 'match';
    if (matchmaking.value.state === 'searching') return 'queue';
    if (roomView.value) return 'room';
    return 'lobby';
  }

  // presence follows what the player is doing
  effect(() => {
    void screen.value;
    void roomView.value;
    void matchmaking.value.state;
    const name = profile.value.username;
    presence?.set(presenceFor(), { name });
  });

  account.start();
  await Promise.race([account.ready, new Promise((r) => setTimeout(r, 15000))]);
  if (backendState.value === 'connecting') {
    backendState.value = 'error';
    backendError.value = 'Timed out connecting to the account service';
  }
}
