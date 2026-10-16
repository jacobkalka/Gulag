import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { GameController } from '@/app/GameController';
import { roomBusy, roomView, onlineRoomsAvailable, capacityOf } from '@/app/rooms';
import { pushToast } from '@/app/state';
import { PLAYLISTS, PLAYLIST_ORDER, type PlaylistId } from '@/data/playlists';
import type { RoomMember } from '@/net/protocol';
import { Button, Panel, Segmented, Toggle } from '../components';
import { MapPicker } from './MapPicker';

/** Create / join controls shown on the Play tab when not in a room. */
export function RoomEntry(props: { game: GameController }): JSX.Element {
  const [code, setCode] = useState('');
  const busy = roomBusy.value;
  const online = onlineRoomsAvailable();
  const join = () => void props.game.rooms.joinRoom(code);
  return (
    <div class="room-entry">
      <div class="room-entry-h">
        <span>PRIVATE ROOM</span>
        <span class={`mode-badge ${online ? 'online' : 'local'}`} title={online ? 'Rooms work across the internet' : 'Firebase is not configured: rooms connect browser tabs on this device only (see SETUP.md)'}>
          {online ? 'ONLINE' : 'LOCAL ONLY'}
        </span>
      </div>
      <div class="room-entry-row">
        <Button variant="secondary" size="lg" onClick={() => void props.game.rooms.createRoom()} disabled={!!busy} testid="create-room">
          CREATE ROOM
        </Button>
        <input
          class="code-input"
          data-testid="join-code"
          placeholder="ROOM CODE"
          maxLength={6}
          value={code}
          onInput={(e) => setCode((e.target as HTMLInputElement).value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && join()}
          spellcheck={false}
        />
        <Button variant="secondary" size="lg" onClick={join} disabled={!!busy || code.length < 6} testid="join-room">
          JOIN
        </Button>
      </div>
      {busy && <div class="room-busy">{busy}…</div>}
    </div>
  );
}

function MemberRow(props: { m: RoomMember; me: boolean; isHost: boolean; onMove: () => void; onKick: () => void }): JSX.Element {
  const m = props.m;
  return (
    <div class={`member ${props.me ? 'me' : ''}`} data-testid={`member-${m.name}`}>
      <span class="member-name">
        {m.host && <i class="crown" title="Host">♛</i>}
        {m.name}
      </span>
      <span class="member-lv">LV {m.level}</span>
      <span class="member-ping">{m.host ? 'HOST' : `${m.ping || '-'} MS`}</span>
      <span class={`member-ready ${m.ready ? 'on' : ''}`}>{m.ready ? 'READY' : 'NOT READY'}</span>
      {props.isHost && (
        <span class="member-actions">
          <button class="icon-b" title="Move to the other team" onClick={props.onMove}>
            ⇄
          </button>
          {!m.host && (
            <button class="icon-b danger" title="Remove from room" onClick={props.onKick}>
              ×
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/** The room lobby: teams, match settings, chat, start. */
export function RoomPanel(props: { game: GameController }): JSX.Element | null {
  const v = roomView.value;
  const [msg, setMsg] = useState('');
  const [ready, setReady] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [v?.chat.length]);
  if (!v) return null;
  const rooms = props.game.rooms;
  const room = v.room;
  const isHost = v.role === 'host';
  const size = PLAYLISTS[room.playlist].rules.teamSize;
  const teams: RoomMember[][] = [room.members.filter((m) => m.team === 0), room.members.filter((m) => m.team === 1)];
  const me = room.members.find((m) => m.pid === v.selfPid);
  const canStart = isHost && room.phase === 'lobby' && (room.fillBots || (teams[0].length > 0 && teams[1].length > 0));
  const copy = () => {
    void navigator.clipboard?.writeText(room.code).then(
      () => pushToast({ title: 'ROOM CODE COPIED', body: room.code, kind: 'success', ttl: 2000 }),
      () => {},
    );
  };
  const send = () => {
    if (!msg.trim()) return;
    rooms.chat(msg);
    setMsg('');
  };
  return (
    <div class="room" data-testid="room">
      <div class="room-main">
        <header class="room-h">
          <div>
            <div class="room-label">ROOM CODE</div>
            <div class="room-code" data-testid="room-code" onClick={copy} title="Click to copy">
              {room.code}
            </div>
          </div>
          <div class="room-meta">
            <span class={`mode-badge ${v.mode === 'online' ? 'online' : 'local'}`}>{v.mode === 'online' ? 'ONLINE' : 'LOCAL: THIS DEVICE'}</span>
            <span class="room-pl">
              {room.playlist.toUpperCase()} · {PLAYLISTS[room.playlist].name.toUpperCase()}
            </span>
            {room.phase === 'match' && <span class="room-live">MATCH IN PROGRESS</span>}
          </div>
        </header>
        <div class="teams">
          {[0, 1].map((t) => (
            <div class={`team team-${t}`} data-testid={`team-${t}`}>
              <div class="team-h">
                <span>{t === 0 ? 'TEAM A' : 'TEAM B'}</span>
                <span class="team-n">
                  {teams[t].length}/{size}
                </span>
              </div>
              {teams[t].map((m) => (
                <MemberRow m={m} me={m.pid === v.selfPid} isHost={isHost} onMove={() => rooms.setTeam(m.pid, t === 0 ? 1 : 0)} onKick={() => rooms.kick(m.pid)} />
              ))}
              {Array.from({ length: Math.max(0, size - teams[t].length) }, () => (
                <div class="member empty">{room.fillBots ? 'BOT' : 'OPEN SLOT'}</div>
              ))}
              {me && me.team !== t && room.phase === 'lobby' && teams[t].length < size && (
                <button class="join-team" onClick={() => rooms.setTeam(v.selfPid, t as 0 | 1)}>
                  JOIN {t === 0 ? 'TEAM A' : 'TEAM B'}
                </button>
              )}
            </div>
          ))}
        </div>
        <div class="room-actions">
          {isHost ? (
            <Button variant="primary" size="xl" disabled={!canStart} onClick={() => rooms.startMatch()} testid="start-match">
              START MATCH
            </Button>
          ) : (
            <Button
              variant={ready ? 'primary' : 'secondary'}
              size="xl"
              onClick={() => {
                rooms.setReady(!ready);
                setReady(!ready);
              }}
              testid="ready"
            >
              {ready ? 'READY ✓' : 'READY UP'}
            </Button>
          )}
          <Button variant="danger" size="lg" onClick={() => rooms.leaveRoom()} testid="leave-room">
            LEAVE ROOM
          </Button>
          {!isHost && room.phase === 'lobby' && <span class="hint">Waiting for the host to start…</span>}
        </div>
      </div>
      <div class="room-side">
        <Panel title="MATCH">
          <div class="field">
            <span class="field-l">MAP</span>
          </div>
          <MapPicker compact value={room.map} onChange={isHost ? (m) => rooms.setMap(m) : undefined} />
          {isHost ? (
            <Segmented<PlaylistId>
              label="PLAYLIST"
              value={room.playlist}
              options={PLAYLIST_ORDER.map((id) => ({ value: id, label: id.toUpperCase() }))}
              onChange={(id) => {
                if (room.members.length > capacityOf(id)) pushToast({ title: 'TOO MANY PLAYERS', body: `${PLAYLISTS[id].name} holds ${capacityOf(id)} players.`, kind: 'error' });
                else rooms.setPlaylist(id);
              }}
            />
          ) : (
            <div class="field">
              <span class="field-l">PLAYLIST</span>
              <b>{room.playlist.toUpperCase()}</b>
            </div>
          )}
          {isHost ? (
            <>
              <Toggle label="FILL EMPTY SLOTS WITH BOTS" value={room.fillBots} onChange={(b) => rooms.setFillBots(b)} />
              <Segmented
                label="BOT SKILL"
                value={room.difficulty}
                options={[
                  { value: 'recruit', label: 'RECRUIT' },
                  { value: 'regular', label: 'REGULAR' },
                  { value: 'veteran', label: 'VETERAN' },
                ]}
                onChange={(d) => rooms.setDifficulty(d)}
              />
            </>
          ) : (
            <div class="field">
              <span class="field-l">BOTS</span>
              <b>{room.fillBots ? room.difficulty.toUpperCase() : 'OFF'}</b>
            </div>
          )}
          <p class="hint">Share the code. The host's browser runs the match, so the host should have the best connection.</p>
        </Panel>
        <Panel title="CHAT" class="chat-panel">
          <div class="chat-lines" ref={chatRef} data-testid="chat-lines">
            {v.chat.map((l) => (
              <div class={`chat-line ${l.system ? 'sys' : ''}`}>
                {!l.system && <b>{l.name}: </b>}
                {l.text}
              </div>
            ))}
            {!v.chat.length && <div class="chat-line sys">Say hi.</div>}
          </div>
          <div class="chat-input">
            <input
              data-testid="chat-input"
              value={msg}
              maxLength={140}
              placeholder="Message"
              onInput={(e) => setMsg((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
            />
            <Button size="sm" onClick={send}>
              SEND
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}
