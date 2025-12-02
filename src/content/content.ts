import { Readability } from '@mozilla/readability';
import { highlightChunk, resetHighlightTracking, pauseWordAnimation, HIGHLIGHT_CLASS, setArticleElements as setHighlightElements } from './highlight';
import type { BackgroundToContentMessage, ContentToBackgroundMessage } from '@shared/messages';
import type { ArticleContent, PlaybackState, TTSRequest, TTSSettings } from '@shared/types';

const WIDGET_ID = 'riddi-widget';
const STYLES_ID = 'tts-reader-styles';
const SELECTION_MODE_CLASS = 'riddi-selection-mode-active';
const SELECTION_HOVER_CLASS = 'riddi-selection-hover';

// SVG Icons
const ICON_SELECT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>`;
const ICON_PLAY = `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>`;
const ICON_STOP = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`;
const ICON_LOADING = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;

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

// Selection mode state
let isSelectionModeActive = false;
let currentHoveredElement: HTMLElement | null = null;
let selectBtn: HTMLButtonElement | null = null;

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
  
  // Disable selection mode on navigation
  if (isSelectionModeActive) {
    disableSelectionMode();
  }
  
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
    selectBtn = null;
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

  selectBtn = document.createElement('button');
  selectBtn.className = 'riddi-ctrl-btn riddi-ctrl-btn--select';
  selectBtn.innerHTML = ICON_SELECT;
  selectBtn.title = 'Select text block (Ctrl+Shift+S)';
  selectBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSelectionMode();
  });

  playBtn = document.createElement('button');
  playBtn.className = 'riddi-ctrl-btn riddi-ctrl-btn--play';
  playBtn.innerHTML = ICON_PLAY;
  playBtn.title = 'Play';
  playBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handlePlayPauseClick();
  });

  pauseBtn = document.createElement('button');
  pauseBtn.className = 'riddi-ctrl-btn riddi-ctrl-btn--pause';
  pauseBtn.innerHTML = ICON_PAUSE;
  pauseBtn.title = 'Pause';
  pauseBtn.style.display = 'none';
  pauseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handlePlayPauseClick();
  });

  stopBtn = document.createElement('button');
  stopBtn.className = 'riddi-ctrl-btn riddi-ctrl-btn--stop';
  stopBtn.innerHTML = ICON_STOP;
  stopBtn.title = 'Stop';
  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void notifyBackground({ type: 'stop-tts' });
    resetHighlightTracking();
  });

  controlsPanel.append(selectBtn, playBtn, pauseBtn, stopBtn);

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

// Selection Mode Functions
function toggleSelectionMode(): void {
  if (isSelectionModeActive) {
    disableSelectionMode();
  } else {
    enableSelectionMode();
  }
}

function enableSelectionMode(): void {
  if (isSelectionModeActive) return;
  
  // Stop any active playback first
  if (playbackState?.status === 'playing' || playbackState?.status === 'loading') {
    void notifyBackground({ type: 'stop-tts' });
    resetHighlightTracking();
  }
  
  isSelectionModeActive = true;
  document.body.classList.add(SELECTION_MODE_CLASS);
  
  document.addEventListener('mousemove', handleSelectionMouseMove, true);
  document.addEventListener('click', handleSelectionClick, true);
  document.addEventListener('keydown', handleSelectionKeydown, true);
  
  updateSelectionButtonState();
}

function disableSelectionMode(): void {
  if (!isSelectionModeActive) return;
  
  isSelectionModeActive = false;
  document.body.classList.remove(SELECTION_MODE_CLASS);
  
  if (currentHoveredElement) {
    currentHoveredElement.classList.remove(SELECTION_HOVER_CLASS);
    currentHoveredElement = null;
  }
  
  document.removeEventListener('mousemove', handleSelectionMouseMove, true);
  document.removeEventListener('click', handleSelectionClick, true);
  document.removeEventListener('keydown', handleSelectionKeydown, true);
  
  updateSelectionButtonState();
}

function handleSelectionKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    disableSelectionMode();
  }
}

function handleSelectionMouseMove(event: MouseEvent): void {
  if (!isSelectionModeActive) return;
  
  const target = event.target as HTMLElement;
  if (!target || target.closest(`#${WIDGET_ID}`)) return;
  
  const selectableElement = findSelectableElement(target);
  
  if (selectableElement !== currentHoveredElement) {
    if (currentHoveredElement) {
      currentHoveredElement.classList.remove(SELECTION_HOVER_CLASS);
    }
    
    currentHoveredElement = selectableElement;
    
    if (currentHoveredElement) {
      currentHoveredElement.classList.add(SELECTION_HOVER_CLASS);
    }
  }
}

function handleSelectionClick(event: MouseEvent): void {
  if (!isSelectionModeActive) return;
  
  const target = event.target as HTMLElement;
  
  // Ignore clicks on widget
  if (target.closest(`#${WIDGET_ID}`)) return;
  
  event.preventDefault();
  event.stopPropagation();
  
  const selectableElement = findSelectableElement(target);
  
  if (selectableElement) {
    const extractedArticle = extractArticleFromElement(selectableElement);
    
    if (extractedArticle && extractedArticle.content.trim().length > 10) {
      // Update the article with selected content
      article = extractedArticle;
      
      // Disable selection mode
      disableSelectionMode();
      
      // Auto-start TTS with selected content
      void startPlayback();
    }
  }
}

function findSelectableElement(target: HTMLElement): HTMLElement | null {
  if (target.closest(`#${WIDGET_ID}`)) return null;
  
  let element: HTMLElement | null = target;
  
  while (element && element !== document.body) {
    // Skip tiny elements
    if (element.offsetWidth < 50 || element.offsetHeight < 20) {
      element = element.parentElement;
      continue;
    }
    
    // Skip hidden elements
    if (element.offsetParent === null && element.tagName !== 'BODY') {
      element = element.parentElement;
      continue;
    }
    
    // Skip excluded elements
    if (element.closest('nav, footer, header, aside, [role="navigation"], [role="banner"], script, style, noscript')) {
      element = element.parentElement;
      continue;
    }
    
    // Check if it's a good text container
    const text = element.innerText?.trim() || '';
    if (text.length >= 10) {
      const tagLower = element.tagName.toLowerCase();
      if (['article', 'main', 'section', 'p', 'blockquote', 'pre'].includes(tagLower)) {
        return element;
      }
      
      if (['div', 'span'].includes(tagLower)) {
        const parent = element.parentElement;
        if (parent && ['article', 'main', 'section'].includes(parent.tagName.toLowerCase())) {
          return parent;
        }
        return element;
      }
      
      if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'figcaption'].includes(tagLower)) {
        return element;
      }
    }
    
    element = element.parentElement;
  }
  
  return null;
}

function extractArticleFromElement(element: HTMLElement): ArticleContent | null {
  try {
    const wrapper = document.createElement('div');
    wrapper.appendChild(element.cloneNode(true));
    
    const doc = document.implementation.createHTMLDocument('Selected Content');
    doc.body.innerHTML = wrapper.innerHTML;
    
    const reader = new Readability(doc);
    const parsed = reader.parse();
    
    if (parsed && parsed.textContent?.trim()) {
      const plainContent = parsed.textContent?.trim() || '';
      
      textBlocks = extractBlocksFromSelectedElement(element);
      
      const content = textBlocks.length > 0 
        ? textBlocks.map(b => b.text).join('\n\n')
        : plainContent;
      
      setHighlightElements(textBlocks, content);
      
      return {
        title: document.title,
        content,
        sentences: splitIntoSentences(content)
      };
    }
    
    return extractArticleFallback(element);
  } catch {
    return extractArticleFallback(element);
  }
}

function extractArticleFallback(element: HTMLElement): ArticleContent | null {
  textBlocks = extractBlocksFromSelectedElement(element);
  
  if (textBlocks.length === 0) {
    const text = element.innerText?.trim();
    if (text && text.length >= 10) {
      textBlocks = [{ text, element, startOffset: 0 }];
    }
  }
  
  if (textBlocks.length === 0) return null;
  
  const content = textBlocks.map(b => b.text).join('\n\n');
  setHighlightElements(textBlocks, content);
  
  return {
    title: document.title,
    content,
    sentences: splitIntoSentences(content)
  };
}

function extractBlocksFromSelectedElement(container: HTMLElement): TextBlock[] {
  const blocks: TextBlock[] = [];
  let currentOffset = 0;
  
  const containerTag = container.tagName.toLowerCase();
  if (['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'figcaption', 'li'].includes(containerTag)) {
    const text = container.innerText?.trim();
    if (text && text.length >= 10) {
      return [{ text, element: container, startOffset: 0 }];
    }
  }
  
  for (const el of container.querySelectorAll<HTMLElement>('p, h1, h2, h3, h4, h5, h6, blockquote, figcaption, li')) {
    if (el.offsetParent === null) continue;
    if (el.closest('nav, footer, aside, script, style')) continue;
    if (isNavigationElement(el, el.innerText)) continue;
    
    const text = el.innerText?.trim();
    if (!text || text.length < 10) continue;
    
    blocks.push({ text, element: el, startOffset: currentOffset });
    currentOffset += text.length + 2;
  }
  
  return blocks;
}

function updateSelectionButtonState(): void {
  if (!selectBtn) return;
  
  if (isSelectionModeActive) {
    selectBtn.classList.add('riddi-ctrl-btn--active');
    selectBtn.title = 'Cancel selection (Esc)';
  } else {
    selectBtn.classList.remove('riddi-ctrl-btn--active');
    selectBtn.title = 'Select text block (Ctrl+Shift+S)';
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
    case 'toggle-selection-mode':
      toggleSelectionMode();
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
      playBtn.innerHTML = ICON_PLAY;
      playBtn.title = 'Resume';
      playBtn.disabled = false;
    } else if (status === 'loading') {
      playBtn.innerHTML = ICON_LOADING;
      playBtn.classList.add('riddi-ctrl-btn--loading');
      playBtn.title = 'Loading...';
      playBtn.disabled = true;
    } else {
      playBtn.innerHTML = ICON_PLAY;
      playBtn.classList.remove('riddi-ctrl-btn--loading');
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
    return;
  }

  if (event.code === 'KeyS') {
    event.preventDefault();
    event.stopPropagation();
    toggleSelectionMode();
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
      transition: all 100ms ease;
    }
    #${WIDGET_ID} .riddi-ctrl-btn svg {
      width: 14px;
      height: 14px;
    }
    #${WIDGET_ID} .riddi-ctrl-btn--loading svg {
      animation: riddi-spin 1s linear infinite;
    }
    @keyframes riddi-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
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
    
    #${WIDGET_ID} .riddi-ctrl-btn--select {
      color: #FFE8D2;
    }
    #${WIDGET_ID} .riddi-ctrl-btn--select:hover:not(:disabled) {
      background: rgba(244, 124, 38, 0.3);
      color: #F47C26;
    }
    #${WIDGET_ID} .riddi-ctrl-btn--select.riddi-ctrl-btn--active {
      background: rgba(244, 124, 38, 0.5);
      color: #F47C26;
      box-shadow: 0 0 0 2px rgba(244, 124, 38, 0.3);
    }
    
    /* Selection Mode Styles */
    .${SELECTION_MODE_CLASS} {
      cursor: crosshair !important;
    }
    
    .${SELECTION_MODE_CLASS} * {
      cursor: crosshair !important;
    }
    
    .${SELECTION_HOVER_CLASS} {
      outline: 2px solid rgba(244, 124, 38, 0.8) !important;
      outline-offset: 2px !important;
      background-color: rgba(244, 124, 38, 0.1) !important;
      transition: outline 100ms ease, background-color 100ms ease !important;
      border-radius: 4px !important;
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
