import { useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement } from 'react';
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
import { ReplyQuoteBox } from '@/components/chat/ReplyQuote';
import { briefStatusLabel, toggleBrief, type BriefCardFields } from '@/lib/chat/briefs';
import { togglePost } from '@/components/chat/post-picker';
import { attachmentMenuItems } from '@/lib/chat/attachment-menu';
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
import type { PostCardFields } from '@srtdio/posts';

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
  const recorder = useAudioRecorder();
  const toast = useToast();

  const formRef = useRef<HTMLFormElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canAttach = props.uploadFile !== undefined && !props.disabled;
  const canSend = composerCanSend({
    disabled: props.disabled,
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
    const taken = dispatchSend(props.onSend, {
      text,
      attachments: draftAttachments(pending, props.uploadFile),
      sharedPostIds: sharedPosts.map((post) => post.id),
      reply: props.reply?.quote ?? null,
      sharedBriefIds: sharedBriefs.map((brief) => brief.id),
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
      className="flex flex-col gap-2 border-t border-border bg-panel px-3 py-2.5"
    >
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
                props.onTyping?.();
              }}
              onKeyDown={handleKeyDown}
              placeholder="Write a message"
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
      />
    </form>
  );
}

/** Title-case a stage value for its chip meta (stage strings come from the Row). */
function stageLabel(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}
