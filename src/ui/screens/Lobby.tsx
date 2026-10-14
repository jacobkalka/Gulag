import type { JSX } from 'preact';
import { lobbyTab, profile, selectedPlaylist, type LobbyTab } from '@/app/state';
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
        <div class="playlists">
          {PLAYLIST_ORDER.map((id) => {
            const p2 = PLAYLISTS[id];
            return (
              <button class={`pl-card ${pl === id ? 'on' : ''}`} data-testid={`playlist-${id}`} onClick={() => (selectedPlaylist.value = id)}>
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

export function Lobby(props: { game: GameController }): JSX.Element {
  const tab = lobbyTab.value;
  return (
    <div class="lobby">
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
        <span>SUBLEVEL 9 · {PLAYLISTS[selectedPlaylist.value].name.toUpperCase()}</span>
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
