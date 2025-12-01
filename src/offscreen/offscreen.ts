import * as ort from 'onnxruntime-web';
import wasmSimdThreaded from '../onnxruntime/ort-wasm-simd-threaded.wasm?url';
import wasmJsep from '../onnxruntime/ort-wasm-simd-threaded.jsep.wasm?url';
import wasmAsyncify from '../onnxruntime/ort-wasm-simd-threaded.asyncify.wasm?url';
import {
  loadTextToSpeech,
  loadVoiceStyle,
  type Style,
  type TextToSpeech
} from '@lib/tts';
import type { BackgroundToOffscreenMessage, OffscreenToBackgroundMessage } from '@shared/messages';
import type { TTSRequest, VoiceId } from '@shared/types';

const ONNX_DIR = chrome.runtime.getURL('assets/onnx');
const VOICE_STYLE_DIR = chrome.runtime.getURL('assets/voice_styles');

let audioContext: AudioContext | null = null;
let textToSpeech: TextToSpeech | null = null;
let currentStyle: Style | null = null;
let currentVoice: VoiceId | null = null;
let activeRequestId: string | null = null;

// Audio queue for streaming playback
let audioQueue: AudioBufferSourceNode[] = [];
let nextPlayTime = 0;
let isPlaying = false;

// Global error handlers to catch any unhandled errors
self.addEventListener('error', (event) => {
  console.error('[offscreen] Uncaught error:', event.message, event.error);
  void notifyBackground({
    type: 'debug-log',
    level: 'error',
    message: 'uncaught-error',
    detail: { message: event.message, filename: event.filename, lineno: event.lineno }
  });
});

self.addEventListener('unhandledrejection', (event) => {
  console.error('[offscreen] Unhandled promise rejection:', event.reason);
  void notifyBackground({
    type: 'debug-log',
    level: 'error',
    message: 'unhandled-rejection',
    detail: String(event.reason)
  });
});

chrome.runtime.onMessage.addListener((message: BackgroundToOffscreenMessage, _sender, sendResponse) => {
  void debug('msg-received', { type: message.type });
  void routeMessage(message).catch((err) => {
    console.error('[offscreen] routeMessage error:', err);
    void debug('route-error', String(err), 'error');
  });
  sendResponse({ ok: true });
  return true;
});

notifyBackground({ type: 'ready' }).catch((error) => console.error('Failed to notify ready state', error));

async function routeMessage(message: BackgroundToOffscreenMessage): Promise<void> {
  switch (message.type) {
    case 'synthesize':
      await synthesizeAndPlay(message.payload);
      break;
    case 'pause':
      pause();
      break;
    case 'resume':
      resume();
      break;
    case 'stop':
      stop();
      activeRequestId = null;
      break;
    default:
      break;
  }
}

async function synthesizeAndPlay(request: TTSRequest): Promise<void> {
  try {
    activeRequestId = request.requestId;
    await debug('synth-step', 'ensuring-audio-context');
    await ensureAudioContext();
    await debug('synth-step', 'ensuring-tts');
    await ensureTextToSpeech();
    await debug('synthesis-start', { requestId: request.requestId, textLength: request.text.length });
    await debug('synth-step', 'loading-voice-style');
    const style = await ensureVoiceStyle(request.settings.voice);
    await debug('synth-step', 'voice-style-loaded');

    // Reset audio state
    stopAllAudio();
    isPlaying = true;
    let totalDuration = 0;

    // Get text chunks
    const textChunks = textToSpeech!.getChunks(request.text);
    const totalChunks = textChunks.length;
    await debug('text-chunks', { totalChunks, lengths: textChunks.map(c => c.length) });

    if (totalChunks === 0) {
      throw new Error('No text chunks to synthesize');
    }

    // Buffer for pre-synthesized chunks
    // Dynamic sizing based on chunk content
    const SHORT_TEXT_THRESHOLD = 100; // characters - chunks shorter than this are likely headings
    const LONG_TEXT_THRESHOLD = 200;  // characters - chunks longer than this produce enough audio
    const SHORT_DURATION_THRESHOLD = 3; // seconds - need more buffer for short audio chunks
    
    const buffer: Array<{ wav: number[]; duration: number; text: string; index: number }> = [];
    let nextToSynthesize = 0;
    let nextToPlay = 0;

    // Progress callback
    const progressCallback = (step: number, total: number) => {
      notifyBackground({
        type: 'tts-progress',
        progress: { requestId: request.requestId, step, totalSteps: total }
      }).catch(() => {});
    };

    // Helper to synthesize one chunk and add to buffer
    const synthesizeNext = async (): Promise<boolean> => {
      if (nextToSynthesize >= totalChunks) return false;
      if (activeRequestId !== request.requestId) return false;

      const idx = nextToSynthesize;
      const chunkText = textChunks[idx];
      nextToSynthesize++;

      await debug('synthesizing-chunk', { chunkIndex: idx, bufferSize: buffer.length, textLength: chunkText.length });
      
      const { wav, duration } = await textToSpeech!.synthesizeChunk(
        chunkText,
        style,
        request.settings.qualitySteps,
        request.settings.speed,
        progressCallback
      );

      if (activeRequestId !== request.requestId) return false;

      buffer.push({ wav, duration, text: chunkText, index: idx });
      await debug('chunk-buffered', { chunkIndex: idx, bufferSize: buffer.length, duration: duration.toFixed(1) });
      return true;
    };

    // Calculate how many chunks to buffer during playback
    const getTargetBufferSize = (): number => {
      const avgBufferedDuration = buffer.length > 0
        ? buffer.reduce((sum, c) => sum + c.duration, 0) / buffer.length
        : 0;
      
      // Check upcoming chunk lengths
      let shortChunksAhead = 0;
      for (let i = nextToSynthesize; i < Math.min(nextToSynthesize + 3, totalChunks); i++) {
        if (textChunks[i].length < SHORT_TEXT_THRESHOLD) shortChunksAhead++;
      }
      
      // Need more buffer for short chunks or short durations
      if (shortChunksAhead >= 2 || avgBufferedDuration < SHORT_DURATION_THRESHOLD) {
        return 4;
      }
      return 2;
    };

    // Dynamic initial buffer size based on first chunk's content
    // Long first chunk = start playing after just 1 chunk (faster time-to-audio)
    // Short first chunk = buffer 2 chunks to avoid gaps
    const firstChunkLength = textChunks[0].length;
    const initialBufferSize = firstChunkLength >= LONG_TEXT_THRESHOLD ? 1 : 2;
    const actualInitialSize = Math.min(initialBufferSize, totalChunks);
    
    await debug('pre-filling-buffer', { 
      targetSize: actualInitialSize, 
      firstChunkLength,
      reason: firstChunkLength >= LONG_TEXT_THRESHOLD ? 'long-chunk-fast-start' : 'short-chunk-needs-buffer'
    });
    
    for (let i = 0; i < actualInitialSize; i++) {
      const success = await synthesizeNext();
      if (!success) break;
    }

    // Notify that playback is starting
    await notifyBackground({
      type: 'tts-result',
      result: {
        requestId: request.requestId,
        sampleRate: textToSpeech!.sampleRate,
        durationSeconds: 0
      }
    });

    // Play chunks from buffer, synthesizing next while playing
    while (nextToPlay < totalChunks && activeRequestId === request.requestId) {
      // Wait for buffer to have something
      if (buffer.length === 0) {
        await debug('buffer-empty-waiting');
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }

      // Get next chunk to play
      const chunk = buffer.shift()!;
      nextToPlay++;

      await debug('playing-chunk', { 
        chunkIndex: chunk.index, 
        totalChunks, 
        bufferRemaining: buffer.length 
      });

      // Send highlight BEFORE playing (include duration for accurate word timing)
      await notifyBackground({
        type: 'tts-chunk-playing',
        requestId: request.requestId,
        chunkIndex: chunk.index,
        chunkText: chunk.text,
        durationMs: Math.round(chunk.duration * 1000)
      });

      // Determine how many chunks to synthesize based on current chunk duration
      // Short chunks (headings) need more buffer to avoid gaps
      const targetBuffer = getTargetBufferSize();
      const chunksToSynthesize = Math.max(0, targetBuffer - buffer.length);
      
      // Start synthesizing while this chunk plays
      const synthesisPromises: Promise<boolean>[] = [];
      for (let i = 0; i < chunksToSynthesize && nextToSynthesize < totalChunks; i++) {
        synthesisPromises.push(synthesizeNext());
      }

      // Play current chunk and wait for it to finish
      await playChunkAndWait(chunk.wav, textToSpeech!.sampleRate);
      
      totalDuration += chunk.duration;
      await debug('chunk-finished', { chunkIndex: chunk.index, totalDuration, bufferSize: buffer.length });

      // Wait for background synthesis to complete before next iteration
      await Promise.all(synthesisPromises);
    }

    // All done
    isPlaying = false;
    activeRequestId = null;
    await debug('all-audio-ended', { totalDuration, chunksPlayed: nextToPlay });
    await notifyBackground({
      type: 'tts-complete',
      requestId: request.requestId,
      totalDuration
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown synthesis error';
    const stack = error instanceof Error ? error.stack : undefined;
    console.error('[offscreen] Synthesis error:', message, stack);
    await debug('synthesis-error', { message, stack }, 'error');
    await notifyBackground({ type: 'tts-error', requestId: request.requestId, message });
  }
}

/**
 * Play a single audio chunk and return a promise that resolves when it finishes
 */
function playChunkAndWait(wav: number[], sampleRate: number): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const wavArray = new Float32Array(wav);
      const buffer = audioContext!.createBuffer(1, wavArray.length, sampleRate);
      buffer.copyToChannel(wavArray, 0);

      const source = audioContext!.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext!.destination);

      // Store reference for pause/stop
      audioQueue.push(source);

      source.onended = () => {
        const idx = audioQueue.indexOf(source);
        if (idx !== -1) {
          audioQueue.splice(idx, 1);
        }
        resolve();
      };

      source.start();
    } catch (err) {
      reject(err);
    }
  });
}

async function debug(message: string, detail?: unknown, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
  await notifyBackground({ type: 'debug-log', level, message, detail });
}

function pause(): void {
  if (!audioContext) return;
  
  // Immediately stop all currently playing audio for instant pause
  for (const source of audioQueue) {
    try {
      source.stop();
      source.disconnect();
    } catch {
      // Source may have already ended
    }
  }
  audioQueue = [];
  
  // Suspend the context to prevent any scheduled audio
  if (audioContext.state === 'running') {
    void audioContext.suspend();
  }
  
  void debug('pause-executed', { queueCleared: true });
}

function resume(): void {
  if (audioContext && audioContext.state === 'suspended') {
    void audioContext.resume();
  }
  void debug('resume-executed');
}

function stop(): void {
  stopAllAudio();
}

function stopAllAudio(): void {
  // Stop all queued audio sources
  for (const source of audioQueue) {
    try {
      source.stop();
      source.disconnect();
    } catch {
      // Source may have already ended
    }
  }
  audioQueue = [];
  isPlaying = false;
  nextPlayTime = 0;
}

async function ensureAudioContext(): Promise<void> {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
}

async function ensureTextToSpeech(): Promise<void> {
  if (textToSpeech) return;

  // Prefer single-threaded WASM (SharedArrayBuffer not guaranteed in offscreen).
  ort.env.wasm.numThreads = 1;
  // Map bundled WASM filenames to their hashed URLs.
  ort.env.wasm.wasmPaths = {
    'ort-wasm-simd-threaded.wasm': wasmSimdThreaded,
    'ort-wasm-simd-threaded.jsep.wasm': wasmJsep,
    'ort-wasm-simd-threaded.asyncify.wasm': wasmAsyncify
  };

  const wasmResult = await loadTextToSpeech(
    ONNX_DIR,
    { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
    (name, current, total) => {
      void debug('model-loading', { name, current, total });
    }
  );
  textToSpeech = wasmResult.textToSpeech;
  
  // Wire up debug callback to trace TTS pipeline
  textToSpeech.debugCallback = (message, detail) => {
    void debug(`tts:${message}`, detail);
  };
  
  await debug('tts-loaded');
}

async function ensureVoiceStyle(voice: VoiceId): Promise<Style> {
  if (currentStyle && currentVoice === voice) return currentStyle;
  const stylePath = `${VOICE_STYLE_DIR}/${voice}.json`;
  currentStyle = await loadVoiceStyle([stylePath], true);
  currentVoice = voice;
  return currentStyle;
}

async function notifyBackground(message: OffscreenToBackgroundMessage): Promise<void> {
  await chrome.runtime.sendMessage(message);
}
