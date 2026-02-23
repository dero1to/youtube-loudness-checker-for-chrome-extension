// popup.js - ポップアップUIの制御（メーター表示・キャプチャ開始/停止）

let isCapturing = false;

// DOM要素の参照を取得
const toggleBtn = document.getElementById("toggle-btn");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("status-text");
const metersEl = document.getElementById("meters");

const momentaryValueEl = document.getElementById("momentary-value");
const shortTermValueEl = document.getElementById("shortterm-value");
const rmsValueEl = document.getElementById("rms-value");

const momentaryBarEl = document.getElementById("momentary-bar");
const shortTermBarEl = document.getElementById("shortterm-bar");
const rmsBarEl = document.getElementById("rms-bar");

// ポップアップを開いたときにbackgroundからキャプチャ状態を取得し、UIを復元する
// （ポップアップは閉じるたびに破棄されるため、状態はbackground側で保持する）
chrome.runtime.sendMessage({ type: "get-capture-state" }, (response) => {
  if (response && response.capturing) {
    setUIState(true);
  }
});

/**
 * dB値をメーターバーの幅（0〜100%）に変換する
 * 表示レンジ: -60dB（0%） 〜 0dB（100%）
 */
function dbToPercent(db) {
  if (!isFinite(db)) return 0;
  const clamped = Math.max(-60, Math.min(0, db));
  return ((clamped + 60) / 60) * 100;
}

/**
 * dB値に応じたメーターバーの色クラスを返す
 *   緑: -14 LUFS以下（YouTubeの正常範囲）
 *   黄: -14〜-8 LUFS（やや大きい）
 *   赤: -8 LUFS超（クリッピング危険域）
 */
function getMeterColor(db) {
  if (db > -8) return "meter-bar--red";
  if (db > -14) return "meter-bar--yellow";
  return "meter-bar--green";
}

/**
 * dB値を表示用文字列にフォーマットする
 * 無音（-Infinity）の場合は「-∞」と表示
 */
function formatDB(value, unit) {
  if (!isFinite(value)) return `-\u221E ${unit}`;
  return `${value.toFixed(1)} ${unit}`;
}

/**
 * メーターバーと数値表示を更新する
 *
 * @param {HTMLElement} barEl - メーターバーのDOM要素
 * @param {HTMLElement} valueEl - 数値表示のDOM要素
 * @param {number} db - dB値
 * @param {string} unit - 単位（"LUFS" or "dBFS"）
 */
function updateMeter(barEl, valueEl, db, unit) {
  const pct = dbToPercent(db);
  barEl.style.width = `${pct}%`;

  // 色クラスをリセットして現在の値に応じた色を適用
  barEl.classList.remove(
    "meter-bar--green",
    "meter-bar--yellow",
    "meter-bar--red"
  );
  barEl.classList.add(getMeterColor(db));

  valueEl.textContent = formatDB(db, unit);
}

/**
 * offscreen → background経由で届く測定データを受信し、メーターを更新する
 * 100ms間隔（10Hz）で呼ばれる
 */
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "loudness-data") {
    updateMeter(
      momentaryBarEl,
      momentaryValueEl,
      message.momentaryLUFS,
      "LUFS"
    );
    updateMeter(
      shortTermBarEl,
      shortTermValueEl,
      message.shortTermLUFS,
      "LUFS"
    );
    updateMeter(rmsBarEl, rmsValueEl, message.rmsDB, "dBFS");
  }
});

/**
 * 開始/停止ボタンのクリックハンドラ
 *
 * 開始時:
 *   1. アクティブタブを取得
 *   2. YouTubeタブかどうかを確認
 *   3. backgroundにstart-captureメッセージを送信
 *
 * 停止時:
 *   backgroundにstop-captureメッセージを送信
 */
toggleBtn.addEventListener("click", async () => {
  if (isCapturing) {
    // 計測停止
    chrome.runtime.sendMessage({ type: "stop-capture" });
    setUIState(false);
  } else {
    // 現在のアクティブタブを取得
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab) {
      statusText.textContent = "アクティブなタブが見つかりません";
      return;
    }

    // YouTubeタブかどうかを確認
    if (!tab.url || !tab.url.includes("youtube.com")) {
      statusText.textContent = "YouTubeのタブではありません";
      statusEl.className = "status status--error";
      return;
    }

    // 計測開始
    toggleBtn.disabled = true;
    statusText.textContent = "開始中...";

    const response = await chrome.runtime.sendMessage({
      type: "start-capture",
      tabId: tab.id,
    });

    toggleBtn.disabled = false;

    if (response && response.success) {
      setUIState(true);
    } else {
      statusText.textContent = `エラー: ${response?.error || "不明なエラー"}`;
      statusEl.className = "status status--error";
    }
  }
});

/**
 * UIの表示状態を計測中/停止中で切り替える
 *
 * @param {boolean} capturing - true: 計測中, false: 停止中
 */
function setUIState(capturing) {
  isCapturing = capturing;

  if (capturing) {
    toggleBtn.textContent = "停止";
    toggleBtn.classList.add("btn--stop");
    statusEl.className = "status status--active";
    statusText.textContent = "計測中...";
    metersEl.classList.remove("hidden");
  } else {
    toggleBtn.textContent = "計測開始";
    toggleBtn.classList.remove("btn--stop");
    statusEl.className = "status status--idle";
    statusText.textContent = "停止中";
    metersEl.classList.add("hidden");
  }
}
