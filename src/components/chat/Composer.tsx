import { useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement, SyntheticEvent } from 'react';
import { logger } from '@/lib/logger';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Textarea } from '@/components/ui/Textarea';
import {
  IconBriefs,
  IconFile,
  IconMic,
  IconPaperclip,
  IconPipeline,
  IconSend,
  IconTrash,
  IconX,
} from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { useAudioRecorder, recordingFileName } from '@/lib/chat/use-audio-recorder';
import type { TranscribeResult } from '@/lib/chat/transcribe';
import { AttachmentMenu } from '@/components/chat/AttachmentMenu';
import { PostPicker } from '@/components/chat/PostPicker';
import { PendingChip } from '@/components/chat/PendingChip';
import { PostRefThumb, postRefKey, type PostRefPost } from '@/components/chat/PostRefChip';
import { ReplyQuoteBox } from '@/components/chat/ReplyQuote';
import { briefStatusLabel, toggleBrief, type BriefCardFields } from '@/lib/chat/briefs';
import { togglePost } from '@/components/chat/post-picker';
import { attachmentMenuItems } from '@/lib/chat/attachment-menu';
import { caretHashQuery, stripHashToken } from '@/lib/chat/post-refs';
import { fileExtension } from '@/lib/assets';
import { precheckFile } from '@/lib/asset-upload';
import {
  canSendAttachmentMessage,
  precheckImage,
  toLocalAttachment,
  type AttachmentUploader,
  type MessageAttachment,
  type ReplyQuote,
} from '@/lib/chat/attachments';
import type { PostCardFields, Result } from '@srtdio/posts';
// Deep import: the package index is outside this change; the read lives beside readPostsByIds.
import { readPostIdsByNumbers } from '../../../packages/posts/src/reads';
import { readBriefIdsByNumbers } from '@/lib/chat/briefs';
import { APP_ENTITY_ROUTES, classify, currentOrigin, tokenize } from '@/lib/chat/message-links';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';

interface ComposerProps {
  /**
   * Queues the trimmed text plus any picked files (local attachments that upload
   * in the background) and shared posts and briefs. Synchronous: uploads,
   * delivery and retries run in the background.
   */
  onSend: ComposerSend;
  disabled: boolean;
  /**
   * Upload one file via the asset pipeline (with progress); absent disables
   * attaching. Picked files carry it to the outbox; voice notes call it here.
   */
  uploadFile?: AttachmentUploader | undefined;
  /** Transcribe a recorded voice note; absent sends the audio with no transcript. */
  transcribe?: ((blob: Blob) => Promise<TranscribeResult>) | undefined;
  /** Called on each keystroke so the parent can broadcast a throttled typing signal. */
  onTyping?: (() => void) | undefined;
  /** The active reply draft; renders the preview bar above the chips when present. */
  reply?: { authorName: string; quote: ReplyQuote } | undefined;
  /** Clears the active reply draft (cancel button, and after a successful send). */
  onCancelReply?: (() => void) | undefined;
  /** The post the conversation is about; renders the About bar above the reply bar. */
  about?: PostRefPost | undefined;
  /** Closes the About bar (its X); a send never clears it. */
  onCancelAbout?: (() => void) | undefined;
  /** Post ids already shared in this chat; picker rows say "in this chat". */
  sharedPostIds?: ReadonlySet<string> | undefined;
  /**
   * Bring a post into the conversation (the hash picker's pick); absent turns
   * the hash picker off.
   */
  onBringPost?: ((postId: string) => void) | undefined;
}

/** The composer placeholder: "Message about KEY-N" while About is up. */
export function composerPlaceholder(aboutRef: string | null): string {
  return aboutRef !== null ? `Message about ${aboutRef}` : 'Write a message';
}

/**
 * The About bar: the reply bar's grammar (3px accent rule, panel-3 box) with a
 * 32px thumbnail, "About KEY-N" in accent over the title, and a 44px close.
 */
export function AboutBar(props: {
  post: PostRefPost;
  refLabel: string | null;
  onCancel: () => void;
}): ReactElement {
  return (
    <div
      data-about-bar={props.post.id}
      className="flex min-w-0 items-center gap-2 overflow-hidden rounded-md bg-panel-3"
    >
      <span className="w-[3px] shrink-0 self-stretch rounded-full bg-accent" aria-hidden="true" />
      <PostRefThumb assetVersionId={props.post.thumbnailAssetVersionId} size={32} />
      <span className="flex min-w-0 flex-1 flex-col py-1">
        <span className="truncate text-xs font-medium text-accent">
          {props.refLabel !== null ? `About ${props.refLabel}` : 'About'}
        </span>
        <span className="truncate text-xs text-fg-2">{props.post.title}</span>
      </span>
      <IconButton label="Close about" className="shrink-0" onClick={props.onCancel}>
        <IconX size={16} />
      </IconButton>
    </div>
  );
}

/** The hash picker state for a text and caret: the query to search, or closed. */
export function hashPickerQuery(input: {
  enabled: boolean;
  dismissed: boolean;
  text: string;
  caret: number;
}): string | null {
  if (!input.enabled || input.dismissed) return null;
  return caretHashQuery(input.text, input.caret);
}

/** One accepted picked file, shown as a removable chip until Send. */
export interface Pending {
  id: string;
  file: File;
  previewUrl: string | null;
}

let pendingSeq = 0;

export type ComposerSend = (
  text: string,
  attachments: MessageAttachment[],
  sharedPostIds: string[],
  reply: ReplyQuote | null,
  sharedBriefIds: string[],
) => void;

/**
 * Hand one draft to the thread. The thread only queues it (the record write and
 * publish run in the background), so this returns in the same tick and the
 * composer clears and re-enables Send at once. True when the draft was taken;
 * false only when onSend threw, which is unexpected and logged, so the caller
 * keeps the draft.
 */
export function dispatchSend(
  onSend: ComposerSend,
  draft: {
    text: string;
    attachments: MessageAttachment[];
    sharedPostIds: string[];
    reply: ReplyQuote | null;
    sharedBriefIds: string[];
  },
): boolean {
  try {
    onSend(draft.text, draft.attachments, draft.sharedPostIds, draft.reply, draft.sharedBriefIds);
    return true;
  } catch (error) {
    logger.error('chat composer: send threw', { error: String(error) });
    return false;
  }
}

/** The draft fields pasted post / brief links can add cards to. */
export interface LinkCardDraft {
  text: string;
  sharedPostIds: string[];
  sharedBriefIds: string[];
}

/** Batched number-to-id reads for the open workspace (one query per entity type). */
export interface LinkCardReaders {
  postIds: (numbers: number[]) => Promise<Result<Array<{ id: string; number: number }>>>;
  briefIds: (numbers: number[]) => Promise<Result<Array<{ id: string; number: number }>>>;
}

/** The internal post / brief links in a body that belong to the open workspace. */
function workspaceLinks(
  text: string,
  workspaceKey: string | null,
  origin: string | null,
): Array<{ url: string; kind: 'post' | 'brief'; number: number }> {
  if (workspaceKey === null) return [];
  const links: Array<{ url: string; kind: 'post' | 'brief'; number: number }> = [];
  for (const segment of tokenize(text)) {
    if (segment.kind !== 'url') continue;
    const target = classify(segment.url, origin, APP_ENTITY_ROUTES);
    if (target.kind === 'external') continue;
    if (target.ref.key !== workspaceKey.toUpperCase()) continue;
    links.push({ url: segment.url, kind: target.kind, number: target.ref.number });
  }
  return links;
}

/** Whether Send must resolve pasted links first (any internal link to this workspace). */
export function hasLinkCards(
  text: string,
  workspaceKey: string | null,
  origin: string | null,
): boolean {
  return workspaceLinks(text, workspaceKey, origin).length > 0;
}

/**
 * Turn pasted post and brief links into shared cards at Send: at most one batched
 * read per entity type over every link's number, then each resolved id joins the
 * shared ids exactly as the picker adds it (no duplicates). A body of only
 * resolved links and whitespace sends as cards with an empty body; otherwise the
 * text stays as typed. A ref with no row under RLS, or a failed read, stays a
 * plain link with no error.
 */
export async function withLinkCards(
  draft: LinkCardDraft,
  context: { workspaceKey: string | null; origin: string | null },
  readers: LinkCardReaders,
): Promise<LinkCardDraft> {
  const links = workspaceLinks(draft.text, context.workspaceKey, context.origin);
  if (links.length === 0) return draft;
  const numbers = (kind: 'post' | 'brief'): number[] => [
    ...new Set(links.filter((l) => l.kind === kind).map((l) => l.number)),
  ];
  const postNumbers = numbers('post');
  const briefNumbers = numbers('brief');
  const [posts, briefs] = await Promise.all([
    postNumbers.length > 0 ? readers.postIds(postNumbers) : Promise.resolve(null),
    briefNumbers.length > 0 ? readers.briefIds(briefNumbers) : Promise.resolve(null),
  ]);
  const byNumber = (result: typeof posts): Map<number, string> =>
    new Map(result?.ok === true ? result.data.map((row) => [row.number, row.id]) : []);
  const postIdOf = byNumber(posts);
  const briefIdOf = byNumber(briefs);

  const sharedPostIds = [...draft.sharedPostIds];
  const sharedBriefIds = [...draft.sharedBriefIds];
  const resolved = new Set<string>();
  for (const link of links) {
    const id = (link.kind === 'post' ? postIdOf : briefIdOf).get(link.number);
    if (id === undefined) continue;
    resolved.add(link.url);
    const ids = link.kind === 'post' ? sharedPostIds : sharedBriefIds;
    if (!ids.includes(id)) ids.push(id);
  }
  const onlyLinks = tokenize(draft.text).every((segment) =>
    segment.kind === 'url' ? resolved.has(segment.url) : segment.text.trim() === '',
  );
  return { text: onlyLinks ? '' : draft.text, sharedPostIds, sharedBriefIds };
}

/**
 * True when `window.matchMedia('(pointer: coarse)')` matches, i.e. the primary
 * pointer is coarse (touch). Guarded so it returns false when `window` or
 * `window.matchMedia` is unavailable (SSR / non-DOM test environments).
 */
function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Whether a composer keydown should send rather than insert a newline: plain
 * Enter only. Shift+Enter (newline) and Enter mid-IME-composition are excluded,
 * and a coarse (touch-primary) pointer never sends on Enter so phones and
 * touch-only tablets keep the newline and tap Send instead.
 */
export function isSendKeydown(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  coarsePointer: boolean;
}): boolean {
  return input.key === 'Enter' && !input.shiftKey && !input.isComposing && !input.coarsePointer;
}

/**
 * Whether the composer's trailing control is the record-voice-note mic rather
 * than Send: only when attaching is possible and the composer is otherwise idle
 * and empty (no text, no pending attachments, no shared posts, not already
 * recording or processing a voice note).
 */
export function shouldShowMic(input: {
  hasUpload: boolean;
  disabled: boolean;
  text: string;
  attachmentCount: number;
  sharedPostCount: number;
  recording: boolean;
  voiceBusy: boolean;
}): boolean {
  return (
    input.hasUpload &&
    !input.disabled &&
    input.text.trim() === '' &&
    input.attachmentCount === 0 &&
    input.sharedPostCount === 0 &&
    !input.recording &&
    !input.voiceBusy
  );
}

/** Format a non-negative second count as mm:ss; 0 for non-finite input. */
function formatMmSs(s: number): string {
  const safe = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  const mm = Math.floor(safe / 60);
  const ss = safe % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/**
 * The picked files as the send carries them: one local attachment per chip, in
 * order, holding the File, its preview URL (the bubble tile shows it) and the
 * uploader. The upload itself runs in the outbox after Send.
 */
export function draftAttachments(
  pending: readonly Pending[],
  upload: AttachmentUploader | undefined,
): MessageAttachment[] {
  return pending.map((item) => toLocalAttachment(item.file, item.previewUrl, upload));
}

/** Whether Send is enabled: text, a picked file, or a shared post or brief. Never waits on an upload. */
export function composerCanSend(input: {
  disabled: boolean;
  text: string;
  fileCount: number;
  sharedPostCount: number;
  sharedBriefCount: number;
}): boolean {
  return (
    !input.disabled &&
    canSendAttachmentMessage({
      text: input.text,
      attachmentCount: input.fileCount,
      sharedPostCount: input.sharedPostCount,
      sharedBriefCount: input.sharedBriefCount,
      sending: false,
    })
  );
}

/**
 * Composer with text + an extensible attach menu (Photo / File). Files are
 * pre-checked client-side (a rejected one is refused with a toast) and shown as
 * removable chips; nothing uploads here. Send hands the picked files over as
 * local attachments: the bubble shows at once from the previews and the outbox
 * uploads them in the background, with progress on the bubble. Attachments-only
 * is allowed, empty is blocked. `onSend` only queues the message, so the draft
 * clears and Send re-enables in the same tick; a throw is unexpected, so it is
 * logged, surfaced as a toast, and the draft is kept.
 */
export function Composer(props: ComposerProps): ReactElement {
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [sharedPosts, setSharedPosts] = useState<PostCardFields[]>([]);
  const [sharedBriefs, setSharedBriefs] = useState<BriefCardFields[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [resolvingLinks, setResolvingLinks] = useState(false);
  // The caret, read on every change and selection, drives the hash picker.
  const [caret, setCaret] = useState(0);
  // Escape closes the hash picker until the caret leaves the token.
  const [hashDismissed, setHashDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { workspaceId, workspaceKey } = useWorkspace();
  const recorder = useAudioRecorder();
  const toast = useToast();

  const formRef = useRef<HTMLFormElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canAttach = props.uploadFile !== undefined && !props.disabled;
  const canSend = composerCanSend({
    disabled: props.disabled || resolvingLinks,
    text,
    fileCount: pending.length,
    sharedPostCount: sharedPosts.length,
    sharedBriefCount: sharedBriefs.length,
  });

  const menuItems = useMemo(
    () =>
      attachmentMenuItems({
        onPickPhoto: () => photoInputRef.current?.click(),
        onPickFile: () => fileInputRef.current?.click(),
        onSharePost: () => setPickerOpen(true),
      }),
    [],
  );

  function addFiles(list: FileList | null, imageOnly: boolean): void {
    if (list === null || list.length === 0 || props.uploadFile === undefined) return;
    const accepted: Pending[] = [];
    for (const file of Array.from(list)) {
      // The Photo path is image-only; the File path takes the full allowlist.
      const check = imageOnly ? precheckImage(file) : precheckFile(file);
      if (!check.ok) {
        toast.show({ title: check.message });
        continue;
      }
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      accepted.push({ id: `att-${(pendingSeq += 1)}`, file, previewUrl });
    }
    if (accepted.length > 0) setPending((prev) => [...prev, ...accepted]);
  }

  function removePending(id: string): void {
    setPending((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl != null) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  }

  function toggleSharedPost(post: PostCardFields): void {
    setSharedPosts((prev) => togglePost(prev, post));
  }

  function toggleSharedBrief(brief: BriefCardFields): void {
    setSharedBriefs((prev) => toggleBrief(prev, brief));
  }

  // Enter sends on desktop; Shift+Enter, IME composition, and touch-primary
  // devices keep the default newline. Route through the form's submit so the
  // Send button's exact handler and guard run.
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Escape' && hashQuery !== null) {
      event.preventDefault();
      setHashDismissed(true);
      return;
    }
    if (
      !isSendKeydown({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
        coarsePointer: isCoarsePointer(),
      })
    )
      return;
    event.preventDefault();
    formRef.current?.requestSubmit();
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!canSend) return;
    const draft: LinkCardDraft = {
      text,
      sharedPostIds: sharedPosts.map((post) => post.id),
      sharedBriefIds: sharedBriefs.map((brief) => brief.id),
    };
    const origin = currentOrigin();
    // Pasted post / brief links resolve here, at Send only (never per keystroke).
    if (workspaceId === null || !hasLinkCards(text, workspaceKey, origin)) {
      send(draft);
      return;
    }
    setResolvingLinks(true);
    void withLinkCards(
      draft,
      { workspaceKey, origin },
      {
        postIds: (numbers) => readPostIdsByNumbers(supabase, { workspaceId, numbers }),
        briefIds: (numbers) => readBriefIdsByNumbers(supabase, { workspaceId, numbers }),
      },
    )
      .catch((error: unknown) => {
        logger.warn('chat composer: link cards failed', { error: String(error) });
        return draft;
      })
      .then((resolved) => {
        setResolvingLinks(false);
        send(resolved);
      });
  }

  function send(draft: LinkCardDraft): void {
    const taken = dispatchSend(props.onSend, {
      text: draft.text,
      attachments: draftAttachments(pending, props.uploadFile),
      sharedPostIds: draft.sharedPostIds,
      reply: props.reply?.quote ?? null,
      sharedBriefIds: draft.sharedBriefIds,
    });
    if (!taken) {
      // Keep the draft (text + chips + shared posts) so it is not lost.
      toast.show({ title: 'Could not send the message. Your draft is kept.' });
      return;
    }
    // The preview URLs now belong to the bubble (revoked when it goes).
    setText('');
    setPending([]);
    setSharedPosts([]);
    setSharedBriefs([]);
    props.onCancelReply?.();
  }

  async function start(): Promise<void> {
    const ok = await recorder.start();
    if (!ok) toast.show({ title: 'Microphone access is needed to record.' });
  }

  function cancel(): void {
    recorder.cancel();
  }

  async function stopSend(): Promise<void> {
    setVoiceBusy(true);
    const durationMs = recorder.seconds * 1000;
    const rec = await recorder.stop();
    if (rec === null) {
      setVoiceBusy(false);
      return;
    }
    const file = new File([rec.blob], recordingFileName(rec.mime), { type: rec.mime });
    let transcript: string | undefined;
    if (props.transcribe !== undefined) {
      const t = await props.transcribe(rec.blob);
      if (t.ok && t.transcript.trim() !== '') transcript = t.transcript;
    }
    const up =
      props.uploadFile !== undefined
        ? await props.uploadFile(file)
        : ({ ok: false, message: 'Upload is unavailable.' } as const);
    if (!up.ok) {
      toast.show({ title: up.message });
      setVoiceBusy(false);
      return;
    }
    const attachment: MessageAttachment = {
      assetId: up.versionId,
      name: file.name,
      mime: file.type,
      size: file.size,
      durationMs,
      ...(transcript !== undefined ? { transcript } : {}),
    };
    const taken = dispatchSend(props.onSend, {
      text: '',
      attachments: [attachment],
      sharedPostIds: [],
      reply: props.reply?.quote ?? null,
      sharedBriefIds: [],
    });
    if (taken) props.onCancelReply?.();
    else toast.show({ title: 'Could not send the voice note.' });
    setVoiceBusy(false);
  }

  function trackCaret(event: SyntheticEvent<HTMLTextAreaElement>): void {
    const el = event.currentTarget;
    textareaRef.current = el;
    const next = el.selectionStart ?? el.value.length;
    setCaret(next);
    if (caretHashQuery(el.value, next) === null) setHashDismissed(false);
  }

  const hashQuery = hashPickerQuery({
    enabled: props.onBringPost !== undefined && !props.disabled,
    dismissed: hashDismissed,
    text,
    caret,
  });

  // A pick drops the hash token from the text and brings the post in.
  function pickHashPost(post: PostCardFields): void {
    const next = stripHashToken(text, caret);
    setText(next.text);
    setCaret(next.caret);
    const el = textareaRef.current;
    if (el !== null) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      });
    }
    props.onBringPost?.(post.id);
  }

  const aboutRef = props.about !== undefined ? postRefKey(workspaceKey, props.about.number) : null;

  const showMic = shouldShowMic({
    hasUpload: props.uploadFile !== undefined,
    disabled: props.disabled,
    text,
    attachmentCount: pending.length,
    sharedPostCount: sharedPosts.length + sharedBriefs.length,
    recording: recorder.recording,
    voiceBusy,
  });

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      className="relative flex flex-col gap-2 border-t border-border bg-panel px-3 py-2.5"
    >
      {hashQuery !== null ? (
        <div data-hash-picker="" className="absolute inset-x-3 bottom-full z-20 mb-2">
          <PostPicker
            inline
            open
            query={hashQuery}
            onClose={() => setHashDismissed(true)}
            selected={[]}
            onToggle={pickHashPost}
            selectedBriefs={[]}
            onToggleBrief={() => undefined}
            sharedPostIds={props.sharedPostIds}
          />
        </div>
      ) : null}

      {props.about !== undefined ? (
        <AboutBar post={props.about} refLabel={aboutRef} onCancel={() => props.onCancelAbout?.()} />
      ) : null}

      {props.reply != null ? (
        <ReplyQuoteBox
          author={props.reply.authorName}
          preview={props.reply.quote.preview}
          trailing={
            <IconButton
              label="Cancel reply"
              className="shrink-0"
              onClick={() => props.onCancelReply?.()}
            >
              <IconX size={16} />
            </IconButton>
          }
        />
      ) : null}

      {pending.length > 0 || sharedPosts.length > 0 || sharedBriefs.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {pending.map((item) => (
            <PendingChip
              key={item.id}
              thumb={
                item.previewUrl !== null ? (
                  <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <IconFile size={16} />
                )
              }
              title={item.file.name}
              meta={fileExtension(item.file.name)}
              onRemove={() => removePending(item.id)}
            />
          ))}
          {sharedPosts.map((post) => (
            <PendingChip
              key={post.id}
              thumb={<IconPipeline size={16} />}
              title={post.title}
              meta={stageLabel(post.stage)}
              onRemove={() => toggleSharedPost(post)}
            />
          ))}
          {sharedBriefs.map((brief) => (
            <PendingChip
              key={brief.id}
              thumb={<IconBriefs size={16} />}
              title={brief.title}
              meta={briefStatusLabel(brief.status)}
              onRemove={() => toggleSharedBrief(brief)}
            />
          ))}
        </ul>
      ) : null}

      <div className="flex items-end gap-2">
        {recorder.recording ? (
          <>
            <IconButton
              label="Cancel recording"
              className="shrink-0 text-bad hover:bg-bad-soft hover:text-bad"
              onClick={cancel}
            >
              <IconTrash size={20} />
            </IconButton>
            <div className="flex h-11 flex-1 items-center gap-2 rounded-md border border-border bg-panel-2 px-3">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-bad"
              />
              <span className="text-sm text-fg-2">Recording</span>
              <span className="ml-auto font-mono text-xs tabular-nums text-fg-2">
                {formatMmSs(recorder.seconds)}
              </span>
            </div>
            <Button
              type="button"
              variant="primary"
              size="lg"
              aria-label="Stop and send voice note"
              className="w-11 shrink-0 px-0"
              onClick={() => void stopSend()}
            >
              <IconSend size={18} />
            </Button>
          </>
        ) : voiceBusy ? (
          <div className="flex h-11 flex-1 items-center gap-2 px-1">
            <span
              aria-hidden="true"
              className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-border border-t-accent"
            />
            <span className="text-sm text-fg-2">Sending voice note…</span>
          </div>
        ) : (
          <>
            {canAttach ? (
              <div className="relative">
                <IconButton
                  label="Add attachment"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <IconPaperclip size={20} />
                </IconButton>
                <AttachmentMenu
                  open={menuOpen}
                  items={menuItems}
                  onClose={() => setMenuOpen(false)}
                />
              </div>
            ) : null}

            <Textarea
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                trackCaret(event);
                props.onTyping?.();
              }}
              onSelect={trackCaret}
              onKeyDown={handleKeyDown}
              placeholder={composerPlaceholder(aboutRef)}
              rows={1}
              compact
            />
            {showMic ? (
              <Button
                type="button"
                variant="primary"
                size="lg"
                aria-label="Record voice note"
                className="w-11 shrink-0 px-0"
                onClick={() => void start()}
              >
                <IconMic size={18} />
              </Button>
            ) : (
              <Button
                type="submit"
                variant="primary"
                size="lg"
                aria-label="Send"
                className="w-11 shrink-0 px-0"
                disabled={!canSend}
              >
                <IconSend size={18} />
              </Button>
            )}
          </>
        )}
      </div>

      <input
        ref={photoInputRef}
        type="file"
        multiple
        accept={menuItems.find((item) => item.id === 'photo')?.accept}
        className="sr-only"
        onChange={(event) => {
          addFiles(event.target.files, true);
          event.target.value = '';
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={menuItems.find((item) => item.id === 'file')?.accept}
        className="sr-only"
        onChange={(event) => {
          addFiles(event.target.files, false);
          event.target.value = '';
        }}
      />

      <PostPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selected={sharedPosts}
        onToggle={toggleSharedPost}
        selectedBriefs={sharedBriefs}
        onToggleBrief={toggleSharedBrief}
        sharedPostIds={props.sharedPostIds}
      />
    </form>
  );
}

/** Title-case a stage value for its chip meta (stage strings come from the Row). */
function stageLabel(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}
