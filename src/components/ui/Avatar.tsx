import { useState, type CSSProperties } from 'react';
import { cn } from '@/lib/cn';
import { IconUser } from '@/components/ui/icons';

interface AvatarProps {
  name?: string;
  src?: string;
  /** 'row' is the 48px dense chat-list row avatar (text-sm initials). */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'row';
  /** 'online' adds a bottom-right presence dot; absent renders no dot. */
  presence?: 'online' | undefined;
}

const PX: Record<NonNullable<AvatarProps['size']>, number> = {
  sm: 24,
  md: 26,
  lg: 32,
  xl: 48,
  row: 48,
};

const PALETTE = ['#5e6ad2', '#3e7d54', '#b8772b', '#c2392b', '#7a5ea8', '#2b8a9e'];

/**
 * The deterministic tone for a key, drawn from the shared avatar palette. Exported
 * so other tinted surfaces (e.g. the activity thumbnail tile) reuse the exact same
 * hash + palette instead of duplicating raw colors.
 */
function colorFor(name: string): string {
  let sum = 0;
  for (let i = 0; i < name.length; i += 1) {
    sum += name.charCodeAt(i);
  }
  return PALETTE[sum % PALETTE.length] ?? '#5e6ad2';
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
}

const base = 'rounded-full inline-flex items-center justify-center select-none';

export function Avatar({ presence, ...props }: AvatarProps) {
  if (presence !== 'online') return <AvatarFace {...props} />;
  return (
    <span className="relative inline-flex shrink-0">
      <AvatarFace {...props} />
      <span
        data-presence="online"
        aria-hidden="true"
        className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-good ring-2 ring-panel"
      />
    </span>
  );
}

function AvatarFace({ name, src, size = 'md' }: Omit<AvatarProps, 'presence'>) {
  const [errored, setErrored] = useState(false);
  const px = PX[size];
  const style: CSSProperties = { width: px, height: px };

  if (src !== undefined && !errored) {
    return (
      <img
        src={src}
        alt={name ?? ''}
        style={style}
        onError={() => setErrored(true)}
        className={cn(base, 'object-cover')}
      />
    );
  }

  if (name !== undefined && name.length > 0) {
    return (
      <div
        style={{ ...style, backgroundColor: colorFor(name) }}
        className={cn(base, 'text-white font-medium', size === 'row' ? 'text-sm' : 'text-xs')}
      >
        {initialsFor(name)}
      </div>
    );
  }

  return (
    <div style={style} className={cn(base, 'bg-accent-soft border border-accent-line text-accent')}>
      <IconUser size={Math.round(px * 0.6)} />
    </div>
  );
}
