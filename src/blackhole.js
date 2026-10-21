import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { vertex, diskBake, march, bloomDown, bloomUp, composite } from './shaders.js';

// Distances are in Schwarzschild radii (Rs = 1).
export const defaults = {
  width: 3840,
  height: 2160,
  samples: 3, // n x n jittered samples per pixel
  tile: 128, // px; each tile is one draw call
  diskTextureWidth: 8192,

  // camera
  distance: 32,
  elevation: 5.5, // degrees above the disk plane
  azimuth: 0,
  roll: -9, // degrees
  fov: 21, // vertical, degrees

  // accretion disk
  rIn: 3, // ISCO
  rOut: 13,
  sheetOpacity: 3.5, // optical depth of the disk sheet at density 1
  hazeThickness: 0.035, // scale height / r of the glow around it
  hazeOpacity: 0.5,
  hazeGain: 0.8,
  temperature: 6800, // K at the inner edge, before Doppler shift
  temperatureFalloff: 0.75,
  brightness: 0.7,
  brightnessFalloff: 1.9,
  dopplerColor: 0.9,
  dopplerBeam: 2.3,
  shearMacro: 22,
  shearFilament: 9,

  // integrator
  stepSize: 0.045,
  slabStep: 0.35, // max step inside the haze, in units of its local thickness
  maxSteps: 520,

  // background
  galaxyBrightness: 0.02,

  // post
  bloom: 0.45,
  bloomSpread: 0.55, // < 1 keeps the wide haze from lifting the black shadow
  exposure: 1.0,
  saturation: 1.05,
  vignette: 0.35,
};

const sleep = () => new Promise((r) => setTimeout(r, 0));

function makePass(fragmentShader, uniforms) {
  const material = new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
  return { material, quad: new FullScreenQuad(material), uniforms: material.uniforms };
}

function makeTarget(width, height, wrapS = THREE.ClampToEdgeWrapping) {
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS,
    depthBuffer: false,
    generateMipmaps: false,
  });
}

// Draws a pass into `target` in small scissored tiles so no single draw call runs long.
async function drawTiled(renderer, pass, target, tile, report) {
  const { width, height } = target;
  const gl = renderer.getContext();
  const cols = Math.ceil(width / tile);
  const rows = Math.ceil(height / tile);
  target.scissorTest = true;
  let done = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      target.scissor.set(x * tile, y * tile, tile, tile);
      renderer.setRenderTarget(target);
      pass.quad.render(renderer);
      gl.finish();
      report?.(++done / (cols * rows));
      if (done % 4 === 0) await sleep();
    }
  }
  target.scissorTest = false;
}

function drawFull(renderer, pass, target) {
  renderer.setRenderTarget(target);
  pass.quad.render(renderer);
}

export async function renderBlackHole(canvas, options = {}) {
  const cfg = { ...defaults, ...options };
  const { width, height } = cfg;
  const report = (stage) => (p) => cfg.onProgress?.(p, stage);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);

  // 1. bake the disk turbulence into a log-polar texture
  const texW = cfg.diskTextureWidth;
  const texH = texW / 4;
  const diskTarget = makeTarget(texW, texH, THREE.RepeatWrapping);
  const bake = makePass(diskBake(cfg), { uTexSize: { value: new THREE.Vector2(texW, texH) } });
  await drawTiled(renderer, bake, diskTarget, 256, report('disk'));

  // 2. ray march into an HDR buffer
  const el = THREE.MathUtils.degToRad(cfg.elevation);
  const az = THREE.MathUtils.degToRad(cfg.azimuth);
  const camPos = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).multiplyScalar(cfg.distance);
  const fwd = camPos.clone().negate().normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();

  const hdr = makeTarget(width, height);
  const scene = makePass(march(cfg), {
    uResolution: { value: new THREE.Vector2(width, height) },
    uGrid: { value: cfg.samples },
    uCamPos: { value: camPos },
    uCamRight: { value: right },
    uCamUp: { value: up },
    uCamFwd: { value: fwd },
    uTanHalfY: { value: Math.tan(THREE.MathUtils.degToRad(cfg.fov) / 2) },
    uRoll: { value: THREE.MathUtils.degToRad(cfg.roll) },
    uDisk: { value: diskTarget.texture },
  });
  await drawTiled(renderer, scene, hdr, cfg.tile, report('trace'));

  // 3. bloom pyramid
  const levels = 7;
  const down = [];
  const up2 = [];
  for (let i = 1; i <= levels; i++) {
    const w = Math.max(2, width >> i);
    const h = Math.max(2, height >> i);
    down.push(makeTarget(w, h));
    up2.push(makeTarget(w, h));
  }
  const downPass = makePass(bloomDown, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const upPass = makePass(bloomUp, {
    tLow: { value: null },
    tHigh: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uWeight: { value: 1 },
  });
  let src = hdr;
  for (const t of down) {
    downPass.uniforms.tSrc.value = src.texture;
    downPass.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
    drawFull(renderer, downPass, t);
    src = t;
  }
  let low = down[levels - 1];
  for (let i = levels - 2; i >= 0; i--) {
    upPass.uniforms.tLow.value = low.texture;
    upPass.uniforms.tHigh.value = down[i].texture;
    upPass.uniforms.uTexel.value.set(1 / low.width, 1 / low.height);
    upPass.uniforms.uWeight.value = cfg.bloomSpread;
    drawFull(renderer, upPass, up2[i]);
    low = up2[i];
  }

  // 4. composite to the canvas
  const comp = makePass(composite(cfg), {
    tScene: { value: hdr.texture },
    tBloom: { value: low.texture },
    uResolution: { value: new THREE.Vector2(width, height) },
  });
  renderer.setRenderTarget(null);
  renderer.setViewport(0, 0, width, height);
  comp.quad.render(renderer);
  renderer.getContext().finish();
  cfg.onProgress?.(1, 'done');

  return canvas.toDataURL('image/png');
}
