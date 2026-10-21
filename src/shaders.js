// All GLSL lives here. Units: Schwarzschild radius Rs = 1 (so M = 1/2).
//   photon sphere r = 1.5, shadow radius b = 3*sqrt(3)/2 ~= 2.6, ISCO r = 3.

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

export const vertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const common = /* glsl */ `
#define PI 3.14159265359
#define TAU 6.28318530718

uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float hash(uint a)               { return float(pcg(a)) * (1.0 / 4294967296.0); }
float hash(uint a, uint b)       { return float(pcg(a ^ pcg(b))) * (1.0 / 4294967296.0); }
float hash(uint a, uint b, uint c) { return float(pcg(a ^ pcg(b ^ pcg(c)))) * (1.0 / 4294967296.0); }
`;

// ---------------------------------------------------------------------------
// 1. Disk texture bake: turbulence in (angle, log r) space, differentially sheared.
// ---------------------------------------------------------------------------
export const diskBake = (c) => /* glsl */ `
${common}
uniform vec2 uTexSize;

#define LN_RMIN ${f(Math.log(c.rIn * 0.9))}
#define LN_RMAX ${f(Math.log(c.rOut * 1.05))}

// value noise, periodic along x with an integer period (so the angle wraps seamlessly)
float vnoise(vec2 p, float period, uint seed) {
  vec2 i = floor(p);
  vec2 fr = p - i;
  vec2 u = fr * fr * fr * (fr * (fr * 6.0 - 15.0) + 10.0);
  uint x0 = uint(mod(i.x, period));
  uint x1 = uint(mod(i.x + 1.0, period));
  uint y0 = uint(i.y);
  uint y1 = y0 + 1u;
  float a = hash(x0, y0, seed);
  float b = hash(x1, y0, seed);
  float cc = hash(x0, y1, seed);
  float d = hash(x1, y1, seed);
  return mix(mix(a, b, u.x), mix(cc, d, u.x), u.y);
}

float fbm(float a, float lnr, float na, float ks, int octaves, float gain, uint seed) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * vnoise(vec2(fract(a) * na, lnr * ks), na, seed + uint(i) * 17u);
    norm += amp;
    amp *= gain;
    na *= 2.0;
    ks *= 2.0;
  }
  return sum / norm;
}

// returns (sheet density, brightness, smooth density for the haze)
vec3 pattern(float a, float v) {
  float lnr = mix(LN_RMIN, LN_RMAX, v);
  float r = exp(lnr);
  float omega = 0.7071 * pow(r, -1.5);          // Keplerian angular speed

  // large, tightly wound spiral clumps (fbm hugs 0.5, so stretch the contrast)
  float aMacro = a - omega * ${f(c.shearMacro)} / TAU;
  float macro = smoothstep(0.28, 0.72, fbm(aMacro, lnr, 3.0, 4.0, 6, 0.62, 11u));

  // concentric filaments, broken into arcs by an angular modulation
  float aFil = a - omega * ${f(c.shearFilament)} / TAU;
  float fil = 0.50 * vnoise(vec2(fract(aFil) * 13.0, lnr * 42.0), 13.0, 71u)
            + 0.32 * vnoise(vec2(fract(aFil) * 29.0, lnr * 115.0), 29.0, 72u)
            + 0.18 * vnoise(vec2(fract(aFil) * 61.0, lnr * 340.0), 61.0, 73u);
  fil = smoothstep(0.26, 0.74, fil);
  float arcs = smoothstep(0.30, 0.70, fbm(aFil, lnr, 4.0, 14.0, 3, 0.5, 91u));
  fil *= 0.25 + 0.95 * arcs;

  // broad radial bands with thin gaps, like Saturn's rings
  float bands = smoothstep(0.15, 0.75, vnoise(vec2(0.5, lnr * 11.0), 1.0, 55u));
  float gaps  = smoothstep(0.20, 0.45, vnoise(vec2(0.5, lnr * 38.0), 1.0, 56u));

  float dens = (0.06 + 1.15 * macro) * (0.10 + 1.55 * fil) * (0.45 + 0.9 * bands) * (0.40 + 0.75 * gaps);
  dens *= 1.0 + 1.6 * exp(-(r / ${f(c.rIn)} - 1.0) * 2.2);   // denser, hotter towards the ISCO

  // hot knots: brightness varies independently of density
  float heat = smoothstep(0.30, 0.78, fbm(aMacro + 0.37, lnr, 5.0, 7.0, 5, 0.6, 137u));
  heat = (0.25 + 1.75 * heat) * (0.55 + 0.9 * fil);
  return vec3(dens, heat, macro);
}

void main() {
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 uv = (gl_FragCoord.xy + (vec2(float(i), float(j)) - 0.5) * 0.5) / uTexSize;
      acc += pattern(uv.x, uv.y);
    }
  }
  gl_FragColor = vec4(acc * 0.25, 1.0);
}
`;

// ---------------------------------------------------------------------------
// 2. Ray marcher: null geodesics around a Schwarzschild black hole.
// ---------------------------------------------------------------------------
export const march = (c) => /* glsl */ `
${common}

uniform vec2 uResolution;
uniform int uGrid;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfY;
uniform float uRoll;
uniform sampler2D uDisk;

#define MAX_STEPS ${c.maxSteps}
#define RIN ${f(c.rIn)}
#define ROUT ${f(c.rOut)}
#define RMIN (RIN * 0.9)
#define RMAX (ROUT * 1.05)
#define LN_RMIN ${f(Math.log(c.rIn * 0.9))}
#define LN_RMAX ${f(Math.log(c.rOut * 1.05))}
#define HFRAC ${f(c.hazeThickness)}
#define HAZE_TAU ${f(c.hazeOpacity)}
#define HAZE_GAIN ${f(c.hazeGain)}
#define SHEET_TAU ${f(c.sheetOpacity)}
#define T_PEAK ${f(c.temperature)}
#define TEMP_EXP ${f(c.temperatureFalloff)}
#define BRIGHT ${f(c.brightness)}
#define BRIGHT_EXP ${f(c.brightnessFalloff)}
#define D_COLOR ${f(c.dopplerColor)}
#define D_BEAM ${f(c.dopplerBeam)}
#define RFAR 60.0
#define SAMPLE_CLAMP 80.0

// ---- colour ---------------------------------------------------------------
// Planckian locus (Kim et al.) -> linear sRGB with luminance 1.
vec3 blackbody(float T) {
  T = clamp(T, 1700.0, 24000.0);
  float t = 1000.0 / T;
  float x = T < 4000.0
    ? ((-0.2661239 * t - 0.2343589) * t + 0.8776956) * t + 0.179910
    : ((-3.0258469 * t + 2.1070379) * t + 0.2226347) * t + 0.240390;
  float y;
  if (T < 2222.0)      y = ((-1.1063814 * x - 1.34811020) * x + 2.18555832) * x - 0.20219683;
  else if (T < 4000.0) y = ((-0.9549476 * x - 1.37418593) * x + 2.09137015) * x - 0.16748867;
  else                 y = (( 3.0817580 * x - 5.87338670) * x + 3.75112997) * x - 0.37001483;
  float X = x / y;
  float Z = (1.0 - x - y) / y;
  vec3 rgb = vec3( 3.2404542 * X - 1.5371385 - 0.4985314 * Z,
                  -0.9692660 * X + 1.8760108 + 0.0415560 * Z,
                   0.0556434 * X - 0.2040259 + 1.0572252 * Z);
  return max(rgb, 0.0);
}

// ---- background: stars + galaxy -------------------------------------------
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 fr = p - i;
  vec3 u = fr * fr * (3.0 - 2.0 * fr);
  uvec3 q = uvec3(ivec3(i));
  float v000 = hash(q.x,       q.y,       q.z);
  float v100 = hash(q.x + 1u,  q.y,       q.z);
  float v010 = hash(q.x,       q.y + 1u,  q.z);
  float v110 = hash(q.x + 1u,  q.y + 1u,  q.z);
  float v001 = hash(q.x,       q.y,       q.z + 1u);
  float v101 = hash(q.x + 1u,  q.y,       q.z + 1u);
  float v011 = hash(q.x,       q.y + 1u,  q.z + 1u);
  float v111 = hash(q.x + 1u,  q.y + 1u,  q.z + 1u);
  return mix(mix(mix(v000, v100, u.x), mix(v010, v110, u.x), u.y),
             mix(mix(v001, v101, u.x), mix(v011, v111, u.x), u.y), u.z);
}
float fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise3(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s / 0.96875;
}

// Equal-angle cube-sphere grid, one star per cell, cell-local so lookups are O(1).
vec3 starLayer(vec3 d, float G, float prob, float sigma, float magPow, float gain, uint seed) {
  vec3 ad = abs(d);
  vec2 uv; uint face;
  if (ad.x >= ad.y && ad.x >= ad.z)  { uv = d.yz / ad.x; face = d.x > 0.0 ? 0u : 1u; }
  else if (ad.y >= ad.z)             { uv = d.xz / ad.y; face = d.y > 0.0 ? 2u : 3u; }
  else                               { uv = d.xy / ad.z; face = d.z > 0.0 ? 4u : 5u; }

  vec2 w = atan(uv) * (4.0 / PI);                 // equal-angle warp, [-1, 1]
  vec2 g = (w * 0.5 + 0.5) * G;
  vec2 ic = floor(g);
  uint cell = uint(ic.x) + uint(G) * uint(ic.y) + face * uint(G * G);

  if (hash(cell, seed) > prob) return vec3(0.0);
  vec2 sp = ic + 0.25 + 0.5 * vec2(hash(cell, seed + 1u), hash(cell, seed + 2u));
  vec2 su = tan(((sp / G) * 2.0 - 1.0) * (PI * 0.25));
  vec3 sd;
  if      (face == 0u) sd = vec3( 1.0, su.x, su.y);
  else if (face == 1u) sd = vec3(-1.0, su.x, su.y);
  else if (face == 2u) sd = vec3(su.x,  1.0, su.y);
  else if (face == 3u) sd = vec3(su.x, -1.0, su.y);
  else if (face == 4u) sd = vec3(su.x, su.y,  1.0);
  else                 sd = vec3(su.x, su.y, -1.0);
  sd = normalize(sd);

  float dist = length(d - sd);
  float mag = pow(hash(cell, seed + 3u), magPow);
  float temp = mix(3200.0, 14000.0, pow(hash(cell, seed + 4u), 1.6));
  vec3 tint = mix(vec3(1.0), blackbody(temp), 0.75);
  float q = dist / sigma;
  float profile = exp(-0.5 * q * q) + 0.02 / (1.0 + q * q * 0.25);
  return tint * (gain * mag * profile);
}

vec3 stars(vec3 d) {
  return starLayer(d,  64.0, 0.55, 0.00032, 7.0, 1.8, 101u)
       + starLayer(d, 190.0, 0.45, 0.00022, 6.0, 1.0, 202u)
       + starLayer(d, 520.0, 0.35, 0.00014, 4.0, 0.55, 303u);
}

vec3 galaxy(vec3 d) {
  // galactic plane: normal GN, centre direction GC
  const vec3 GN = vec3(-0.30, 0.78, 0.55);
  vec3 GC = normalize(cross(GN, vec3(0.0, 0.0, 1.0)));
  vec3 GY = cross(GN, GC);
  float lat = dot(d, GN);
  float lon = atan(dot(d, GY), dot(d, GC));

  float band = exp(-pow(abs(lat) / 0.17, 1.35));
  float bulge = exp(-lon * lon / 1.1) * exp(-pow(abs(lat) / 0.30, 1.5));
  float clouds = fbm3(d * 3.2 + 3.0);
  float fine = fbm3(d * 11.0 + 9.0);
  float dust = smoothstep(0.50, 0.72, fbm3(d * 6.0 + 40.0)) * exp(-pow(abs(lat) / 0.09, 2.0));

  float light = band * (0.30 + 1.1 * clouds) * (0.55 + 0.7 * fine) + 1.2 * bulge * (0.5 + clouds);
  light *= 1.0 - 0.88 * dust;
  vec3 tint = mix(vec3(0.50, 0.62, 1.00), vec3(1.00, 0.72, 0.48), clamp(bulge * 2.2, 0.0, 1.0));
  vec3 col = tint * light * ${f(c.galaxyBrightness)};

  // unresolved star dust riding the band
  float grains = pow(vnoise3(d * 900.0), 14.0) + pow(vnoise3(d * 1700.0 + 5.0), 18.0);
  col += tint * grains * band * ${f(c.galaxyBrightness * 24)};
  return col;
}

vec3 background(vec3 d) { return stars(d) + galaxy(d); }

// ---- geodesics --------------------------------------------------------------
// Photon in Schwarzschild: x'' = -1.5 * Rs * h^2 * x / r^5  (h = |x cross v| is conserved)
vec3 accel(vec3 x, float h2) {
  float r2 = dot(x, x);
  return -1.5 * h2 * x / (r2 * r2 * sqrt(r2));
}

void rk4(inout vec3 x, inout vec3 v, float h2, float dt) {
  vec3 k1x = v;                       vec3 k1v = accel(x, h2);
  vec3 k2x = v + 0.5 * dt * k1v;      vec3 k2v = accel(x + 0.5 * dt * k1x, h2);
  vec3 k3x = v + 0.5 * dt * k2v;      vec3 k3v = accel(x + 0.5 * dt * k2x, h2);
  vec3 k4x = v + dt * k3v;            vec3 k4v = accel(x + dt * k3x, h2);
  x += dt / 6.0 * (k1x + 2.0 * k2x + 2.0 * k3x + k4x);
  v += dt / 6.0 * (k1v + 2.0 * k2v + 2.0 * k3v + k4v);
}

// ---- accretion disk -----------------------------------------------------------
// The disk is an opaque-ish thin sheet in y = 0 (crossings are found exactly, so the surface
// stays crisp at grazing angles) wrapped in a faint, thicker haze for the soft glow.
float diskRadial(float rr) {
  float x = rr / RIN;
  return smoothstep(1.0, 1.05, x) * (1.0 - smoothstep(0.45, 1.0, (rr - RIN) / (ROUT - RIN)));
}

vec2 diskUV(vec3 p, float rr) {
  return vec2(atan(p.z, p.x) / TAU + 0.5, (log(rr) - LN_RMIN) / (LN_RMAX - LN_RMIN));
}

// Radiance of the disk at p as seen along v: temperature profile, Doppler beaming and
// gravitational redshift for a circular geodesic emitter.
vec3 diskRadiance(vec3 p, vec3 v, float rr, float heat) {
  float x = rr / RIN;
  float beta = sqrt(0.5 / (rr - 1.0));
  vec3 tang = vec3(p.z, 0.0, -p.x) / rr;
  vec3 toObs = -normalize(v);
  float gamma = inversesqrt(1.0 - beta * beta);
  float g = sqrt(1.0 - 1.0 / length(p)) / (gamma * (1.0 - beta * dot(tang, toObs)));
  float Tobs = T_PEAK * pow(x, -TEMP_EXP) * pow(g, D_COLOR);
  return blackbody(Tobs) * (BRIGHT * pow(x, -BRIGHT_EXP) * pow(g, D_BEAM) * heat);
}

void sheetSample(vec3 p, vec3 v, inout vec3 col, inout float trans) {
  float rr = length(p.xz);
  if (rr < RIN || rr > RMAX) return;
  vec2 tex = texture(uDisk, diskUV(p, rr)).rg;
  float a = 1.0 - exp(-SHEET_TAU * tex.r * diskRadial(rr));
  col += trans * diskRadiance(p, v, rr, tex.g) * a;
  trans *= 1.0 - a;
}

void hazeSample(vec3 p, vec3 v, float ds, inout vec3 col, inout float trans) {
  float rr = length(p.xz);
  if (rr < RIN || rr > RMAX) return;
  float H = HFRAC * rr;
  float zz = p.y / H;
  if (abs(zz) > 5.0) return;
  float macro = texture(uDisk, diskUV(p, rr)).b;   // smooth channel: no fine rings to smear along the view
  float dens = (0.2 + 0.8 * macro) * diskRadial(rr) * exp(-0.5 * zz * zz);
  if (dens < 1.0e-3) return;
  float a = 1.0 - exp(-HAZE_TAU * dens * ds / H);
  col += trans * diskRadiance(p, v, rr, 1.0) * (HAZE_GAIN * a);
  trans *= 1.0 - a;
}

vec3 trace(vec3 pos, vec3 vel) {
  vec3 L = cross(pos, vel);
  float h2 = dot(L, L);
  vec3 col = vec3(0.0);
  float trans = 1.0;
  bool escaped = false;

  for (int i = 0; i < MAX_STEPS; i++) {
    float r = length(pos);
    if (r < 1.0) break;                              // fell through the horizon
    float rv = dot(pos, vel);
    if (rv > 0.0 && r > RFAR) { escaped = true; break; }
    if (trans < 0.004) break;

    float dt = ${f(c.stepSize)} * r;
    if (rv > 0.0 && r > 1.3 * ROUT) dt = 0.3 * r;    // outbound and clear of the disk
    float rr = length(pos.xz);
    if (rr > RIN * 0.8 && rr < RMAX * 1.1) {         // refine inside the disk slab
      float ys = max(HFRAC * rr, 0.3 * abs(pos.y));
      dt = min(dt, ${f(c.slabStep)} * ys / max(abs(vel.y), 0.08));
    }
    dt = max(dt, 0.004);

    vec3 p0 = pos;
    rk4(pos, vel, h2, dt);
    vec3 dir = normalize(pos - p0);
    if (p0.y * pos.y < 0.0) {                         // crossed the disk plane
      float t = p0.y / (p0.y - pos.y);
      sheetSample(mix(p0, pos, t), dir, col, trans);
    }
    hazeSample(0.5 * (p0 + pos), dir, distance(p0, pos), col, trans);
  }
  if (escaped) col += trans * background(normalize(vel));
  return col;
}

void main() {
  vec3 sum = vec3(0.0);
  uint px = uint(gl_FragCoord.x), py = uint(gl_FragCoord.y);
  float n = float(uGrid);
  float cr = cos(uRoll), sr = sin(uRoll);

  for (int j = 0; j < uGrid; j++) {
    for (int i = 0; i < uGrid; i++) {
      uint k = uint(i + j * uGrid) * 2u;
      vec2 jit = vec2(hash(px, py, k + 1u), hash(px, py, k + 2u));
      vec2 pix = floor(gl_FragCoord.xy) + (vec2(float(i), float(j)) + jit) / n;
      vec2 ndc = (pix - 0.5 * uResolution) / (0.5 * uResolution.y);
      ndc = vec2(cr * ndc.x - sr * ndc.y, sr * ndc.x + cr * ndc.y);
      vec3 rd = normalize(uCamFwd + uTanHalfY * (ndc.x * uCamRight + ndc.y * uCamUp));
      sum += min(trace(uCamPos, rd), vec3(SAMPLE_CLAMP));
    }
  }
  gl_FragColor = vec4(sum / (n * n), 1.0);
}
`;

// ---------------------------------------------------------------------------
// 3. Post: bloom pyramid + composite.
// ---------------------------------------------------------------------------
export const bloomDown = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;   // 1 / source size
void main() {
  vec3 a = texture(tSrc, vUv + uTexel * vec2(-2.0, -2.0)).rgb;
  vec3 b = texture(tSrc, vUv + uTexel * vec2( 0.0, -2.0)).rgb;
  vec3 c = texture(tSrc, vUv + uTexel * vec2( 2.0, -2.0)).rgb;
  vec3 d = texture(tSrc, vUv + uTexel * vec2(-2.0,  0.0)).rgb;
  vec3 e = texture(tSrc, vUv).rgb;
  vec3 f = texture(tSrc, vUv + uTexel * vec2( 2.0,  0.0)).rgb;
  vec3 g = texture(tSrc, vUv + uTexel * vec2(-2.0,  2.0)).rgb;
  vec3 h = texture(tSrc, vUv + uTexel * vec2( 0.0,  2.0)).rgb;
  vec3 i = texture(tSrc, vUv + uTexel * vec2( 2.0,  2.0)).rgb;
  vec3 j = texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 k = texture(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  vec3 l = texture(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  vec3 m = texture(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  gl_FragColor = vec4(col, 1.0);
}
`;

// up = tent(low) + high * wHigh
export const bloomUp = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tLow;
uniform sampler2D tHigh;
uniform vec2 uTexel;   // 1 / low size
uniform float uWeight;   // how much of the wider (low) levels survives
void main() {
  vec3 a = texture(tLow, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  vec3 b = texture(tLow, vUv + uTexel * vec2( 0.0,  1.0)).rgb;
  vec3 c = texture(tLow, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  vec3 d = texture(tLow, vUv + uTexel * vec2(-1.0,  0.0)).rgb;
  vec3 e = texture(tLow, vUv).rgb;
  vec3 f = texture(tLow, vUv + uTexel * vec2( 1.0,  0.0)).rgb;
  vec3 g = texture(tLow, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 h = texture(tLow, vUv + uTexel * vec2( 0.0, -1.0)).rgb;
  vec3 i = texture(tLow, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  vec3 low = (e * 4.0 + (b + d + f + h) * 2.0 + (a + c + g + i)) / 16.0;
  gl_FragColor = vec4(low * uWeight + texture(tHigh, vUv).rgb, 1.0);
}
`;

export const composite = (c) => /* glsl */ `
${common}
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uResolution;

vec3 aces(vec3 color) {
  const mat3 inM  = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color = inM * color;
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  return clamp(outM * (a / b), 0.0, 1.0);
}

vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 hdr = texture(tScene, vUv).rgb + texture(tBloom, vUv).rgb * ${f(c.bloom)};
  hdr *= ${f(c.exposure)} / 0.6;

  vec3 col = aces(hdr);
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, ${f(c.saturation)});

  vec2 q = vUv - 0.5;
  q.x *= uResolution.x / uResolution.y;
  col *= 1.0 - ${f(c.vignette)} * smoothstep(0.25, 1.1, length(q));

  col = toSrgb(col);
  uvec2 px = uvec2(gl_FragCoord.xy);
  col += (hash(px.x, px.y, 7u) - 0.5) / 255.0;     // dither, hides banding in the dark gradients
  gl_FragColor = vec4(col, 1.0);
}
`;
