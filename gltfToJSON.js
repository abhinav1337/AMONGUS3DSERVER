// Run with: node --loader=esbuild-register gltf-to-json.js path/to/map.glb out.json

import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { NodeIO } from '@gltf-transform/core'; // optional if you prefer gltf-transform; not required for bounding boxes

// Minimal DOM stub for three if needed (some builds don't need it)
globalThis.window = globalThis;
globalThis.document = {
  createElement() { return {}; }
};

if (process.argv.length < 4) {
  console.error('Usage: node gltf-to-json.js <input.glb> <output.json>');
  process.exit(1);
}
const input = process.argv[2];
const outFile = process.argv[3];

async function loadGLTF(file) {
  return new Promise((res, rej) => {
    const loader = new GLTFLoader();
    loader.load(
      file,
      gltf => res(gltf),
      undefined,
      err => rej(err)
    );
  });
}

function worldBoundingBox(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  return box;
}

function avgRotationYFromQuaternion(q) {
  // Extract yaw around Y axis from quaternion
  const euler = new THREE.Euler().setFromQuaternion(q, 'YXZ');
  return euler.y;
}

function sanitizeName(name) {
  if (!name) return '';
  return name.trim().toLowerCase();
}

(async () => {
  try {
    const gltf = await loadGLTF(input);
    const scene = gltf.scene;
    scene.updateMatrixWorld(true); // ensure world matrices are current

    const blocks = [];

    scene.traverse(obj => {
      if (!obj.isMesh) return;

      // Compute world-space bounding box
      const box = worldBoundingBox(obj);
      if (box.isEmpty()) return;

      const size = new THREE.Vector3();
      box.getSize(size); // in scene units
      const center = new THREE.Vector3();
      box.getCenter(center);

      // Assuming your game uses MAP_SCALE to convert between map units and world units,
      // reverse that here to get the 'x','z' in your JSON map coordinates.
      // If MAP_SCALE is 5 (as in your client), then map coord = world / MAP_SCALE.
      const MAP_SCALE = 5; // adjust if different in this export context

      const x = center.x / MAP_SCALE;
      const z = center.z / MAP_SCALE;
      const width  = size.x / MAP_SCALE;
      const depth  = size.z / MAP_SCALE;

      // Determine rotationY if any (you may need to decompose parent's rotation too)
      // For simplicity, assume object has no skew and world quaternion contains its rotation:
      const rotationY = avgRotationYFromQuaternion(obj.getWorldQuaternion(new THREE.Quaternion()));

      // Heuristics: decide if this is a wall vs prop vs task based on name
      const name = sanitizeName(obj.name);
      let entry = {
        name: obj.name || '',
        x, z,
        width: Number(width.toFixed(3)),
        depth: Number(depth.toFixed(3)),
      };
      if (Math.abs(rotationY) > 1e-3) {
        entry.rotationY = Number(rotationY.toFixed(4)); // in radians
      }

      // Simple tagging rules (customize for your map):
      if (name.includes('wall')) {
        entry.color = 0x999999; // example color highlight for walls
      }

      // If you want to break out this mesh as its own model file later:
      entry.model = null; // or set to something like `${obj.name || 'mesh'}.glb`

      // If you name something like "task_clean", assign a taskId
      if (name.startsWith('task_')) {
        const parts = name.split('_'); // e.g., "task_clean"
        const taskName = parts[1];
        // map to your internal taskId logic; example mapping:
        const taskMap = {
          clean: 5,
          upload: 1,
          swipe: 2,
          wiring: 6,
          reactor: 7,
          key: 4
        };
        if (taskMap[taskName]) {
          entry.taskId = taskMap[taskName];
        }
      }

      blocks.push(entry);
    });

    // Optionally: merge or postprocess overlapping/small walls here before writing.

    fs.writeFileSync(outFile, JSON.stringify(blocks, null, 2));
    console.log(`Wrote ${blocks.length} entries to ${outFile}`);
  } catch (err) {
    console.error('Error:', err);
  }
})();
