import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * Lighting for the 3D toolpath view. Lights fixed in the scene leave the faces turned away from
 * them nearly black (the underside of a part, a wall facing away), so:
 *  - a soft studio surrounding lights every face from every side and gives the steel something
 *    to reflect,
 *  - a light carried by the camera lights whatever faces the viewer, from any angle,
 *  - a key light from above-front keeps the shapes readable (tops brighter than walls).
 * Returns the key light (it casts the shadows) and a clean-up function.
 */
export function addLights(scene: THREE.Scene, renderer: THREE.WebGLRenderer, camera: THREE.Camera): { key: THREE.DirectionalLight; dispose: () => void } {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.3;

  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a3346, 0.3));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(120, 260, 180);
  // Soft shadows: placed round the part on every fit (see Toolpath3D).
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.5;
  key.shadow.radius = 4;
  scene.add(key, key.target);

  // Head light: points where the camera looks.
  const head = new THREE.DirectionalLight(0xffffff, 0.6);
  head.position.set(0, 0, 0);
  head.target.position.set(0, 0, -1);
  camera.add(head, head.target);
  if (!camera.parent) scene.add(camera);

  return {
    key,
    dispose: () => {
      env.dispose();
      pmrem.dispose();
    },
  };
}
