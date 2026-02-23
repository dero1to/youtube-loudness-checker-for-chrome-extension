// content.js - YouTube画面上にラウドネスメーターをオーバーレイ表示する
//
// Shadow DOMを使用してYouTubeのCSSと完全に分離。
// backgroundから届く計測データ（LUFS/VU/RMS）をリアルタイム表示し、
// YouTubeプレイヤーのラウドネス正規化情報も取得して表示する。

(function () {
  "use strict";

  // 二重注入を防止
  if (document.getElementById("yt-loudness-host")) return;

  // ============================================================
  // Shadow DOMホストの作成
  // ============================================================

  const host = document.createElement("div");
  host.id = "yt-loudness-host";
  host.style.cssText = "all:initial; position:fixed; z-index:2147483647;";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "closed" });

  // ============================================================
  // スタイル定義（Shadow DOM内に閉じるのでYouTubeに影響しない）
  // ============================================================

  const style = document.createElement("style");
  style.textContent = `
    /* ウィジェット本体 */
    .widget {
      position: fixed;
      top: 12px;
      right: 12px;
      width: 280px;
      background: rgba(15, 15, 30, 0.95);
      border: 1px solid #334155;
      border-radius: 10px;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      backdrop-filter: blur(8px);
      user-select: none;
      transition: opacity 0.2s;
    }
    .widget.hidden { display: none; }

    /* ヘッダー（ドラッグ可能領域） */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid #1e293b;
      cursor: grab;
    }
    .header:active { cursor: grabbing; }
    .title { font-size: 13px; font-weight: 600; color: #fff; }
    .header-btns { display: flex; gap: 4px; align-items: center; }
    .header-btn {
      width: 22px; height: 22px;
      border: none; border-radius: 50%;
      background: #334155; color: #94a3b8;
      font-size: 13px; line-height: 1;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    .close-btn:hover { background: #ef4444; color: #fff; }

    /* メーターエリア */
    .body { padding: 10px 12px; }
    .meter { margin-bottom: 10px; }
    .meter:last-of-type { margin-bottom: 0; }

    .meter-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 3px;
    }
    .meter-label {
      font-size: 10px; font-weight: 600;
      color: #94a3b8; text-transform: uppercase; letter-spacing: 0.3px;
    }
    .meter-value {
      font-size: 13px; font-weight: 700;
      font-variant-numeric: tabular-nums; color: #fff;
    }

    /* メーターバー */
    .bar-bg {
      height: 10px; background: #1e293b;
      border-radius: 3px; overflow: hidden;
    }
    .bar {
      height: 100%; width: 0%;
      border-radius: 3px;
      transition: width 0.08s linear;
    }
    .bar.green  { background: linear-gradient(90deg, #22c55e, #4ade80); }
    .bar.yellow { background: linear-gradient(90deg, #eab308, #facc15); }
    .bar.red    { background: linear-gradient(90deg, #ef4444, #f87171); }
    .bar.rms    { background: linear-gradient(90deg, #6366f1, #818cf8); }
    .bar.vu     { background: linear-gradient(90deg, #f59e0b, #fbbf24); }

    /* メーターセクション区切り */
    .meter-section-label {
      font-size: 9px; font-weight: 600;
      color: #475569; text-transform: uppercase; letter-spacing: 0.5px;
      padding-bottom: 4px; margin-bottom: 8px;
      border-bottom: 1px solid #1e293b;
    }
    .meter-section + .meter-section { margin-top: 10px; }

    /* スケールラベル */
    .scale {
      display: flex; justify-content: space-between;
      margin-top: 1px; font-size: 8px; color: #475569;
    }

    /* ツールチップ */
    .tip {
      position: relative;
      display: inline-flex; align-items: center; justify-content: center;
      width: 12px; height: 12px; margin-left: 3px;
      border-radius: 50%; background: #334155;
      color: #64748b; font-size: 8px; font-weight: 700;
      cursor: help; vertical-align: middle;
    }
    .tip::after {
      content: attr(data-tip);
      position: absolute; bottom: calc(100% + 6px);
      left: 50%; transform: translateX(-50%);
      width: 180px; padding: 6px 8px; border-radius: 5px;
      background: #1e293b; border: 1px solid #475569;
      color: #e2e8f0; font-size: 10px; font-weight: 400;
      line-height: 1.4; text-transform: none; letter-spacing: 0;
      white-space: normal; pointer-events: none;
      opacity: 0; transition: opacity 0.15s; z-index: 10;
    }
    .tip:hover::after { opacity: 1; }

    /* ボリュームスライダー */
    .volume {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 12px 8px;
    }
    .volume-icon { flex-shrink: 0; width: 14px; height: 14px; color: #94a3b8; }
    .volume-slider {
      -webkit-appearance: none; appearance: none;
      flex: 1; height: 4px; border-radius: 2px;
      background: #334155; outline: none; cursor: pointer;
    }
    .volume-slider::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 12px; height: 12px; border-radius: 50%;
      background: #e0e0e0; cursor: pointer;
    }
    .volume-pct {
      width: 28px; text-align: right;
      font-size: 10px; font-variant-numeric: tabular-nums; color: #94a3b8;
    }

    /* YouTube Normalization 情報 */
    .yt-info { padding: 8px 12px 10px; border-top: 1px solid #1e293b; }
    .yt-info-row {
      display: flex; justify-content: space-between;
      align-items: baseline; margin-bottom: 2px;
    }
    .yt-info-row:last-child { margin-bottom: 0; }
    .yt-info-label { font-size: 10px; color: #94a3b8; }
    .yt-info-value {
      font-size: 12px; font-weight: 600;
      font-variant-numeric: tabular-nums; color: #e0e0e0;
    }
  `;
  shadow.appendChild(style);

  // ============================================================
  // ウィジェットHTML
  // ============================================================

  const widget = document.createElement("div");
  widget.className = "widget hidden";
  widget.innerHTML = `
    <div class="header" id="drag-handle">
      <span class="title">YouTube Loudness</span>
      <div class="header-btns">
        <button class="header-btn close-btn" title="計測停止">&times;</button>
      </div>
    </div>
    <div class="body">
      <!-- ITU-R BS.1770 LUFS -->
      <div class="meter-section">
        <div class="meter-section-label">LUFS (ITU-R BS.1770)</div>
        <div class="meter">
          <div class="meter-header">
            <span class="meter-label">
              Momentary
              <span class="tip" data-tip="直近0.4秒の瞬時音量。急な爆音やピークを捉える">?</span>
            </span>
            <span class="meter-value" id="m-val">--.-- LUFS</span>
          </div>
          <div class="bar-bg"><div class="bar green" id="m-bar"></div></div>
          <div class="scale"><span>-60</span><span>-36</span><span>-24</span><span>-14</span><span>0</span></div>
        </div>
        <div class="meter">
          <div class="meter-header">
            <span class="meter-label">
              Short-term
              <span class="tip" data-tip="直近3秒の平均音量。体感的な「今の音量」に近い">?</span>
            </span>
            <span class="meter-value" id="s-val">--.-- LUFS</span>
          </div>
          <div class="bar-bg"><div class="bar green" id="s-bar"></div></div>
          <div class="scale"><span>-60</span><span>-36</span><span>-24</span><span>-14</span><span>0</span></div>
        </div>
        <div class="meter">
          <div class="meter-header">
            <span class="meter-label">
              Integrated
              <span class="tip" data-tip="計測開始からの全体平均。無音区間はゲーティングで除外される。YouTube比較に最適">?</span>
            </span>
            <span class="meter-value" id="i-val">--.-- LUFS</span>
          </div>
          <div class="bar-bg"><div class="bar green" id="i-bar"></div></div>
          <div class="scale"><span>-60</span><span>-36</span><span>-24</span><span>-14</span><span>0</span></div>
        </div>
      </div>
      <!-- Signal Level（BS.1770とは無関係） -->
      <div class="meter-section">
        <div class="meter-section-label">Signal Level</div>
        <div class="meter">
          <div class="meter-header">
            <span class="meter-label">
              VU
              <span class="tip" data-tip="300msバリスティック特性。アナログメーターの針の動きを模倣。0 VU = -20 dBFS">?</span>
            </span>
            <span class="meter-value" id="v-val">--.-- VU</span>
          </div>
          <div class="bar-bg"><div class="bar vu" id="v-bar"></div></div>
          <div class="scale"><span>-60</span><span>-36</span><span>-24</span><span>-14</span><span>0</span></div>
        </div>
        <div class="meter">
          <div class="meter-header">
            <span class="meter-label">
              RMS
              <span class="tip" data-tip="聴覚補正なしの信号レベル（0.4秒）。LUFSとの差で周波数バランスがわかる">?</span>
            </span>
            <span class="meter-value" id="r-val">--.-- dBFS</span>
          </div>
          <div class="bar-bg"><div class="bar rms" id="r-bar"></div></div>
          <div class="scale"><span>-60</span><span>-36</span><span>-24</span><span>-14</span><span>0</span></div>
        </div>
      </div>
    </div>
    <div class="volume">
      <svg class="volume-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
      </svg>
      <input type="range" class="volume-slider" id="vol-slider" min="0" max="100" value="100">
      <span class="volume-pct" id="vol-pct">100</span>
    </div>
    <div class="yt-info">
      <div class="meter-section-label">YouTube Normalization</div>
      <div class="yt-info-row">
        <span class="yt-info-label">
          Original
          <span class="tip" data-tip="YouTubeがアップロード時に計測した推定ラウドネス。-14 LUFSがYouTubeのターゲット">?</span>
        </span>
        <span class="yt-info-value" id="yt-original-val">--</span>
      </div>
      <div class="yt-info-row">
        <span class="yt-info-label">
          Adjustment
          <span class="tip" data-tip="YouTubeが再生時に適用する音量補正。ターゲット(-14 LUFS)より大きい動画は自動で下げられる">?</span>
        </span>
        <span class="yt-info-value" id="yt-adj-val">--</span>
      </div>
    </div>
  `;
  shadow.appendChild(widget);

  // ============================================================
  // DOM要素の参照
  // ============================================================

  // メーターバー・数値
  const mBar = shadow.getElementById("m-bar");
  const sBar = shadow.getElementById("s-bar");
  const iBar = shadow.getElementById("i-bar");
  const vBar = shadow.getElementById("v-bar");
  const rBar = shadow.getElementById("r-bar");
  const mVal = shadow.getElementById("m-val");
  const sVal = shadow.getElementById("s-val");
  const iVal = shadow.getElementById("i-val");
  const vVal = shadow.getElementById("v-val");
  const rVal = shadow.getElementById("r-val");

  // YouTube Normalization
  const ytOriginalVal = shadow.getElementById("yt-original-val");
  const ytAdjVal = shadow.getElementById("yt-adj-val");

  // ボリュームスライダー
  const volSlider = shadow.getElementById("vol-slider");
  const volPct = shadow.getElementById("vol-pct");

  // ============================================================
  // メーター更新ユーティリティ
  // ============================================================

  /** dB → パーセント（-60dB=0%, 0dB=100%） */
  function dbToPct(db) {
    if (!isFinite(db) || db <= -59.9) return 0;
    return ((Math.max(-60, Math.min(0, db)) + 60) / 60) * 100;
  }

  /** dB → 色クラス（LUFS用） */
  function colorClass(db) {
    if (db > -8) return "red";
    if (db > -14) return "yellow";
    return "green";
  }

  /** dB → 表示文字列。-60以下はtabCaptureの微小ノイズなので無音扱い */
  function fmt(v, unit) {
    if (!isFinite(v) || v <= -59.9) return "\u7121\u97F3";
    return `${v.toFixed(1)} ${unit}`;
  }

  /**
   * メーターバーと数値を更新
   * @param {boolean} fixedColor true: バーの色をCSSクラスで固定（VU/RMS用）
   */
  function updateBar(barEl, valEl, db, unit, fixedColor) {
    barEl.style.width = `${dbToPct(db)}%`;
    if (!fixedColor) {
      barEl.className = `bar ${colorClass(db)}`;
    }
    valEl.textContent = fmt(db, unit);
  }

  // ============================================================
  // YouTube ラウドネス正規化情報の取得
  // ============================================================

  let ytLoudnessRetries = 0;

  /** backgroundにリクエストしてYouTubeプレイヤーからラウドネス情報を取得 */
  function fetchYouTubeLoudness() {
    chrome.runtime.sendMessage({ type: "get-yt-loudness" }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.data && response.data.loudnessDb !== null) {
        ytLoudnessRetries = 0;
        updateYouTubeInfo(response.data.loudnessDb);
      } else if (ytLoudnessRetries < 5) {
        ytLoudnessRetries++;
        setTimeout(fetchYouTubeLoudness, 1000);
      }
    });
  }

  /** YouTube正規化情報をUIに反映 */
  function updateYouTubeInfo(loudnessDb) {
    // loudnessDb: ターゲット(-14 LUFS)からの相対値
    // 正の値 = ターゲットより大きい → YouTubeが音量を下げる
    const estimatedLufs = -14 + loudnessDb;
    ytOriginalVal.textContent = `${estimatedLufs.toFixed(1)} LUFS`;

    // 正規化パーセンテージ: 10^(-loudnessDb/20) × 100
    const normalizedPct = loudnessDb > 0
      ? Math.round(Math.pow(10, -loudnessDb / 20) * 100)
      : 100;

    if (loudnessDb > 0) {
      ytAdjVal.textContent = `\u2212${loudnessDb.toFixed(1)} dB (${normalizedPct}%)`;
      ytAdjVal.style.color = "#facc15";
    } else {
      ytAdjVal.textContent = `None (${normalizedPct}%)`;
      ytAdjVal.style.color = "#22c55e";
    }
  }

  /** YouTube正規化の表示をリセット */
  function resetYouTubeInfo() {
    ytLoudnessRetries = 0;
    ytOriginalVal.textContent = "--";
    ytAdjVal.textContent = "--";
    ytAdjVal.style.color = "#e0e0e0";
  }

  // YouTube SPA遷移時に再取得
  document.addEventListener("yt-navigate-finish", () => {
    resetYouTubeInfo();
    setTimeout(fetchYouTubeLoudness, 500);
  });

  // ============================================================
  // backgroundからのメッセージ受信
  // ============================================================

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "loudness-data") {
      updateBar(mBar, mVal, message.momentaryLUFS, "LUFS", false);
      updateBar(sBar, sVal, message.shortTermLUFS, "LUFS", false);
      updateBar(iBar, iVal, message.integratedLUFS, "LUFS", false);
      updateBar(vBar, vVal, message.vuDB, "VU", true);
      updateBar(rBar, rVal, message.rmsDB, "dBFS", true);
    }

    if (message.type === "capture-started") {
      widget.classList.remove("hidden");
      resetYouTubeInfo();
      fetchYouTubeLoudness();
    }

    if (message.type === "capture-stopped") {
      widget.classList.add("hidden");
    }
  });

  // ============================================================
  // UIコントロール
  // ============================================================

  // ボリュームスライダー
  volSlider.addEventListener("input", () => {
    const value = parseInt(volSlider.value, 10);
    volPct.textContent = value;
    chrome.runtime.sendMessage({ type: "set-volume", volume: value / 100 });
  });

  // 停止ボタン
  widget.querySelector(".close-btn").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "stop-capture" });
    widget.classList.add("hidden");
  });

  // ドラッグ移動（ヘッダー部分をつかんで自由に移動可能）
  const handle = shadow.getElementById("drag-handle");
  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  handle.addEventListener("mousedown", (e) => {
    if (e.target.closest(".header-btn") || e.target.closest(".tip")) return;
    dragging = true;
    const rect = widget.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const x = Math.max(0, Math.min(e.clientX - dragOffsetX, window.innerWidth - widget.offsetWidth));
    const y = Math.max(0, Math.min(e.clientY - dragOffsetY, window.innerHeight - widget.offsetHeight));
    widget.style.left = `${x}px`;
    widget.style.top = `${y}px`;
    widget.style.right = "auto";
  });

  document.addEventListener("mouseup", () => {
    dragging = false;
  });
})();
