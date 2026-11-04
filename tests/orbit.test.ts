import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Orbit } from '../src/lib/orbit';

describe('orbit', () => {
  it('turns round the middle of the part, even after the view target moved to an edge', () => {
    const cam = new THREE.PerspectiveCamera(40, 1.6, 0.1, 1000);
    // Only what Orbit touches of an element.
    const el = { clientHeight: 600, addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement;
    const o = new Orbit(cam, el, () => {});
    const middle = new THREE.Vector3(10, 0, 0);
    o.center = () => middle;
    // As after zooming toward a point on the part's edge: the camera looks at the edge.
    o.target.set(40, 0, 0);
    cam.position.set(40, 30, 80);
    o.update();
    const before = cam.position.distanceTo(middle);
    o.rotate(300, 120);
    // The camera stays as far from the middle of the part as it was: it went round it.
    expect(cam.position.distanceTo(middle)).toBeCloseTo(before, 5);
  });
});
