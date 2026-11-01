import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  Box,
  PlusSquare,
  Eraser,
  Paintbrush,
  Grid,
  Columns,
  Pipette,
  Undo2,
  Play,
  Square,
  FolderOpen,
  ShoppingBag,
  Save,
  CloudUpload,
  RotateCcw,
  Sun,
  Moon,
  Volume2,
  VolumeX,
  Grid3X3,
  FlipHorizontal,
  Scaling,
  Gamepad2,
  Layers,
  Palette,
  SwatchBook,
  Camera,
  Eye,
  EyeOff,
  Compass,
  Trash2,
  X,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Sparkles,
  Activity,
  Cpu,
  Wrench,
  Map as MapIcon,
  SlidersHorizontal,
  Hand,
  Hammer,
  Clock,
  Download,
  FileText,
  Image as ImageIcon,
  ChevronLeft,
  Check,
} from 'lucide-react';
import {
  CHUNK_SIZE,
  WORLD_SIZE,
  PALETTE,
  TEX_NAMES,
  TEX_SHORT,
  BIOME_GROUPS,
  VoxelEntry,
  SavedBuild,
  normalizeHex,
  packVoxelHex,
  unpackVoxel,
  posKey,
  createPixelAtlasTexture,
  generateSandboxIslandData,
  generateFrostCitadelVoxels,
  serializeWorldMap,
  buildChunkGreedyGeometry,
  createBuildThumbnailDataUrl,
} from './voxel/voxelData';
import { AmbientMusicEngine } from './audio/ambientMusic';
import VoxelPreview3D from './components/VoxelPreview3D';

type ToolId = 'add' | 'erase' | 'paint' | 'box' | 'column' | 'eyedrop';
type BackgroundMode = 'classic' | 'sky';
type MobileTouchMode = 'build' | 'orbit';
type ModalMode = 'builds' | 'shop' | 'studio' | null;

const STORAGE_KEY = 'sandbox_workshop_store_v2';
const MAX_UNDO_STEPS = 20;
const TOTAL_CHUNKS = Math.pow(WORLD_SIZE / CHUNK_SIZE, 3); // 8 chunks (2x2x2)

// Pre-allocated vectors outside render loop to avoid GC
const _vec3A = new THREE.Vector3();
const _vec3B = new THREE.Vector3();
const _planeIntersect = new THREE.Vector3();

interface PerfStats {
  fps: number;
  activeChunks: number;
  totalChunks: number;
  memoryMB: string;
  triangles: number;
}

function formatTimeOfDay(hours: number): { timeStr: string; phase: string } {
  const h = Math.floor(hours) % 24;
  const m = Math.round((hours - Math.floor(hours)) * 60) % 60;
  const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  let phase = 'Night';
  if (hours >= 5.5 && hours < 8.0) phase = 'Sunrise';
  else if (hours >= 8.0 && hours < 16.5) phase = 'Daylight';
  else if (hours >= 16.5 && hours < 19.5) phase = 'Golden Hour';
  return { timeStr, phase };
}

/**
 * Creates a crisp 32x32 voxel-aligned grid with highlighted 16x16 chunk boundaries
 * and a subtle 3D build-volume bounding box.
 */
function createVoxelGridGroup(gridY: number): THREE.Group {
  const group = new THREE.Group();

  const minorPositions: number[] = [];
  const majorPositions: number[] = [];
  const yOffset = gridY + 0.015;

  for (let i = 0; i <= WORLD_SIZE; i++) {
    const isMajor = i % CHUNK_SIZE === 0;
    const target = isMajor ? majorPositions : minorPositions;

    target.push(i, yOffset, 0, i, yOffset, WORLD_SIZE);
    target.push(0, yOffset, i, WORLD_SIZE, yOffset, i);
  }

  const minorGeo = new THREE.BufferGeometry();
  minorGeo.setAttribute('position', new THREE.Float32BufferAttribute(minorPositions, 3));
  const minorMat = new THREE.LineBasicMaterial({
    color: '#26b5d6',
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });
  group.add(new THREE.LineSegments(minorGeo, minorMat));

  const majorGeo = new THREE.BufferGeometry();
  majorGeo.setAttribute('position', new THREE.Float32BufferAttribute(majorPositions, 3));
  const majorMat = new THREE.LineBasicMaterial({
    color: '#38e2ff',
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
  });
  group.add(new THREE.LineSegments(majorGeo, majorMat));

  const cornerPositions: number[] = [
    0, 0, 0, 0, WORLD_SIZE, 0,
    WORLD_SIZE, 0, 0, WORLD_SIZE, WORLD_SIZE, 0,
    0, 0, WORLD_SIZE, 0, WORLD_SIZE, WORLD_SIZE,
    WORLD_SIZE, 0, WORLD_SIZE, WORLD_SIZE, WORLD_SIZE, WORLD_SIZE,
  ];
  const cornerGeo = new THREE.BufferGeometry();
  cornerGeo.setAttribute('position', new THREE.Float32BufferAttribute(cornerPositions, 3));
  const cornerMat = new THREE.LineBasicMaterial({
    color: '#38e2ff',
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  group.add(new THREE.LineSegments(cornerGeo, cornerMat));

  return group;
}

/**
 * Creates a 3x3 local alignment grid helper that snaps onto the currently hovered voxel face
 */
function createLocalFaceGrid(): THREE.LineSegments {
  const pts: number[] = [];
  for (let i = -1.5; i <= 1.5; i += 1.0) {
    pts.push(i, 0, -1.5, i, 0, 1.5);
    pts.push(-1.5, 0, i, 1.5, 0, i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({
    color: '#ffe678',
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });
  return new THREE.LineSegments(geo, mat);
}

/**
 * Updates a 2D canvas sky gradient texture according to the time of day
 */
function updateSkyGradientCanvas(
  canvas: HTMLCanvasElement,
  tex: THREE.CanvasTexture,
  timeOfDay: number,
): { fogHex: string } {
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);

  // Compute day factor: -1 at midnight, 0 at 6:00/18:00, +1 at 12:00 noon
  const solarAngle = ((timeOfDay - 6) / 24) * Math.PI * 2;
  const sinElev = Math.sin(solarAngle);

  let topCol = '#1e69de';
  let midCol = '#57a8ff';
  let botCol = '#dff4ff';
  let fogHex = '#8ccaff';

  if (sinElev > 0.25) {
    // Full Daylight
    topCol = '#1e69de';
    midCol = '#57a8ff';
    botCol = '#dff4ff';
    fogHex = '#8ccaff';
  } else if (sinElev >= -0.15) {
    // Sunrise / Golden Hour / Sunset
    topCol = '#1f2b59';
    midCol = '#c85a53';
    botCol = '#ffbe6b';
    fogHex = '#d98a6c';
  } else {
    // Starry Night
    topCol = '#040b14';
    midCol = '#091b2e';
    botCol = '#122f4a';
    fogHex = '#091b2e';
  }

  grad.addColorStop(0.0, topCol);
  grad.addColorStop(0.52, midCol);
  grad.addColorStop(1.0, botCol);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  tex.needsUpdate = true;

  return { fogHex };
}

/**
 * Creates a 3D Voxel Sun + Corona Halo group + drifting 3D Voxel Clouds
 */
function createSunAndCloudsGroup(isSoftwareGl: boolean): {
  skyDecorGroup: THREE.Group;
  sunGroup: THREE.Group;
  cloudClusters: THREE.Group[];
  sunCoreMat: THREE.MeshBasicMaterial;
  sunInnerGlowMat: THREE.MeshBasicMaterial;
} {
  const skyDecorGroup = new THREE.Group();

  const sunGroup = new THREE.Group();
  const sunCoreMat = new THREE.MeshBasicMaterial({ color: '#fff9c4' });
  const sunInnerGlowMat = new THREE.MeshBasicMaterial({
    color: '#ffe066',
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  const sunOuterGlowMat = new THREE.MeshBasicMaterial({
    color: '#ffae34',
    transparent: true,
    opacity: 0.25,
    depthWrite: false,
  });

  const sunCore = new THREE.Mesh(new THREE.BoxGeometry(6.5, 6.5, 6.5), sunCoreMat);
  const sunHalo1 = new THREE.Mesh(new THREE.BoxGeometry(9.8, 9.8, 9.8), sunInnerGlowMat);
  const sunHalo2 = new THREE.Mesh(new THREE.BoxGeometry(13.5, 13.5, 13.5), sunOuterGlowMat);
  sunGroup.add(sunCore, sunHalo1, sunHalo2);
  sunGroup.position.set(52, 54, -48);
  sunGroup.lookAt(16, 10, 16);
  skyDecorGroup.add(sunGroup);

  const cloudMat = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.92,
    metalness: 0.0,
    transparent: true,
    opacity: 0.92,
  });
  const cloudBottomMat = new THREE.MeshStandardMaterial({
    color: '#d8ecff',
    roughness: 0.95,
    metalness: 0.0,
  });

  const cloudSpecs: Array<{ x: number; y: number; z: number; scale: number }> = [
    { x: -18, y: 29, z: -12, scale: 1.1 },
    { x: 12, y: 32, z: -24, scale: 1.35 },
    { x: 42, y: 28, z: -8, scale: 0.95 },
    { x: -10, y: 31, z: 22, scale: 1.25 },
    { x: 26, y: 33, z: 36, scale: 1.15 },
    { x: 54, y: 30, z: 18, scale: 1.0 },
    { x: -28, y: 30, z: 8, scale: 1.2 },
    { x: 8, y: 27, z: -38, scale: 0.9 },
  ];

  const cloudClusters: THREE.Group[] = [];

  for (const spec of cloudSpecs) {
    const cluster = new THREE.Group();

    const mainBody = new THREE.Mesh(new THREE.BoxGeometry(8, 1.8, 4.5), cloudMat);
    mainBody.position.set(0, 0.4, 0);
    mainBody.castShadow = !isSoftwareGl;
    cluster.add(mainBody);

    const topPuff = new THREE.Mesh(new THREE.BoxGeometry(4.8, 1.4, 3.2), cloudMat);
    topPuff.position.set(-0.6, 1.4, 0.2);
    cluster.add(topPuff);

    const sidePuffL = new THREE.Mesh(new THREE.BoxGeometry(3.5, 1.3, 3.4), cloudMat);
    sidePuffL.position.set(-3.4, 0.1, 0.6);
    cluster.add(sidePuffL);

    const sidePuffR = new THREE.Mesh(new THREE.BoxGeometry(3.8, 1.4, 3.2), cloudMat);
    sidePuffR.position.set(3.2, 0.2, -0.5);
    cluster.add(sidePuffR);

    const underShadow = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.45, 4.0), cloudBottomMat);
    underShadow.position.set(0, -0.55, 0);
    cluster.add(underShadow);

    cluster.position.set(spec.x, spec.y, spec.z);
    cluster.scale.setScalar(spec.scale);
    skyDecorGroup.add(cluster);
    cloudClusters.push(cluster);
  }

  return { skyDecorGroup, sunGroup, cloudClusters, sunCoreMat, sunInnerGlowMat };
}

export default function App() {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const musicEngineRef = useRef<AmbientMusicEngine | null>(null);

  // Responsive viewport detection
  const [isMobileView, setIsMobileView] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  );

  // HUD Panel Visibility States
  const [showToolsHud, setShowToolsHud] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 768 : true,
  );
  const [showPaletteHud, setShowPaletteHud] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 768 : false,
  );
  const [showWorldHud, setShowWorldHud] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 768 : true,
  );
  const [showMinimapHud, setShowMinimapHud] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 768 : false,
  );
  const [showPerfHud, setShowPerfHud] = useState<boolean>(true);

  // Mobile Touch Mode ('build' vs 'orbit')
  const [mobileTouchMode, setMobileTouchMode] = useState<MobileTouchMode>('build');

  // Performance Telemetry State
  const [perfStats, setPerfStats] = useState<PerfStats>({
    fps: 60,
    activeChunks: 8,
    totalChunks: TOTAL_CHUNKS,
    memoryMB: '24.5',
    triangles: 0,
  });

  // UI State
  const [isExploreMode, setIsExploreMode] = useState(false);
  const [isThirdPerson, setIsThirdPerson] = useState(true);
  const [currentTool, setCurrentTool] = useState<ToolId>('add');
  const [selectedColIdx, setSelectedColIdx] = useState<number>(1);
  const [customHex, setCustomHex] = useState<string>(PALETTE[1]);
  const [hexInputText, setHexInputText] = useState<string>(PALETTE[1].toUpperCase());
  const [paletteColors, setPaletteColors] = useState<string[]>([...PALETTE]);
  const [selectedTexIdx, setSelectedTexIdx] = useState<number>(0);
  const [brushSize, setBrushSize] = useState<number>(1);
  const [mirrorX, setMirrorX] = useState<boolean>(false);
  const [showGrid, setShowGrid] = useState<boolean>(true);
  const [gridLevelY, setGridLevelY] = useState<number>(11);
  const [isOrtho, setIsOrtho] = useState<boolean>(true);
  const [cubeCount, setCubeCount] = useState<number>(0);
  const [hoverCoords, setHoverCoords] = useState<string>('0, 0, 0');

  // Time of Day & Sun Position State (0.0 to 24.0 hours)
  const [timeOfDay, setTimeOfDay] = useState<number>(13.5);

  // Undo Stack State (tracks up to 20 snapshots of worldData)
  const undoStackRef = useRef<Array<Map<string, number>>>([]);
  const [undoCount, setUndoCount] = useState<number>(0);

  // Sky & Music State
  const [bgMode, setBgMode] = useState<BackgroundMode>('sky');
  const [isMusicPlaying, setIsMusicPlaying] = useState<boolean>(false);

  // Builds, Shop & Screenshot/Save Studio State
  const [buildName, setBuildName] = useState<string>('Four-Biome Floating Island');
  const [buildPrice, setBuildPrice] = useState<string>('250 SAND');
  const [savedBuilds, setSavedBuilds] = useState<SavedBuild[]>([]);
  const [shopItems, setShopItems] = useState<SavedBuild[]>([]);
  const [activeModal, setActiveModal] = useState<ModalMode>(null);
  const [selectedBuildDetail, setSelectedBuildDetail] = useState<SavedBuild | null>(null);

  // Studio Modal Form State (Name, Bio, Image, 3D Rotatable Preview)
  const [studioVoxels, setStudioVoxels] = useState<VoxelEntry[]>([]);
  const [studioName, setStudioName] = useState<string>('Four-Biome Floating Island');
  const [studioBio, setStudioBio] = useState<string>(
    'A custom floating island crafted in The Sandbox Voxel Workshop featuring multi-biome terrain and structures.',
  );
  const [studioPrice, setStudioPrice] = useState<string>('250 SAND');
  const [studioImageUrl, setStudioImageUrl] = useState<string>('');
  const [studioYaw, setStudioYaw] = useState<number>(0.785);
  const [studioPitch, setStudioPitch] = useState<number>(-0.52);
  const [studioSnapNotice, setStudioSnapNotice] = useState<boolean>(false);

  // Mobile Virtual D-Pad Ref for Explore Mode
  const mobileInputRef = useRef({
    up: false,
    down: false,
    left: false,
    right: false,
  });

  // Mutable refs for event handlers & Three.js loop
  const worldDataRef = useRef<Map<string, number>>(new Map());
  const stateRef = useRef({
    isExploreMode: false,
    isThirdPerson: true,
    currentTool: 'add' as ToolId,
    selectedColIdx: 1,
    customHex: PALETTE[1],
    selectedTexIdx: 0,
    brushSize: 1,
    mirrorX: false,
    showGrid: true,
    gridLevelY: 11,
    bgMode: 'sky' as BackgroundMode,
    timeOfDay: 13.5,
    mobileTouchMode: 'build' as MobileTouchMode,
    modalOpen: false,
  });

  useEffect(() => {
    stateRef.current = {
      isExploreMode,
      isThirdPerson,
      currentTool,
      selectedColIdx,
      customHex,
      selectedTexIdx,
      brushSize,
      mirrorX,
      showGrid,
      gridLevelY,
      bgMode,
      timeOfDay,
      mobileTouchMode,
      modalOpen: activeModal !== null,
    };
  }, [
    isExploreMode,
    isThirdPerson,
    currentTool,
    selectedColIdx,
    customHex,
    selectedTexIdx,
    brushSize,
    mirrorX,
    showGrid,
    gridLevelY,
    bgMode,
    timeOfDay,
    mobileTouchMode,
    activeModal,
  ]);

  // Camera & scene control refs exposed to UI buttons
  const sceneActionsRef = useRef<{
    rebuildAllChunks: () => void;
    setCameraAngle: (yaw: number, pitch: number) => void;
    toggleOrtho: () => void;
    setGameMode: (explore: boolean) => void;
    triggerJump: () => void;
    updateGridAppearance: (visible: boolean, yLevel: number) => void;
    updateSunAndEnvironment: (mode: BackgroundMode, hours: number) => void;
    performUndo: () => void;
    captureMainCanvasScreenshot: () => string;
  } | null>(null);

  // On mobile, toggling one main drawer closes the others so the screen never gets cluttered
  const toggleHudPanel = useCallback(
    (panel: 'tools' | 'palette' | 'world' | 'minimap' | 'perf') => {
      if (panel === 'perf') {
        setShowPerfHud((p) => !p);
        return;
      }
      if (isMobileView) {
        setShowToolsHud(panel === 'tools' ? !showToolsHud : false);
        setShowPaletteHud(panel === 'palette' ? !showPaletteHud : false);
        setShowWorldHud(panel === 'world' ? !showWorldHud : false);
        setShowMinimapHud(panel === 'minimap' ? !showMinimapHud : false);
      } else {
        if (panel === 'tools') setShowToolsHud((p) => !p);
        else if (panel === 'palette') setShowPaletteHud((p) => !p);
        else if (panel === 'world') setShowWorldHud((p) => !p);
        else if (panel === 'minimap') setShowMinimapHud((p) => !p);
      }
    },
    [isMobileView, showToolsHud, showPaletteHud, showWorldHud, showMinimapHud],
  );

  const anyPanelOpen = showToolsHud || showPaletteHud || showWorldHud || showMinimapHud;
  const toggleAllPanels = useCallback(() => {
    if (anyPanelOpen) {
      setShowToolsHud(false);
      setShowPaletteHud(false);
      setShowWorldHud(false);
      setShowMinimapHud(false);
    } else {
      if (isMobileView) {
        setShowToolsHud(true);
      } else {
        setShowToolsHud(true);
        setShowPaletteHud(true);
        setShowWorldHud(true);
        setShowMinimapHud(true);
      }
    }
  }, [anyPanelOpen, isMobileView]);

  // Push current worldData onto the Undo stack (max 20 snapshots)
  const pushUndoSnapshot = useCallback(() => {
    const snapshot = new Map<string, number>(worldDataRef.current);
    const stack = undoStackRef.current;
    stack.push(snapshot);
    if (stack.length > MAX_UNDO_STEPS) {
      stack.shift();
    }
    setUndoCount(stack.length);
  }, []);

  const handleUndo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const prevSnapshot = stack.pop()!;
    worldDataRef.current = prevSnapshot;
    setUndoCount(stack.length);
    sceneActionsRef.current?.rebuildAllChunks();
  }, []);

  // Initialize & clean up Ambient Music Engine
  useEffect(() => {
    musicEngineRef.current = new AmbientMusicEngine();
    return () => {
      musicEngineRef.current?.dispose();
    };
  }, []);

  const toggleMusic = useCallback(() => {
    if (!musicEngineRef.current) return;
    if (isMusicPlaying) {
      musicEngineRef.current.stop();
      setIsMusicPlaying(false);
    } else {
      musicEngineRef.current.start();
      setIsMusicPlaying(true);
    }
  }, [isMusicPlaying]);

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
            const { hex } = unpackVoxel(val);
            ctx.fillStyle = hex;
            ctx.fillRect(x, z, 1, 1);
            break;
          }
        }
      }
    }
  }, []);

  // Re-draw minimap whenever the minimap panel becomes visible
  useEffect(() => {
    if (showMinimapHud) {
      updateMinimap();
    }
  }, [showMinimapHud, updateMinimap]);

  const persistStorage = useCallback((builds: SavedBuild[], shop: SavedBuild[]) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ builds, shop }));
    } catch {
      // Ignore storage quota errors
    }
  }, []);

  // Sync grid visibility and height when toggled from React UI
  useEffect(() => {
    sceneActionsRef.current?.updateGridAppearance(showGrid && !isExploreMode, gridLevelY);
  }, [showGrid, gridLevelY, isExploreMode]);

  // Sync sun position, time of day, and background mode
  useEffect(() => {
    sceneActionsRef.current?.updateSunAndEnvironment(bgMode, timeOfDay);
  }, [bgMode, timeOfDay]);

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
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(
      mount.clientWidth || window.innerWidth,
      mount.clientHeight || window.innerHeight,
    );
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.tabIndex = 0;
    renderer.domElement.style.outline = 'none';
    renderer.domElement.style.touchAction = 'none';
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const classicBgColor = new THREE.Color('#0b263b');

    const skyCanvas = document.createElement('canvas');
    skyCanvas.width = 16;
    skyCanvas.height = 256;
    const skyGradientTexture = new THREE.CanvasTexture(skyCanvas);
    skyGradientTexture.colorSpace = THREE.SRGBColorSpace;

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();

    // Sky & Studio Lighting
    const hemiLight = new THREE.HemisphereLight('#d1e6fa', '#061b2d', 0.85);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight('#fff8eb', 1.35);
    dirLight.position.set(22, 36, 24);
    dirLight.target.position.set(16, 10, 16);
    scene.add(dirLight.target);
    dirLight.castShadow = !isSoftwareGl;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    dirLight.shadow.camera.near = 5;
    dirLight.shadow.camera.far = 110;
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

    // 3D Sun & Moving Clouds Group
    const { skyDecorGroup, sunGroup, cloudClusters, sunCoreMat, sunInnerGlowMat } =
      createSunAndCloudsGroup(isSoftwareGl);
    scene.add(skyDecorGroup);

    /**
     * Dynamically updates Sun position, directional light, shadow casting, and sky colors
     * from `timeOfDay` (0..24) and `bgMode`.
     */
    const applySunAndEnvironment = (mode: BackgroundMode, hours: number) => {
      // Solar angle: 6:00 = sunrise (0 rad), 12:00 = zenith (PI/2), 18:00 = sunset (PI), 24:00 = midnight (3PI/2)
      const solarAngle = ((hours - 6.0) / 24.0) * Math.PI * 2.0;
      const orbitRadius = 62.0;
      const sunX = 16 + Math.cos(solarAngle) * orbitRadius;
      const sunY = 10 + Math.sin(solarAngle) * orbitRadius;
      const sunZ = 16 - Math.sin(solarAngle * 0.5) * 28.0;

      sunGroup.position.set(sunX, sunY, sunZ);
      sunGroup.lookAt(16, 10, 16);

      const sinElev = Math.sin(solarAngle);
      const isDaytime = sinElev >= -0.08;

      if (isDaytime) {
        // Sun is above or near horizon: cast directional shadows from sun position
        const lightScale = 0.65;
        dirLight.position.set(
          16 + (sunX - 16) * lightScale,
          Math.max(16, 10 + (sunY - 10) * lightScale),
          16 + (sunZ - 16) * lightScale,
        );
        dirLight.castShadow = !isSoftwareGl;

        if (sinElev < 0.28) {
          // Sunrise / Golden Hour warm orange sun
          dirLight.color.set('#ff9e58');
          dirLight.intensity = THREE.MathUtils.lerp(0.45, 1.25, (sinElev + 0.08) / 0.36);
          sunCoreMat.color.set('#ffd27d');
          sunInnerGlowMat.color.set('#ff7b38');
        } else {
          // Midday crisp warm sunlight
          dirLight.color.set('#fff8eb');
          dirLight.intensity = THREE.MathUtils.lerp(1.25, 1.55, (sinElev - 0.28) / 0.72);
          sunCoreMat.color.set('#fff9c4');
          sunInnerGlowMat.color.set('#ffe066');
        }
      } else {
        // Nighttime: cool moonlight from opposite arc
        dirLight.position.set(
          16 - (sunX - 16) * 0.55,
          Math.max(20, 10 - (sunY - 10) * 0.55),
          16 - (sunZ - 16) * 0.55,
        );
        dirLight.color.set('#6aa2ff');
        dirLight.intensity = 0.38;
        dirLight.castShadow = !isSoftwareGl;
      }

      if (mode === 'sky') {
        const { fogHex } = updateSkyGradientCanvas(skyCanvas, skyGradientTexture, hours);
        scene.background = skyGradientTexture;
        scene.fog = new THREE.FogExp2(fogHex, 0.0042);
        skyDecorGroup.visible = true;

        if (sinElev > 0.2) {
          hemiLight.color.set('#ffffff');
          hemiLight.groundColor.set('#3d6e8f');
          hemiLight.intensity = 0.95;
        } else if (sinElev >= -0.15) {
          hemiLight.color.set('#ffbfa0');
          hemiLight.groundColor.set('#382942');
          hemiLight.intensity = 0.72;
        } else {
          hemiLight.color.set('#38598a');
          hemiLight.groundColor.set('#081526');
          hemiLight.intensity = 0.45;
        }
      } else {
        scene.background = classicBgColor;
        scene.fog = new THREE.FogExp2('#0b263b', 0.0065);
        skyDecorGroup.visible = false;
        hemiLight.color.set('#d1e6fa');
        hemiLight.groundColor.set('#061b2d');
        hemiLight.intensity = isDaytime ? 0.85 : 0.48;
      }
    };
    applySunAndEnvironment(stateRef.current.bgMode, stateRef.current.timeOfDay);

    // Visual Grid Overlay for Edit Mode
    let gridOverlayGroup = createVoxelGridGroup(11);
    scene.add(gridOverlayGroup);

    const localFaceGrid = createLocalFaceGrid();
    localFaceGrid.visible = false;
    scene.add(localFaceGrid);

    // Cameras: Orthographic & Perspective for Editor + Perspective for Player
    const width = mount.clientWidth || window.innerWidth;
    const height = mount.clientHeight || window.innerHeight;
    const aspect = width / height;

    const orthoCam = new THREE.OrthographicCamera(-14 * aspect, 14 * aspect, 14, -14, 0.1, 400);
    const perspCam = new THREE.PerspectiveCamera(50, aspect, 0.1, 400);
    const playerCam = new THREE.PerspectiveCamera(70, aspect, 0.1, 400);

    // Editor Camera Orbit State
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

    // Chunks container
    const chunksGroup = new THREE.Group();
    scene.add(chunksGroup);
    const chunkMeshes = new Map<string, THREE.Mesh>();
    let totalTrianglesCount = 0;

    const rebuildAllChunks = () => {
      const numChunks = WORLD_SIZE / CHUNK_SIZE;
      totalTrianglesCount = 0;
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
            const vertCount = geom.attributes.position.count;
            if (vertCount > 0) {
              totalTrianglesCount += Math.floor(vertCount / 3);
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

    // Cursor Preview Box
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

    // Composite Voxel Explorer Character Model
    const playerGroup = new THREE.Group();
    const torsoMat = new THREE.MeshStandardMaterial({ color: '#1589b8', roughness: 0.45, metalness: 0.15 });
    const trimMat = new THREE.MeshStandardMaterial({ color: '#38e2ff', roughness: 0.25, metalness: 0.4 });
    const headMat = new THREE.MeshStandardMaterial({ color: '#ffe678', roughness: 0.65, metalness: 0.05 });
    const darkMat = new THREE.MeshStandardMaterial({ color: '#0f2436', roughness: 0.2, metalness: 0.7 });
    const packMat = new THREE.MeshStandardMaterial({ color: '#ff5232', roughness: 0.5, metalness: 0.25 });

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.62, 0.28), torsoMat);
    torso.position.set(0, 0.86, 0);
    torso.castShadow = !isSoftwareGl;
    playerGroup.add(torso);

    const chestBadge = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.18, 0.04), trimMat);
    chestBadge.position.set(0, 0.92, -0.15);
    playerGroup.add(chestBadge);

    const headMesh = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.44, 0.44), headMat);
    headMesh.position.set(0, 1.42, 0);
    headMesh.castShadow = !isSoftwareGl;
    playerGroup.add(headMesh);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.14, 0.06), darkMat);
    visor.position.set(0, 1.44, -0.21);
    playerGroup.add(visor);

    const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.44, 0.16), packMat);
    backpack.position.set(0, 0.88, 0.2);
    playerGroup.add(backpack);

    const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.52, 0.16), trimMat);
    leftArm.position.set(-0.35, 0.86, 0);
    playerGroup.add(leftArm);

    const rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.52, 0.16), trimMat);
    rightArm.position.set(0.35, 0.86, 0);
    playerGroup.add(rightArm);

    const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.55, 0.2), darkMat);
    leftLeg.position.set(-0.13, 0.275, 0);
    playerGroup.add(leftLeg);

    const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.55, 0.2), darkMat);
    rightLeg.position.set(0.13, 0.275, 0);
    playerGroup.add(rightLeg);

    playerGroup.visible = false;
    scene.add(playerGroup);

    // Player Physics State
    const playerState = {
      pos: new THREE.Vector3(16.5, 12, 18.5),
      vel: new THREE.Vector3(0, 0, 0),
      yaw: 0,
      pitch: -0.25,
      onFloor: false,
      coyoteTimer: 0,
      jumpQueued: false,
      isDraggingLook: false,
      walkCycle: 0,
    };

    const findSafeSpawnPosition = (): THREE.Vector3 => {
      const candidates: Array<[number, number]> = [
        [16, 18],
        [16, 17],
        [15, 18],
        [16, 16],
        [12, 12],
      ];
      for (const [cx, cz] of candidates) {
        for (let y = WORLD_SIZE - 2; y >= 1; y--) {
          const val = worldDataRef.current.get(posKey(cx, y, cz));
          const above1 = worldDataRef.current.get(posKey(cx, y + 1, cz));
          const above2 = worldDataRef.current.get(posKey(cx, y + 2, cz));
          if (val && !above1 && !above2) {
            return new THREE.Vector3(cx + 0.5, y + 1.001, cz + 0.5);
          }
        }
      }
      return new THREE.Vector3(16.5, 18.0, 18.5);
    };

    // Generate Initial Island & Load Storage
    worldDataRef.current = generateSandboxIslandData();
    rebuildAllChunks();

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          parsed &&
          Array.isArray(parsed.builds) &&
          Array.isArray(parsed.shop) &&
          parsed.shop.length > 0
        ) {
          setSavedBuilds(parsed.builds);
          setShopItems(parsed.shop);
        } else {
          throw new Error('Initialize defaults');
        }
      } else {
        throw new Error('Initialize defaults');
      }
    } catch {
      const islandVoxels = serializeWorldMap(worldDataRef.current);
      const citadelVoxels = generateFrostCitadelVoxels();
      const defaultShop: SavedBuild[] = [
        {
          name: 'Four-Biome Floating Island',
          author: '@TheSandboxOfficial',
          price: '450 SAND',
          bio: 'An enchanted floating island where Frost Crystal spires, an active Magma volcano, a Golden Desert pyramid, and an ancient Forest grove meet around a central obsidian obelisk.',
          imageUrl: createBuildThumbnailDataUrl(islandVoxels),
          previewYaw: 0.785,
          previewPitch: -0.52,
          voxels: islandVoxels,
        },
        {
          name: 'Frost Crystal Citadel',
          author: '@VoxelArchitect',
          price: '180 SAND',
          bio: 'A fortified glacial stronghold carved from pure frost crystals with crenelated ice ramparts and a towering central crystal spire.',
          imageUrl: createBuildThumbnailDataUrl(citadelVoxels),
          previewYaw: 0.65,
          previewPitch: -0.48,
          voxels: citadelVoxels,
        },
      ];
      setShopItems(defaultShop);
      persistStorage([], defaultShop);
    }

    // Voxel Setter Helpers
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
      const {
        currentTool: tool,
        selectedColIdx: colIdx,
        customHex: activeHex,
        selectedTexIdx: texIdx,
        brushSize: bSize,
      } = stateRef.current;

      const insideP = _vec3A.copy(hitPos).addScaledVector(snappedNormal, -0.5);
      const outsideP = _vec3B.copy(hitPos).addScaledVector(snappedNormal, 0.5);

      const ix = Math.floor(insideP.x);
      const iy = Math.floor(insideP.y);
      const iz = Math.floor(insideP.z);
      const ox = Math.floor(outsideP.x);
      const oy = Math.floor(outsideP.y);
      const oz = Math.floor(outsideP.z);

      const packed = packVoxelHex(activeHex, texIdx, colIdx);
      const r = bSize - 1;

      if (tool === 'eyedrop') {
        const v = worldDataRef.current.get(posKey(ix, iy, iz));
        if (v !== undefined && v !== 0) {
          const unpacked = unpackVoxel(v);
          setSelectedColIdx(unpacked.colIdx);
          setCustomHex(unpacked.hex);
          setHexInputText(unpacked.hex.toUpperCase());
          setSelectedTexIdx(unpacked.texIdx);
        }
        return;
      }

      pushUndoSnapshot();

      if (tool === 'erase') {
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
    const gridMathPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -11);
    let lastHoverRaycast = 0;

    const updateLocalFaceGridTransform = (
      bx: number,
      by: number,
      bz: number,
      snappedNormal: THREE.Vector3,
    ) => {
      if (!stateRef.current.showGrid) {
        localFaceGrid.visible = false;
        return;
      }
      localFaceGrid.visible = true;
      const tool = stateRef.current.currentTool;
      const isInside = tool === 'erase' || tool === 'paint' || tool === 'eyedrop';
      const faceCenter = new THREE.Vector3(bx + 0.5, by + 0.5, bz + 0.5).addScaledVector(
        snappedNormal,
        isInside ? 0.51 : -0.49,
      );
      localFaceGrid.position.copy(faceCenter);
      localFaceGrid.rotation.set(0, 0, 0);
      if (Math.abs(snappedNormal.x) > 0.5) {
        localFaceGrid.rotation.z = Math.PI / 2;
      } else if (Math.abs(snappedNormal.z) > 0.5) {
        localFaceGrid.rotation.x = Math.PI / 2;
      }
    };

    const performRaycastTool = (clientX: number, clientY: number, isClick: boolean) => {
      if (stateRef.current.isExploreMode || stateRef.current.modalOpen) {
        cursorBox.visible = false;
        localFaceGrid.visible = false;
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
        if (n.dot(raycaster.ray.direction) > 0) {
          n.negate();
        }

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
          applyToolAt(hit.point, snappedNormal);
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
          updateLocalFaceGridTransform(bx, by, bz, snappedNormal);
          setHoverCoords(`${bx - 16}, ${by - 10}, ${bz - 16}`);
        }
        return;
      }

      // Fallback: if visual grid is shown and a placement tool is active, intersect the grid plane
      const tool = stateRef.current.currentTool;
      const canBuildOnGrid =
        stateRef.current.showGrid && (tool === 'add' || tool === 'box' || tool === 'column');

      if (canBuildOnGrid) {
        gridMathPlane.constant = -stateRef.current.gridLevelY;
        const hitGrid = raycaster.ray.intersectPlane(gridMathPlane, _planeIntersect);
        if (hitGrid) {
          const gx = Math.floor(hitGrid.x);
          const gy = stateRef.current.gridLevelY;
          const gz = Math.floor(hitGrid.z);
          if (
            gx >= 0 &&
            gx < WORLD_SIZE &&
            gy >= 0 &&
            gy < WORLD_SIZE &&
            gz >= 0 &&
            gz < WORLD_SIZE
          ) {
            const upNormal = new THREE.Vector3(0, 1, 0);
            if (isClick) {
              const fakeHitPoint = new THREE.Vector3(gx + 0.5, gy, gz + 0.5);
              applyToolAt(fakeHitPoint, upNormal);
            } else {
              cursorBox.visible = true;
              cursorBox.position.set(gx + 0.5, gy + 0.5, gz + 0.5);
              updateLocalFaceGridTransform(gx, gy, gz, upNormal);
              setHoverCoords(`${gx - 16}, ${gy - 10}, ${gz - 16}`);
            }
            return;
          }
        }
      }

      cursorBox.visible = false;
      localFaceGrid.visible = false;
    };

    // Mouse, Touch & Keyboard Input Listeners
    const keysPressed = new Set<string>();

    const onMouseDown = (e: MouseEvent) => {
      if (stateRef.current.modalOpen) return;
      renderer.domElement.focus();

      if (stateRef.current.isExploreMode) {
        if (e.button === 0 || e.button === 2) {
          playerState.isDraggingLook = true;
        }
        return;
      }

      if (e.button === 2) {
        camState.isOrbiting = true;
      } else if (e.button === 0) {
        if (window.innerWidth < 768 && stateRef.current.mobileTouchMode === 'orbit') {
          camState.isOrbiting = true;
        } else {
          performRaycastTool(e.clientX, e.clientY, true);
        }
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (stateRef.current.modalOpen) return;

      if (stateRef.current.isExploreMode) {
        if (playerState.isDraggingLook || document.pointerLockElement === renderer.domElement) {
          playerState.yaw -= e.movementX * 0.005;
          playerState.pitch = THREE.MathUtils.clamp(
            playerState.pitch - e.movementY * 0.005,
            THREE.MathUtils.degToRad(-75),
            THREE.MathUtils.degToRad(75),
          );
        }
        return;
      }

      if (camState.isOrbiting) {
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

    const onMouseUp = () => {
      camState.isOrbiting = false;
      playerState.isDraggingLook = false;
    };

    // Mobile Touch Support (1-finger tap/orbit + 2-finger pinch zoom)
    let touchStartPos = { x: 0, y: 0 };
    let lastTouchPos = { x: 0, y: 0 };
    let touchMoved = false;
    let initialPinchDist = 0;
    let initialCamDist = 42.0;

    const onTouchStart = (e: TouchEvent) => {
      if (stateRef.current.modalOpen) return;
      if (e.touches.length === 1) {
        const t = e.touches[0];
        touchStartPos = { x: t.clientX, y: t.clientY };
        lastTouchPos = { x: t.clientX, y: t.clientY };
        touchMoved = false;
        if (!stateRef.current.isExploreMode) {
          performRaycastTool(t.clientX, t.clientY, false);
        }
      } else if (e.touches.length === 2) {
        touchMoved = true;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        initialPinchDist = Math.hypot(dx, dy);
        initialCamDist = camState.targetDistance;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (stateRef.current.modalOpen) return;
      e.preventDefault();

      if (e.touches.length === 2 && !stateRef.current.isExploreMode) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        if (initialPinchDist > 10) {
          const scale = initialPinchDist / dist;
          camState.targetDistance = THREE.MathUtils.clamp(initialCamDist * scale, 12.0, 75.0);
        }
        return;
      }

      if (e.touches.length === 1) {
        const t = e.touches[0];
        const moveDx = t.clientX - lastTouchPos.x;
        const moveDy = t.clientY - lastTouchPos.y;
        lastTouchPos = { x: t.clientX, y: t.clientY };

        if (Math.hypot(t.clientX - touchStartPos.x, t.clientY - touchStartPos.y) > 8) {
          touchMoved = true;
        }

        if (stateRef.current.isExploreMode) {
          playerState.yaw -= moveDx * 0.006;
          playerState.pitch = THREE.MathUtils.clamp(
            playerState.pitch - moveDy * 0.006,
            THREE.MathUtils.degToRad(-75),
            THREE.MathUtils.degToRad(75),
          );
        } else if (touchMoved) {
          camState.targetYaw -= moveDx * 0.009;
          camState.targetPitch = THREE.MathUtils.clamp(
            camState.targetPitch - moveDy * 0.009,
            -1.4,
            -0.1,
          );
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (stateRef.current.modalOpen) return;
      if (
        !touchMoved &&
        e.changedTouches.length === 1 &&
        !stateRef.current.isExploreMode &&
        stateRef.current.mobileTouchMode === 'build'
      ) {
        const t = e.changedTouches[0];
        performRaycastTool(t.clientX, t.clientY, true);
      }
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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        sceneActionsRef.current?.performUndo();
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        playerState.jumpQueued = true;
      }

      if (
        e.code === 'ArrowUp' ||
        e.code === 'ArrowDown' ||
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight'
      ) {
        e.preventDefault();
      }

      keysPressed.add(e.code);

      if (e.code === 'Tab') {
        e.preventDefault();
        sceneActionsRef.current?.setGameMode(!stateRef.current.isExploreMode);
      } else if (e.code === 'KeyG' && !stateRef.current.isExploreMode) {
        setShowGrid((prev) => !prev);
      } else if (e.code === 'KeyV' && stateRef.current.isExploreMode) {
        setIsThirdPerson((prev) => !prev);
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
    domElem.addEventListener('touchstart', onTouchStart, { passive: false });
    domElem.addEventListener('touchmove', onTouchMove, { passive: false });
    domElem.addEventListener('touchend', onTouchEnd);
    domElem.addEventListener('wheel', onWheel, { passive: false });
    domElem.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const onResize = () => {
      const w = mount.clientWidth || window.innerWidth;
      const h = mount.clientHeight || window.innerHeight;
      setIsMobileView(w < 768);
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
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        renderer.domElement.focus();

        setIsExploreMode(explore);
        stateRef.current.isExploreMode = explore;
        cursorBox.visible = false;
        localFaceGrid.visible = false;
        gridOverlayGroup.visible = !explore && stateRef.current.showGrid;
        playerGroup.visible = explore;

        if (explore) {
          const spawn = findSafeSpawnPosition();
          playerState.pos.copy(spawn);
          playerState.vel.set(0, 0, 0);
          playerState.yaw = 0;
          playerState.pitch = -0.25;
          playerState.onFloor = true;
          playerState.coyoteTimer = 0.2;
          playerState.jumpQueued = false;
        } else {
          if (document.pointerLockElement === renderer.domElement) {
            document.exitPointerLock?.();
          }
        }
      },
      triggerJump: () => {
        playerState.jumpQueued = true;
        renderer.domElement.focus();
      },
      updateGridAppearance: (visible: boolean, yLevel: number) => {
        scene.remove(gridOverlayGroup);
        gridOverlayGroup.traverse((obj) => {
          if (obj instanceof THREE.LineSegments) {
            obj.geometry.dispose();
            if (obj.material instanceof THREE.Material) obj.material.dispose();
          }
        });
        gridOverlayGroup = createVoxelGridGroup(yLevel);
        gridOverlayGroup.visible = visible;
        scene.add(gridOverlayGroup);
      },
      updateSunAndEnvironment: (mode: BackgroundMode, hours: number) => {
        applySunAndEnvironment(mode, hours);
      },
      performUndo: () => {
        const stack = undoStackRef.current;
        if (stack.length === 0) return;
        const prevSnapshot = stack.pop()!;
        worldDataRef.current = prevSnapshot;
        setUndoCount(stack.length);
        rebuildAllChunks();
      },
      captureMainCanvasScreenshot: () => {
        const prevGridVis = gridOverlayGroup.visible;
        const prevCursorVis = cursorBox.visible;
        const prevFaceVis = localFaceGrid.visible;
        gridOverlayGroup.visible = false;
        cursorBox.visible = false;
        localFaceGrid.visible = false;

        const activeCam = stateRef.current.isExploreMode
          ? playerCam
          : camState.isOrtho
            ? orthoCam
            : perspCam;
        renderer.render(scene, activeCam);
        const dataUrl = renderer.domElement.toDataURL('image/png');

        gridOverlayGroup.visible = prevGridVis;
        cursorBox.visible = prevCursorVis;
        localFaceGrid.visible = prevFaceVis;
        return dataUrl;
      },
    };

    // Exact Epsilon-Safe AABB Voxel Collision Solver for Player in Explore mode
    const isSolidAt = (vx: number, vy: number, vz: number): boolean => {
      if (vx < 0 || vx >= WORLD_SIZE || vy < 0 || vy >= WORLD_SIZE || vz < 0 || vz >= WORLD_SIZE) {
        return false;
      }
      const val = worldDataRef.current.get(posKey(vx, vy, vz));
      return val !== undefined && val !== 0;
    };

    const PLAYER_RADIUS = 0.32;
    const PLAYER_HEIGHT = 1.65;
    const EPS = 0.001;

    const collidesAABB = (px: number, py: number, pz: number): boolean => {
      const minX = Math.floor(px - PLAYER_RADIUS + EPS);
      const maxX = Math.floor(px + PLAYER_RADIUS - EPS);
      const minY = Math.floor(py + EPS);
      const maxY = Math.floor(py + PLAYER_HEIGHT - EPS);
      const minZ = Math.floor(pz - PLAYER_RADIUS + EPS);
      const maxZ = Math.floor(pz + PLAYER_RADIUS - EPS);

      for (let vx = minX; vx <= maxX; vx++) {
        for (let vy = minY; vy <= maxY; vy++) {
          for (let vz = minZ; vz <= maxZ; vz++) {
            if (isSolidAt(vx, vy, vz)) return true;
          }
        }
      }
      return false;
    };

    if (!isSoftwareGl) {
      renderer.compile(scene, orthoCam);
    }

    // Main Animation, Telemetry & Physics Loop
    const clock = new THREE.Clock();
    let frameId = 0;
    let fpsFrames = 0;
    let fpsLastTime = performance.now();

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

      // Update FPS, Chunk Count, and Memory Telemetry every ~500ms
      fpsFrames++;
      const nowPerf = performance.now();
      if (nowPerf - fpsLastTime >= 500) {
        const currentFps = Math.min(
          144,
          Math.max(1, Math.round((fpsFrames * 1000) / (nowPerf - fpsLastTime))),
        );
        fpsFrames = 0;
        fpsLastTime = nowPerf;

        const perfMem = (
          performance as unknown as { memory?: { usedJSHeapSize: number } }
        ).memory;
        let memMBStr = '24.2';
        if (perfMem && perfMem.usedJSHeapSize) {
          memMBStr = (perfMem.usedJSHeapSize / (1024 * 1024)).toFixed(1);
        } else {
          const estimatedBytes =
            18.4 * 1024 * 1024 +
            worldDataRef.current.size * 64 +
            totalTrianglesCount * 144 +
            undoStackRef.current.length * worldDataRef.current.size * 32;
          memMBStr = (estimatedBytes / (1024 * 1024)).toFixed(1);
        }

        setPerfStats({
          fps: currentFps,
          activeChunks: chunkMeshes.size,
          totalChunks: TOTAL_CHUNKS,
          memoryMB: memMBStr,
          triangles: totalTrianglesCount,
        });
      }

      // Animate moving clouds when Sky mode is active
      if (stateRef.current.bgMode === 'sky') {
        for (let i = 0; i < cloudClusters.length; i++) {
          const cloud = cloudClusters[i];
          cloud.position.x += (1.1 + (i % 3) * 0.35) * delta;
          if (cloud.position.x > 68) {
            cloud.position.x = -36;
          }
        }
      }

      if (!stateRef.current.isExploreMode) {
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
        // Explore Mode Physics & Controls
        const SPEED = 7.5;
        const JUMP_VELOCITY = 8.4;
        const GRAVITY = 21.0;

        if (keysPressed.has('KeyE')) playerState.yaw += 2.2 * delta;
        if (keysPressed.has('KeyR')) playerState.yaw -= 2.2 * delta;

        const mInput = mobileInputRef.current;
        let moveX = 0;
        let moveZ = 0;
        if (
          keysPressed.has('ArrowUp') ||
          keysPressed.has('KeyW') ||
          keysPressed.has('KeyZ') ||
          mInput.up
        ) {
          moveZ -= 1;
        }
        if (keysPressed.has('ArrowDown') || keysPressed.has('KeyS') || mInput.down) {
          moveZ += 1;
        }
        if (
          keysPressed.has('ArrowLeft') ||
          keysPressed.has('KeyA') ||
          keysPressed.has('KeyQ') ||
          mInput.left
        ) {
          moveX -= 1;
        }
        if (keysPressed.has('ArrowRight') || keysPressed.has('KeyD') || mInput.right) {
          moveX += 1;
        }

        const isMoving = moveX !== 0 || moveZ !== 0;
        if (isMoving) {
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

        const touchingGround = collidesAABB(
          playerState.pos.x,
          playerState.pos.y - 0.06,
          playerState.pos.z,
        );
        if (touchingGround && playerState.vel.y <= 0) {
          playerState.onFloor = true;
          playerState.coyoteTimer = 0.15;
        } else {
          playerState.coyoteTimer = Math.max(0, playerState.coyoteTimer - delta);
        }

        const wantsJump = keysPressed.has('Space') || playerState.jumpQueued;
        if (wantsJump && (playerState.onFloor || playerState.coyoteTimer > 0)) {
          playerState.vel.y = JUMP_VELOCITY;
          playerState.onFloor = false;
          playerState.coyoteTimer = 0;
          playerState.jumpQueued = false;
        } else {
          playerState.jumpQueued = false;
        }

        playerState.vel.y -= GRAVITY * delta;
        playerState.vel.y = Math.max(playerState.vel.y, -28.0);

        // 1. Resolve Y Axis
        const dy = playerState.vel.y * delta;
        const candidateY = playerState.pos.y + dy;
        if (!collidesAABB(playerState.pos.x, candidateY, playerState.pos.z)) {
          playerState.pos.y = candidateY;
          playerState.onFloor = false;
        } else {
          if (dy < 0) {
            const hitVoxelY = Math.floor(candidateY + EPS);
            playerState.pos.y = hitVoxelY + 1.0001;
            playerState.onFloor = true;
          } else if (dy > 0) {
            const hitCeilY = Math.floor(candidateY + PLAYER_HEIGHT - EPS);
            playerState.pos.y = hitCeilY - PLAYER_HEIGHT - 0.001;
          }
          playerState.vel.y = 0;
        }

        // 2. Resolve X Axis
        const dx = playerState.vel.x * delta;
        const candidateX = playerState.pos.x + dx;
        if (!collidesAABB(candidateX, playerState.pos.y, playerState.pos.z)) {
          playerState.pos.x = candidateX;
        } else {
          playerState.vel.x = 0;
        }

        // 3. Resolve Z Axis
        const dz = playerState.vel.z * delta;
        const candidateZ = playerState.pos.z + dz;
        if (!collidesAABB(playerState.pos.x, playerState.pos.y, candidateZ)) {
          playerState.pos.z = candidateZ;
        } else {
          playerState.vel.z = 0;
        }

        if (playerState.pos.y < -12.0) {
          const spawn = findSafeSpawnPosition();
          playerState.pos.copy(spawn);
          playerState.vel.set(0, 0, 0);
          playerState.onFloor = true;
        }

        playerGroup.position.copy(playerState.pos);
        playerGroup.rotation.y = playerState.yaw;

        if (!playerState.onFloor) {
          leftLeg.rotation.x = 0.45;
          rightLeg.rotation.x = -0.35;
          leftArm.rotation.x = -0.6;
          rightArm.rotation.x = 0.6;
        } else if (isMoving) {
          playerState.walkCycle += delta * 11.0;
          const swing = Math.sin(playerState.walkCycle) * 0.65;
          leftLeg.rotation.x = swing;
          rightLeg.rotation.x = -swing;
          leftArm.rotation.x = -swing * 0.8;
          rightArm.rotation.x = swing * 0.8;
        } else {
          leftLeg.rotation.x = THREE.MathUtils.damp(leftLeg.rotation.x, 0, 10, delta);
          rightLeg.rotation.x = THREE.MathUtils.damp(rightLeg.rotation.x, 0, 10, delta);
          leftArm.rotation.x = THREE.MathUtils.damp(leftArm.rotation.x, 0, 10, delta);
          rightArm.rotation.x = THREE.MathUtils.damp(rightArm.rotation.x, 0, 10, delta);
        }

        const thirdPerson = stateRef.current.isThirdPerson;
        playerGroup.visible = thirdPerson;

        if (thirdPerson) {
          const camDist = 6.2;
          const lookTarget = _vec3A.set(
            playerState.pos.x,
            playerState.pos.y + 1.35,
            playerState.pos.z,
          );
          const camOffset = _vec3B.set(
            Math.cos(playerState.pitch) * Math.sin(playerState.yaw) * camDist,
            -Math.sin(playerState.pitch) * camDist + 0.6,
            Math.cos(playerState.pitch) * Math.cos(playerState.yaw) * camDist,
          );
          playerCam.position.copy(lookTarget).add(camOffset);
          playerCam.lookAt(lookTarget);
        } else {
          playerCam.position.set(
            playerState.pos.x,
            playerState.pos.y + 1.5,
            playerState.pos.z,
          );
          const euler = new THREE.Euler(playerState.pitch, playerState.yaw, 0, 'YXZ');
          playerCam.quaternion.setFromEuler(euler);
        }

        const bx = Math.floor(playerState.pos.x);
        const by = Math.floor(playerState.pos.y);
        const bz = Math.floor(playerState.pos.z);
        setHoverCoords(`${bx - 16}, ${by - 10}, ${bz - 16}`);

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
      domElem.removeEventListener('touchstart', onTouchStart);
      domElem.removeEventListener('touchmove', onTouchMove);
      domElem.removeEventListener('touchend', onTouchEnd);
      domElem.removeEventListener('wheel', onWheel);
      domElem.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('resize', onResize);
      chunkMeshes.forEach((m) => m.geometry.dispose());
      sharedMaterial.dispose();
      atlasTexture.dispose();
      skyGradientTexture.dispose();
      renderer.dispose();
      if (domElem.parentNode === mount) {
        mount.removeChild(domElem);
      }
    };
  }, [persistStorage, pushUndoSnapshot, updateMinimap]);

  // Select a swatch from the palette
  const handleSelectPaletteColor = (cIdx: number) => {
    setSelectedColIdx(cIdx);
    const hex = paletteColors[cIdx] || PALETTE[cIdx];
    setCustomHex(hex);
    setHexInputText(hex.toUpperCase());
  };

  // Handle typing a custom hex color code
  const handleHexInputChange = (val: string) => {
    setHexInputText(val);
    const norm = normalizeHex(val);
    if (norm) {
      setCustomHex(norm);
    }
  };

  // Apply custom hex code to overwrite the currently selected palette swatch
  const handleApplyHexToSwatch = () => {
    const norm = normalizeHex(hexInputText);
    if (!norm) return;
    PALETTE[selectedColIdx] = norm;
    setPaletteColors([...PALETTE]);
    setCustomHex(norm);
    setHexInputText(norm.toUpperCase());
    sceneActionsRef.current?.rebuildAllChunks();
  };

  // Open the Screenshot & Save/Publish Studio Modal
  const openSaveStudioModal = () => {
    const currentVox = serializeWorldMap(worldDataRef.current);
    setStudioVoxels(currentVox);
    setStudioName(buildName.trim() || `Custom Island #${savedBuilds.length + 1}`);
    setStudioPrice(buildPrice.trim() || '250 SAND');
    // Capture an initial screenshot from the main viewport as default cover image
    const initialShot =
      sceneActionsRef.current?.captureMainCanvasScreenshot() ||
      createBuildThumbnailDataUrl(currentVox);
    setStudioImageUrl(initialShot);
    setStudioYaw(0.785);
    setStudioPitch(-0.52);
    setActiveModal('studio');
  };

  const handleConfirmSaveToBuilds = () => {
    const cleanName = studioName.trim() || `Custom Island #${savedBuilds.length + 1}`;
    const cleanBio =
      studioBio.trim() ||
      'A custom voxel creation built in The Sandbox Voxel Workshop.';
    const finalImage = studioImageUrl || createBuildThumbnailDataUrl(studioVoxels);

    const newEntry: SavedBuild = {
      name: cleanName,
      author: '@You',
      price: 'Saved Draft',
      bio: cleanBio,
      imageUrl: finalImage,
      previewYaw: studioYaw,
      previewPitch: studioPitch,
      voxels: studioVoxels,
    };
    const nextBuilds = [newEntry, ...savedBuilds];
    setSavedBuilds(nextBuilds);
    setBuildName(cleanName);
    persistStorage(nextBuilds, shopItems);
    setSelectedBuildDetail(null);
    setActiveModal('builds');
  };

  const handleConfirmPublishToShop = () => {
    const cleanName = studioName.trim() || `Published World #${shopItems.length + 1}`;
    const cleanBio =
      studioBio.trim() ||
      'A community voxel world published to The Sandbox Shop.';
    let cleanPrice = studioPrice.trim() || '100 SAND';
    if (!cleanPrice.toUpperCase().endsWith('SAND')) {
      cleanPrice += ' SAND';
    }
    const finalImage = studioImageUrl || createBuildThumbnailDataUrl(studioVoxels);

    const newEntry: SavedBuild = {
      name: cleanName,
      author: '@YazSm05',
      price: cleanPrice,
      bio: cleanBio,
      imageUrl: finalImage,
      previewYaw: studioYaw,
      previewPitch: studioPitch,
      voxels: studioVoxels,
    };
    const nextBuilds = [newEntry, ...savedBuilds];
    const nextShop = [newEntry, ...shopItems];
    setSavedBuilds(nextBuilds);
    setShopItems(nextShop);
    setBuildName(cleanName);
    setBuildPrice(cleanPrice);
    persistStorage(nextBuilds, nextShop);
    setSelectedBuildDetail(null);
    setActiveModal('shop');
  };

  const handleDownloadScreenshot = () => {
    if (!studioImageUrl) return;
    const a = document.createElement('a');
    a.href = studioImageUrl;
    a.download = `${(studioName || 'sandbox-build').toLowerCase().replace(/\s+/g, '-')}.png`;
    a.click();
  };

  const handleLoadVoxelBuild = (item: SavedBuild) => {
    pushUndoSnapshot();
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
    setSelectedBuildDetail(null);
    setActiveModal(null);
  };

  const handleDeleteSavedBuild = (idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const nextBuilds = savedBuilds.filter((_, i) => i !== idx);
    setSavedBuilds(nextBuilds);
    persistStorage(nextBuilds, shopItems);
  };

  const handleResetDefaultIsland = () => {
    pushUndoSnapshot();
    worldDataRef.current = generateSandboxIslandData();
    sceneActionsRef.current?.rebuildAllChunks();
    setBuildName('Four-Biome Floating Island');
  };

  const isHexValid = normalizeHex(hexInputText) !== null;
  const modalList = activeModal === 'shop' ? shopItems : savedBuilds;
  const { timeStr, phase } = formatTimeOfDay(timeOfDay);

  const toolConfig: Array<{
    id: ToolId;
    label: string;
    Icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: 'add', label: 'Add Cube', Icon: PlusSquare },
    { id: 'erase', label: 'Erase', Icon: Eraser },
    { id: 'paint', label: 'Paint', Icon: Paintbrush },
    { id: 'box', label: 'Box Fill', Icon: Grid },
    { id: 'column', label: 'Column', Icon: Columns },
    { id: 'eyedrop', label: 'Eyedrop', Icon: Pipette },
  ];

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#081824] font-sans text-white select-none">
      {/* Dedicated WebGL Mount Container */}
      <div ref={canvasMountRef} className="w-full h-full" />

      {/* =====================================================================
          PC TOP HUD TOGGLE BAR (Visible on Desktop/Tablet `md:flex`)
      ====================================================================== */}
      <div className="hidden md:flex fixed top-2.5 left-1/2 -translate-x-1/2 z-30 bg-[#0a1c2b]/95 border border-[#1e4968] rounded-lg px-3 py-1.5 items-center gap-1.5 shadow-xl">
        <div className="flex items-center gap-1.5 pr-2 border-r border-[#1e4968] text-[#38e2ff] font-bold text-xs tracking-wide">
          <Box className="w-4 h-4 text-[#38e2ff]" />
          <span>SANDBOX</span>
        </div>

        <button
          onClick={() => toggleHudPanel('tools')}
          className={`px-2.5 py-1 text-xs rounded border flex items-center gap-1.5 transition-colors cursor-pointer ${
            showToolsHud
              ? 'bg-[#1589b8] border-[#38e2ff] text-white'
              : 'bg-[#102538] border-[#1e4460] text-[#b8d4e8] hover:bg-[#183752]'
          }`}
        >
          <Wrench className="w-3.5 h-3.5" />
          <span>Tools</span>
        </button>

        <button
          onClick={() => toggleHudPanel('palette')}
          className={`px-2.5 py-1 text-xs rounded border flex items-center gap-1.5 transition-colors cursor-pointer ${
            showPaletteHud
              ? 'bg-[#1589b8] border-[#38e2ff] text-white'
              : 'bg-[#102538] border-[#1e4460] text-[#b8d4e8] hover:bg-[#183752]'
          }`}
        >
          <Palette className="w-3.5 h-3.5" />
          <span>Palette</span>
        </button>

        <button
          onClick={() => toggleHudPanel('world')}
          className={`px-2.5 py-1 text-xs rounded border flex items-center gap-1.5 transition-colors cursor-pointer ${
            showWorldHud
              ? 'bg-[#1589b8] border-[#38e2ff] text-white'
              : 'bg-[#102538] border-[#1e4460] text-[#b8d4e8] hover:bg-[#183752]'
          }`}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          <span>World & Camera</span>
        </button>

        <button
          onClick={() => toggleHudPanel('minimap')}
          className={`px-2.5 py-1 text-xs rounded border flex items-center gap-1.5 transition-colors cursor-pointer ${
            showMinimapHud
              ? 'bg-[#1589b8] border-[#38e2ff] text-white'
              : 'bg-[#102538] border-[#1e4460] text-[#b8d4e8] hover:bg-[#183752]'
          }`}
        >
          <MapIcon className="w-3.5 h-3.5" />
          <span>Minimap</span>
        </button>

        <button
          onClick={() => toggleHudPanel('perf')}
          className={`px-2.5 py-1 text-xs rounded border flex items-center gap-1.5 transition-colors cursor-pointer ${
            showPerfHud
              ? 'bg-[#1589b8] border-[#38e2ff] text-white'
              : 'bg-[#102538] border-[#1e4460] text-[#b8d4e8] hover:bg-[#183752]'
          }`}
        >
          <Activity className="w-3.5 h-3.5 text-[#8cd656]" />
          <span>Stats</span>
        </button>

        <div className="h-4 w-[1px] bg-[#1e4968] mx-0.5" />

        <button
          onClick={openSaveStudioModal}
          title="Capture Screenshot & Save / Publish Build with 3D Preview"
          className="px-2.5 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] flex items-center gap-1.5 text-[#ffe678] transition-colors cursor-pointer"
        >
          <Camera className="w-3.5 h-3.5" />
          <span>Screenshot & Save</span>
        </button>

        <button
          onClick={handleUndo}
          disabled={undoCount === 0}
          title="Undo last world change (Ctrl+Z)"
          className="px-2.5 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] disabled:opacity-40 flex items-center gap-1 transition-colors cursor-pointer"
        >
          <Undo2 className="w-3.5 h-3.5 text-[#f5c242]" />
          <span>{undoCount}</span>
        </button>

        <button
          onClick={() => setBgMode((m) => (m === 'sky' ? 'classic' : 'sky'))}
          title="Toggle Sky & Clouds vs Deep Space"
          className="px-2 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] flex items-center gap-1 cursor-pointer"
        >
          {bgMode === 'sky' ? (
            <Sun className="w-3.5 h-3.5 text-[#ffe678]" />
          ) : (
            <Moon className="w-3.5 h-3.5 text-[#38e2ff]" />
          )}
        </button>

        <button
          onClick={toggleMusic}
          title="Toggle Ambient Music"
          className="px-2 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] flex items-center gap-1 cursor-pointer"
        >
          {isMusicPlaying ? (
            <Volume2 className="w-3.5 h-3.5 text-[#8cd656]" />
          ) : (
            <VolumeX className="w-3.5 h-3.5 text-[#9ab8d0]" />
          )}
        </button>

        <button
          onClick={(e) => {
            e.currentTarget.blur();
            sceneActionsRef.current?.setGameMode(!isExploreMode);
          }}
          className="px-2.5 py-1 text-xs font-medium rounded border bg-[#1589b8] border-[#38e2ff] hover:bg-[#1ba3d9] flex items-center gap-1 transition-colors cursor-pointer"
        >
          {isExploreMode ? (
            <>
              <Square className="w-3 h-3 fill-current" />
              <span>Edit</span>
            </>
          ) : (
            <>
              <Play className="w-3 h-3 fill-current" />
              <span>Explore</span>
            </>
          )}
        </button>

        <button
          onClick={toggleAllPanels}
          title={anyPanelOpen ? 'Hide All Panels' : 'Show All Panels'}
          className="px-2 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] flex items-center cursor-pointer"
        >
          {anyPanelOpen ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* =====================================================================
          MOBILE SIDE HUD TOGGLE BAR (Visible on Mobile `< md`)
      ====================================================================== */}
      <div className="flex md:hidden fixed left-2 top-1/2 -translate-y-1/2 z-30 bg-[#0a1c2b]/95 border border-[#1e4968] rounded-xl p-1.5 flex-col items-center gap-1.5 shadow-xl">
        <button
          onClick={() => toggleHudPanel('tools')}
          title="Voxel Tools"
          className={`w-9 h-9 rounded-lg border flex flex-col items-center justify-center gap-0.5 transition-colors ${
            showToolsHud
              ? 'bg-[#1589b8] border-[#38e2ff] text-white'
              : 'bg-[#102538] border-[#1e4460] text-[#b8d4e8]'
          }`}
        >
          <Wrench className="w-4 h-4" />
          <span className="text-[8px] leading-none">Tools</span>
        </button>

        <button
          onClick={() => toggleHudPanel('palette')}
          title="Color & Texture Palette"
          className={`w-9 h-9 rounded-lg border flex flex-col items-center justify-center gap-0.5 transition-colors ${
            showPaletteHud
              ? 'bg-[#1589b8] border-[#38e2ff] text-white'
              : 'bg-[#102538] border-[#1e4460] text-[#b8d4e8]'
          }`}
        >
          <Palette className="w-4 h-4" />
          <span className="text-[8px] leading-none">Color</span>
        </button>

        <button
          onClick={() => toggleHudPanel('world')}
          title="World, Sun Slider & Camera"
          className={`w-9 h-9 rounded-lg border flex flex-col items-center justify-center gap-0.5 transition-colors ${
            showWorldHud
              ? 'bg-[#1589b8] border-[#38e2ff] text-white'
              : 'bg-[#102538] border-[#1e4460] text-[#b8d4e8]'
          }`}
        >
          <SlidersHorizontal className="w-4 h-4" />
          <span className="text-[8px] leading-none">World</span>
        </button>

        <button
          onClick={() => toggleHudPanel('minimap')}
          title="Minimap"
          className={`w-9 h-9 rounded-lg border flex flex-col items-center justify-center gap-0.5 transition-colors ${
            showMinimapHud
              ? 'bg-[#1589b8] border-[#38e2ff] text-white'
              : 'bg-[#102538] border-[#1e4460] text-[#b8d4e8]'
          }`}
        >
          <MapIcon className="w-4 h-4" />
          <span className="text-[8px] leading-none">Map</span>
        </button>

        <button
          onClick={openSaveStudioModal}
          title="Screenshot & Save Studio"
          className="w-9 h-9 rounded-lg border bg-[#102538] border-[#1e4460] text-[#ffe678] flex flex-col items-center justify-center gap-0.5"
        >
          <Camera className="w-4 h-4" />
          <span className="text-[8px] leading-none">Snap</span>
        </button>

        <button
          onClick={() => toggleHudPanel('perf')}
          title="Performance Monitor"
          className={`w-9 h-9 rounded-lg border flex flex-col items-center justify-center gap-0.5 transition-colors ${
            showPerfHud
              ? 'bg-[#1589b8] border-[#38e2ff] text-white'
              : 'bg-[#102538] border-[#1e4460] text-[#b8d4e8]'
          }`}
        >
          <Activity className="w-4 h-4 text-[#8cd656]" />
          <span className="text-[8px] leading-none">FPS</span>
        </button>

        <div className="w-6 h-[1px] bg-[#1e4968] my-0.5" />

        <button
          onClick={handleUndo}
          disabled={undoCount === 0}
          title="Undo"
          className="w-9 h-8 rounded-lg border bg-[#102538] border-[#1e4460] disabled:opacity-40 flex flex-col items-center justify-center"
        >
          <Undo2 className="w-3.5 h-3.5 text-[#f5c242]" />
          <span className="text-[8px] leading-none text-[#f5c242]">{undoCount}</span>
        </button>

        <button
          onClick={toggleMusic}
          title="Music"
          className="w-9 h-8 rounded-lg border bg-[#102538] border-[#1e4460] flex items-center justify-center"
        >
          {isMusicPlaying ? (
            <Volume2 className="w-4 h-4 text-[#8cd656]" />
          ) : (
            <VolumeX className="w-4 h-4 text-[#9ab8d0]" />
          )}
        </button>

        <button
          onClick={(e) => {
            e.currentTarget.blur();
            sceneActionsRef.current?.setGameMode(!isExploreMode);
          }}
          title="Play / Explore"
          className="w-9 h-9 rounded-lg border bg-[#1589b8] border-[#38e2ff] flex flex-col items-center justify-center gap-0.5"
        >
          {isExploreMode ? (
            <>
              <Square className="w-3.5 h-3.5 fill-current" />
              <span className="text-[8px] leading-none">Edit</span>
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5 fill-current" />
              <span className="text-[8px] leading-none">Play</span>
            </>
          )}
        </button>
      </div>

      {/* MOBILE QUICK BUILD / ORBIT PILL (Top-Center on Mobile in Edit Mode) */}
      {!isExploreMode && (
        <div className="flex md:hidden fixed top-2.5 left-1/2 -translate-x-1/2 z-20 bg-[#0a1c2b]/95 border border-[#1e4968] rounded-lg p-1 items-center gap-1 shadow-lg">
          <button
            onClick={() => setMobileTouchMode('build')}
            className={`px-2.5 py-1 text-[11px] rounded flex items-center gap-1 ${
              mobileTouchMode === 'build'
                ? 'bg-[#1589b8] text-white font-semibold'
                : 'text-[#b8d4e8]'
            }`}
          >
            <Hammer className="w-3 h-3" />
            <span>Tap: Build</span>
          </button>
          <button
            onClick={() => setMobileTouchMode('orbit')}
            className={`px-2.5 py-1 text-[11px] rounded flex items-center gap-1 ${
              mobileTouchMode === 'orbit'
                ? 'bg-[#1589b8] text-white font-semibold'
                : 'text-[#b8d4e8]'
            }`}
          >
            <Hand className="w-3 h-3" />
            <span>Drag: Orbit</span>
          </button>
          <div
            className="w-4 h-4 rounded border border-white/40 ml-1"
            style={{ backgroundColor: customHex }}
          />
        </div>
      )}

      {/* =====================================================================
          TOGGLEABLE PERFORMANCE MONITOR HUD (FPS, Chunks, Memory Usage)
      ====================================================================== */}
      {showPerfHud && (
        <div className="fixed top-2.5 right-3.5 z-20 bg-[#0a1c2b]/95 border border-[#1e4968] rounded-lg px-2.5 py-1.5 flex items-center gap-3 text-[11px] font-mono shadow-lg">
          <div className="flex items-center gap-1">
            <Activity className="w-3.5 h-3.5 text-[#8cd656]" />
            <span className="text-[#9ab8d0]">FPS:</span>
            <span
              className={`font-bold ${
                perfStats.fps >= 45
                  ? 'text-[#8cd656]'
                  : perfStats.fps >= 25
                    ? 'text-[#f5c242]'
                    : 'text-[#ff5232]'
              }`}
            >
              {perfStats.fps}
            </span>
          </div>
          <div className="flex items-center gap-1 border-l border-[#1e4968] pl-2.5">
            <Box className="w-3.5 h-3.5 text-[#38e2ff]" />
            <span className="text-[#9ab8d0]">Chunks:</span>
            <span className="text-white font-semibold">
              {perfStats.activeChunks}/{perfStats.totalChunks}
            </span>
          </div>
          <div className="flex items-center gap-1 border-l border-[#1e4968] pl-2.5">
            <Cpu className="w-3.5 h-3.5 text-[#f5c242]" />
            <span className="text-[#9ab8d0]">Mem:</span>
            <span className="text-[#f5c242] font-semibold">{perfStats.memoryMB} MB</span>
          </div>
        </div>
      )}

      {/* =====================================================================
          PANEL 1: WORLD, CAMERA, TIME OF DAY SLIDER, MY BUILDS & SHOP DOCK
      ====================================================================== */}
      {showWorldHud && (
        <div className="fixed z-20 bottom-3 left-14 right-3 md:bottom-auto md:top-14 md:left-1/2 md:-translate-x-1/2 md:right-auto md:w-[560px] bg-[#0a1c2b]/95 border border-[#1e4968] rounded-lg px-3 py-2.5 flex flex-col gap-2 shadow-xl">
          {/* Row 1: Camera Angles & Quick World Name */}
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5">
              {[
                { label: 'FRONT', yaw: 0.0, pitch: -0.45 },
                { label: 'SIDE', yaw: 1.57, pitch: -0.45 },
                { label: 'ISO', yaw: 0.78, pitch: -0.55 },
              ].map((v) => (
                <button
                  key={v.label}
                  onClick={() => sceneActionsRef.current?.setCameraAngle(v.yaw, v.pitch)}
                  className="px-2 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <Compass className="w-3 h-3 text-[#38e2ff]" />
                  <span>{v.label}</span>
                </button>
              ))}
              <button
                onClick={() => sceneActionsRef.current?.toggleOrtho()}
                className={`px-2 py-1 text-xs rounded border flex items-center gap-1 transition-colors cursor-pointer ${
                  isOrtho
                    ? 'bg-[#1589b8] border-[#38e2ff]'
                    : 'bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff]'
                }`}
              >
                <Eye className="w-3 h-3" />
                <span>ORTHO</span>
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  setSelectedBuildDetail(null);
                  setActiveModal('builds');
                }}
                className="px-2.5 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5 text-[#38e2ff]" />
                <span>My Builds ({savedBuilds.length})</span>
              </button>
              <button
                onClick={() => {
                  setSelectedBuildDetail(null);
                  setActiveModal('shop');
                }}
                className="px-2.5 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <ShoppingBag className="w-3.5 h-3.5 text-[#f5c242]" />
                <span>Shop ({shopItems.length})</span>
              </button>
            </div>
          </div>

          {/* Row 2: Sun Position & Time of Day Slider */}
          <div className="flex items-center gap-2.5 bg-[#081824]/90 border border-[#1e4460] rounded-md px-2.5 py-1.5">
            <div className="flex items-center gap-1.5 text-xs text-[#ffe678] font-medium shrink-0">
              {timeOfDay >= 6 && timeOfDay <= 19 ? (
                <Sun className="w-3.5 h-3.5 text-[#ffe678]" />
              ) : (
                <Moon className="w-3.5 h-3.5 text-[#38e2ff]" />
              )}
              <span>Sun & Time:</span>
            </div>
            <input
              type="range"
              min={0}
              max={24}
              step={0.1}
              value={timeOfDay}
              onChange={(e) => setTimeOfDay( parseFloat(e.target.value) )}
              className="flex-1 accent-[#38e2ff] h-1.5 bg-[#102538] rounded-lg cursor-pointer"
            />
            <div className="flex items-center gap-1.5 text-[11px] font-mono shrink-0">
              <Clock className="w-3 h-3 text-[#38e2ff]" />
              <span className="text-white font-semibold">{timeStr}</span>
              <span className="text-[#9ab8d0]">({phase})</span>
            </div>
          </div>

          {/* Row 3: Screenshot, Save & Publish Studio Actions */}
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5">
              <button
                onClick={openSaveStudioModal}
                className="px-3 py-1 text-xs font-medium rounded border bg-[#1589b8] border-[#38e2ff] hover:bg-[#1ba3d9] flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Camera className="w-3.5 h-3.5 text-[#ffe678]" />
                <span>📸 Screenshot, Save & Publish Studio</span>
              </button>
            </div>
            <button
              onClick={handleResetDefaultIsland}
              title="Reset Default Island"
              className="px-2.5 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] flex items-center gap-1 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3 h-3 text-[#ff8c24]" />
              <span>Reset Island</span>
            </button>
          </div>
        </div>
      )}

      {/* =====================================================================
          EXPLORE MODE CONTROLS (Desktop Action Bar + Mobile Virtual D-Pad)
      ====================================================================== */}
      {isExploreMode && (
        <>
          <div className="flex md:hidden fixed bottom-4 left-14 z-20 flex-col items-center gap-1">
            <button
              onTouchStart={(e) => {
                e.preventDefault();
                mobileInputRef.current.up = true;
              }}
              onTouchEnd={() => {
                mobileInputRef.current.up = false;
              }}
              onMouseDown={() => {
                mobileInputRef.current.up = true;
              }}
              onMouseUp={() => {
                mobileInputRef.current.up = false;
              }}
              className="w-11 h-11 rounded-lg bg-[#0a1c2b]/90 border border-[#38e2ff] flex items-center justify-center active:bg-[#1589b8]"
            >
              <ArrowUp className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-1">
              <button
                onTouchStart={(e) => {
                  e.preventDefault();
                  mobileInputRef.current.left = true;
                }}
                onTouchEnd={() => {
                  mobileInputRef.current.left = false;
                }}
                onMouseDown={() => {
                  mobileInputRef.current.left = true;
                }}
                onMouseUp={() => {
                  mobileInputRef.current.left = false;
                }}
                className="w-11 h-11 rounded-lg bg-[#0a1c2b]/90 border border-[#38e2ff] flex items-center justify-center active:bg-[#1589b8]"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <button
                onTouchStart={(e) => {
                  e.preventDefault();
                  mobileInputRef.current.down = true;
                }}
                onTouchEnd={() => {
                  mobileInputRef.current.down = false;
                }}
                onMouseDown={() => {
                  mobileInputRef.current.down = true;
                }}
                onMouseUp={() => {
                  mobileInputRef.current.down = false;
                }}
                className="w-11 h-11 rounded-lg bg-[#0a1c2b]/90 border border-[#38e2ff] flex items-center justify-center active:bg-[#1589b8]"
              >
                <ArrowDown className="w-5 h-5" />
              </button>
              <button
                onTouchStart={(e) => {
                  e.preventDefault();
                  mobileInputRef.current.right = true;
                }}
                onTouchEnd={() => {
                  mobileInputRef.current.right = false;
                }}
                onMouseDown={() => {
                  mobileInputRef.current.right = true;
                }}
                onMouseUp={() => {
                  mobileInputRef.current.right = false;
                }}
                className="w-11 h-11 rounded-lg bg-[#0a1c2b]/90 border border-[#38e2ff] flex items-center justify-center active:bg-[#1589b8]"
              >
                <ArrowRight className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="fixed bottom-4 right-3 md:right-auto md:left-1/2 md:-translate-x-1/2 z-20 bg-[#0a1c2b]/95 border border-[#38e2ff] rounded-lg px-3.5 py-2 flex items-center gap-2.5 shadow-xl">
            <div className="hidden md:flex items-center gap-1.5 text-xs text-[#38e2ff] font-semibold">
              <Sparkles className="w-3.5 h-3.5" />
              <span>EXPLORE MODE</span>
            </div>
            <span className="hidden md:inline text-xs text-[#b8d4e8]">
              WASD / Arrows: Move • Drag Mouse: Look • SPACE: Jump
            </span>
            <button
              onTouchStart={(e) => {
                e.preventDefault();
                sceneActionsRef.current?.triggerJump();
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                sceneActionsRef.current?.triggerJump();
              }}
              className="px-3.5 py-2 md:py-1 text-xs font-semibold rounded border bg-[#1589b8] border-[#38e2ff] hover:bg-[#1ba3d9] flex items-center gap-1 cursor-pointer"
            >
              <ArrowUp className="w-4 h-4" />
              <span>Jump</span>
            </button>
            <button
              onMouseDown={(e) => {
                e.preventDefault();
                setIsThirdPerson((prev) => !prev);
              }}
              className="px-2.5 py-2 md:py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] flex items-center gap-1.5 cursor-pointer"
            >
              <Camera className="w-3.5 h-3.5 text-[#38e2ff]" />
              <span>{isThirdPerson ? '3rd' : '1st'}</span>
            </button>
          </div>
        </>
      )}

      {/* =====================================================================
          PANEL 2: VOXEL TOOLS, UNDO & VISUAL GRID OVERLAY
      ====================================================================== */}
      {showToolsHud && !isExploreMode && (
        <div className="fixed z-20 bottom-3 left-14 right-3 md:bottom-auto md:right-auto md:top-14 md:left-3.5 md:w-60 bg-[#0a1c2b]/95 border border-[#1e4968] rounded-lg p-3 flex flex-col gap-2 shadow-xl max-h-[45vh] md:max-h-none overflow-y-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[#38e2ff] font-semibold text-xs tracking-wider">
              <Box className="w-3.5 h-3.5" />
              <span>VOXEL TOOLS</span>
            </div>
            <span className="text-[#f5c242] font-medium text-xs">{cubeCount} Cubes</span>
          </div>

          <div className="grid grid-cols-3 md:grid-cols-2 gap-1.5">
            {toolConfig.map(({ id, label, Icon }) => {
              const active = currentTool === id;
              return (
                <button
                  key={id}
                  onClick={() => setCurrentTool(id)}
                  className={`h-9 px-2 text-xs font-medium rounded border flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                    active
                      ? 'bg-[#1589b8] border-[#38e2ff] text-white'
                      : 'bg-[#102538] border-[#1e4460] text-white hover:bg-[#183752] hover:border-[#38e2ff]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
          </div>

          <button
            onClick={handleUndo}
            disabled={undoCount === 0}
            className="w-full h-8 px-2.5 text-xs font-medium rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] disabled:opacity-40 flex items-center justify-between transition-colors cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              <Undo2 className="w-3.5 h-3.5 text-[#f5c242]" />
              <span>Undo Action (Ctrl+Z)</span>
            </span>
            <span className="text-[11px] font-mono text-[#f5c242]">{undoCount}/20</span>
          </button>

          <div className="flex items-center justify-between pt-0.5">
            <span className="flex items-center gap-1.5 text-xs text-slate-200">
              <Scaling className="w-3.5 h-3.5 text-[#38e2ff]" />
              <span>Brush Size:</span>
            </span>
            <div className="flex items-center gap-1.5">
              {[1, 2, 3].map((sz) => (
                <button
                  key={sz}
                  onClick={() => setBrushSize(sz)}
                  className={`px-2.5 py-0.5 text-xs rounded border transition-colors cursor-pointer ${
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
            <span className="flex items-center gap-1.5 text-xs text-slate-200">
              <FlipHorizontal className="w-3.5 h-3.5 text-[#38e2ff]" />
              <span>Mirror X-Axis:</span>
            </span>
            <button
              onClick={() => setMirrorX((prev) => !prev)}
              className={`px-3 py-0.5 text-xs rounded border transition-colors cursor-pointer ${
                mirrorX
                  ? 'bg-[#1589b8] border-[#38e2ff]'
                  : 'bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff]'
              }`}
            >
              {mirrorX ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="flex flex-col gap-1.5 pt-1.5 border-t border-[#1e4460]/70">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs text-slate-200">
                <Grid3X3 className="w-3.5 h-3.5 text-[#38e2ff]" />
                <span>Grid Overlay (G):</span>
              </span>
              <button
                onClick={() => setShowGrid((prev) => !prev)}
                className={`px-3 py-0.5 text-xs rounded border transition-colors cursor-pointer ${
                  showGrid
                    ? 'bg-[#1589b8] border-[#38e2ff]'
                    : 'bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff]'
                }`}
              >
                {showGrid ? 'ON' : 'OFF'}
              </button>
            </div>
            {showGrid && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[#9ab8d0]">Grid Plane Y:</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setGridLevelY((y) => Math.max(0, y - 1))}
                    className="px-2 py-0.5 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] cursor-pointer"
                  >
                    −
                  </button>
                  <span className="w-8 text-center font-mono text-xs text-[#f5c242]">
                    {gridLevelY - 10}
                  </span>
                  <button
                    onClick={() => setGridLevelY((y) => Math.min(WORLD_SIZE - 1, y + 1))}
                    className="px-2 py-0.5 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] cursor-pointer"
                  >
                    +
                  </button>
                  <button
                    onClick={() => setGridLevelY(11)}
                    title="Reset Grid to Island Surface"
                    className="px-1.5 py-0.5 text-[10px] rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] cursor-pointer"
                  >
                    0
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          PANEL 3: BOTTOM-LEFT CONTROLS & LIVE MINIMAP
      ====================================================================== */}
      {showMinimapHud && (
        <div className="fixed z-20 bottom-3 left-14 right-3 md:right-auto md:bottom-3 md:left-3.5 md:w-60 bg-[#0a1c2b]/95 border border-[#1e4968] rounded-lg p-3 flex flex-row md:flex-col items-center md:items-stretch justify-between gap-2 shadow-xl">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-[#38e2ff] font-semibold text-xs">
                <Gamepad2 className="w-3.5 h-3.5" />
                <span>MINIMAP & COORDS</span>
              </div>
              <span className="text-[#f5c242] font-mono text-xs">{hoverCoords}</span>
            </div>

            <div className="flex flex-col gap-0.5 text-[11px] text-[#b8d4e8]">
              <span>Tap / L-Click: Place Cube</span>
              <span>Drag / R-Click: Orbit View</span>
              <span>Pinch / Scroll: Zoom</span>
              <span>Ctrl+Z: Undo (Last 20)</span>
            </div>
          </div>

          <div className="flex justify-center shrink-0">
            <canvas
              ref={minimapCanvasRef}
              width={WORLD_SIZE}
              height={WORLD_SIZE}
              className="w-20 h-20 md:w-24 md:h-24 rounded border border-[#1e4968] bg-[#081824] [image-rendering:pixelated]"
            />
          </div>
        </div>
      )}

      {/* =====================================================================
          PANEL 4: RIGHT DOCK — CUBE TEXTURE, HEX COLOR EDITOR & BIOME PALETTE
      ====================================================================== */}
      {showPaletteHud && !isExploreMode && (
        <div className="fixed z-20 bottom-3 left-14 right-3 md:bottom-auto md:left-auto md:top-14 md:right-3.5 md:w-64 bg-[#0a1c2b]/95 border border-[#1e4968] rounded-lg p-3 flex flex-col gap-2 shadow-xl max-h-[45vh] md:max-h-none overflow-y-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[#38e2ff] font-semibold text-xs">
              <Layers className="w-3.5 h-3.5" />
              <span>CUBE TEXTURE</span>
            </div>
            <span className="text-[11px] text-slate-200">{TEX_NAMES[selectedTexIdx]}</span>
          </div>

          <div className="grid grid-cols-4 gap-1.5">
            {TEX_SHORT.map((shortName, ti) => {
              const active = selectedTexIdx === ti;
              return (
                <button
                  key={shortName}
                  onClick={() => setSelectedTexIdx(ti)}
                  className={`h-8 text-xs rounded border transition-colors cursor-pointer ${
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

          <div className="flex flex-col gap-1.5 pt-1 border-t border-[#1e4460]/70">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[#38e2ff] font-semibold text-xs">
                <Palette className="w-3.5 h-3.5" />
                <span>HEX COLOR CODE</span>
              </div>
              <span className="text-[#f5c242] font-mono text-xs">{customHex.toUpperCase()}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <label
                title="Click to pick block color"
                className="relative w-7 h-7 rounded border border-[#38e2ff] overflow-hidden cursor-pointer shrink-0"
                style={{ backgroundColor: customHex }}
              >
                <input
                  type="color"
                  value={customHex}
                  onChange={(e) => {
                    const val = e.target.value;
                    setCustomHex(val);
                    setHexInputText(val.toUpperCase());
                  }}
                  className="opacity-0 absolute inset-0 w-full h-full cursor-pointer"
                />
              </label>
              <input
                type="text"
                value={hexInputText}
                onChange={(e) => handleHexInputChange(e.target.value)}
                placeholder="#5AC54F"
                maxLength={7}
                className={`flex-1 min-w-0 h-7 px-2 font-mono text-xs bg-[#081824] rounded border outline-none text-white ${
                  isHexValid
                    ? 'border-[#1e4460] focus:border-[#38e2ff]'
                    : 'border-red-500 focus:border-red-400'
                }`}
              />
              <button
                onClick={handleApplyHexToSwatch}
                disabled={!isHexValid}
                title="Save this Hex color into the selected palette slot"
                className="px-2 h-7 text-[11px] rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] disabled:opacity-40 cursor-pointer shrink-0"
              >
                Set Slot
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between pt-0.5">
            <div className="flex items-center gap-1.5 text-[#38e2ff] font-semibold text-xs">
              <SwatchBook className="w-3.5 h-3.5" />
              <span>BIOME PALETTE</span>
            </div>
            <span className="text-[11px] text-[#9ab8d0]">Slot #{selectedColIdx}</span>
          </div>

          <div className="flex flex-col gap-1.5">
            {BIOME_GROUPS.map((bg) => (
              <div key={bg.name} className="flex flex-col gap-1">
                <span className="text-[11px] text-[#9ab8d0]">{bg.name}</span>
                <div className="grid grid-cols-8 gap-1">
                  {Array.from({ length: 8 }, (_, offset) => {
                    const cIdx = bg.startIdx + offset;
                    const hex = paletteColors[cIdx] || PALETTE[cIdx];
                    const isSelected =
                      selectedColIdx === cIdx && customHex.toLowerCase() === hex.toLowerCase();
                    return (
                      <button
                        key={cIdx}
                        onClick={() => handleSelectPaletteColor(cIdx)}
                        style={{ backgroundColor: hex }}
                        title={hex.toUpperCase()}
                        className={`h-5 rounded-[3px] cursor-pointer transition-transform ${
                          isSelected
                            ? 'ring-2 ring-[#38e2ff] scale-105'
                            : selectedColIdx === cIdx
                              ? 'ring-1 ring-white/80'
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
              onClick={openSaveStudioModal}
              className="flex-1 py-1.5 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <Camera className="w-3.5 h-3.5 text-[#ffe678]" />
              <span>Save / Studio</span>
            </button>
            <button
              onClick={() => {
                setSelectedBuildDetail(null);
                setActiveModal('shop');
              }}
              className="flex-1 py-1.5 text-xs rounded border bg-[#1589b8] border-[#38e2ff] hover:bg-[#1ba3d9] flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <ShoppingBag className="w-3.5 h-3.5" />
              <span>Open Shop</span>
            </button>
          </div>
        </div>
      )}

      {/* =====================================================================
          SCREENSHOT, 3D PREVIEW & SAVE / PUBLISH STUDIO MODAL
      ====================================================================== */}
      {activeModal === 'studio' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3">
          <div className="w-[860px] max-w-full max-h-[92vh] bg-[#081726]/98 border-2 border-[#38e2ff] rounded-xl p-4 flex flex-col gap-3 shadow-2xl overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[#1e4968] pb-2.5">
              <div className="flex items-center gap-2 text-[#38e2ff] font-bold text-sm tracking-wide">
                <Camera className="w-4 h-4 text-[#ffe678]" />
                <span>BUILD SCREENSHOT, 3D PREVIEW & SAVE STUDIO</span>
              </div>
              <button
                onClick={() => setActiveModal(null)}
                className="px-3 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] flex items-center gap-1 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                <span>Close</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Left Column: Interactive 3D Rotatable Preview + Angle Screenshot Capture */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#38e2ff] font-semibold">
                    1. Rotate 3D Build & Snap Cover Screenshot
                  </span>
                  <span className="text-[11px] text-[#9ab8d0]">{studioVoxels.length} Cubes</span>
                </div>

                <VoxelPreview3D
                  voxels={studioVoxels}
                  initialYaw={studioYaw}
                  initialPitch={studioPitch}
                  showCaptureButton={true}
                  onAngleChange={(yaw, pitch) => {
                    setStudioYaw(yaw);
                    setStudioPitch(pitch);
                  }}
                  onCaptureScreenshot={(dataUrl, yaw, pitch) => {
                    setStudioImageUrl(dataUrl);
                    setStudioYaw(yaw);
                    setStudioPitch(pitch);
                    setStudioSnapNotice(true);
                    window.setTimeout(() => setStudioSnapNotice(false), 1800);
                  }}
                  className="w-full h-64 md:h-72"
                />

                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const mainShot = sceneActionsRef.current?.captureMainCanvasScreenshot();
                      if (mainShot) {
                        setStudioImageUrl(mainShot);
                        setStudioSnapNotice(true);
                        window.setTimeout(() => setStudioSnapNotice(false), 1800);
                      }
                    }}
                    className="flex-1 py-1.5 px-2.5 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <ImageIcon className="w-3.5 h-3.5 text-[#38e2ff]" />
                    <span>Use Main Scene View</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadScreenshot}
                    className="py-1.5 px-3 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] flex items-center justify-center gap-1.5 text-[#8cd656] cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download PNG</span>
                  </button>
                </div>
              </div>

              {/* Right Column: Build Name, Bio, Captured Screenshot Preview & Save/Publish */}
              <div className="flex flex-col gap-2.5">
                <span className="text-xs text-[#38e2ff] font-semibold">
                  2. Choose Build Name, Bio & Cover Image
                </span>

                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-[#9ab8d0]">Build Name *</label>
                  <input
                    type="text"
                    value={studioName}
                    onChange={(e) => setStudioName(e.target.value)}
                    placeholder="Enter your build's title..."
                    className="w-full h-8 px-2.5 text-xs bg-[#081824] border border-[#1e4460] focus:border-[#38e2ff] rounded text-white outline-none"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-[#9ab8d0]">
                    Build Bio / Description * (Shown when clicked in Shop)
                  </label>
                  <textarea
                    rows={3}
                    value={studioBio}
                    onChange={(e) => setStudioBio(e.target.value)}
                    placeholder="Describe your build, its biomes, secret rooms, or architecture..."
                    className="w-full p-2 text-xs bg-[#081824] border border-[#1e4460] focus:border-[#38e2ff] rounded text-white outline-none resize-none"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-[#9ab8d0]">Shop Price (SAND)</label>
                  <input
                    type="text"
                    value={studioPrice}
                    onChange={(e) => setStudioPrice(e.target.value)}
                    placeholder="e.g. 250 SAND"
                    className="w-full h-8 px-2.5 text-xs bg-[#081824] border border-[#1e4460] focus:border-[#38e2ff] rounded text-white outline-none"
                  />
                </div>

                {/* Captured Cover Image Preview */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-[#9ab8d0]">Captured Cover Image Preview</span>
                    {studioSnapNotice && (
                      <span className="text-[11px] text-[#8cd656] flex items-center gap-1 font-medium">
                        <Check className="w-3 h-3" /> Screenshot Updated!
                      </span>
                    )}
                  </div>
                  <div className="w-full h-28 bg-[#081824] border border-[#1e4460] rounded-lg overflow-hidden flex items-center justify-center">
                    {studioImageUrl ? (
                      <img
                        src={studioImageUrl}
                        alt="Captured Build Preview"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-xs text-[#9ab8d0]">
                        Rotate the 3D model and click &apos;Snap Screenshot&apos;
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-1 mt-auto">
                  <button
                    type="button"
                    onClick={handleConfirmSaveToBuilds}
                    disabled={!studioName.trim() || !studioBio.trim()}
                    className="flex-1 py-2 text-xs font-semibold rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] disabled:opacity-40 flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Save className="w-3.5 h-3.5 text-[#8cd656]" />
                    <span>Save to My Builds</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmPublishToShop}
                    disabled={!studioName.trim() || !studioBio.trim()}
                    className="flex-1 py-2 text-xs font-semibold rounded border bg-[#1589b8] border-[#38e2ff] hover:bg-[#1ba3d9] disabled:opacity-40 flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <CloudUpload className="w-3.5 h-3.5" />
                    <span>Publish to Shop</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          POPUP MODAL FOR "MY BUILDS" & "THE SANDBOX SHOP"
          (Grid View shows Name & Image; Clicking a build opens Bio + 3D Rotatable Preview)
      ====================================================================== */}
      {(activeModal === 'shop' || activeModal === 'builds') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3">
          <div className="w-[820px] max-w-full h-[520px] max-h-[90vh] bg-[#081726]/98 border-2 border-[#38e2ff] rounded-xl p-4 flex flex-col gap-3 shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#1e4968] pb-2.5">
              <div className="flex items-center gap-2 text-[#38e2ff] font-bold text-xs md:text-sm tracking-wide">
                {selectedBuildDetail ? (
                  <button
                    onClick={() => setSelectedBuildDetail(null)}
                    className="px-2.5 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] text-white flex items-center gap-1 cursor-pointer mr-1"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Back</span>
                  </button>
                ) : activeModal === 'shop' ? (
                  <ShoppingBag className="w-4 h-4 text-[#f5c242] shrink-0" />
                ) : (
                  <FolderOpen className="w-4 h-4 text-[#38e2ff] shrink-0" />
                )}
                <span className="truncate">
                  {selectedBuildDetail
                    ? selectedBuildDetail.name
                    : activeModal === 'shop'
                      ? 'THE SANDBOX COMMUNITY SHOP — Click any build to inspect Bio & 3D Preview'
                      : 'MY SAVED BUILDS — Click any build to inspect Bio & 3D Preview'}
                </span>
              </div>
              <button
                onClick={() => {
                  setSelectedBuildDetail(null);
                  setActiveModal(null);
                }}
                className="px-3 py-1 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-[#183752] hover:border-[#38e2ff] flex items-center gap-1 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                <span>Close</span>
              </button>
            </div>

            {/* BUILD DETAIL VIEW: Shows Bio + Interactive 3D Rotatable Preview + Cover Image */}
            {selectedBuildDetail ? (
              <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 overflow-y-auto pr-1">
                <div className="flex flex-col gap-2">
                  <span className="text-xs text-[#38e2ff] font-semibold flex items-center gap-1.5">
                    <Box className="w-3.5 h-3.5" />
                    <span>Interactive 3D Rotatable Preview</span>
                  </span>
                  <VoxelPreview3D
                    voxels={selectedBuildDetail.voxels}
                    initialYaw={selectedBuildDetail.previewYaw ?? 0.785}
                    initialPitch={selectedBuildDetail.previewPitch ?? -0.52}
                    autoRotateDefault={true}
                    showCaptureButton={false}
                    className="w-full h-64 md:h-72"
                  />
                </div>

                <div className="flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-base font-bold text-white">{selectedBuildDetail.name}</h3>
                      <p className="text-xs text-[#f5c242]">
                        {selectedBuildDetail.author} • {selectedBuildDetail.price} •{' '}
                        {selectedBuildDetail.voxels.length} Cubes
                      </p>
                    </div>
                  </div>

                  <div className="bg-[#0f2436] border border-[#1e4968] rounded-lg p-3 flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-[#38e2ff]">
                      <FileText className="w-3.5 h-3.5" />
                      <span>Build Bio & Description</span>
                    </div>
                    <p className="text-xs text-slate-200 leading-relaxed whitespace-pre-wrap">
                      {selectedBuildDetail.bio ||
                        'A custom voxel creation crafted in The Sandbox Voxel Workshop.'}
                    </p>
                  </div>

                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] text-[#9ab8d0]">Captured Build Image</span>
                    <div className="w-full h-28 bg-[#081824] border border-[#1e4460] rounded-lg overflow-hidden">
                      <img
                        src={
                          selectedBuildDetail.imageUrl ||
                          createBuildThumbnailDataUrl(selectedBuildDetail.voxels)
                        }
                        alt={selectedBuildDetail.name}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 mt-auto pt-1">
                    <button
                      onClick={() => handleLoadVoxelBuild(selectedBuildDetail)}
                      className="flex-1 py-2 text-xs font-semibold rounded border bg-[#1589b8] border-[#38e2ff] hover:bg-[#1ba3d9] flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      {activeModal === 'shop' ? (
                        <>
                          <ShoppingBag className="w-4 h-4" />
                          <span>Buy & Load into Workshop ({selectedBuildDetail.price})</span>
                        </>
                      ) : (
                        <>
                          <FolderOpen className="w-4 h-4" />
                          <span>Load & Edit in Workshop</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              /* SHOP / BUILDS GRID VIEW: Shows Name & Image (click card to open Bio & 3D Preview) */
              <div className="flex-1 overflow-y-auto pr-1">
                {modalList.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center gap-2 text-sm text-[#9ab8d0] text-center px-4">
                    <span>No builds saved yet!</span>
                    <button
                      onClick={openSaveStudioModal}
                      className="px-3 py-1.5 text-xs rounded border bg-[#1589b8] border-[#38e2ff] text-white cursor-pointer"
                    >
                      Open Screenshot & Save Studio
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3.5">
                    {modalList.map((item, idx) => {
                      const coverImg =
                        item.imageUrl || createBuildThumbnailDataUrl(item.voxels);
                      return (
                        <div
                          key={`${item.name}-${idx}`}
                          onClick={() => setSelectedBuildDetail(item)}
                          className="group bg-[#0f2436] hover:bg-[#143047] border border-[#26b5d6] hover:border-[#38e2ff] rounded-lg overflow-hidden flex flex-col cursor-pointer transition-all shadow-md"
                        >
                          <div className="relative w-full h-36 bg-[#081824] overflow-hidden border-b border-[#1e4460]">
                            <img
                              src={coverImg}
                              alt={item.name}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                            />
                            <div className="absolute top-2 right-2 bg-[#081824]/85 border border-[#38e2ff]/60 rounded px-2 py-0.5 text-[10px] font-semibold text-[#f5c242]">
                              {item.price}
                            </div>
                            <div className="absolute bottom-2 left-2 bg-[#081824]/85 rounded px-2 py-0.5 text-[10px] text-[#38e2ff] flex items-center gap-1">
                              <Box className="w-3 h-3" />
                              <span>Click for Bio & 3D View</span>
                            </div>
                          </div>

                          <div className="p-2.5 flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-xs font-bold text-white truncate">
                                {item.name}
                              </div>
                              <div className="text-[11px] text-[#9ab8d0] truncate">
                                {item.author} • {item.voxels.length} cubes
                              </div>
                            </div>

                            {activeModal === 'builds' && (
                              <button
                                onClick={(e) => handleDeleteSavedBuild(idx, e)}
                                title="Delete Build"
                                className="p-1.5 text-xs rounded border bg-[#102538] border-[#1e4460] hover:bg-red-900/60 hover:border-red-400 flex items-center justify-center shrink-0 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5 text-red-300" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
