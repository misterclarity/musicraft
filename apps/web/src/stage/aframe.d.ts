/** The parts of A-Frame's API that the stage uses (A-Frame ships no types). */
declare module "aframe" {
  import type * as THREE from "three";

  export interface Entity extends HTMLElement {
    object3D: THREE.Object3D;
    sceneEl?: Scene;
    components: Record<string, unknown>;
    hasLoaded: boolean;
    setObject3D(type: string, object: THREE.Object3D): void;
    getObject3D(type: string): THREE.Object3D | undefined;
    removeObject3D(type: string): void;
    emit(name: string, detail?: unknown, bubbles?: boolean): void;
  }

  export interface Scene extends Entity {
    camera: THREE.Camera;
    renderer: THREE.WebGLRenderer;
    canvas: HTMLCanvasElement;
    isPlaying: boolean;
    pause(): void;
    play(): void;
  }

  export interface Component<D = Record<string, unknown>> {
    el: Entity;
    data: D;
  }

  interface AFrameStatic {
    /** Methods: init, update(oldData), tick(time, delta), remove, and any of the component's own. */
    registerComponent(name: string, definition: Record<string, unknown>): void;
    components: Record<string, unknown>;
    THREE: typeof THREE & {
      BufferGeometryUtils: { mergeGeometries(geometries: THREE.BufferGeometry[], useGroups?: boolean): THREE.BufferGeometry | null };
    };
    version: string;
  }

  const AFRAME: AFrameStatic;
  export default AFRAME;
}
