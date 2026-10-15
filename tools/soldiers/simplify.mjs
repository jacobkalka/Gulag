// Step 1 of the soldier pipeline: decimate a Tripo GLB to a game LOD with meshoptimizer.
// meshoptimizer keeps attribute seams (UV islands) intact, so the original textures still fit.
//   node tools/soldiers/simplify.mjs <in.glb> <out.glb> <targetTriangles>
// Needs the tool dependencies: (cd tools/soldiers && npm i)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';

const [src, dst, targetArg] = process.argv.slice(2);
if (!src || !dst || !targetArg) {
  console.error('usage: node simplify.mjs <in.glb> <out.glb> <targetTriangles>');
  process.exit(2);
}
await MeshoptDecoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(src);
for (const ext of doc.getRoot().listExtensionsUsed()) {
  if (['EXT_meshopt_compression', 'KHR_mesh_quantization'].includes(ext.extensionName)) ext.dispose();
}

const triangles = () => {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      n += (idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3;
    }
  }
  return n;
};

await doc.transform(dequantize(), weld());
const before = triangles();
const target = Number(targetArg);
// meshopt stops early when it would exceed the error bound; step the bound up until the
// target is reached (silhouette error stays small: the source is 1.9M triangles)
let error = 0.002;
let after = before;
for (let pass = 0; pass < 8 && after > target * 1.08; pass++) {
  await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: target / after, error, lockBorder: false }));
  after = triangles();
  console.log(`pass ${pass}: error ${error} -> ${Math.round(after)} triangles`);
  error *= 2;
}
await doc.transform(prune());
await io.write(dst, doc);
console.log(`${src}: ${Math.round(before)} -> ${Math.round(after)} triangles, wrote ${dst}`);
