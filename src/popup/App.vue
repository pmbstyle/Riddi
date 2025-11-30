<template>
  <div class="popup">
    <header class="popup__header">
      <div>
        <p class="eyebrow">Riddi</p>
        <h1>Playback settings</h1>
      </div>
      <span class="badge">Manifest V3</span>
    </header>

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

      <label class="checkbox">
        <input v-model="settings.autoStart" type="checkbox" />
        <span>Auto-start on article pages</span>
      </label>
    </section>

    <section class="panel shortcuts">
      <h2>Keyboard shortcuts</h2>
      <ul>
        <li><strong>Play / Pause</strong><span>Ctrl/Cmd + Shift + R</span></li>
        <li><strong>Stop</strong><span>Ctrl/Cmd + Shift + X</span></li>
        <li><strong>Skip sentence</strong><span>Ctrl/Cmd + Shift + Arrow</span></li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, watch } from 'vue';
import type { TTSSettings } from '@shared/types';

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
  autoStart: false
});

onMounted(async () => {
  const saved = await chrome.storage.sync.get(['ttsSettings']);
  if (saved?.ttsSettings) {
    Object.assign(settings, saved.ttsSettings as Partial<TTSSettings>);
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
  font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
  background: linear-gradient(145deg, #0b1221, #0f172a);
  color: #e2e8f0;
}
.popup {
  min-width: 360px;
  padding: 16px;
}
.popup__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 11px;
  color: #94a3b8;
  margin: 0 0 4px;
}
h1 {
  font-size: 18px;
  margin: 0;
  color: #e2e8f0;
}
.badge {
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(14, 165, 233, 0.2);
  color: #7dd3fc;
  font-weight: 600;
  font-size: 12px;
  border: 1px solid rgba(125, 211, 252, 0.4);
}
.panel {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 14px;
  margin-bottom: 12px;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.24);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 14px;
}
.field input[type='range'],
.field select {
  width: 100%;
}
.field select {
  padding: 8px;
  background: #1e293b;
  color: #e2e8f0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
}
.field input[type='range'] {
  accent-color: #0ea5e9;
}
.checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.shortcuts h2 {
  margin: 0 0 8px;
  font-size: 14px;
  color: #cbd5e1;
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
  font-size: 13px;
}
.shortcuts strong {
  color: #e2e8f0;
}
.shortcuts span {
  color: #94a3b8;
  font-family: 'SFMono-Regular', Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  font-size: 12px;
}
</style>
