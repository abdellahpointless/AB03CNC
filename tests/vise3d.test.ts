import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildVise, loadVise, VISE_DEPTH } from '../src/lib/vise3d';
import { VISE_FRAME } from '../src/lib/viseModel';
import { jawsFrom } from '../src/lib/setups';

// The shop's vise in the 3D views: its maker's model, jaw plates exactly 45 mm over the bed, on the part's faces.
const extent = (obj: THREE.Object3D) => {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj);
  // three.js X/Y/Z -> machine X/-Z/Y
  return { x: [b.min.x, b.max.x], y: [-b.max.z, -b.min.z], z: [b.min.y, b.max.y] };
};
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.03);

describe("the shop's vise", () => {
  it('has jaw plates exactly 45 mm over its bed (the model has 44.5), the rest as its maker drew it', async () => {
    const v = await loadVise();
    expect(VISE_FRAME.modelJawHeight).toBe(44.5);
    expect(VISE_FRAME.jawHeight).toBe(45);
    for (const k of ['fixedPlate', 'movingPlate'] as const) {
      v.geos[k].computeBoundingBox();
      near(v.geos[k].boundingBox!.max.y, 45);
      near(v.geos[k].boundingBox!.min.y, 0);
    }
    // The jaw blocks under the plates' tops, the body's underside VISE_DEPTH under the bed.
    for (const k of ['fixedJaw', 'movingJaw'] as const) {
      v.geos[k].computeBoundingBox();
      expect(v.geos[k].boundingBox!.max.y).toBeLessThan(45);
    }
    v.geos.fixedBody.computeBoundingBox();
    near(v.geos.fixedBody.boundingBox!.min.y, -VISE_DEPTH);
    // Its jaws 125 mm long (the model's are 152).
    expect(VISE_FRAME.modelJawLength).toBe(152);
    expect(VISE_FRAME.jawLength).toBe(125);
  });

  it('closes its jaw plates on the part, the jaws from the stop’s face, the plates’ tops on the jaw-top line', async () => {
    const v = buildVise({ min: [0, -20], max: [60, 20] }, 10, 55, [jawsFrom(0)], null, []);
    await v.ready;
    const plate = (i: number) => v.group.getObjectsByProperty('material', v.jawMats[i])[0];
    const fixed = extent(plate(1));
    const moving = extent(plate(3));
    near(fixed.y[0], 20);
    near(moving.y[1], -20);
    near(fixed.z[1], 55);
    near(moving.z[1], 55);
    near(fixed.z[0], 10);
    near(fixed.x[0], 0);
    near(fixed.x[1], 125);
    // The stop before them, 8 mm thick, between the jaws.
    const stop = extent(v.group.children.find((c) => c instanceof THREE.Group && c !== v.moving && c.children.some((m) => m instanceof THREE.Mesh)) as THREE.Object3D);
    near(stop.x[0], -8);
    near(stop.x[1], 0);
  });

  it('follows another jaw height when one is set for the checks', async () => {
    const v = buildVise({ min: [0, -20], max: [60, 20] }, 0, 50, [jawsFrom(0)], null, []);
    await v.ready;
    near(extent(v.group.getObjectsByProperty('material', v.jawMats[1])[0]).z[1], 50);
  });
});
