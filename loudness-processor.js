// loudness-processor.js - AudioWorkletProcessor
//
// オーディオスレッド上で動作する音声計測プロセッサ。
// 各計測は独立したクラスに分離し、LoudnessProcessorが統合する。
//
// - LUFSMeter: ITU-R BS.1770 準拠（Momentary / Short-term / Integrated）
// - VUMeter:   ANSI C16.5 バリスティック特性
// - RMSMeter:  信号レベル（聴覚補正なし）

// ============================================================
// ITU-R BS.1770 K-weightingフィルタ係数
// ============================================================

const K_WEIGHT_COEFFS = {
  48000: {
    stage1: {
      b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
      a: [1.0, -1.69065929318241, 0.73248077421585],
    },
    stage2: {
      b: [1.0, -2.0, 1.0],
      a: [1.0, -1.99004745483398, 0.99007225036621],
    },
  },
  44100: {
    stage1: {
      b: [1.5308412300498355, -2.6509799951536985, 1.1690790799210682],
      a: [1.0, -1.6636551132560204, 0.7125954280732254],
    },
    stage2: {
      b: [1.0, -2.0, 1.0],
      a: [1.0, -1.9891696736297957, 0.9891990357870394],
    },
  },
};

/**
 * バイクアッドフィルタ（Direct Form I）を1サンプルに適用
 *
 * y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
 */
function applyBiquad(sample, b, a, state) {
  const out =
    b[0] * sample +
    b[1] * state.x1 +
    b[2] * state.x2 -
    a[1] * state.y1 -
    a[2] * state.y2;
  state.x2 = state.x1;
  state.x1 = sample;
  state.y2 = state.y1;
  state.y1 = out;
  return out;
}

// ============================================================
// LUFSMeter - ITU-R BS.1770 準拠ラウドネス計測
// ============================================================

class LUFSMeter {
  constructor(sr, channelCount) {
    this.channelCount = channelCount;
    this.coeffs = K_WEIGHT_COEFFS[sr] || K_WEIGHT_COEFFS[48000];

    // チャンネルごとのK-weightingフィルタ状態（2段 × ch数）
    this.filterStates = [];
    for (let ch = 0; ch < channelCount; ch++) {
      this.filterStates.push({
        stage1: { x1: 0, x2: 0, y1: 0, y2: 0 },
        stage2: { x1: 0, x2: 0, y1: 0, y2: 0 },
      });
    }

    // Momentary / Short-term リングバッファ
    this.momentarySize = Math.floor(sr * 0.4); // 400ms
    this.shortTermSize = Math.floor(sr * 3); // 3秒

    this.momentaryBuf = [];
    this.shortTermBuf = [];
    for (let ch = 0; ch < channelCount; ch++) {
      this.momentaryBuf.push(new Float64Array(this.momentarySize));
      this.shortTermBuf.push(new Float64Array(this.shortTermSize));
    }
    this.momentaryIdx = 0;
    this.shortTermIdx = 0;
    this.momentaryFilled = 0;
    this.shortTermFilled = 0;

    // Integrated LUFS用（BS.1770-4 ゲーティング）
    this.blockLoudness = [];
    this.integratedBlockStep = Math.floor(sr * 0.1); // 100ms（75%オーバーラップ）
    this.samplesSinceBlock = 0;
  }

  /** サンプルごとに呼ばれる。K-weightingを適用しバッファに蓄積 */
  pushSample(ch, raw, sampleOffset) {
    const afterStage1 = applyBiquad(
      raw,
      this.coeffs.stage1.b,
      this.coeffs.stage1.a,
      this.filterStates[ch].stage1
    );
    const weighted = applyBiquad(
      afterStage1,
      this.coeffs.stage2.b,
      this.coeffs.stage2.a,
      this.filterStates[ch].stage2
    );

    const sq = weighted * weighted;
    this.momentaryBuf[ch][(this.momentaryIdx + sampleOffset) % this.momentarySize] = sq;
    this.shortTermBuf[ch][(this.shortTermIdx + sampleOffset) % this.shortTermSize] = sq;
  }

  /** レンダークォンタム（128サンプル）ごとにインデックスを進める */
  advance(numSamples) {
    this.momentaryIdx = (this.momentaryIdx + numSamples) % this.momentarySize;
    this.shortTermIdx = (this.shortTermIdx + numSamples) % this.shortTermSize;
    this.momentaryFilled = Math.min(this.momentaryFilled + numSamples, this.momentarySize);
    this.shortTermFilled = Math.min(this.shortTermFilled + numSamples, this.shortTermSize);

    // Integrated: 100msごとにブロックラウドネスを蓄積
    this.samplesSinceBlock += numSamples;
    if (this.samplesSinceBlock >= this.integratedBlockStep && this.momentaryFilled >= this.momentarySize) {
      this.samplesSinceBlock = 0;
      this.blockLoudness.push(this._calcPower(this.momentaryBuf, this.momentaryFilled));
    }
  }

  /** チャンネル加重パワーを算出（LUFS変換前の線形値） */
  _calcPower(buffers, filled) {
    if (filled === 0) return 0;
    let sum = 0;
    for (let ch = 0; ch < this.channelCount; ch++) {
      const weight = this.channelCount <= 2 ? 1.0 : [1, 1, 1, 0, 1.41, 1.41][ch] || 1.0;
      if (weight === 0) continue;
      let chSum = 0;
      for (let i = 0; i < filled; i++) {
        chSum += buffers[ch][i];
      }
      sum += weight * (chSum / filled);
    }
    return sum;
  }

  /** パワーをLUFS値に変換 */
  _powerToLUFS(power) {
    if (power <= 0) return -Infinity;
    return Math.max(-60, -0.691 + 10 * Math.log10(power));
  }

  momentary() {
    return this._powerToLUFS(this._calcPower(this.momentaryBuf, this.momentaryFilled));
  }

  shortTerm() {
    return this._powerToLUFS(this._calcPower(this.shortTermBuf, this.shortTermFilled));
  }

  /**
   * Integrated LUFS（BS.1770-4 ゲーティング）
   * 1. 絶対ゲート: -70 LUFS以下を除外
   * 2. 相対ゲート: 平均 - 10 dB以下を除外
   */
  integrated() {
    if (this.blockLoudness.length === 0) return -Infinity;

    const ABS_GATE = Math.pow(10, (-70 + 0.691) / 10);
    const afterAbsGate = this.blockLoudness.filter((p) => p > ABS_GATE);
    if (afterAbsGate.length === 0) return -Infinity;

    const absGateMean = afterAbsGate.reduce((a, b) => a + b, 0) / afterAbsGate.length;
    const REL_GATE = absGateMean * 0.1; // -10 dB

    const afterRelGate = afterAbsGate.filter((p) => p > REL_GATE);
    if (afterRelGate.length === 0) return -Infinity;

    const finalMean = afterRelGate.reduce((a, b) => a + b, 0) / afterRelGate.length;
    return this._powerToLUFS(finalMean);
  }
}

// ============================================================
// VUMeter - ANSI C16.5 バリスティック特性
// ============================================================

class VUMeter {
  constructor(sr, channelCount) {
    this.channelCount = channelCount;
    this.coeff = Math.exp(-1 / (sr * 0.3)); // 300ms時定数
    this.level = new Float64Array(channelCount);
  }

  /** サンプルごとに呼ばれる。1次IIRローパスで平滑化 */
  pushSample(ch, raw) {
    this.level[ch] = this.coeff * this.level[ch] + (1 - this.coeff) * Math.abs(raw);
  }

  /** VU値（0 VU = -20 dBFS） */
  read() {
    let sum = 0;
    for (let ch = 0; ch < this.channelCount; ch++) {
      sum += this.level[ch];
    }
    const avg = sum / this.channelCount;
    if (avg <= 0) return -Infinity;
    return Math.max(-60, 20 * Math.log10(avg) + 20);
  }
}

// ============================================================
// RMSMeter - 信号レベル（聴覚補正なし）
// ============================================================

class RMSMeter {
  constructor(sr, channelCount) {
    this.channelCount = channelCount;
    this.bufSize = Math.floor(sr * 0.4); // 400ms
    this.buf = [];
    for (let ch = 0; ch < channelCount; ch++) {
      this.buf.push(new Float64Array(this.bufSize));
    }
    this.idx = 0;
    this.filled = 0;
  }

  /** サンプルごとに呼ばれる。生の二乗値を蓄積 */
  pushSample(ch, raw, sampleOffset) {
    this.buf[ch][(this.idx + sampleOffset) % this.bufSize] = raw * raw;
  }

  /** レンダークォンタムごとにインデックスを進める */
  advance(numSamples) {
    this.idx = (this.idx + numSamples) % this.bufSize;
    this.filled = Math.min(this.filled + numSamples, this.bufSize);
  }

  /** RMS(dBFS) = 20 * log10( sqrt( 平均二乗値 ) ) */
  read() {
    if (this.filled === 0) return -Infinity;

    let sum = 0;
    for (let ch = 0; ch < this.channelCount; ch++) {
      let chSum = 0;
      for (let i = 0; i < this.filled; i++) {
        chSum += this.buf[ch][i];
      }
      sum += chSum / this.filled;
    }

    const rms = Math.sqrt(sum / this.channelCount);
    if (rms <= 0) return -Infinity;
    return Math.max(-60, 20 * Math.log10(rms));
  }
}

// ============================================================
// LoudnessProcessor - 各メーターを統合する AudioWorkletProcessor
// ============================================================

class LoudnessProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const channelCount = options.processorOptions?.channelCount || 2;
    this.channelCount = channelCount;
    const sr = sampleRate;

    this.lufs = new LUFSMeter(sr, channelCount);
    this.vu = new VUMeter(sr, channelCount);
    this.rms = new RMSMeter(sr, channelCount);

    this.reportInterval = Math.floor(sr * 0.1); // 約100ms
    this.samplesSinceReport = 0;
  }

  /**
   * オーディオスレッドから128サンプルごとに呼ばれるメイン処理
   *
   * 音声パススルーはsourceNodeからdestinationへの直接接続で行うため、
   * このプロセッサでは計測のみを担当する。
   */
  process(inputs, outputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const numSamples = input[0].length;
    const chCount = Math.min(input.length, this.channelCount);

    // 各メーターにサンプルを供給
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < chCount; ch++) {
        const raw = input[ch][i];
        this.lufs.pushSample(ch, raw, i); // K-weighting → リングバッファ
        this.vu.pushSample(ch, raw);      // IIRローパス平滑化
        this.rms.pushSample(ch, raw, i);  // 生の二乗値 → リングバッファ
      }
    }

    // リングバッファのインデックス更新（VUは状態変数のみなので不要）
    this.lufs.advance(numSamples);
    this.rms.advance(numSamples);

    // 約100msごとに全メーターの計測結果をメインスレッドに送信
    this.samplesSinceReport += numSamples;
    if (this.samplesSinceReport >= this.reportInterval) {
      this.samplesSinceReport = 0;
      this.port.postMessage({
        momentaryLUFS: this.lufs.momentary(),
        shortTermLUFS: this.lufs.shortTerm(),
        integratedLUFS: this.lufs.integrated(),
        vuDB: this.vu.read(),
        rmsDB: this.rms.read(),
      });
    }

    return true;
  }
}

registerProcessor("loudness-processor", LoudnessProcessor);
