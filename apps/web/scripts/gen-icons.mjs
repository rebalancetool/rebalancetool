import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

/**
 * Regenerates the raster icons in public/ from their SVG sources (also in
 * public/ — the SVGs are shipped as-is; the rasters are fallbacks for
 * browsers and platforms that don't take SVG icons). Everything is local:
 * `pnpm icons` after editing an SVG, then commit the outputs.
 *
 *   favicon.svg          → favicon.ico (16 + 32), icon-192.png, icon-512.png
 *   apple-touch-icon.svg → apple-touch-icon.png (180×180)
 */

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Renders an SVG square at `size`, bumping the rasterization density so vectors stay crisp. */
async function rasterize(svgName, size) {
  const svg = await readFile(path.join(publicDir, svgName));
  const { width } = await sharp(svg).metadata();
  const density = Math.ceil((72 * size) / (width ?? size));
  return sharp(svg, { density }).resize(size, size).png().toBuffer();
}

/**
 * Assembles an .ico container from PNG-encoded entries (valid since Windows
 * Vista and in every browser that still requests favicon.ico). sharp can't
 * write ICO itself; the format is just a 6-byte header, one 16-byte
 * directory entry per image, then the image blobs.
 */
function icoFromPngs(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach(({ size, png }, i) => {
    const at = i * 16;
    directory.writeUInt8(size === 256 ? 0 : size, at); // width (0 = 256)
    directory.writeUInt8(size === 256 ? 0 : size, at + 1); // height
    directory.writeUInt8(0, at + 2); // no palette
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // color planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...entries.map((e) => e.png)]);
}

const [png16, png32, png192, png512, apple180] = await Promise.all([
  rasterize("favicon.svg", 16),
  rasterize("favicon.svg", 32),
  rasterize("favicon.svg", 192),
  rasterize("favicon.svg", 512),
  rasterize("apple-touch-icon.svg", 180),
]);

const outputs = [
  ["favicon.ico", icoFromPngs([{ size: 16, png: png16 }, { size: 32, png: png32 }])],
  ["icon-192.png", png192],
  ["icon-512.png", png512],
  ["apple-touch-icon.png", apple180],
];
for (const [name, data] of outputs) {
  await writeFile(path.join(publicDir, name), data);
  console.log(`${name}  ${data.length} bytes`);
}
