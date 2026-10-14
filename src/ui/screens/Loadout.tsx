import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { GameController } from '@/app/GameController';
import { profile, updateLoadout } from '@/app/state';
import { CLASS_LABEL, WEAPONS, WEAPON_MAP, damageAt, statBars, timeToKill, type WeaponClass, type WeaponStats } from '@/data/weapons';
import { EQUIPMENT, LEVEL_XP, levelForXp, type Loadout } from '@/data/progression';
import { Bar, Button } from '../components';

type Slot = 'primary' | 'secondary' | 'lethal' | 'tactical';

const SLOT_LABEL: Record<Slot, string> = { primary: 'PRIMARY', secondary: 'SECONDARY', lethal: 'LETHAL', tactical: 'TACTICAL' };
const CLASS_ORDER: WeaponClass[] = ['ar', 'smg', 'shotgun', 'marksman', 'sniper', 'lmg', 'pistol'];
const FIRE_MODE: Record<string, string> = { auto: 'FULL AUTO', semi: 'SEMI AUTO', burst: '3-ROUND BURST', pump: 'PUMP ACTION', bolt: 'BOLT ACTION' };

const EQUIP_INFO: Record<string, { name: string; desc: string }> = {
  frag: { name: 'Breaker Frag', desc: 'Fragmentation grenade on a 2.4 s fuse. Lethal up close, wounds out to 6.5 m. Walls block the blast.' },
  flash: { name: 'Blinder Flash', desc: 'Pops after 1.7 s. Blinds anyone with line of sight for up to 2.6 s; looking away softens it.' },
  none: { name: 'Empty', desc: 'Carry nothing in this slot.' },
};

function lockInfo(level: number, xp: number): { locked: boolean; progress: number } {
  const need = LEVEL_XP[level] ?? 0;
  return { locked: xp < need, progress: need > 0 ? Math.min(1, xp / need) : 1 };
}

function StatRow(props: { label: string; value: number; compare?: number }): JSX.Element {
  const diff = props.compare === undefined ? 0 : props.value - props.compare;
  return (
    <div class="stat-row">
      <span>{props.label}</span>
      <div class="stat-bar">
        <i style={{ width: `${Math.round(props.value * 100)}%` }} />
        {props.compare !== undefined && <b class="cmp" style={{ left: `${Math.round(props.compare * 100)}%` }} />}
      </div>
      <em class={diff > 0.02 ? 'up' : diff < -0.02 ? 'down' : ''}>{diff > 0.02 ? '▲' : diff < -0.02 ? '▼' : ''}</em>
    </div>
  );
}

function WeaponDetails(props: { w: WeaponStats; equipped: WeaponStats }): JSX.Element {
  const w = props.w;
  const s = statBars(w);
  const e = statBars(props.equipped);
  const same = w.id === props.equipped.id;
  const ttk = timeToKill(w, 15);
  return (
    <div class="wdetail" data-testid="weapon-details">
      <div class="wd-class">{CLASS_LABEL[w.class].toUpperCase()}</div>
      <div class="wd-name">{w.name.toUpperCase()}</div>
      <div class="wd-desc">{w.description}</div>
      <div class="wd-stats">
        <StatRow label="DAMAGE" value={s.damage} compare={same ? undefined : e.damage} />
        <StatRow label="FIRE RATE" value={s.fireRate} compare={same ? undefined : e.fireRate} />
        <StatRow label="RANGE" value={s.range} compare={same ? undefined : e.range} />
        <StatRow label="ACCURACY" value={s.accuracy} compare={same ? undefined : e.accuracy} />
        <StatRow label="MOBILITY" value={s.mobility} compare={same ? undefined : e.mobility} />
        <StatRow label="HANDLING" value={s.handling} compare={same ? undefined : e.handling} />
      </div>
      <div class="wd-facts">
        <span>
          <b>{FIRE_MODE[w.fireMode]}</b>
        </span>
        <span>
          <b>{w.rpm}</b> RPM
        </span>
        <span>
          <b>{Math.round(damageAt(w, 0) * (w.pellets ?? 1))}</b> DMG{w.pellets ? ` (${w.pellets}×)` : ''}
        </span>
        <span>
          <b>{w.magSize}</b> MAG
        </span>
        <span>
          <b>{w.reload.toFixed(1)}s</b> RELOAD
        </span>
        <span>
          <b>{ttk === Infinity ? '-' : ttk === 0 ? 'ONE SHOT' : `${ttk}ms`}</b> {ttk === 0 ? '@15m' : 'TTK @15m'}
        </span>
      </div>
    </div>
  );
}

export function LoadoutTab(props: { game: GameController; onChange?: (l: Loadout) => void }): JSX.Element {
  const p = profile.value;
  const lo = p.loadout;
  const lv = levelForXp(p.xp).level;
  const [slot, setSlot] = useState<Slot>('primary');
  const [sel, setSel] = useState<string>(lo.primary);
  // keep the selection on the slot's equipped item when switching slots
  useEffect(() => setSel(lo[slot]), [slot]);
  const selWeapon = WEAPON_MAP[sel];
  useEffect(() => {
    props.game.setShowcase(selWeapon ? selWeapon.id : WEAPON_MAP[lo.primary]?.id ?? null);
  }, [sel]);
  useEffect(() => () => props.game.setShowcase(null), []);

  const equip = (id: string) => {
    const next = { ...lo, [slot]: id };
    void updateLoadout(next).then(() => props.onChange?.(profile.value.loadout));
  };

  const items: { id: string; name: string; group: string; level: number }[] =
    slot === 'primary' || slot === 'secondary'
      ? WEAPONS.filter((w) => w.slot === slot)
          .sort((a, b) => CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class) || a.unlockLevel - b.unlockLevel)
          .map((w) => ({ id: w.id, name: w.name, group: CLASS_LABEL[w.class], level: w.unlockLevel }))
      : [
          ...EQUIPMENT.filter((e) => e.kind === slot).map((e) => ({ id: e.id, name: e.name, group: slot === 'lethal' ? 'Lethal' : 'Tactical', level: e.unlockLevel })),
          { id: 'none', name: 'Empty', group: slot === 'lethal' ? 'Lethal' : 'Tactical', level: 1 },
        ];
  const groups = [...new Set(items.map((i) => i.group))];
  const selItem = items.find((i) => i.id === sel);
  const selLock = selItem ? lockInfo(selItem.level, p.xp) : { locked: false, progress: 1 };

  return (
    <div class="loadout" data-testid="loadout">
      <div class="lo-slots">
        {(['primary', 'secondary', 'lethal', 'tactical'] as Slot[]).map((s) => {
          const id = lo[s];
          const w = WEAPON_MAP[id];
          return (
            <button class={`lo-slot ${slot === s ? 'on' : ''}`} onClick={() => setSlot(s)} data-testid={`slot-${s}`}>
              <small>{SLOT_LABEL[s]}</small>
              <b>{(w ? w.name : (EQUIP_INFO[id]?.name ?? id)).toUpperCase()}</b>
              <span>{w ? CLASS_LABEL[w.class] : s === 'lethal' || s === 'tactical' ? 'Equipment' : ''}</span>
            </button>
          );
        })}
        <div class="lo-level">
          <span>LEVEL {lv}</span>
          <Bar value={levelForXp(p.xp).progress} class="xp" />
          <small>{levelForXp(p.xp).need ? `${levelForXp(p.xp).into} / ${levelForXp(p.xp).need} XP` : 'MAX LEVEL'}</small>
        </div>
      </div>

      <div class="lo-center">
        {selWeapon ? (
          <WeaponDetails w={selWeapon} equipped={WEAPON_MAP[lo[slot]] ?? selWeapon} />
        ) : (
          <div class="wdetail">
            <div class="wd-class">{slot.toUpperCase()}</div>
            <div class="wd-name">{(EQUIP_INFO[sel]?.name ?? sel).toUpperCase()}</div>
            <div class="wd-desc">{EQUIP_INFO[sel]?.desc}</div>
          </div>
        )}
        <div class="lo-equip">
          {selLock.locked ? (
            <div class="lo-locked" data-testid="locked">
              <span>UNLOCKS AT LEVEL {selItem?.level}</span>
              <Bar value={selLock.progress} />
            </div>
          ) : lo[slot] === sel ? (
            <Button variant="secondary" size="lg" disabled>
              EQUIPPED
            </Button>
          ) : (
            <Button variant="primary" size="lg" onClick={() => equip(sel)} testid="equip">
              EQUIP
            </Button>
          )}
        </div>
      </div>

      <div class="lo-list">
        {groups.map((g) => (
          <div class="lo-group">
            <div class="lo-group-h">{g.toUpperCase()}</div>
            <div class="lo-grid">
              {items
                .filter((i) => i.group === g)
                .map((i) => {
                  const lk = lockInfo(i.level, p.xp);
                  return (
                    <button
                      class={`lo-item ${sel === i.id ? 'sel' : ''} ${lo[slot] === i.id ? 'eq' : ''} ${lk.locked ? 'locked' : ''}`}
                      onClick={() => setSel(i.id)}
                      onDblClick={() => !lk.locked && equip(i.id)}
                      data-testid={`item-${i.id}`}
                    >
                      <b>{i.name.toUpperCase()}</b>
                      {lk.locked ? (
                        <span class="lk">
                          🔒 LV {i.level}
                          <Bar value={lk.progress} />
                        </span>
                      ) : lo[slot] === i.id ? (
                        <span class="eqd">EQUIPPED</span>
                      ) : (
                        <span>&nbsp;</span>
                      )}
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Compact loadout picker used in the pause menu (applies from the next round). */
export function QuickLoadout(props: { onPick: (l: Loadout) => void }): JSX.Element {
  const p = profile.value;
  const lo = p.loadout;
  const lv = levelForXp(p.xp).level;
  const row = (slot: Slot, options: { id: string; name: string; level: number }[]) => (
    <div class="ql-row">
      <span class="ql-l">{SLOT_LABEL[slot]}</span>
      <div class="ql-opts">
        {options.map((o) => {
          const locked = o.level > lv;
          return (
            <button
              class={`seg-b ${lo[slot] === o.id ? 'on' : ''}`}
              disabled={locked}
              title={locked ? `Unlocks at level ${o.level}` : ''}
              onClick={() => {
                const next = { ...lo, [slot]: o.id };
                void updateLoadout(next).then(() => props.onPick(profile.value.loadout));
              }}
            >
              {locked ? '🔒 ' : ''}
              {o.name.toUpperCase()}
            </button>
          );
        })}
      </div>
    </div>
  );
  const weapons = (slot: 'primary' | 'secondary') =>
    WEAPONS.filter((w) => w.slot === slot)
      .sort((a, b) => a.unlockLevel - b.unlockLevel)
      .map((w) => ({ id: w.id, name: w.name, level: w.unlockLevel }));
  const equipment = (kind: 'lethal' | 'tactical') => [
    ...EQUIPMENT.filter((e) => e.kind === kind).map((e) => ({ id: e.id, name: e.name, level: e.unlockLevel })),
    { id: 'none', name: 'None', level: 1 },
  ];
  return (
    <div class="quick-loadout" data-testid="quick-loadout">
      {row('primary', weapons('primary'))}
      {row('secondary', weapons('secondary'))}
      {row('lethal', equipment('lethal'))}
      {row('tactical', equipment('tactical'))}
    </div>
  );
}
