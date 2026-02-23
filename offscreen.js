// offscreen.js - AudioWorkletNodeを使ったリアルタイム音声解析
//
// MV3のService WorkerではAudioContextが使えないため、
// オフスクリーンドキュメント上で音声キャプチャ・計測・再生を行う。
//
// オーディオグラフ:
//   source → workletNode (計測のみ)
//   source → gainNode → destination (再生・音量調整)

let audioContext = null;
let sourceNode = null;
let workletNode = null;
let gainNode = null;
let stream = null;

// ============================================================
// メッセージハンドラ
// ============================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case "start-audio-processing":
      startProcessing(message.streamId).then(sendResponse);
      return true; // 非同期レスポンス

    case "stop-audio-processing":
      stopProcessing();
      sendResponse({ success: true });
      return false;

    case "set-volume":
      if (gainNode) gainNode.gain.value = message.volume;
      return false;
  }
});

// ============================================================
// オーディオグラフ構築（startProcessing / devicechange 共通）
// ============================================================

/**
 * ストリームからAudioContext・ノードチェーンを構築する
 *
 * @param {MediaStream} mediaStream - tabCaptureのメディアストリーム
 * @param {number} initialGain - GainNodeの初期値（デバイス変更時にゲインを復元）
 */
async function buildAudioGraph(mediaStream, initialGain = 1) {
  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule("loudness-processor.js");

  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  const channelCount = sourceNode.channelCount || 2;

  workletNode = new AudioWorkletNode(audioContext, "loudness-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [channelCount],
    processorOptions: { channelCount },
  });

  workletNode.port.onmessage = (event) => {
    chrome.runtime
      .sendMessage({ type: "loudness-data", ...event.data, sampleRate: audioContext.sampleRate })
      .catch(() => {});
  };

  sourceNode.connect(workletNode);               // 計測パス
  gainNode = audioContext.createGain();
  gainNode.gain.value = initialGain;
  sourceNode.connect(gainNode);                   // 再生パス
  gainNode.connect(audioContext.destination);
}

// ============================================================
// 音声処理の開始・停止
// ============================================================

/**
 * 音声処理を開始する
 *
 * 1. tabCaptureのstreamIdでメディアストリームを取得
 * 2. buildAudioGraph() でオーディオグラフを構築
 */
async function startProcessing(streamId) {
  try {
    stopProcessing();

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });

    await buildAudioGraph(stream);
    return { success: true };
  } catch (err) {
    console.error("音声処理の開始に失敗:", err);
    return { success: false, error: err.message };
  }
}

/**
 * 音声処理を停止し、全リソースを解放する
 * 解放順序: ノード切断 → AudioContext終了 → ストリーム停止
 */
function stopProcessing() {
  if (workletNode)  { workletNode.disconnect();  workletNode = null; }
  if (gainNode)     { gainNode.disconnect();     gainNode = null; }
  if (sourceNode)   { sourceNode.disconnect();   sourceNode = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  if (stream)       { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}

// ============================================================
// 音声出力デバイス変更の監視
//
// スピーカー/ヘッドホン切替・Bluetooth接続/切断時に
// AudioContextを再構築して新しいデバイスに音声をルーティングする。
// ストリーム（tabCapture）はデバイスに依存しないので維持する。
// ============================================================

navigator.mediaDevices.addEventListener("devicechange", async () => {
  if (!audioContext || !stream) return;

  const savedGain = gainNode?.gain.value ?? 1;

  // ノード切断・AudioContext閉鎖（streamは維持）
  if (workletNode)  { workletNode.disconnect();  workletNode = null; }
  if (gainNode)     { gainNode.disconnect();     gainNode = null; }
  if (sourceNode)   { sourceNode.disconnect();   sourceNode = null; }
  if (audioContext) { await audioContext.close().catch(() => {}); audioContext = null; }

  try {
    await buildAudioGraph(stream, savedGain);
  } catch (err) {
    console.error("デバイス変更後のAudioContext再構築に失敗:", err);
  }
});
