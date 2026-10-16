import type { JSX } from 'preact';
import { MAP_INFO, MAP_ORDER, mapChoiceName, type MapChoice } from '@/data/maps';

/** Map cards (preview, name, one line) plus Random. Without onChange it only shows the pick. */
export function MapPicker(props: { value: MapChoice; onChange?: (m: MapChoice) => void; compact?: boolean }): JSX.Element {
  const base = import.meta.env.BASE_URL;
  const choices: MapChoice[] = [...MAP_ORDER, 'random'];
  return (
    <div class={`maps ${props.compact ? 'compact' : ''}`} role="radiogroup" aria-label="Map">
      {choices.map((id) => {
        const info = id === 'random' ? null : MAP_INFO[id];
        return (
          <button
            class={`map-card ${props.value === id ? 'on' : ''}`}
            role="radio"
            aria-checked={props.value === id}
            data-testid={`map-${id}`}
            disabled={!props.onChange && props.value !== id}
            onClick={() => props.onChange?.(id)}
          >
            <div class="map-thumb" style={info ? { backgroundImage: `url(${base}${info.thumb})` } : undefined}>
              {!info && <span>?</span>}
            </div>
            <div class="map-name">{mapChoiceName(id).toUpperCase()}</div>
            {!props.compact && <div class="map-desc">{info ? info.blurb : 'A different map each match.'}</div>}
          </button>
        );
      })}
    </div>
  );
}
