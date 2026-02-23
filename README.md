# YouTube Loudness Checker

YouTube の動画音声をリアルタイムで計測し、ラウドネス（LUFS）と RMS を画面上に表示する Chrome 拡張機能です。

## 計測項目

| 指標 | 窓幅 | 説明 |
|------|------|------|
| Momentary LUFS | 0.4 秒 | 瞬時音量。急な爆音やピークを捉える |
| Short-term LUFS | 3 秒 | 体感的な「今の音量」に近い平均値 |
| RMS (dBFS) | 0.4 秒 | 聴覚補正なしの信号レベル。LUFS との差で周波数バランスがわかる |

LUFS は ITU-R BS.1770 準拠の K-weighting フィルタを適用して算出しています。YouTube は動画のラウドネスが **-14 LUFS** を超えると自動でノーマライズ（音量を下げる）します。

## 使い方

1. Chrome に拡張をインストール
2. YouTube で動画を開く
3. 拡張アイコンをクリック → 画面右上にメーターが表示され計測開始
4. もう一度アイコンをクリック、またはウィジェットの × ボタンで計測停止

ウィジェットはドラッグで自由に移動できます。

## アーキテクチャ

Chrome Extension Manifest V3 の制約上、Service Worker 内で `AudioContext` が使えないため、3 つのコンテキストが協調して動作します。

```
┌─────────────┐    メッセージ     ┌──────────────┐    メッセージ     ┌─────────────────┐
│ content.js  │ ◄──────────────► │ background.js│ ◄──────────────► │  offscreen.js   │
│ (YouTube    │                  │ (Service     │                  │  (Offscreen     │
│  ページ内)   │                  │  Worker)     │                  │   Document)     │
│             │                  │              │                  │                 │
│ ・UIウィジェ │                  │ ・tabCapture │                  │ ・AudioContext  │
│   ット表示   │                  │   制御       │                  │ ・AudioWorklet  │
│ ・Shadow DOM│                  │ ・メッセージ  │                  │ ・LUFS/RMS計算  │
│ ・ドラッグ   │                  │   中継       │                  │ ・音声パススルー │
└─────────────┘                  └──────────────┘                  └─────────────────┘
                                                                          │
                                                                  ┌───────┴───────┐
                                                                  │ loudness-     │
                                                                  │ processor.js  │
                                                                  │ (AudioWorklet │
                                                                  │  Processor)   │
                                                                  └───────────────┘
```

### 処理の流れ

1. **アイコンクリック** → `background.js` が `chrome.tabCapture.getMediaStreamId()` でタブ音声のストリーム ID を取得
2. **Offscreen Document 作成** → `offscreen.html` / `offscreen.js` が音声処理用のドキュメントとして起動
3. **音声キャプチャ開始** → `offscreen.js` がストリーム ID から `getUserMedia()` で音声ストリームを取得し、`AudioContext` に接続
4. **AudioWorklet で計測** → `loudness-processor.js` がオーディオスレッド上で 128 サンプルごとに K-weighting + LUFS/RMS 計算を実行、約 100ms ごとに結果を返す
5. **結果を表示** → `offscreen.js` → `background.js` → `content.js` とメッセージを中継し、YouTube 画面上の Shadow DOM ウィジェットに反映

### オーディオノードチェーン

```
MediaStreamSource → AudioWorkletNode (計測 + パススルー) → AudioContext.destination (スピーカー)
```

AudioWorkletNode 内で入力を出力にコピーすることで、計測中もタブの音声がそのまま聞こえます。

## ファイル構成

```
├── manifest.json          … MV3 マニフェスト（権限・content script 定義）
├── background.js          … Service Worker（tabCapture 管理、メッセージ中継）
├── offscreen.html         … Offscreen Document の HTML シェル
├── offscreen.js           … AudioContext + AudioWorkletNode の管理
├── loudness-processor.js  … AudioWorkletProcessor（K-weighting、LUFS/RMS 計算）
├── content.js             … YouTube 画面上のオーバーレイ UI（Shadow DOM）
└── icons/                 … 拡張アイコン（16/48/128px）
```

## 使用している権限

| 権限 | 用途 |
|------|------|
| `tabCapture` | タブの音声ストリームを取得 |
| `offscreen` | Service Worker 外で AudioContext を使うための Offscreen Document 作成 |
| `activeTab` | アクティブタブへのアクセス |
| `scripting` | content script の動的注入（拡張更新後も確実に動作させるため） |

## 技術的な補足

- **K-weighting フィルタ**: 48kHz / 44.1kHz のバイクアッド係数を内蔵。2 段の IIR フィルタ（Direct Form I）で実装
- **リングバッファ**: `Float64Array` を使用し、精度を確保しつつ固定メモリで動作
- **Shadow DOM**: YouTube の CSS と完全に分離されたウィジェットを実現。`mode: "closed"` で外部からのアクセスを遮断
- **無音判定**: tabCapture は停止中も微小ノイズを送出するため、-60 dB 以下を無音として扱う
