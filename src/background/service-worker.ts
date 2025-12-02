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

// Track articles per tab
const tabArticles = new Map<number, ArticleContent>();

let playbackState: PlaybackState = {
  status: 'idle',
  currentChunk: 0,
  totalChunks: 0,
  positionSeconds: 0,
  durationSeconds: 0
};
let activeRequestId: string | null = null;
let activeTabId: number | null = null;

chrome.runtime.onInstalled.addListener(() => {
  console.info('[Riddi] Extension installed');
});

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabArticles.delete(tabId);
  if (activeTabId === tabId) {
    activeTabId = null;
  }
});

chrome.runtime.onMessage.addListener((message: ContentToBackgroundMessage | OffscreenToBackgroundMessage | PopupToBackgroundMessage, sender, sendResponse) => {
  if (isContentMessage(message)) {
    const tabId = sender.tab?.id;
    void handleContentMessage(message, tabId);
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

async function getActiveTabArticle(): Promise<{ article: ArticleContent; tabId: number } | null> {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id) {
      const article = tabArticles.get(activeTab.id);
      if (article) {
        return { article, tabId: activeTab.id };
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}

async function handlePopupMessage(message: PopupToBackgroundMessage, sendResponse: (response: unknown) => void): Promise<void> {
  switch (message.type) {
    case 'get-playback-state': {
      const result = await getActiveTabArticle();
      sendResponse({ state: playbackState, hasArticle: !!result?.article });
      return;
    }
    case 'popup-start-tts': {
      const result = await getActiveTabArticle();
      if (result) {
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
        activeTabId = result.tabId;
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
          payload: { requestId, text: result.article.content, settings }
        });
      }
      sendResponse({ ok: true });
      return;
    }
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
      activeTabId = null;
      updatePlaybackState({ status: 'idle', positionSeconds: 0, durationSeconds: 0 });
      sendResponse({ ok: true });
      return;
    case 'popup-toggle-selection-mode': {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.id) {
        sendToTab(activeTab.id, { type: 'toggle-selection-mode' });
      }
      sendResponse({ ok: true });
      return;
    }
    default:
      sendResponse({ ok: false });
  }
}

async function handleContentMessage(message: ContentToBackgroundMessage, tabId?: number): Promise<void> {
  switch (message.type) {
    case 'content-ready':
      if (tabId) {
        tabArticles.set(tabId, message.article);
      }
      break;
    case 'start-tts':
      await ensureOffscreenReady();
      activeRequestId = message.payload.requestId;
      activeTabId = tabId ?? null;
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
      await postToOffscreen({ type: 'pause' });
      updatePlaybackState({ status: 'paused' });
      break;
    case 'resume-tts':
      await postToOffscreen({ type: 'resume' });
      updatePlaybackState({ status: 'playing' });
      break;
    case 'stop-tts':
      await postToOffscreen({ type: 'stop' });
      activeRequestId = null;
      activeTabId = null;
      updatePlaybackState({ status: 'idle', positionSeconds: 0, durationSeconds: 0 });
      break;
  }
}

async function handleOffscreenMessage(message: OffscreenToBackgroundMessage): Promise<void> {
  switch (message.type) {
    case 'ready':
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
      }
      break;
    case 'tts-progress':
      if (activeRequestId && message.progress.requestId === activeRequestId) {
        updatePlaybackState({
          currentChunk: message.progress.step,
          totalChunks: message.progress.totalSteps
        });
      }
      break;
    case 'tts-result':
      if (activeRequestId && message.result.requestId === activeRequestId) {
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
        // Only send highlight to the active tab
        if (activeTabId) {
          sendToTab(activeTabId, {
            type: 'highlight-chunk',
            chunkIndex: message.chunkIndex,
            chunkText: message.chunkText,
            durationMs: message.durationMs
          });
        }
      }
      break;
    case 'tts-complete':
      if (activeRequestId && message.requestId === activeRequestId) {
        // Send final highlight clear to active tab
        if (activeTabId) {
          sendToTab(activeTabId, {
            type: 'highlight-chunk',
            chunkIndex: -1,
            chunkText: '',
            durationMs: 0
          });
        }
        activeRequestId = null;
        activeTabId = null;
        updatePlaybackState({
          status: 'idle',
          positionSeconds: 0,
          durationSeconds: message.totalDuration
        });
      }
      break;
    case 'tts-error':
      console.error('[Riddi] TTS error:', message.message);
      updatePlaybackState({ status: 'error', error: message.message });
      break;
  }
}

function updatePlaybackState(partial: Partial<PlaybackState>): void {
  playbackState = { ...playbackState, ...partial };
  // Broadcast state to all tabs so popup can get updated state
  void broadcastToContent({ type: 'playback-state', state: playbackState });
}

async function postToOffscreen(message: BackgroundToOffscreenMessage): Promise<void> {
  await ensureOffscreenReady();
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    offscreenReady = false;
    offscreenReadyPromise = null;
    offscreenReadyResolver = null;
    await ensureOffscreenReady();
    await chrome.runtime.sendMessage(message);
  }
}

function sendToTab(tabId: number, message: BackgroundToContentMessage): void {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

async function broadcastToContent(message: BackgroundToContentMessage): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}

chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'get-last-article') {
    // Return article from active tab
    getActiveTabArticle().then(result => {
      sendResponse({ article: result?.article ?? null });
    });
    return true;
  }
  return false;
});
