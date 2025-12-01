import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { crx, defineManifest } from '@crxjs/vite-plugin';
import path from 'path';

const manifest = defineManifest({
  manifest_version: 3,
  name: 'Riddi',
  version: '0.0.1',
  description: 'Listen to cleaned article text with local TTS, sentence highlighting, and a floating player.',
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
  },
  cross_origin_embedder_policy: { value: 'require-corp' },
  cross_origin_opener_policy: { value: 'same-origin' },
  permissions: ['activeTab', 'storage', 'offscreen'],
  host_permissions: ['<all_urls>'],
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module'
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/content.ts'],
      run_at: 'document_idle'
    }
  ],
  icons: {
    '16': 'assets/riddi_icon.png',
    '32': 'assets/riddi_icon.png',
    '48': 'assets/riddi_icon.png',
    '128': 'assets/riddi_icon.png'
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_icon: {
      '16': 'assets/riddi_icon.png',
      '32': 'assets/riddi_icon.png',
      '48': 'assets/riddi_icon.png'
    }
  },
  web_accessible_resources: [
    {
      resources: [
        'src/offscreen/offscreen.html',
        'assets/*',
        'onnxruntime/*',
        'assets/offscreen-*.js',
        'assets/service-worker.ts-*.js',
        'assets/content.ts-*.js',
        'assets/popup-*.js',
        'assets/*.wasm'
      ],
      matches: ['<all_urls>']
    }
  ]
});

export default defineConfig({
  plugins: [vue(), crx({ manifest })],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@lib': path.resolve(__dirname, 'src/lib')
    }
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    sourcemap: true,
    outDir: 'dist',
    rollupOptions: {
      input: {
        offscreen: path.resolve(__dirname, 'src/offscreen/offscreen.html'),
        popup: path.resolve(__dirname, 'src/popup/index.html')
      }
    }
  }
});
