import { settings, teamColors } from '@/app/settings';
import { WEAPON_MAP } from '@/data/weapons';
import type { PlayerState, RoundState } from '@/game/sim/types';

// In-match HUD as a lightweight imperative DOM overlay (no framework re-renders at 60 Hz).

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
}

function setText(e: HTMLElement, v: string): void {
  if (e.textContent !== v) e.textContent = v;
}

export interface RosterEntry {
  id: number;
  name: string;
  hp: number;
  alive: boolean;
  local: boolean;
}

export interface ScoreRow {
  id: number;
  name: string;
  team: 0 | 1;
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  alive: boolean;
  local: boolean;
  bot: boolean;
  ping?: number;
}

const FIRE_MODE: Record<string, string> = { auto: 'AUTO', semi: 'SEMI', burst: 'BURST', pump: 'PUMP', bolt: 'BOLT' };

export class Hud {
  readonly root: HTMLDivElement;
  private cross: HTMLDivElement;
  private crossLines: HTMLDivElement[] = [];
  private crossDot: HTMLDivElement;
  private hit: HTMLDivElement;
  private hitT = 0;
  private dmgRing: HTMLDivElement;
  private hpFill: HTMLDivElement;
  private hpText: HTMLDivElement;
  private hpBox: HTMLDivElement;
  private ammoMag: HTMLDivElement;
  private ammoRes: HTMLDivElement;
  private weaponName: HTMLDivElement;
  private fireMode: HTMLDivElement;
  private equip: HTMLDivElement;
  private reloadBar: HTMLDivElement;
  private reloadFill: HTMLDivElement;
  private prompt: HTMLDivElement;
  private scoreA: HTMLDivElement;
  private scoreB: HTMLDivElement;
  private pipsA: HTMLDivElement;
  private pipsB: HTMLDivElement;
  private timer: HTMLDivElement;
  private aliveA: HTMLDivElement;
  private aliveB: HTMLDivElement;
  private objective: HTMLDivElement;
  private objFill: HTMLDivElement;
  private objText: HTMLDivElement;
  private feed: HTMLDivElement;
  private banner: HTMLDivElement;
  private bannerT = 0;
  private roster: HTMLDivElement;
  private spectate: HTMLDivElement;
  private scoreboard: HTMLDivElement;
  private nums: HTMLDivElement;
  private scope: HTMLDivElement;
  private perf: HTMLDivElement;
  private conn: HTMLDivElement;
  private markers: HTMLDivElement;
  private captions: HTMLDivElement;
  private captionSeen = new Map<string, number>();
  private lowerHud: HTMLElement[] = [];
  private lastPips = '';
  localTeam: 0 | 1 = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud', parent);
    this.root.style.setProperty('--hud-scale', String(settings.value.hudScale));
    // crosshair
    this.cross = el('div', 'hud-cross', this.root);
    for (let i = 0; i < 4; i++) this.crossLines.push(el('div', `hud-cross-line l${i}`, this.cross));
    this.crossDot = el('div', 'hud-cross-dot', this.cross);
    this.hit = el('div', 'hud-hit', this.root, '<i></i><i></i><i></i><i></i>');
    this.dmgRing = el('div', 'hud-dmg-ring', this.root);
    this.markers = el('div', 'hud-markers', this.root);
    this.captions = el('div', 'hud-captions', this.root);
    this.nums = el('div', 'hud-nums', this.root);
    this.scope = el('div', 'hud-scope', this.root, '<div class="hud-scope-reticle"></div>');
    // health
    this.hpBox = el('div', 'hud-hp', this.root);
    el('div', 'hud-hp-label', this.hpBox, 'VITALS');
    const bar = el('div', 'hud-hp-bar', this.hpBox);
    this.hpFill = el('div', 'hud-hp-fill', bar);
    this.hpText = el('div', 'hud-hp-text', this.hpBox);
    // ammo
    const ammo = el('div', 'hud-ammo', this.root);
    this.weaponName = el('div', 'hud-weapon', ammo);
    const row = el('div', 'hud-ammo-row', ammo);
    this.ammoMag = el('div', 'hud-mag', row);
    this.ammoRes = el('div', 'hud-res', row);
    this.fireMode = el('div', 'hud-firemode', ammo);
    this.equip = el('div', 'hud-equip', ammo);
    this.reloadBar = el('div', 'hud-reload', this.root);
    this.reloadFill = el('div', 'hud-reload-fill', this.reloadBar);
    el('div', 'hud-reload-label', this.reloadBar, 'RELOADING');
    this.prompt = el('div', 'hud-prompt', this.root);
    // round header
    const top = el('div', 'hud-top', this.root);
    const sa = el('div', 'hud-team a', top);
    this.aliveA = el('div', 'hud-alive', sa);
    this.scoreA = el('div', 'hud-score', sa);
    this.pipsA = el('div', 'hud-pips', sa);
    const mid = el('div', 'hud-mid', top);
    this.timer = el('div', 'hud-timer', mid);
    const sb = el('div', 'hud-team b', top);
    this.scoreB = el('div', 'hud-score', sb);
    this.pipsB = el('div', 'hud-pips', sb);
    this.aliveB = el('div', 'hud-alive', sb);
    this.objective = el('div', 'hud-objective', this.root);
    this.objText = el('div', 'hud-obj-text', this.objective);
    const ob = el('div', 'hud-obj-bar', this.objective);
    this.objFill = el('div', 'hud-obj-fill', ob);
    this.feed = el('div', 'hud-feed', this.root);
    this.banner = el('div', 'hud-banner', this.root);
    this.roster = el('div', 'hud-roster', this.root);
    this.spectate = el('div', 'hud-spectate', this.root);
    this.scoreboard = el('div', 'hud-scoreboard', this.root);
    this.perf = el('div', 'hud-perf', this.root);
    this.conn = el('div', 'hud-conn', this.root);
    this.lowerHud = [this.hpBox, ammo, this.reloadBar, this.prompt];
    this.applyColors();
  }

  /** Hide personal HUD elements (health, ammo, crosshair) while dead/spectating. */
  setAliveHud(alive: boolean): void {
    for (const e of this.lowerHud) e.style.visibility = alive ? 'visible' : 'hidden';
    if (!alive) this.cross.style.opacity = '0';
  }

  applyColors(): void {
    const c = teamColors(settings.value.colorblind);
    this.root.style.setProperty('--friendly', c.friendly);
    this.root.style.setProperty('--enemy', c.enemy);
    this.root.style.setProperty('--xh', settings.value.crosshairColor);
    this.root.style.setProperty('--hud-scale', String(settings.value.hudScale));
  }

  dispose(): void {
    this.root.remove();
  }

  /** spreadPx: half-gap in pixels from the weapon's current cone. */
  setCrosshair(spreadPx: number, visible: boolean): void {
    const s = settings.value;
    const gap = s.crosshairDynamic ? s.crosshairGap + spreadPx : s.crosshairGap;
    this.cross.style.opacity = visible ? '1' : '0';
    const size = s.crosshairSize;
    const th = s.crosshairThickness;
    const style = s.crosshairStyle;
    this.cross.dataset.style = style;
    this.crossDot.style.display = s.crosshairDot || style === 'dot' ? 'block' : 'none';
    this.crossDot.style.width = this.crossDot.style.height = `${Math.max(2, th + 1)}px`;
    if (style === 'cross' || style === 'chevron') {
      const pos = [
        [0, -gap - size, th, size],
        [0, gap, th, size],
        [-gap - size, 0, size, th],
        [gap, 0, size, th],
      ];
      this.crossLines.forEach((l, i) => {
        l.style.display = style === 'chevron' && i === 0 ? 'none' : 'block';
        const [x, y, w, h] = pos[i];
        l.style.transform = `translate(${x - (i < 2 ? th / 2 : 0)}px, ${y - (i >= 2 ? th / 2 : 0)}px)`;
        l.style.width = `${w}px`;
        l.style.height = `${h}px`;
      });
      this.cross.style.setProperty('--ring', '0px');
    } else if (style === 'circle') {
      this.crossLines.forEach((l) => (l.style.display = 'none'));
      this.cross.style.setProperty('--ring', `${Math.max(6, gap + 4)}px`);
    } else {
      this.crossLines.forEach((l) => (l.style.display = 'none'));
      this.cross.style.setProperty('--ring', '0px');
    }
  }

  hitmarker(kind: 'body' | 'head' | 'kill'): void {
    this.hit.className = `hud-hit show ${kind}`;
    void this.hit.offsetWidth;
    this.hitT = kind === 'kill' ? 0.35 : 0.18;
  }

  /** Direction (radians, 0 = in front, + = to the right) a hit came from. */
  damageIndicator(angle: number): void {
    const d = el('div', 'hud-dmg-arc', this.dmgRing);
    d.style.transform = `rotate(${angle}rad)`;
    setTimeout(() => d.remove(), 1600);
  }

  damageNumber(x: number, y: number, amount: number, head: boolean): void {
    if (!settings.value.damageNumbers) return;
    const n = el('div', `hud-num${head ? ' head' : ''}`, this.nums, String(amount));
    n.style.left = `${x}px`;
    n.style.top = `${y}px`;
    setTimeout(() => n.remove(), 900);
  }

  setHealth(hp: number): void {
    const v = Math.max(0, Math.round(hp));
    this.hpFill.style.width = `${v}%`;
    setText(this.hpText, String(v));
    this.hpBox.classList.toggle('low', v < 35);
  }

  setAmmo(p: PlayerState): void {
    const wr = p.weapons[p.slot];
    const w = WEAPON_MAP[wr.id];
    setText(this.weaponName, w ? w.name.toUpperCase() : '');
    setText(this.ammoMag, String(wr.mag));
    setText(this.ammoRes, `/ ${wr.reserve}`);
    setText(this.fireMode, w ? FIRE_MODE[w.fireMode] ?? '' : '');
    this.ammoMag.classList.toggle('low', !!w && wr.mag <= Math.max(1, Math.floor(w.magSize * 0.25)));
    const eq = `${p.loadout.lethal === 'frag' ? `<span class="${p.lethals ? '' : 'used'}">FRAG ×${p.lethals}</span>` : ''}${p.loadout.tactical === 'flash' ? `<span class="${p.tacticals ? '' : 'used'}">FLASH ×${p.tacticals}</span>` : ''}`;
    if (this.equip.innerHTML !== eq) this.equip.innerHTML = eq;
    const reloading = p.reloadT > 0 && p.reloadKind !== 2;
    this.reloadBar.style.opacity = reloading ? '1' : '0';
    if (reloading) this.reloadFill.style.width = `${(1 - p.reloadT / Math.max(0.01, p.reloadTotal)) * 100}%`;
    const low = w && wr.mag <= Math.floor(w.magSize * 0.25) && wr.reserve > 0 && !reloading;
    const empty = wr.mag === 0 && wr.reserve === 0;
    this.setPrompt(empty ? 'NO AMMO — SWAP WEAPON [Q]' : low ? 'RELOAD [R]' : '');
  }

  setPrompt(text: string): void {
    setText(this.prompt, text);
    this.prompt.style.opacity = text ? '1' : '0';
  }

  setRound(r: RoundState, rules: { roundsToWin: number }, alive: [number, number], teamSize: number): void {
    const my = this.localTeam;
    const en = my === 0 ? 1 : 0;
    setText(this.scoreA, String(r.score[my]));
    setText(this.scoreB, String(r.score[en]));
    const pipKey = `${r.score[my]}|${r.score[en]}|${rules.roundsToWin}`;
    if (pipKey !== this.lastPips) {
      this.lastPips = pipKey;
      this.pipsA.innerHTML = Array.from({ length: rules.roundsToWin }, (_, i) => `<i class="${i < r.score[my] ? 'on' : ''}"></i>`).join('');
      this.pipsB.innerHTML = Array.from({ length: rules.roundsToWin }, (_, i) => `<i class="${i < r.score[en] ? 'on' : ''}"></i>`).join('');
    }
    const icons = (n: number, total: number) => Array.from({ length: total }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
    const ka = icons(alive[my], teamSize);
    const kb = icons(alive[en], teamSize);
    if (this.aliveA.innerHTML !== ka) this.aliveA.innerHTML = ka;
    if (this.aliveB.innerHTML !== kb) this.aliveB.innerHTML = kb;
    let t = '';
    if (r.phase === 'countdown') t = `${Math.ceil(r.timer)}`;
    else if (r.phase === 'live') {
      const s = Math.max(0, Math.ceil(r.timer));
      t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    } else if (r.phase === 'overtime') t = 'OVERTIME';
    else if (r.phase === 'roundEnd') t = `ROUND ${r.round}`;
    else if (r.phase === 'matchEnd') t = 'FINAL';
    setText(this.timer, t);
    this.timer.classList.toggle('urgent', (r.phase === 'live' && r.timer < 10) || r.phase === 'overtime');
    // objective
    const c = r.capture;
    this.objective.style.opacity = c.active ? '1' : '0';
    if (c.active) {
      const mine = c.team === my;
      setText(this.objText, c.contested ? 'CONTESTED' : c.team < 0 ? 'CAPTURE THE DRAIN' : mine ? 'CAPTURING' : 'ENEMY CAPTURING');
      this.objFill.style.width = `${Math.round(c.progress * 100)}%`;
      this.objective.dataset.state = c.contested ? 'contested' : c.team < 0 ? 'neutral' : mine ? 'friendly' : 'enemy';
    }
  }

  killfeed(killer: string, victim: string, weapon: string, headshot: boolean, killerTeam: number, victimTeam: number, involvesLocal: boolean): void {
    const e = el('div', `hud-feed-item${involvesLocal ? ' local' : ''}`, this.feed);
    const kc = killerTeam === this.localTeam ? 'f' : 'e';
    const vc = victimTeam === this.localTeam ? 'f' : 'e';
    const wname = WEAPON_MAP[weapon]?.name ?? (weapon === 'melee' ? 'Shiv' : weapon === 'frag' ? 'Frag' : weapon);
    e.innerHTML = `${killer ? `<b class="${kc}">${esc(killer)}</b>` : ''}<span class="w">${esc(wname)}${headshot ? ' <em>✦</em>' : ''}</span><b class="${vc}">${esc(victim)}</b>`;
    while (this.feed.children.length > 5) this.feed.firstElementChild?.remove();
    setTimeout(() => {
      e.classList.add('out');
      setTimeout(() => e.remove(), 400);
    }, 5000);
  }

  /**
   * Audio-cue caption (accessibility). `dir` is the cue's bearing relative to where the player
   * looks (radians, 0 = ahead, positive = left) or null for non-directional cues.
   */
  caption(text: string, dir: number | null, kind: 'enemy' | 'ally' | 'info' = 'info'): void {
    const now = performance.now();
    const key = `${text}|${kind}`;
    if (now - (this.captionSeen.get(key) ?? -1e9) < 1200) return;
    this.captionSeen.set(key, now);
    let arrow = '';
    if (dir !== null) {
      const arrows = ['↑', '↖', '←', '↙', '↓', '↘', '→', '↗'];
      const i = Math.round((((dir % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
      arrow = arrows[i];
    }
    const e = el('div', `hud-caption ${kind}`, this.captions, `${arrow ? `<b>${arrow}</b> ` : ''}${esc(text)}`);
    while (this.captions.children.length > 4) this.captions.firstElementChild?.remove();
    setTimeout(() => {
      e.classList.add('out');
      setTimeout(() => e.remove(), 400);
    }, 2200);
  }

  showBanner(title: string, sub = '', kind: 'neutral' | 'win' | 'lose' | 'warn' | 'count' = 'neutral', duration = 2.2): void {
    this.banner.className = `hud-banner show ${kind}`;
    this.banner.innerHTML = `<div class="t">${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}`;
    this.bannerT = duration;
  }

  setRoster(list: RosterEntry[]): void {
    const html = list
      .map((r) => `<div class="hud-roster-item${r.alive ? '' : ' dead'}${r.local ? ' me' : ''}"><span>${esc(r.name)}</span><div class="b"><i style="width:${Math.max(0, Math.round(r.hp))}%"></i></div></div>`)
      .join('');
    if (this.roster.innerHTML !== html) this.roster.innerHTML = html;
  }

  setSpectate(name: string | null, hint = 'LMB / RMB — switch player'): void {
    if (!name) {
      this.spectate.style.opacity = '0';
      return;
    }
    this.spectate.style.opacity = '1';
    const html = `<div class="l">SPECTATING</div><div class="n">${esc(name)}</div><div class="h">${hint}</div>`;
    if (this.spectate.innerHTML !== html) this.spectate.innerHTML = html;
  }

  setScoreboard(visible: boolean, rows: ScoreRow[] = [], header = ''): void {
    this.scoreboard.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    const team = (t: 0 | 1) =>
      rows
        .filter((r) => r.team === t)
        .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
        .map(
          (r) =>
            `<tr class="${r.local ? 'me' : ''}${r.alive ? '' : ' dead'}"><td>${esc(r.name)}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${r.assists}</td><td>${r.damage}</td><td>${r.bot ? 'BOT' : r.ping !== undefined ? `${r.ping}ms` : ''}</td></tr>`,
        )
        .join('');
    const my = this.localTeam;
    const en = my === 0 ? 1 : 0;
    const html = `<div class="hdr">${esc(header)}</div>
      <table><thead><tr><th>OPERATOR</th><th>K</th><th>D</th><th>A</th><th>DMG</th><th></th></tr></thead>
      <tbody class="f">${team(my)}</tbody><tbody class="e">${team(en)}</tbody></table>`;
    if (this.scoreboard.innerHTML !== html) this.scoreboard.innerHTML = html;
  }

  setScope(visible: boolean): void {
    this.scope.style.opacity = visible ? '1' : '0';
  }

  setPerf(fps: number, ping: number): void {
    const s = settings.value;
    const parts: string[] = [];
    if (s.showFps) parts.push(`${Math.round(fps)} FPS`);
    if (s.showPing && ping > 0) parts.push(`${Math.round(ping)} MS`);
    setText(this.perf, parts.join('  ·  '));
  }

  setConnection(message: string): void {
    setText(this.conn, message);
    this.conn.style.opacity = message ? '1' : '0';
  }

  /** Screen-space markers (teammate names, objective, pings). */
  setMarkers(list: { x: number; y: number; text: string; kind: 'friend' | 'objective' | 'enemy' }[]): void {
    const html = list.map((m) => `<div class="hud-marker ${m.kind}" style="left:${m.x.toFixed(0)}px;top:${m.y.toFixed(0)}px">${esc(m.text)}</div>`).join('');
    if (this.markers.innerHTML !== html) this.markers.innerHTML = html;
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? 'block' : 'none';
  }

  update(dt: number): void {
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT <= 0) this.hit.classList.remove('show');
    }
    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) this.banner.classList.remove('show');
    }
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
