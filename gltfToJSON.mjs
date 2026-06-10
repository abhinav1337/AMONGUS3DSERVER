import { NodeIO } from '@gltf-transform/core';
import fs from 'fs';
import path from 'path';

const [,, input, output = 'out.json'] = process.argv;
if (!input) {
  console.error('Usage: node gltfToJSON.mjs input.gltf|glb [output.json]');
  process.exit(1);
}

const inputPath = path.resolve(input);
const io = new NodeIO(); // no registerExtensions needed for basic geometry

// <-- here: await the read
const doc = await io.read(inputPath);
const root = doc.getRoot();


const walls = [];

/**
 * Apply a 4x4 world matrix (column-major, same layout as three.js) to a vec3.
 */
function applyMatrix4(v3, m) {
  const x = v3[0], y = v3[1], z = v3[2];
  const nx = m[0] * x + m[4] * y + m[8]  * z + m[12];
  const ny = m[1] * x + m[5] * y + m[9]  * z + m[13];
  const nz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const w  = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (w && w !== 1) {
    return [nx / w, ny / w, nz / w];
  }
  return [nx, ny, nz];
}

// Walk nodes that have meshes
root.listNodes().forEach(node => {
  const mesh = node.getMesh();
  if (!mesh) return;

  // Get the world matrix of this node
  // glTF-Transform Node has getWorldMatrix() returning Float32Array[16]
  const worldMatrix = node.getWorldMatrix ? node.getWorldMatrix() : null;

  mesh.listPrimitives().forEach(prim => {
    const position = prim.getAttribute('POSITION');
    if (!position) return;

    const array = position.getArray(); // Float32Array of XYZ triples
    const localMin = [Infinity, Infinity, Infinity];
    const localMax = [-Infinity, -Infinity, -Infinity];

    for (let i = 0; i < array.length; i += 3) {
      const x = array[i], y = array[i + 1], z = array[i + 2];
      localMin[0] = Math.min(localMin[0], x);
      localMin[1] = Math.min(localMin[1], y);
      localMin[2] = Math.min(localMin[2], z);
      localMax[0] = Math.max(localMax[0], x);
      localMax[1] = Math.max(localMax[1], y);
      localMax[2] = Math.max(localMax[2], z);
    }

    // Local center & size
    const centerLocal = [
      (localMin[0] + localMax[0]) / 2,
      (localMin[1] + localMax[1]) / 2,
      (localMin[2] + localMax[2]) / 2
    ];
    const sizeLocal = [
      localMax[0] - localMin[0],
      localMax[1] - localMin[1],
      localMax[2] - localMin[2]
    ];

    // Transform center into world space
    const centerWorld = worldMatrix
      ? applyMatrix4(centerLocal, worldMatrix)
      : centerLocal.slice();

    // Extract world scale from matrix columns (approximate)
    let scaleX = 1, scaleY = 1, scaleZ = 1;
    if (worldMatrix) {
      scaleX = Math.hypot(worldMatrix[0], worldMatrix[1], worldMatrix[2]);
      scaleY = Math.hypot(worldMatrix[4], worldMatrix[5], worldMatrix[6]);
      scaleZ = Math.hypot(worldMatrix[8], worldMatrix[9], worldMatrix[10]);
    }

    const sizeWorld = [
      sizeLocal[0] * scaleX,
      sizeLocal[1] * scaleY,
      sizeLocal[2] * scaleZ
    ];

    // Emit in your game format: center.x/z and width/depth from X/Z size
    walls.push({
      name: node.getName() || mesh.getName() || 'unnamed',
      x: centerWorld[0],
      z: centerWorld[2],
      width: sizeWorld[0],
      depth: sizeWorld[2]
    });
  });
});

await fs.promises.writeFile(output, JSON.stringify(walls, null, 2), 'utf-8');
console.log(`Exported ${walls.length} wall/prop entries to ${output}`);
