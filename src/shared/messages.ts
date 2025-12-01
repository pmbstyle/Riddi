import type {
  ArticleContent,
  PlaybackState,
  TTSProgress,
  TTSRequest,
  TTSResult
} from './types';

export type ContentToBackgroundMessage =
  | { type: 'content-ready'; article: ArticleContent }
  | { type: 'start-tts'; payload: TTSRequest }
  | { type: 'pause-tts' }
  | { type: 'resume-tts' }
  | { type: 'stop-tts' };

export type PopupToBackgroundMessage =
  | { type: 'popup-start-tts' }
  | { type: 'popup-pause-tts' }
  | { type: 'popup-resume-tts' }
  | { type: 'popup-stop-tts' }
  | { type: 'get-playback-state' };

export type BackgroundToContentMessage =
  | { type: 'playback-state'; state: PlaybackState }
  | { type: 'highlight-chunk'; chunkIndex: number; chunkText: string; durationMs: number }
  | { type: 'widget-visibility'; enabled: boolean };

export type BackgroundToOffscreenMessage =
  | { type: 'synthesize'; payload: TTSRequest }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' };

export type OffscreenToBackgroundMessage =
  | { type: 'ready' }
  | { type: 'tts-progress'; progress: TTSProgress }
  | { type: 'tts-result'; result: TTSResult }
  | { type: 'tts-chunk-playing'; requestId: string; chunkIndex: number; chunkText: string; durationMs: number }
  | { type: 'tts-complete'; requestId: string; totalDuration: number }
  | { type: 'tts-error'; requestId?: string; message: string }
  | { type: 'debug-log'; level?: 'info' | 'warn' | 'error'; message: string; detail?: unknown };

export type RuntimeMessage =
  | ContentToBackgroundMessage
  | PopupToBackgroundMessage
  | BackgroundToContentMessage
  | BackgroundToOffscreenMessage
  | OffscreenToBackgroundMessage;

export function isOffscreenMessage(
  message: RuntimeMessage
): message is OffscreenToBackgroundMessage {
  return (
    message.type === 'ready' ||
    message.type === 'tts-progress' ||
    message.type === 'tts-result' ||
    message.type === 'tts-chunk-playing' ||
    message.type === 'tts-complete' ||
    message.type === 'tts-error' ||
    message.type === 'debug-log'
  );
}

export function isContentMessage(
  message: RuntimeMessage
): message is ContentToBackgroundMessage {
  return (
    message.type === 'content-ready' ||
    message.type === 'start-tts' ||
    message.type === 'pause-tts' ||
    message.type === 'resume-tts' ||
    message.type === 'stop-tts'
  );
}

export function isPopupMessage(
  message: RuntimeMessage
): message is PopupToBackgroundMessage {
  return (
    message.type === 'popup-start-tts' ||
    message.type === 'popup-pause-tts' ||
    message.type === 'popup-resume-tts' ||
    message.type === 'popup-stop-tts' ||
    message.type === 'get-playback-state'
  );
}
