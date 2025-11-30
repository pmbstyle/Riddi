import { Readability } from '@mozilla/readability';
import { highlightChunk, resetHighlightTracking, HIGHLIGHT_CLASS, setArticleElements as setHighlightElements } from './highlight';
import type { BackgroundToContentMessage, ContentToBackgroundMessage } from '@shared/messages';
import type { ArticleContent, PlaybackState, TTSRequest, TTSSettings } from '@shared/types';

const WIDGET_ID = 'riddi-widget';
const APP_NAME = 'Riddi';
const SHORTCUT_PLAY_PAUSE = { ctrlKey: false, metaKey: true, shiftKey: true, key: 'R' }; // Cmd/Ctrl+Shift+R
const SHORTCUT_STOP = { ctrlKey: false, metaKey: true, shiftKey: true, key: 'X' }; // Cmd/Ctrl+Shift+X

let settings: TTSSettings = {
  voice: 'M1',
  speed: 1.0,
  qualitySteps: 6,
  autoStart: false
};

let article: ArticleContent | null = null;
let playbackState: PlaybackState | null = null;
let widgetRoot: HTMLDivElement | null = null;

// Widget button references for reactive updates
let playBtn: HTMLButtonElement | null = null;
let pauseBtn: HTMLButtonElement | null = null;
let stopBtn: HTMLButtonElement | null = null;
let statusLabel: HTMLSpanElement | null = null;

// Track text blocks with their DOM elements for reliable highlighting
interface TextBlock {
  text: string;
  element: HTMLElement;
  startOffset: number; // character offset in full content
}
let textBlocks: TextBlock[] = [];

init().catch((error) => console.error('Failed to initialize content script', error));

async function init(): Promise<void> {
  injectStyles();
  await loadSettings();
  
  // Listen for settings changes from popup
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.ttsSettings?.newValue) {
      const newSettings = changes.ttsSettings.newValue as Partial<TTSSettings>;
      settings = { ...settings, ...newSettings };
      console.log('[Riddi] Settings updated:', settings);
    }
  });
  
  article = extractArticle();
  if (article) {
    await notifyBackground({ type: 'content-ready', article });
  }
  injectWidget();
  chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage, _sender, sendResponse) => {
    handleRuntimeMessage(message);
    sendResponse({ ok: true });
    return true;
  });
}

function extractArticle(): ArticleContent | null {
  try {
    const cloned = document.cloneNode(true) as Document;
    const reader = new Readability(cloned);
    const parsed = reader.parse();

    if (!parsed) throw new Error('Readability returned null');

    const htmlContent = parsed.content || '';
    const plainContent = parsed.textContent?.trim() || '';
    
    textBlocks = extractBlocksFromReadabilityHTML(htmlContent, plainContent);
    
    // Join blocks with double newline so TTS chunker respects paragraph boundaries
    const content = textBlocks.length > 0 
      ? textBlocks.map(b => b.text).join('\n\n')
      : plainContent;
    
    setHighlightElements(textBlocks, content);

    return {
      title: parsed.title ?? document.title,
      byline: parsed.byline ?? undefined,
      content,
      sentences: splitIntoSentences(content)
    };
  } catch (error) {
    console.warn('Readability parsing failed, falling back to body text', error);
    
    textBlocks = extractTextBlocksFallback(document.body);
    const content = textBlocks.map(b => b.text).join(' ');
    setHighlightElements(textBlocks, content);
    
    return {
      title: document.title,
      content,
      sentences: splitIntoSentences(content)
    };
  }
}

function extractBlocksFromReadabilityHTML(htmlContent: string, plainContent: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlContent, 'text/html');
  const readabilityBlocks = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote');
  
  const normalizedPlain = normalizeForMatching(plainContent);
  const matchedElements = new Set<HTMLElement>();
  const seenText = new Set<string>();
  let currentOffset = 0;
  
  for (const readabilityBlock of readabilityBlocks) {
    const blockText = readabilityBlock.textContent?.trim() || '';
    if (blockText.length < 10) continue;
    
    const normalizedBlock = normalizeForMatching(blockText);
    const textKey = normalizedBlock.substring(0, 50);
    
    // Skip duplicates (e.g., blockquote > p with same text)
    if (seenText.has(textKey)) continue;
    seenText.add(textKey);
    
    const realElement = findMatchingRealElement(blockText, matchedElements);
    
    if (realElement) {
      matchedElements.add(realElement);
      const posInContent = normalizedPlain.indexOf(normalizedBlock, currentOffset > 0 ? currentOffset - 20 : 0);
      const elementText = realElement.innerText.trim() || blockText;
      
      blocks.push({
        text: elementText,
        element: realElement,
        startOffset: posInContent !== -1 ? posInContent : currentOffset
      });
      
      if (posInContent !== -1) {
        currentOffset = posInContent + normalizedBlock.length;
      }
    }
  }
  
  return blocks.sort((a, b) => a.startOffset - b.startOffset);
}

function findMatchingRealElement(blockText: string, alreadyMatched: Set<HTMLElement>): HTMLElement | null {
  const normalizedBlock = normalizeForMatching(blockText);
  const blockStart = normalizedBlock.substring(0, Math.min(40, normalizedBlock.length));
  const blockLength = normalizedBlock.length;
  
  const candidates = document.body.querySelectorAll<HTMLElement>(
    'p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption'
  );
  
  let bestMatch: HTMLElement | null = null;
  let bestScore = 0;
  
  for (const el of candidates) {
    if (alreadyMatched.has(el)) continue;
    if (el.offsetParent === null) continue;
    if (el.closest('#riddi-widget, nav, footer, aside, header, [role="navigation"]')) continue;
    
    const elText = (el.textContent || '').trim();
    if (elText.length < 10) continue;
    
    const normalizedEl = normalizeForMatching(elText);
    const elLength = normalizedEl.length;
    
    if (elLength > blockLength * 3) continue;
    
    let score = 0;
    
    if (normalizedEl.startsWith(blockStart.substring(0, 20))) {
      score = 100;
    } else if (normalizedEl.includes(blockStart)) {
      score = 70;
    } else if (normalizedBlock.includes(normalizedEl.substring(0, 30))) {
      score = 50;
    }
    
    if (score > 0) {
      const sizeDiff = Math.abs(elLength - blockLength) / blockLength;
      if (sizeDiff < 0.3) score += 20;
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = el;
      }
    }
  }
  
  return bestMatch;
}

function normalizeForMatching(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '').trim();
}

function isNavigationElement(el: HTMLElement, text: string): boolean {
  if (!el.parentElement) return false;
  if (el.closest('nav, [role="navigation"]')) return true;
  if (el.tagName === 'A') return true;
  
  const linkText = Array.from(el.querySelectorAll('a')).map(a => a.innerText).join('');
  if (linkText.length > text.length * 0.8) return true;
  
  if (el.tagName === 'LI' && text.length < 60 && el.querySelector('a')) return true;
  
  let ancestor: HTMLElement | null = el.parentElement;
  for (let i = 0; i < 5 && ancestor; i++) {
    const className = ancestor.className?.toLowerCase() || '';
    if (/nav|menu|sidebar|toc/.test(className)) return true;
    ancestor = ancestor.parentElement;
  }
  
  return false;
}

function extractTextBlocksFallback(container: HTMLElement): TextBlock[] {
  const blocks: TextBlock[] = [];
  let currentOffset = 0;
  
  for (const el of container.querySelectorAll<HTMLElement>('p, h1, h2, h3, h4, h5, h6, blockquote, figcaption')) {
    if (el.offsetParent === null) continue;
    if (el.closest('#riddi-widget, nav, footer, aside, script, style')) continue;
    if (isNavigationElement(el, el.innerText)) continue;
    
    const text = el.innerText.trim();
    if (text.length < 15) continue;
    
    blocks.push({ text, element: el, startOffset: currentOffset });
    currentOffset += text.length + 1;
  }
  
  if (blocks.length === 0) {
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest('script, style, noscript, nav, footer, #riddi-widget')) {
            return NodeFilter.FILTER_REJECT;
          }
          return (node.textContent?.trim().length ?? 0) >= 20 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );
    
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const parent = node.parentElement;
      if (!parent) continue;
      
      const text = node.textContent?.trim() ?? '';
      blocks.push({ text, element: parent, startOffset: currentOffset });
      currentOffset += text.length + 1;
    }
  }
  
  return blocks;
}

function injectWidget(): void {
  if (document.getElementById(WIDGET_ID)) return;

  widgetRoot = document.createElement('div');
  widgetRoot.id = WIDGET_ID;

  const header = document.createElement('div');
  header.className = 'tts-reader-widget__header';
  
  const title = document.createElement('span');
  title.textContent = APP_NAME;
  
  statusLabel = document.createElement('span');
  statusLabel.className = 'tts-reader-widget__status';
  statusLabel.textContent = 'Ready';
  
  header.append(title, statusLabel);

  const controls = document.createElement('div');
  controls.className = 'tts-reader-widget__controls';

  playBtn = document.createElement('button');
  playBtn.className = 'tts-btn tts-btn--play';
  playBtn.innerHTML = '▶';
  playBtn.title = 'Play';
  playBtn.addEventListener('click', handlePlayPauseClick);

  pauseBtn = document.createElement('button');
  pauseBtn.className = 'tts-btn tts-btn--pause';
  pauseBtn.innerHTML = '⏸';
  pauseBtn.title = 'Pause';
  pauseBtn.style.display = 'none';
  pauseBtn.addEventListener('click', handlePlayPauseClick);

  stopBtn = document.createElement('button');
  stopBtn.className = 'tts-btn tts-btn--stop';
  stopBtn.innerHTML = '⏹';
  stopBtn.title = 'Stop';
  stopBtn.addEventListener('click', () => {
    void notifyBackground({ type: 'stop-tts' });
    resetHighlightTracking();
  });

  controls.append(playBtn, pauseBtn, stopBtn);

  widgetRoot.append(header, controls);
  document.body.appendChild(widgetRoot);

  window.addEventListener('keydown', handleShortcuts, { passive: true });
  
  // Initial state update
  updateWidgetState();
}

function handlePlayPauseClick(): void {
  if (!playbackState || playbackState.status === 'idle' || playbackState.status === 'error') {
    void startPlayback();
  } else if (playbackState.status === 'playing') {
    void notifyBackground({ type: 'pause-tts' });
  } else if (playbackState.status === 'paused') {
    void notifyBackground({ type: 'resume-tts' });
  } else if (playbackState.status === 'loading') {
    // Already loading, do nothing
  }
}

function handleRuntimeMessage(message: BackgroundToContentMessage): void {
  console.log('[Riddi] Content received message:', message.type);
  switch (message.type) {
    case 'playback-state':
      playbackState = message.state;
      updateWidgetState();
      // Clear highlights when idle
      if (playbackState.status === 'idle') {
        resetHighlightTracking();
      }
      break;
    case 'highlight-chunk':
      // Highlight the chunk text on the actual page using chunk index
      console.log('[Riddi] Received highlight-chunk:', message.chunkIndex, 'text:', message.chunkText.substring(0, 30));
      if (message.chunkIndex < 0) {
        // Negative index means clear all highlights
        resetHighlightTracking();
      } else {
        highlightChunk(message.chunkIndex, message.chunkText, settings.speed);
      }
      break;
    default:
      break;
  }
}

function updateWidgetState(): void {
  if (!widgetRoot || !playBtn || !pauseBtn || !statusLabel) return;
  
  const status = playbackState?.status ?? 'idle';
  widgetRoot.dataset.status = status;
  
  // Update status label
  const statusLabels: Record<string, string> = {
    idle: 'Ready',
    loading: 'Loading...',
    playing: 'Playing',
    paused: 'Paused',
    error: 'Error'
  };
  statusLabel.textContent = statusLabels[status] ?? status;
  statusLabel.className = `tts-reader-widget__status tts-reader-widget__status--${status}`;
  
  // Update button visibility and states
  if (status === 'playing') {
    playBtn.style.display = 'none';
    pauseBtn.style.display = 'flex';
  } else {
    playBtn.style.display = 'flex';
    pauseBtn.style.display = 'none';
    
    // Change play button icon based on state
    if (status === 'paused') {
      playBtn.innerHTML = '▶';
      playBtn.title = 'Resume';
    } else if (status === 'loading') {
      playBtn.innerHTML = '⏳';
      playBtn.title = 'Loading...';
      playBtn.disabled = true;
    } else {
      playBtn.innerHTML = '▶';
      playBtn.title = 'Play';
      playBtn.disabled = false;
    }
  }
  
  // Reset highlights when stopped
  if (status === 'idle') {
    resetHighlightTracking();
  }
}

async function startPlayback(): Promise<void> {
  if (!article) return;
  
  // Reset highlight tracking for new playback
  resetHighlightTracking();
  
  // Reload settings before starting to ensure we have the latest
  await loadSettings();
  
  const request: TTSRequest = {
    requestId: crypto.randomUUID(),
    text: article.content,
    settings
  };
  
  console.log('[Riddi] Starting playback with settings:', settings);
  
  notifyBackground({ type: 'start-tts', payload: request }).catch((error) =>
    console.error('Failed to start TTS', error)
  );
}

async function notifyBackground(message: ContentToBackgroundMessage): Promise<void> {
  await chrome.runtime.sendMessage(message);
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function loadSettings(): Promise<void> {
  const saved = await chrome.storage.sync.get(['ttsSettings']);
  if (saved?.ttsSettings) {
    settings = { ...settings, ...(saved.ttsSettings as Partial<TTSSettings>) };
  }
}

function handleShortcuts(event: KeyboardEvent): void {
  const key = event.key.toUpperCase();
  const isMeta = navigator.platform.toLowerCase().includes('mac');
  const matches = (shortcut: typeof SHORTCUT_PLAY_PAUSE) =>
    event.shiftKey === shortcut.shiftKey &&
    (isMeta ? event.metaKey : event.ctrlKey) === true &&
    key === shortcut.key;

  if (matches(SHORTCUT_PLAY_PAUSE)) {
    event.preventDefault();
    if (playbackState?.status === 'playing') {
      void notifyBackground({ type: 'pause-tts' });
    } else if (playbackState?.status === 'paused') {
      void notifyBackground({ type: 'resume-tts' });
    } else {
      void startPlayback();
    }
    return;
  }

  if (matches(SHORTCUT_STOP)) {
    event.preventDefault();
    void notifyBackground({ type: 'stop-tts' });
    resetHighlightTracking();
  }
}

function injectStyles(): void {
  if (document.getElementById('tts-reader-styles')) return;
  const style = document.createElement('style');
  style.id = 'tts-reader-styles';
  style.textContent = `
    /* Widget styles */
    #${WIDGET_ID} {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      background: #0f172a;
      color: #e2e8f0;
      border-radius: 14px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255,255,255,0.05);
      overflow: hidden;
      font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #${WIDGET_ID} .tts-reader-widget__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 0.02em;
      background: linear-gradient(135deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02));
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    #${WIDGET_ID} .tts-reader-widget__status {
      font-size: 11px;
      font-weight: 500;
      padding: 3px 8px;
      border-radius: 10px;
      background: rgba(255,255,255,0.08);
      color: #94a3b8;
    }
    #${WIDGET_ID} .tts-reader-widget__status--playing {
      background: rgba(34, 197, 94, 0.2);
      color: #4ade80;
    }
    #${WIDGET_ID} .tts-reader-widget__status--loading {
      background: rgba(234, 179, 8, 0.2);
      color: #facc15;
    }
    #${WIDGET_ID} .tts-reader-widget__status--paused {
      background: rgba(14, 165, 233, 0.2);
      color: #38bdf8;
    }
    #${WIDGET_ID} .tts-reader-widget__status--error {
      background: rgba(239, 68, 68, 0.2);
      color: #f87171;
    }
    #${WIDGET_ID} .tts-reader-widget__controls {
      display: flex;
      gap: 6px;
      padding: 10px 12px;
    }
    #${WIDGET_ID} .tts-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      background: #1e293b;
      color: #e2e8f0;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      cursor: pointer;
      font-size: 16px;
      transition: all 150ms ease;
    }
    #${WIDGET_ID} .tts-btn:hover:not(:disabled) {
      background: #0ea5e9;
      color: #fff;
      border-color: #0ea5e9;
      transform: scale(1.05);
    }
    #${WIDGET_ID} .tts-btn:active:not(:disabled) {
      transform: scale(0.95);
    }
    #${WIDGET_ID} .tts-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    #${WIDGET_ID} .tts-btn--play {
      background: linear-gradient(135deg, #0ea5e9, #0284c7);
      border-color: #0ea5e9;
      color: #fff;
    }
    #${WIDGET_ID} .tts-btn--play:hover:not(:disabled) {
      background: linear-gradient(135deg, #38bdf8, #0ea5e9);
    }
    #${WIDGET_ID} .tts-btn--stop:hover:not(:disabled) {
      background: #ef4444;
      border-color: #ef4444;
    }
    
    /* Page highlight styles - chunk container */
    .${HIGHLIGHT_CLASS} {
      background: linear-gradient(135deg, rgba(14, 165, 233, 0.12), rgba(56, 189, 248, 0.06)) !important;
      border-left: 3px solid rgba(14, 165, 233, 0.6) !important;
      padding-left: 8px !important;
      margin-left: -11px !important;
      transition: background 200ms ease !important;
    }
    
    /* Word-by-word highlight */
    .riddi-word {
      transition: all 100ms ease !important;
      border-radius: 3px !important;
    }
    
    .riddi-highlight-word {
      background: linear-gradient(135deg, rgba(14, 165, 233, 0.5), rgba(56, 189, 248, 0.4)) !important;
      color: #0c4a6e !important;
      padding: 1px 3px !important;
      margin: -1px -3px !important;
      border-radius: 4px !important;
      box-shadow: 0 0 0 2px rgba(14, 165, 233, 0.3), 0 2px 8px rgba(14, 165, 233, 0.25) !important;
    }
    
    /* Pulse animation on current word */
    @keyframes riddi-word-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.02); }
    }
    .riddi-highlight-word {
      animation: riddi-word-pulse 400ms ease-in-out !important;
    }
  `;
  document.head.appendChild(style);
}
