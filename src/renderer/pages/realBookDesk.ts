/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/engine/desk.ts，Apache-2.0。已修改：文件改名并接入 spbf 的真实书籍场景。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
import * as THREE from 'three'
import { DESK_PALETTES, type RealBookDesk } from './realBookWebGLModel'

interface DeskSurface {
  dark: string
  light: string
  material: 'wood' | 'linen' | 'matte' | 'felt' | 'stone'
  roughness: number
}

/** 与参考站同一套桌面材质；spbf 的色板与参考站 settings.ts 的 DESK_SURFACES 完全相同。 */
const DESK_MATERIAL: Record<RealBookDesk, DeskSurface['material']> = {
  walnut: 'wood',
  linen: 'linen',
  graphite: 'matte',
  sage: 'felt',
  limestone: 'stone',
}

function deskSurface(id: RealBookDesk): DeskSurface {
  const palette = DESK_PALETTES[id] ?? DESK_PALETTES.walnut
  return { dark: palette.dark, light: palette.light, material: DESK_MATERIAL[id] ?? 'wood', roughness: palette.roughness }
}

/**
 * Quiet, seamless surfaces evaluated in world space, so their texture stays anchored
 * as the camera moves. Fine detail fades below pixel size to avoid shimmer when tilting.
 */
export interface DeskHandle {
  mesh: THREE.Mesh
  setSurface(id: RealBookDesk): void
}

export function createDesk(): DeskHandle {
  const geo = new THREE.PlaneGeometry(1, 1)
  const uniforms = {
    uDeskDark: { value: new THREE.Color() },
    uDeskLight: { value: new THREE.Color() },
    uDeskMaterial: { value: 0 },
    uDeskRoughness: { value: 1 },
  }
  const materials = { wood: 0, linen: 1, matte: 2, felt: 3, stone: 4 } as const
  const apply = (surface: DeskSurface) => {
    uniforms.uDeskDark.value.set(surface.dark)
    uniforms.uDeskLight.value.set(surface.light)
    uniforms.uDeskMaterial.value = materials[surface.material]
    uniforms.uDeskRoughness.value = surface.roughness
  }
  apply(deskSurface('walnut'))

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 })
  mat.customProgramCacheKey = () => 'desk-materials-v2'
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDeskDark = uniforms.uDeskDark
    shader.uniforms.uDeskLight = uniforms.uDeskLight
    shader.uniforms.uDeskMaterial = uniforms.uDeskMaterial
    shader.uniforms.uDeskRoughness = uniforms.uDeskRoughness
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDeskXY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDeskXY = (modelMatrix * vec4(position, 1.0)).xy;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec2 vDeskXY;
uniform vec3 uDeskDark;
uniform vec3 uDeskLight;
uniform float uDeskMaterial;
uniform float uDeskRoughness;
float dh2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)))*43758.5453); }
float dn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(dh2(i),dh2(i+vec2(1,0)),f.x), mix(dh2(i+vec2(0,1)),dh2(i+vec2(1,1)),f.x), f.y); }
float dfiltered(vec2 p){
  float footprint = max(length(dFdx(p)), length(dFdy(p)));
  return mix(dn(p), 0.5, smoothstep(0.35, 1.2, footprint));
}
float dfbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<4;i++){ s+=a*dfiltered(p); p=p*2.03+17.0; a*=0.5; } return s; }
`,
      )
      .replace(
        '#include <map_fragment>',
        `
vec2 wp = vDeskXY;
float tone = 0.5;
if (uDeskMaterial < 0.5) {
  // Smoked walnut: long, irregular fibers without plank borders or glossy bands.
  float drift = dfbm(wp * vec2(0.055, 0.28));
  float grain = dfbm(vec2(wp.x * 0.085, wp.y * 3.0 + drift * 1.8));
  float fibers = dfiltered(wp * vec2(0.3, 24.0) + vec2(0.0, grain * 0.3));
  tone = 0.3 + 0.3 * grain + 0.1 * fibers;
} else if (uDeskMaterial < 1.5) {
  // Linen: a barely visible warp and weft over warm, softly varied yarn.
  vec2 weave = wp * 14.0;
  vec2 fade = 1.0 - smoothstep(vec2(0.4), vec2(1.1), fwidth(weave));
  float threads = dot(sin(weave * 6.283185) * fade, vec2(0.5));
  tone += 0.045 * threads + 0.12 * (dfiltered(wp * 12.0) - 0.5)
    + 0.2 * (dfbm(wp * 0.12) - 0.5);
} else if (uDeskMaterial < 2.5) {
  // Graphite: powder-coated matte, with no directional grain.
  tone += 0.12 * (dfbm(wp * 0.17) - 0.5) + 0.35 * (dfiltered(wp * 18.0) - 0.5);
} else if (uDeskMaterial < 3.5) {
  // Sage felt: soft, intermingled fibers rather than a regular woven grid.
  tone += 0.2 * (dfbm(wp * 2.0) - 0.5)
    + 0.12 * (dfiltered(wp * vec2(22.0, 9.0)) - 0.5);
} else {
  // Honed limestone: diffuse mineral clouds, without decorative marble veins.
  tone += 0.65 * (dfbm(wp * 0.23) - 0.5) + 0.18 * (dfiltered(wp * 16.0) - 0.5);
}
diffuseColor.rgb = mix(uDeskDark, uDeskLight, clamp(tone, 0.0, 1.0));
`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = uDeskRoughness;`,
      )
  }
  const mesh = new THREE.Mesh(geo, mat)
  mesh.receiveShadow = true
  mesh.frustumCulled = false
  mesh.position.z = 0
  return {
    mesh,
    setSurface(id) {
      apply(deskSurface(id))
    },
  }
}
