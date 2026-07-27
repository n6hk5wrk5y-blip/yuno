// Global State Management
let audioContext = null;
let analyser = null;
let micStream = null;
let dataArray = null;
let animationFrameId = null;

// Timer Interval IDs
let graphUpdateIntervalId = null;
let logUpdateIntervalId = null;
let alarmIntervalId = null;

// Measurement status
let isMeasuring = false;
let isMicInitialized = false;
let currentDbValue = 0.0;
let peakDbValue = 0.0;
let dbSum = 0.0;
let dbCount = 0;

// Danger Warning States
let noisySecondsCounter = 0;
let isDangerTriggered = false;
let isAlarmPlaying = false;

// Recorded Data for CSV
let recordedLogs = [];

// Chart.js Instance
let noiseChart = null;

// Constants
const CALIBRATION_OFFSET = 100; // Offset to match dB SPL
const MAX_CHART_POINTS = 60; // 60 seconds at 1.0s updates

// DOM Elements
const appContainer = document.getElementById('appContainer');
const btnGrantMic = document.getElementById('btnGrantMic');
const micStatusBadge = document.getElementById('micStatusBadge');
const micStatusText = document.getElementById('micStatusText');

const currentDbElement = document.getElementById('currentDb');
const statusEmoji = document.getElementById('statusEmoji');
const statusText = document.getElementById('statusText');
const recordingBadge = document.getElementById('recordingBadge');

const peakDbElement = document.getElementById('peakDb');
const avgDbElement = document.getElementById('avgDb');

// Settings Inputs
const thresholdNormal = document.getElementById('thresholdNormal');
const thresholdSlightly = document.getElementById('thresholdSlightly');
const thresholdNoisy = document.getElementById('thresholdNoisy');

const alertEnabled = document.getElementById('alertEnabled');
const alertVolume = document.getElementById('alertVolume');
const volValText = document.getElementById('volValText');
const volBlocks = document.getElementById('volBlocks');
const dangerDuration = document.getElementById('dangerDuration');
const dangerSecText = document.getElementById('dangerSecText');

// Overlay
const dangerOverlay = document.getElementById('dangerOverlay');
const btnDismissDanger = document.getElementById('btnDismissDanger');

// Logs
const logTable = document.getElementById('logTable');
const logBody = document.getElementById('logBody');
const logCount = document.getElementById('logCount');

// Action Buttons
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnExport = document.getElementById('btnExport');
const btnReset = document.getElementById('btnReset');
const btnFullscreen = document.getElementById('btnFullscreen');

// -------------------------------------------------------------
// 1. Initialization & Event Listeners
// -------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  initChart();
  setupEventListeners();
  updateVolumeIndicator(parseInt(alertVolume.value, 10));
});

function setupEventListeners() {
  btnGrantMic.addEventListener('click', initAudio);
  btnStart.addEventListener('click', startMeasurement);
  btnStop.addEventListener('click', stopMeasurement);
  btnExport.addEventListener('click', exportToCSV);
  btnReset.addEventListener('click', resetLogs);
  btnFullscreen.addEventListener('click', toggleFullscreen);
  btnDismissDanger.addEventListener('click', dismissDangerOverlay);

  // Dynamic Settings Listeners
  alertVolume.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    volValText.textContent = val;
    updateVolumeIndicator(val);
  });

  dangerDuration.addEventListener('input', (e) => {
    dangerSecText.textContent = e.target.value;
  });

  // Watch for Fullscreen changes to update button text/icon
  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
}

// -------------------------------------------------------------
// 2. Audio Input Setup (Web Audio API)
// -------------------------------------------------------------
async function initAudio() {
  try {
    // Request microphone access
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    
    // Initialize AudioContext
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    dataArray = new Float32Array(analyser.fftSize);
    
    // Connect microphone to AnalyserNode
    const source = audioContext.createMediaStreamSource(micStream);
    source.connect(analyser);
    
    isMicInitialized = true;
    
    // Update Header UI
    btnGrantMic.style.display = 'none';
    micStatusBadge.className = 'status-badge connected';
    micStatusText.textContent = 'マイク接続完了';
    
    btnStart.removeAttribute('disabled');
    
    // Start audio sampling loop every 1.0s
    updateRealtimeNoise();
    animationFrameId = setInterval(updateRealtimeNoise, 1000);
    
    // Start continuous graph update timer (even when not recording, we draw the live line)
    startGraphTimer();
    
  } catch (error) {
    console.error('マイクアクセスエラー:', error);
    micStatusBadge.className = 'status-badge error';
    micStatusText.textContent = 'アクセス拒否';
    alert('マイクの使用許可が得られませんでした。ブラウザのアドレスバーにある鍵アイコンから許可を与えてください。');
  }
}

// -------------------------------------------------------------
// 3. Real-time Sampling & Classification
// -------------------------------------------------------------
function updateRealtimeNoise() {
  if (!isMicInitialized) return;
  
  // Get time domain data
  analyser.getFloatTimeDomainData(dataArray);
  
  // Calculate Root Mean Square (RMS)
  let sumSquares = 0.0;
  for (let i = 0; i < dataArray.length; i++) {
    sumSquares += dataArray[i] * dataArray[i];
  }
  let rms = Math.sqrt(sumSquares / dataArray.length);
  
  // Protect against log of 0
  if (rms < 0.00001) rms = 0.00001;
  
  // Calculate dBFS (digital scale decibels)
  let dbFS = 20 * Math.log10(rms);
  
  // Add offset to approximate dB SPL
  let dbSPL = dbFS + CALIBRATION_OFFSET;
  
  // Bound to 0dB - 120dB
  if (dbSPL < 0) dbSPL = 0;
  if (dbSPL > 120) dbSPL = 120;
  
  currentDbValue = dbSPL;
  
  // Update primary screen number
  currentDbElement.textContent = Math.round(dbSPL).toFixed(0);
  
  // Classify level & update body background themes
  const status = classifyNoiseLevel(dbSPL);
  updateThemeClass(status);
  
  // Update location highlights
  updateComparisonHighlight(dbSPL);
  
  // If active measurement session is running, calculate Peak and Average
  if (isMeasuring) {
    if (dbSPL > peakDbValue) {
      peakDbValue = dbSPL;
      peakDbElement.textContent = Math.round(peakDbValue).toFixed(0);
    }
    dbSum += dbSPL;
    dbCount++;
    const avgDb = dbSum / dbCount;
    avgDbElement.textContent = Math.round(avgDb).toFixed(0);
  }
}

// Classify Noise Level based on custom thresholds
function classifyNoiseLevel(db) {
  const normThresh = parseFloat(thresholdNormal.value);
  const slightThresh = parseFloat(thresholdSlightly.value);
  const noisyThresh = parseFloat(thresholdNoisy.value);
  
  if (db < normThresh) {
    return { name: '静か', emoji: '🟦', class: 'quiet' };
  } else if (db < slightThresh) {
    return { name: '普通', emoji: '🟩', class: 'normal' };
  } else if (db < noisyThresh) {
    return { name: '少しうるさい', emoji: '🟨', class: 'slightly' };
  } else {
    return { name: 'うるさい', emoji: '🟥', class: 'noisy' };
  }
}

// Get color hex code based on noise level thresholds for chart
function getColorForDb(db) {
  const normThresh = parseFloat(thresholdNormal.value);
  const slightThresh = parseFloat(thresholdSlightly.value);
  const noisyThresh = parseFloat(thresholdNoisy.value);
  
  if (db < normThresh) {
    return '#3b82f6'; // 静か
  } else if (db < slightThresh) {
    return '#10b981'; // 普通
  } else if (db < noisyThresh) {
    return '#f59e0b'; // 少しうるさい
  } else {
    return '#ef4444'; // うるさい
  }
}

// Update body class for screen dynamic background colors/glows
function updateThemeClass(status) {
  document.body.classList.remove('state-quiet', 'state-normal', 'state-slightly', 'state-noisy');
  document.body.classList.add(`state-${status.class}`);
  
  statusEmoji.textContent = status.emoji;
  statusText.textContent = status.name;
}

// Highlight the equivalent location on the comparison list
function updateComparisonHighlight(db) {
  const items = document.querySelectorAll('.comparison-item');
  items.forEach(item => item.classList.remove('active'));
  
  let activeDb = 30;
  if (db < 35) activeDb = 30;
  else if (db < 45) activeDb = 40;
  else if (db < 55) activeDb = 50;
  else if (db < 65) activeDb = 60;
  else if (db < 75) activeDb = 70;
  else if (db < 85) activeDb = 80;
  else if (db < 95) activeDb = 90;
  else activeDb = 100;
  
  const targetItem = document.querySelector(`.comparison-item[data-db="${activeDb}"]`);
  if (targetItem) {
    targetItem.classList.add('active');
  }
}

// Return human-readable place description for table logs
function getEquivalentPlace(db) {
  if (db < 35) return "図書館";
  if (db < 45) return "住宅街";
  if (db < 55) return "静かなオフィス";
  if (db < 65) return "通常の会話";
  if (db < 75) return "掃除機";
  if (db < 85) return "交通量の多い道路";
  if (db < 95) return "電車のガード下";
  return "ライブ会場前方";
}

// -------------------------------------------------------------
// 4. Measuring Session Controls (Start/Stop)
// -------------------------------------------------------------
function startMeasurement() {
  if (!isMicInitialized || isMeasuring) return;
  
  isMeasuring = true;
  
  // Reset Stats for this run
  peakDbValue = currentDbValue;
  dbSum = currentDbValue;
  dbCount = 1;
  
  peakDbElement.textContent = Math.round(peakDbValue).toFixed(0);
  avgDbElement.textContent = Math.round(currentDbValue).toFixed(0);
  
  // UI Status
  btnStart.disabled = true;
  btnStop.disabled = false;
  recordingBadge.classList.add('active');
  micStatusBadge.className = 'status-badge measuring';
  micStatusText.textContent = '計測・記録中';
  
  // Clear any existing logs from previous run if user wants, 
  // but here we just append to the active logs list.
  
  // Start logging timer (records to history table every 3 seconds)
  logUpdateIntervalId = setInterval(recordLogEntry, 3000);
  
  // Record first log entry immediately
  recordLogEntry();
}

function stopMeasurement() {
  if (!isMeasuring) return;
  
  isMeasuring = false;
  
  // Clear logging interval
  clearInterval(logUpdateIntervalId);
  logUpdateIntervalId = null;
  
  // Reset counters for danger warning
  noisySecondsCounter = 0;
  clearDangerAlarm();
  
  // UI Status
  btnStart.disabled = false;
  btnStop.disabled = true;
  recordingBadge.classList.remove('active');
  micStatusBadge.className = 'status-badge connected';
  micStatusText.textContent = 'マイク接続完了';
}

// -------------------------------------------------------------
// 5. Logging and Trend Graph updates
// -------------------------------------------------------------
function recordLogEntry() {
  const now = new Date();
  const dbVal = Math.round(currentDbValue);
  const timeLabel = formatTimeOnly(now);
  const status = classifyNoiseLevel(dbVal);
  const place = getEquivalentPlace(dbVal);
  
  // Add to internal memory
  const logItem = {
    time: timeLabel,
    db: dbVal,
    status: status.name,
    class: status.class,
    place: place
  };
  recordedLogs.push(logItem);
  
  // Append row to HTML table at the top
  const tr = document.createElement('tr');
  tr.className = `log-row-${status.class}`;
  tr.innerHTML = `
    <td>${logItem.time}</td>
    <td><span class="log-db-val">${logItem.db}</span> dB</td>
    <td><span class="badge-state ${status.class}">${status.emoji} ${status.name}</span></td>
    <td>${logItem.place}</td>
  `;
  
  const emptyRow = logBody.querySelector('.empty-row');
  if (emptyRow) {
    logBody.removeChild(emptyRow);
  }
  
  logBody.insertBefore(tr, logBody.firstChild);
  logCount.textContent = `合計: ${recordedLogs.length}件`;
}

function startGraphTimer() {
  graphUpdateIntervalId = setInterval(() => {
    const now = new Date();
    const timeLabel = formatTimeOnly(now);
    const dbVal = Math.round(currentDbValue);
    
    // Add point to Chart.js
    addChartData(timeLabel, dbVal);
    
    // Monitor Danger Alert conditions (runs every 1s)
    checkDangerCondition();
  }, 1000);
}

// -------------------------------------------------------------
// 6. Danger Alarm System (Screen flashing & synth tone)
// -------------------------------------------------------------
function checkDangerCondition() {
  const noisyThreshVal = parseFloat(thresholdNoisy.value);
  const dangerSecLimit = parseFloat(dangerDuration.value);
  
  // Check if we are measuring AND alert is enabled AND current dB exceeds Noisy threshold
  if (isMeasuring && alertEnabled.checked && currentDbValue >= noisyThreshVal) {
    noisySecondsCounter += 1.0;
    if (noisySecondsCounter >= dangerSecLimit && !isDangerTriggered) {
      triggerDangerAlarm();
    }
  } else if (currentDbValue < noisyThreshVal) {
    // If volume falls below threshold, automatically restore normal state
    noisySecondsCounter = 0;
    if (isDangerTriggered) {
      clearDangerAlarm();
    }
  }
}

function triggerDangerAlarm() {
  isDangerTriggered = true;
  dangerOverlay.style.display = 'flex';
  
  // Start playing alarm synth tone
  startAlarmTone();
}

function clearDangerAlarm() {
  isDangerTriggered = false;
  dangerOverlay.style.display = 'none';
  stopAlarmTone();
}

function dismissDangerOverlay() {
  // Silence alarm but keep warning tracking active (it will re-trigger if conditions met later)
  clearDangerAlarm();
  noisySecondsCounter = 0;
}

function startAlarmTone() {
  if (isAlarmPlaying || !alertEnabled.checked) return;
  isAlarmPlaying = true;
  
  // Pulsing beep loop
  playBeepPulse();
  alarmIntervalId = setInterval(playBeepPulse, 800);
}

function stopAlarmTone() {
  if (isAlarmPlaying) {
    clearInterval(alarmIntervalId);
    alarmIntervalId = null;
    isAlarmPlaying = false;
  }
}

function playBeepPulse() {
  if (!audioContext || !alertEnabled.checked) return;
  
  try {
    const osc = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    osc.type = 'sine';
    // Clear dual tone warning
    osc.frequency.setValueAtTime(880, audioContext.currentTime); // 880Hz (A5)
    
    const volSetting = parseInt(alertVolume.value, 10);
    const volumeRatio = volSetting / 7;
    const finalVolume = volumeRatio * 0.12; // Max gain capped at 0.12 for safety/feedback prevention
    
    gainNode.gain.setValueAtTime(0, audioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(finalVolume, audioContext.currentTime + 0.05);
    gainNode.gain.exponentialRampToValueAtTime(0.00001, audioContext.currentTime + 0.35);
    
    osc.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    osc.start();
    osc.stop(audioContext.currentTime + 0.4);
  } catch (e) {
    console.error("シンセビープ音の出力エラー:", e);
  }
}

// -------------------------------------------------------------
// 7. Interactive Settings & Volume Indicator Blocks
// -------------------------------------------------------------
function updateVolumeIndicator(vol) {
  const blocks = volBlocks.querySelectorAll('.vol-block');
  blocks.forEach((block, idx) => {
    if (idx < vol) {
      block.classList.add('active');
    } else {
      block.classList.remove('active');
    }
  });
}

// -------------------------------------------------------------
// 8. Chart.js Configuration
// -------------------------------------------------------------
function initChart() {
  const ctx = document.getElementById('noiseChart').getContext('2d');

  noiseChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: '騒音 (dB)',
        data: [],
        borderWidth: 2.5,
        fill: false,
        tension: 0.3, // Curve smoothing
        segment: {
          borderColor: ctx => {
            if (ctx.p0 && ctx.p1) {
              const val = ctx.p1.parsed.y;
              return getColorForDb(val);
            }
            return '#3b82f6';
          }
        },
        pointBackgroundColor: ctx => {
          if (ctx.parsed) {
            return getColorForDb(ctx.parsed.y);
          }
          return '#3b82f6';
        },
        pointBorderColor: '#0b0f19',
        pointBorderWidth: 1.5,
        pointRadius: 0, // Keep clean, show points only on hover
        pointHoverRadius: 5,
        pointHoverBackgroundColor: '#ffffff',
        pointHoverBorderColor: ctx => {
          if (ctx.parsed) {
            return getColorForDb(ctx.parsed.y);
          }
          return '#3b82f6';
        },
        pointHoverBorderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(11, 15, 25, 0.9)',
          titleFont: { family: 'Outfit', size: 12 },
          bodyFont: { family: 'Outfit', size: 13, weight: 'bold' },
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 10,
          displayColors: false,
          callbacks: {
            label: function(context) {
              return `${context.parsed.y} dB`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: 'rgba(255, 255, 255, 0.03)',
            borderColor: 'rgba(255, 255, 255, 0.06)'
          },
          ticks: {
            color: '#64748b',
            font: { family: 'Outfit', size: 9 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8
          }
        },
        y: {
          min: 30,
          max: 100,
          grid: {
            color: 'rgba(255, 255, 255, 0.03)',
            borderColor: 'rgba(255, 255, 255, 0.06)'
          },
          ticks: {
            color: '#64748b',
            font: { family: 'Outfit', size: 10 },
            stepSize: 10,
            callback: function(value) {
              return value + ' dB';
            }
          }
        }
      },
      interaction: {
        intersect: false,
        mode: 'index'
      }
    }
  });
}

function addChartData(label, value) {
  if (!noiseChart) return;
  
  noiseChart.data.labels.push(label);
  noiseChart.data.datasets[0].data.push(value);
  
  // Roll chart left if exceeding buffer size
  if (noiseChart.data.labels.length > MAX_CHART_POINTS) {
    noiseChart.data.labels.shift();
    noiseChart.data.datasets[0].data.shift();
  }
  
  // Dynamic scale adjustment based on data min/max values
  const dataset = noiseChart.data.datasets[0].data;
  const maxVal = Math.max(...dataset);
  const minVal = Math.min(...dataset);
  
  noiseChart.options.scales.y.max = Math.max(90, Math.ceil((maxVal + 10) / 10) * 10);
  noiseChart.options.scales.y.min = Math.min(30, Math.floor((minVal - 10) / 10) * 10);
  
  noiseChart.update('none'); // Quick update without standard full animation to save CPU
}

// -------------------------------------------------------------
// 9. Logs Actions & CSV Exporting
// -------------------------------------------------------------
function resetLogs() {
  if (recordedLogs.length === 0) return;
  
  if (confirm('記録されているログをクリアしますか？')) {
    recordedLogs = [];
    
    // Clear HTML Table
    logBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="4">計測中のデータはありません。「計測開始」を押してください。</td>
      </tr>
    `;
    logCount.textContent = '合計: 0件';
    
    // Reset Stats
    peakDbValue = currentDbValue;
    dbSum = currentDbValue;
    dbCount = 1;
    peakDbElement.textContent = Math.round(peakDbValue).toFixed(0);
    avgDbElement.textContent = Math.round(currentDbValue).toFixed(0);
  }
}

function exportToCSV() {
  if (recordedLogs.length === 0) {
    alert('出力するデータがありません。計測を開始してログを記録してください。');
    return;
  }
  
  // Build CSV string contents
  let csvContent = "時刻,騒音レベル (dB),状態評価,目安の場所\r\n";
  recordedLogs.forEach(item => {
    csvContent += `"${item.time}","${item.db}","${item.status}","${item.place}"\r\n`;
  });
  
  // Generate filename timestamp
  const now = new Date();
  const timestamp = formatDateForFilename(now);
  const filename = `騒音計測ログ_${timestamp}.csv`;
  
  // Download Blob using standard link click trigger (adds UTF-8 BOM)
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// -------------------------------------------------------------
// 10. Fullscreen API Integration
// -------------------------------------------------------------
function toggleFullscreen() {
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    // Enter Fullscreen
    if (appContainer.requestFullscreen) {
      appContainer.requestFullscreen();
    } else if (appContainer.webkitRequestFullscreen) {
      appContainer.webkitRequestFullscreen();
    }
  } else {
    // Exit Fullscreen
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
}

function handleFullscreenChange() {
  const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  if (isFullscreen) {
    btnFullscreen.innerHTML = '<i class="fa-solid fa-compress"></i> 画面縮小';
  } else {
    btnFullscreen.innerHTML = '<i class="fa-solid fa-expand"></i> 全画面';
  }
}

// -------------------------------------------------------------
// 11. Time Utilities
// -------------------------------------------------------------
function formatTimeOnly(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${min}:${s}`;
}

function formatDateForFilename(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}_${h}${min}${s}`;
}
