<p align="center">
<img src="./riddi-logo.png" width="250">
</p>

![Chrome Web Store Version](https://img.shields.io/chrome-web-store/v/elghlgcjihgpmmffcmphbddmkgbfdbbg) 

# Riddi – Local Text-to-Speech Browser Reader

A Chrome extension that converts web articles to speech using built-in local AI models. No cloud services, no API keys – everything runs directly in your browser, fast and secure.

👉 [Download from Chrome Web Store](https://chromewebstore.google.com/detail/riddi/elghlgcjihgpmmffcmphbddmkgbfdbbg)

## What is Riddi?

Riddi extracts readable content from web pages and synthesizes natural-sounding speech using bundled ONNX neural TTS models. It's perfect for:

- **Listening to articles** while doing other tasks
- **Accessibility** – have any web content read aloud
- **Learning** – listen to educational content hands-free
- **Reducing eye strain** – give your eyes a break

[<img width="848" height="476" alt="Riddi youtube showcase" src="https://github.com/user-attachments/assets/d1d94738-3fc0-4741-b222-ffce5426a4ca" />](https://www.youtube.com/watch?v=J2JbKLt9PP4)


## Features

### Local AI Processing
- Runs entirely in your browser using ONNX Runtime (WebGPU with WASM fallback)
- No data sent to external servers
- Works offline once loaded

### Smart Content Extraction
- Automatically detects and extracts article content using Readability.js
- Filters out navigation, ads, and other non-content elements
- **Text Selection Mode** – manually select specific text blocks to read

### Real-time Highlighting
- Highlights the current paragraph being read
- Word-by-word highlighting synced with speech
- Smooth auto-scroll to keep content in view

### Multiple Voices
- 10 built-in voice styles (5 male, 5 female)
- Adjustable speech speed (0.5x – 2x)
- Quality/speed tradeoff via denoising steps

### Floating Widget
- Unobtrusive player that stays in the corner
- Expand for playback controls
- Can be disabled in settings (use pop-up instead)

<img alt="Riddi screenshot" src="https://github.com/user-attachments/assets/3f03e28e-7f96-45cb-9a29-31324be24dd2" />




## How to Use

### Basic Playback
1. Navigate to any article or web page
2. Click the Riddi widget (bottom-right corner) to expand controls
3. Press **▶ Play** to start reading the entire article
4. Use **⏸ Pause** and **⏹ Stop** as needed

### Text Selection Mode
1. Click the **⌖** button (or press `Ctrl+Shift+S`) to enter selection mode
2. Hover over text blocks – they highlight with an orange outline
3. Click to select – TTS starts automatically with that content
4. Press `Escape` to cancel selection mode

### Settings (Popup)
Click the Riddi icon in the Chrome toolbar to access:
- **Voice** – Choose between M1-5, F1-5
- **Speed** – Adjust playback rate
- **Quality Steps** – Higher = better quality, slower generation
- **Widget Toggle** – Show/hide the floating widget

### Keyboard Shortcuts
| Action | Shortcut |
|--------|----------|
| Play / Pause | `Ctrl + Shift + Space` |
| Stop | `Ctrl + Shift + X` |
| Select Text | `Ctrl + Shift + S` |

---

## Local Development

### Prerequisites
- Git LFS
- Node.js 22+
- npm or pnpm

### Setup
```bash
#If you don't have Git LFS installed
#mac
brew install git-lfs
#linux
sudo apt-get install git-lfs
#windows
git lfs install

# Clone the repository
git clone https://github.com/pmbstyle/Riddi.git
cd riddi

# Install dependencies
npm install

# Build the extension
npm run build
```

### Load in Chrome
1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist` folder

### Development Mode
```bash
# Watch mode with hot reload
npm run dev
```

After making changes, click the refresh icon on the extension card in `chrome://extensions/`.

### Project Structure
```
src/
├── background/       # Service worker
├── content/          # Content script (widget, highlighting)
├── popup/            # Extension popup (Vue)
├── offscreen/        # ONNX TTS pipeline
├── lib/tts/          # TTS synthesis logic
└── shared/           # Shared types and messages

public/assets/
├── onnx/             # Neural TTS models
└── voice_styles/     # Voice embedding files
```

### Tech Stack
- **Vite** + **CRXJS** – Extension bundling
- **Vue 3** – Popup UI
- **ONNX Runtime Web** – Neural network inference
- [**Supertonic**](https://github.com/supertone-inc/supertonic) – Lightweight TTS model
- [**Readability.js**](https://github.com/mozilla/readability) – Content extraction

---

## Notes

- TTS models are bundled (~60MB) under `public/assets/onnx/`
- First synthesis may take a few seconds while models load
- WebGPU provides the best performance; falls back to WASM if unavailable
- Works best on article-style pages with a clear content structure
