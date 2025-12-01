<p align="center">
<img src="./riddi-logo.png" width="250">
</p>

## Riddi – local TTS reader (Chrome extension)

### How to use
- Load the unpacked extension from `dist` in Chrome.
- Open an article page; Riddi injects a floating player bottom-right.
- Click **Play** on the widget (or use the shortcut below) to synthesize the cleaned article text with the bundled ONNX models and play it back.
- Pause/Resume or Stop from the widget or shortcuts. Settings are in the popup (toolbar icon).

### Keyboard shortcuts
- Play/Pause: `Alt + Shift + P`
- Stop: `Alt + Shift + S`

### Notes
- Models and voice styles are bundled under `public/assets`.
- Offscreen document runs the ONNX pipeline via `onnxruntime-web` with WebGPU → WASM fallback.
- Parsed text uses Readability.js; sentences are highlighted in the widget view for now.
