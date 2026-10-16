import type { JSX } from 'preact';
import { lobbyTab, profile, selectedMap, selectedPlaylist, type LobbyTab } from '@/app/state';
import { mapChoiceName } from '@/data/maps';
import { MapPicker } from './MapPicker';
import { settings, updateSettings } from '@/app/settings';
import type { GameController } from '@/app/GameController';
import { PLAYLISTS, PLAYLIST_ORDER } from '@/data/playlists';
import { levelForXp } from '@/data/progression';
import { Button, Panel, Segmented, Bar } from '../components';
import { SettingsPanel } from './SettingsPanel';
import { StatsTab } from './StatsTab';
import { screen } from '@/app/state';
import { roomView } from '@/app/rooms';
import { RoomEntry, RoomPanel } from './Room';
import { SocialTab } from './Social';
import { LoadoutTab } from './Loadout';
import { matchmaking, party, social, account } from '@/app/social';
import { useEffect, useState } from 'preact/hooks';

export function TopNav(): JSX.Element {
  const p = profile.value;
  const li = levelForXp(p.xp);
  const tabs: { id: LobbyTab; label: string }[] = [
    { id: 'play', label: 'PLAY' },
    { id: 'loadout', label: 'LOADOUT' },
    { id: 'social', label: 'SOCIAL' },
    { id: 'stats', label: 'STATS' },
    { id: 'settings', label: 'SETTINGS' },
  ];
  return (
    <header class="topnav">
      <div class="brand">
        LOCK<span>DOWN</span>
      </div>
      <nav>
        {tabs.map((t) => (
          <button class={`nav-b ${lobbyTab.value === t.id ? 'on' : ''}`} data-testid={`nav-${t.id}`} onClick={() => (lobbyTab.value = t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      {party.value && (
        <div class="nav-party" title="Your party">
          PARTY <b>{party.value.members.length}/4</b>
        </div>
      )}
      <div class="nav-me">
        <div class="nav-me-name">{p.username}</div>
        <div class="nav-me-lv">
          <span class="lv">LV {li.level}</span>
          <Bar value={li.progress} class="xp" />
        </div>
      </div>
    </header>
  );
}

export function PlayTab(props: { game: GameController }): JSX.Element {
  if (roomView.value) return <RoomPanel game={props.game} />;
  const pl = selectedPlaylist.value;
  const diff = settings.value.botDifficulty;
  const p = profile.value;
  const pv = party.value;
  const me = account.value?.uid;
  const leader = !!pv && pv.leader === me;
  const member = !!pv && pv.leader !== me;
  const start = () => {
    props.game.startBotMatch(pl, diff, p.loadout, p.username);
    screen.value = 'match';
  };
  return (
    <div class="play">
      <div class="play-left">
        <Panel title="OPERATOR" class="op-panel">
          <div class="op-name">{p.username}</div>
          <div class="op-sub">
            {p.guest ? 'GUEST · progress saved on this device' : 'SIGNED IN'}
          </div>
          <div class="op-loadout">
            <div>
              <small>PRIMARY</small>
              <b>{p.loadout.primary.toUpperCase()}</b>
            </div>
            <div>
              <small>SECONDARY</small>
              <b>{p.loadout.secondary.toUpperCase()}</b>
            </div>
          </div>
        </Panel>
      </div>
      <div class="play-right">
        <MapPicker
          value={selectedMap.value}
          onChange={(m) => {
            selectedMap.value = m;
            if (leader) void social.value?.setPartyMap(m);
          }}
        />
        {member && pv && (
          <div class="party-pick" data-testid="party-pick">
            YOUR PARTY PLAYS THE LEADER'S PICK: <b>{mapChoiceName(pv.map).toUpperCase()}</b> · <b>{pv.playlist.toUpperCase()}</b>
          </div>
        )}
        <div class="playlists">
          {PLAYLIST_ORDER.map((id) => {
            const p2 = PLAYLISTS[id];
            return (
              <button
                class={`pl-card ${pl === id ? 'on' : ''}`}
                data-testid={`playlist-${id}`}
                onClick={() => {
                  selectedPlaylist.value = id;
                  if (leader) void social.value?.setPartyPlaylist(id);
                }}
              >
                <div class="pl-id">{id.toUpperCase()}</div>
                <div class="pl-name">{p2.name.toUpperCase()}</div>
                <div class="pl-desc">{p2.description}</div>
              </button>
            );
          })}
        </div>
        <div class="play-actions">
          <FindMatch />
          <div class="play-row">
            <Button variant="secondary" size="lg" onClick={start} testid="practice">
              PRACTICE VS BOTS
            </Button>
            <Segmented
              value={diff}
              options={[
                { value: 'recruit', label: 'RECRUIT' },
                { value: 'regular', label: 'REGULAR' },
                { value: 'veteran', label: 'VETERAN' },
              ]}
              onChange={(v) => updateSettings({ botDifficulty: v })}
            />
          </div>
          <RoomEntry game={props.game} />
        </div>
      </div>
    </div>
  );
}

/** Keeps the 3D lobby lineup in sync (you + party members) and draws their name tags. */
function Operators(props: { game: GameController; visible: boolean }): JSX.Element {
  const p = profile.value;
  const pv = party.value;
  const me = account.value?.uid ?? 'me';
  const list = [{ key: me, name: p.username, level: levelForXp(p.xp).level, weapon: p.loadout.primary }];
  for (const m of pv?.members ?? []) if (m.uid !== me) list.push({ key: m.uid, name: m.name, level: m.level ?? 1, weapon: m.primary ?? 'halberd' });
  const sig = list.map((o) => `${o.key}:${o.weapon}`).join('|');
  useEffect(() => props.game.setOperators(list.map((o) => ({ key: o.key, weapon: o.weapon }))), [sig]);
  useEffect(() => props.game.setOperatorsVisible(props.visible), [props.visible]);
  useEffect(() => () => props.game.setOperatorsVisible(false), []);
  const [tags, setTags] = useState<{ key: string; x: number; y: number }[]>([]);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const t = props.game.operatorTags();
      setTags((prev) => (prev.length === t.length && prev.every((a, i) => Math.abs(a.x - t[i].x) < 0.5 && Math.abs(a.y - t[i].y) < 0.5) ? prev : t));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  if (!props.visible) return <></>;
  return (
    <div class="op-tags">
      {tags.map((t) => {
        const o = list.find((x) => x.key === t.key);
        if (!o) return null;
        return (
          <div class={`op-tag ${o.key === me ? 'me' : ''}`} style={{ left: `${t.x}px`, top: `${t.y}px` }}>
            <b>{o.name}</b>
            <span>LV {o.level}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Lobby(props: { game: GameController }): JSX.Element {
  const tab = lobbyTab.value;
  return (
    <div class="lobby">
      <Operators game={props.game} visible={(tab === 'play' && !roomView.value) || tab === 'social'} />
      <TopNav />
      <main class="lobby-main">
        {tab === 'play' && <PlayTab game={props.game} />}
        {tab === 'settings' && (
          <div class="tab-wrap">
            <SettingsPanel game={props.game} />
          </div>
        )}
        {tab === 'stats' && <StatsTab />}
        {tab === 'social' && <SocialTab />}
        {tab === 'loadout' && <LoadoutTab game={props.game} onChange={() => props.game.rooms.syncLoadout()} />}
      </main>
      <footer class="lobby-foot">
        <span>
          {mapChoiceName(selectedMap.value).toUpperCase()} · {PLAYLISTS[selectedPlaylist.value].name.toUpperCase()}
        </span>
        <span class="ver">BUILD {__BUILD__}</span>
      </footer>
    </div>
  );
}

/** FIND MATCH button, or the live search status while queued. */
function FindMatch(): JSX.Element {
  const api = social.value;
  const mm = matchmaking.value;
  const pv = party.value;
  const me = account.value?.uid;
  const [, tick] = useState(0);
  useEffect(() => {
    if (mm.state === 'idle') return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [mm.state]);
  if (mm.state !== 'idle') {
    const secs = Math.floor((Date.now() - mm.since) / 1000);
    return (
      <div class="mm-status" data-testid="mm-status">
        <div>
          <div class="mm-t">{mm.state === 'found' ? 'MATCH FOUND' : 'SEARCHING'}</div>
          <div class="mm-s">
            {mm.playlist.toUpperCase()} · {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')} · {mm.queued}/{mm.needed} IN QUEUE
          </div>
        </div>
        {mm.state === 'searching' && (
          <Button variant="ghost" onClick={() => void api?.cancelMatchmaking()} testid="cancel-mm">
            CANCEL
          </Button>
        )}
      </div>
    );
  }
  const follower = !!pv && pv.leader !== me;
  return (
    <Button
      variant="primary"
      size="xl"
      disabled={!api || follower}
      title={!api ? 'Online matchmaking needs Firebase (see SETUP.md)' : follower ? 'The party leader starts matchmaking' : ''}
      onClick={() => void api?.findMatch(selectedPlaylist.value)}
      testid="find-match"
    >
      {follower ? 'LEADER QUEUES' : 'FIND MATCH'}
    </Button>
  );
}
