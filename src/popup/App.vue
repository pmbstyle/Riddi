<template>
  <div class="popup">
    <header class="popup__header">
      <div class="popup__brand">
        <img src="/assets/riddi_icon.png" alt="Riddi" class="popup__logo" />
        <div>
          <h1>Riddi</h1>
          <p class="popup__tagline">AI Text-to-Speech</p>
        </div>
      </div>
    </header>

    <!-- Playback Controls -->
    <section class="panel playback-panel">
      <div class="playback-controls">
        <button
          v-if="playbackState.status !== 'playing'"
          class="btn btn--play"
          :disabled="!hasArticle || playbackState.status === 'loading'"
          @click="handlePlayPause"
        >
          <span v-if="playbackState.status === 'loading'" class="btn__icon">⏳</span>
          <span v-else class="btn__icon">▶</span>
        </button>
        <button
          v-else
          class="btn btn--pause"
          @click="handlePlayPause"
        >
          <span class="btn__icon">⏸</span>
        </button>
        <button
          class="btn btn--stop"
          :disabled="playbackState.status === 'idle'"
          @click="handleStop"
        >
          <span class="btn__icon">⏹</span>
        </button>
      </div>
      <div class="playback-status">
        <span :class="['status-badge', `status-badge--${playbackState.status}`]">
          {{ statusLabel }}
        </span>
        <span v-if="!hasArticle" class="status-hint">No article detected</span>
      </div>
    </section>

    <section class="panel">
      <label class="field">
        <span>Voice</span>
        <select v-model="settings.voice">
          <option v-for="voice in voices" :key="voice.id" :value="voice.id">
            {{ voice.label }}
          </option>
        </select>
      </label>

      <label class="field">
        <span>Speed: {{ settings.speed.toFixed(2) }}x</span>
        <input v-model.number="settings.speed" type="range" min="0.5" max="2" step="0.05" />
      </label>

      <label class="field">
        <span>Quality steps: {{ settings.qualitySteps }}</span>
        <input v-model.number="settings.qualitySteps" type="range" min="1" max="10" step="1" />
      </label>

      <label class="checkbox widget-toggle">
        <input v-model="settings.widgetEnabled" type="checkbox" />
        <span>Enable floating widget</span>
      </label>
      <p class="hint">When disabled, use this popup for playback control</p>
    </section>

    <section class="panel shortcuts">
      <h2>Keyboard shortcuts</h2>
      <ul>
        <li><strong>Play / Pause</strong><span>Alt + Shift + P</span></li>
        <li><strong>Stop</strong><span>Alt + Shift + S</span></li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type { PlaybackState, TTSSettings } from '@shared/types';

const voices = [
  { id: 'M1', label: 'Male 1 (M1)' },
  { id: 'M2', label: 'Male 2 (M2)' },
  { id: 'F1', label: 'Female 1 (F1)' },
  { id: 'F2', label: 'Female 2 (F2)' }
];

const settings = reactive<TTSSettings>({
  voice: 'M1',
  speed: 1,
  qualitySteps: 6,
  widgetEnabled: true
});

const playbackState = reactive<PlaybackState>({
  status: 'idle',
  currentChunk: 0,
  totalChunks: 0,
  positionSeconds: 0,
  durationSeconds: 0
});

const hasArticle = ref(false);
let pollInterval: ReturnType<typeof setInterval> | null = null;

const statusLabel = computed(() => {
  const labels: Record<string, string> = {
    idle: 'Ready',
    loading: 'Loading...',
    playing: 'Playing',
    paused: 'Paused',
    error: 'Error'
  };
  return labels[playbackState.status] ?? playbackState.status;
});

const fetchPlaybackState = async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-playback-state' });
    if (response?.state) {
      Object.assign(playbackState, response.state);
    }
    hasArticle.value = response?.hasArticle ?? false;
  } catch {
    // Ignore errors when popup is closing
  }
};

const handlePlayPause = async () => {
  if (playbackState.status === 'idle' || playbackState.status === 'error') {
    await chrome.runtime.sendMessage({ type: 'popup-start-tts' });
  } else if (playbackState.status === 'playing') {
    await chrome.runtime.sendMessage({ type: 'popup-pause-tts' });
  } else if (playbackState.status === 'paused') {
    await chrome.runtime.sendMessage({ type: 'popup-resume-tts' });
  }
  await fetchPlaybackState();
};

const handleStop = async () => {
  await chrome.runtime.sendMessage({ type: 'popup-stop-tts' });
  await fetchPlaybackState();
};

onMounted(async () => {
  const saved = await chrome.storage.sync.get(['ttsSettings']);
  if (saved?.ttsSettings) {
    Object.assign(settings, saved.ttsSettings as Partial<TTSSettings>);
  }
  
  await fetchPlaybackState();
  pollInterval = setInterval(fetchPlaybackState, 500);
});

onUnmounted(() => {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
});

watch(
  settings,
  async (value) => {
    await chrome.storage.sync.set({ ttsSettings: value });
  },
  { deep: true }
);
</script>

<style scoped>
:global(body) {
  margin: 0;
  font-family: 'Nunito', 'Segoe UI', system-ui, -apple-system, sans-serif;
  background: #2D2D2D;
  color: white;
}
.popup {
  min-width: 340px;
  padding: 16px;
}
.popup__header {
  margin-bottom: 16px;
}
.popup__brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.popup__logo {
  width: 48px;
  height: 48px;
  border-radius: 12px;
}
.popup__brand h1 {
  font-size: 20px;
  font-weight: 700;
  margin: 0;
  color: #F47C26;
}
.popup__tagline {
  font-size: 12px;
  color: #FFE8D2;
  margin: 2px 0 0;
  opacity: 0.8;
}

/* Playback Panel */
.playback-panel {
  background: linear-gradient(135deg, rgba(244, 124, 38, 0.15), rgba(244, 124, 38, 0.05));
  border-color: rgba(244, 124, 38, 0.3);
}
.playback-controls {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}
.btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 50px;
  height: 50px;
  border-radius: 14px;
  border: none;
  cursor: pointer;
  font-size: 20px;
  transition: all 150ms ease;
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.btn--play {
  background: linear-gradient(135deg, #F47C26, #e06a1a);
  color: white;
  flex: 1;
}
.btn--play:hover:not(:disabled) {
  background: linear-gradient(135deg, #ff8c36, #F47C26);
  transform: scale(1.02);
}
.btn--pause {
  background: linear-gradient(135deg, #F47C26, #e06a1a);
  color: white;
  flex: 1;
}
.btn--pause:hover:not(:disabled) {
  background: linear-gradient(135deg, #ff8c36, #F47C26);
  transform: scale(1.02);
}
.btn--stop {
  background: rgba(255, 255, 255, 0.1);
  color: #FFE8D2;
  width: 50px;
}
.btn--stop:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.8);
  color: white;
}
.btn__icon {
  line-height: 1;
}
.playback-status {
  display: flex;
  align-items: center;
  gap: 10px;
}
.status-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.1);
  color: #FFE8D2;
}
.status-badge--playing {
  background: rgba(34, 197, 94, 0.25);
  color: #4ade80;
}
.status-badge--loading {
  background: rgba(244, 124, 38, 0.25);
  color: #F47C26;
}
.status-badge--paused {
  background: rgba(255, 232, 210, 0.2);
  color: #FFE8D2;
}
.status-badge--error {
  background: rgba(239, 68, 68, 0.25);
  color: #f87171;
}
.status-hint {
  font-size: 11px;
  color: rgba(255, 232, 210, 0.5);
}

/* Panel */
.panel {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  padding: 14px;
  margin-bottom: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 14px;
  color: #FFE8D2;
}
.field input[type='range'],
.field select {
  width: 100%;
}
.field select {
  padding: 10px 12px;
  background: #2D2D2D;
  color: white;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 10px;
  font-size: 14px;
  cursor: pointer;
}
.field select:focus {
  outline: none;
  border-color: #F47C26;
}
.field select option {
  background: #2D2D2D;
  color: white;
  padding: 8px;
}
.field input[type='range'] {
  accent-color: #F47C26;
  height: 6px;
}
.checkbox {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  color: #FFE8D2;
  cursor: pointer;
}
.checkbox input[type='checkbox'] {
  width: 18px;
  height: 18px;
  accent-color: #F47C26;
  cursor: pointer;
}
.divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.1);
  margin: 14px 0;
}
.widget-toggle {
  margin-bottom: 4px;
}
.hint {
  font-size: 11px;
  color: rgba(255, 232, 210, 0.5);
  margin: 0;
  padding-left: 28px;
}

/* Shortcuts */
.shortcuts h2 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: #FFE8D2;
}
.shortcuts ul {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.shortcuts li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
}
.shortcuts strong {
  color: white;
  font-weight: 500;
}
.shortcuts span {
  color: rgba(255, 232, 210, 0.6);
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.08);
  padding: 3px 8px;
  border-radius: 6px;
}
</style>
