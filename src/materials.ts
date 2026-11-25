// Shaders for the two looks and the mixed-reality backdrop. All of them share
// the reveal lens (a screen-space circle), the soft head mask (edge feather)
// and three.js clipping planes.
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  FrontSide,
  MeshStandardMaterial,
  NormalBlending,
  type Plane,
  ShaderMaterial,
  Vector2,
} from "three";

/** Uniforms shared by every material (one object, so one update reaches all). */
export const shared = {
  uLensOn: { value: 0 },
  uLensCenter: { value: new Vector2() }, // drawing-buffer pixels (gl_FragCoord space)
  uLensRadius: { value: 100 },
  uFeather: { value: 0.17 },
  uBrightness: { value: 1 },
  uRealMe: { value: 0.35 },
  uTime: { value: 0 },
  uHeadCenter: { value: new Vector2() }, // head ellipse on screen, drawing-buffer pixels
  uHeadAxes: { value: new Vector2(1, 1) },
  uHeadDepth: { value: -60 }, // view-space z of the head centre (cm)
};

/** Clipping planes for the reveal modes; materials hold this same array. */
export const clipPlanes: Plane[] = [];

/**
 * X-ray styles:
 *  bone  - bright fresnel edges, dark translucent centres, blue->white gradient
 *  soft  - tinted translucent tissue (brain, muscles, eyes) with a faint emissive body
 *  rim   - silhouette glow only (head outline)
 *  hand  - slim translucent white-blue bones with a soft body glow (no head mask)
 */
export type XrayStyle = "bone" | "soft" | "rim" | "hand";
const STYLE_ID: Record<XrayStyle, number> = { bone: 0, soft: 1, rim: 2, hand: 3 };

const MASKS_GLSL = /* glsl */ `
  uniform float uLensOn;
  uniform vec2 uLensCenter;
  uniform float uLensRadius;
  uniform float uFeather;
  uniform vec2 uHeadCenter;
  uniform vec2 uHeadAxes;
  // 1 inside the lens, 0 outside, soft edge of width uFeather * radius.
  float lensMask() {
    if (uLensOn < 0.5) return 1.0;
    float d = distance(gl_FragCoord.xy, uLensCenter);
    return 1.0 - smoothstep(uLensRadius * (1.0 - uFeather), uLensRadius, d);
  }
  // Soft elliptical alpha mask around the head: the "edge feather".
  float headMask() {
    float d = length((gl_FragCoord.xy - uHeadCenter) / uHeadAxes);
    return 1.0 - smoothstep(1.0 - uFeather * 1.6, 1.0, d);
  }
`;

const VERTEX = /* glsl */ `
  #include <clipping_planes_pars_vertex>
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying float vViewZ;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPosition.xyz);
    vViewZ = mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`;

/** X-ray look: additive blending, fresnel rim light, depth cue and a faint scan shimmer. */
/** `body` is the soft style's emissive glow for surfaces facing the viewer. */
export function xrayMaterial(color: string, strength: number, style: XrayStyle, body = 0.1): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...shared, uColor: { value: new Color(color) }, uStrength: { value: strength }, uBody: { value: body } },
    defines: { STYLE: STYLE_ID[style] },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      #include <clipping_planes_pars_fragment>
      ${MASKS_GLSL}
      uniform vec3 uColor;
      uniform float uStrength;
      uniform float uBody;
      uniform float uBrightness;
      uniform float uTime;
      uniform float uHeadDepth;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      varying float vViewZ;
      void main() {
        #include <clipping_planes_fragment>
        float m = lensMask();
        #if STYLE != 3
          m *= headMask();
        #endif
        if (m <= 0.002) discard;
        float ndv = abs(dot(normalize(vNormalV), normalize(vViewDir)));
        float rim = pow(1.0 - ndv, 2.4);
        vec3 c;
        #if STYLE == 0
          // Bone: blue translucent centre -> white edge.
          vec3 tint = mix(uColor * vec3(0.35, 0.6, 1.0), vec3(1.0), smoothstep(0.15, 0.9, rim));
          c = tint * (0.045 + 1.15 * rim);
        #elif STYLE == 1
          c = uColor * (uBody + 0.9 * rim) + vec3(1.0) * pow(rim, 5.0) * 0.25;
        #elif STYLE == 2
          // Thin silhouette line: only surfaces almost exactly edge-on glow.
          c = uColor * pow(1.0 - ndv, 9.0) * 1.6;
        #else
          c = mix(vec3(0.55, 0.75, 1.0), vec3(1.0), rim) * (0.16 + 0.9 * rim);
        #endif
        #if STYLE != 3
          // Depth cue: the back of the head is dimmer than the front.
          c *= clamp(1.0 + (vViewZ - uHeadDepth) / 14.0, 0.35, 1.25);
        #endif
        // Faint scanline shimmer.
        c *= 0.94 + 0.06 * sin(gl_FragCoord.y * 1.3 - uTime * 4.0);
        gl_FragColor = vec4(c * uStrength * uBrightness * m, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: style === "rim" ? FrontSide : DoubleSide, // the outline traces the outer silhouette only
    clipping: true,
    clippingPlanes: clipPlanes,
  });
}

/**
 * Solid look: lit physically-based shading. Head anatomy becomes see-through
 * as "Real me showing through" rises and fades at the feathered head edge;
 * hands stay opaque.
 */
export function solidMaterial(color: string, isHand = false): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color, roughness: 0.55, metalness: 0, side: DoubleSide, clippingPlanes: clipPlanes, transparent: !isHand });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    const fade = isHand ? "" : "gl_FragColor.a *= (1.0 - 0.85 * uRealMe) * headMask();";
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nuniform float uRealMe;\n${MASKS_GLSL}`)
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\n if (lensMask() < 0.5) discard;")
      .replace("#include <dithering_fragment>", `#include <dithering_fragment>\n${fade}`);
  };
  // three.js caches programs by onBeforeCompile's source, which is the same for both variants.
  m.customProgramCacheKey = () => (isHand ? "solid-hand" : "solid-head");
  return m;
}

/**
 * Mixed-reality backdrop drawn on the head shell, before the anatomy: a dark
 * X-ray "film" whose opacity is (1 - realMe), so the camera shows through by
 * that amount; it fades out at the silhouette and the feathered head edge.
 */
export function backdropMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...shared },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      #include <clipping_planes_pars_fragment>
      ${MASKS_GLSL}
      uniform float uRealMe;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      void main() {
        #include <clipping_planes_fragment>
        float ndv = max(dot(normalize(vNormalV), normalize(vViewDir)), 0.0);
        float edge = smoothstep(0.0, max(uFeather * 2.0, 0.001), ndv);
        float a = (1.0 - uRealMe) * edge * lensMask() * headMask();
        gl_FragColor = vec4(0.01, 0.03, 0.07, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
    side: FrontSide,
    clipping: true,
    clippingPlanes: clipPlanes,
  });
}
