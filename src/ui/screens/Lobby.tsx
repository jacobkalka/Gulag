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
          <Button variant="primary" size="xl" disabled title="Online matchmaking needs Firebase (see SETUP.md)">
            FIND MATCH
          </Button>
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
        {(tab === 'loadout' || tab === 'social') && (
          <div class="tab-wrap">
            <Panel title={tab.toUpperCase()}>
              <p class="hint big">Coming online in the next milestone.</p>
            </Panel>
          </div>
        )}
      </main>
      <footer class="lobby-foot">
        <span>SUBLEVEL 9 · {PLAYLISTS[selectedPlaylist.value].name.toUpperCase()}</span>
        <span class="ver">BUILD {__BUILD__}</span>
      </footer>
    </div>
  );
}
