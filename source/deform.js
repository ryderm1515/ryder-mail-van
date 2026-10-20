import * as T from "three";

// GPU free-form deformation driven by the soft-body lattice.
//
// Node displacements and accumulated crush are packed into a small 3D texture.
// Every vehicle material gets a vertex-shader patch that maps the vertex into
// body space, samples the lattice (hardware trilinear filtering), adds crumple
// wrinkles scaled by local crush, and rebuilds the normal from the field's
// Jacobian so folds read clearly in the toon lighting. Detached debris bakes
// the same field on the CPU (bake()) so parts keep their damage when they fly.

const NOISE = 32;

function makeNoise() {
  const data = new Uint8Array(NOISE * NOISE * NOISE * 4);
  let s = 1234567;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(rnd() * 256);
  return data;
}

const GLSL = /* glsl */ `
uniform highp sampler3D uDmgTex;
uniform highp sampler3D uDmgNoise;
uniform vec3 uDmgMin;
uniform vec3 uDmgSize;
uniform vec3 uDmgRes;
uniform mat4 uBodyInv;
uniform float uDmgOn;
attribute float aPart;
uniform highp sampler2D uExplodeTex;
uniform float uExplode;
// Exploded view: each named object has a body-space offset and a start delay,
// so parts separate in waves (shell first, then cab, running gear, fasteners).
vec3 dmgExplode(){
  if(uExplode<=0.||aPart<.5) return vec3(0.);
  int id=int(aPart+.5);
  int w=textureSize(uExplodeTex,0).x;
  vec4 e=texelFetch(uExplodeTex,ivec2(id%w,id/w),0);
  float k=clamp((uExplode-e.w)/.45,0.,1.);
  k=k*k*k*(k*(k*6.-15.)+10.);
  return e.xyz*k;
}
vec4 dmgLattice(vec3 b){
  vec3 t=clamp((b-uDmgMin)/uDmgSize,0.,1.);
  return texture(uDmgTex,(t*(uDmgRes-1.)+.5)/uDmgRes);
}
vec3 dmgNoise(vec3 p){ return texture(uDmgNoise,p*${(1 / NOISE).toFixed(6)}).xyz*2.-1.; }
vec3 dmgField(vec3 b){
  vec4 s=dmgLattice(b);
  float c=min(s.w,1.4);
  return s.xyz+c*(dmgNoise(b*3.3)*.05+dmgNoise(b*9.1+7.)*.018);
}
`;

const NORMAL_PATCH = /* glsl */ `
vec3 dmgLocal=vec3(0.);
if(uExplode>0.){
  vec3 ex=dmgExplode();
  if(dot(ex,ex)>0.) dmgLocal+=inverse(mat3(uBodyInv*modelMatrix))*ex;
}
if(uDmgOn>.5){
  mat4 dmgM=uBodyInv*modelMatrix;
  vec3 dmgB=(dmgM*vec4(position,1.)).xyz;
  vec4 dmgS=dmgLattice(dmgB);
  if(dot(dmgS.xyz,dmgS.xyz)+dmgS.w>1e-6){
    vec3 d0=dmgField(dmgB);
    const float e=.03;
    mat3 J=mat3(
      (dmgField(dmgB+vec3(e,0.,0.))-d0)/e,
      (dmgField(dmgB+vec3(0.,e,0.))-d0)/e,
      (dmgField(dmgB+vec3(0.,0.,e))-d0)/e);
    mat3 dmgL=mat3(dmgM);
    mat3 dmgLi=inverse(dmgL);
    vec3 nb=normalize(dmgL*objectNormal);
    nb=normalize(nb-transpose(J)*nb);
    objectNormal=dmgLi*nb;
    dmgLocal+=dmgLi*d0;
  }
}
`;

const EXPLODE_ONLY = /* glsl */ `
#include <begin_vertex>
if(uExplode>0.) transformed+=inverse(mat3(uBodyInv*modelMatrix))*dmgExplode();
`;

const DEPTH_PATCH = /* glsl */ `
#include <begin_vertex>
if(uExplode>0.) transformed+=inverse(mat3(uBodyInv*modelMatrix))*dmgExplode();
if(uDmgOn>.5){
  mat4 dmgM=uBodyInv*modelMatrix;
  vec3 dmgB=(dmgM*vec4(position,1.)).xyz;
  transformed+=inverse(mat3(dmgM))*dmgField(dmgB);
}
`;

export class DamageField {
  constructor(soft) {
    this.soft = soft;
    const [nx, ny, nz] = soft.res;
    this.data = new Uint16Array(nx * ny * nz * 4);
    this.tex = new T.Data3DTexture(this.data, nx, ny, nz);
    this.tex.format = T.RGBAFormat;
    this.tex.type = T.HalfFloatType;
    this.tex.minFilter = this.tex.magFilter = T.LinearFilter;
    this.tex.wrapS = this.tex.wrapT = this.tex.wrapR = T.ClampToEdgeWrapping;
    this.tex.unpackAlignment = 1;
    this.tex.needsUpdate = true;
    this.noiseData = makeNoise();
    this.noise = new T.Data3DTexture(this.noiseData, NOISE, NOISE, NOISE);
    this.noise.format = T.RGBAFormat;
    this.noise.type = T.UnsignedByteType;
    this.noise.minFilter = this.noise.magFilter = T.LinearFilter;
    this.noise.wrapS = this.noise.wrapT = this.noise.wrapR = T.RepeatWrapping;
    this.noise.unpackAlignment = 1;
    this.noise.needsUpdate = true;
    this.uniforms = {
      uDmgTex: { value: this.tex },
      uDmgNoise: { value: this.noise },
      uDmgMin: { value: soft.min.clone() },
      uDmgSize: { value: soft.size.clone() },
      uDmgRes: { value: new T.Vector3(nx, ny, nz) },
      uBodyInv: { value: new T.Matrix4() },
      uDmgOn: { value: 0 },
      uExplode: { value: 0 },
      uExplodeTex: { value: null },
    };
    // Placeholder until the exploded-view layout is built (part 0 = no motion).
    this.setExplodeData(new Float32Array(4), 1);
    this.version = -1;
    this.depth = this.patchDepth(new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking }));
    this.depthRigid = this.patchExplode(new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking }));
    this._v = new T.Vector4();
  }
  patch(material) {
    const prev = material.onBeforeCompile,
      prevKey = material.customProgramCacheKey?.call(material) ?? "";
    material.onBeforeCompile = (s, r) => {
      prev?.call(material, s, r);
      Object.assign(s.uniforms, this.uniforms);
      s.vertexShader = s.vertexShader
        .replace("#include <common>", "#include <common>\n" + GLSL)
        .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\n" + NORMAL_PATCH)
        .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed+=dmgLocal;");
    };
    material.customProgramCacheKey = () => prevKey + "|softbody-v2";
    material.userData.deforms = true;
    return material;
  }
  // Rigid running gear: no crumple, but it still takes part in the exploded view.
  patchExplode(material) {
    const prev = material.onBeforeCompile,
      prevKey = material.customProgramCacheKey?.call(material) ?? "";
    material.onBeforeCompile = (s, r) => {
      prev?.call(material, s, r);
      Object.assign(s.uniforms, this.uniforms);
      s.vertexShader = s.vertexShader
        .replace("#include <common>", "#include <common>\n" + GLSL)
        .replace("#include <begin_vertex>", EXPLODE_ONLY);
    };
    material.customProgramCacheKey = () => prevKey + "|explode-v1";
    material.userData.explodes = true;
    return material;
  }
  setExplodeData(data, count) {
    const w = 256,
      h = Math.max(1, Math.ceil(count / w)),
      full = new Float32Array(w * h * 4);
    full.set(data.subarray(0, Math.min(data.length, full.length)));
    this.explodeData = data;
    this.uniforms.uExplodeTex.value?.dispose();
    const tex = new T.DataTexture(full, w, h, T.RGBAFormat, T.FloatType);
    tex.minFilter = tex.magFilter = T.NearestFilter;
    tex.needsUpdate = true;
    this.uniforms.uExplodeTex.value = tex;
  }
  patchDepth(material) {
    material.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, this.uniforms);
      s.vertexShader = s.vertexShader
        .replace("#include <common>", "#include <common>\n" + GLSL)
        .replace("#include <begin_vertex>", DEPTH_PATCH);
    };
    material.customProgramCacheKey = () => "softbody-depth-v2";
    return material;
  }
  // Called once per frame after the vehicle's interpolated pose is applied.
  update(vehicle) {
    this.uniforms.uBodyInv.value.copy(vehicle.matrixWorld).invert();
    const s = this.soft;
    if (s.version === this.version) return;
    this.version = s.version;
    const d = this.data,
      x = s.x,
      r = s.rest,
      h = T.DataUtils.toHalfFloat;
    let any = false;
    for (let i = 0; i < s.count; i++) {
      const o = i * 3,
        dx = x[o] - r[o],
        dy = x[o + 1] - r[o + 1],
        dz = x[o + 2] - r[o + 2],
        c = s.crush[i];
      d[i * 4] = h(dx);
      d[i * 4 + 1] = h(dy);
      d[i * 4 + 2] = h(dz);
      d[i * 4 + 3] = h(c);
      if (!any && (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-4 || c > 1e-4)) any = true;
    }
    this.tex.needsUpdate = true;
    this.uniforms.uDmgOn.value = any ? 1 : 0;
  }
  // CPU twin of the GLSL noise (trilinear, repeating) for baking debris.
  noiseAt(px, py, pz, out) {
    const N = NOISE,
      fx = px - 0.5,
      fy = py - 0.5,
      fz = pz - 0.5,
      x0 = Math.floor(fx),
      y0 = Math.floor(fy),
      z0 = Math.floor(fz),
      tx = fx - x0,
      ty = fy - y0,
      tz = fz - z0,
      m = (v) => ((v % N) + N) % N;
    out.set(0, 0, 0);
    for (let c = 0; c < 8; c++) {
      const di = c & 1,
        dj = (c >> 1) & 1,
        dk = (c >> 2) & 1,
        w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz),
        o = (m(x0 + di) + N * (m(y0 + dj) + N * m(z0 + dk))) * 4;
      out.x += (this.noiseData[o] / 255) * w;
      out.y += (this.noiseData[o + 1] / 255) * w;
      out.z += (this.noiseData[o + 2] / 255) * w;
    }
    return out.multiplyScalar(2).subScalar(1);
  }
  field(b, out) {
    const s = this.soft.sample(b, this._v),
      c = Math.min(s.w, 1.4),
      n = this._n || (this._n = new T.Vector3());
    out.set(s.x, s.y, s.z);
    if (c > 0) {
      out.addScaledVector(this.noiseAt(b.x * 3.3, b.y * 3.3, b.z * 3.3, n), c * 0.05);
      out.addScaledVector(this.noiseAt(b.x * 9.1 + 7, b.y * 9.1 + 7, b.z * 9.1 + 7, n), c * 0.018);
    }
    return out;
  }
  // Bake the current deformation into a mesh geometry (positions and normals).
  // meshToBody: matrix taking the geometry's local space into body space.
  bake(geometry, meshToBody) {
    if (!this.uniforms.uDmgOn.value) return;
    const pos = geometry.attributes.position,
      nor = geometry.attributes.normal,
      L = new T.Matrix3().setFromMatrix4(meshToBody),
      Li = L.clone().invert(),
      p = new T.Vector3(),
      d0 = new T.Vector3(),
      g = new T.Vector3(),
      n = new T.Vector3(),
      J = [new T.Vector3(), new T.Vector3(), new T.Vector3()],
      e = 0.03;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(meshToBody);
      this.field(p, d0);
      if (d0.lengthSq() < 1e-10) continue;
      for (let a = 0; a < 3; a++) {
        p.setComponent(a, p.getComponent(a) + e);
        this.field(p, g);
        J[a].copy(g).sub(d0).multiplyScalar(1 / e);
        p.setComponent(a, p.getComponent(a) - e);
      }
      if (nor) {
        n.fromBufferAttribute(nor, i).applyMatrix3(L).normalize();
        const jt = new T.Vector3(J[0].dot(n), J[1].dot(n), J[2].dot(n));
        n.sub(jt).normalize().applyMatrix3(Li).normalize();
        nor.setXYZ(i, n.x, n.y, n.z);
      }
      d0.applyMatrix3(Li);
      pos.setXYZ(i, pos.getX(i) + d0.x, pos.getY(i) + d0.y, pos.getZ(i) + d0.z);
    }
    pos.needsUpdate = true;
    if (nor) nor.needsUpdate = true;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
}
