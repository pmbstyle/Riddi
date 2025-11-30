import * as ort from 'onnxruntime-web';

export interface TTSConfig {
  ae: {
    sample_rate: number;
    base_chunk_size: number;
    [key: string]: unknown;
  };
  ttl: {
    chunk_compress_factor: number;
    latent_dim: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type ModelProgressCallback = (name: string, current: number, total: number) => void;
export type StepProgressCallback = (current: number, total: number) => void;
export type ChunkReadyCallback = (chunkIndex: number, totalChunks: number, wav: number[], durationSeconds: number, chunkText: string) => void;

export class UnicodeProcessor {
  constructor(private readonly indexer: number[]) {}

  call(textList: string[]): { textIds: number[][]; textMask: number[][][] } {
    const processedTexts = textList.map((text) => this.preprocessText(text));

    const textIdsLengths = processedTexts.map((text) => text.length);
    const maxLen = Math.max(...textIdsLengths);

    const textIds = processedTexts.map((text) => {
      const row = new Array<number>(maxLen).fill(0);
      for (let j = 0; j < text.length; j++) {
        const codePoint = text.codePointAt(j) ?? 0;
        row[j] = codePoint < this.indexer.length ? this.indexer[codePoint] : -1;
      }
      return row;
    });

    const textMask = this.getTextMask(textIdsLengths);
    return { textIds, textMask };
  }

  preprocessText(text: string): string {
    let normalized = text.normalize('NFKD');

    const emojiPattern =
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;
    normalized = normalized.replace(emojiPattern, '');

    const replacements: Record<string, string> = {
      '–': '-',
      '‑': '-',
      '—': '-',
      '¯': ' ',
      _ : ' ',
      '"': '"',
      '\u2018': "'",
      '\u2019': "'",
      '´': "'",
      '`': "'",
      '[': ' ',
      ']': ' ',
      '|': ' ',
      '/': ' ',
      '#': ' ',
      '→': ' ',
      '←': ' '
    };
    for (const [k, v] of Object.entries(replacements)) {
      normalized = normalized.replaceAll(k, v);
    }

    normalized = normalized.replace(
      /[\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u030A\u030B\u030C\u0327\u0328\u0329\u032A\u032B\u032C\u032D\u032E\u032F]/g,
      ''
    );

    normalized = normalized.replace(/[♥☆♡©\\]/g, '');

    const exprReplacements: Record<string, string> = {
      '@': ' at ',
      'e.g.,': 'for example, ',
      'i.e.,': 'that is, '
    };
    for (const [k, v] of Object.entries(exprReplacements)) {
      normalized = normalized.replaceAll(k, v);
    }

    normalized = normalized.replace(/ ,/g, ',');
    normalized = normalized.replace(/ \./g, '.');
    normalized = normalized.replace(/ !/g, '!');
    normalized = normalized.replace(/ \?/g, '?');
    normalized = normalized.replace(/ ;/g, ';');
    normalized = normalized.replace(/ :/g, ':');
    normalized = normalized.replace(/ '/g, "'");

    normalized = normalized.replace(/""/g, '"');
    normalized = normalized.replace(/''/g, "'");
    normalized = normalized.replace(/``/g, '`');

    normalized = normalized.replace(/\s+/g, ' ').trim();

    if (!/[.!?;:,'\"')\]}…。」』】〉》›»]$/.test(normalized)) {
      normalized += '.';
    }

    return normalized;
  }

  getTextMask(textIdsLengths: number[]): number[][][] {
    const maxLen = Math.max(...textIdsLengths);
    return this.lengthToMask(textIdsLengths, maxLen);
  }

  lengthToMask(lengths: number[], maxLen?: number): number[][][] {
    const actualMaxLen = maxLen ?? Math.max(...lengths);
    return lengths.map((len) => {
      const row = new Array<number>(actualMaxLen).fill(0.0);
      for (let j = 0; j < Math.min(len, actualMaxLen); j++) {
        row[j] = 1.0;
      }
      return [row];
    });
  }
}

export class Style {
  constructor(public readonly ttl: ort.Tensor, public readonly dp: ort.Tensor) {}
}

export type DebugCallback = (message: string, detail?: unknown) => void;

export class TextToSpeech {
  readonly sampleRate: number;
  debugCallback: DebugCallback | null = null;

  constructor(
    private readonly cfgs: TTSConfig,
    private readonly textProcessor: UnicodeProcessor,
    private readonly dpOrt: ort.InferenceSession,
    private readonly textEncOrt: ort.InferenceSession,
    private readonly vectorEstOrt: ort.InferenceSession,
    private readonly vocoderOrt: ort.InferenceSession
  ) {
    this.sampleRate = cfgs.ae.sample_rate;
  }

  private log(message: string, detail?: unknown): void {
    this.debugCallback?.(message, detail);
  }

  /**
   * Split text into chunks for TTS processing
   */
  getChunks(text: string): string[] {
    return chunkText(text);
  }

  /**
   * Synthesize a single text chunk
   */
  async synthesizeChunk(
    chunkText: string,
    style: Style,
    totalStep: number,
    speed = 1.05,
    progressCallback: StepProgressCallback | null = null
  ): Promise<{ wav: number[]; duration: number }> {
    this.log('synthesize-single-chunk', { textLength: chunkText.length });
    const { wav, duration } = await this._infer([chunkText], style, totalStep, speed, progressCallback);
    return { wav, duration: duration[0] };
  }

  /**
   * Streaming TTS - synthesizes text chunk by chunk, calling onChunkReady as each chunk completes.
   * This allows playback to start immediately while subsequent chunks are still being synthesized.
   */
  async synthesizeStreaming(
    text: string,
    style: Style,
    totalStep: number,
    speed = 1.05,
    progressCallback: StepProgressCallback | null = null,
    onChunkReady: ChunkReadyCallback
  ): Promise<{ totalChunks: number; totalDuration: number }> {
    if (style.ttl.dims[0] !== 1) {
      throw new Error('Single speaker text to speech only supports single style');
    }
    const textList = chunkText(text);
    this.log('tts-chunks', { totalChunks: textList.length, chunkLengths: textList.map(c => c.length) });
    
    let totalDuration = 0;

    for (let i = 0; i < textList.length; i++) {
      const chunk = textList[i];
      this.log('chunk-start', { chunkIndex: i, chunkLength: chunk.length, totalChunks: textList.length });
      
      // Yield to event loop between chunks to allow GC and prevent blocking
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      
      try {
        const { wav, duration } = await this._infer([chunk], style, totalStep, speed, progressCallback);
        const chunkDuration = duration[0];
        this.log('chunk-complete', { chunkIndex: i, wavLength: wav.length, duration: chunkDuration });

        totalDuration += chunkDuration;
        
        // Emit this chunk immediately for playback
        onChunkReady(i, textList.length, wav, chunkDuration, chunk);
      } catch (chunkError) {
        this.log('chunk-error', { chunkIndex: i, error: String(chunkError) });
        throw chunkError;
      }
    }

    this.log('tts-streaming-complete', { totalChunks: textList.length, totalDuration });
    return { totalChunks: textList.length, totalDuration };
  }

  /**
   * Legacy method - synthesizes all chunks and returns combined audio.
   * Consider using synthesizeStreaming() for better UX.
   */
  async call(
    text: string,
    style: Style,
    totalStep: number,
    speed = 1.05,
    silenceDuration = 0.3,
    progressCallback: StepProgressCallback | null = null
  ): Promise<{ wav: number[]; duration: number[] }> {
    const wavChunks: number[][] = [];
    let totalDuration = 0;
    const silenceLen = Math.floor(silenceDuration * this.sampleRate);

    await this.synthesizeStreaming(
      text,
      style,
      totalStep,
      speed,
      progressCallback,
      (chunkIndex, totalChunks, wav, duration, _chunkText) => {
        wavChunks.push(wav);
        totalDuration += duration;
        if (chunkIndex < totalChunks - 1) {
          totalDuration += silenceDuration;
        }
      }
    );

    // Concatenate all chunks efficiently
    this.log('concatenating-chunks', { numChunks: wavChunks.length });
    const totalLength = wavChunks.reduce((sum, chunk, idx) => {
      return sum + chunk.length + (idx < wavChunks.length - 1 ? silenceLen : 0);
    }, 0);
    
    const wavCat = new Array<number>(totalLength);
    let offset = 0;
    
    for (let i = 0; i < wavChunks.length; i++) {
      const chunk = wavChunks[i];
      for (let j = 0; j < chunk.length; j++) {
        wavCat[offset++] = chunk[j];
      }
      if (i < wavChunks.length - 1) {
        for (let j = 0; j < silenceLen; j++) {
          wavCat[offset++] = 0;
        }
      }
    }

    this.log('tts-complete', { totalWavLength: wavCat.length, totalDuration });
    return { wav: wavCat, duration: [totalDuration] };
  }

  async batch(
    textList: string[],
    style: Style,
    totalStep: number,
    speed = 1.05,
    progressCallback: StepProgressCallback | null = null
  ): Promise<{ wav: number[]; duration: number[] }> {
    return this._infer(textList, style, totalStep, speed, progressCallback);
  }

  private async _infer(
    textList: string[],
    style: Style,
    totalStep: number,
    speed: number,
    progressCallback: StepProgressCallback | null
  ): Promise<{ wav: number[]; duration: number[] }> {
    const bsz = textList.length;

    this.log('infer-start', { bsz, textLengths: textList.map(t => t.length) });

    const { textIds, textMask } = this.textProcessor.call(textList);
    this.log('text-processed', { textIdsShape: [bsz, textIds[0]?.length], textMaskShape: [bsz, 1, textMask[0]?.[0]?.length] });

    const textIdsFlat = new BigInt64Array(textIds.flat().map((x) => BigInt(x)));
    const textIdsShape: [number, number] = [bsz, textIds[0].length];
    const textIdsTensor = new ort.Tensor('int64', textIdsFlat, textIdsShape);

    const textMaskFlat = new Float32Array(textMask.flat(2));
    const textMaskShape: [number, number, number] = [bsz, 1, textMask[0][0].length];
    const textMaskTensor = new ort.Tensor('float32', textMaskFlat, textMaskShape);

    this.log('running-duration-predictor');
    const dpOutputs = await this.dpOrt.run({
      text_ids: textIdsTensor,
      style_dp: style.dp,
      text_mask: textMaskTensor
    });
    const duration = Array.from(dpOutputs.duration.data) as number[];
    
    // Dispose duration predictor outputs
    dpOutputs.duration.dispose();
    
    this.log('duration-predictor-done', { duration });

    for (let i = 0; i < duration.length; i++) {
      duration[i] /= speed;
    }

    this.log('running-text-encoder');
    const textEncOutputs = await this.textEncOrt.run({
      text_ids: textIdsTensor,
      style_ttl: style.ttl,
      text_mask: textMaskTensor
    });
    const textEmb = textEncOutputs.text_emb as ort.Tensor;
    this.log('text-encoder-done', { textEmbShape: textEmb.dims });

    // Dispose input tensors that are no longer needed
    textIdsTensor.dispose();

    let { xt, latentMask } = this.sampleNoisyLatent(
      duration,
      this.sampleRate,
      this.cfgs.ae.base_chunk_size,
      this.cfgs.ttl.chunk_compress_factor,
      this.cfgs.ttl.latent_dim
    );
    this.log('noisy-latent-sampled', { xtShape: [bsz, xt[0]?.length, xt[0]?.[0]?.length] });

    const latentMaskFlat = new Float32Array(latentMask.flat(2));
    const latentMaskShape: [number, number, number] = [bsz, 1, latentMask[0][0].length];
    const latentMaskTensor = new ort.Tensor('float32', latentMaskFlat, latentMaskShape);

    const totalStepArray = new Float32Array(bsz).fill(totalStep);
    const totalStepTensor = new ort.Tensor('float32', totalStepArray, [bsz]);

    for (let step = 0; step < totalStep; step++) {
      progressCallback?.(step + 1, totalStep);
      this.log('vector-est-step-start', { step: step + 1, totalStep });

      const currentStepArray = new Float32Array(bsz).fill(step);
      const currentStepTensor = new ort.Tensor('float32', currentStepArray, [bsz]);

      const xtFlat = new Float32Array(xt.flat(2));
      const xtShape: [number, number, number] = [bsz, xt[0].length, xt[0][0].length];
      const xtTensor = new ort.Tensor('float32', xtFlat, xtShape);

      const vectorEstOutputs = await this.vectorEstOrt.run({
        noisy_latent: xtTensor,
        text_emb: textEmb,
        style_ttl: style.ttl,
        latent_mask: latentMaskTensor,
        text_mask: textMaskTensor,
        current_step: currentStepTensor,
        total_step: totalStepTensor
      });
      
      // Dispose tensors created in loop immediately after use
      currentStepTensor.dispose();
      xtTensor.dispose();
      
      this.log('vector-est-step-done', { step: step + 1 });

      const denoised = Array.from(vectorEstOutputs.denoised_latent.data) as number[];
      
      // Dispose vector estimator output
      vectorEstOutputs.denoised_latent.dispose();

      // Check for NaN/Infinity in denoised output
      const hasInvalid = denoised.some((v) => !Number.isFinite(v));
      if (hasInvalid) {
        this.log('vector-est-invalid-output', { step: step + 1, hasNaN: denoised.some(Number.isNaN), hasInf: denoised.some(v => !Number.isFinite(v) && !Number.isNaN(v)) });
      }

      const latentDim = xt[0].length;
      const latentLen = xt[0][0].length;
      xt = [];
      let idx = 0;
      for (let b = 0; b < bsz; b++) {
        const batch: number[][] = [];
        for (let d = 0; d < latentDim; d++) {
          const row: number[] = [];
          for (let t = 0; t < latentLen; t++) {
            row.push(denoised[idx++]);
          }
          batch.push(row);
        }
        xt.push(batch);
      }
    }

    // Dispose remaining tensors before vocoder
    textMaskTensor.dispose();
    latentMaskTensor.dispose();
    totalStepTensor.dispose();
    textEmb.dispose();

    this.log('running-vocoder');
    const finalXtFlat = new Float32Array(xt.flat(2));
    const finalXtShape: [number, number, number] = [bsz, xt[0].length, xt[0][0].length];
    const finalXtTensor = new ort.Tensor('float32', finalXtFlat, finalXtShape);
    
    this.log('vocoder-tensor-created', { shape: finalXtShape, dataLength: finalXtFlat.length });

    // Run vocoder with timeout detection
    const VOCODER_TIMEOUT_MS = 120000; // 2 minutes max per chunk
    let vocoderOutputs: Awaited<ReturnType<typeof this.vocoderOrt.run>>;
    
    try {
      const vocoderPromise = this.vocoderOrt.run({ latent: finalXtTensor });
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Vocoder timed out after ${VOCODER_TIMEOUT_MS}ms`)), VOCODER_TIMEOUT_MS);
      });
      
      vocoderOutputs = await Promise.race([vocoderPromise, timeoutPromise]);
    } catch (vocoderError) {
      finalXtTensor.dispose();
      this.log('vocoder-error', { error: String(vocoderError) });
      throw vocoderError;
    }
    
    // Dispose vocoder input
    finalXtTensor.dispose();
    
    this.log('vocoder-done');

    const wav = Array.from(vocoderOutputs.wav_tts.data) as number[];
    
    // Dispose vocoder output
    vocoderOutputs.wav_tts.dispose();
    
    this.log('infer-complete', { wavLength: wav.length });

    return { wav, duration };
  }

  private sampleNoisyLatent(
    duration: number[],
    sampleRate: number,
    baseChunkSize: number,
    chunkCompress: number,
    latentDim: number
  ): { xt: number[][][]; latentMask: number[][][] } {
    const bsz = duration.length;
    const maxDur = Math.max(...duration);

    const wavLenMax = Math.floor(maxDur * sampleRate);
    const wavLengths = duration.map((d) => Math.floor(d * sampleRate));

    const chunkSize = baseChunkSize * chunkCompress;
    const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
    const latentDimVal = latentDim * chunkCompress;

    const xt: number[][][] = [];
    for (let b = 0; b < bsz; b++) {
      const batch: number[][] = [];
      for (let d = 0; d < latentDimVal; d++) {
        const row: number[] = [];
        for (let t = 0; t < latentLen; t++) {
          const u1 = Math.max(0.0001, Math.random());
          const u2 = Math.random();
          const val = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
          row.push(val);
        }
        batch.push(row);
      }
      xt.push(batch);
    }

    const latentLengths = wavLengths.map((len) => Math.floor((len + chunkSize - 1) / chunkSize));
    const latentMask = this.lengthToMask(latentLengths, latentLen);

    for (let b = 0; b < bsz; b++) {
      for (let d = 0; d < latentDimVal; d++) {
        for (let t = 0; t < latentLen; t++) {
          xt[b][d][t] *= latentMask[b][0][t];
        }
      }
    }

    return { xt, latentMask };
  }

  private lengthToMask(lengths: number[], maxLen?: number): number[][][] {
    const actualMaxLen = maxLen ?? Math.max(...lengths);
    return lengths.map((len) => {
      const row = new Array<number>(actualMaxLen).fill(0.0);
      for (let j = 0; j < Math.min(len, actualMaxLen); j++) {
        row[j] = 1.0;
      }
      return [row];
    });
  }
}

export async function loadVoiceStyle(voiceStylePaths: string[], verbose = false): Promise<Style> {
  const bsz = voiceStylePaths.length;

  const firstResponse = await fetch(voiceStylePaths[0]);
  const firstStyle = await firstResponse.json();

  const ttlDims: [number, number, number] = firstStyle.style_ttl.dims;
  const dpDims: [number, number, number] = firstStyle.style_dp.dims;

  const ttlDim1 = ttlDims[1];
  const ttlDim2 = ttlDims[2];
  const dpDim1 = dpDims[1];
  const dpDim2 = dpDims[2];

  const ttlSize = bsz * ttlDim1 * ttlDim2;
  const dpSize = bsz * dpDim1 * dpDim2;
  const ttlFlat = new Float32Array(ttlSize);
  const dpFlat = new Float32Array(dpSize);

  for (let i = 0; i < bsz; i++) {
    const response = await fetch(voiceStylePaths[i]);
    const voiceStyle = await response.json();

    const ttlData: number[] = voiceStyle.style_ttl.data.flat(Infinity);
    const ttlOffset = i * ttlDim1 * ttlDim2;
    ttlFlat.set(ttlData, ttlOffset);

    const dpData: number[] = voiceStyle.style_dp.data.flat(Infinity);
    const dpOffset = i * dpDim1 * dpDim2;
    dpFlat.set(dpData, dpOffset);
  }

  const ttlShape: [number, number, number] = [bsz, ttlDim1, ttlDim2];
  const dpShape: [number, number, number] = [bsz, dpDim1, dpDim2];

  const ttlTensor = new ort.Tensor('float32', ttlFlat, ttlShape);
  const dpTensor = new ort.Tensor('float32', dpFlat, dpShape);

  if (verbose) {
    console.log(`Loaded ${bsz} voice styles`);
  }

  return new Style(ttlTensor, dpTensor);
}

export async function loadCfgs(onnxDir: string): Promise<TTSConfig> {
  const response = await fetch(`${onnxDir}/tts.json`);
  const cfgs = (await response.json()) as TTSConfig;
  return cfgs;
}

export async function loadTextProcessor(onnxDir: string): Promise<UnicodeProcessor> {
  const response = await fetch(`${onnxDir}/unicode_indexer.json`);
  const indexer = (await response.json()) as number[];
  return new UnicodeProcessor(indexer);
}

export async function loadOnnx(onnxPath: string, options: ort.InferenceSession.SessionOptions): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(onnxPath, options);
}

export async function loadTextToSpeech(
  onnxDir: string,
  sessionOptions: ort.InferenceSession.SessionOptions = {},
  progressCallback: ModelProgressCallback | null = null
): Promise<{ textToSpeech: TextToSpeech; cfgs: TTSConfig }> {
  const cfgs = await loadCfgs(onnxDir);

  const dpPath = `${onnxDir}/duration_predictor.onnx`;
  const textEncPath = `${onnxDir}/text_encoder.onnx`;
  const vectorEstPath = `${onnxDir}/vector_estimator.onnx`;
  const vocoderPath = `${onnxDir}/vocoder.onnx`;

  const modelPaths = [
    { name: 'Duration Predictor', path: dpPath },
    { name: 'Text Encoder', path: textEncPath },
    { name: 'Vector Estimator', path: vectorEstPath },
    { name: 'Vocoder', path: vocoderPath }
  ];

  const sessions: ort.InferenceSession[] = [];
  for (let i = 0; i < modelPaths.length; i++) {
    progressCallback?.(modelPaths[i].name, i + 1, modelPaths.length);
    const session = await loadOnnx(modelPaths[i].path, sessionOptions);
    sessions.push(session);
  }

  const [dpOrt, textEncOrt, vectorEstOrt, vocoderOrt] = sessions;

  const textProcessor = await loadTextProcessor(onnxDir);
  const textToSpeech = new TextToSpeech(cfgs, textProcessor, dpOrt, textEncOrt, vectorEstOrt, vocoderOrt);

  return { textToSpeech, cfgs };
}

export function chunkText(text: string, maxLen = 300): string[] {
  if (typeof text !== 'string') {
    throw new Error(`chunkText expects a string, got ${typeof text}`);
  }

  // Split by double newlines to get paragraphs (each paragraph = one DOM block)
  const paragraphs = text.trim().split(/\n\s*\n+/).filter((p) => p.trim());

  const chunks: string[] = [];

  for (let paragraph of paragraphs) {
    paragraph = paragraph.trim();
    if (!paragraph) continue;

    // Short paragraphs (likely headings or short content) - keep as single chunk
    // This ensures headings are read separately from the following paragraph
    if (paragraph.length <= maxLen) {
      chunks.push(paragraph);
      continue;
    }

    // Long paragraphs - split by sentences
    const sentences = paragraph.split(
      /(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/
    );

    let currentChunk = '';

    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length + 1 <= maxLen) {
        currentChunk += (currentChunk ? ' ' : '') + sentence;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
        }
        currentChunk = sentence;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }
  }

  return chunks;
}

export function writeWavFile(audioData: number[], sampleRate: number): ArrayBuffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = audioData.length * 2;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const int16Data = new Int16Array(audioData.length);
  for (let i = 0; i < audioData.length; i++) {
    const clamped = Math.max(-1.0, Math.min(1.0, audioData[i]));
    int16Data[i] = Math.floor(clamped * 32767);
  }

  const dataView = new Uint8Array(buffer, 44);
  dataView.set(new Uint8Array(int16Data.buffer));

  return buffer;
}
