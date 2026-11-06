import { createGestureState, samplesFromResult, stepGestures } from "./gestures.js";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const video = document.querySelector("#camera");
const canvas = document.querySelector("#stage");
const stateEl = document.querySelector("#state");
const hintEl = document.querySelector("#hint");
const startBtn = document.querySelector("#start");

const gesture = createGestureState();
let cameraOn = false;
let opening = false;
let cameraError = "";
let modelStatus = "loading";
let landmarker = null;
let lastVideoTime = -1;
let lastDetect = 0;
let stamp = 0;

video.muted = true;
video.defaultMuted = true;
video.playsInline = true;
video.setAttribute("playsinline", "");
video.setAttribute("webkit-playsinline", "");

for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}
document.addEventListener("touchmove", (event) => event.preventDefault(), { passive: false });
document.addEventListener("contextmenu", (event) => event.preventDefault());

const handsReady = loadLandmarker();

const THREE = await import("https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js");
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 40);
camera.position.z = gesture.cameraZ;

const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  premultipliedAlpha: false,
});
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;

const face = (hex) =>
  new THREE.MeshStandardMaterial({
    color: hex,
    roughness: 0.46,
    metalness: 0.02,
    emissive: hex,
    emissiveIntensity: 0.12,
  });

const cube = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), [
  face(0xef4444),
  face(0xf97316),
  face(0xfacc15),
  face(0x22c55e),
  face(0x3b82f6),
  face(0xa855f7),
]);
cube.add(
  new THREE.LineSegments(
    new THREE.EdgesGeometry(cube.geometry),
    new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.4 }),
  ),
);
scene.add(cube);

scene.add(new THREE.AmbientLight(0xffffff, 0.62));
const key = new THREE.DirectionalLight(0xffffff, 1.05);
key.position.set(1.5, 2.2, 2.6);
scene.add(key);
const fill = new THREE.DirectionalLight(0xdbe7ff, 0.4);
fill.position.set(-2.1, -0.6, 1.4);
scene.add(fill);

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (width < 1 || height < 1) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
}

resize();
window.addEventListener("resize", resize);
window.visualViewport?.addEventListener("resize", resize);

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function paintStatus() {
  if (!cameraOn) setText(stateEl, "Waiting for camera");
  else if (modelStatus === "ready" && gesture.mode === "holding") setText(stateEl, "Holding");
  else if (modelStatus === "ready" && gesture.mode === "zooming") setText(stateEl, "Zooming");
  else setText(stateEl, "Idle");

  if (!cameraOn) setText(hintEl, opening ? "Allow the camera when asked." : cameraError || "Tap to start the camera");
  else if (modelStatus === "loading") setText(hintEl, "Starting hand tracking…");
  else if (modelStatus === "error") setText(hintEl, "Hand tracking did not load. You can still see the cube.");
  else setText(hintEl, "Pinch to turn. Two hands pinch to zoom.");
}

function applyPose() {
  cube.rotation.order = "YXZ";
  cube.rotation.y = gesture.yaw;
  cube.rotation.x = gesture.pitch;
  cube.rotation.z = 0;
  camera.position.z = gesture.cameraZ;
  camera.lookAt(0, 0, 0);
}

function nextStamp(now) {
  stamp = now > stamp ? now : stamp + 1;
  return stamp;
}

function detectHands(now) {
  if (!cameraOn || !landmarker || video.readyState < 2 || video.videoWidth < 2) return;
  const newFrame = video.currentTime !== lastVideoTime;
  if (!newFrame && now - lastDetect < 100) return;
  if (newFrame) lastVideoTime = video.currentTime;
  lastDetect = now;
  const result = landmarker.detectForVideo(video, nextStamp(now));
  const aspect = video.videoWidth / video.videoHeight || 1;
  stepGestures(gesture, samplesFromResult(result), aspect);
}

function frame(now) {
  requestAnimationFrame(frame);
  try {
    detectHands(now);
  } catch (error) {
    console.error(error);
  }
  applyPose();
  renderer.render(scene, camera);
  paintStatus();
}

requestAnimationFrame(frame);
paintStatus();

startBtn.addEventListener("click", async () => {
  if (startBtn.disabled || cameraOn) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraError = "This browser has no camera API. Open the page in Safari.";
    paintStatus();
    return;
  }
  startBtn.disabled = true;
  opening = true;
  cameraError = "";
  paintStatus();
  try {
    const stream = await openCamera();
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    cameraOn = true;
    opening = false;
    startBtn.hidden = true;
  } catch (error) {
    console.error(error);
    opening = false;
    cameraError = messageFor(error);
    startBtn.disabled = false;
    const stream = video.srcObject;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    }
  }
  paintStatus();
});

async function openCamera() {
  const attempts = [
    { audio: false, video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } },
    { audio: false, video: { facingMode: "user" } },
  ];
  let lastError;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;
      if (error?.name === "NotAllowedError" || error?.name === "SecurityError") throw error;
    }
  }
  throw lastError;
}

function messageFor(error) {
  const name = error?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera permission is blocked. Allow it and tap again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No front camera was found. Tap to try again.";
  }
  return "Camera did not start. Tap to try again.";
}

async function loadLandmarker() {
  const { FilesetResolver, HandLandmarker } = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs"
  );
  const vision = await FilesetResolver.forVisionTasks(WASM);
  // CPU leaves the only WebGL context to the cube. The GPU delegate is unreliable
  // in iOS Safari when another WebGL context is already in use.
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL, delegate: "CPU" },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

handsReady.then(
  (created) => {
    landmarker = created;
    modelStatus = "ready";
  },
  (error) => {
    console.error(error);
    modelStatus = "error";
  },
);
