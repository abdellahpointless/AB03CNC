import * as THREE from 'three';

/**
 * Turning the 3D view the way CAD software does:
 *  - drag: turns around the point under the pointer: left/right around the vertical, up/down over
 *    the top and on underneath (the part can be seen from below), never rolling sideways;
 *  - right-drag, middle-drag or Shift+drag: moves the view;
 *  - wheel: zooms toward the pointer; double-click: turns around the point clicked from then on.
 * Nothing keeps spinning once let go.
 */
export class Orbit {
  /** The point the camera looks at. */
  readonly target = new THREE.Vector3();
  /** What a drag, zoom or double-click aims at (the part, the vise): picked under the pointer. */
  pickables: () => (THREE.Object3D | null)[] = () => [];
  private drag: { id: number; x: number; y: number; pan: boolean; pivot: THREE.Vector3 } | null = null;
  private fly: { t0: number; ms: number; from: { pos: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 }; to: { pos: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 } } | null = null;
  private ray = new THREE.Raycaster();
  private off: () => void;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private el: HTMLElement,
    private onChange: () => void,
  ) {
    const down = (e: PointerEvent) => {
      if (this.drag) return;
      const pan = e.button === 1 || e.button === 2 || e.shiftKey;
      if (e.button !== 0 && !pan) return;
      this.fly = null;
      el.setPointerCapture(e.pointerId);
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pan, pivot: pan ? this.target.clone() : this.pick(e) ?? this.target.clone() };
    };
    const move = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      if (d.pan) this.pan(dx, dy);
      else this.rotate(dx, dy, d.pivot);
    };
    const up = (e: PointerEvent) => {
      if (this.drag?.id === e.pointerId) this.drag = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.fly = null;
      this.zoom(Math.exp((e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.0015), e);
    };
    const dbl = (e: MouseEvent) => {
      const p = this.pick(e);
      if (!p) return;
      const shift = p.clone().sub(this.target);
      this.flyTo(this.camera.position.clone().add(shift), p, this.camera.up.clone(), 450);
    };
    const menu = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('dblclick', dbl);
    el.addEventListener('contextmenu', menu);
    this.off = () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('dblclick', dbl);
      el.removeEventListener('contextmenu', menu);
    };
  }

  /** The first pickable surface under the pointer (scene coordinates), if any. */
  private pick(e: { clientX: number; clientY: number }): THREE.Vector3 | null {
    const r = this.el.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    const objs = this.pickables().filter((o): o is THREE.Object3D => !!o && o.visible);
    const hit = this.ray.intersectObjects(objs, true).find((h) => (h.object as THREE.Mesh).isMesh && h.object.visible);
    return hit ? hit.point.clone() : null;
  }

  /** Turns the camera and what it looks at around a point, by a drag of dx, dy pixels. */
  rotate(dx: number, dy: number, pivot = this.target) {
    const k = (Math.PI * 1.2) / Math.max(200, this.el.clientHeight);
    const cam = this.camera;
    const { right } = this.frame();
    // Upside down (seen from below, over the top): left/right turns the other way, so the part
    // still follows the pointer.
    const yaw = -dx * k * (cam.up.y < 0 ? -1 : 1);
    const pitch = -dy * k;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw).multiply(new THREE.Quaternion().setFromAxisAngle(right, pitch));
    cam.position.sub(pivot).applyQuaternion(q).add(pivot);
    this.target.sub(pivot).applyQuaternion(q).add(pivot);
    cam.up.applyQuaternion(q).normalize();
    this.update();
  }

  private pan(dx: number, dy: number) {
    const cam = this.camera;
    const dist = cam.position.distanceTo(this.target);
    const s = (2 * dist * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(1, this.el.clientHeight);
    const { right } = this.frame();
    const shift = right.multiplyScalar(-dx * s).addScaledVector(cam.up, dy * s);
    cam.position.add(shift);
    this.target.add(shift);
    this.update();
  }

  /** The view's directions; the camera's up made square to the view (it can lean after a fit). */
  private frame() {
    const cam = this.camera;
    const fwd = this.target.clone().sub(cam.position).normalize();
    const right = fwd.clone().cross(cam.up).normalize();
    cam.up.copy(right.clone().cross(fwd));
    return { fwd, right };
  }

  /** f < 1 comes closer, toward the point under the pointer (or the middle of the view). */
  private zoom(f: number, e: { clientX: number; clientY: number }) {
    const cam = this.camera;
    const r = this.el.getBoundingClientRect();
    let p = this.pick(e);
    if (!p) {
      this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), cam);
      p = this.ray.ray.at(cam.position.distanceTo(this.target), new THREE.Vector3());
    }
    const d = cam.position.distanceTo(p);
    if ((f < 1 && d * f < cam.near * 4) || (f > 1 && d * f > cam.far * 0.4)) return;
    cam.position.sub(p).multiplyScalar(f).add(p);
    this.target.sub(p).multiplyScalar(f).add(p);
    this.update();
  }

  /** Moves the camera there smoothly (at once with reduced motion or ms = 0). */
  flyTo(pos: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3, ms = 600) {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || ms <= 0) {
      this.camera.position.copy(pos);
      this.target.copy(target);
      this.camera.up.copy(up);
      this.fly = null;
      return this.update();
    }
    this.fly = { t0: 0, ms, from: { pos: this.camera.position.clone(), target: this.target.clone(), up: this.camera.up.clone() }, to: { pos: pos.clone(), target: target.clone(), up: up.clone() } };
    this.onChange();
  }

  /** Called on every frame: moves a flight on. */
  tick(now: number) {
    const f = this.fly;
    if (!f) return;
    if (!f.t0) f.t0 = now;
    const t = Math.min(1, (now - f.t0) / f.ms);
    const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    // Round the target, not through the part: the direction turns, the distance changes.
    const target = f.from.target.clone().lerp(f.to.target, e);
    const d0 = f.from.pos.clone().sub(f.from.target);
    const d1 = f.to.pos.clone().sub(f.to.target);
    const dir = new THREE.Vector3().copy(d0).normalize();
    const turn = new THREE.Quaternion().setFromUnitVectors(dir, d1.clone().normalize());
    const part = new THREE.Quaternion().slerp(turn, e);
    const len = d0.length() + (d1.length() - d0.length()) * e;
    this.camera.position.copy(target).add(dir.applyQuaternion(part).multiplyScalar(len));
    this.target.copy(target);
    // The up direction follows the same turn, then settles on the one asked for.
    const up = f.from.up.clone().applyQuaternion(part).lerp(f.to.up, e);
    if (up.lengthSq() > 1e-6) this.camera.up.copy(up.normalize());
    if (t >= 1) {
      this.camera.position.copy(f.to.pos);
      this.target.copy(f.to.target);
      this.camera.up.copy(f.to.up);
      this.fly = null;
    }
    this.update();
  }

  /** Points the camera at the target (after the camera or target were moved from outside). */
  update() {
    // An up along the view would leave the turn undefined: lean it a hair.
    const fwd = this.target.clone().sub(this.camera.position).normalize();
    if (Math.abs(fwd.dot(this.camera.up)) > 0.999) this.camera.up.add(new THREE.Vector3(0, 0, -0.01)).normalize();
    this.camera.lookAt(this.target);
    this.onChange();
  }

  dispose() {
    this.off();
  }
}
