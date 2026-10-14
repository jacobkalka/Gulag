import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { account, backendError, backendState, friends, party, partyChat, social, type FriendView, type PresenceState } from '@/app/social';
import { profile, pushToast, saveLocalProfile } from '@/app/state';
import { levelForXp } from '@/data/progression';
import { Button, Panel } from '../components';

const PRESENCE_LABEL: Record<PresenceState, string> = {
  online: 'ONLINE',
  lobby: 'IN LOBBY',
  room: 'IN A ROOM',
  queue: 'SEARCHING',
  match: 'IN MATCH',
  offline: 'OFFLINE',
};

function Dot(props: { state: PresenceState }): JSX.Element {
  return <i class={`pdot p-${props.state}`} />;
}

function AccountPanel(): JSX.Element {
  const p = profile.value;
  const acc = account.value;
  const api = social.value;
  const [name, setName] = useState(p.username);
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(p.username), [p.username]);
  const online = !!api && !!acc;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // errors are surfaced as toasts by the backend
    } finally {
      setBusy(false);
    }
  };
  const rename = () => {
    const n = name.trim();
    if (n === p.username) return;
    if (online)
      void run(async () => {
        await api!.rename(n);
        pushToast({ title: 'NAME CHANGED', body: n, kind: 'success' });
      });
    else if (/^[A-Za-z0-9_]{3,16}$/.test(n)) saveLocalProfile({ ...p, username: n });
    else pushToast({ title: 'INVALID NAME', body: '3-16 letters, digits or _', kind: 'error' });
  };
  return (
    <Panel title="ACCOUNT">
      <div class="acct-name">
        <input class="text-in" value={name} maxLength={16} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && rename()} data-testid="name-input" />
        <Button size="sm" onClick={rename} disabled={busy || name.trim() === p.username} testid="rename">
          RENAME
        </Button>
      </div>
      <div class="field">
        <span class="field-l">LEVEL</span>
        <b>{levelForXp(p.xp).level}</b>
      </div>
      <div class="field">
        <span class="field-l">FRIEND CODE</span>
        <b
          class="friend-code"
          data-testid="friend-code"
          title="Click to copy"
          onClick={() => void navigator.clipboard?.writeText(p.friendCode).then(() => pushToast({ title: 'FRIEND CODE COPIED', kind: 'success', ttl: 1500 }))}
        >
          {online ? p.friendCode : '-'}
        </b>
      </div>
      <div class="field">
        <span class="field-l">STATUS</span>
        <b data-testid="account-status">
          {!online ? (backendState.value === 'connecting' ? 'CONNECTING…' : 'OFFLINE GUEST') : acc!.anonymous ? 'GUEST (CLOUD SAVE)' : acc!.provider === 'google' ? 'GOOGLE' : (acc!.email ?? 'EMAIL')}
        </b>
      </div>
      {!online && (
        <p class="hint">
          {backendState.value === 'error'
            ? `Online services unavailable: ${backendError.value}`
            : 'Online features (accounts, friends, parties, matchmaking) turn on once Firebase is configured. See SETUP.md.'}
        </p>
      )}
      {online && acc!.anonymous && (
        <>
          <p class="hint">You are playing as a guest. Link an account to keep your progress on any device.</p>
          <Button variant="primary" onClick={() => void run(() => api!.signInWithGoogle())} disabled={busy} testid="google">
            CONTINUE WITH GOOGLE
          </Button>
          <div class="email-form">
            <input class="text-in" type="email" placeholder="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} data-testid="email" />
            <input class="text-in" type="password" placeholder="password (6+)" value={pass} onInput={(e) => setPass((e.target as HTMLInputElement).value)} data-testid="password" />
            <div class="row">
              <Button size="sm" onClick={() => void run(() => api!.signInWithEmail(email, pass, true))} disabled={busy || !email || pass.length < 6} testid="email-create">
                CREATE ACCOUNT
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void run(() => api!.signInWithEmail(email, pass, false))} disabled={busy || !email || pass.length < 6} testid="email-signin">
                SIGN IN
              </Button>
            </div>
            <p class="hint small">Signing in to an existing account switches to that profile; this guest's progress stays with the guest.</p>
          </div>
        </>
      )}
      {online && !acc!.anonymous && (
        <Button variant="ghost" onClick={() => void run(() => api!.signOut())} disabled={busy} testid="sign-out">
          SIGN OUT
        </Button>
      )}
    </Panel>
  );
}

function FriendRow(props: { f: FriendView; inParty: boolean }): JSX.Element {
  const f = props.f;
  const api = social.value!;
  return (
    <div class={`friend ${f.status}`} data-testid={`friend-${f.name}`}>
      <Dot state={f.status === 'friend' ? f.presence : 'offline'} />
      <div class="friend-main">
        <div class="friend-name">
          {f.name} <span class="friend-lv">LV {f.level}</span>
        </div>
        <div class="friend-sub">{f.status === 'incoming' ? 'WANTS TO BE FRIENDS' : f.status === 'outgoing' ? 'REQUEST SENT' : PRESENCE_LABEL[f.presence]}</div>
      </div>
      <div class="friend-actions">
        {f.status === 'incoming' && (
          <>
            <Button size="sm" variant="primary" onClick={() => void api.acceptFriend(f.pair)} testid={`accept-${f.name}`}>
              ACCEPT
            </Button>
            <button class="icon-b danger" title="Decline" onClick={() => void api.removeFriend(f.pair)}>
              ×
            </button>
          </>
        )}
        {f.status === 'friend' && (
          <>
            {f.presence !== 'offline' && !props.inParty && (
              <Button size="sm" onClick={() => void api.invite(f.uid)} testid={`invite-${f.name}`}>
                INVITE
              </Button>
            )}
            <button class="icon-b danger" title="Remove friend" onClick={() => void api.removeFriend(f.pair)}>
              ×
            </button>
          </>
        )}
        {f.status === 'outgoing' && (
          <button class="icon-b danger" title="Cancel request" onClick={() => void api.removeFriend(f.pair)}>
            ×
          </button>
        )}
      </div>
    </div>
  );
}

function FriendsPanel(): JSX.Element {
  const api = social.value;
  const [q, setQ] = useState('');
  const list = friends.value;
  const pv = party.value;
  const add = () => {
    if (!api || !q.trim()) return;
    void api.addFriend(q.trim()).then(() => setQ(''), () => {});
  };
  return (
    <Panel title="FRIENDS" right={<span class="hint">{list.filter((f) => f.status === 'friend' && f.presence !== 'offline').length} ONLINE</span>}>
      <div class="add-friend">
        <input class="text-in" placeholder="FRIEND CODE OR NAME" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && add()} disabled={!api} data-testid="add-friend-input" />
        <Button size="sm" onClick={add} disabled={!api || !q.trim()} testid="add-friend">
          ADD
        </Button>
      </div>
      <div class="friend-list">
        {list.map((f) => (
          <FriendRow f={f} inParty={!!pv?.members.some((m) => m.uid === f.uid)} />
        ))}
        {!list.length && <p class="hint">{api ? 'No friends yet. Share your friend code.' : 'Sign-in is not available offline.'}</p>}
      </div>
    </Panel>
  );
}

function PartyPanel(): JSX.Element {
  const api = social.value;
  const pv = party.value;
  const me = account.value?.uid;
  const [msg, setMsg] = useState('');
  const chatRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [partyChat.value.length]);
  if (!api) {
    return (
      <Panel title="PARTY">
        <p class="hint">Parties need online services.</p>
      </Panel>
    );
  }
  if (!pv) {
    return (
      <Panel title="PARTY">
        <p class="hint">Team up with friends: invite them from your friends list, then queue or open a room together.</p>
        <Button onClick={() => void api.createParty()} testid="create-party">
          START A PARTY
        </Button>
      </Panel>
    );
  }
  const leader = pv.leader === me;
  const send = () => {
    if (!msg.trim()) return;
    void api.sendPartyChat(msg);
    setMsg('');
  };
  return (
    <Panel title={`PARTY · ${pv.members.length}/4`} right={<span class="hint">{pv.state === 'queue' ? 'SEARCHING' : pv.state === 'room' ? `ROOM ${pv.room ?? ''}` : 'IDLE'}</span>}>
      <div class="party-members" data-testid="party-members">
        {pv.members.map((m) => (
          <div class={`member ${m.uid === me ? 'me' : ''}`}>
            <span class="member-name">
              {m.uid === pv.leader && <i class="crown">♛</i>}
              {m.name}
            </span>
            <span class="member-ping">
              <Dot state={m.presence} /> {PRESENCE_LABEL[m.presence]}
            </span>
            <span />
            <span />
            {leader && m.uid !== me ? (
              <button class="icon-b danger" title="Remove from party" onClick={() => void api.kickFromParty(m.uid)}>
                ×
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
      <div class="chat-lines short" ref={chatRef}>
        {partyChat.value.map((l) => (
          <div class="chat-line">
            <b>{l.name}: </b>
            {l.text}
          </div>
        ))}
        {!partyChat.value.length && <div class="chat-line sys">Party chat</div>}
      </div>
      <div class="chat-input">
        <input value={msg} maxLength={140} placeholder="Message party" onInput={(e) => setMsg((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && send()} data-testid="party-chat-input" />
        <Button size="sm" onClick={send}>
          SEND
        </Button>
      </div>
      <Button variant="danger" size="sm" onClick={() => void api.leaveParty()} testid="leave-party">
        LEAVE PARTY
      </Button>
      {!leader && <p class="hint small">The party leader picks the playlist, queues and opens rooms. You follow automatically.</p>}
    </Panel>
  );
}

export function SocialTab(): JSX.Element {
  return (
    <div class="social" data-testid="social">
      <AccountPanel />
      <FriendsPanel />
      <PartyPanel />
    </div>
  );
}
