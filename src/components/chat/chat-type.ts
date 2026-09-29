// The one source for every chat type size (WhatsApp parity). Each constant is
// the mobile value first, then the md: (768px and up) value. Chat surfaces use
// only these; no other size literals. 12px / 16px is Tailwind's text-xs.

/** Message body in a bubble: 17/22 mobile, 14.2/19 laptop, 400. */
export const BUBBLE_BODY_TYPE =
  'text-[17px] leading-[22px] font-normal md:text-[14.2px] md:leading-[19px]';

/** In-bubble meta (time, "edited"): 11/15, 400 on both. */
export const BUBBLE_META_TYPE = 'text-[11px] leading-[15px] font-normal tabular-nums';

/** The meta's tick (and clock / alert) glyph box: 16x11. */
export const TICK_ICON_BOX = 'h-[11px] w-4 shrink-0';

/** The sender name over a group run: 13/18/600 mobile, 12.8/22/500 laptop. */
export const GROUP_SENDER_TYPE =
  'text-[13px] leading-[18px] font-semibold md:text-[12.8px] md:leading-[22px] md:font-medium';

/** A bubble's reply quote author: 13/18/600 mobile, 12.8/20/500 laptop. */
export const QUOTE_AUTHOR_TYPE =
  'text-[13px] leading-[18px] font-semibold md:text-[12.8px] md:leading-[20px] md:font-medium';

/** A bubble's reply quote text: 14/18 mobile, 13.2/20 laptop, 400. */
export const QUOTE_TEXT_TYPE =
  'text-[14px] leading-[18px] font-normal md:text-[13.2px] md:leading-[20px]';

/** Shared post card title: 15/20 mobile, 14/19 laptop, 500. */
export const POST_CARD_TITLE_TYPE =
  'text-[15px] leading-[20px] font-medium md:text-[14px] md:leading-[19px]';

/** Shared post card meta: 12/16, 400 on both. */
export const POST_CARD_META_TYPE = 'text-xs font-normal';

/** Thread header name: 17/22/600 mobile, 16/21/500 laptop. */
export const HEADER_NAME_TYPE =
  'text-[17px] leading-[22px] font-semibold md:text-[16px] md:leading-[21px] md:font-medium';

/** Thread header second line: 13/16 mobile, 13/20 laptop, 400. */
export const HEADER_LINE_TYPE = 'text-[13px] leading-[16px] font-normal md:leading-[20px]';

/**
 * Composer input and placeholder: 17/22 mobile, 15/20 laptop, 400. Important,
 * so it wins over the compact Textarea's inline 16px default.
 */
export const COMPOSER_INPUT_TYPE =
  '!text-[17px] !leading-[22px] font-normal md:!text-[15px] md:!leading-[20px]';

/** Chat list name: 17/22/600 mobile, 17/21/400 laptop. */
export const CHAT_LIST_NAME_TYPE =
  'text-[17px] leading-[22px] font-semibold md:leading-[21px] md:font-normal';

/** Chat list preview: 15/20 mobile, 14/20 laptop, 400. */
export const CHAT_LIST_PREVIEW_TYPE =
  'text-[15px] leading-[20px] font-normal md:text-[14px] md:leading-[20px]';

/** Chat list time: 14/18 mobile, 12/16 laptop, 400; sans with tabular figures. */
export const CHAT_LIST_TIME_TYPE =
  'font-sans text-[14px] leading-[18px] font-normal tabular-nums md:text-xs';

/** Date separator pill: 12.5/16/500 mobile, 12.5/16/400 uppercase laptop; sans, tabular. */
export const DATE_PILL_TYPE =
  'font-sans text-[12.5px] leading-[16px] font-medium tabular-nums md:font-normal md:uppercase';

/** The typing row above the composer: 13/16, 400. */
export const TYPING_ROW_TYPE = 'text-[13px] leading-[16px] font-normal';

/** The emoji in a reaction badge: 14. */
export const REACTION_EMOJI_TYPE = 'text-[14px] leading-none';

/** The "Draft:" prefix in a chat list preview: weight 500 (the accent comes from a token). */
export const DRAFT_PREFIX_TYPE = 'font-medium';

/** Bubble shape on md+ only: 7.5px radius, 6/7/8/9 padding. Mobile is unchanged. */
export const BUBBLE_SHAPE_MD = 'md:rounded-[7.5px]';
export const BUBBLE_PAD_MD = 'md:pb-[8px] md:pl-[9px] md:pr-[7px] md:pt-[6px]';

/** The bubble column's max width on md+ (mobile keeps its own). */
export const BUBBLE_MAX_MD = 'md:max-w-[65%]';
