// One shared-brief chip in the composer, mirroring SharedPostChip: title, status
// and a 44px remove control.

import type { ReactElement } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { IconBriefs, IconX } from '@/components/ui/icons';
import { briefStatusLabel, type BriefCardFields } from '@/lib/chat/briefs';

export function SharedBriefChip({
  brief,
  onRemove,
}: {
  brief: BriefCardFields;
  onRemove: () => void;
}): ReactElement {
  return (
    <li className="flex items-center gap-2 rounded-lg border border-border bg-panel-2 py-1 pl-1 pr-1">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-panel-3 text-fg-3">
        <IconBriefs size={16} />
      </span>
      <span className="flex min-w-0 max-w-[180px] flex-col">
        <span className="truncate text-xs font-medium text-fg" title={brief.title}>
          {brief.title}
        </span>
        <span className="text-[11px] text-fg-3">{briefStatusLabel(brief.status)}</span>
      </span>
      <IconButton label={`Remove ${brief.title}`} onClick={onRemove}>
        <IconX size={16} />
      </IconButton>
    </li>
  );
}
