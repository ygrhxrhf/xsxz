/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/engine/paperMaterial.ts，Apache-2.0。已修改：文件改名，接入 spbf 的真实书籍场景。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
import * as THREE from 'three'

export interface PaperUniforms {
  uFront: { value: THREE.Texture | null }
  uBack: { value: THREE.Texture | null }
  uLightDirV: { value: THREE.Vector3 }
  /**
   * 纸底色的线性空间乘数。上游的页面纹理画在白底上，纸色由 shader 给；
   * spbf 的页面纹理已经把纸色画进去了，所以这里默认白色，只保留纤维/边缘/中缝/曲率。
   */
  uPaperTint: { value: THREE.Color }
  /** 书脊侧压暗强度。spbf 的页面纹理已经画了中缝阴影，静态页/飞页都把这里设为 0。 */
  uGutter: { value: number }
  uShowThrough: { value: number }
  uTransmit: { value: number }
  uPhone: { value: number }
  uShRecv: { value: number }
  uShSelf: { value: number }
}

export const SH_COLS = 20
export const SH_SLOTS = 2
export const SH_ROWS = 3

/**
 * Soft analytic shadow of lifted leaves on the pages beneath them. Pages cannot receive from the shadow map
 * (a sheet resting on a sheet self-shadows with acne), so each flying leaf publishes a few polylines of its
 * section in a small float texture and every receiving page fragment marches the lamp ray against them.
 * Darkness fades with the occluder's distance along the ray and the penumbra widens with it.
 */
export const shadowRig = {
  uShTex: { value: null as THREE.DataTexture | null },
  uShN: { value: 0 },
  uShOpacity: { value: new Float32Array(SH_SLOTS) },
  uLampW: { value: new THREE.Vector3(-11, 13, 36) },
  uShCfg: { value: new THREE.Vector4(0.28, 4.2, 0.1, 0.3) },
}
shadowRig.uShTex.value = (() => {
  const t = new THREE.DataTexture(new Float32Array(SH_COLS * SH_SLOTS * SH_ROWS * 4), SH_COLS, SH_SLOTS * SH_ROWS, THREE.RGBAFormat, THREE.FloatType)
  t.minFilter = t.magFilter = THREE.NearestFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
})()

// 上游用 4×4 白画布做默认贴图；这里改成 DataTexture，模块在 jsdom（无 canvas 实现）
// 里被导入时也不会在顶层抛错。
const blank = (() => {
  const data = new Uint8Array(4 * 4 * 4).fill(255)
  const t = new THREE.DataTexture(data, 4, 4, THREE.RGBAFormat)
  t.colorSpace = THREE.SRGBColorSpace
  t.needsUpdate = true
  return t
})()
export const BLANK_TEXTURE = blank

/**
 * Paper leaf material. Both faces of a leaf use the same mesh; gl_FrontFacing selects which page
 * texture is shown. The *other* page's ink shows faintly through the sheet (mirrored automatically,
 * because it is sampled with the opposite u), and light arriving from behind is transmitted through
 * the paper so that a lifted leaf glows warmly against the lamp.
 */
export function createPaperMaterial(): { material: THREE.MeshStandardMaterial; uniforms: PaperUniforms } {
  const uniforms: PaperUniforms = {
    uFront: { value: BLANK_TEXTURE },
    uBack: { value: BLANK_TEXTURE },
    uLightDirV: { value: new THREE.Vector3(0, 0, 1) },
    uPaperTint: { value: new THREE.Color(0xffffff) },
    uGutter: { value: 0.14 },
    uShowThrough: { value: 0.16 },
    uTransmit: { value: 0.62 },
    uPhone: { value: 0 },
    uShRecv: { value: 0 },
    uShSelf: { value: -1 },
  }
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.88,
    metalness: 0,
    side: THREE.DoubleSide,
    shadowSide: THREE.DoubleSide,
  })
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, shadowRig)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aCurv;\nvarying float vCurv;\nvarying vec2 vPUv;\nvarying vec3 vWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCurv = aCurv;\nvPUv = uv;\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vCurv;
varying vec2 vPUv;
vec3 paperTint = vec3(1.0);
uniform sampler2D uFront;
uniform sampler2D uBack;
uniform vec3 uLightDirV;
uniform vec3 uPaperTint;
uniform float uGutter;
uniform float uShowThrough;
uniform float uTransmit;
uniform float uPhone;
varying vec3 vWP;
uniform sampler2D uShTex;
uniform float uShN;
uniform float uShOpacity[${SH_SLOTS}];
uniform float uShRecv;
uniform float uShSelf;
uniform vec3 uLampW;
uniform vec4 uShCfg;
const int SH_COLS = ${SH_COLS};
// strongest soft occlusion of the lamp ray (origin P, unit direction d, in the x-z plane) by one section polyline;
// .x darkness, .y distance along the ray to the occluder
// 与上游保持同一套坐标：书页在 x-y 平面，z 朝镜头；软影在 x-z 平面里算，y 充当「高度」。
vec2 shRow(vec2 P, vec2 d, vec2 n, int row){
  float best = 0.0, bt = 0.0;
  vec4 a = texelFetch(uShTex, ivec2(0, row), 0);
  for (int i = 1; i < SH_COLS; i++) {
    vec4 b = texelFetch(uShTex, ivec2(i, row), 0);
    vec2 qa = a.xy - P, qb = b.xy - P;
    a = b;
    // Only paper on the lamp-facing side of the receiving surface can occlude it.
    // Without clipping, endpoints below a landed sheet produce a stripe per section sample.
    float ha = dot(qa, n) - 0.001, hb = dot(qb, n) - 0.001;
    if (max(ha, hb) <= 0.0) continue;
    if (min(ha, hb) < 0.0) {
      vec2 hit = mix(qa, qb, ha / (ha - hb));
      if (ha < 0.0) qa = hit; else qb = hit;
    }
    float pa = dot(qa, d), ca = qa.x * d.y - qa.y * d.x;
    float pb = dot(qb, d), cb = qb.x * d.y - qb.y * d.x;
    float t, dp;
    if (ca * cb <= 0.0) { t = mix(pa, pb, ca / (ca - cb + 1e-6)); dp = 0.0; }
    else if (abs(ca) < abs(cb)) { t = pa; dp = abs(ca); }
    else { t = pb; dp = abs(cb); }
    if (t > 0.0) {
      float w = uShCfg.z + uShCfg.w * t;
      float s = (1.0 - smoothstep(0.0, w, dp)) * exp(-t / uShCfg.y);
      if (s > best) { best = s; bt = t; }
    }
  }
  return vec2(best, bt);
}
float leafShadow(vec3 P, vec3 N){
  vec3 Lv = uLampW - P;
  float l2 = max(length(Lv.xz), 1e-3);
  vec2 d = Lv.xz / l2;
  vec2 n = length(N.xz) > 1e-3 ? normalize(N.xz) : d;
  if (dot(n, d) < 0.0) n = -n;
  float dy = Lv.y / l2;
  float res = 0.0;
  int count = int(uShN + 0.5);
  for (int s = 0; s < ${SH_SLOTS}; s++) {
    if (s >= count || float(s) == uShSelf || uShOpacity[s] <= 0.0) continue;
    int r0 = s * ${SH_ROWS};
    float y0 = texelFetch(uShTex, ivec2(0, r0), 0).z;
    float y1 = texelFetch(uShTex, ivec2(0, r0 + 1), 0).z;
    float y2 = texelFetch(uShTex, ivec2(0, r0 + 2), 0).z;
    vec2 m = shRow(P.xz, d, n, r0 + 1);
    if (m.x <= 0.002) continue;
    float yh = P.y + dy * m.y;
    float ex = max(max(y0 - yh, yh - y2), 0.0);
    float fade = 1.0 - smoothstep(0.0, uShCfg.z * 6.0 + uShCfg.w * m.y * 1.4, ex);
    float sh;
    if (yh < y1) {
      float f = clamp((yh - y0) / (y1 - y0), 0.0, 1.0);
      sh = mix(shRow(P.xz, d, n, r0).x, m.x, f);
    } else {
      float f = clamp((yh - y1) / (y2 - y1), 0.0, 1.0);
      sh = mix(m.x, shRow(P.xz, d, n, r0 + 2).x, f);
    }
    res = max(res, sh * fade * uShOpacity[s]);
  }
  return res * uShCfg.x;
}
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
`,
      )
      .replace(
        '#include <map_fragment>',
        `
vec2 uvF = vec2(vPUv.x, vPUv.y);
vec3 ownInk = gl_FrontFacing ? texture2D(uFront, uvF).rgb : texture2D(uBack, vec2(1.0 - uvF.x, uvF.y)).rgb;
// The phone verso is the reverse of the same sheet, with faint mirrored front ink.
if (uPhone > 0.5 && !gl_FrontFacing) ownInk = mix(vec3(1.0), texture2D(uFront, uvF).rgb, 0.32);
vec3 otherInk = gl_FrontFacing ? texture2D(uBack, vec2(1.0 - uvF.x, uvF.y), 2.2).rgb : texture2D(uFront, uvF, 2.2).rgb;
vec2 fp = (gl_FrontFacing ? uvF : vec2(1.0 - uvF.x, uvF.y)) * vec2(640.0, 920.0);
float fiber = vn(fp * 0.55) * 0.5 + vn(fp * 2.1 + 7.0) * 0.3 + vn(vec2(fp.x*0.08, fp.y*1.6)) * 0.2;
vec3 paper = uPaperTint * (0.965 + 0.05 * fiber);
float edge = min(min(uvF.x, 1.0 - uvF.x), min(uvF.y, 1.0 - uvF.y));
paper *= mix(0.9, 1.0, smoothstep(0.0, 0.025, edge));
float gutter = exp(-uvF.x * 14.0);
paper *= 1.0 - uGutter * gutter * (1.0 - uPhone);
if (uPhone > 0.5 && !gl_FrontFacing) paper *= 0.86;
float conc = gl_FrontFacing ? vCurv : -vCurv;
paper *= 1.0 - 0.17 * (1.0 - exp(-max(conc, 0.0) * 1.6));
paperTint = paper;
diffuseColor.rgb = paper * ownInk * mix(vec3(1.0), otherInk, uShowThrough);
`,
      )
      .replace(
        '#include <opaque_fragment>',
        `
{
  float x = dot(normal, uLightDirV);
  vec3 warm = vec3(1.0, 0.91, 0.76);
  // paper scatters light: wrap the diffuse term past the terminator and let the lamp glow through the sheet
  float wrap = clamp((x + 0.62) / 1.62, 0.0, 1.0);
  wrap *= wrap;
  float extra = max(0.0, wrap - max(x, 0.0));
  float backLit = max(0.0, -x);
  float glow = uTransmit * (0.35 + 0.65 * smoothstep(0.0, 0.9, backLit));
  vec3 inkT = mix(vec3(1.0), diffuseColor.rgb / max(vec3(0.001), paperTint), 0.55);
  outgoingLight += paperTint * inkT * warm * (0.82 * extra + glow * backLit * 1.05 + 0.64 * (1.0 - max(x, 0.0)));
  if (uShRecv > 0.5 && uShN > 0.5) outgoingLight *= 1.0 - leafShadow(vWP, inverseTransformDirection(normal, viewMatrix));
}
#include <opaque_fragment>`,
      )
  }
  // 与上游的 program cache key 分开：我们改了纸色来源（uPaperTint）。
  material.customProgramCacheKey = () => 'paper-leaf-spbf-v1'
  return { material, uniforms }
}
