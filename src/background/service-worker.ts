import type {
  BackgroundToContentMessage,
  BackgroundToOffscreenMessage,
  ContentToBackgroundMessage,
  OffscreenToBackgroundMessage,
  PopupToBackgroundMessage
} from '@shared/messages';
import { isContentMessage, isOffscreenMessage, isPopupMessage } from '@shared/messages';
import type { ArticleContent, PlaybackState, TTSRequest, TTSSettings } from '@shared/types';

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';
let offscreenReady = false;
let offscreenReadyResolver: (() => void) | null = null;
let offscreenReadyPromise: Promise<void> | null = null;

let lastArticle: ArticleContent | null = null;
let playbackState: PlaybackState = {
  status: 'idle',
  currentChunk: 0,
  totalChunks: 0,
  positionSeconds: 0,
  durationSeconds: 0
};
let activeRequestId: string | null = null;

chrome.runtime.onInstalled.addListener(() => {
  console.info('Riddi installed.');
});

chrome.runtime.onMessage.addListener((message: ContentToBackgroundMessage | OffscreenToBackgroundMessage | PopupToBackgroundMessage, _sender, sendResponse) => {
  if (isContentMessage(message)) {
    void handleContentMessage(message);
    sendResponse({ ok: true });
    return true;
  }

  if (isOffscreenMessage(message)) {
    void handleOffscreenMessage(message);
    sendResponse({ ok: true });
    return true;
  }

  if (isPopupMessage(message)) {
    void handlePopupMessage(message, sendResponse);
    return true;
  }

  return false;
});

async function ensureOffscreenDocument(): Promise<void> {
  const hasDoc = (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) || false;
  if (hasDoc) return;
  offscreenReady = false;
  offscreenReadyPromise = null;
  offscreenReadyResolver = null;

  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH),
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Run ONNX TTS pipeline and play generated audio.'
  });
}

async function ensureOffscreenReady(): Promise<void> {
  await ensureOffscreenDocument();
  if (offscreenReady) return;
  if (!offscreenReadyPromise) {
    offscreenReadyPromise = new Promise<void>((resolve) => {
      offscreenReadyResolver = resolve;
    });
  }
  await offscreenReadyPromise;
}

async function handlePopupMessage(message: PopupToBackgroundMessage, sendResponse: (response: unknown) => void): Promise<void> {
  switch (message.type) {
    case 'get-playback-state':
      sendResponse({ state: playbackState, hasArticle: !!lastArticle });
      return;
    case 'popup-start-tts':
      if (lastArticle) {
        const saved = await chrome.storage.sync.get(['ttsSettings']);
        const settings: TTSSettings = saved?.ttsSettings ?? {
          voice: 'M1',
          speed: 1,
          qualitySteps: 6,
          widgetEnabled: true
        };
        
        await ensureOffscreenReady();
        const requestId = crypto.randomUUID();
        activeRequestId = requestId;
        updatePlaybackState({
          status: 'loading',
          currentChunk: 0,
          totalChunks: 0,
          positionSeconds: 0,
          durationSeconds: 0,
          highlightedSentence: 0
        });
        await postToOffscreen({
          type: 'synthesize',
          payload: { requestId, text: lastArticle.content, settings }
        });
      }
      sendResponse({ ok: true });
      return;
    case 'popup-pause-tts':
      await postToOffscreen({ type: 'pause' });
      updatePlaybackState({ status: 'paused' });
      sendResponse({ ok: true });
      return;
    case 'popup-resume-tts':
      await postToOffscreen({ type: 'resume' });
      updatePlaybackState({ status: 'playing' });
      sendResponse({ ok: true });
      return;
    case 'popup-stop-tts':
      await postToOffscreen({ type: 'stop' });
      activeRequestId = null;
      updatePlaybackState({ status: 'idle', positionSeconds: 0, durationSeconds: 0 });
      sendResponse({ ok: true });
      return;
    default:
      sendResponse({ ok: false });
  }
}

async function handleContentMessage(message: ContentToBackgroundMessage): Promise<void> {
  switch (message.type) {
    case 'content-ready':
      lastArticle = message.article;
      console.info('Content ready received');
      break;
    case 'start-tts':
      console.info('Start TTS requested');
      await ensureOffscreenReady();
      activeRequestId = message.payload.requestId;
      updatePlaybackState({
        status: 'loading',
        currentChunk: 0,
        totalChunks: 0,
        positionSeconds: 0,
        durationSeconds: 0,
        highlightedSentence: 0
      });
      await postToOffscreen({ type: 'synthesize', payload: message.payload });
      break;
    case 'pause-tts':
      console.info('Pause TTS requested');
      await postToOffscreen({ type: 'pause' });
      updatePlaybackState({ status: 'paused' });
      break;
    case 'resume-tts':
      console.info('Resume TTS requested');
      await postToOffscreen({ type: 'resume' });
      updatePlaybackState({ status: 'playing' });
      break;
    case 'stop-tts':
      console.info('Stop TTS requested');
      await postToOffscreen({ type: 'stop' });
      activeRequestId = null;
      updatePlaybackState({ status: 'idle', positionSeconds: 0, durationSeconds: 0 });
      break;
    default:
      break;
  }
}

async function handleOffscreenMessage(message: OffscreenToBackgroundMessage): Promise<void> {
  switch (message.type) {
    case 'ready':
      console.info('Offscreen document ready for synthesis.');
      offscreenReady = true;
      offscreenReadyResolver?.();
      offscreenReadyResolver = null;
      break;
    case 'debug-log':
      {
        const level = message.level ?? 'info';
        const prefix = '[offscreen]';
        if (level === 'error') console.error(prefix, message.message, message.detail ?? '');
        else if (level === 'warn') console.warn(prefix, message.message, message.detail ?? '');
        else console.info(prefix, message.message, message.detail ?? '');
      }
      break;
    case 'tts-progress':
      console.info('Offscreen progress', message.progress);
      if (activeRequestId && message.progress.requestId === activeRequestId) {
        // Keep status as loading during synthesis
        updatePlaybackState({
          currentChunk: message.progress.step,
          totalChunks: message.progress.totalSteps
        });
      }
      break;
    case 'tts-result':
      if (activeRequestId && message.result.requestId === activeRequestId) {
        console.info('Offscreen result received', message.result);
        // Update to playing status when first audio starts
        updatePlaybackState({
          status: 'playing',
          positionSeconds: 0,
          durationSeconds: message.result.durationSeconds
        });
      }
      break;
    case 'tts-chunk-playing':
      if (activeRequestId && message.requestId === activeRequestId) {
        updatePlaybackState({
          status: 'playing',
          currentChunk: message.chunkIndex
        });
        broadcastToContent({
          type: 'highlight-chunk',
          chunkIndex: message.chunkIndex,
          chunkText: message.chunkText,
          durationMs: message.durationMs
        }).catch(err => console.warn('Failed to broadcast highlight:', err));
      }
      break;
    case 'tts-complete':
      if (activeRequestId && message.requestId === activeRequestId) {
        console.info('Playback complete, total duration:', message.totalDuration);
        activeRequestId = null;
        updatePlaybackState({
          status: 'idle',
          positionSeconds: 0,
          durationSeconds: message.totalDuration
        });
        // Send final highlight clear to content
        broadcastToContent({
          type: 'highlight-chunk',
          chunkIndex: -1,  // -1 signals clear highlights
          chunkText: '',
          durationMs: 0
        }).catch(() => {});
      }
      break;
    case 'tts-error':
      console.error('Offscreen TTS error:', message.message);
      updatePlaybackState({ status: 'error', error: message.message });
      break;
    default:
      break;
  }
}

function updatePlaybackState(partial: Partial<PlaybackState>): void {
  playbackState = { ...playbackState, ...partial };
  void broadcastToContent({ type: 'playback-state', state: playbackState });
}

async function postToOffscreen(message: BackgroundToOffscreenMessage): Promise<void> {
  await ensureOffscreenReady();
  try {
    await chrome.runtime.sendMessage(message);
  } catch (err) {
    // If the offscreen document was closed, recreate and retry once.
    console.warn('Retrying offscreen message after failure', err);
    offscreenReady = false;
    offscreenReadyPromise = null;
    offscreenReadyResolver = null;
    await ensureOffscreenReady();
    await chrome.runtime.sendMessage(message);
  }
}

async function broadcastToContent(message: BackgroundToContentMessage): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, message).catch(() => {
      /* ignore tabs without the content script */
    });
  }
}

// Expose lastArticle for future use (popup, debugging)
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'get-last-article') {
    sendResponse({ article: lastArticle });
    return true;
  }
  return false;
});
