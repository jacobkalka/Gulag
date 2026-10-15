// Step 3 of the soldier pipeline: game-ready textures and compressed geometry.
//   node tools/soldiers/finalize.mjs <rigged.glb> <out.glb> [maxTexture=2048]
// Albedo and ORM become WebP (lossy), normals lossless WebP; geometry gets meshopt compression
// (the game loads it with three's MeshoptDecoder).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, textureCompress } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { statSync } from 'node:fs';

const [src, dst, maxArg = '2048'] = process.argv.slice(2);
const max = Number(maxArg);
await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(src);
await doc.transform(
  dedup(),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [max, max], quality: 86, slots: /^(?!normalTexture).*$/ }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [max, max], lossless: true, slots: /^normalTexture$/ }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
await io.write(dst, doc);
const mb = (f) => (statSync(f).size / 1048576).toFixed(1);
console.log(`${src} (${mb(src)} MB) -> ${dst} (${mb(dst)} MB)`);
