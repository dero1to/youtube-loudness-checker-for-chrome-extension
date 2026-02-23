// background.js - タブキャプチャを管理するService Worker
//
// アイコンクリックで計測をトグルし、測定データを
// offscreen → background → content script のルートで転送する。
// YouTubeプレイヤーのラウドネス正規化情報もcontent scriptに提供する。

let offscreenDocumentCreated = false;
let capturing = false;
let captureTabId = null;

// ============================================================
// オフスクリーンドキュメント管理
// ============================================================

/**
 * オフスクリーンドキュメントが存在しなければ作成する。
 * MV3ではService Worker内でAudioContextが使えないため、
 * 音声処理専用のオフスクリーンドキュメントを用意する。
 */
async function ensureOffscreenDocument() {
  if (offscreenDocumentCreated) return;

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")],
  });

  if (existingContexts.length > 0) {
    offscreenDocumentCreated = true;
    return;
  }

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification:
      "Audio capture via getUserMedia and playback to keep tab audio audible",
  });
  offscreenDocumentCreated = true;
}

// ============================================================
// アイコンクリック → キャプチャのON/OFF切り替え
// ============================================================

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !tab.url.includes("youtube.com")) return;

  if (capturing) {
    await stopCapture();
  } else {
    // content scriptを確実に注入（拡張更新直後は既存タブに自動注入されないため）
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });

    const result = await handleStartCapture(tab.id);
    if (result.success) {
      chrome.tabs.sendMessage(tab.id, { type: "capture-started" }).catch(() => {});
      chrome.action.setBadgeText({ text: "ON" });
      chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
    }
  }
});

// ============================================================
// メッセージルーティング
//
// content script → background:
//   stop-capture, set-volume, get-capture-state, get-yt-loudness
// offscreen → background → content script:
//   loudness-data
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "stop-capture":
      stopCapture();
      sendResponse({ success: true });
      return false;

    case "get-capture-state":
      sendResponse({ capturing, tabId: captureTabId });
      return false;

    case "set-volume":
      chrome.runtime.sendMessage(message).catch(() => {});
      return false;

    case "get-yt-loudness":
      fetchYouTubeLoudnessFromPlayer(sender.tab.id)
        .then((data) => sendResponse({ data }))
        .catch(() => sendResponse({ data: null }));
      return true; // 非同期レスポンス

    case "loudness-data":
      if (captureTabId) {
        chrome.tabs.sendMessage(captureTabId, message).catch(() => {});
      }
      return false;
  }
});

// ============================================================
// キャプチャ制御
// ============================================================

/** キャプチャを停止し、UIとバッジをリセットする */
async function stopCapture() {
  chrome.runtime.sendMessage({ type: "stop-audio-processing" }).catch(() => {});

  if (captureTabId) {
    chrome.tabs.sendMessage(captureTabId, { type: "capture-stopped" }).catch(() => {});
  }

  capturing = false;
  captureTabId = null;
  chrome.action.setBadgeText({ text: "" });
}

/**
 * タブキャプチャを開始し、offscreenドキュメントに音声処理を依頼する。
 *
 * 1. 既存キャプチャがあれば停止
 * 2. オフスクリーンドキュメントを確保
 * 3. chrome.tabCapture.getMediaStreamId() でストリームIDを取得
 * 4. offscreenにストリームIDを送り、音声処理を開始させる
 */
async function handleStartCapture(tabId) {
  try {
    if (capturing) await stopCapture();

    await ensureOffscreenDocument();

    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });

    await chrome.runtime.sendMessage({
      type: "start-audio-processing",
      streamId,
    });

    capturing = true;
    captureTabId = tabId;
    return { success: true };
  } catch (err) {
    console.error("キャプチャ失敗:", err);
    return { success: false, error: err.message };
  }
}

// ============================================================
// YouTubeプレイヤーからラウドネス情報を取得
//
// ページコンテキスト（world: 'MAIN'）で実行し、
// #movie_player.getPlayerResponse() から audioConfig を読み取る。
// ============================================================

async function fetchYouTubeLoudnessFromPlayer(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const player = document.getElementById("movie_player");
      if (!player || typeof player.getPlayerResponse !== "function") return null;

      const response = player.getPlayerResponse();
      const audioConfig = response?.playerConfig?.audioConfig;
      if (!audioConfig) return null;

      return {
        loudnessDb: audioConfig.loudnessDb ?? null,
        perceptualLoudnessDb: audioConfig.perceptualLoudnessDb ?? null,
      };
    },
  });

  return results?.[0]?.result ?? null;
}
