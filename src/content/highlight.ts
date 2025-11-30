export const HIGHLIGHT_CLASS = 'riddi-highlight';
export const HIGHLIGHT_WORD_CLASS = 'riddi-highlight-word';

interface TextBlock {
  text: string;
  element: HTMLElement;
  startOffset: number;
}

let articleTextBlocks: TextBlock[] = [];
let currentHighlightElements: HTMLElement[] = [];
let originalHTMLMap = new Map<HTMLElement, string>();
let wordHighlightTimeout: ReturnType<typeof setTimeout> | null = null;
let currentWordIndex = 0;
let currentWords: HTMLElement[] = [];
let currentChunkIndex = -1;

export function setArticleElements(blocks: TextBlock[], _fullContent?: string): void {
  articleTextBlocks = blocks;
  currentHighlightElements = [];
  originalHTMLMap.clear();
  currentChunkIndex = -1;
}

export function highlightChunk(chunkIndex: number, chunkText: string, durationMs: number): void {
  clearPageHighlights();
  
  if (!chunkText?.trim()) return;
  
  currentChunkIndex = chunkIndex;
  const matchingBlock = findBestMatchingBlock(chunkText);
  
  if (matchingBlock) {
    highlightElement(matchingBlock.element);
    wrapWordsInElement(matchingBlock.element);
    
    if (currentWords.length === 0) {
      clearPageHighlights();
      fallbackHighlight(chunkText, durationMs);
      return;
    }
    
    const startWordIndex = findChunkStartWordIndex(chunkText);
    startWordAnimation(durationMs, startWordIndex);
    matchingBlock.element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else {
    fallbackHighlight(chunkText, durationMs);
  }
}

function findChunkStartWordIndex(chunkText: string): number {
  if (currentWords.length === 0) return 0;
  
  const chunkWords = chunkText.trim().split(/\s+/).slice(0, 5);
  if (chunkWords.length === 0) return 0;
  
  const firstChunkWord = chunkWords[0].toLowerCase().replace(/[^\w']/g, '');
  
  for (let i = 0; i < currentWords.length; i++) {
    const wordText = (currentWords[i].textContent || '').toLowerCase().replace(/[^\w']/g, '');
    
    if (wordText === firstChunkWord || wordText.startsWith(firstChunkWord) || firstChunkWord.startsWith(wordText)) {
      let matches = 1;
      for (let j = 1; j < Math.min(chunkWords.length, 4); j++) {
        if (i + j < currentWords.length) {
          const nextWordText = (currentWords[i + j].textContent || '').toLowerCase().replace(/[^\w']/g, '');
          const nextChunkWord = chunkWords[j].toLowerCase().replace(/[^\w']/g, '');
          if (nextWordText === nextChunkWord || nextWordText.startsWith(nextChunkWord) || nextChunkWord.startsWith(nextWordText)) {
            matches++;
          }
        }
      }
      
      if (matches >= 2 || chunkWords.length === 1) {
        return i;
      }
    }
  }
  
  return 0;
}

function findBestMatchingBlock(chunkText: string): TextBlock | null {
  const normalizedChunk = normalizeText(chunkText);
  const chunkStart = normalizedChunk.substring(0, Math.min(40, normalizedChunk.length));
  const chunkLength = normalizedChunk.length;
  
  let bestBlock: TextBlock | null = null;
  let bestScore = 0;
  
  for (const block of articleTextBlocks) {
    const normalizedBlock = normalizeText(block.text);
    const blockLength = normalizedBlock.length;
    
    const isHeading = block.element.tagName.match(/^H[1-6]$/);
    if (blockLength < 5) continue;
    if (blockLength < 20 && !isHeading) continue;
    
    const blockStart = normalizedBlock.substring(0, Math.min(40, normalizedBlock.length));
    
    let score = 0;
    
    if (normalizedBlock.startsWith(chunkStart.substring(0, 20))) {
      score = 100;
    } else if (normalizedChunk.startsWith(blockStart.substring(0, 20))) {
      score = 90;
    } else if (normalizedBlock.includes(chunkStart.substring(0, 20))) {
      score = 80;
    } else if (normalizedChunk.includes(blockStart)) {
      score = 40;
    }
    
    if (score > 0) {
      if (score !== 80) {
        const sizeDiff = Math.abs(blockLength - chunkLength) / chunkLength;
        if (sizeDiff < 0.3) score += 30;
        else if (sizeDiff < 0.7) score += 15;
        else if (sizeDiff > 2) score -= 10;
      }
      
      if (block.element.tagName.match(/^(P|H[1-6]|LI|BLOCKQUOTE)$/i)) {
        score += 10;
      }
    }
    
    if (score > bestScore) {
      bestScore = score;
      bestBlock = block;
    }
  }
  
  return bestBlock && bestScore >= 50 ? bestBlock : null;
}

export function highlightChunkByIndex(chunkText: string, durationMs: number): void {
  highlightChunk(currentChunkIndex + 1, chunkText, durationMs);
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function highlightElement(element: HTMLElement): void {
  if (!originalHTMLMap.has(element)) {
    originalHTMLMap.set(element, element.innerHTML);
  }
  currentHighlightElements.push(element);
  element.classList.add(HIGHLIGHT_CLASS);
}

function wrapWordsInElement(container: HTMLElement): void {
  currentWords = [];
  currentWordIndex = 0;
  
  if (!document.body.contains(container)) return;
  if (!container.classList.contains(HIGHLIGHT_CLASS)) {
    container.classList.add(HIGHLIGHT_CLASS);
  }
  
  const containerText = container.textContent || '';
  if (!containerText.trim()) return;
  
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (['SCRIPT', 'STYLE', 'SVG'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.classList.contains('riddi-word')) return NodeFilter.FILTER_REJECT;
        if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  
  const textNodes: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    textNodes.push(node);
  }
  
  for (const textNode of textNodes) {
    const text = textNode.textContent ?? '';
    const parent = textNode.parentElement;
    if (!parent || !text.trim()) continue;
    
    const parts = text.split(/(\s+)/);
    if (parts.length <= 1 && !/\s/.test(text)) {
      if (text.trim()) {
        const span = document.createElement('span');
        span.className = 'riddi-word';
        span.textContent = text;
        parent.replaceChild(span, textNode);
        currentWords.push(span);
      }
      continue;
    }
    
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      if (/^\s+$/.test(part)) {
        fragment.appendChild(document.createTextNode(part));
      } else if (part.length > 0) {
        const span = document.createElement('span');
        span.className = 'riddi-word';
        span.textContent = part;
        fragment.appendChild(span);
        currentWords.push(span);
      }
    }
    parent.replaceChild(fragment, textNode);
  }
}

function startWordAnimation(durationMs: number, startIndex = 0): void {
  if (wordHighlightTimeout) clearTimeout(wordHighlightTimeout);
  
  currentWordIndex = startIndex;
  
  // Calculate words remaining from startIndex
  const wordsToAnimate = currentWords.length - startIndex;
  if (wordsToAnimate <= 0) return;
  
  // Calculate ms per word from actual audio duration
  // Use a minimum of 100ms to avoid too-fast animation
  const msPerWord = Math.max(100, Math.round(durationMs / wordsToAnimate));
  
  // Extra pause after sentence-ending punctuation (10% of word time)
  const sentenceEndPause = Math.round(msPerWord * 0.25);
  
  highlightCurrentWord();
  
  const scheduleNextWord = () => {
    const currentWord = currentWords[currentWordIndex];
    const wordText = currentWord?.textContent || '';
    const isSentenceEnd = /[.!?]$/.test(wordText.trim());
    const delay = isSentenceEnd ? msPerWord + sentenceEndPause : msPerWord;
    
    wordHighlightTimeout = setTimeout(() => {
      currentWordIndex++;
      if (currentWordIndex >= currentWords.length) {
        wordHighlightTimeout = null;
        return;
      }
      highlightCurrentWord();
      scheduleNextWord();
    }, delay);
  };
  
  scheduleNextWord();
}

function highlightCurrentWord(): void {
  currentWords.forEach((word, idx) => {
    if (idx === currentWordIndex) {
      word.classList.add(HIGHLIGHT_WORD_CLASS);
    } else {
      word.classList.remove(HIGHLIGHT_WORD_CLASS);
    }
  });
}

function fallbackHighlight(chunkText: string, durationMs: number): void {
  const normalizedChunk = normalizeText(chunkText);
  const chunkLength = normalizedChunk.length;
  
  const allWords = chunkText.trim().split(/\s+/);
  const textWords = allWords.filter(w => w.replace(/[^\w]/g, '').length > 0);
  const chunkWords = textWords.slice(0, 4);
  const effectiveWords = chunkWords.length > 0 ? chunkWords : allWords.slice(0, 4);
  
  const firstWord = effectiveWords[0]?.toLowerCase().replace(/[^\w]/g, '') || '';
  const firstTwoWords = effectiveWords.slice(0, 2).join(' ').toLowerCase().replace(/[^\w\s]/g, '').trim();
  const firstThreeWords = effectiveWords.slice(0, 3).join(' ').toLowerCase().replace(/[^\w\s]/g, '').trim();
  
  if (firstWord.length < 2 && firstTwoWords.length < 3) return;
  
  const contentArea = document.querySelector(
    'article, main, [role="main"], .markdown-body, .readme, .entry-content, .post-content, .article-content'
  ) || document.body;
  
  const excludeSelector = '#riddi-widget, nav, footer, header, aside, [role="navigation"], [role="banner"]';
  
  // Strategy 1: Block elements
  for (const el of contentArea.querySelectorAll<HTMLElement>('p, h1, h2, h3, h4, h5, h6, blockquote, figcaption')) {
    if (el.offsetParent === null || el.closest(excludeSelector)) continue;
    
    const elText = normalizeText(el.textContent || '');
    if (elText.length < 3 || elText.length > chunkLength * 4) continue;
    
    const isHeading = el.tagName.match(/^H[1-6]$/);
    if (isHeading) {
      if (chunkWords.length === 1) {
        if (elText !== firstWord && !elText.startsWith(firstWord + ' ')) continue;
      } else {
        if (!elText.startsWith(firstTwoWords)) continue;
      }
    } else {
      const startsWithChunk = elText.startsWith(firstTwoWords) || elText.startsWith(firstThreeWords);
      if (!startsWithChunk && !elText.includes(firstWord)) continue;
      if (!startsWithChunk && elText.length > chunkLength * 2) continue;
    }
    
    highlightElement(el);
    wrapWordsInElement(el);
    if (currentWords.length > 0) {
      startWordAnimation(durationMs, findChunkStartWordIndex(chunkText));
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  
  // Strategy 2: LI elements with strict matching
  for (const el of contentArea.querySelectorAll<HTMLElement>('li')) {
    if (el.offsetParent === null || el.closest(excludeSelector)) continue;
    
    const elText = normalizeText(el.textContent || '');
    if (!elText.startsWith(firstTwoWords) && !elText.startsWith(firstThreeWords)) continue;
    if (elText.length > chunkLength * 3) continue;
    
    highlightElement(el);
    wrapWordsInElement(el);
    if (currentWords.length > 0) {
      startWordAnimation(durationMs, findChunkStartWordIndex(chunkText));
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  
  // Strategy 3: TreeWalker for text nodes
  const walker = document.createTreeWalker(
    contentArea,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('#riddi-widget, script, style, noscript, nav, footer, header, aside, [role="navigation"], [role="banner"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  
  let textNode: Text | null;
  while ((textNode = walker.nextNode() as Text | null)) {
    const nodeText = normalizeText(textNode.textContent ?? '');
    if (!nodeText.includes(firstWord)) continue;
    
    const parent = textNode.parentElement;
    if (parent) {
      const block = parent.closest('p, h1, h2, h3, h4, h5, h6, blockquote, figcaption') as HTMLElement;
      const target = block ?? parent;
      
      const targetText = normalizeText(target.textContent || '');
      if (targetText.length > chunkLength * 4) continue;
      
      highlightElement(target);
      wrapWordsInElement(target);
      if (currentWords.length > 0) {
        startWordAnimation(durationMs);
      }
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
  }
}

export function pauseWordAnimation(): void {
  if (wordHighlightTimeout) {
    clearTimeout(wordHighlightTimeout);
    wordHighlightTimeout = null;
  }
}

export function clearPageHighlights(): void {
  if (wordHighlightTimeout) {
    clearTimeout(wordHighlightTimeout);
    wordHighlightTimeout = null;
  }
  
  for (const element of currentHighlightElements) {
    const originalHTML = originalHTMLMap.get(element);
    if (originalHTML !== undefined) {
      try {
        element.innerHTML = originalHTML;
        element.classList.remove(HIGHLIGHT_CLASS);
      } catch {
        // Element may have been removed from DOM
      }
    }
  }
  
  currentHighlightElements = [];
  originalHTMLMap.clear();
  currentWords = [];
  currentWordIndex = 0;
  
  // Clean up stray classes
  document.querySelectorAll('.' + HIGHLIGHT_CLASS).forEach(el => el.classList.remove(HIGHLIGHT_CLASS));
  document.querySelectorAll('.riddi-word').forEach(span => {
    span.replaceWith(document.createTextNode(span.textContent ?? ''));
  });
}

export function resetHighlightTracking(): void {
  currentChunkIndex = -1;
  clearPageHighlights();
}

