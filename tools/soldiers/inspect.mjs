// Prints what a soldier GLB contains: meshes, skin joints, textures, landmark extras.
//   node tools/soldiers/inspect.mjs public/assets/soldiers/red.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
for (const m of root.listMeshes()) {
  for (const p of m.listPrimitives()) {
    const idx = p.getIndices();
    console.log(`mesh ${m.getName()}: ${(idx ? idx.getCount() : 0) / 3} tris, ${p.getAttribute('POSITION').getCount()} verts, attrs ${p.listSemantics().join(',')}`);
  }
}
for (const s of root.listSkins()) console.log(`skin: ${s.listJoints().length} joints: ${s.listJoints().map((j) => j.getName()).join(' ')}`);
for (const t of root.listTextures()) {
  const size = t.getSize();
  console.log(`texture ${t.getName() || t.getURI()}: ${t.getMimeType()} ${size ? size.join('x') : '?'} ${(t.getImage().byteLength / 1024).toFixed(0)} KB`);
}
for (const n of root.listNodes()) {
  const ex = n.getExtras();
  if (ex && Object.keys(ex).length) console.log(`extras on node ${n.getName()}: ${Object.keys(ex).join(',')}`);
  const mesh = n.getMesh();
  if (mesh && Object.keys(mesh.getExtras()).length) console.log(`extras on mesh ${mesh.getName()}: ${Object.keys(mesh.getExtras()).join(',')}`);
}
console.log('extensions:', root.listExtensionsUsed().map((e) => e.extensionName).join(', '));
