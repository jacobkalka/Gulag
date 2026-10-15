import type { ComponentChildren, JSX } from 'preact';
import { audio } from '@/engine/audio/AudioEngine';

// Small shared UI building blocks (industrial style). Sounds on hover/click for juice.

export function Button(props: {
  children: ComponentChildren;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  disabled?: boolean;
  title?: string;
  class?: string;
  testid?: string;
}): JSX.Element {
  const v = props.variant ?? 'secondary';
  return (
    <button
      class={`btn btn-${v} btn-${props.size ?? 'md'} ${props.class ?? ''}`}
      disabled={props.disabled}
      title={props.title}
      data-testid={props.testid}
      onMouseEnter={() => !props.disabled && audio.ui('uiHover', 0.6)}
      onClick={() => {
        if (props.disabled) return;
        audio.unlock();
        audio.ui('uiClick');
        props.onClick?.();
      }}
    >
      <span>{props.children}</span>
    </button>
  );
}

export function Panel(props: { title?: string; children: ComponentChildren; class?: string; right?: ComponentChildren }): JSX.Element {
  return (
    <section class={`panel ${props.class ?? ''}`}>
      {props.title && (
        <header class="panel-h">
          <h3>{props.title}</h3>
          {props.right}
        </header>
      )}
      <div class="panel-b">{props.children}</div>
    </section>
  );
}

export function Slider(props: { label: string; value: number; min: number; max: number; step?: number; onInput: (v: number) => void; format?: (v: number) => string; hint?: string }): JSX.Element {
  return (
    <label class="field slider" title={props.hint}>
      <span class="field-l">{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 0.01}
        value={props.value}
        onInput={(e) => props.onInput(parseFloat((e.target as HTMLInputElement).value))}
      />
      <span class="field-v">{props.format ? props.format(props.value) : props.value.toFixed(2)}</span>
    </label>
  );
}

export function Toggle(props: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }): JSX.Element {
  return (
    <label class="field toggle" title={props.hint}>
      <span class="field-l">{props.label}</span>
      <button
        class={`tgl ${props.value ? 'on' : ''}`}
        role="switch"
        aria-checked={props.value}
        onClick={() => {
          audio.ui('uiClick');
          props.onChange(!props.value);
        }}
      >
        <i />
      </button>
    </label>
  );
}

export function Segmented<T extends string>(props: { label?: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }): JSX.Element {
  return (
    <div class="field seg">
      {props.label && <span class="field-l">{props.label}</span>}
      <div class="seg-row">
        {props.options.map((o) => (
          <button
            class={`seg-b ${o.value === props.value ? 'on' : ''}`}
            onClick={() => {
              audio.ui('uiClick');
              props.onChange(o.value);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Hazard(): JSX.Element {
  return <div class="hazard" />;
}

export function Bar(props: { value: number; class?: string }): JSX.Element {
  return (
    <div class={`bar ${props.class ?? ''}`}>
      <i style={{ width: `${Math.round(Math.max(0, Math.min(1, props.value)) * 100)}%` }} />
    </div>
  );
}
