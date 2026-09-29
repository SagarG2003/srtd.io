import { useState, type CSSProperties } from 'react';
import { cn } from '@/lib/cn';
import { IconUser } from '@/components/ui/icons';

interface AvatarProps {
  name?: string;
  src?: string;
  /**
   * 'row' is the 48px dense chat-list row avatar (text-sm initials); 'header' is
   * the 40px group thread header photo; 'hero' is the 112px group info photo.
   */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'row' | 'header' | 'hero';
  /** 'rounded' is the 24px-radius rounded square (group info photo); default circle. */
  shape?: 'circle' | 'rounded';
  /** 'online' adds a bottom-right presence dot; absent renders no dot. */
  presence?: 'online' | undefined;
}

const PX: Record<NonNullable<AvatarProps['size']>, number> = {
  sm: 24,
  md: 26,
  lg: 32,
  xl: 48,
  row: 48,
  header: 40,
  hero: 112,
};

const INITIALS_TYPE: Record<NonNullable<AvatarProps['size']>, string> = {
  sm: 'text-xs',
  md: 'text-xs',
  lg: 'text-xs',
  xl: 'text-xs',
  row: 'text-sm',
  header: 'text-sm',
  hero: 'text-3xl',
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

const base = 'inline-flex items-center justify-center select-none';

const SHAPE: Record<NonNullable<AvatarProps['shape']>, string> = {
  circle: 'rounded-full',
  rounded: 'rounded-[24px]',
};

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

function AvatarFace({ name, src, size = 'md', shape = 'circle' }: Omit<AvatarProps, 'presence'>) {
  const [errored, setErrored] = useState(false);
  const px = PX[size];
  const box = `${SHAPE[shape]} ${base}`;
  const style: CSSProperties = { width: px, height: px };

  if (src !== undefined && !errored) {
    return (
      <img
        src={src}
        alt={name ?? ''}
        style={style}
        onError={() => setErrored(true)}
        className={cn(box, 'object-cover')}
      />
    );
  }

  if (name !== undefined && name.length > 0) {
    return (
      <div
        style={{ ...style, backgroundColor: colorFor(name) }}
        className={cn(box, 'text-white font-medium', INITIALS_TYPE[size])}
      >
        {initialsFor(name)}
      </div>
    );
  }

  return (
    <div style={style} className={cn(box, 'bg-accent-soft border border-accent-line text-accent')}>
      <IconUser size={Math.round(px * 0.6)} />
    </div>
  );
}
