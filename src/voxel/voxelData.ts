import * as THREE from 'three';

export const CHUNK_SIZE = 16;
export const WORLD_SIZE = 32;

export const PALETTE: string[] = [
  '#ffffff',
  // Forest & Cliff (1-8)
  '#5ac54f', '#3e8948', '#265c42', '#8cd656',
  '#8a5844', '#6d4234', '#523126', '#a87056',
  // Frost & Crystal (9-16)
  '#e3f8ff', '#99e6ff', '#38c6d9', '#1685a8',
  '#0f5573', '#6b8299', '#485869', '#ffffff',
  // Desert & Gold (17-24)
  '#ffe678', '#f5c242', '#d99126', '#b36b19',
  '#e8c170', '#c49a52', '#8c6b3b', '#544026',
  // Volcanic & Obsidian (25-32)
  '#ff5232', '#ff8c24', '#c42430', '#42393b',
  '#2b2527', '#1a1618', '#635659', '#ffdb4d',
];

export const TEX_NAMES = [
  'Grass Block',
  'Solid Matte',
  'Ice Crystal',
  'Magma Core',
  'Stone Brick',
  'Wood Planks',
  'Desert Sand',
  'Forest Leaf',
];

export const TEX_SHORT = [
  'Grass',
  'Solid',
  'Ice',
  'Magma',
  'Stone',
  'Wood',
  'Sand',
  'Leaf',
];

export const BIOME_GROUPS: Array<{ name: string; startIdx: number }> = [
  { name: 'Forest & Cliff', startIdx: 1 },
  { name: 'Frost & Crystal', startIdx: 9 },
  { name: 'Desert & Gold', startIdx: 17 },
  { name: 'Volcanic & Obsidian', startIdx: 25 },
];

export type VoxelEntry = [number, number, number, number]; // [x, y, z, packed]

export interface SavedBuild {
  name: string;
  author: string;
  price: string;
  voxels: VoxelEntry[];
}

export function packVoxel(colIdx: number, texIdx: number): number {
  return (colIdx & 0xff) | ((texIdx & 0xff) << 8);
}

export function unpackVoxel(val: number): { colIdx: number; texIdx: number } {
  const absVal = Math.abs(val);
  const colIdx = Math.min(Math.max(absVal & 0xff, 1), PALETTE.length - 1);
  const texIdx = Math.min(Math.max((absVal >> 8) & 0xff, 0), 7);
  return { colIdx, texIdx };
}

export function posKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

export function parsePosKey(key: string): [number, number, number] {
  const parts = key.split(',');
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/**
 * Generates the exact 128x16 procedural pixel atlas from voxel_chunk.gd
 */
export function createPixelAtlasTexture(): THREE.DataTexture {
  const width = 128;
  const height = 16;
  const data = new Uint8Array(width * height * 4);

  for (let t = 0; t < 8; t++) {
    const ox = t * 16;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        let v = 0.96;
        if (x === 0 || y === 0 || x === 15 || y === 15) {
          v = 0.82;
        }
        if (t === 0) {
          if (y < 4 || (y === 4 && x % 3 === 0)) v = 1.04;
          else if ((x * 7 + y * 13) % 5 === 0) v = 0.88;
        } else if (t === 2) {
          const sum = x + y;
          if (sum === 5 || sum === 6 || sum === 17 || sum === 18) v = 1.15;
        } else if (t === 3) {
          if ((x * 3 + y * 5) % 9 === 0) v = 1.2;
          else if ((x + y) % 4 === 0) v = 0.78;
        } else if (t === 4) {
          const rowBlock = Math.floor(y / 8);
          if (y % 8 === 0 || (x + rowBlock * 8) % 16 === 0) v = 0.72;
        } else if (t === 5) {
          const rowBlock = Math.floor(y / 4);
          if (y % 4 === 0 || (x === 8 && rowBlock % 2 === 0)) v = 0.76;
        } else if (t === 6) {
          if ((x * 11 + y * 7) % 6 === 0) v = 0.88;
        } else if (t === 7) {
          if ((x + y) % 2 === 0) v = 0.86;
        }

        const byteVal = Math.min(255, Math.max(0, Math.round(v * 255)));
        const idx = (y * width + (ox + x)) * 4;
        data[idx] = byteVal;
        data[idx + 1] = byteVal;
        data[idx + 2] = byteVal;
        data[idx + 3] = 255;
      }
    }
  }

  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Generates the initial Four-Biome Floating Island from voxel_world.gd
 */
export function generateSandboxIslandData(): Map<string, number> {
  const map = new Map<string, number>();
  const setVoxel = (x: number, y: number, z: number, val: number) => {
    if (x < 0 || x >= WORLD_SIZE || y < 0 || y >= WORLD_SIZE || z < 0 || z >= WORLD_SIZE) return;
    if (val === 0) map.delete(posKey(x, y, z));
    else map.set(posKey(x, y, z), val);
  };

  for (let x = 4; x < 28; x++) {
    for (let z = 4; z < 28; z++) {
      const dist = Math.hypot(x - 15.5, z - 15.5);
      const wave = Math.trunc(Math.sin(x * 0.8) * 1.8 + Math.cos(z * 0.8) * 1.8);
      const bottomY = Math.min(9, Math.max(2, Math.trunc(dist * 0.48) + 2 + wave));
      for (let y = bottomY; y < 11; y++) {
        let col = 5;
        let tex = 4;
        if (y === 9 && (x === 4 || x === 27 || z === 4 || z === 27)) {
          col = 2;
          tex = 0;
        } else if (y === 10) {
          if (x < 16 && z < 16) {
            col = (x + z) % 2 === 0 ? 10 : 9;
            tex = 2;
          } else if (x >= 16 && z < 16) {
            col = (x + z) % 3 !== 0 ? 1 : 2;
            tex = 0;
          } else if (x < 16 && z >= 16) {
            col = (x * z) % 5 !== 0 ? 28 : 25;
            tex = col === 25 ? 3 : 4;
          } else {
            if ((x === 17 || x === 26 || z === 17 || z === 26) && (x + z) % 2 === 0) {
              col = 29;
              tex = 4;
            } else {
              col = 17;
              tex = 6;
            }
          }
        }
        setVoxel(x, y, z, packVoxel(col, tex));
      }
    }
  }

  // Floating rocks around perimeter
  const rocks: Array<[number, number, number]> = [
    [1, 5, 10],
    [2, 4, 22],
    [10, 3, 29],
    [29, 5, 19],
  ];
  for (const [rx0, ry0, rz0] of rocks) {
    for (let rx = 0; rx < 2; rx++) {
      for (let rz = 0; rz < 2; rz++) {
        setVoxel(rx0 + rx, ry0, rz0 + rz, packVoxel(5, 4));
        setVoxel(rx0 + rx, ry0 + 1, rz0 + rz, packVoxel(2, 0));
      }
    }
  }

  // Frost spires
  const spires: Array<[number, number, number]> = [
    [8, 8, 6],
    [9, 8, 8],
    [10, 9, 7],
    [8, 10, 5],
    [11, 7, 5],
    [7, 7, 4],
  ];
  for (const [sx, sz, sh] of spires) {
    for (let y = 11; y < 11 + sh; y++) {
      setVoxel(sx, y, sz, packVoxel(11, 2));
    }
  }

  // Volcano mound
  for (let l = 0; l < 3; l++) {
    for (let x = 6 + l; x < 13 - l; x++) {
      for (let z = 18 + l; z < 25 - l; z++) {
        setVoxel(x, 11 + l, z, packVoxel(6, 4));
      }
    }
  }
  setVoxel(9, 14, 21, packVoxel(25, 3));
  setVoxel(8, 13, 21, packVoxel(26, 3));

  // Center obelisk
  for (let y = 11; y < 17; y++) {
    setVoxel(15, y, 15, packVoxel(29, 4));
    setVoxel(16, y, 15, packVoxel(29, 4));
    if (y === 13 || y === 14) {
      setVoxel(14, y, 15, packVoxel(29, 4));
      setVoxel(17, y, 15, packVoxel(29, 4));
    }
  }

  // Desert pyramid
  for (let l = 0; l < 4; l++) {
    for (let x = 18 + l; x < 26 - l; x++) {
      for (let z = 18 + l; z < 26 - l; z++) {
        setVoxel(x, 11 + l, z, packVoxel(l % 2 === 0 ? 18 : 17, 6));
      }
    }
  }

  // Forest platform & trees
  for (let x = 19; x < 26; x++) {
    for (let z = 6; z < 13; z++) {
      setVoxel(x, 11, z, packVoxel(5, 5));
      if ((x === 20 || x === 24) && (z === 7 || z === 11)) {
        for (let ty = 12; ty < 15; ty++) {
          setVoxel(x, ty, z, packVoxel(6, 5));
        }
        for (let lx = x - 1; lx <= x + 1; lx++) {
          for (let lz = z - 1; lz <= z + 1; lz++) {
            setVoxel(lx, 15, lz, packVoxel(1, 7));
          }
        }
        setVoxel(x, 16, z, packVoxel(4, 7));
      }
    }
  }

  return map;
}

export function generateFrostCitadelVoxels(): VoxelEntry[] {
  const citadelVox: VoxelEntry[] = [];
  for (let x = 10; x < 22; x++) {
    for (let z = 10; z < 22; z++) {
      citadelVox.push([x, 10, z, packVoxel(10, 2)]);
      if ((x === 10 || x === 21 || z === 10 || z === 21) && (x + z) % 2 === 0) {
        for (let y = 11; y < 16; y++) {
          citadelVox.push([x, y, z, packVoxel(11, 2)]);
        }
      }
    }
  }
  for (let y = 11; y < 21; y++) {
    citadelVox.push([15, y, 15, packVoxel(9, 2)]);
    citadelVox.push([16, y, 15, packVoxel(11, 2)]);
  }
  return citadelVox;
}

export function serializeWorldMap(map: Map<string, number>): VoxelEntry[] {
  const arr: VoxelEntry[] = [];
  map.forEach((val, key) => {
    const [x, y, z] = parsePosKey(key);
    arr.push([x, y, z, val]);
  });
  return arr;
}

/**
 * Greedy Meshing for a 16x16x16 chunk (ported directly from voxel_chunk.gd)
 */
export function buildChunkGreedyGeometry(
  chunkX: number,
  chunkY: number,
  chunkZ: number,
  worldData: Map<string, number>,
): THREE.BufferGeometry {
  const baseX = chunkX * CHUNK_SIZE;
  const baseY = chunkY * CHUNK_SIZE;
  const baseZ = chunkZ * CHUNK_SIZE;

  const getChunkVoxel = (lx: number, ly: number, lz: number): number => {
    if (lx < 0 || lx >= CHUNK_SIZE || ly < 0 || ly >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) {
      return 0;
    }
    return worldData.get(posKey(baseX + lx, baseY + ly, baseZ + lz)) ?? 0;
  };

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];

  const tempColor = new THREE.Color();
  const mask = new Int32Array(CHUNK_SIZE * CHUNK_SIZE);

  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const x = [0, 0, 0];
    const q = [0, 0, 0];
    q[axis] = 1;

    for (let d = -1; d < CHUNK_SIZE; d++) {
      x[axis] = d;
      let n = 0;
      for (let j = 0; j < CHUNK_SIZE; j++) {
        x[v] = j;
        for (let i = 0; i < CHUNK_SIZE; i++) {
          x[u] = i;
          const a = getChunkVoxel(x[0], x[1], x[2]);
          const b = getChunkVoxel(x[0] + q[0], x[1] + q[1], x[2] + q[2]);
          if ((a !== 0) === (b !== 0)) {
            mask[n] = 0;
          } else if (a !== 0) {
            mask[n] = a;
          } else {
            mask[n] = -b;
          }
          n++;
        }
      }

      n = 0;
      for (let j = 0; j < CHUNK_SIZE; j++) {
        let i = 0;
        while (i < CHUNK_SIZE) {
          const c = mask[n];
          if (c !== 0) {
            let w = 1;
            while (i + w < CHUNK_SIZE && mask[n + w] === c) {
              w++;
            }
            let h = 1;
            let done = false;
            while (j + h < CHUNK_SIZE) {
              for (let k = 0; k < w; k++) {
                if (mask[n + k + h * CHUNK_SIZE] !== c) {
                  done = true;
                  break;
                }
              }
              if (done) break;
              h++;
            }

            x[u] = i;
            x[v] = j;
            const du = [0, 0, 0];
            const dv = [0, 0, 0];
            du[u] = w;
            dv[v] = h;

            const px = x[0] + q[0];
            const py = x[1] + q[1];
            const pz = x[2] + q[2];

            const nx = c > 0 ? q[0] : -q[0];
            const ny = c > 0 ? q[1] : -q[1];
            const nz = c > 0 ? q[2] : -q[2];

            const { colIdx, texIdx } = unpackVoxel(c);
            tempColor.set(PALETTE[colIdx]);

            // Directional shading matching voxel_chunk.gd
            let shade = 1.0;
            if (Math.abs(nx) > 0.5) shade = 1.0 - 0.14;
            else if (Math.abs(nz) > 0.5) shade = 1.0 - 0.07;
            else if (ny < -0.5) shade = 1.0 - 0.28;

            const rCol = tempColor.r * shade;
            const gCol = tempColor.g * shade;
            const bCol = tempColor.b * shade;

            const u0 = (texIdx + 0.08) / 8.0;
            const u1 = (texIdx + 0.92) / 8.0;
            const uv0: [number, number] = [u0, 0.92];
            const uv1: [number, number] = [u1, 0.92];
            const uv2: [number, number] = [u1, 0.08];
            const uv3: [number, number] = [u0, 0.08];

            const v0: [number, number, number] = [px, py, pz];
            const v1: [number, number, number] = [px + du[0], py + du[1], pz + du[2]];
            const v2: [number, number, number] = [
              px + du[0] + dv[0],
              py + du[1] + dv[1],
              pz + du[2] + dv[2],
            ];
            const v3: [number, number, number] = [px + dv[0], py + dv[1], pz + dv[2]];

            const pushVertex = (pos: [number, number, number], uv: [number, number]) => {
              positions.push(pos[0], pos[1], pos[2]);
              normals.push(nx, ny, nz);
              uvs.push(uv[0], uv[1]);
              colors.push(rCol, gCol, bCol);
            };

            // Counter-clockwise outward face winding in Three.js
            if (c > 0) {
              pushVertex(v0, uv0);
              pushVertex(v1, uv1);
              pushVertex(v2, uv2);
              pushVertex(v0, uv0);
              pushVertex(v2, uv2);
              pushVertex(v3, uv3);
            } else {
              pushVertex(v0, uv0);
              pushVertex(v2, uv2);
              pushVertex(v1, uv1);
              pushVertex(v0, uv0);
              pushVertex(v3, uv3);
              pushVertex(v2, uv2);
            }

            for (let l = 0; l < h; l++) {
              for (let k = 0; k < w; k++) {
                mask[n + k + l * CHUNK_SIZE] = 0;
              }
            }
            i += w;
            n += w;
          } else {
            i++;
            n++;
          }
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Renders a top-down 32x32 pixel thumbnail data URL for a voxel build
 */
export function createBuildThumbnailDataUrl(voxels: VoxelEntry[]): string {
  const canvas = document.createElement('canvas');
  canvas.width = WORLD_SIZE;
  canvas.height = WORLD_SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#081824';
  ctx.fillRect(0, 0, WORLD_SIZE, WORLD_SIZE);

  const topY = new Map<string, [number, number]>();
  for (const [vx, vy, vz, packed] of voxels) {
    const key = `${vx},${vz}`;
    const existing = topY.get(key);
    if (!existing || vy > existing[0]) {
      topY.set(key, [vy, packed & 0xff]);
    }
  }

  topY.forEach(([, colIdx], key) => {
    const [xStr, zStr] = key.split(',');
    const x = Number(xStr);
    const z = Number(zStr);
    if (x >= 0 && x < WORLD_SIZE && z >= 0 && z < WORLD_SIZE) {
      const clampedIdx = Math.min(Math.max(colIdx, 1), PALETTE.length - 1);
      ctx.fillStyle = PALETTE[clampedIdx];
      ctx.fillRect(x, z, 1, 1);
    }
  });

  return canvas.toDataURL();
}
