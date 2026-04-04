const video = document.getElementById("webcam");
const overlay = document.getElementById("overlay");
const overlayCtx = overlay.getContext("2d");

const gameCanvas = document.getElementById("gameCanvas");
const gameCtx = gameCanvas.getContext("2d");

const startBtn = document.getElementById("startBtn");
const resetBtn = document.getElementById("resetBtn");
const cameraSelect = document.getElementById("cameraSelect");
const statusText = document.getElementById("status");
const gamePanel = document.getElementById("gamePanel");

const pelhamBg = new Image();
pelhamBg.src = "pelham-catcher-bg.png";
let pelhamBgLoaded = false;
pelhamBg.onload = () => {
  pelhamBgLoaded = true;
};

let detector = null;
let started = false;
let selectedCameraId = "";

let latestKeypoints = null;
let isEstimating = false;

let wristScreen = null;
let shoulderScreen = null;

let loadBox = null;
let readyBox = null;
let target = null;
let followGuide = null;

let wristHistory = [];
let readyFrames = 0;
let readyLockout = false;
let throwCooldown = false;

let phase = "LOAD"; // LOAD / READY / FOLLOW / RESET / DONE
let pitchCount = 0;
const MAX_PITCHES = 6;

let feedbackText = "READY";
let feedbackTimer = 0;
let currentPower = 0;

let rings = [];
let sparks = [];
let confetti = [];
let flashes = [];

let bgFade = 0;
let bgFadeTarget = 0;

const FORWARD_DIRECTION = 1; // set to -1 if throw direction feels backwards
const HOLD_FRAMES_REQUIRED = 5;
const RELEASE_THRESHOLD = 34;

const COLORS = {
  blue: "#6cc7ff",
  green: "#8ed857",
  yellow: "#f1c94c",
  orange: "#f29a45",
  pink: "#d87adf",
  aqua: "#7ef7ff",
  red: "#ff6b6b",
  white: "#ffffff",
  navy: "#07121f",
  dark: "#07131f"
};

// target center inside the Pelham image
// tweak only if needed
const MITT_U = 0.765; // x % across image
const MITT_V = 0.405; // y % down image

function setStatus(text) {
  if (statusText) statusText.textContent = text;
}

/* =========================
   AUDIO
========================= */
let audioCtx = null;

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

function playTone(freq = 440, duration = 0.08, type = "sine", volume = 0.04, slideTo = null) {
  ensureAudio();

  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (slideTo !== null) {
    osc.frequency.linearRampToValueAtTime(slideTo, now + duration);
  }

  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start(now);
  osc.stop(now + duration);
}

function playNoise(duration = 0.05, volume = 0.02, highpass = 1200) {
  ensureAudio();

  const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * duration, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const source = audioCtx.createBufferSource();
  const filter = audioCtx.createBiquadFilter();
  const gain = audioCtx.createGain();

  source.buffer = buffer;
  filter.type = "highpass";
  filter.frequency.value = highpass;

  gain.gain.setValueAtTime(volume, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(audioCtx.destination);

  source.start();
  source.stop(audioCtx.currentTime + duration);
}

function playLoad() {
  playTone(520, 0.08, "triangle", 0.04);
}

function playThrow() {
  playTone(260, 0.08, "sawtooth", 0.05, 520);
  setTimeout(() => playNoise(0.05, 0.018, 1400), 20);
}

function playHit() {
  playTone(920, 0.05, "square", 0.05);
  setTimeout(() => playTone(1220, 0.08, "square", 0.045), 40);
}

function playNear() {
  playTone(720, 0.05, "triangle", 0.04);
  setTimeout(() => playTone(870, 0.07, "triangle", 0.032), 35);
}

function playMiss() {
  playTone(210, 0.08, "sawtooth", 0.03, 140);
}

function playSuccess() {
  playTone(620, 0.08, "triangle", 0.045);
  setTimeout(() => playTone(860, 0.08, "triangle", 0.04), 50);
  setTimeout(() => playTone(1120, 0.12, "triangle", 0.04), 100);
}

function playReset() {
  playTone(500, 0.05, "triangle", 0.03);
}

/* =========================
   CAMERA PICKER
========================= */
async function populateCameraSelect() {
  if (!cameraSelect) return;

  try {
    const tempStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });

    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput");

    cameraSelect.innerHTML = "";

    if (!cams.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No cameras found";
      cameraSelect.appendChild(option);
    } else {
      cams.forEach((cam, i) => {
        const option = document.createElement("option");
        option.value = cam.deviceId;
        option.textContent = cam.label || `Camera ${i + 1}`;
        cameraSelect.appendChild(option);
      });

      const preferred =
        cams.find((d) => /obs virtual camera/i.test(d.label)) ||
        cams.find((d) => /azure|kinect/i.test(d.label)) ||
        cams[0];

      selectedCameraId = preferred.deviceId;
      cameraSelect.value = selectedCameraId;
    }

    cameraSelect.onchange = () => {
      selectedCameraId = cameraSelect.value;
    };

    tempStream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    console.error("populateCameraSelect error:", err);
    setStatus("Allow camera access, then refresh.");
  }
}

/* =========================
   START CAMERA
========================= */
async function startCamera() {
  ensureAudio();
  setStatus("Starting camera...");

  if (video.srcObject) {
    video.srcObject.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: selectedCameraId ? { exact: selectedCameraId } : undefined,
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 }
    },
    audio: false
  });

  video.srcObject = stream;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Camera timeout")), 12000);

    video.onloadedmetadata = () => {
      clearTimeout(timeout);
      resolve();
    };

    video.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("Video failed to load"));
    };
  });

  await video.play();

  overlay.width = video.videoWidth || 640;
  overlay.height = video.videoHeight || 480;

  if (!detector) {
    await tf.setBackend("webgl");
    await tf.ready();

    detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      {
        modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING
      }
    );
  }

  if (gamePanel) {
    gamePanel.classList.add("game-active");
  }

  bgFadeTarget = 1;
  setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Put your throwing hand in the blue box.`);

  if (!started) {
    started = true;
    requestAnimationFrame(loop);
  }
}

/* =========================
   RESET
========================= */
function resetGame() {
  phase = "LOAD";
  pitchCount = 0;
  readyFrames = 0;
  readyLockout = false;
  throwCooldown = false;
  feedbackText = "READY";
  feedbackTimer = 0;
  currentPower = 0;
  wristHistory = [];
  rings = [];
  sparks = [];
  confetti = [];
  flashes = [];

  playReset();
  setStatus(`Pitch 1/${MAX_PITCHES} · Put your throwing hand in the blue box.`);
}

/* =========================
   BUTTONS
========================= */
startBtn.onclick = async () => {
  try {
    await startCamera();
  } catch (err) {
    console.error("Camera start error:", err);
    setStatus("Camera failed: " + err.message);
    alert("Camera failed: " + err.message);
  }
};

resetBtn.onclick = () => {
  resetGame();
};

/* =========================
   MAIN LOOP
========================= */
function loop() {
  requestAnimationFrame(loop);

  if (detector && video.readyState >= 2 && !isEstimating) {
    estimatePoseFrame();
  }

  processPose();
  updateFX();
  drawGame();
  drawOverlay();
}

async function estimatePoseFrame() {
  if (!detector) return;

  try {
    isEstimating = true;
    const poses = await detector.estimatePoses(video);

    if (poses?.length && poses[0].keypoints) {
      latestKeypoints = poses[0].keypoints;
    } else {
      latestKeypoints = null;
    }
  } catch (err) {
    console.error("Pose estimate error:", err);
    latestKeypoints = null;
  } finally {
    isEstimating = false;
  }
}

function processPose() {
  if (!latestKeypoints) {
    if (started) {
      setStatus("No body detected. Step back so your upper body is visible.");
    }
    return;
  }

  const rightWrist = findKeypoint(latestKeypoints, "right_wrist");
  const rightShoulder = findKeypoint(latestKeypoints, "right_shoulder");
  const rightHip = findKeypoint(latestKeypoints, "right_hip");
  const leftShoulder = findKeypoint(latestKeypoints, "left_shoulder");

  if (
    !rightWrist || !rightShoulder || !rightHip || !leftShoulder ||
    rightWrist.score < 0.2 ||
    rightShoulder.score < 0.2 ||
    rightHip.score < 0.2 ||
    leftShoulder.score < 0.2
  ) {
    setStatus("Upper body not clear. Face camera and step back.");
    return;
  }

  wristScreen = { x: rightWrist.x, y: rightWrist.y };
  shoulderScreen = { x: rightShoulder.x, y: rightShoulder.y };

  const torsoHeight = Math.abs(rightHip.y - rightShoulder.y);
  const shoulderSpan = Math.abs(rightShoulder.x - leftShoulder.x);

  // Easier, bigger, closer to body
  const boxW = Math.max(shoulderSpan * 1.45, 190);
  const boxH = Math.max(torsoHeight * 1.20, 220);

  loadBox = {
    x: shoulderScreen.x - boxW - 8,
    y: shoulderScreen.y - boxH * 0.05,
    w: boxW,
    h: boxH
  };

  readyBox = {
    x: loadBox.x + 6,
    y: loadBox.y + 6,
    w: loadBox.w - 12,
    h: loadBox.h - 12
  };

  const bgRect = getCoverRect(
    pelhamBgLoaded ? pelhamBg.width : 1365,
    pelhamBgLoaded ? pelhamBg.height : 768,
    gameCanvas.width,
    gameCanvas.height
  );

  target = {
    x: bgRect.x + bgRect.w * MITT_U,
    y: bgRect.y + bgRect.h * MITT_V,
    outerR: 120,
    middleR: 80,
    innerR: 42
  };

  followGuide = {
    x1: target.x - 10,
    y1: target.y + 10,
    x2: target.x + 90,
    y2: target.y + 92
  };

  if (phase === "DONE" || throwCooldown) return;

  const inLoad = pointInRect(wristScreen.x, wristScreen.y, loadBox);
  const inReady = pointInRect(wristScreen.x, wristScreen.y, readyBox);

  if (phase === "LOAD" && readyLockout) {
    if (!inLoad) {
      readyLockout = false;
      readyFrames = 0;
      setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Re-enter the blue box.`);
    } else {
      setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Move arm out, then reload.`);
    }
    return;
  }

  wristHistory.push({
    x: wristScreen.x,
    y: wristScreen.y,
    t: performance.now()
  });
  if (wristHistory.length > 18) wristHistory.shift();

  if (phase === "LOAD") {
    if (inReady) {
      readyFrames++;
      if (readyFrames >= HOLD_FRAMES_REQUIRED) {
        phase = "READY";
        feedbackText = "ARM READY";
        feedbackTimer = 999999;
        playLoad();
        wristHistory = [];
        setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Throw to Pelham!`);
      } else {
        setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Hold in the green zone...`);
      }
    } else {
      readyFrames = 0;
      setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Put your throwing hand in the blue box.`);
    }
    return;
  }

  if (phase === "READY") {
    if (wristHistory.length >= 4) {
      const first = wristHistory[0];
      const last = wristHistory[wristHistory.length - 1];

      const rawForwardX = (last.x - first.x) * FORWARD_DIRECTION;
      const upwardY = first.y - last.y;

      const forwardX = Math.max(0, rawForwardX);
      const power = forwardX + Math.max(0, upwardY) * 0.30;
      currentPower = Math.min(400, power * 3.0);

      if (forwardX > RELEASE_THRESHOLD) {
        triggerThrow(power);
      } else {
        setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Throw to Pelham.`);
      }
    }
    return;
  }
}

/* =========================
   THROW LOGIC
========================= */
function triggerThrow(power) {
  if (!wristScreen || !target) return;

  const dist = Math.hypot(wristScreen.x - target.x, wristScreen.y - target.y);
  const centerFactor = clamp(1 - dist / target.outerR, 0, 1);
  const throwFactor = clamp(power / 220, 0, 1);

  playThrow();

  // always reward the throw
  spawnBurst(
    wristScreen.x,
    wristScreen.y,
    COLORS.orange,
    120 + power * 0.6
  );

  if (dist <= target.innerR) {
    feedbackText = "BULLSEYE!";
    playHit();

    const impactPower = 220 + centerFactor * 180 + throwFactor * 80;
    spawnBigImpact(COLORS.yellow, impactPower);
    flashGamePanel();
  } else if (dist <= target.middleR) {
    feedbackText = "TARGET HIT";
    playHit();

    const impactPower = 170 + centerFactor * 140 + throwFactor * 70;
    spawnBigImpact(COLORS.green, impactPower);
    flashGamePanel();
  } else if (dist <= target.outerR) {
    feedbackText = "NICE TRY";
    playNear();

    const impactPower = 110 + centerFactor * 90 + throwFactor * 50;
    spawnBigImpact(COLORS.orange, impactPower);
  } else {
    feedbackText = "BIG THROW!";
    playMiss();

    const missPower = 90 + throwFactor * 60;
    spawnBigImpact(COLORS.pink, missPower);
  }

  feedbackTimer = 75;
  phase = "FOLLOW";
  throwCooldown = true;
  pitchCount++;

  setStatus(`Pitch ${pitchCount}/${MAX_PITCHES} complete...`);

  const finalPitch = pitchCount >= MAX_PITCHES;

  setTimeout(() => {
    playSuccess();

    if (finalPitch) {
      phase = "DONE";
      feedbackText = "ROUND COMPLETE";
      feedbackTimer = 170;
      setStatus("Nice work! Press Reset Game to play again.");
      setTimeout(() => {
        throwCooldown = false;
      }, 2200);
      return;
    }

    phase = "RESET";
    readyLockout = true;
    readyFrames = 0;
    wristHistory = [];
    feedbackText = "READY";
    feedbackTimer = 0;
    currentPower = 0;

    setStatus(`Reset for pitch ${pitchCount + 1}/${MAX_PITCHES}...`);

    setTimeout(() => {
      phase = "LOAD";
      throwCooldown = false;
      setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Move arm out, then reload.`);
    }, 1250);
  }, 700);
}

/* =========================
   GAME PANEL FLASH
========================= */
function flashGamePanel() {
  if (!gamePanel) return;
  gamePanel.classList.add("impactFlash");
  setTimeout(() => {
    gamePanel.classList.remove("impactFlash");
  }, 280);
}

/* =========================
   FX UPDATE
========================= */
function updateFX() {
  bgFade += (bgFadeTarget - bgFade) * 0.06;

  for (let i = rings.length - 1; i >= 0; i--) {
    rings[i].r += rings[i].grow;
    rings[i].alpha *= 0.92;
    if (rings[i].alpha < 0.04) rings.splice(i, 1);
  }

  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.x += s.vx;
    s.y += s.vy;
    s.size *= 0.96;
    s.alpha *= 0.94;
    if (s.size < 0.8 || s.alpha < 0.05) sparks.splice(i, 1);
  }

  for (let i = confetti.length - 1; i >= 0; i--) {
    const c = confetti[i];
    c.x += c.vx;
    c.y += c.vy;
    c.vy += 0.08;
    c.rot += c.spin;
    c.alpha *= 0.985;
    if (c.alpha < 0.05 || c.y > gameCanvas.height + 40) confetti.splice(i, 1);
  }

  for (let i = flashes.length - 1; i >= 0; i--) {
    flashes[i].alpha *= 0.9;
    if (flashes[i].alpha < 0.04) flashes.splice(i, 1);
  }

  if (feedbackTimer > 0 && feedbackTimer < 999999) feedbackTimer--;
}

/* =========================
   FX SPAWN
========================= */
function spawnBurst(x, y, color, power = 80) {
  const ringCount = 4 + Math.floor(power / 28);

  for (let i = 0; i < ringCount; i++) {
    rings.push({
      x,
      y,
      r: 18 + i * 24,
      grow: 6 + i * 1.25,
      alpha: 0.98 - i * 0.08,
      color: i % 2 === 0 ? color : COLORS.aqua
    });
  }

  for (let i = 0; i < 28; i++) {
    sparks.push({
      x,
      y,
      vx: Math.random() * 16 - 8,
      vy: Math.random() * 16 - 8,
      size: 7 + Math.random() * 12,
      alpha: 0.98,
      color: [color, COLORS.yellow, COLORS.pink, COLORS.aqua][Math.floor(Math.random() * 4)]
    });
  }

  flashes.push({ color, alpha: 0.18 });
}

function spawnBigImpact(color, power = 160) {
  if (!target) return;

  const x = target.x;
  const y = target.y;

  const ringCount =
    power > 300 ? 20 :
    power > 220 ? 16 :
    power > 160 ? 12 : 8;

  const ringScale =
    power > 300 ? 2.8 :
    power > 220 ? 2.2 :
    power > 160 ? 1.75 : 1.15;

  for (let i = 0; i < ringCount; i++) {
    rings.push({
      x,
      y,
      r: (20 + i * 26) * ringScale,
      grow: (6 + i * 1.0) * ringScale,
      alpha: 0.94 - i * 0.045,
      color: i % 3 === 0 ? COLORS.yellow : i % 3 === 1 ? color : COLORS.aqua
    });
  }

  for (let i = 0; i < ringCount * 10; i++) {
    confetti.push({
      x,
      y,
      vx: Math.random() * 24 - 12,
      vy: Math.random() * -18 - 2,
      w: 8 + Math.random() * 18,
      h: 5 + Math.random() * 12,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.7,
      alpha: 1,
      color: [COLORS.blue, COLORS.orange, COLORS.yellow, COLORS.green, COLORS.pink, COLORS.aqua][Math.floor(Math.random() * 6)]
    });
  }

  for (let i = 0; i < 28; i++) {
    sparks.push({
      x,
      y,
      vx: Math.random() * 18 - 9,
      vy: Math.random() * 18 - 9,
      size: 8 + Math.random() * 15,
      alpha: 0.98,
      color: [COLORS.yellow, COLORS.aqua, COLORS.orange, COLORS.pink][Math.floor(Math.random() * 4)]
    });
  }

  flashes.push({ color, alpha: 0.34 });
}

/* =========================
   DRAW GAME
========================= */
function drawGame() {
  gameCtx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);

  drawBackground();
  drawTargetPulse();
  drawHUD();
  drawTopFade();
  drawRings();
  drawSparks();
  drawConfetti();
  drawFlashes();
}

function drawBackground() {
  if (pelhamBgLoaded) {
    const r = getCoverRect(pelhamBg.width, pelhamBg.height, gameCanvas.width, gameCanvas.height);
    gameCtx.drawImage(pelhamBg, r.x, r.y, r.w, r.h);
  } else {
    const bg = gameCtx.createLinearGradient(0, 0, 0, gameCanvas.height);
    bg.addColorStop(0, "#173149");
    bg.addColorStop(0.35, "#1e3b55");
    bg.addColorStop(1, "#234e2b");
    gameCtx.fillStyle = bg;
    gameCtx.fillRect(0, 0, gameCanvas.width, gameCanvas.height);
  }

  // gradual darker fade when game comes on
  const darkAlpha = 0.10 + bgFade * 0.30;
  gameCtx.fillStyle = `rgba(5, 12, 22, ${darkAlpha})`;
  gameCtx.fillRect(0, 0, gameCanvas.width, gameCanvas.height);
}

function drawTargetPulse() {
  if (!target || phase === "DONE") return;

  const pulse = 1 + Math.sin(performance.now() * 0.006) * 0.06;

  const g = gameCtx.createRadialGradient(
    target.x,
    target.y,
    10,
    target.x,
    target.y,
    target.outerR * 0.95 * pulse
  );

  g.addColorStop(0, "rgba(255,220,120,0.18)");
  g.addColorStop(0.45, "rgba(255,220,120,0.08)");
  g.addColorStop(1, "rgba(255,220,120,0)");

  gameCtx.fillStyle = g;
  gameCtx.beginPath();
  gameCtx.arc(target.x, target.y, target.outerR * 0.95 * pulse, 0, Math.PI * 2);
  gameCtx.fill();
}

function drawHUD() {
  gameCtx.fillStyle = "rgba(6,16,28,0.76)";
  roundRectFill(30, 24, 320, 44, 18);
  roundRectFill(1040, 24, 250, 104, 20);
  roundRectFill(420, 22, 520, 90, 24);

  roundRectColor(
    34,
    30,
    Math.min(currentPower, 300),
    30,
    14,
    currentPower > 180 ? COLORS.orange : COLORS.blue
  );

  gameCtx.fillStyle = COLORS.white;
  gameCtx.font = "bold 15px Arial";
  gameCtx.fillText("THROW POWER", 38, 20);

  gameCtx.font = "bold 26px Arial";
  const pitchDisplay = phase === "DONE" ? MAX_PITCHES : Math.min(pitchCount + 1, MAX_PITCHES);
  gameCtx.fillText(`Pitch: ${pitchDisplay}/${MAX_PITCHES}`, 1064, 58);
  gameCtx.fillText(`Completed: ${pitchCount}`, 1064, 88);

  gameCtx.textAlign = "center";
  gameCtx.font = "bold 24px Arial";
  gameCtx.fillText("PITCH TO PELHAM", gameCanvas.width / 2, 54);

  gameCtx.font = "bold 38px Arial";
  gameCtx.fillStyle =
    phase === "LOAD" ? COLORS.blue :
    phase === "READY" ? COLORS.green :
    phase === "FOLLOW" ? COLORS.orange :
    phase === "DONE" ? COLORS.yellow :
    COLORS.white;

  gameCtx.fillText(phase, gameCanvas.width / 2, 90);

  if (feedbackTimer > 0) {
    roundRectFill(500, 126, 395, 58, 18);
    gameCtx.fillStyle = COLORS.white;
    gameCtx.font = "bold 30px Arial";
    gameCtx.fillText(feedbackText, gameCanvas.width / 2, 164);
  }

  gameCtx.textAlign = "start";
}

function drawTopFade() {
  const topFade = gameCtx.createLinearGradient(0, 0, 0, 160);
  topFade.addColorStop(0, "rgba(0,0,0,0.62)");
  topFade.addColorStop(1, "rgba(0,0,0,0)");
  gameCtx.fillStyle = topFade;
  gameCtx.fillRect(0, 0, gameCanvas.width, 160);
}

function drawRings() {
  rings.forEach((r) => {
    gameCtx.strokeStyle = rgbaFromHex(r.color, r.alpha);
    gameCtx.lineWidth = 5 + r.grow * 0.08;
    gameCtx.beginPath();
    gameCtx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    gameCtx.stroke();
  });
}

function drawSparks() {
  sparks.forEach((s) => {
    gameCtx.fillStyle = rgbaFromHex(s.color, s.alpha);
    gameCtx.beginPath();
    gameCtx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
    gameCtx.fill();
  });
}

function drawConfetti() {
  confetti.forEach((c) => {
    gameCtx.save();
    gameCtx.globalAlpha = c.alpha;
    gameCtx.translate(c.x, c.y);
    gameCtx.rotate(c.rot);
    gameCtx.fillStyle = c.color;
    gameCtx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
    gameCtx.restore();
  });
}

function drawFlashes() {
  flashes.forEach((f) => {
    gameCtx.fillStyle = rgbaFromHex(f.color, f.alpha * 0.20);
    gameCtx.fillRect(0, 0, gameCanvas.width, gameCanvas.height);
  });
}

/* =========================
   OVERLAY
========================= */
function drawOverlay() {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  if (!latestKeypoints) {
    drawFallbackOverlay();
    return;
  }

  if (loadBox) {
    overlayCtx.fillStyle = "rgba(0,140,255,0.16)";
    overlayCtx.strokeStyle = "rgba(0,220,255,0.95)";
    overlayCtx.lineWidth = 4;
    overlayCtx.fillRect(loadBox.x, loadBox.y, loadBox.w, loadBox.h);
    overlayCtx.strokeRect(loadBox.x, loadBox.y, loadBox.w, loadBox.h);
  }

  if (readyBox) {
    overlayCtx.fillStyle = phase === "LOAD" ? "rgba(80,255,140,0.14)" : "rgba(242,154,69,0.16)";
    overlayCtx.strokeStyle = phase === "LOAD" ? "rgba(80,255,140,0.9)" : "rgba(242,154,69,0.95)";
    overlayCtx.lineWidth = phase === "LOAD" ? 5 : 4;
    overlayCtx.fillRect(readyBox.x, readyBox.y, readyBox.w, readyBox.h);
    overlayCtx.strokeRect(readyBox.x, readyBox.y, readyBox.w, readyBox.h);
  }

  if (followGuide && phase === "FOLLOW") {
    overlayCtx.strokeStyle = "rgba(242,154,69,0.88)";
    overlayCtx.lineWidth = 5;
    overlayCtx.beginPath();
    overlayCtx.moveTo(followGuide.x1, followGuide.y1);
    overlayCtx.lineTo(followGuide.x2, followGuide.y2);
    overlayCtx.stroke();
  }

  overlayCtx.strokeStyle =
    phase === "READY" ? "rgba(80,255,140,0.98)" :
    phase === "FOLLOW" ? "rgba(242,154,69,0.98)" :
    "rgba(111,214,255,0.98)";

  overlayCtx.lineWidth = 6;
  overlayCtx.lineCap = "round";

  drawBone(latestKeypoints, "left_shoulder", "right_shoulder");
  drawBone(latestKeypoints, "left_shoulder", "left_elbow");
  drawBone(latestKeypoints, "left_elbow", "left_wrist");
  drawBone(latestKeypoints, "right_shoulder", "right_elbow");
  drawBone(latestKeypoints, "right_elbow", "right_wrist");
  drawBone(latestKeypoints, "left_shoulder", "left_hip");
  drawBone(latestKeypoints, "right_shoulder", "right_hip");
  drawBone(latestKeypoints, "left_hip", "right_hip");

  latestKeypoints.forEach((k) => {
    if (k.score > 0.25) {
      overlayCtx.fillStyle = "rgba(255,230,120,0.95)";
      overlayCtx.beginPath();
      overlayCtx.arc(k.x, k.y, 6, 0, Math.PI * 2);
      overlayCtx.fill();
    }
  });

  if (wristScreen) {
    overlayCtx.fillStyle =
      phase === "READY" ? "rgba(80,255,140,1)" :
      phase === "FOLLOW" ? "rgba(242,154,69,1)" :
      "rgba(255,255,255,1)";

    overlayCtx.beginPath();
    overlayCtx.arc(wristScreen.x, wristScreen.y, 12, 0, Math.PI * 2);
    overlayCtx.fill();
  }
}

function drawFallbackOverlay() {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  overlayCtx.fillStyle = "rgba(0,140,255,0.22)";
  overlayCtx.strokeStyle = "rgba(0,220,255,1)";
  overlayCtx.lineWidth = 5;
  overlayCtx.fillRect(40, 80, 120, 140);
  overlayCtx.strokeRect(40, 80, 120, 140);
}

/* =========================
   HELPERS
========================= */
function getCoverRect(imgW, imgH, canvasW, canvasH) {
  const scale = Math.max(canvasW / imgW, canvasH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  const x = (canvasW - w) / 2;
  const y = (canvasH - h) / 2;
  return { x, y, w, h };
}

function roundRectFill(x, y, w, h, r) {
  gameCtx.beginPath();
  gameCtx.moveTo(x + r, y);
  gameCtx.lineTo(x + w - r, y);
  gameCtx.quadraticCurveTo(x + w, y, x + w, y + r);
  gameCtx.lineTo(x + w, y + h - r);
  gameCtx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  gameCtx.lineTo(x + r, y + h);
  gameCtx.quadraticCurveTo(x, y + h, x, y + h - r);
  gameCtx.lineTo(x, y + r);
  gameCtx.quadraticCurveTo(x, y, x + r, y);
  gameCtx.closePath();
  gameCtx.fill();
}

function roundRectColor(x, y, w, h, r, color) {
  gameCtx.save();
  gameCtx.fillStyle = color;
  roundRectFill(x, y, w, h, r);
  gameCtx.restore();
}

function findKeypoint(keypoints, name) {
  return keypoints.find((k) => k.name === name);
}

function drawBone(keypoints, aName, bName) {
  const a = findKeypoint(keypoints, aName);
  const b = findKeypoint(keypoints, bName);
  if (!a || !b || a.score < 0.25 || b.score < 0.25) return;

  overlayCtx.beginPath();
  overlayCtx.moveTo(a.x, a.y);
  overlayCtx.lineTo(b.x, b.y);
  overlayCtx.stroke();
}

function pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function rgbaFromHex(hex, alpha) {
  const c = hex.replace("#", "");
  const n = parseInt(c, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/* =========================
   INIT
========================= */
populateCameraSelect();
