// A scorching map's air, on High only: it rides in the OutputPass that tone maps the frame.
// - Heat shimmer (the palette's `heat`, 0-1): hot air in a layer over the ground, thinning by e every
//   HEAT_HEIGHT m up, bends each view ray by as much air as it crosses, so long rays skimming the
//   sand shimmer and near things, or looking up or down, hardly do. Its ripples are fixed to
//   directions in the world (they don't swim as you turn), smooth noise rather than waves, rising.
// - Mirage (`mirage`, 0-1): far sand seen just under the horizon shows what's just over it, upside
//   down and squashed (the sky, the tops of far rocks under their bases), in patches that drift.
// Purely visual: shots go where they always did. The cockpit, drawn after the pass, isn't touched.
import * as THREE from 'three';

const HEAT_HEIGHT = 3; // m
const HEAT_AIR = [15, 70]; // m of air at ground level along a ray: shimmer fades in over these
const AMPLITUDE = [0.0022, 0.0045]; // across and up, in screen sizes, at full strength
const MIRAGE_ANGLE = 3.5; // degrees under the horizon it reaches
const MIRAGE_NEAR = [60, 110]; // m: it fades in over these

/**
 * Patches `output` (an OutputPass) for both. Its render target needs a depth texture. Returns
 * `{ setMap(map), tick(seconds, camera) }`.
 */
export function heatShimmer(output) {
  const heat = new THREE.Vector4(); // shimmer strength, time (s), camera near, camera far
  const view = new THREE.Vector4(); // tan(fov / 2), aspect, mirage strength
  const eye = new THREE.Vector3(), rot = new THREE.Matrix3(), inv = new THREE.Matrix3(); // the camera's position; view to world and back
  Object.assign(output.uniforms, { tDepth: { value: null }, heat: { value: heat }, heatView: { value: view }, heatEye: { value: eye }, heatRot: { value: rot }, heatRotInv: { value: inv } });
  const f = (v) => v.toFixed(4);
  output.material.fragmentShader = output.material.fragmentShader
    .replace(
      'uniform sampler2D tDiffuse;',
      /* glsl */ `uniform sampler2D tDiffuse, tDepth;
		uniform vec4 heat, heatView;
		uniform vec3 heatEye;
		uniform mat3 heatRot, heatRotInv;
		// Smooth 3D value noise in -1..1 (Perlin-style: interpolated lattice values, eased).
		float hash3( vec3 p ) { return fract( sin( dot( p, vec3( 127.1, 311.7, 74.7 ) ) ) * 43758.5453 ); }
		float noise3( vec3 p ) {
			vec3 i = floor( p ), f = fract( p ), u = f * f * ( 3.0 - 2.0 * f );
			vec2 e = vec2( 1.0, 0.0 );
			float x00 = mix( hash3( i ), hash3( i + e.xyy ), u.x ), x10 = mix( hash3( i + e.yxy ), hash3( i + e.xxy ), u.x );
			float x01 = mix( hash3( i + e.yyx ), hash3( i + e.xyx ), u.x ), x11 = mix( hash3( i + e.yxx ), hash3( i + e.xxx ), u.x );
			return mix( mix( x00, x10, u.y ), mix( x01, x11, u.y ), u.z ) * 2.0 - 1.0;
		}`,
    )
    .replace(
      'gl_FragColor = texture2D( tDiffuse, vUv );',
      /* glsl */ `vec2 uv = vUv;
			vec3 mirage = vec3( 0.0 );
			float pool = 0.0;
			if ( heat.x > 0.0 || heatView.z > 0.0 ) {
				// This pixel's ray: its world direction, and how far it goes (from the depth buffer).
				vec3 ray = vec3( ( vUv * 2.0 - 1.0 ) * vec2( heatView.y, 1.0 ) * heatView.x, -1.0 );
				float d = texture2D( tDepth, vUv ).x, len = heat.z * heat.w / ( heat.w - d * ( heat.w - heat.z ) ) * length( ray );
				vec3 dir = heatRot * normalize( ray );
				// Hot air along it, integrated through the layer (in meters of air at ground level).
				float H = ${f(HEAT_HEIGHT)}, base = exp( -max( heatEye.y, 0.0 ) / H );
				float air = abs( dir.y ) > 1e-4 ? base * H / dir.y * ( 1.0 - exp( -len * dir.y / H ) ) : base * len;
				float k = heat.x * smoothstep( ${f(HEAT_AIR[0])}, ${f(HEAT_AIR[1])}, air ), t = heat.y;
				// The noise (the costly part) only where it shows: most of the screen is near, or looks
				// up or down, and skips it.
				if ( k > 0.001 ) {
					// Noise over the view direction, cells wider than tall (heat lies in layers), rising; a
					// finer octave drifting its own way keeps it boiling.
					vec3 q = vec3( dir.x * 32.0, dir.y * 80.0 - t * 2.0, dir.z * 32.0 );
					vec2 wave = vec2( noise3( q ) + 0.5 * noise3( q * 2.03 + vec3( 0.0, -t * 1.5, 5.2 ) ),
						noise3( q + vec3( 19.1, 0.0, 7.3 ) ) + 0.5 * noise3( q * 1.97 + vec3( 3.7, -t * 1.8, 0.0 ) ) );
					uv += wave * vec2( ${f(AMPLITUDE[0])}, ${f(AMPLITUDE[1])} ) * k;
				}
				// Mirrored over the horizon, squashed, and sampled with the same shimmer; in patches over
				// the sand where the ray lands.
				float under = -dir.y;
				pool = heatView.z * step( 0.0, under ) * ( 1.0 - smoothstep( 0.0, ${f(Math.sin((MIRAGE_ANGLE * Math.PI) / 180))}, under ) ) * smoothstep( ${f(MIRAGE_NEAR[0])}, ${f(MIRAGE_NEAR[1])}, len );
				if ( pool > 0.001 ) {
					vec3 g = heatEye + dir * len, v = heatRotInv * normalize( vec3( dir.x, under * 0.8 + 0.002, dir.z ) );
					vec2 at = ( v.xy / -v.z ) / ( vec2( heatView.y, 1.0 ) * heatView.x ) * 0.5 + 0.5 + ( uv - vUv );
					float patches = 0.5 + 0.5 * ( noise3( vec3( g.x * 0.035, t * 0.08, g.z * 0.035 ) ) + 0.5 * noise3( vec3( g.x * 0.09, -t * 0.12, g.z * 0.09 ) ) );
					pool *= smoothstep( 0.3, 0.7, patches ) * step( 0.0, at.y ) * step( at.y, 1.0 );
					mirage = texture2D( tDiffuse, at ).rgb;
				}
			}
			gl_FragColor = texture2D( tDiffuse, uv );
			gl_FragColor.rgb = mix( gl_FragColor.rgb, mirage, pool );`,
    );
  const render = output.render.bind(output);
  output.render = (renderer, writeBuffer, readBuffer, ...rest) => {
    output.uniforms.tDepth.value = readBuffer.depthTexture;
    render(renderer, writeBuffer, readBuffer, ...rest);
  };
  return {
    setMap(map) {
      heat.x = map.palette?.heat ?? 0;
      view.z = map.palette?.mirage ?? 0;
    },
    tick(seconds, camera) {
      camera.updateMatrixWorld();
      heat.set(heat.x, seconds % 1000, camera.near, camera.far);
      view.set(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), camera.aspect, view.z, 0);
      eye.setFromMatrixPosition(camera.matrixWorld);
      rot.setFromMatrix4(camera.matrixWorld);
      inv.copy(rot).transpose(); // the shader's GLSL 1 has no transpose()
    },
  };
}
