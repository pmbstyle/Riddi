import type { LanguageSetting, SupportedLanguage } from './languages';

export type VoiceId = 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'F1' | 'F2' | 'F3' | 'F4' | 'F5';

export interface TTSSettings {
  voice: VoiceId;
  language: LanguageSetting;
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
  language?: {
    code: SupportedLanguage;
    source: 'document' | 'metadata' | 'text' | 'fallback';
    confidence?: number;
    isReliable?: boolean;
    raw?: string;
  };
}

export interface TTSRequest {
  requestId: string;
  text: string;
  language: SupportedLanguage;
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
