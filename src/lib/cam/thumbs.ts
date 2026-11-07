import * as THREE from 'three';
import type { Mat3 } from '../orient';

/**
 * Small pictures of a part lying each way in the vise (CAM AI's orientation step): one offscreen
 * renderer, the part turned by each R (model -> vise frame: X along the jaws, Y between them, Z up),
 * seen from the front right above. Images (data URLs), or [] where WebGL is not there.
 */
export function renderViews(tris: Float32Array, turns: Mat3[], px = 168, dark = false): string[] {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
  } catch {
    return [];
  }
  renderer.setPixelRatio(2);
  renderer.setSize(px, px, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, dark ? 0x30384a : 0x8a94a6, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(1, -2, 3);
  scene.add(key);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(tris, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  const centre = geo.boundingBox!.getCenter(new THREE.Vector3());
  geo.translate(-centre.x, -centre.y, -centre.z);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: dark ? 0xc9d3e0 : 0xb7c2d2, roughness: 0.55, metalness: 0.1, flatShading: true }));
  scene.add(mesh);
  geo.computeBoundingSphere();
  const radius = geo.boundingSphere?.radius ?? 50;
  const cam = new THREE.OrthographicCamera(-radius, radius, radius, -radius, -radius * 10, radius * 10);
  cam.up.set(0, 0, 1);
  cam.position.set(radius * 1.2, -radius * 2, radius * 1.4);
  cam.lookAt(0, 0, 0);
  const out: string[] = [];
  for (const R of turns) {
    mesh.matrixAutoUpdate = false;
    mesh.matrix.set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1);
    renderer.render(scene, cam);
    out.push(renderer.domElement.toDataURL('image/png'));
  }
  geo.dispose();
  (mesh.material as THREE.Material).dispose();
  renderer.dispose();
  return out;
}
