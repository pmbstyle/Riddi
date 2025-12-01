import { Readability } from '@mozilla/readability';
import { highlightChunk, resetHighlightTracking, pauseWordAnimation, HIGHLIGHT_CLASS, setArticleElements as setHighlightElements } from './highlight';
import type { BackgroundToContentMessage, ContentToBackgroundMessage } from '@shared/messages';
import type { ArticleContent, PlaybackState, TTSRequest, TTSSettings } from '@shared/types';

const WIDGET_ID = 'riddi-widget';
const STYLES_ID = 'tts-reader-styles';

let settings: TTSSettings = {
  voice: 'M1',
  speed: 1.0,
  qualitySteps: 6,
  widgetEnabled: true
};

let article: ArticleContent | null = null;
let playbackState: PlaybackState | null = null;
let widgetRoot: HTMLDivElement | null = null;
let isWidgetExpanded = false;
let currentUrl = location.href;

let mainBtn: HTMLButtonElement | null = null;
let playBtn: HTMLButtonElement | null = null;
let pauseBtn: HTMLButtonElement | null = null;
let stopBtn: HTMLButtonElement | null = null;
let controlsPanel: HTMLDivElement | null = null;

interface TextBlock {
  text: string;
  element: HTMLElement;
  startOffset: number;
}
let textBlocks: TextBlock[] = [];

init().catch((error) => console.error('[Riddi] Failed to initialize', error));

async function init(): Promise<void> {
  injectStyles();
  await loadSettings();
  
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.ttsSettings?.newValue) {
      const newSettings = changes.ttsSettings.newValue as Partial<TTSSettings>;
      const wasEnabled = settings.widgetEnabled;
      settings = { ...settings, ...newSettings };
      
      if (wasEnabled !== settings.widgetEnabled) {
        updateWidgetVisibility();
      }
    }
  });
  
  article = extractArticle();
  if (article) {
    await notifyBackground({ type: 'content-ready', article });
  }
  
  injectWidget();
  document.addEventListener('keydown', handleShortcuts, true);
  
  chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage, _sender, sendResponse) => {
    handleRuntimeMessage(message);
    sendResponse({ ok: true });
    return true;
  });
  
  setupSPANavigationDetection();
}

function setupSPANavigationDetection(): void {
  let lastTitle = document.title;
  let lastPathname = location.pathname;
  
  window.addEventListener('popstate', () => scheduleNavigationCheck());
  window.addEventListener('hashchange', () => scheduleNavigationCheck());
  
  const observer = new MutationObserver(() => {
    if (!document.getElementById(WIDGET_ID) && settings.widgetEnabled) {
      ensureWidgetExists();
    }
    if (!document.getElementById(STYLES_ID)) {
      injectStyles();
    }
    
    const newPathname = location.pathname;
    const newTitle = document.title;
    
    if (newPathname !== lastPathname) {
      lastPathname = newPathname;
      scheduleNavigationCheck();
    } else if (newTitle !== lastTitle && newTitle.length > 0) {
      lastTitle = newTitle;
      scheduleNavigationCheck();
    }
  });
  
  observer.observe(document.documentElement, { 
    childList: true, 
    subtree: true,
    attributes: true,
    attributeFilter: ['href']
  });
  
  setInterval(() => {
    if (location.href !== currentUrl) {
      scheduleNavigationCheck();
    }
  }, 300);
}

let navigationCheckTimeout: ReturnType<typeof setTimeout> | null = null;

function scheduleNavigationCheck(): void {
  if (navigationCheckTimeout) {
    clearTimeout(navigationCheckTimeout);
  }
  navigationCheckTimeout = setTimeout(() => {
    handleNavigation();
    navigationCheckTimeout = null;
  }, 100);
}

function handleNavigation(): void {
  const newUrl = location.href;
  if (newUrl === currentUrl) return;
  
  currentUrl = newUrl;
  
  if (playbackState?.status === 'playing' || playbackState?.status === 'loading') {
    void notifyBackground({ type: 'stop-tts' });
  }
  
  resetHighlightTracking();
  playbackState = null;
  article = null;
  textBlocks = [];
  
  setTimeout(async () => {
    ensureWidgetExists();
    updateWidgetState();
    
    const newArticle = extractArticle();
    if (newArticle) {
      article = newArticle;
      await notifyBackground({ type: 'content-ready', article });
    }
  }, 500);
}

function ensureWidgetExists(): void {
  if (!document.getElementById(STYLES_ID)) {
    injectStyles();
  }
  
  if (!document.getElementById(WIDGET_ID)) {
    widgetRoot = null;
    mainBtn = null;
    playBtn = null;
    pauseBtn = null;
    stopBtn = null;
    controlsPanel = null;
    isWidgetExpanded = false;
    injectWidget();
  }
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
  } catch {
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

function updateWidgetVisibility(): void {
  if (!widgetRoot) return;
  
  if (settings.widgetEnabled) {
    widgetRoot.style.display = 'flex';
  } else {
    widgetRoot.style.display = 'none';
    isWidgetExpanded = false;
  }
}

function toggleWidgetExpanded(): void {
  if (playbackState?.status === 'loading') return;
  
  isWidgetExpanded = !isWidgetExpanded;
  updateControlsVisibility();
}

function updateControlsVisibility(): void {
  if (!controlsPanel || !mainBtn) return;
  
  if (isWidgetExpanded) {
    controlsPanel.style.display = 'flex';
    mainBtn.classList.add('riddi-btn--expanded');
  } else {
    controlsPanel.style.display = 'none';
    mainBtn.classList.remove('riddi-btn--expanded');
  }
}

function injectWidget(): void {
  if (document.getElementById(WIDGET_ID)) return;

  widgetRoot = document.createElement('div');
  widgetRoot.id = WIDGET_ID;

  controlsPanel = document.createElement('div');
  controlsPanel.className = 'riddi-controls';
  controlsPanel.style.display = 'none';

  playBtn = document.createElement('button');
  playBtn.className = 'riddi-ctrl-btn riddi-ctrl-btn--play';
  playBtn.innerHTML = '▶';
  playBtn.title = 'Play';
  playBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handlePlayPauseClick();
  });

  pauseBtn = document.createElement('button');
  pauseBtn.className = 'riddi-ctrl-btn riddi-ctrl-btn--pause';
  pauseBtn.innerHTML = '⏸';
  pauseBtn.title = 'Pause';
  pauseBtn.style.display = 'none';
  pauseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handlePlayPauseClick();
  });

  stopBtn = document.createElement('button');
  stopBtn.className = 'riddi-ctrl-btn riddi-ctrl-btn--stop';
  stopBtn.innerHTML = '⏹';
  stopBtn.title = 'Stop';
  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void notifyBackground({ type: 'stop-tts' });
    resetHighlightTracking();
  });

  controlsPanel.append(playBtn, pauseBtn, stopBtn);

  mainBtn = document.createElement('button');
  mainBtn.className = 'riddi-main-btn';
  mainBtn.title = 'Riddi TTS';
  mainBtn.addEventListener('click', toggleWidgetExpanded);

  widgetRoot.append(controlsPanel, mainBtn);
  document.body.appendChild(widgetRoot);
  
  updateWidgetVisibility();
  updateWidgetState();
}

function handlePlayPauseClick(): void {
  if (!playbackState || playbackState.status === 'idle' || playbackState.status === 'error') {
    void startPlayback();
  } else if (playbackState.status === 'playing') {
    void notifyBackground({ type: 'pause-tts' });
  } else if (playbackState.status === 'paused') {
    void notifyBackground({ type: 'resume-tts' });
  }
}

function handleRuntimeMessage(message: BackgroundToContentMessage): void {
  switch (message.type) {
    case 'playback-state':
      playbackState = message.state;
      updateWidgetState();
      if (playbackState.status === 'idle') {
        resetHighlightTracking();
      } else if (playbackState.status === 'paused') {
        pauseWordAnimation();
      }
      break;
    case 'highlight-chunk':
      if (message.chunkIndex < 0) {
        resetHighlightTracking();
      } else {
        highlightChunk(message.chunkIndex, message.chunkText, message.durationMs);
      }
      break;
    case 'widget-visibility':
      settings.widgetEnabled = message.enabled;
      updateWidgetVisibility();
      break;
  }
}

function updateWidgetState(): void {
  if (!widgetRoot || !playBtn || !pauseBtn || !mainBtn) return;
  
  const status = playbackState?.status ?? 'idle';
  widgetRoot.dataset.status = status;
  
  if (status === 'loading') {
    mainBtn.classList.add('riddi-btn--loading');
  } else {
    mainBtn.classList.remove('riddi-btn--loading');
  }
  
  if (status === 'playing') {
    playBtn.style.display = 'none';
    pauseBtn.style.display = 'flex';
    playBtn.disabled = false;
  } else {
    playBtn.style.display = 'flex';
    pauseBtn.style.display = 'none';
    
    if (status === 'paused') {
      playBtn.innerHTML = '▶';
      playBtn.title = 'Resume';
      playBtn.disabled = false;
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
  
  if (status === 'idle') {
    resetHighlightTracking();
  }
}

async function startPlayback(): Promise<void> {
  if (!article) return;
  
  resetHighlightTracking();
  await loadSettings();
  
  const request: TTSRequest = {
    requestId: crypto.randomUUID(),
    text: article.content,
    settings
  };
  
  notifyBackground({ type: 'start-tts', payload: request }).catch((error) =>
    console.error('[Riddi] Failed to start TTS', error)
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
  const isModifier = event.code.startsWith('Shift') || 
                     event.code.startsWith('Alt') || 
                     event.code.startsWith('Control') || 
                     event.code.startsWith('Meta');
  if (isModifier) return;
  
  const hasCtrl = event.ctrlKey || event.metaKey;
  if (!hasCtrl || !event.shiftKey) return;
  
  if (event.code === 'Space') {
    event.preventDefault();
    event.stopPropagation();
    
    if (playbackState?.status === 'playing') {
      void notifyBackground({ type: 'pause-tts' });
    } else if (playbackState?.status === 'paused') {
      void notifyBackground({ type: 'resume-tts' });
    } else {
      void startPlayback();
    }
    return;
  }

  if (event.code === 'KeyX') {
    event.preventDefault();
    event.stopPropagation();
    void notifyBackground({ type: 'stop-tts' });
    resetHighlightTracking();
  }
}

function injectStyles(): void {
  if (document.getElementById(STYLES_ID)) return;
  const style = document.createElement('style');
  style.id = STYLES_ID;
  
  const iconUrl = chrome.runtime.getURL('assets/riddi_icon.png');
  
  style.textContent = `
    #${WIDGET_ID} {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 0;
      font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    
    #${WIDGET_ID} .riddi-main-btn {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      border: none;
      background: url('${iconUrl}') center/cover no-repeat;
      cursor: pointer;
      transition: transform 150ms ease, box-shadow 150ms ease;
      flex-shrink: 0;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }
    #${WIDGET_ID} .riddi-main-btn:hover {
      transform: scale(1.1);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
    }
    #${WIDGET_ID} .riddi-main-btn.riddi-btn--expanded {
      transform: scale(1.05);
    }
    #${WIDGET_ID} .riddi-main-btn.riddi-btn--loading {
      cursor: not-allowed;
      opacity: 0.7;
      animation: riddi-pulse 1.5s ease-in-out infinite;
    }
    
    @keyframes riddi-pulse {
      0%, 100% { opacity: 0.7; }
      50% { opacity: 1; }
    }
    
    #${WIDGET_ID} .riddi-controls {
      display: none;
      align-items: center;
      gap: 4px;
      background: #2D2D2D;
      border-radius: 15px;
      padding: 4px 8px;
      margin-right: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      animation: riddi-slide-in 150ms ease;
    }
    
    @keyframes riddi-slide-in {
      from {
        opacity: 0;
        transform: translateX(10px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
    
    #${WIDGET_ID} .riddi-ctrl-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      background: transparent;
      color: #FFE8D2;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      transition: all 100ms ease;
    }
    #${WIDGET_ID} .riddi-ctrl-btn:hover:not(:disabled) {
      background: rgba(244, 124, 38, 0.3);
      color: #F47C26;
    }
    #${WIDGET_ID} .riddi-ctrl-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    #${WIDGET_ID} .riddi-ctrl-btn--play {
      color: #F47C26;
    }
    #${WIDGET_ID} .riddi-ctrl-btn--play:hover:not(:disabled) {
      background: rgba(244, 124, 38, 0.4);
      color: white;
    }
    #${WIDGET_ID} .riddi-ctrl-btn--pause {
      color: #F47C26;
    }
    #${WIDGET_ID} .riddi-ctrl-btn--stop:hover:not(:disabled) {
      background: rgba(239, 68, 68, 0.3);
      color: #ef4444;
    }
    
    .${HIGHLIGHT_CLASS} {
      background: linear-gradient(135deg, rgba(244, 124, 38, 0.12), rgba(255, 232, 210, 0.06)) !important;
      border-left: 3px solid rgba(244, 124, 38, 0.6) !important;
      padding-left: 8px !important;
      margin-left: -11px !important;
      transition: background 200ms ease !important;
    }
    
    .riddi-word {
      transition: all 100ms ease !important;
      border-radius: 3px !important;
    }
    
    .riddi-highlight-word {
      background: linear-gradient(135deg, rgba(244, 124, 38, 0.5), rgba(255, 232, 210, 0.4)) !important;
      color: #2D2D2D !important;
      padding: 1px 3px !important;
      margin: -1px -3px !important;
      border-radius: 4px !important;
      box-shadow: 0 0 0 2px rgba(244, 124, 38, 0.3), 0 2px 8px rgba(244, 124, 38, 0.25) !important;
      animation: riddi-word-pulse 400ms ease-in-out !important;
    }
    
    @keyframes riddi-word-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.02); }
    }
  `;
  document.head.appendChild(style);
}
