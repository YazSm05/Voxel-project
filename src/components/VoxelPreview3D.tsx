import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Camera, RotateCw, Compass, ZoomIn, ZoomOut } from 'lucide-react';
import {
  CHUNK_SIZE,
  WORLD_SIZE,
  VoxelEntry,
  voxelArrayToMap,
  createPixelAtlasTexture,
  buildChunkGreedyGeometry,
} from '../voxel/voxelData';

interface VoxelPreview3DProps {
  voxels: VoxelEntry[];
  initialYaw?: number;
  initialPitch?: number;
  autoRotateDefault?: boolean;
  showCaptureButton?: boolean;
  onCaptureScreenshot?: (dataUrl: string, yaw: number, pitch: number) => void;
  onAngleChange?: (yaw: number, pitch: number) => void;
  className?: string;
}

export default function VoxelPreview3D({
  voxels,
  initialYaw = 0.785,
  initialPitch = -0.52,
  autoRotateDefault = false,
  showCaptureButton = false,
  onCaptureScreenshot,
  onAngleChange,
  className = 'w-full h-64',
}: VoxelPreview3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [autoSpin, setAutoSpin] = useState<boolean>(autoRotateDefault);
  const autoSpinRef = useRef<boolean>(autoRotateDefault);

  useEffect(() => {
    autoSpinRef.current = autoSpin;
  }, [autoSpin]);

  const actionsRef = useRef<{
    capture: () => void;
    setAngle: (yaw: number, pitch: number) => void;
    zoom: (delta: number) => void;
  } | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const isSoftwareGl = (() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();

    const width = mount.clientWidth || 360;
    const height = mount.clientHeight || 240;

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.domElement.style.touchAction = 'none';
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0c2438');

    const hemiLight = new THREE.HemisphereLight('#e3f2ff', '#071b2c', 0.95);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight('#fff8eb', 1.35);
    dirLight.position.set(26, 38, 28);
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight('#5bc2e7', 0.5);
    fillLight.position.set(-22, 16, -20);
    scene.add(fillLight);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 300);

    // Build chunk meshes for the preview voxel data
    const worldMap = voxelArrayToMap(voxels);
    const atlasTex = createPixelAtlasTexture();
    const mat = new THREE.MeshStandardMaterial({
      map: atlasTex,
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.05,
    });

    const group = new THREE.Group();
    scene.add(group);
    const geometries: THREE.BufferGeometry[] = [];

    const numChunks = WORLD_SIZE / CHUNK_SIZE;
    for (let cx = 0; cx < numChunks; cx++) {
      for (let cy = 0; cy < numChunks; cy++) {
        for (let cz = 0; cz < numChunks; cz++) {
          const geom = buildChunkGreedyGeometry(cx, cy, cz, worldMap);
          if (geom.attributes.position.count > 0) {
            geometries.push(geom);
            const mesh = new THREE.Mesh(geom, mat);
            mesh.position.set(cx * CHUNK_SIZE, cy * CHUNK_SIZE, cz * CHUNK_SIZE);
            group.add(mesh);
          } else {
            geom.dispose();
          }
        }
      }
    }

    // Subtle turntable pedestal ring under the island
    const ringGeo = new THREE.RingGeometry(13.2, 13.8, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: '#38e2ff',
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.35,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.position.set(16, 2.5, 16);
    scene.add(ringMesh);

    const orbit = {
      yaw: initialYaw,
      pitch: initialPitch,
      targetYaw: initialYaw,
      targetPitch: initialPitch,
      distance: 36.0,
      targetDistance: 36.0,
      target: new THREE.Vector3(16, 10.5, 16),
      dragging: false,
      lastX: 0,
      lastY: 0,
    };

    const updateCam = () => {
      const ox = Math.cos(orbit.pitch) * Math.sin(orbit.yaw) * orbit.distance;
      const oy = -Math.sin(orbit.pitch) * orbit.distance;
      const oz = Math.cos(orbit.pitch) * Math.cos(orbit.yaw) * orbit.distance;
      camera.position.set(
        orbit.target.x + ox,
        orbit.target.y + oy,
        orbit.target.z + oz,
      );
      camera.lookAt(orbit.target);
    };
    updateCam();

    const onPointerDown = (e: PointerEvent) => {
      orbit.dragging = true;
      orbit.lastX = e.clientX;
      orbit.lastY = e.clientY;
      setAutoSpin(false);
      renderer.domElement.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!orbit.dragging) return;
      const dx = e.clientX - orbit.lastX;
      const dy = e.clientY - orbit.lastY;
      orbit.lastX = e.clientX;
      orbit.lastY = e.clientY;

      orbit.targetYaw -= dx * 0.01;
      orbit.targetPitch = THREE.MathUtils.clamp(orbit.targetPitch - dy * 0.01, -1.45, 0.25);
      onAngleChange?.(orbit.targetYaw, orbit.targetPitch);
    };

    const onPointerUp = (e: PointerEvent) => {
      orbit.dragging = false;
      renderer.domElement.releasePointerCapture(e.pointerId);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 3.0 : -3.0;
      orbit.targetDistance = THREE.MathUtils.clamp(orbit.targetDistance + delta, 14.0, 68.0);
    };

    const dom = renderer.domElement;
    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointermove', onPointerMove);
    dom.addEventListener('pointerup', onPointerUp);
    dom.addEventListener('wheel', onWheel, { passive: false });

    const onResize = () => {
      if (!mount) return;
      const w = mount.clientWidth || 360;
      const h = mount.clientHeight || 240;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    actionsRef.current = {
      capture: () => {
        renderer.render(scene, camera);
        const dataUrl = renderer.domElement.toDataURL('image/png');
        onCaptureScreenshot?.(dataUrl, orbit.yaw, orbit.pitch);
      },
      setAngle: (yaw: number, pitch: number) => {
        setAutoSpin(false);
        orbit.targetYaw = yaw;
        orbit.targetPitch = pitch;
        onAngleChange?.(yaw, pitch);
      },
      zoom: (delta: number) => {
        orbit.targetDistance = THREE.MathUtils.clamp(orbit.targetDistance + delta, 14.0, 68.0);
      },
    };

    const clock = new THREE.Clock();
    let frameId = 0;

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function tick() {
      const delta = Math.min(clock.getDelta(), 0.05);
      if (autoSpinRef.current && !orbit.dragging) {
        orbit.targetYaw += delta * 0.55;
      }
      orbit.yaw = THREE.MathUtils.damp(orbit.yaw, orbit.targetYaw, 12, delta);
      orbit.pitch = THREE.MathUtils.damp(orbit.pitch, orbit.targetPitch, 12, delta);
      orbit.distance = THREE.MathUtils.damp(orbit.distance, orbit.targetDistance, 12, delta);
      updateCam();
      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    }

    frameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      dom.removeEventListener('pointerdown', onPointerDown);
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerup', onPointerUp);
      dom.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
      geometries.forEach((g) => g.dispose());
      ringGeo.dispose();
      ringMat.dispose();
      mat.dispose();
      atlasTex.dispose();
      renderer.dispose();
      if (dom.parentNode === mount) {
        mount.removeChild(dom);
      }
    };
  }, [voxels]);

  return (
    <div className={`relative rounded-lg overflow-hidden border border-[#26b5d6] bg-[#0c2438] ${className}`}>
      <div ref={mountRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

      {/* Top-Left 3D Interactive Badge */}
      <div className="absolute top-2 left-2 pointer-events-none bg-[#081824]/85 border border-[#1e4968] rounded px-2 py-0.5 text-[10px] text-[#38e2ff] font-medium flex items-center gap-1">
        <RotateCw className="w-3 h-3" />
        <span>Drag to Rotate 3D • Scroll to Zoom</span>
      </div>

      {/* Bottom Controls Overlay */}
      <div className="absolute bottom-2 left-2 right-2 flex flex-wrap items-center justify-between gap-1.5 pointer-events-auto">
        <div className="flex items-center gap-1 bg-[#081824]/90 border border-[#1e4968] rounded p-1">
          {[
            { label: 'ISO', yaw: 0.785, pitch: -0.52 },
            { label: 'FRONT', yaw: 0.0, pitch: -0.35 },
            { label: 'SIDE', yaw: 1.57, pitch: -0.35 },
            { label: 'TOP', yaw: 0.785, pitch: -1.35 },
          ].map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => actionsRef.current?.setAngle(preset.yaw, preset.pitch)}
              className="px-1.5 py-0.5 text-[10px] rounded bg-[#102538] hover:bg-[#1589b8] text-white cursor-pointer"
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setAutoSpin((s) => !s)}
            title="Toggle Auto-Turntable Rotation"
            className={`px-1.5 py-0.5 text-[10px] rounded flex items-center gap-1 cursor-pointer ${
              autoSpin ? 'bg-[#1589b8] text-white' : 'bg-[#102538] text-[#b8d4e8]'
            }`}
          >
            <Compass className="w-3 h-3" />
            <span>Spin</span>
          </button>
          <button
            type="button"
            onClick={() => actionsRef.current?.zoom(-4)}
            title="Zoom In"
            className="p-0.5 rounded bg-[#102538] hover:bg-[#183752] text-white cursor-pointer"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => actionsRef.current?.zoom(4)}
            title="Zoom Out"
            className="p-0.5 rounded bg-[#102538] hover:bg-[#183752] text-white cursor-pointer"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
        </div>

        {showCaptureButton && (
          <button
            type="button"
            onClick={() => actionsRef.current?.capture()}
            className="px-2.5 py-1 text-xs font-semibold rounded border bg-[#1589b8] border-[#38e2ff] hover:bg-[#1ba3d9] text-white flex items-center gap-1.5 shadow-lg cursor-pointer"
          >
            <Camera className="w-3.5 h-3.5 text-[#ffe678]" />
            <span>Snap Screenshot from Angle</span>
          </button>
        )}
      </div>
    </div>
  );
}
