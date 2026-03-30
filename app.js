import {
  PoseLandmarker,
  FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs";

const video = document.getElementById("webcam");
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const overlay = document.getElementById("overlay");
const overlayCtx = overlay.getContext("2d");

const startBtn = document.getElementById("startBtn");
const statusText = document.getElementById("status");

let poseLandmarker = null;
let animationStarted = false;
let history = [];
let ball = null;
let particles = [];

startBtn.onclick = async () => {
  try {
    statusText.innerText = "Requesting camera permission...";

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
    });

    video.srcObject = stream;

    await new Promise((resolve) => {
      video.onloadedmetadata = () => resolve();
    });

    await video.play();

    overlay.width = video.videoWidth || 640;
    overlay.height = video.videoHeight || 480;

    statusText.innerText = "Loading pose tracker...";

    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm"
    );

    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    statusText.innerText = "Camera ready. Stand where your upper body is visible.";

    if (!animationStarted) {
      animationStarted = true;
      requestAnimationFrame(loop);
    }
  } catch (err) {
    console.error(err);
    statusText.innerText = "Camera failed. Check browser permission.";
    alert("Camera failed to start. Make sure you allowed webcam access in Chrome.");
  }
};

function loop(time) {
  requestAnimationFrame(loop);

  drawGame();

  if (!poseLandmarker || video.readyState < 2) return;

  const result = poseLandmarker.detectForVideo(video, time);

  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  if (!result.landmarks || result.landmarks.length === 0) {
    statusText.innerText = "No body detected. Step back so head, shoulders, and arm are visible.";
    updateGame();
    return;
  }

  const lm = result.landmarks[0];

  const rightWrist = lm[16];
  const rightShoulder = lm[12];

  const x = rightWrist.x * overlay.width;
  const y = rightWrist.y * overlay.height;

  overlayCtx.beginPath();
  overlayCtx.arc(x, y, 8, 0, Math.PI * 2);
  overlayCtx.fillStyle = "yellow";
  overlayCtx.fill();

  statusText.innerText = "Body detected. Move your throwing arm forward.";

  history.push({ x: rightWrist.x, y: rightWrist.y, t: time });
  if (history.length > 6) history.shift();

  if (history.length >= 2) {
    const first = history[0];
    const last = history[history.length - 1];

    const dx = last.x - first.x;
    const dy = first.y - last.y;
    const speed = Math.abs(dx) + Math.abs(dy) * 0.5;

    const shoulderDistance = Math.abs(rightWrist.x - rightShoulder.x);

    if (speed > 0.09 && shoulderDistance > 0.06 && !ball) {
      throwBall(speed);
      statusText.innerText = "Throw detected!";
      history = [];
    }
  }

  updateGame();
}

function throwBall(power) {
  ball = {
    x: 50,
    y: 300,
    vx: 8 + power * 120,
    vy: -10 - power * 20
  };
}

function updateGame() {
  if (ball) {
    ball.vy += 0.45;
    ball.x += ball.vx;
    ball.y += ball.vy;

    particles.push({
      x: ball.x,
      y: ball.y,
      vx: Math.random() * 2 - 1,
      vy: Math.random() * 2 - 1,
      size: 4 + Math.random() * 6
    });

    if (ball.y > 350 || ball.x > canvas.width - 20) {
      explode(ball.x, Math.min(ball.y, 350));
      ball = null;
    }
  }

  particles.forEach((p) => {
    p.x += p.vx || 0;
    p.y += p.vy || 0;
    p.size *= 0.95;
  });

  particles = particles.filter((p) => p.size > 1);
}

function explode(x, y) {
  for (let i = 0; i < 35; i++) {
    particles.push({
      x,
      y,
      vx: Math.random() * 8 - 4,
      vy: Math.random() * 8 - 4,
      size: 5 + Math.random() * 10
    });
  }
}

function drawGame() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (ball) {
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = "white";
    ctx.fill();
  }

  particles.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fillStyle = "orange";
    ctx.fill();
  });
}
