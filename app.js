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

let detector = null;
let started = false;
let selectedCameraId = "";

let wristScreen = null;
let shoulderScreen = null;

let loadBox = null;
let target = null;
let followGuide = null;

let phase = "LOAD"; // LOAD / READY / FOLLOW / RESET / DONE
let pitchCount = 0;
const MAX_PITCHES = 6;

let readyFrames = 0;
let throwCooldown = false;
let readyLockout = false;
let feedbackText = "READY";
let feedbackTimer = 0;
let currentPower = 0;

let wristHistory = [];
let rings = [];
let sparks = [];
let confetti = [];
let flashes = [];

const FORWARD_DIRECTION = 1; // flip to -1 if needed
const HOLD_FRAMES_REQUIRED = 5;
const RELEASE_THRESHOLD = 34;
const FOLLOW_THRESHOLD = 6;

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
  shell: "#4fa35d",
  shellDark: "#2f6f3a",
  skin: "#86c96f"
};

/* =========================
   STATUS
========================= */
function setStatus(text) {
  if (statusText) statusText.textContent = text;
}

/* =========================
   AUDIO
========================= */
let audioCtx = null;

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
}

function playTone(freq = 440, duration = 0.08, type = "sine", volume = 0.04, slideTo = null) {
  ensureAudio();
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (slideTo !== null) osc.frequency.linearRampToValueAtTime(slideTo, now + duration);

  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + duration);
}

function playNoise(duration = 0.05, volume = 0.02) {
  ensureAudio();
  const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * duration, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const source = audioCtx.createBufferSource();
  const gain = audioCtx.createGain();
  const filter = audioCtx.createBiquadFilter();

  source.buffer = buffer;
  filter.type = "highpass";
  filter.frequency.value = 1200;

  gain.gain.value = volume;
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(audioCtx.destination);

  source.start();
  source.stop(audioCtx.currentTime + duration);
}

function playLoad() {
  playTone(520, 0.09, "triangle", 0.04);
}

function playThrow() {
  playTone(260, 0.08, "sawtooth", 0.05, 520);
  setTimeout(() => playNoise(0.04, 0.02), 20);
}

function playHit() {
  playTone(900, 0.05, "square", 0.05);
  setTimeout(() => playTone(1200, 0.08, "square", 0.045), 40);
}

function playNear() {
  playTone(700, 0.06, "triangle", 0.035);
  setTimeout(() => playTone(860, 0.07, "triangle", 0.03), 35);
}

function playMiss() {
  playTone(220, 0.08, "sawtooth", 0.03, 140);
}

function playSuccess() {
  playTone(620, 0.08, "triangle", 0.045);
  setTimeout(() => playTone(860, 0.08, "triangle", 0.04), 50);
  setTimeout(() => playTone(1120, 0.12, "triangle", 0.045), 100);
}

function playReset() {
  playTone(520, 0.06, "triangle", 0.03);
}

/* =========================
   CAMERA PICKER
========================= */
async function populateCameraSelect() {
  if (!cameraSelect) return;

  try {
    const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput");

    cameraSelect.innerHTML = "";

    cams.forEach((cam, i) => {
      const option = document.createElement("option");
      option.value = cam.deviceId;
      option.textContent = cam.label || `Camera ${i + 1}`;
      cameraSelect.appendChild(option);
    });

    if (cams.length) {
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
    console.error("Camera list error:", err);
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

  if (gamePanel) gamePanel.classList.add("game-active");

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
  throwCooldown = false;
  readyLockout = false;
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
async function loop() {
  requestAnimationFrame(loop);

  updateFX();
  drawGame();

  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  if (!detector || video.readyState < 2) {
    drawFallbackOverlay();
    return;
  }

  try {
    const poses = await detector.estimatePoses(video);

    if (!poses?.length || !poses[0].keypoints) {
      drawFallbackOverlay();
      setStatus("No body detected. Step back so your upper body is visible.");
      return;
    }

    const keypoints = poses[0].keypoints;

    const rightWrist = findKeypoint(keypoints, "right_wrist");
    const rightShoulder = findKeypoint(keypoints, "right_shoulder");
    const rightHip = findKeypoint(keypoints, "right_hip");
    const leftShoulder = findKeypoint(keypoints, "left_shoulder");

    if (
      !rightWrist || !rightShoulder || !rightHip || !leftShoulder ||
      rightWrist.score < 0.2 ||
      rightShoulder.score < 0.2 ||
      rightHip.score < 0.2 ||
      leftShoulder.score < 0.2
    ) {
      drawFallbackOverlay();
      setStatus("Upper body not clear. Face camera and step back.");
      return;
    }

    wristScreen = { x: rightWrist.x, y: rightWrist.y };
    shoulderScreen = { x: rightShoulder.x, y: rightShoulder.y };

    const torsoHeight = Math.abs(rightHip.y - rightShoulder.y);
    const shoulderSpan = Math.abs(rightShoulder.x - leftShoulder.x);

    const boxW = Math.max(shoulderSpan * 1.45, 190);
    const boxH = Math.max(torsoHeight * 1.2, 220);

    loadBox = {
      x: shoulderScreen.x - boxW - 8,
      y: shoulderScreen.y - boxH * 0.05,
      w: boxW,
      h: boxH
    };

    readyBox = {
      x: loadBox.x + 2,
      y: loadBox.y + 2,
      w: loadBox.w - 4,
      h: loadBox.h - 4
    };

    target = {
      x: shoulderScreen.x + Math.max(54, shoulderSpan * 0.34),
      y: shoulderScreen.y + 20,
      outerR: 120,
      middleR: 80,
      innerR: 42
    };

    followGuide = {
      x1: target.x + 18,
      y1: target.y + 20,
      x2: target.x + 150,
      y2: target.y + 112
    };

    drawOverlay(keypoints);

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
          const dist = Math.hypot(wristScreen.x - target.x, wristScreen.y - target.y);

          playThrow();
          spawnBurst(wristScreen.x, wristScreen.y, COLORS.orange, Math.max(80, power * 2.4));
          spawnBigImpact(COLORS.orange, Math.max(120, power * 1.5));

          if (dist <= target.innerR) {
            feedbackText = "BULLSEYE!";
            playTargetHit();
            spawnBigImpact(COLORS.yellow, Math.max(220, power * 2.4));
            flashGamePanel();
          } else if (dist <= target.middleR) {
            feedbackText = "TARGET HIT";
            playTargetHit();
            spawnBigImpact(COLORS.green, Math.max(180, power * 2.0));
            flashGamePanel();
          } else if (dist <= target.outerR + 60) {
            feedbackText = "NICE TRY";
            playNearHit();
            spawnBigImpact(COLORS.orange, Math.max(150, power * 1.6));
          } else {
            feedbackText = "BIG THROW!";
            playMiss();
            spawnBigImpact(COLORS.pink, Math.max(140, power * 1.4));
          }

          feedbackTimer = 70;
          phase = "FOLLOW";
          wristHistory = [];
          setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Follow through.`);
        } else {
          setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Throw to Pelham.`);
        }
      }
      return;
    }

    if (phase === "FOLLOW") {
      if (wristHistory.length >= 2) {
        const first = wristHistory[0];
        const last = wristHistory[wristHistory.length - 1];
        const travel = Math.abs(last.x - first.x) + Math.abs(last.y - first.y);

        if (travel > FOLLOW_THRESHOLD) {
          completePitch();
        } else {
          setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Keep following through.`);
        }
      }
    }
  } catch (err) {
    console.error("Pose detection error:", err);
    setStatus("Pose error: " + err.message);
  }
}

/* =========================
   COMPLETE PITCH
========================= */
function completePitch() {
  pitchCount++;
  feedbackTimer = 100;
  playSuccess();

  if (pitchCount >= MAX_PITCHES) {
    phase = "DONE";
    throwCooldown = true;
    feedbackText = "ROUND COMPLETE";
    setStatus("Nice work! Press Reset Game to play again.");
    setTimeout(() => {
      throwCooldown = false;
    }, 2400);
    return;
  }

  phase = "RESET";
  throwCooldown = true;
  readyLockout = true;
  readyFrames = 0;
  wristHistory = [];

  setStatus(`Reset for pitch ${pitchCount + 1}/${MAX_PITCHES}...`);

  setTimeout(() => {
    phase = "LOAD";
    throwCooldown = false;
    feedbackText = "READY";
    feedbackTimer = 0;
    setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Move arm out, then reload.`);
  }, 1300);
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
   DRAW GAME
========================= */
function drawGame() {
  gameCtx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);

  drawBackground();
  drawHUD();
  drawTopFade();
  drawRings();
  drawSparks();
  drawConfetti();
  drawFlashes();
}

function drawBackground() {
  const bg = gameCtx.createLinearGradient(0, 0, 0, gameCanvas.height);
  bg.addColorStop(0, "#173149");
  bg.addColorStop(0.35, "#1e3b55");
  bg.addColorStop(0.36, "#1b2e40");
  bg.addColorStop(1, "#234e2b");
  gameCtx.fillStyle = bg;
  gameCtx.fillRect(0, 0, gameCanvas.width, gameCanvas.height);

  drawPelhamCatcher();
}

function drawPelhamCatcher() {
  const cx = gameCanvas.width * 0.68;
  const cy = gameCanvas.height * 0.36;

  const glow = gameCtx.createRadialGradient(cx, cy, 20, cx, cy, 220);
  glow.addColorStop(0, "rgba(241,201,76,0.18)");
  glow.addColorStop(0.45, "rgba(108,199,255,0.10)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  gameCtx.fillStyle = glow;
  gameCtx.fillRect(cx - 260, cy - 220, 520, 440);

  gameCtx.fillStyle = COLORS.shellDark;
  gameCtx.beginPath();
  gameCtx.ellipse(cx, cy + 12, 110, 130, 0, 0, Math.PI * 2);
  gameCtx.fill();

  gameCtx.fillStyle = COLORS.shell;
  gameCtx.beginPath();
  gameCtx.ellipse(cx, cy + 8, 96, 116, 0, 0, Math.PI * 2);
  gameCtx.fill();

  gameCtx.strokeStyle = "rgba(255,255,255,0.16)";
  gameCtx.lineWidth = 5;
  gameCtx.beginPath();
  gameCtx.moveTo(cx, cy - 86);
  gameCtx.lineTo(cx, cy + 100);
  gameCtx.stroke();

  gameCtx.beginPath();
  gameCtx.moveTo(cx - 62, cy - 42);
  gameCtx.lineTo(cx + 62, cy - 42);
  gameCtx.stroke();

  gameCtx.beginPath();
  gameCtx.moveTo(cx - 64, cy + 34);
  gameCtx.lineTo(cx + 64, cy + 34);
  gameCtx.stroke();

  gameCtx.fillStyle = COLORS.skin;
  gameCtx.beginPath();
  gameCtx.ellipse(cx, cy - 112, 48, 40, 0, 0, Math.PI * 2);
  gameCtx.fill();

  gameCtx.fillStyle = COLORS.white;
  gameCtx.beginPath();
  gameCtx.arc(cx - 15, cy - 118, 8, 0, Math.PI * 2);
  gameCtx.arc(cx + 15, cy - 118, 8, 0, Math.PI * 2);
  gameCtx.fill();

  gameCtx.fillStyle = COLORS.navy;
  gameCtx.beginPath();
  gameCtx.arc(cx - 15, cy - 118, 3.5, 0, Math.PI * 2);
  gameCtx.arc(cx + 15, cy - 118, 3.5, 0, Math.PI * 2);
  gameCtx.fill();

  gameCtx.strokeStyle = COLORS.navy;
  gameCtx.lineWidth = 3;
  gameCtx.beginPath();
  gameCtx.arc(cx, cy - 106, 15, 0.25, 2.9);
  gameCtx.stroke();

  gameCtx.strokeStyle = COLORS.skin;
  gameCtx.lineWidth = 14;
  gameCtx.lineCap = "round";

  gameCtx.beginPath();
  gameCtx.moveTo(cx - 72, cy - 10);
  gameCtx.lineTo(cx - 144, cy + 22);
  gameCtx.stroke();

  gameCtx.beginPath();
  gameCtx.moveTo(cx + 72, cy - 8);
  gameCtx.lineTo(cx + 132, cy + 20);
  gameCtx.stroke();

  const mittX = cx + 156;
  const mittY = cy + 32;

  gameCtx.fillStyle = "#b36b34";
  gameCtx.beginPath();
  gameCtx.ellipse(mittX, mittY, 48, 58, 0, 0, Math.PI * 2);
  gameCtx.fill();

  gameCtx.fillStyle = "#db9250";
  gameCtx.beginPath();
  gameCtx.ellipse(mittX + 3, mittY + 2, 32, 38, 0, 0, Math.PI * 2);
  gameCtx.fill();

  gameCtx.strokeStyle = "rgba(255,255,255,0.75)";
  gameCtx.lineWidth = 5;
  gameCtx.beginPath();
  gameCtx.arc(mittX, mittY, 70, 0, Math.PI * 2);
  gameCtx.stroke();

  gameCtx.fillStyle = COLORS.white;
  gameCtx.font = "bold 22px Arial";
  gameCtx.fillText("BxCM", cx - 28, cy + 172);
}

function drawHUD() {
  gameCtx.fillStyle = "rgba(6,16,28,0.76)";
  roundRectFill(30, 24, 320, 44, 18);
  roundRectFill(1040, 24, 250, 104, 20);
  roundRectFill(420, 22, 520, 90, 24);

  roundRectColor(34, 30, Math.min(currentPower, 300), 30, 14, currentPower > 180 ? COLORS.orange : COLORS.blue);

  gameCtx.fillStyle = COLORS.white;
  gameCtx.font = "bold 15px Arial";
  gameCtx.fillText("MOTION ENERGY", 38, 20);

  gameCtx.font = "bold 26px Arial";
  gameCtx.fillText(`Pitch: ${pitchCount}/${MAX_PITCHES}`, 1064, 58);
  gameCtx.fillText(`Throws: ${pitchCount}`, 1064, 88);

  gameCtx.textAlign = "center";
  gameCtx.font = "bold 24px Arial";
  gameCtx.fillText("BXCM THROW LAB", gameCanvas.width / 2, 54);

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
    gameCtx.fillStyle = rgbaFromHex(f.color, f.alpha * 0.2);
    gameCtx.fillRect(0, 0, gameCanvas.width, gameCanvas.height);
  });
}

/* =========================
   DRAW OVERLAY
========================= */
function drawOverlay(keypoints) {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

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

  overlayCtx.strokeStyle =
    phase === "READY" ? "rgba(80,255,140,0.98)" :
    phase === "FOLLOW" ? "rgba(242,154,69,0.98)" :
    "rgba(111,214,255,0.98)";

  overlayCtx.lineWidth = 6;
  overlayCtx.lineCap = "round";

  drawBone(keypoints, "left_shoulder", "right_shoulder");
  drawBone(keypoints, "left_shoulder", "left_elbow");
  drawBone(keypoints, "left_elbow", "left_wrist");
  drawBone(keypoints, "right_shoulder", "right_elbow");
  drawBone(keypoints, "right_elbow", "right_wrist");
  drawBone(keypoints, "left_shoulder", "left_hip");
  drawBone(keypoints, "right_shoulder", "right_hip");
  drawBone(keypoints, "left_hip", "right_hip");

  keypoints.forEach((k) => {
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

/* =========================
   FX UPDATE
========================= */
function updateFX() {
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

function spawnBurst(x, y, color, power = 40) {
  const ringCount = 4 + Math.floor(power / 20);

  for (let i = 0; i < ringCount; i++) {
    rings.push({
      x,
      y,
      r: 16 + i * 22,
      grow: 6 + i * 1.2,
      alpha: 0.98 - i * 0.08,
      color: i % 2 === 0 ? color : COLORS.aqua
    });
  }

  for (let i = 0; i < 26; i++) {
    sparks.push({
      x,
      y,
      vx: Math.random() * 15 - 7.5,
      vy: Math.random() * 15 - 7.5,
      size: 7 + Math.random() * 11,
      alpha: 0.98,
      color: [color, COLORS.yellow, COLORS.pink, COLORS.aqua, COLORS.purple][Math.floor(Math.random() * 5)]
    });
  }

  flashes.push({ color, alpha: 0.22 });
}

function spawnBigImpact(color, power) {
  const x = gameCanvas.width * 0.68;
  const y = gameCanvas.height * 0.36;

  const ringCount = power > 240 ? 18 : power > 180 ? 14 : 10;
  const ringScale = power > 240 ? 2.4 : power > 180 ? 2.0 : 1.5;

  for (let i = 0; i < ringCount; i++) {
    rings.push({
      x,
      y,
      r: (30 + i * 30) * ringScale,
      grow: (7 + i * 1.1) * ringScale,
      alpha: 0.92 - i * 0.045,
      color: i % 3 === 0 ? COLORS.yellow : i % 3 === 1 ? color : COLORS.aqua
    });
  }

  for (let i = 0; i < ringCount * 8; i++) {
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
      color: [COLORS.blue, COLORS.orange, COLORS.yellow, COLORS.green, COLORS.pink, COLORS.purple, COLORS.aqua][Math.floor(Math.random() * 7)]
    });
  }

  flashes.push({ color, alpha: 0.4 });
}

/* =========================
   SHAPE HELPERS
========================= */
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

function pointInRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
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
forceOverlayVisibility();
