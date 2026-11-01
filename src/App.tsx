import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  CHUNK_SIZE,
  WORLD_SIZE,
  PALETTE,
  TEX_NAMES,
  TEX_SHORT,
  BIOME_GROUPS,
  VoxelEntry,
  SavedBuild,
  packVoxel,
  unpackVoxel,
  posKey,
  createPixelAtlasTexture,
  generateSandboxIslandData,
  generateFrostCitadelVoxels,
  serializeWorldMap,
  buildChunkGreedyGeometry,
  createBuildThumbnailDataUrl,
} from './voxel/voxelData';

type ToolId = 'add' | 'erase' | 'paint' | 'box' | 'column' | 'eyedrop';

const STORAGE_KEY = 'sandbox_workshop_store_v1';

// Pre-allocated vectors outside render loop to avoid GC
const _vec3A = new THREE.Vector3();
const _vec3B = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();

export default function App() {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // UI State
  const [isExploreMode, setIsExploreMode] = useState(false);
  const [currentTool, setCurrentTool] = useState<ToolId>('add');
  const [selectedColIdx, setSelectedColIdx] = useState<number>(1);
  const [selectedTexIdx, setSelectedTexIdx] = useState<number>(0);
  const [brushSize, setBrushSize] = useState<number>(1);
  const [mirrorX, setMirrorX] = useState<boolean>(false);
  const [isOrtho, setIsOrtho] = useState<boolean>(true);
  const [cubeCount, setCubeCount] = useState<number>(0);
  const [hoverCoords, setHoverCoords] = useState<string>('0, 0, 0');

  const [buildName, setBuildName] = useState<string>('Four-Biome Floating Island');
  const [buildPrice, setBuildPrice] = useState<string>('250 SAND');
  const [savedBuilds, setSavedBuilds] = useState<SavedBuild[]>([]);
  const [shopItems, setShopItems] = useState<SavedBuild[]>([]);
  const [activeModal, setActiveModal] = useState<'builds' | 'shop' | null>(null);

  // Mutable refs for event handlers & Three.js loop
  const worldDataRef = useRef<Map<string, number>>(new Map());
  const stateRef = useRef({
    isExploreMode: false,
    currentTool: 'add' as ToolId,
    selectedColIdx: 1,
    selectedTexIdx: 0,
    brushSize: 1,
    mirrorX: false,
    modalOpen: false,
  });

  useEffect(() => {
    stateRef.current = {
      isExploreMode,
      currentTool,
      selectedColIdx,
      selectedTexIdx,
      brushSize,
      mirrorX,
      modalOpen: activeModal !== null,
    };
  }, [isExploreMode, currentTool, selectedColIdx, selectedTexIdx, brushSize, mirrorX, activeModal]);

  // Camera & scene control refs exposed to UI buttons
  const sceneActionsRef = useRef<{
    rebuildAllChunks: () => void;
    setCameraAngle: (yaw: number, pitch: number) => void;
    toggleOrtho: () => void;
    setGameMode: (explore: boolean) => void;
  } | null>(null);

  const updateMinimap = useCallback(() => {
    const canvas = minimapCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#081824';
    ctx.fillRect(0, 0, WORLD_SIZE, WORLD_SIZE);

    const map = worldDataRef.current;
    for (let x = 0; x < WORLD_SIZE; x++) {
      for (let z = 0; z < WORLD_SIZE; z++) {
        for (let y = WORLD_SIZE - 1; y >= 0; y--) {
          const val = map.get(posKey(x, y, z));
          if (val !== undefined && val !== 0) {
            const colIdx = Math.min(Math.max(val & 0xff, 1), PALETTE.length - 1);
            ctx.fillStyle = PALETTE[colIdx];
            ctx.fillRect(x, z, 1, 1);
            break;
          }
        }
      }
    }
  }, []);

  const persistStorage = useCallback((builds: SavedBuild[], shop: SavedBuild[]) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ builds, shop }));
    } catch {
      // Ignore storage quota errors
    }
  }, []);

  // Initialize Three.js Scene & Voxel World
  useEffect(() => {
    const mount = canvasMountRef.current;
    if (!mount) return;

    // 1. Software WebGL detection
    const isSoftwareGl = (() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth || window.innerWidth, mount.clientHeight || window.innerHeight);
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b263b');
    scene.fog = new THREE.FogExp2('#0b263b', 0.0065);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();

    // Sky & Studio Lighting matching main.tscn
    const hemiLight = new THREE.HemisphereLight('#d1e6fa', '#061b2d', 0.85);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight('#fff8eb', 1.35);
    dirLight.position.set(22, 36, 24);
    dirLight.castShadow = !isSoftwareGl;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    dirLight.shadow.camera.near = 5;
    dirLight.shadow.camera.far = 90;
    const d = 24;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;
    dirLight.shadow.bias = -0.0005;
    dirLight.shadow.normalBias = 0.02;
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight('#6bc5e8', 0.45);
    fillLight.position.set(-20, 14, -18);
    scene.add(fillLight);

    // Cameras: Orthographic & Perspective for Editor + First-Person Perspective for Player
    const width = mount.clientWidth || window.innerWidth;
    const height = mount.clientHeight || window.innerHeight;
    const aspect = width / height;

    const orthoCam = new THREE.OrthographicCamera(-14 * aspect, 14 * aspect, 14, -14, 0.1, 400);
    const perspCam = new THREE.PerspectiveCamera(50, aspect, 0.1, 400);
    const playerCam = new THREE.PerspectiveCamera(70, aspect, 0.1, 400);

    // Editor Camera Orbit State (from editor_camera.gd)
    const camState = {
      yaw: 0.785,
      pitch: -0.58,
      targetYaw: 0.785,
      targetPitch: -0.58,
      distance: 42.0,
      targetDistance: 42.0,
      target: new THREE.Vector3(16, 9, 16),
      isOrtho: true,
      isOrbiting: false,
    };

    const updateEditorCameras = () => {
      const size = camState.distance * 0.68;
      const w = mount.clientWidth || window.innerWidth;
      const h = mount.clientHeight || window.innerHeight;
      const asp = w / h;

      orthoCam.left = (-size * asp) / 2;
      orthoCam.right = (size * asp) / 2;
      orthoCam.top = size / 2;
      orthoCam.bottom = -size / 2;
      orthoCam.updateProjectionMatrix();

      perspCam.aspect = asp;
      perspCam.updateProjectionMatrix();

      const ox = Math.cos(camState.pitch) * Math.sin(camState.yaw) * camState.distance;
      const oy = -Math.sin(camState.pitch) * camState.distance;
      const oz = Math.cos(camState.pitch) * Math.cos(camState.yaw) * camState.distance;

      orthoCam.position.set(
        camState.target.x + ox,
        camState.target.y + oy,
        camState.target.z + oz,
      );
      orthoCam.lookAt(camState.target);

      perspCam.position.copy(orthoCam.position);
      perspCam.lookAt(camState.target);
    };
    updateEditorCameras();

    // Shared Voxel Atlas Material
    const atlasTexture = createPixelAtlasTexture();
    atlasTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const sharedMaterial = new THREE.MeshStandardMaterial({
      map: atlasTexture,
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.05,
    });

    // Chunks container (2x2x2 chunks for 32x32x32 world)
    const chunksGroup = new THREE.Group();
    scene.add(chunksGroup);
    const chunkMeshes = new Map<string, THREE.Mesh>();

    const rebuildAllChunks = () => {
      const numChunks = WORLD_SIZE / CHUNK_SIZE;
      for (let cx = 0; cx < numChunks; cx++) {
        for (let cy = 0; cy < numChunks; cy++) {
          for (let cz = 0; cz < numChunks; cz++) {
            const cKey = `${cx},${cy},${cz}`;
            const oldMesh = chunkMeshes.get(cKey);
            if (oldMesh) {
              oldMesh.geometry.dispose();
              chunksGroup.remove(oldMesh);
              chunkMeshes.delete(cKey);
            }
            const geom = buildChunkGreedyGeometry(cx, cy, cz, worldDataRef.current);
            if (geom.attributes.position.count > 0) {
              const mesh = new THREE.Mesh(geom, sharedMaterial);
              mesh.position.set(cx * CHUNK_SIZE, cy * CHUNK_SIZE, cz * CHUNK_SIZE);
              mesh.castShadow = !isSoftwareGl;
              mesh.receiveShadow = !isSoftwareGl;
              chunksGroup.add(mesh);
              chunkMeshes.set(cKey, mesh);
            } else {
              geom.dispose();
            }
          }
        }
      }
      setCubeCount(worldDataRef.current.size);
      updateMinimap();
    };

    // Cursor Preview Box (matching _create_cursor_box in voxel_world.gd)
    const cursorGeo = new THREE.BoxGeometry(1.04, 1.04, 1.04);
    const cursorMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.22, 0.88, 1.0),
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    });
    const cursorBox = new THREE.Mesh(cursorGeo, cursorMat);
    const cursorEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(cursorGeo),
      new THREE.LineBasicMaterial({ color: '#38e2ff' }),
    );
    cursorBox.add(cursorEdges);
    cursorBox.visible = false;
    scene.add(cursorBox);

    // Player Avatar (3-12 part composite procedural model for Explore Mode & visual representation)
    const playerGroup = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: '#38e2ff', roughness: 0.4, metalness: 0.2 });
    const headMat = new THREE.MeshStandardMaterial({ color: '#ffe678', roughness: 0.65, metalness: 0.05 });
    const visorMat = new THREE.MeshStandardMaterial({ color: '#0f2436', roughness: 0.15, metalness: 0.8 });
    const packMat = new THREE.MeshStandardMaterial({ color: '#ff5232', roughness: 0.5, metalness: 0.3 });

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.7, 0.32), bodyMat);
    torso.position.set(0, 0.75, 0);
    playerGroup.add(torso);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.46, 0.46), headMat);
    head.position.set(0, 1.38, 0);
    playerGroup.add(head);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.16, 0.08), visorMat);
    visor.position.set(0, 1.4, -0.22);
    playerGroup.add(visor);

    const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.2), packMat);
    backpack.position.set(0, 0.78, 0.24);
    playerGroup.add(backpack);

    const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.4, 0.24), visorMat);
    leftLeg.position.set(-0.14, 0.2, 0);
    playerGroup.add(leftLeg);

    const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.4, 0.24), visorMat);
    rightLeg.position.set(0.14, 0.2, 0);
    playerGroup.add(rightLeg);

    playerGroup.visible = false;
    scene.add(playerGroup);

    // Player Physics State (from player.gd)
    const playerState = {
      pos: new THREE.Vector3(16, 19, 16),
      vel: new THREE.Vector3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      onFloor: false,
      isDraggingLook: false,
    };

    // Generate Initial Island & Load Storage
    worldDataRef.current = generateSandboxIslandData();
    rebuildAllChunks();

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.builds) && Array.isArray(parsed.shop) && parsed.shop.length > 0) {
          setSavedBuilds(parsed.builds);
          setShopItems(parsed.shop);
        } else {
          throw new Error('Initialize defaults');
        }
      } else {
        throw new Error('Initialize defaults');
      }
    } catch {
      const defaultShop: SavedBuild[] = [
        {
          name: 'Four-Biome Floating Island',
          author: '@TheSandboxOfficial',
          price: '450 SAND',
          voxels: serializeWorldMap(worldDataRef.current),
        },
        {
          name: 'Frost Crystal Citadel',
          author: '@VoxelArchitect',
          price: '180 SAND',
          voxels: generateFrostCitadelVoxels(),
        },
      ];
      setShopItems(defaultShop);
      persistStorage([], defaultShop);
    }

    // Voxel Setter Helpers (matching set_world_voxel & _set_with_mirror in voxel_world.gd)
    const setWorldVoxel = (wx: number, wy: number, wz: number, val: number) => {
      if (wx < 0 || wx >= WORLD_SIZE || wy < 0 || wy >= WORLD_SIZE || wz < 0 || wz >= WORLD_SIZE) {
        return;
      }
      const key = posKey(wx, wy, wz);
      if (val === 0) {
        worldDataRef.current.delete(key);
      } else {
        worldDataRef.current.set(key, val);
      }
    };

    const setWithMirror = (wx: number, wy: number, wz: number, val: number) => {
      setWorldVoxel(wx, wy, wz, val);
      if (stateRef.current.mirrorX) {
        const mx = WORLD_SIZE - 1 - wx;
        setWorldVoxel(mx, wy, wz, val);
      }
    };

    const applyToolAt = (hitPos: THREE.Vector3, snappedNormal: THREE.Vector3) => {
      const { currentTool: tool, selectedColIdx: colIdx, selectedTexIdx: texIdx, brushSize: bSize } =
        stateRef.current;

      const insideP = _vec3A.copy(hitPos).addScaledVector(snappedNormal, -0.5);
      const outsideP = _vec3B.copy(hitPos).addScaledVector(snappedNormal, 0.5);

      const ix = Math.floor(insideP.x);
      const iy = Math.floor(insideP.y);
      const iz = Math.floor(insideP.z);
      const ox = Math.floor(outsideP.x);
      const oy = Math.floor(outsideP.y);
      const oz = Math.floor(outsideP.z);

      const packed = packVoxel(colIdx, texIdx);
      const r = bSize - 1;

      if (tool === 'eyedrop') {
        const v = worldDataRef.current.get(posKey(ix, iy, iz));
        if (v !== undefined && v !== 0) {
          const unpacked = unpackVoxel(v);
          setSelectedColIdx(unpacked.colIdx);
          setSelectedTexIdx(unpacked.texIdx);
        }
        return;
      } else if (tool === 'erase') {
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            for (let dz = -r; dz <= r; dz++) {
              setWithMirror(ix + dx, iy + dy, iz + dz, 0);
            }
          }
        }
      } else if (tool === 'paint') {
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            for (let dz = -r; dz <= r; dz++) {
              const k = posKey(ix + dx, iy + dy, iz + dz);
              if (worldDataRef.current.has(k)) {
                setWithMirror(ix + dx, iy + dy, iz + dz, packed);
              }
            }
          }
        }
      } else if (tool === 'column') {
        for (let h = 0; h < 4; h++) {
          setWithMirror(ox, oy + h, oz, packed);
        }
      } else if (tool === 'box') {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            setWithMirror(ox + dx, oy, oz + dz, packed);
          }
        }
      } else {
        // 'add'
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            for (let dz = -r; dz <= r; dz++) {
              setWithMirror(ox + dx, oy + dy, oz + dz, packed);
            }
          }
        }
      }

      rebuildAllChunks();
    };

    // Raycasting for Editor Tool
    const raycaster = new THREE.Raycaster();
    const pointerNDC = new THREE.Vector2();
    let lastHoverRaycast = 0;

    const performRaycastTool = (clientX: number, clientY: number, isClick: boolean, forceErase = false) => {
      if (stateRef.current.isExploreMode || stateRef.current.modalOpen) {
        cursorBox.visible = false;
        return;
      }

      const rect = renderer.domElement.getBoundingClientRect();
      pointerNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointerNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;

      const activeCam = camState.isOrtho ? orthoCam : perspCam;
      raycaster.setFromCamera(pointerNDC, activeCam);

      const meshes = Array.from(chunkMeshes.values());
      const intersects = raycaster.intersectObjects(meshes, false);

      if (intersects.length > 0) {
        const hit = intersects[0];
        if (!hit.face) return;

        const n = _vec3A.copy(hit.face.normal);
        // Ensure normal points outward toward camera ray
        if (n.dot(raycaster.ray.direction) > 0) {
          n.negate();
        }

        // Snap strictly to dominant axis (±X, ±Y, or ±Z)
        const ax = Math.abs(n.x);
        const ay = Math.abs(n.y);
        const az = Math.abs(n.z);
        const snappedNormal = new THREE.Vector3();
        if (ax >= ay && ax >= az) {
          snappedNormal.set(Math.sign(n.x), 0, 0);
        } else if (ay >= ax && ay >= az) {
          snappedNormal.set(0, Math.sign(n.y), 0);
        } else {
          snappedNormal.set(0, 0, Math.sign(n.z));
        }

        if (isClick) {
          if (forceErase) {
            const prevTool = stateRef.current.currentTool;
            stateRef.current.currentTool = 'erase';
            applyToolAt(hit.point, snappedNormal);
            stateRef.current.currentTool = prevTool;
          } else {
            applyToolAt(hit.point, snappedNormal);
          }
        } else {
          const tool = stateRef.current.currentTool;
          const isInside = tool === 'erase' || tool === 'paint' || tool === 'eyedrop';
          const targetP = _vec3B
            .copy(hit.point)
            .addScaledVector(snappedNormal, isInside ? -0.5 : 0.5);
          const bx = Math.floor(targetP.x);
          const by = Math.floor(targetP.y);
          const bz = Math.floor(targetP.z);
          cursorBox.visible = true;
          cursorBox.position.set(bx + 0.5, by + 0.5, bz + 0.5);
          setHoverCoords(`${bx - 16}, ${by - 10}, ${bz - 16}`);
        }
      } else {
        cursorBox.visible = false;
      }
    };

    // Mouse & Keyboard Input Listeners
    const keysPressed = new Set<string>();
    let rightMouseDownPos = { x: 0, y: 0 };
    let rightMouseDragged = false;

    const onMouseDown = (e: MouseEvent) => {
      if (stateRef.current.modalOpen) return;

      if (stateRef.current.isExploreMode) {
        if (e.button === 0 || e.button === 2) {
          playerState.isDraggingLook = true;
        }
        return;
      }

      if (e.button === 2) {
        camState.isOrbiting = true;
        rightMouseDownPos = { x: e.clientX, y: e.clientY };
        rightMouseDragged = false;
      } else if (e.button === 0) {
        performRaycastTool(e.clientX, e.clientY, true, false);
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (stateRef.current.modalOpen) return;

      if (stateRef.current.isExploreMode) {
        if (playerState.isDraggingLook || document.pointerLockElement === renderer.domElement) {
          playerState.yaw -= e.movementX * 0.004;
          playerState.pitch = THREE.MathUtils.clamp(
            playerState.pitch - e.movementY * 0.004,
            THREE.MathUtils.degToRad(-80),
            THREE.MathUtils.degToRad(80),
          );
        }
        return;
      }

      if (camState.isOrbiting) {
        if (Math.hypot(e.clientX - rightMouseDownPos.x, e.clientY - rightMouseDownPos.y) > 4) {
          rightMouseDragged = true;
        }
        camState.targetYaw -= e.movementX * 0.008;
        camState.targetPitch = THREE.MathUtils.clamp(
          camState.targetPitch - e.movementY * 0.008,
          -1.4,
          -0.1,
        );
      } else {
        const now = performance.now();
        if (now - lastHoverRaycast >= 28) {
          lastHoverRaycast = now;
          performRaycastTool(e.clientX, e.clientY, false);
        }
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 2) {
        camState.isOrbiting = false;
      }
      playerState.isDraggingLook = false;
    };

    const onWheel = (e: WheelEvent) => {
      if (stateRef.current.isExploreMode || stateRef.current.modalOpen) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? 2.5 : -2.5;
      camState.targetDistance = THREE.MathUtils.clamp(camState.targetDistance + delta, 12.0, 75.0);
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore keyboard shortcuts when typing in input fields
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      keysPressed.add(e.code);

      if (e.code === 'Tab') {
        e.preventDefault();
        sceneActionsRef.current?.setGameMode(!stateRef.current.isExploreMode);
      } else if (e.code >= 'Digit1' && e.code <= 'Digit8') {
        const idx = Number(e.code.replace('Digit', '')) - 1;
        setSelectedTexIdx(idx);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      keysPressed.delete(e.code);
    };

    const domElem = renderer.domElement;
    domElem.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    domElem.addEventListener('wheel', onWheel, { passive: false });
    domElem.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const onResize = () => {
      const w = mount.clientWidth || window.innerWidth;
      const h = mount.clientHeight || window.innerHeight;
      renderer.setSize(w, h);
      playerCam.aspect = w / h;
      playerCam.updateProjectionMatrix();
      updateEditorCameras();
    };
    window.addEventListener('resize', onResize);

    // Expose actions to React UI
    sceneActionsRef.current = {
      rebuildAllChunks,
      setCameraAngle: (yaw: number, pitch: number) => {
        camState.targetYaw = yaw;
        camState.targetPitch = pitch;
      },
      toggleOrtho: () => {
        camState.isOrtho = !camState.isOrtho;
        setIsOrtho(camState.isOrtho);
        updateEditorCameras();
      },
      setGameMode: (explore: boolean) => {
        setIsExploreMode(explore);
        stateRef.current.isExploreMode = explore;
        cursorBox.visible = false;
        if (explore) {
          playerState.pos.set(16, 19, 16);
          playerState.vel.set(0, 0, 0);
          playerState.yaw = 0;
          playerState.pitch = -0.15;
        } else {
          if (document.pointerLockElement === renderer.domElement) {
            document.exitPointerLock?.();
          }
        }
      },
    };

    // Voxel AABB Collision check for Player in Explore mode
    const isSolidAt = (wx: number, wy: number, wz: number): boolean => {
      const ix = Math.floor(wx);
      const iy = Math.floor(wy);
      const iz = Math.floor(wz);
      const val = worldDataRef.current.get(posKey(ix, iy, iz));
      return val !== undefined && val !== 0;
    };

    const checkPlayerCollision = (px: number, py: number, pz: number): boolean => {
      const r = 0.35;
      const h = 1.65;
      const sampleY = [py + 0.05, py + 0.85, py + h];
      const sampleXZ = [
        [px - r, pz - r],
        [px + r, pz - r],
        [px - r, pz + r],
        [px + r, pz + r],
      ];
      for (const sy of sampleY) {
        for (const [sx, sz] of sampleXZ) {
          if (isSolidAt(sx, sy, sz)) return true;
        }
      }
      return false;
    };

    if (!isSoftwareGl) {
      renderer.compile(scene, orthoCam);
    }

    // Main Animation & Physics Loop (with software WebGL pacing guard)
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
      const delta = Math.min(clock.getDelta(), 0.1);

      if (!stateRef.current.isExploreMode) {
        // Editor Mode: Keyboard arrow orbit + smooth damping
        let inputX = 0;
        let inputY = 0;
        if (keysPressed.has('ArrowLeft')) inputX -= 1;
        if (keysPressed.has('ArrowRight')) inputX += 1;
        if (keysPressed.has('ArrowUp')) inputY -= 1;
        if (keysPressed.has('ArrowDown')) inputY += 1;

        if (inputX !== 0 || inputY !== 0) {
          camState.targetYaw -= inputX * 1.8 * delta;
          camState.targetPitch = THREE.MathUtils.clamp(
            camState.targetPitch - inputY * 1.2 * delta,
            -1.4,
            -0.1,
          );
        }

        camState.yaw = THREE.MathUtils.damp(camState.yaw, camState.targetYaw, 12, delta);
        camState.pitch = THREE.MathUtils.damp(camState.pitch, camState.targetPitch, 12, delta);
        camState.distance = THREE.MathUtils.damp(
          camState.distance,
          camState.targetDistance,
          12,
          delta,
        );
        updateEditorCameras();

        renderer.render(scene, camState.isOrtho ? orthoCam : perspCam);
      } else {
        // Explore Mode (from player.gd)
        const SPEED = 8.0;
        const JUMP_VELOCITY = 7.8;
        const GRAVITY = 20.0;

        if (keysPressed.has('KeyE')) playerState.yaw -= 2.2 * delta;
        if (keysPressed.has('KeyR')) playerState.yaw += 2.2 * delta;

        let moveX = 0;
        let moveZ = 0;
        if (keysPressed.has('ArrowUp') || keysPressed.has('KeyW') || keysPressed.has('KeyZ')) {
          moveZ -= 1;
        }
        if (keysPressed.has('ArrowDown') || keysPressed.has('KeyS')) {
          moveZ += 1;
        }
        if (keysPressed.has('ArrowLeft') || keysPressed.has('KeyA') || keysPressed.has('KeyQ')) {
          moveX -= 1;
        }
        if (keysPressed.has('ArrowRight') || keysPressed.has('KeyD')) {
          moveX += 1;
        }

        if (moveX !== 0 || moveZ !== 0) {
          const len = Math.hypot(moveX, moveZ);
          moveX /= len;
          moveZ /= len;
        }

        const sinY = Math.sin(playerState.yaw);
        const cosY = Math.cos(playerState.yaw);
        const dirX = moveX * cosY + moveZ * sinY;
        const dirZ = -moveX * sinY + moveZ * cosY;

        playerState.vel.x = dirX * SPEED;
        playerState.vel.z = dirZ * SPEED;

        if (!playerState.onFloor) {
          playerState.vel.y -= GRAVITY * delta;
        }
        if (keysPressed.has('Space') && playerState.onFloor) {
          playerState.vel.y = JUMP_VELOCITY;
          playerState.onFloor = false;
        }

        // Move X
        const nextX = playerState.pos.x + playerState.vel.x * delta;
        if (!checkPlayerCollision(nextX, playerState.pos.y, playerState.pos.z)) {
          playerState.pos.x = nextX;
        } else if (
          playerState.onFloor &&
          !checkPlayerCollision(nextX, playerState.pos.y + 1.05, playerState.pos.z)
        ) {
          // Auto step-up 1 voxel block for smooth island traversal
          playerState.pos.y += 1.02;
          playerState.pos.x = nextX;
        }

        // Move Z
        const nextZ = playerState.pos.z + playerState.vel.z * delta;
        if (!checkPlayerCollision(playerState.pos.x, playerState.pos.y, nextZ)) {
          playerState.pos.z = nextZ;
        } else if (
          playerState.onFloor &&
          !checkPlayerCollision(playerState.pos.x, playerState.pos.y + 1.05, nextZ)
        ) {
          playerState.pos.y += 1.02;
          playerState.pos.z = nextZ;
        }

        // Move Y
        const nextY = playerState.pos.y + playerState.vel.y * delta;
        if (!checkPlayerCollision(playerState.pos.x, nextY, playerState.pos.z)) {
          playerState.pos.y = nextY;
          playerState.onFloor = false;
        } else {
          if (playerState.vel.y < 0) {
            playerState.onFloor = true;
            playerState.pos.y = Math.floor(playerState.pos.y);
          }
          playerState.vel.y = 0;
        }

        // Respawn if falling off island
        if (playerState.pos.y < -15.0) {
          playerState.pos.set(16, 20, 16);
          playerState.vel.set(0, 0, 0);
        }

        // Update First-Person Camera
        playerCam.position.set(
          playerState.pos.x,
          playerState.pos.y + 1.5,
          playerState.pos.z,
        );
        const euler = new THREE.Euler(playerState.pitch, playerState.yaw, 0, 'YXZ');
        playerCam.quaternion.setFromEuler(euler);

        renderer.render(scene, playerCam);
      }

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
      domElem.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      domElem.removeEventListener('wheel', onWheel);
      domElem.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('resize', onResize);
      chunkMeshes.forEach((m) => m.geometry.dispose());
      sharedMaterial.dispose();
      atlasTexture.dispose();
      renderer.dispose();
      if (domElem.parentNode === mount) {
        mount.removeChild(domElem);
      }
    };
  }, [persistStorage, updateMinimap]);

  // Save / Publish / Load Handlers (matching voxel_world.gd)
  const handleSaveToMyBuilds = () => {
    const cleanName = buildName.trim() || `Custom Island #${savedBuilds.length + 1}`;
    const newEntry: SavedBuild = {
      name: cleanName,
      author: '@You',
      price: 'Saved Draft',
      voxels: serializeWorldMap(worldDataRef.current),
    };
    const nextBuilds = [...savedBuilds, newEntry];
    setSavedBuilds(nextBuilds);
    persistStorage(nextBuilds, shopItems);
    setActiveModal('builds');
  };

  const handlePublishToShop = () => {
    const cleanName = buildName.trim() || `Published World #${shopItems.length + 1}`;
    let cleanPrice = buildPrice.trim() || '100 SAND';
    if (!cleanPrice.toUpperCase().endsWith('SAND')) {
      cleanPrice += ' SAND';
    }
    const newEntry: SavedBuild = {
      name: cleanName,
      author: '@YazSm05',
      price: cleanPrice,
      voxels: serializeWorldMap(worldDataRef.current),
    };
    const nextBuilds = [...savedBuilds, newEntry];
    const nextShop = [newEntry, ...shopItems];
    setSavedBuilds(nextBuilds);
    setShopItems(nextShop);
    persistStorage(nextBuilds, nextShop);
    setActiveModal('shop');
  };

  const handleLoadVoxelBuild = (item: SavedBuild) => {
    const nextMap = new Map<string, number>();
    for (const [vx, vy, vz, val] of item.voxels) {
      if (
        vx >= 0 &&
        vx < WORLD_SIZE &&
        vy >= 0 &&
        vy < WORLD_SIZE &&
        vz >= 0 &&
        vz < WORLD_SIZE &&
        val !== 0
      ) {
        nextMap.set(posKey(vx, vy, vz), val);
      }
    }
    worldDataRef.current = nextMap;
    sceneActionsRef.current?.rebuildAllChunks();
    setBuildName(item.name);
    setActiveModal(null);
  };

  const handleDeleteSavedBuild = (idx: number) => {
    const nextBuilds = savedBuilds.filter((_, i) => i !== idx);
    setSavedBuilds(nextBuilds);
    persistStorage(nextBuilds, shopItems);
  };

  const handleResetDefaultIsland = () => {
    worldDataRef.current = generateSandboxIslandData();
    sceneActionsRef.current?.rebuildAllChunks();
    setBuildName('Four-Biome Floating Island');
  };

  const selectedHex = PALETTE[selectedColIdx]?.toUpperCase() || '#5AC54F';
  const modalList = activeModal === 'shop' ? shopItems : savedBuilds;

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#081824] font-sans text-white select-none">
      {/* Dedicated WebGL Mount Container */}
      <div ref={canvasMountRef} className="w-full h-full" />

      {/* 1. TOP-LEFT BRAND & WORLD NAME INPUT */}
      <div className="absolute top-2.5 left-3.5 bg-[#0a1c2b]/95 border border-[#1e4968] rounded-lg px-3 py-2 flex items-center gap-2.5 shadow-lg">
        <span className="text-[#38e2ff] font-bold text-sm tracking-wide whitespace-nowrap">
          ♦ SANDBOX ♦
        </span>
        <input
          type="text"
          value={buildName}
          onChange={(e) => setBuildName(e.target.value)}
          placeholder="World Name"
          className="w-48 h-7 px-2 text-xs bg-[#081824] border border-[#1e4460] focus:border-[#38e2ff] rounded text-white outline-none"
        />
        <input
          type="text"
          value={buildPrice}
          onChange={(e) => setBuildPrice(e.target.value)}
          placeholder="Price (e.g. 250 SAND)"
          className="w-28 h-7 px-2 text-xs bg-[#081824] border border-[#1e4460] focus:border-[#38e2ff] rounded text-white outline-none"
        />
      </div>

      {/* 2. TOP-CENTER CAMERA, MY BUILDS & SHOP DOCK */}
      <div className="absolute top-14 left-64 bg-[#0a1c2b]/95 border border-[#1e4968] rounded-lg px-2.5 py-2 flex flex-col gap-1.5 shadow-lg">
        <div className="flex items-center gap-1.5">
          {[
            { label: 'FRONT', yaw: 0.0, pitch: -0.45 },
            { label: 'SIDE', yaw: 1.57, pitch: -0.45 },
            { label: 'ISO', yaw: 0.78, pitch: -0.55 },
          ].map((v) => (
            <button
              key={v.label}
              onClick={() => sceneActionsRef.current?.setCameraAngle(v.yaw, v.pitch)}
              className="px-2.5 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] transition-colors cursor-pointer"
            >
              {v.label}
            </button>
          ))}
          <button
            onClick={() => sceneActionsRef.current?.toggleOrtho()}
            className={`px-2.5 py-1 text-xs rounded border transition-colors cursor-pointer ${
              isOrtho
                ? 'bg-[#1589b8] border-[#38e2ff]'
                : 'bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff]'
            }`}
          >
            ORTHO
          </button>
          <button
            onClick={() => sceneActionsRef.current?.setGameMode(!isExploreMode)}
            className="px-3 py-1 text-xs font-medium rounded border bg-[#1589b8] border-[#38e2ff] hover:bg-[#1ba3d9] transition-colors cursor-pointer"
          >
            {isExploreMode ? '■ Edit Mode (TAB)' : '▶ Play / Explore'}
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setActiveModal('builds')}
            className="px-2.5 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] transition-colors cursor-pointer"
          >
            📁 My Builds ({savedBuilds.length})
          </button>
          <button
            onClick={() => setActiveModal('shop')}
            className="px-2.5 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] transition-colors cursor-pointer"
          >
            🛒 Shop ({shopItems.length})
          </button>
          <button
            onClick={handleSaveToMyBuilds}
            className="px-2.5 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] transition-colors cursor-pointer"
          >
            💾 Save
          </button>
          <button
            onClick={handlePublishToShop}
            className="px-2.5 py-1 text-xs rounded border bg-[#1589b8] border-[#38e2ff] hover:bg-[#1ba3d9] transition-colors cursor-pointer"
          >
            ☁ Publish to Shop
          </button>
          <button
            onClick={handleResetDefaultIsland}
            title="Reset Default Island"
            className="px-2 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] transition-colors cursor-pointer"
          >
            ↺ Reset
          </button>
        </div>
      </div>

      {/* 3. LEFT DOCK: VOXEL TOOLS */}
      <div className="absolute top-14 left-3.5 w-60 bg-[#0a1c2b]/95 border border-[#1e4968] rounded-lg p-3 flex flex-col gap-2.5 shadow-lg">
        <div className="flex items-center justify-between">
          <span className="text-[#38e2ff] font-semibold text-xs tracking-wider">VOXEL TOOLS</span>
          <span className="text-[#f5c242] font-medium text-xs">{cubeCount} Cubes</span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['add', 'Add Cube'],
              ['erase', 'Erase'],
              ['paint', 'Paint'],
              ['box', 'Box Fill'],
              ['column', 'Column'],
              ['eyedrop', 'Eyedrop'],
            ] as Array<[ToolId, string]>
          ).map(([tid, label]) => {
            const active = currentTool === tid;
            return (
              <button
                key={tid}
                onClick={() => setCurrentTool(tid)}
                className={`h-11 text-xs font-medium rounded border transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#1589b8] border-[#38e2ff] text-white'
                    : 'bg-[#102538] border-[#1e4460] text-white hover:bg-[#183752] hover:border-[#38e2ff]'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-slate-200">Brush Size:</span>
          <div className="flex items-center gap-1.5">
            {[1, 2, 3].map((sz) => (
              <button
                key={sz}
                onClick={() => setBrushSize(sz)}
                className={`px-2.5 py-1 text-xs rounded border transition-colors cursor-pointer ${
                  brushSize === sz
                    ? 'bg-[#1589b8] border-[#38e2ff]'
                    : 'bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff]'
                }`}
              >
                {sz}x
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-200">Mirror X-Axis:</span>
          <button
            onClick={() => setMirrorX((prev) => !prev)}
            className={`px-3 py-1 text-xs rounded border transition-colors cursor-pointer ${
              mirrorX
                ? 'bg-[#1589b8] border-[#38e2ff]'
                : 'bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff]'
            }`}
          >
            {mirrorX ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* 4. BOTTOM-LEFT CONTROLS & LIVE MINIMAP */}
      <div className="absolute top-[375px] left-3.5 w-60 bg-[#0a1c2b]/95 border border-[#1e4968] rounded-lg p-3 flex flex-col gap-2 shadow-lg">
        <div className="flex items-center justify-between">
          <span className="text-[#38e2ff] font-semibold text-xs">🎮 CONTROLS</span>
          <span className="text-[#f5c242] font-mono text-xs">{hoverCoords}</span>
        </div>

        <div className="flex flex-col gap-0.5 text-[11px] text-[#b8d4e8]">
          <span>L-Click Side/Top: Apply Tool</span>
          <span>R-Click Drag: Orbit Camera</span>
          <span>Explore: Mouse Drag to Turn</span>
          <span>WASD/ZQSD + Space: Move/Jump</span>
        </div>

        <div className="flex justify-center pt-1">
          <canvas
            ref={minimapCanvasRef}
            width={WORLD_SIZE}
            height={WORLD_SIZE}
            className="w-24 h-24 rounded border border-[#1e4968] bg-[#081824] [image-rendering:pixelated]"
          />
        </div>
      </div>

      {/* 5. RIGHT DOCK: CUBE TEXTURE & BIOME PALETTE */}
      <div className="absolute top-14 right-3.5 w-64 bg-[#0a1c2b]/95 border border-[#1e4968] rounded-lg p-3 flex flex-col gap-2.5 shadow-lg">
        <div className="flex items-center justify-between">
          <span className="text-[#38e2ff] font-semibold text-xs">CUBE TEXTURE</span>
          <span className="text-[11px] text-slate-200">{TEX_NAMES[selectedTexIdx]}</span>
        </div>

        <div className="grid grid-cols-4 gap-1.5">
          {TEX_SHORT.map((shortName, ti) => {
            const active = selectedTexIdx === ti;
            return (
              <button
                key={shortName}
                onClick={() => setSelectedTexIdx(ti)}
                className={`h-9 text-xs rounded border transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#1589b8] border-[#38e2ff]'
                    : 'bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff]'
                }`}
              >
                {shortName}
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-1">
          <span className="text-[#38e2ff] font-semibold text-xs">BIOME PALETTE</span>
          <span className="text-[#f5c242] font-mono text-xs">{selectedHex}</span>
        </div>

        <div className="flex flex-col gap-1.5">
          {BIOME_GROUPS.map((bg) => (
            <div key={bg.name} className="flex flex-col gap-1">
              <span className="text-[11px] text-[#9ab8d0]">{bg.name}</span>
              <div className="grid grid-cols-8 gap-1">
                {Array.from({ length: 8 }, (_, offset) => {
                  const cIdx = bg.startIdx + offset;
                  const hex = PALETTE[cIdx];
                  const isSelected = selectedColIdx === cIdx;
                  return (
                    <button
                      key={cIdx}
                      onClick={() => setSelectedColIdx(cIdx)}
                      style={{ backgroundColor: hex }}
                      title={hex.toUpperCase()}
                      className={`h-5 rounded-[3px] cursor-pointer transition-transform ${
                        isSelected
                          ? 'ring-2 ring-[#38e2ff] scale-105'
                          : 'border border-[#0a1926] hover:border-white'
                      }`}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 pt-1.5">
          <button
            onClick={handleSaveToMyBuilds}
            className="flex-1 py-1.5 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] transition-colors cursor-pointer"
          >
            💾 Save Build
          </button>
          <button
            onClick={() => setActiveModal('shop')}
            className="flex-1 py-1.5 text-xs rounded border bg-[#1589b8] border-[#38e2ff] hover:bg-[#1ba3d9] transition-colors cursor-pointer"
          >
            🛒 Open Shop
          </button>
        </div>
      </div>

      {/* 6. POPUP MODAL FOR "MY BUILDS" & "THE SANDBOX SHOP" */}
      {activeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55">
          <div className="w-[740px] max-w-[95vw] h-[460px] max-h-[90vh] bg-[#081726]/98 border-2 border-[#38e2ff] rounded-xl p-4 flex flex-col gap-3 shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#1e4968] pb-2.5">
              <span className="text-[#38e2ff] font-bold text-sm tracking-wide">
                {activeModal === 'shop'
                  ? '🛒 THE SANDBOX COMMUNITY SHOP (Publish & Buy Builds)'
                  : '📁 MY SAVED BUILDS (Save, Load & Edit)'}
              </span>
              <button
                onClick={() => setActiveModal(null)}
                className="px-3 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] cursor-pointer"
              >
                ✕ Close
              </button>
            </div>

            <div className="flex-1 overflow-y-auto pr-1">
              {modalList.length === 0 ? (
                <div className="h-full flex items-center justify-center text-sm text-[#9ab8d0]">
                  No builds saved yet! Enter a name in the top bar and click &apos;Save&apos;.
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  {modalList.map((item, idx) => {
                    const thumbUrl = createBuildThumbnailDataUrl(item.voxels);
                    return (
                      <div
                        key={`${item.name}-${idx}`}
                        className="bg-[#0f2436] border border-[#26b5d6] rounded-md p-2.5 flex flex-col gap-1.5"
                      >
                        <div className="w-full h-24 bg-[#081824] rounded flex items-center justify-center overflow-hidden border border-[#1e4460]">
                          <img
                            src={thumbUrl}
                            alt={item.name}
                            className="w-20 h-20 object-contain [image-rendering:pixelated]"
                          />
                        </div>
                        <div className="text-xs font-semibold text-white truncate">{item.name}</div>
                        <div className="text-[11px] text-[#f5c242] truncate">
                          {item.author} • {item.price} ({item.voxels.length} cubes)
                        </div>
                        <div className="flex items-center gap-1.5 pt-1 mt-auto">
                          <button
                            onClick={() => handleLoadVoxelBuild(item)}
                            className="flex-1 py-1.5 text-xs rounded border bg-[#1589b8] border-[#38e2ff] hover:bg-[#1ba3d9] cursor-pointer"
                          >
                            {activeModal === 'shop' ? '🛒 Buy & Edit' : '✎ Load & Edit'}
                          </button>
                          {activeModal === 'builds' && (
                            <button
                              onClick={() => handleDeleteSavedBuild(idx)}
                              title="Delete Build"
                              className="px-2.5 py-1.5 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-red-900/60 hover:border-red-400 cursor-pointer"
                            >
                              🗑
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
