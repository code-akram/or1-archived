import { emptyModel } from "@or1/core";
import { useEffect, useRef } from "react";
import * as THREE from "three";

/** Editor shell stub: the core replica plus an empty Three.js view. */
export function App() {
  const model = emptyModel();
  return (
    <main style={{ fontFamily: "system-ui", padding: 16 }}>
      <h1>or1</h1>
      <p>
        Core replica loaded: {model.walls.length} walls, {model.spaces.length} spaces.
      </p>
      <View3D />
    </main>
  );
}

function View3D() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(640, 400);
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f4f0);
    const camera = new THREE.PerspectiveCamera(50, 640 / 400, 0.1, 1000);
    camera.position.set(8, 8, 8);
    camera.lookAt(0, 0, 0);
    scene.add(new THREE.GridHelper(20, 20));
    renderer.render(scene, camera);
    return () => {
      renderer.dispose();
      element.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={container} />;
}
