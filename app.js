const video = document.getElementById("webcam");
const overlay = document.getElementById("overlay");
const overlayCtx = overlay.getContext("2d");
const gameCanvas = document.getElementById("gameCanvas");
const gameCtx = gameCanvas.getContext("2d");
const startBtn = document.getElementById("startBtn");
const resetBtn = document.getElementById("resetBtn");
const statusText = document.getElementById("status");

let detector = null;
let started = false;

let ball = null;
let particles = [];
let rings = [];

let score = 0;
let pitchCount = 0;
let maxPitches = 5;
let gameOver = false;
let finalRank = "";
let scoreFlash = "";
let scoreFlashTimer = 0;

let currentPower = 0;
let lastThrowLabel = "READY";

let throwCooldown = false;
let readyPoseArmed = false;
let wristHistory = [];

const strikeZone = { x: 910, y: 250, w: 90, h: 130 };
const miniMap = { x: 35, y: 470, w: 220, h: 95 };

startBtn.onclick = async () => {
  try {
    statusText.innerText = "Requesting camera...";

    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });

    video.srcObject = stream;

    await new Promise((resolve) => {
      video.onloadedmetadata = () => resolve();
    });

    await video.play();

    overlay.width = video.videoWidth || 640;
    overlay.height = video.videoHeight || 800;

    statusText.innerText = "Loading pose detector...";

    await tf.setBackend("webgl");
    await tf.ready();

    detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      {
        modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING
      }
    );

    statusText.innerText = "Bring your throwing hand near your shoulder to arm the pitch.";

    if (!started) {
      started = true;
      requestAnimationFrame(loop);
    }
  } catch (err) {
    console.error(err);
    statusText.innerText = "Error: " + err.message;
    alert("Error: " + err.message);
  }
};

resetBtn.onclick = () => {
  resetGame();
};

function resetGame() {
  ball = null;
  particles = [];
  rings = [];
  score = 0;
  pitchCount = 0;
  gameOver = false;
  finalRank = "";
  scoreFlash = "";
  scoreFlashTimer = 0;
  currentPower = 0;
  lastThrowLabel = "READY";
  throwCooldown = false;
  readyPoseArmed = false;
  wristHistory = [];
  statusText.innerText = "Game reset. Bring your hand near your shoulder to arm the pitch.";
}

async function loop() {
  requestAnimationFrame(loop);

  drawGame();
  updateGame();

  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  if (!detector || video.readyState < 2) return;

  try {
    const poses = await detector.estimatePoses(video);

    if (!poses || poses.length === 0 || !poses[0].keypoints) {
      statusText.innerText = "No body detected. Step back so your upper body is visible.";
      return;
    }

    const keypoints = poses[0].keypoints;

    const rightWrist = findKeypoint(keypoints, "right_wrist");
    const rightElbow = findKeypoint(keypoints, "right_elbow");
    const rightShoulder = findKeypoint(keypoints, "right_shoulder");
    const leftShoulder = findKeypoint(keypoints, "left_shoulder");
    const leftHip = findKeypoint(keypoints, "left_hip");
    const rightHip = findKeypoint(keypoints, "right_hip");

    if (
      !rightWrist || !rightElbow || !rightShoulder ||
      !leftShoulder || !leftHip || !rightHip
    ) {
      statusText.innerText = "Body landmarks unclear. Face camera and step back.";
      return;
    }

    if (
      rightWrist.score < 0.25 ||
      rightElbow.score < 0.25 ||
      rightShoulder.score < 0.25
    ) {
      statusText.innerText = "Right arm not clear. Face camera and step back.";
      return;
    }

    drawSilhouette(keypoints);

    if (gameOver) return;

    const shoulderDist = dist(rightWrist.x, rightWrist.y, rightShoulder.x, rightShoulder.y);
    const elbowBend = dist(rightWrist.x, rightWrist.y, rightElbow.x, rightElbow.y);

    wristHistory.push({
      x: rightWrist.x,
      y: rightWrist.y,
      t: performance.now()
    });
    if (wristHistory.length > 8) wristHistory.shift();

    const armNearShoulder = shoulderDist < 0.16;
    const armLoaded = armNearShoulder && elbowBend < 0.22;

    if (armLoaded && !throwCooldown && !ball) {
      readyPoseArmed = true;
      statusText.innerText = "Loaded. Throw forward now.";
    }

    if (readyPoseArmed && wristHistory.length >= 4 && !throwCooldown && !ball) {
      const first = wristHistory[0];
      const last = wristHistory[wristHistory.length - 1];

      const dx = (last.x - first.x) * overlay.width;
      const dy = (first.y - last.y) * overlay.height;
      const power = Math.abs(dx) + Math.abs(dy) * 0.35;

      if (power > 75 && shoulderDist > 0.22) {
        triggerThrow(power);
      }
    }

  } catch (err) {
    console.error(err);
    statusText.innerText = "Pose error: " + err.message;
  }
}

function triggerThrow(power) {
  const strength = Math.min(power, 180);
  currentPower = Math.min(220, strength);

  if (strength < 90) lastThrowLabel = "SOFT TOSS";
  else if (strength < 120) lastThrowLabel = "FAST BALL";
  else if (strength < 150) lastThrowLabel = "POWER PITCH";
  else lastThrowLabel = "SUPER HEATER";

  ball = {
    x: 145,
    y: 430,
    vx: 11 + strength * 0.18,
    vy: -7.5 - strength * 0.04,
    r: 13
  };

  makeBurst(145, 430, 1.1, "#7fd6ff");
  readyPoseArmed = false;
  throwCooldown = true;
  wristHistory = [];

  statusText.innerText = "Throw detected.";

  setTimeout(() => {
    throwCooldown = false;
    if (!gameOver) {
      statusText.innerText = "Bring your hand near your shoulder to arm the next pitch.";
    }
  }, 900);
}

function updateGame() {
  if (ball && !gameOver) {
    ball.vy += 0.28;
    ball.x += ball.vx;
    ball.y += ball.vy;

    addTrail(ball.x, ball.y);

    if (ball.x >= strikeZone.x) {
      resolvePitch();
      makeBurst(ball.x, ball.y, 1.5, "#ffb347");
      makeRing(ball.x, ball.y);
      ball = null;
    }

    if (ball && (ball.y > 560 || ball.x > gameCanvas.width + 40)) {
      pitchCount++;
      scoreFlash = "MISS";
      scoreFlashTimer = 55;
      makeBurst(ball.x, Math.min(ball.y, 560), 0.9, "#ff7b7b");
      makeRing(ball.x, Math.min(ball.y, 560));
      ball = null;
      checkGameOver();
    }
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.size *= 0.97;
    p.alpha *= 0.95;
    if (p.size < 0.8 || p.alpha < 0.05) particles.splice(i, 1);
  }

  for (let i = rings.length - 1; i >= 0; i--) {
    rings[i].r += 4;
    rings[i].alpha *= 0.92;
    if (rings[i].alpha < 0.05) rings.splice(i, 1);
  }

  if (scoreFlashTimer > 0) scoreFlashTimer--;
}

function resolvePitch() {
  pitchCount++;

  const centerY = strikeZone.y + strikeZone.h / 2;
  const distanceFromCenter = Math.abs(ball.y - centerY);

  if (ball.y >= strikeZone.y && ball.y <= strikeZone.y + strikeZone.h) {
    if (distanceFromCenter < 18) {
      score += 200;
      scoreFlash = "PERFECT +200";
      scoreFlashTimer = 60;
      makeBurst(ball.x, ball.y, 1.7, "#ffe066");
    } else {
      score += 100;
      scoreFlash = "STRIKE +100";
      scoreFlashTimer = 60;
      makeBurst(ball.x, ball.y, 1.2, "#9df59d");
    }

    if (currentPower > 145) {
      score += 50;
      scoreFlash += "  HEAT +50";
      scoreFlashTimer = 70;
    }
  } else {
    scoreFlash = "BALL";
    scoreFlashTimer = 55;
  }

  checkGameOver();
}

function checkGameOver() {
  if (pitchCount >= maxPitches) {
    gameOver = true;

    if (score < 200) finalRank = "ROOKIE";
    else if (score < 400) finalRank = "ALL-STAR";
    else if (score < 650) finalRank = "ACE PITCHER";
    else finalRank = "BXCM LEGEND";

    statusText.innerText = "Round complete. Press Reset Game to play again.";
  }
}

function addTrail(x, y) {
  for (let i = 0; i < 3; i++) {
    particles.push({
      x,
      y,
      vx: Math.random() * 2 - 2.5,
      vy: Math.random() * 2 - 1,
      size: 4 + Math.random() * 7,
      alpha: 0.95,
      color: "#ffb347"
    });
  }
}

function makeBurst(x, y, scale, color) {
  const count = Math.floor(18 + scale * 24);
  for (let i = 0; i < count; i++) {
    particles.push({
      x,
      y,
      vx: (Math.random() * 10 - 5) * scale,
      vy: (Math.random() * 10 - 5) * scale,
      size: (3 + Math.random() * 8) * scale,
      alpha: 1,
      color
    });
  }
}

function makeRing(x, y) {
  rings.push({ x, y, r: 10, alpha: 0.9 });
}

function drawGame() {
  gameCtx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);

  drawBackground();
  drawMiniMap();
  drawStrikeZone();
  drawHUD();
  drawRings();
  drawParticles();
  drawBall();
  drawEndScreen();
}

function drawBackground() {
  const sky = gameCtx.createLinearGradient(0, 0, 0, gameCanvas.height);
  sky.addColorStop(0, "#8fd7ff");
  sky.addColorStop(0.36, "#dff5ff");
  sky.addColorStop(0.37, "#2c4667");
  sky.addColorStop(0.52, "#20344d");
  sky.addColorStop(0.53, "#4ba657");
  sky.addColorStop(1, "#256739");
  gameCtx.fillStyle = sky;
  gameCtx.fillRect(0, 0, gameCanvas.width, gameCanvas.height);

  gameCtx.fillStyle = "#20344d";
  gameCtx.fillRect(0, 210, gameCanvas.width, 85);

  for (let i = 0; i < 180; i++) {
    gameCtx.fillStyle = `rgba(255,255,255,${0.12 + Math.random() * 0.32})`;
    gameCtx.beginPath();
    gameCtx.arc(15 + i * 6, 225 + Math.random() * 55, 1.5 + Math.random() * 1.7, 0, Math.PI * 2);
    gameCtx.fill();
  }

  for (let i = 0; i < 9; i++) {
    gameCtx.fillStyle = "rgba(255,248,190,0.9)";
    gameCtx.beginPath();
    gameCtx.arc(80 + i * 110, 58, 11, 0, Math.PI * 2);
    gameCtx.fill();
  }

  gameCtx.strokeStyle = "rgba(255,255,255,0.25)";
  gameCtx.lineWidth = 4;
  gameCtx.beginPath();
  gameCtx.moveTo(0, 420);
  gameCtx.lineTo(gameCanvas.width, 420);
  gameCtx.stroke();

  for (let i = 0; i < 9; i++) {
    gameCtx.fillStyle = i % 2 === 0 ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)";
    gameCtx.fillRect(0, 430 + i * 22, gameCanvas.width, 22);
  }

  gameCtx.fillStyle = "#c98b52";
  gameCtx.beginPath();
  gameCtx.ellipse(145, 445, 42, 14, 0, 0, Math.PI * 2);
  gameCtx.fill();
}

function drawStrikeZone() {
  gameCtx.strokeStyle = "white";
  gameCtx.lineWidth = 5;
  gameCtx.strokeRect(strikeZone.x, strikeZone.y, strikeZone.w, strikeZone.h);

  gameCtx.strokeStyle = "rgba(255,217,0,0.95)";
  gameCtx.lineWidth = 3;
  gameCtx.strokeRect(
    strikeZone.x + 18,
    strikeZone.y + 24,
    strikeZone.w - 36,
    strikeZone.h - 48
  );

  gameCtx.fillStyle = "rgba(0,0,0,0.5)";
  gameCtx.fillRect(strikeZone.x - 6, strikeZone.y - 38, 132, 28);

  gameCtx.fillStyle = "white";
  gameCtx.font = "bold 15px Arial";
  gameCtx.fillText("STRIKE ZONE", strikeZone.x + 6, strikeZone.y - 18);
}

function drawMiniMap() {
  gameCtx.fillStyle = "rgba(0,0,0,0.35)";
  gameCtx.fillRect(miniMap.x, miniMap.y, miniMap.w, miniMap.h);

  gameCtx.strokeStyle = "rgba(255,255,255,0.25)";
  gameCtx.strokeRect(miniMap.x, miniMap.y, miniMap.w, miniMap.h);

  gameCtx.fillStyle = "#8fd7ff";
  gameCtx.font = "bold 14px Arial";
  gameCtx.fillText("OVERHEAD VIEW", miniMap.x + 12, miniMap.y + 20);

  gameCtx.strokeStyle = "rgba(255,255,255,0.18)";
  gameCtx.beginPath();
  gameCtx.moveTo(miniMap.x + 30, miniMap.y + 65);
  gameCtx.lineTo(miniMap.x + 185, miniMap.y + 65);
  gameCtx.stroke();

  gameCtx.fillStyle = "#c98b52";
  gameCtx.beginPath();
  gameCtx.arc(miniMap.x + 35, miniMap.y + 65, 8, 0, Math.PI * 2);
  gameCtx.fill();

  gameCtx.strokeStyle = "white";
  gameCtx.strokeRect(miniMap.x + 175, miniMap.y + 42, 22, 45);

  if (ball) {
    const t = Math.min(1, (ball.x - 145) / (strikeZone.x - 145));
    const miniX = miniMap.x + 35 + t * 150;
    gameCtx.fillStyle = "#ffb347";
    gameCtx.beginPath();
    gameCtx.arc(miniX, miniMap.y + 65, 5, 0, Math.PI * 2);
    gameCtx.fill();
  }
}

function drawHUD() {
  gameCtx.fillStyle = "rgba(0,0,0,0.35)";
  gameCtx.fillRect(28, 24, 250, 28);

  let meterColor = "#5dc7ff";
  if (currentPower > 60) meterColor = "#ffe066";
  if (currentPower > 110) meterColor = "#ff9f43";
  if (currentPower > 150) meterColor = "#ff4d4d";

  gameCtx.fillStyle = meterColor;
  gameCtx.fillRect(28, 24, Math.min(currentPower, 250), 28);
  gameCtx.strokeStyle = "rgba(255,255,255,0.7)";
  gameCtx.lineWidth = 2;
  gameCtx.strokeRect(28, 24, 250, 28);

  gameCtx.fillStyle = "white";
  gameCtx.font = "bold 14px Arial";
  gameCtx.fillText("PITCH POWER", 28, 18);

  gameCtx.fillStyle = "rgba(0,0,0,0.42)";
  gameCtx.fillRect(810, 24, 240, 72);
  gameCtx.fillStyle = "white";
  gameCtx.font = "bold 24px Arial";
  gameCtx.fillText(`Score: ${score}`, 830, 55);
  gameCtx.fillText(`Pitch: ${pitchCount}/${maxPitches}`, 830, 86);

  gameCtx.textAlign = "center";
  gameCtx.font = "bold 52px Arial";

  if (lastThrowLabel === "SOFT TOSS") gameCtx.fillStyle = "#d6f0ff";
  else if (lastThrowLabel === "FAST BALL") gameCtx.fillStyle = "#ffe066";
  else if (lastThrowLabel === "POWER PITCH") gameCtx.fillStyle = "#ff9f43";
  else if (lastThrowLabel === "SUPER HEATER") gameCtx.fillStyle = "#ff4d4d";
  else gameCtx.fillStyle = "white";

  gameCtx.fillText(lastThrowLabel, gameCanvas.width / 2, 86);

  if (scoreFlashTimer > 0) {
    gameCtx.font = "bold 28px Arial";
    gameCtx.fillStyle = "#fff28a";
    gameCtx.fillText(scoreFlash, gameCanvas.width / 2, 126);
  }

  gameCtx.textAlign = "start";
}

function drawBall() {
  if (!ball) return;

  gameCtx.beginPath();
  gameCtx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
  gameCtx.fillStyle = "white";
  gameCtx.fill();

  gameCtx.strokeStyle = "#d33";
  gameCtx.lineWidth = 2;
  gameCtx.beginPath();
  gameCtx.arc(ball.x, ball.y, ball.r - 3, 0.5, 2.4);
  gameCtx.stroke();

  gameCtx.beginPath();
  gameCtx.arc(ball.x, ball.y, ball.r - 3, 3.6, 5.6);
  gameCtx.stroke();
}

function drawParticles() {
  particles.forEach((p) => {
    gameCtx.fillStyle = hexToRgba(p.color || "#ffb347", p.alpha);
    gameCtx.beginPath();
    gameCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    gameCtx.fill();
  });
}

function drawRings() {
  rings.forEach((r) => {
    gameCtx.strokeStyle = `rgba(255,255,255,${r.alpha})`;
    gameCtx.lineWidth = 4;
    gameCtx.beginPath();
    gameCtx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    gameCtx.stroke();
  });
}

function drawEndScreen() {
  if (!gameOver) return;

  gameCtx.fillStyle = "rgba(0,0,0,0.68)";
  gameCtx.fillRect(260, 150, 580, 260);

  gameCtx.strokeStyle = "rgba(255,255,255,0.18)";
  gameCtx.strokeRect(260, 150, 580, 260);

  gameCtx.fillStyle = "white";
  gameCtx.font = "bold 48px Arial";
  gameCtx.fillText("CHALLENGE COMPLETE", 320, 220);

  gameCtx.fillStyle = "#ffe066";
  gameCtx.font = "bold 44px Arial";
  gameCtx.fillText(finalRank, 430, 285);

  gameCtx.fillStyle = "white";
  gameCtx.font = "bold 30px Arial";
  gameCtx.fillText(`FINAL SCORE: ${score}`, 445, 340);

  gameCtx.font = "bold 22px Arial";
  gameCtx.fillText("Press Reset Game to play again", 420, 382);
}

function drawSilhouette(keypoints) {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  overlayCtx.strokeStyle = "rgba(111,214,255,0.95)";
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
      overlayCtx.arc(k.x, k.y, 5, 0, Math.PI * 2);
      overlayCtx.fill();
    }
  });

  const wrist = findKeypoint(keypoints, "right_wrist");
  if (wrist && wrist.score > 0.25) {
    overlayCtx.fillStyle = "rgba(255,255,255,0.95)";
    overlayCtx.beginPath();
    overlayCtx.arc(wrist.x, wrist.y, 10, 0, Math.PI * 2);
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

function findKeypoint(keypoints, name) {
  return keypoints.find(k => k.name === name);
}

function dist(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

function hexToRgba(hex, alpha) {
  const c = hex.replace("#", "");
  const bigint = parseInt(c, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}
