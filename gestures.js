// Pinch and turn/zoom mapping. Landmark x is mirrored so it matches the
// CSS-mirrored front-camera preview. Pose updates are absolute from the
// moment a pinch grabs; releasing applies nothing further.

export const PINCH_ENTER = 0.42;
export const PINCH_EXIT = 0.62;
export const YAW_PER_SCREEN = 4.8;
export const PITCH_PER_SCREEN = 2.6;
export const PITCH_LIMIT = 1.25;
export const MIN_CAMERA_Z = 2.4;
export const MAX_CAMERA_Z = 12;

const THUMB_TIP = 4;
const INDEX_TIP = 8;
const WRIST = 0;
const MIDDLE_MCP = 9;

export function createGestureState() {
  return {
    mode: "idle",
    yaw: 0.62,
    pitch: 0.38,
    cameraZ: 7.4,
    pinchLatch: {},
    hold: null,
    zoom: null,
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function sampleHand(landmarks, key) {
  if (!landmarks || landmarks.length <= MIDDLE_MCP) return null;
  const thumb = landmarks[THUMB_TIP];
  const index = landmarks[INDEX_TIP];
  const palm = distance(landmarks[WRIST], landmarks[MIDDLE_MCP]);
  if (![thumb, index].every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))) {
    return null;
  }
  const ratio = palm > 1e-4 ? distance(thumb, index) / palm : Infinity;
  return {
    key,
    x: 1 - (thumb.x + index.x) / 2,
    y: (thumb.y + index.y) / 2,
    ratio,
  };
}

export function samplesFromResult(result) {
  const landmarks = result?.landmarks ?? [];
  const handedness = result?.handednesses ?? [];
  const seen = {};
  const samples = [];
  for (let i = 0; i < landmarks.length; i += 1) {
    const name = handedness[i]?.[0]?.categoryName || "Hand";
    seen[name] = (seen[name] || 0) + 1;
    const key = seen[name] === 1 ? name : `${name}-${seen[name]}`;
    const sample = sampleHand(landmarks[i], key);
    if (sample) samples.push(sample);
  }
  return samples;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function stepGestures(state, samples, aspect = 1) {
  const active = [];
  const present = new Set();
  for (const sample of samples) {
    present.add(sample.key);
    const wasPinching = state.pinchLatch[sample.key] === true;
    const pinching = wasPinching ? sample.ratio <= PINCH_EXIT : sample.ratio <= PINCH_ENTER;
    state.pinchLatch[sample.key] = pinching;
    if (pinching) active.push(sample);
  }
  for (const key of Object.keys(state.pinchLatch)) {
    if (!present.has(key)) delete state.pinchLatch[key];
  }

  if (active.length >= 2) {
    const [a, b] = active;
    const separation = Math.hypot((a.x - b.x) * aspect, a.y - b.y);
    if (state.mode !== "zooming" || !state.zoom) {
      state.mode = "zooming";
      state.hold = null;
      state.zoom = {
        separation: Math.max(separation, 0.05),
        cameraZ: state.cameraZ,
      };
    } else {
      const ratio = separation / state.zoom.separation;
      state.cameraZ = clamp(state.zoom.cameraZ / Math.max(ratio, 0.05), MIN_CAMERA_Z, MAX_CAMERA_Z);
    }
    return state;
  }

  state.zoom = null;
  if (active.length === 1) {
    const hand = active[0];
    const sameHold = state.mode === "holding" && state.hold?.key === hand.key;
    if (!sameHold) {
      state.mode = "holding";
      state.hold = { key: hand.key, x: hand.x, y: hand.y, yaw: state.yaw, pitch: state.pitch };
    } else {
      const dx = hand.x - state.hold.x;
      const dy = hand.y - state.hold.y;
      state.yaw = state.hold.yaw - dx * YAW_PER_SCREEN;
      state.pitch = clamp(state.hold.pitch + dy * PITCH_PER_SCREEN, -PITCH_LIMIT, PITCH_LIMIT);
    }
    return state;
  }

  state.mode = "idle";
  state.hold = null;
  return state;
}
