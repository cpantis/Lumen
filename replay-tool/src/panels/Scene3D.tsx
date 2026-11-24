/**
 * three.js scene used by the point-cloud, TF, marker and pose panels.
 * Orbit camera, grid, axes; `preserveDrawingBuffer` so PNG/WebM exports can read it.
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { colormap, type Colormap } from "../core/image";

export interface SceneApi {
  scene: THREE.Scene;
  group: THREE.Group;
  render: () => void;
  fit: (radius: number) => void;
}

export function useScene3D(onReady: (api: SceneApi) => void): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    const el = ref.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    renderer.setPixelRatio(devicePixelRatio);
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("role", "img");
    renderer.domElement.setAttribute("aria-label", "Vizualizare 3D");
    const scene = new THREE.Scene();
    // ROS convention: z up
    const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 500);
    camera.up.set(0, 0, 1);
    camera.position.set(-4, -4, 3);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(3, 0, 0);
    const grid = new THREE.GridHelper(40, 40, 0x555555, 0x2a2a2e);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);
    scene.add(new THREE.AxesHelper(1));
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dl = new THREE.DirectionalLight(0xffffff, 0.8);
    dl.position.set(5, -5, 10);
    scene.add(dl);
    const group = new THREE.Group();
    scene.add(group);
    const render = () => renderer.render(scene, camera);
    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    controls.addEventListener("change", render);
    resize();
    ready.current({
      scene,
      group,
      render,
      fit: (r) => {
        camera.position.set(-r * 0.6, -r * 0.8, r * 0.6);
        controls.target.set(r * 0.4, 0, 0);
        controls.update();
        render();
      },
    });
    return () => {
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);
  return ref;
}

export function clearGroup(g: THREE.Group): void {
  for (const c of [...g.children]) {
    g.remove(c);
    const m = c as THREE.Mesh;
    m.geometry?.dispose?.();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose?.();
  }
}

/** Builds a THREE.Points object from interleaved xyz and a scalar colour field. */
export function makePoints(positions: Float32Array, scalar: Float32Array | undefined, size: number, cmap: Colormap = "turbo", fixedRange?: [number, number]): { points: THREE.Points; range: [number, number] } {
  const n = positions.length / 3;
  const pos: number[] = [];
  const col: number[] = [];
  let lo = Infinity, hi = -Infinity;
  if (scalar) for (let i = 0; i < n; i++) if (Number.isFinite(scalar[i])) (lo = Math.min(lo, scalar[i])), (hi = Math.max(hi, scalar[i]));
  if (fixedRange) [lo, hi] = fixedRange;
  const span = hi - lo || 1;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    pos.push(x, y, z);
    const s = scalar ? scalar[i] : z;
    const [r, g, b] = colormap(cmap, Number.isFinite(s) ? (s - lo) / span : 0);
    col.push(r / 255, g / 255, b / 255);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: true });
  return { points: new THREE.Points(geom, mat), range: [lo, hi] };
}

/** Small RGB axes triad at a pose. */
export function axesAt(t: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }, len = 0.3, label?: string): THREE.Object3D {
  const o = new THREE.Group();
  o.add(new THREE.AxesHelper(len));
  o.position.set(t.x, t.y, t.z);
  o.quaternion.set(q.x, q.y, q.z, q.w);
  if (label) o.name = label;
  return o;
}
