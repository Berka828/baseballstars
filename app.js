const video = document.getElementById("webcam");
const overlay = document.getElementById("overlay");
const overlayCtx = overlay.getContext("2d");
const gameCanvas = document.getElementById("gameCanvas");
const gameCtx = gameCanvas.getContext("2d");
const startBtn = document.getElementById("startBtn");
const resetBtn = document.getElementById("resetBtn");
const statusText = document.getElementById("status");
const cameraSelect = document.getElementById("cameraSelect");
const gamePanel = document.getElementById("gamePanel");

let detector = null;
let started = false;
let selectedCameraId = "";

let wristScreen = null;
let shoulderScreenGlobal = null;
let loadBox = null;
let readyBox = null;
let bullseye = null;
let followGuide = null;

let wristHistory = [];
let readyPoseFrames = 0;
let readyLockout = false;
let throwCooldown = false;
let resultPauseTimer = 0;

let phase = "LOAD"; // LOAD / ARMED / FOLLOW / RESET / DONE
let feedbackText = "READY";
let feedbackTimer = 0;

let formScores = {
  load: 0,
  release: 0,
  target: 0,
  follow: 0,
  total: 0
};

let lastResult = {
  total: 0,
  note: "Complete a throw to get coaching feedback.",
  targetNote: "No throw yet"
};

let sessionCount = 0;
let avgScore = 0;
let currentPower = 0;
let pitchCount = 0;
const MAX_PITCHES = 6;

let rings = [];
let trailDots = [];
let flashes = [];
let confetti = [];
let starBursts = [];
let characterBall = null;

let armReady = false;
let armReadyPulse = 0;
let boxState = "blue";
let targetState = "idle";
let releasePoint = null;
let targetHitLevel = "none";
let targetDistance = 9999;

const FORWARD_DIRECTION = 1; // change to -1 if your setup feels reversed
const RELEASE_THRESHOLD = 34;
const HOLD_FRAMES_REQUIRED = 5;
const FOLLOW_TRAVEL_REQUIRED = 5;

const BX = {
  yellow: "#f1c94c",
  orange: "#f29a45",
  blue: "#6cc7ff",
  pink: "#d87adf",
  green: "#8ed857",
  white: "#ffffff",
  navy: "#07121f",
  red: "#ff6b6b",
  aqua: "#7ef7ff",
  purple: "#9d7bff"
};

function setStatus(msg) {
  if (statusText) statusText.textContent = msg;
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
    const videoDevices = devices.filter((d) => d.kind === "videoinput");

    cameraSelect.innerHTML = "";

    if (!videoDevices.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No cameras found";
      cameraSelect.appendChild(opt);
      return;
    }

    videoDevices.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Camera ${index + 1}`;
      cameraSelect.appendChild(option);
    });

    const preferred =
      videoDevices.find((d) => /obs virtual camera/i.test(d.label)) ||
      videoDevices.find((d) => /azure|kinect/i.test(d.label)) ||
      videoDevices[0];

    selectedCameraId = preferred.deviceId;
    cameraSelect.value = selectedCameraId;

    cameraSelect.onchange = () => {
      selectedCameraId = cameraSelect.value;
    };

    tempStream.getTracks().forEach((track) => track.stop());
  } catch (err) {
    console.error("Could not populate camera list:", err);
    setStatus("Camera permission needed to list cameras.");
  }
}

/* =========================
   FORCE OVERLAY VISIBILITY
========================= */
function forceOverlayVisibility() {
  const wrap = document.querySelector(".videoWrap");
  if (wrap) {
    wrap.style.position = "relative";
    wrap.style.isolation = "isolate";
  }

  video.style.position = "absolute";
  video.style.inset = "0";
  video.style.width = "100%";
  video.style.height = "100%";
  video.style.zIndex = "1";
  video.style.objectFit = "cover";

  overlay.style.position = "absolute";
  overlay.style.inset = "0";
  overlay.style.width = "100%";
  overlay.style.height = "100%";
  overlay.style.zIndex = "9999";
  overlay.style.pointerEvents = "none";
  overlay.style.display = "block";
  overlay.style.opacity = "1";
  overlay.style.background = "transparent";

  const tint = document.querySelector(".videoTint");
  if (tint) {
    tint.style.zIndex = "2";
    tint.style.pointerEvents = "none";
  }
}

/* =========================
   AUDIO
========================= */
let audioCtx = null;

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
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

function playNoiseBurst(duration = 0.08, volume = 0.03, highpass = 1000) {
  ensureAudio();

  const now = audioCtx.currentTime;
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

  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(audioCtx.destination);

  source.start(now);
  source.stop(now + duration);
}

function playLoad() {
  playTone(520, 0.09, "triangle", 0.035);
}

function playRelease() {
  playTone(260, 0.08, "sawtooth", 0.055, 520);
  setTimeout(() => playNoiseBurst(0.05, 0.025, 1200), 20);
}

function playTargetHit() {
  playTone(900, 0.06, "square", 0.05);
  setTimeout(() => playTone(1200, 0.08, "square", 0.045), 45);
  setTimeout(() => playNoiseBurst(0.06, 0.02, 1500), 35);
}

function playNearHit() {
  playTone(700, 0.06, "triangle", 0.04);
  setTimeout(() => playTone(860, 0.08, "triangle", 0.035), 35);
}

function playMiss() {
  playTone(220, 0.08, "sawtooth", 0.03, 150);
}

function playGood() {
  playTone(760, 0.08, "square", 0.04);
  setTimeout(() => playTone(960, 0.08, "square", 0.035), 45);
}

function playGreat() {
  playTone(620, 0.08, "triangle", 0.045);
  setTimeout(() => playTone(860, 0.08, "triangle", 0.045), 50);
  setTimeout(() => playTone(1120, 0.12, "triangle", 0.05), 100);
  setTimeout(() => playNoiseBurst(0.07, 0.02, 1600), 35);
}

function playReset() {
  playTone(520, 0.06, "triangle", 0.03);
}

/* =========================
   CAMERA START
========================= */
async function startCamera() {
  forceOverlayVisibility();
  ensureAudio();
  setStatus("Starting camera...");

  if (video.srcObject) {
    const oldStream = video.srcObject;
    oldStream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }

  if (!selectedCameraId && cameraSelect && cameraSelect.value) {
    selectedCameraId = cameraSelect.value;
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
  overlay.style.width = "100%";
  overlay.style.height = "100%";

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

  setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Load in blue box, then throw to Pelham.`);

  if (!started) {
    started = true;
    requestAnimationFrame(loop);
  }
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

resetBtn.onclick = resetSession;

function resetSession() {
  wristHistory = [];
  readyPoseFrames = 0;
  readyLockout = false;
  throwCooldown = false;
  resultPauseTimer = 0;

  phase = "LOAD";
  feedbackText = "READY";
  feedbackTimer = 0;
  currentPower = 0;

  pitchCount = 0;
  armReady = false;
  armReadyPulse = 0;
  boxState = "blue";
  targetState = "idle";
  releasePoint = null;
  targetHitLevel = "none";
  targetDistance = 9999;

  formScores = { load: 0, release: 0, target: 0, follow: 0, total: 0 };
  lastResult = {
    total: 0,
    note: "Complete a throw to get coaching feedback.",
    targetNote: "No throw yet"
  };

  rings = [];
  trailDots = [];
  flashes = [];
  confetti = [];
  starBursts = [];
  characterBall = null;

  if (gamePanel) {
    gamePanel.classList.remove("impactFlash");
  }

  playReset();
  setStatus(`Pitch 1/${MAX_PITCHES} · Load in blue box, then throw to Pelham.`);
  drawGame();
}

/* =========================
   MAIN LOOP
========================= */
async function loop() {
  requestAnimationFrame(loop);

  updateGame();
  drawGame();

  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  if (!detector || video.readyState < 2) {
    drawFallbackOverlay();
    return;
  }

  try {
    const poses = await detector.estimatePoses(video);

    if (!poses || poses.length === 0 || !poses[0].keypoints) {
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
    shoulderScreenGlobal = { x: rightShoulder.x, y: rightShoulder.y };

    const hipScreen = { x: rightHip.x, y: rightHip.y };
    const leftShoulderScreen = { x: leftShoulder.x, y: leftShoulder.y };

    const torsoHeight = Math.abs(hipScreen.y - shoulderScreenGlobal.y);
    const shoulderSpan = Math.abs(shoulderScreenGlobal.x - leftShoulderScreen.x);

    const baseW = Math.max(shoulderSpan * 1.45, 190);
    const baseH = Math.max(torsoHeight * 1.2, 220);

    loadBox = {
      x: shoulderScreenGlobal.x - baseW - 8,
      y: shoulderScreenGlobal.y - baseH * 0.05,
      w: baseW,
      h: baseH
    };

    readyBox = {
      x: loadBox.x + 2,
      y: loadBox.y + 2,
      w: loadBox.w - 4,
      h: loadBox.h - 4
    };

    bullseye = {
      x: shoulderScreenGlobal.x + Math.max(52, shoulderSpan * 0.34),
      y: shoulderScreenGlobal.y + 18,
      outerR: 120,
      middleR: 80,
      innerR: 42
    };

    followGuide = {
      x1: bullseye.x + 22,
      y1: bullseye.y + 18,
      x2: bullseye.x + 150,
      y2: bullseye.y + 112
    };

    const wristInLoadBox = pointInRect(wristScreen.x, wristScreen.y, loadBox);
    const wristInReadyBox = pointInRect(wristScreen.x, wristScreen.y, readyBox);

    if (phase === "LOAD" && readyLockout) {
      boxState = wristInLoadBox ? "red" : "blue";
      drawSilhouette(keypoints);

      if (!wristInLoadBox) {
        readyLockout = false;
        readyPoseFrames = 0;
        armReady = false;
        boxState = "blue";
        setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Re-enter the blue box.`);
      } else {
        setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Move arm out, then reload.`);
      }
      return;
    }

    armReadyPulse += 0.08;

    if (phase === "LOAD") {
      boxState = wristInReadyBox ? "green" : "blue";
    } else if (phase === "ARMED") {
      boxState = wristInLoadBox ? "green" : "red";
    } else if (phase === "FOLLOW") {
      boxState = "orange";
    } else {
      boxState = "blue";
    }

    drawSilhouette(keypoints);

    if (phase === "DONE") return;
    if (throwCooldown || resultPauseTimer > 0) return;

    wristHistory.push({
      x: wristScreen.x,
      y: wristScreen.y,
      t: performance.now()
    });
    if (wristHistory.length > 18) wristHistory.shift();

    if (phase === "LOAD") {
      if (wristInReadyBox) {
        readyPoseFrames++;

        if (readyPoseFrames >= HOLD_FRAMES_REQUIRED) {
          armReady = true;
          phase = "ARMED";
          formScores.load = 100;
          feedbackText = "ARM READY";
          feedbackTimer = 999999;
          playLoad();
          setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Great load. Throw to Pelham!`);
          wristHistory = [];
        } else {
          armReady = false;
          setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Hold in the green zone...`);
        }
      } else {
        armReady = false;
        readyPoseFrames = 0;
        setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Put your hand in the blue box.`);
      }
      return;
    }

    if (phase === "ARMED") {
      if (wristHistory.length >= 4) {
        const first = wristHistory[0];
        const last = wristHistory[wristHistory.length - 1];

        const rawForwardX = (last.x - first.x) * FORWARD_DIRECTION;
        const upwardY = first.y - last.y;

        const forwardX = Math.max(0, rawForwardX);
        const power = forwardX + Math.max(0, upwardY) * 0.30;
        currentPower = Math.min(400, power * 3.0);

        if (forwardX > RELEASE_THRESHOLD) {
          releasePoint = { x: wristScreen.x, y: wristScreen.y };
          targetDistance = Math.hypot(releasePoint.x - bullseye.x, releasePoint.y - bullseye.y);

          playRelease();
          spawnBurst(releasePoint.x, releasePoint.y, BX.orange, Math.max(75, power * 2.4));
          spawnCharacterBall(wristScreen.x, wristScreen.y, Math.max(70, power * 1.6));
          spawnStarBurst(releasePoint.x, releasePoint.y, Math.max(80, power));

          if (targetDistance <= bullseye.innerR) {
            targetHitLevel = "perfect";
            targetState = "hit";
            formScores.target = 100;
            feedbackText = "BULLSEYE!";
            playTargetHit();
            spawnBigImpact(BX.yellow, Math.max(220, power * 2.4));
            flashGamePanel();
          } else if (targetDistance <= bullseye.middleR) {
            targetHitLevel = "good";
            targetState = "hit";
            formScores.target = 88;
            feedbackText = "TARGET HIT";
            playTargetHit();
            spawnBigImpact(BX.green, Math.max(180, power * 2.0));
            flashGamePanel();
          } else if (targetDistance <= bullseye.outerR + 60) {
            targetHitLevel = "near";
            targetState = "near";
            formScores.target = 70;
            feedbackText = "NICE TRY";
            playNearHit();
            spawnBigImpact(BX.orange, Math.max(150, power * 1.6));
          } else {
            targetHitLevel = "miss";
            targetState = "miss";
            formScores.target = 50;
            feedbackText = "BIG THROW!";
            playMiss();
            spawnBigImpact(BX.pink, Math.max(140, power * 1.4));
          }

          formScores.release = Math.min(100, Math.round(power * 1.7));
          feedbackTimer = 65;
          phase = "FOLLOW";

          setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Follow through down the orange path.`);
          wristHistory = [];
        } else {
          setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Throw to Pelham.`);
        }
      }
      return;
    }

    if (phase === "FOLLOW" && wristHistory.length >= 2) {
      const first = wristHistory[0];
      const last = wristHistory[wristHistory.length - 1];
      const travel = Math.abs(last.x - first.x) + Math.abs(last.y - first.y);

      if (travel > FOLLOW_TRAVEL_REQUIRED) {
        formScores.follow = Math.min(100, 72 + Math.round(travel * 1.7));
        finalizeThrow();
      } else {
        setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Keep following through.`);
      }
    }
  } catch (err) {
    console.error("Pose error:", err);
    drawFallbackOverlay();
    setStatus("Pose error: " + err.message);
  }
}

/* =========================
   FINALIZE THROW
========================= */
function finalizeThrow() {
  formScores.total = Math.round(
    formScores.load * 0.22 +
    formScores.release * 0.28 +
    formScores.target * 0.28 +
    formScores.follow * 0.22
  );

  pitchCount++;
  sessionCount++;
  avgScore = Math.round(((avgScore * (sessionCount - 1)) + formScores.total) / sessionCount);

  let note = "";
  let targetNote = "";
  let burstColor = BX.blue;
  let burstPower = currentPower;

  if (targetHitLevel === "perfect") {
    targetNote = "Bullseye hit!";
  } else if (targetHitLevel === "good") {
    targetNote = "Nice target hit.";
  } else if (targetHitLevel === "near") {
    targetNote = "Close to Pelham.";
  } else {
    targetNote = "Big throw! Try aiming closer to Pelham.";
  }

  if (formScores.total >= 92) {
    note = "Excellent mechanics and aim!";
    feedbackText = "STAR THROW";
    burstColor = BX.yellow;
    burstPower = currentPower * 2.2;
    playGreat();
    flashGamePanel();
  } else if (formScores.total >= 78) {
    note = "Strong throw. Nice mechanics.";
    feedbackText = "STRONG FORM";
    burstColor = BX.green;
    burstPower = currentPower * 1.8;
    playGood();
  } else if (formScores.target < 60) {
    note = "Good load. Aim a little more at Pelham.";
    feedbackText = "AIM FOR PELHAM";
    burstColor = BX.orange;
    burstPower = currentPower * 1.5;
    playGood();
  } else if (formScores.follow < 58) {
    note = "Nice start. Finish down the orange path.";
    feedbackText = "MORE FOLLOW-THROUGH";
    burstColor = BX.aqua;
    burstPower = currentPower * 1.4;
    playGood();
  } else {
    note = "Great job. Keep practicing.";
    feedbackText = "KEEP GOING";
    burstColor = BX.pink;
    burstPower = currentPower * 1.35;
    playGood();
  }

  feedbackTimer = 100;
  lastResult = {
    total: formScores.total,
    note,
    targetNote
  };

  spawnBigImpact(burstColor, Math.max(150, burstPower));

  if (pitchCount >= MAX_PITCHES) {
    phase = "DONE";
    throwCooldown = true;
    resultPauseTimer = 260;
    armReady = false;
    boxState = "blue";
    targetState = "idle";
    feedbackText = "FINAL THROW COMPLETE";
    feedbackTimer = 170;
    setStatus("Nice work! Final results loading...");

    setTimeout(() => {
      feedbackText = "ROUND COMPLETE";
      setStatus("Press Reset Game to play again.");
    }, 2200);

    return;
  }

  phase = "RESET";
  readyLockout = true;
  wristHistory = [];
  throwCooldown = true;
  resultPauseTimer = 85;
  armReady = false;
  readyPoseFrames = 0;
  boxState = "blue";
  targetState = "idle";
  releasePoint = null;
  targetHitLevel = "none";
  targetDistance = 9999;

  setStatus(`${note} Reset for pitch ${pitchCount + 1}/${MAX_PITCHES}...`);

  setTimeout(() => {
    throwCooldown = false;
    phase = "LOAD";
    readyPoseFrames = 0;
    armReady = false;
    boxState = "blue";
    targetState = "idle";
    formScores = { ...formScores, load: 0, release: 0, target: 0, follow: 0 };

    if (pitchCount < MAX_PITCHES) {
      feedbackText = "READY";
      feedbackTimer = 0;
      setStatus(`Pitch ${pitchCount + 1}/${MAX_PITCHES} · Move arm out, then reload.`);
    }
  }, 1250);
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
   UPDATE
========================= */
function updateGame() {
  if (resultPauseTimer > 0) resultPauseTimer--;

  for (let i = trailDots.length - 1; i >= 0; i--) {
    const t = trailDots[i];
    t.x += t.vx;
    t.y += t.vy;
    t.size *= 0.965;
    t.alpha *= 0.94;
    if (t.size < 0.8 || t.alpha < 0.05) trailDots.splice(i, 1);
  }

  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.r += r.grow;
    r.alpha *= 0.928;
    if (r.alpha < 0.05) rings.splice(i, 1);
  }

  for (let i = flashes.length - 1; i >= 0; i--) {
    flashes[i].alpha *= 0.90;
    if (flashes[i].alpha < 0.05) flashes.splice(i, 1);
  }

  for (let i = confetti.length - 1; i >= 0; i--) {
    const c = confetti[i];
    c.x += c.vx;
    c.y += c.vy;
    c.vy += 0.08;
    c.rot += c.spin;
    c.alpha *= 0.985;
    if (c.alpha < 0.05 || c.y > gameCanvas.height + 30) confetti.splice(i, 1);
  }

  for (let i = starBursts.length - 1; i >= 0; i--) {
    const s = starBursts[i];
    s.life--;
    s.scale *= 1.02;
    s.alpha *= 0.93;
    if (s.life <= 0 || s.alpha < 0.04) starBursts.splice(i, 1);
  }

  if (characterBall) {
    characterBall.life--;
    characterBall.x += characterBall.vx;
    characterBall.y += characterBall.vy;
    characterBall.vy += 0.12;
    characterBall.rotation += characterBall.spin;
    if (characterBall.life <= 0) characterBall = null;
  }

  if (feedbackTimer > 0 && feedbackTimer < 999999) feedbackTimer--;
}

/* =========================
   FX HELPERS
========================= */
function spawnBurst(x, y, color, power = 40) {
  const ringCount = 4 + Math.floor(power / 20);

  for (let i = 0; i < ringCount; i++) {
    rings.push({
      x,
      y,
      r: 14 + i * 22,
      grow: 6 + i * 1.3,
      alpha: 0.98 - i * 0.08,
      color: i % 2 === 0 ? color : BX.aqua
    });
  }

  for (let i = 0; i < 26; i++) {
    trailDots.push({
      x,
      y,
      vx: Math.random() * 15 - 7.5,
      vy: Math.random() * 15 - 7.5,
      size: 7 + Math.random() * 12,
      alpha: 0.98,
      color: [color, BX.yellow, BX.pink, BX.aqua, BX.purple][Math.floor(Math.random() * 5)]
    });
  }

  addFlash(color, 0.22);
}

function spawnBigImpact(color, power) {
  const cx = gameCanvas.width * 0.68;
  const cy = gameCanvas.height * 0.36;

  const ringCount =
    power > 260 ? 20 :
    power > 200 ? 16 :
    power > 140 ? 12 : 10;

  const ringScale =
    power > 260 ? 2.5 :
    power > 200 ? 2.05 :
    power > 140 ? 1.7 : 1.35;

  for (let i = 0; i < ringCount; i++) {
    rings.push({
      x: cx,
      y: cy,
      r: (28 + i * 30) * ringScale,
      grow: (7 + i * 1.1) * ringScale,
      alpha: 0.92 - i * 0.045,
      color: i % 3 === 0 ? BX.yellow : i % 3 === 1 ? color : BX.aqua
    });
  }

  for (let i = 0; i < ringCount * 10; i++) {
    confetti.push({
      x: cx,
      y: cy,
      vx: Math.random() * 24 - 12,
      vy: Math.random() * -18 - 2,
      w: 8 + Math.random() * 18,
      h: 5 + Math.random() * 12,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.7,
      alpha: 1,
      color: [BX.blue, BX.orange, BX.yellow, BX.green, BX.pink, BX.purple, BX.aqua][Math.floor(Math.random() * 7)]
    });
  }

  for (let i = 0; i < 36; i++) {
    trailDots.push({
      x: cx,
      y: cy,
      vx: Math.random() * 18 - 9,
      vy: Math.random() * 18 - 9,
      size: 8 + Math.random() * 15,
      alpha: 0.98,
      color: [BX.blue, BX.orange, BX.yellow, BX.green, BX.pink, BX.aqua][Math.floor(Math.random() * 6)]
    });
  }

  spawnStarBurst(cx, cy, power * 1.3);
  addFlash(color, 0.4);
}

function spawnStarBurst(x, y, power) {
  const count = power > 180 ? 4 : power > 110 ? 3 : 2;

  for (let i = 0; i < count; i++) {
    starBursts.push({
      x: x + (Math.random() * 100 - 50),
      y: y + (Math.random() * 100 - 50),
      scale: 0.9 + Math.random() * 0.7,
      alpha: 0.95,
      life: 30 + Math.floor(Math.random() * 14),
      color: [BX.yellow, BX.aqua, BX.pink, BX.orange, BX.green][Math.floor(Math.random() * 5)]
    });
  }
}

function spawnCharacterBall(x, y, power) {
  characterBall = {
    x,
    y,
    vx: 4 + power * 0.045,
    vy: -2.5 - power * 0.016,
    life: 44,
    rotation: 0,
    spin: 0.08 + power * 0.0007,
    size: 24 + Math.min(15, power * 0.06),
    mood: power > 92 ? "fierce" : "happy"
  };
}

function addFlash(color, alpha = 0.25) {
  flashes.push({ color, alpha });
}

/* =========================
   DRAW EFFECTS
========================= */
function drawRings() {
  rings.forEach((r) => {
    gameCtx.strokeStyle = hexToRgba(r.color || "#ffffff", r.alpha);
    gameCtx.lineWidth = 5 + Math.max(0, r.grow * 0.12);
    gameCtx.beginPath();
    gameCtx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    gameCtx.stroke();
  });
}

function drawTrail() {
  trailDots.forEach((t) => {
    gameCtx.fillStyle = hexToRgba(t.color, t.alpha);
    gameCtx.beginPath();
    gameCtx.arc(t.x, t.y, t.size, 0, Math.PI * 2);
    gameCtx.fill();
  });
}

function drawStarBursts() {
  starBursts.forEach((s) => {
    gameCtx.save();
    gameCtx.translate(s.x, s.y);
    gameCtx.scale(s.scale, s.scale);
    gameCtx.globalAlpha = s.alpha;
    gameCtx.strokeStyle = s.color;
    gameCtx.lineWidth = 4;

    for (let i = 0; i < 4; i++) {
      gameCtx.rotate(Math.PI / 4);
      gameCtx.beginPath();
      gameCtx.moveTo(-18, 0);
      gameCtx.lineTo(18, 0);
      gameCtx.stroke();
    }

    gameCtx.restore();
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

function drawCelebrationFlash() {
  flashes.forEach((f) => {
    gameCtx.fillStyle = hexToRgba(f.color, f.alpha * 0.20);
    gameCtx.fillRect(0, 0, gameCanvas.width, gameCanvas.height);
  });
}

/* =========================
   LEFT PANEL OVERLAY
========================= */
function drawFallbackOverlay() {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  overlayCtx.fillStyle = "rgba(0,140,255,0.22)";
  overlayCtx.strokeStyle = "rgba(0,220,255,1)";
  overlayCtx.lineWidth = 5;
  overlayCtx.fillRect(40, 80, 120, 140);
  overlayCtx.strokeRect(40, 80, 120, 140);
}

function drawSilhouette(keypoints) {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  if (loadBox) {
    overlayCtx.fillStyle = "rgba(0,140,255,0.14)";
    overlayCtx.strokeStyle = "rgba(0,220,255,0.9)";
    overlayCtx.lineWidth = 4;
    overlayCtx.fillRect(loadBox.x, loadBox.y, loadBox.w, loadBox.h);
    overlayCtx.strokeRect(loadBox.x, loadBox.y, loadBox.w, loadBox.h);
  }

  if (readyBox) {
    let fillColor = "rgba(80,255,140,0.14)";
    let strokeColor = "rgba(80,255,140,0.8)";

    if (boxState === "green") {
      fillColor = "rgba(80,255,140,0.28)";
      strokeColor = "rgba(80,255,140,1)";
    } else if (boxState === "red") {
      fillColor = "rgba(255,90,90,0.18)";
      strokeColor = "rgba(255,90,90,1)";
    } else if (boxState === "orange") {
      fillColor = "rgba(242,154,69,0.18)";
      strokeColor = "rgba(242,154,69,1)";
    }

    overlayCtx.fillStyle = fillColor;
    overlayCtx.strokeStyle = strokeColor;
    overlayCtx.lineWidth = boxState === "green" ? 7 : 5;
    overlayCtx.fillRect(readyBox.x, readyBox.y, readyBox.w, readyBox.h);
    overlayCtx.strokeRect(readyBox.x, readyBox.y, readyBox.w, readyBox.h);

    if (boxState === "green") {
      overlayCtx.beginPath();
      overlayCtx.strokeStyle = "rgba(80,255,140,0.7)";
      overlayCtx.lineWidth = 4;
      overlayCtx.arc(
        readyBox.x + readyBox.w / 2,
        readyBox.y + readyBox.h / 2,
        18 + Math.sin(armReadyPulse) * 10,
        0,
        Math.PI * 2
      );
      overlayCtx.stroke();
    }
  }

  if (followGuide && phase === "FOLLOW") {
    overlayCtx.strokeStyle = "rgba(242,154,69,0.9)";
    overlayCtx.lineWidth = 5;
    overlayCtx.beginPath();
    overlayCtx.moveTo(followGuide.x1, followGuide.y1);
    overlayCtx.lineTo(followGuide.x2, followGuide.y2);
    overlayCtx.stroke();
  }

  overlayCtx.strokeStyle =
    boxState === "green" ? "rgba(80,255,140,0.98)" :
    boxState === "red" ? "rgba(255,90,90,0.98)" :
    boxState === "orange" ? "rgba(242,154,69,0.98)" :
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
      overlayCtx.fillStyle =
        boxState === "green" ? "rgba(80,255,140,1)" :
        boxState === "red" ? "rgba(255,90,90,1)" :
        boxState === "orange" ? "rgba(242,154,69,1)" :
        "rgba(255,230,120,0.95)";

      overlayCtx.beginPath();
      overlayCtx.arc(k.x, k.y, 6, 0, Math.PI * 2);
      overlayCtx.fill();
    }
  });

  if (wristScreen) {
    overlayCtx.fillStyle =
      boxState === "green" ? "rgba(80,255,140,1)" :
      boxState === "red" ? "rgba(255,90,90,1)" :
      boxState === "orange" ? "rgba(242,154,69,1)" :
      "rgba(255,255,255,1)";

    overlayCtx.beginPath();
    overlayCtx.arc(wristScreen.x, wristScreen.y, 12, 0, Math.PI * 2);
    overlayCtx.fill();
  }
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

/* =========================
   HELPERS
========================= */
function roundedRect(ctx, x, y, w, h, r, fill, stroke, lineWidth = 1) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();

  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

function findKeypoint(keypoints, name) {
  return keypoints.find((k) => k.name === name);
}

function pointInRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

function hexToRgba(hex, alpha) {
  const c = hex.replace("#", "");
  const bigint = parseInt(c, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function wrapText(text, x, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "";

  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + " ";
    const metrics = gameCtx.measureText(testLine);
    const testWidth = metrics.width;

    if (testWidth > maxWidth && n > 0) {
      gameCtx.fillText(line, x, y);
      line = words[n] + " ";
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  gameCtx.fillText(line, x, y);
}

/* =========================
   INIT
========================= */
forceOverlayVisibility();
populateCameraSelect();
