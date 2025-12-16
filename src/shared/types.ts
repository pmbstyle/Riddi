export type VoiceId = 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'F1' | 'F2' | 'F3' | 'F4' | 'F5';

export interface TTSSettings {
  voice: VoiceId;
  speed: number; // 0.5 - 2.0
  qualitySteps: number; // denoising steps (1-10+)
  widgetEnabled: boolean;
}

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface PlaybackState {
  status: PlaybackStatus;
  currentChunk: number;
  totalChunks: number;
  positionSeconds: number;
  durationSeconds: number;
  highlightedSentence?: number;
  error?: string;
}

export interface ArticleContent {
  title: string;
  byline?: string;
  content: string;
  sentences: string[];
}

export interface TTSRequest {
  requestId: string;
  text: string;
  settings: TTSSettings;
}

export interface TTSProgress {
  requestId: string;
  step: number;
  totalSteps: number;
}

export interface TTSResult {
  requestId: string;
  audioBuffer?: ArrayBuffer;
  sampleRate: number;
  durationSeconds: number;
}

export interface DebugLog {
  level?: 'info' | 'warn' | 'error';
  message: string;
  detail?: unknown;
}

export interface HighlightUpdate {
  sentenceIndex: number;
}
