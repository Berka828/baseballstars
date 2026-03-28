import {
  PoseLandmarker,
  FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs";

// Official docs show the Pose Landmarker uses FilesetResolver.forVisionTasks()
// and createFromOptions() on the web.
// Model URL pattern is shown in MediaPipe's official demo/example references.
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm";

const video = document.getElementById("webcam");
const overlay = document.getElementById("overlay");
const overlayCtx = overlay.getContext("2d");
const gameCanvas = document.getElementById("gameCanvas");
const g = gameCanvas.getContext("2d");

const startBtn = document.getElementById("startBtn");
const resetBtn = document.getElementById("resetBtn");
const armSelect = document.getElementById("armSelect");
const scoreValue = document.getElementById("scoreValue");
const throwsValue = document.getElementById("throwsValue");
const lastThrowValue = document.getElementById("lastThrowValue");
const statusBadge = document.getElementById("statusBadge");
const phaseText = document.getElementById("phaseText");

let poseLandmarker = null;
let webcamStream = null;
let running = false;
let lastVideoTime = -1;
let rafId = null;

const GAME = {
  maxThrows: 5,
  score: 0,
  throws: 0,
  state: "idle", // idle | ready | cooldown | gameover
  cooldownUntil: 0,
  lastPower: 0,
  particles: [],
  bursts: [],
  ball: null
};

const THROW = {
  history: [],
  minSamples: 6,
  cooldownMs: 1400,
  rightReadyCount: 0,
  leftReadyCount: 0
};

const LANDMARK = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24
};

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  startBtn.textContent = "Starting…";
  try {
    await setupPose();
    await setupCamera();
    resetGame();
    running = true;
    status("Camera live");
    phase("Get into ready position");
    loop();
  } catch (err) {
    console.error(err);
    status("Could not start camera");
    alert(
      "Could not start camera. Make sure you opened the game over HTTPS (GitHub Pages is fine), allowed webcam access, and are using a supported browser."
    );
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = "Restart Camera";
  }
});

resetBtn.addEventListener("click", () => {
  resetGame();
  status("Game reset");
  phase("Get into ready position");
});

function status(text) {
  statusBadge.textContent = text;
}

function phase(text) {
  phaseText.textContent = text;
}

function resetGame() {
  GAME.score = 0;
  GAME.throws = 0;
  GAME.state = "ready";
  GAME.cooldownUntil = 0;
  GAME.lastPower = 0;
  GAME.ball = null;
  GAME.particles = [];
  GAME.bursts = [];
  THROW.history = [];
  THROW.rightReadyCount = 0;
  THROW.leftReadyCount = 0;
  updateHud();
}

function updateHud(lastText = "—") {
  scoreValue.textContent = String(Math.round(GAME.score));
  throwsValue.textContent = `${GAME.throws} / ${GAME.maxThrows}`;
  lastThrowValue.textContent = lastText;
}

async function setupPose() {
  if (poseLandmarker) return;
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate: "GPU"
    },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5
  });
}

async function setupCamera() {
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
  }
  webcamStream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 960 },
      height: { ideal: 720 }
    },
    audio: false
  });
  video.srcObject = webcamStream;
  await video.play();
  sizeOverlay();
  window.addEventListener("resize", sizeOverlay);
}

function sizeOverlay() {
  overlay.width = video.clientWidth || 640;
  overlay.height = video.clientHeight || 480;
}

function loop() {
  rafId = requestAnimationFrame(loop);
  const now = performance.now();

  if (running && poseLandmarker && video.readyState >= 2) {
    if (video.currentTime !== lastVideoTime) {
      const result = poseLandmarker.detectForVideo(video, now);
      lastVideoTime = video.currentTime;
      drawOverlay(result);
      analyzeThrow(result, now);
    }
  }

  updateGame(now);
  drawGame();
}

function drawOverlay(result) {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  overlayCtx.lineWidth = 4;
  overlayCtx.strokeStyle = "rgba(103,183,255,0.95)";
  overlayCtx.fillStyle = "rgba(255,215,102,0.95)";

  if (!result?.landmarks?.length) return;
  const lm = result.landmarks[0];

  const points = [
    LANDMARK.LEFT_SHOULDER,
    LANDMARK.RIGHT_SHOULDER,
    LANDMARK.LEFT_ELBOW,
    LANDMARK.RIGHT_ELBOW,
    LANDMARK.LEFT_WRIST,
    LANDMARK.RIGHT_WRIST,
    LANDMARK.LEFT_HIP,
    LANDMARK.RIGHT_HIP
  ];

  for (const i of points) {
    const p = lm[i];
    const x = (1 - p.x) * overlay.width;
    const y = p.y * overlay.height;
    overlayCtx.beginPath();
    overlayCtx.arc(x, y, 7, 0, Math.PI * 2);
    overlayCtx.fill();
  }

  drawBone(lm, LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER);
  drawBone(lm, LANDMARK.LEFT_SHOULDER, LANDMARK.LEFT_ELBOW);
  drawBone(lm, LANDMARK.LEFT_ELBOW, LANDMARK.LEFT_WRIST);
  drawBone(lm, LANDMARK.RIGHT_SHOULDER, LANDMARK.RIGHT_ELBOW);
  drawBone(lm, LANDMARK.RIGHT_ELBOW, LANDMARK.RIGHT_WRIST);
  drawBone(lm, LANDMARK.LEFT_SHOULDER, LANDMARK.LEFT_HIP);
  drawBone(lm, LANDMARK.RIGHT_SHOULDER, LANDMARK.RIGHT_HIP);
}

function drawBone(lm, a, b) {
  const p1 = lm[a];
  const p2 = lm[b];
  overlayCtx.beginPath();
  overlayCtx.moveTo((1 - p1.x) * overlay.width, p1.y * overlay.height);
  overlayCtx.lineTo((1 - p2.x) * overlay.width, p2.y * overlay.height);
  overlayCtx.stroke();
}

function analyzeThrow(result, now) {
  if (!result?.landmarks?.length || GAME.state === "gameover") {
    status("No body detected");
    return;
  }

  const lm = result.landmarks[0];
  const arm = armSelect.value;

  const wrist = arm === "right" ? lm[LANDMARK.RIGHT_WRIST] : lm[LANDMARK.LEFT_WRIST];
  const elbow = arm === "right" ? lm[LANDMARK.RIGHT_ELBOW] : lm[LANDMARK.LEFT_ELBOW];
  const shoulder = arm === "right" ? lm[LANDMARK.RIGHT_SHOULDER] : lm[LANDMARK.LEFT_SHOULDER];
  const hip = arm === "right" ? lm[LANDMARK.RIGHT_HIP] : lm[LANDMARK.LEFT_HIP];

  if (!wrist || !elbow || !shoulder || !hip) return;

  const sample = {
    t: now,
    wristX: wrist.x,
    wristY: wrist.y,
    elbowX: elbow.x,
    elbowY: elbow.y,
    shoulderX: shoulder.x,
    shoulderY: shoulder.y,
    extension: distance(wrist.x, wrist.y, shoulder.x, shoulder.y),
    elbowBend: distance(wrist.x, wrist.y, elbow.x, elbow.y),
    torsoHeight: Math.abs(hip.y - shoulder.y)
  };

  THROW.history.push(sample);
  if (THROW.history.length > 12) THROW.history.shift();
  if (THROW.history.length < THROW.minSamples) {
    status("Body found");
    return;
  }

  const oldest = THROW.history[0];
  const newest = THROW.history[THROW.history.length - 1];
  const dt = Math.max((newest.t - oldest.t) / 1000, 0.001);

  // Mirrored webcam means we only care about motion magnitude relative to shoulder.
  // In normalized image coords, moving across screen can differ per arm. To keep it
  // simple for kids, use "how quickly the wrist moved away from the shoulder line".
  const relNowX = newest.wristX - newest.shoulderX;
  const relOldX = oldest.wristX - oldest.shoulderX;
  const forwardSpeed = Math.abs(relNowX - relOldX) / dt;
  const upwardSpeed = (oldest.wristY - newest.wristY) / dt;
  const extensionGain = newest.extension - oldest.extension;

  const ready = isReadyToThrow(arm, newest, shoulder, elbow);
  if (ready && GAME.state === "ready" && performance.now() > GAME.cooldownUntil) {
    status("Ready — throw now");
  }

  const validThrow =
    GAME.state === "ready" &&
    performance.now() > GAME.cooldownUntil &&
    ready &&
    forwardSpeed > 0.55 &&
    extensionGain > 0.035;

  if (validThrow) {
    const powerRaw = clamp(forwardSpeed * 120 + extensionGain * 1800 + Math.max(0, upwardSpeed * 18), 20, 100);
    launchBall(powerRaw, newest.extension, arm);
    GAME.state = "cooldown";
    GAME.cooldownUntil = performance.now() + THROW.cooldownMs;
    GAME.throws += 1;
    GAME.lastPower = powerRaw;
    const label = powerLabel(powerRaw);
    updateHud(label);
    status(`${label}!`);
    phase(GAME.throws >= GAME.maxThrows ? "Finish this throw…" : "Nice throw");
    if (GAME.throws >= GAME.maxThrows) {
      setTimeout(() => {
        if (!GAME.ball) {
          GAME.state = "gameover";
          phase("Game over — reset to play again");
        }
      }, 900);
    }
  }

  if (GAME.state === "cooldown" && performance.now() > GAME.cooldownUntil && !GAME.ball) {
    GAME.state = GAME.throws >= GAME.maxThrows ? "gameover" : "ready";
    phase(GAME.state === "gameover" ? "Game over — reset to play again" : "Get into ready position");
  }
}

function isReadyToThrow(arm, sample, shoulder, elbow) {
  // A forgiving “loaded” pose: wrist near shoulder height, elbow bent, wrist not too low.
  const shoulderDistX = Math.abs(sample.wristX - sample.shoulderX);
  const heightDiff = Math.abs(sample.wristY - sample.shoulderY);
  const elbowBendEnough = sample.elbowBend < sample.extension * 0.95 + 0.02;
  return shoulderDistX < 0.18 && heightDiff < 0.18 && elbowBendEnough;
}

function launchBall(power, extension, arm) {
  const strength = clamp(power / 100, 0.2, 1);
  GAME.ball = {
    x: 130,
    y: 370,
    vx: lerp(9, 24, strength),
    vy: lerp(-7, -16, strength) - extension * 3.5,
    r: 15,
    strength,
    trailTimer: 0
  };
}

function updateGame(now) {
  if (GAME.ball) {
    const b = GAME.ball;
    b.vy += 0.27; // gravity
    b.x += b.vx;
    b.y += b.vy;
    b.trailTimer += 1;

    if (b.trailTimer % 2 === 0) {
      addTrailParticle(b.x, b.y, b.strength);
    }

    if (b.y >= 425) {
      const distancePoints = Math.max(0, Math.round((b.x - 130) * 1.3));
      const powerBonus = Math.round(b.strength * 120);
      const gained = distancePoints + powerBonus;
      GAME.score += gained;
      makeBurst(b.x, 425, b.strength);
      GAME.ball = null;

      if (GAME.throws >= GAME.maxThrows) {
        GAME.state = "gameover";
        phase("Game over — reset to play again");
        status("Round complete");
      } else {
        GAME.state = "ready";
        phase("Get into ready position");
      }
    }
  }

  for (let i = GAME.particles.length - 1; i >= 0; i--) {
    const p = GAME.particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= 1;
    p.alpha *= 0.97;
    p.size *= 0.99;
    if (p.life <= 0 || p.alpha < 0.03) GAME.particles.splice(i, 1);
  }

  for (let i = GAME.bursts.length - 1; i >= 0; i--) {
    const b = GAME.bursts[i];
    b.radius += b.speed;
    b.alpha *= 0.95;
    if (b.alpha < 0.03) GAME.bursts.splice(i, 1);
  }

  scoreValue.textContent = String(Math.round(GAME.score));
}

function addTrailParticle(x, y, strength) {
  const count = Math.round(2 + strength * 6);
  for (let i = 0; i < count; i++) {
    GAME.particles.push({
      x,
      y,
      vx: rand(-2.0, 0.6) - strength * 0.9,
      vy: rand(-1.4, 1.4),
      size: rand(2, 5 + strength * 10),
      alpha: rand(0.45, 0.9),
      life: rand(16, 28),
      hue: rand(38, 56)
    });
  }
}

function makeBurst(x, y, strength) {
  const count = Math.round(18 + strength * 54);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = rand(1.5, 4 + strength * 10);
    GAME.particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed * rand(0.6, 1.25),
      vy: Math.sin(angle) * speed * rand(0.6, 1.25) - rand(0, 1.6),
      size: rand(3, 7 + strength * 18),
      alpha: rand(0.55, 1),
      life: rand(22, 50),
      hue: rand(10, 210)
    });
  }
  GAME.bursts.push({
    x,
    y,
    radius: 10,
    speed: 4 + strength * 13,
    alpha: 0.8 + strength * 0.3
  });
}

function drawGame() {
  // clear
  g.clearRect(0, 0, gameCanvas.width, gameCanvas.height);

  // sky
  const sky = g.createLinearGradient(0, 0, 0, gameCanvas.height);
  sky.addColorStop(0, "#78c6ff");
  sky.addColorStop(0.42, "#eff8ff");
  sky.addColorStop(0.43, "#6ac26d");
  sky.addColorStop(1, "#2f9046");
  g.fillStyle = sky;
  g.fillRect(0, 0, gameCanvas.width, gameCanvas.height);

  // sun glow
  g.fillStyle = "rgba(255,236,150,0.5)";
  g.beginPath();
  g.arc(820, 80, 45, 0, Math.PI * 2);
  g.fill();

  // skyline / fence
  g.fillStyle = "#365f7a";
  for (let i = 0; i < 10; i++) {
    const x = 520 + i * 45;
    const h = 30 + (i % 3) * 20 + Math.random() * 2;
    g.fillRect(x, 210 - h, 24, h);
  }
  g.strokeStyle = "#e8f0a4";
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(430, 250);
  g.lineTo(930, 250);
  g.stroke();

  // target grass bands
  g.fillStyle = "rgba(255,255,255,0.12)";
  for (let i = 0; i < 8; i++) {
    g.fillRect(0, 430 + i * 14, gameCanvas.width, 7);
  }

  // mound / throw zone
  g.fillStyle = "#c9874d";
  g.beginPath();
  g.ellipse(125, 428, 58, 18, 0, 0, Math.PI * 2);
  g.fill();

  // text
  g.fillStyle = "rgba(7,27,47,0.78)";
  g.fillRect(16, 16, 280, 72);
  g.fillStyle = "#fff";
  g.font = "bold 24px Inter, sans-serif";
  g.fillText("Motion Pitch Pop", 28, 45);
  g.font = "16px Inter, sans-serif";
  g.fillText("Real throw = farther ball + bigger particles", 28, 72);

  // bursts
  for (const burst of GAME.bursts) {
    g.strokeStyle = `rgba(255,255,255,${burst.alpha})`;
    g.lineWidth = 6;
    g.beginPath();
    g.arc(burst.x, burst.y, burst.radius, 0, Math.PI * 2);
    g.stroke();
  }

  // particles
  for (const p of GAME.particles) {
    g.fillStyle = `hsla(${p.hue}, 95%, 65%, ${p.alpha})`;
    g.beginPath();
    g.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    g.fill();
  }

  // ball
  if (GAME.ball) {
    const b = GAME.ball;
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#d64646";
    g.lineWidth = 2;
    g.beginPath();
    g.arc(b.x, b.y, b.r - 4, Math.PI * 0.2, Math.PI * 0.8);
    g.stroke();
    g.beginPath();
    g.arc(b.x, b.y, b.r - 4, Math.PI * 1.2, Math.PI * 1.8);
    g.stroke();
  }

  // simple state message
  g.fillStyle = "rgba(0,0,0,0.30)";
  g.fillRect(610, 20, 320, 58);
  g.fillStyle = "#fff";
  g.font = "bold 22px Inter, sans-serif";
  g.fillText(stateBanner(), 628, 56);
}

function stateBanner() {
  if (GAME.state === "gameover") return "Round complete";
  if (GAME.ball) return "Ball in flight";
  if (GAME.state === "cooldown") return "Nice throw";
  if (GAME.state === "ready") return "Ready for throw";
  return "Start camera";
}

function powerLabel(power) {
  if (power >= 85) return "Super Throw";
  if (power >= 68) return "Power Throw";
  if (power >= 48) return "Fast Throw";
  return "Soft Toss";
}

function distance(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function rand(min, max) {
  return min + Math.random() * (max - min);
}
