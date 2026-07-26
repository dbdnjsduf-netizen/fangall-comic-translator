import sharp from "sharp";
import { readFile, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = dirname(__dirname);
const batchId = process.argv[2];
const itemId = process.argv[3] || "item-1";
const insetValues = (process.argv[4] || "5,10,20")
  .split(",")
  .map((value) => Math.max(0, Math.round(Number(value))))
  .filter((value, index, values) => Number.isFinite(value) && values.indexOf(value) === index);

if (!batchId || !insetValues.length) {
  throw new Error("Usage: node scripts/painted_overrestore_trials.mjs <batch-id> [item-id] [5,10,20]");
}

const statePath = join(projectDir, "tmp", "batch-state", `${batchId}.json`);
const state = JSON.parse(await readFile(statePath, "utf8"));
const item = state.items?.find((candidate) => candidate.id === itemId);
if (!item) throw new Error(`Item not found: ${batchId}/${itemId}`);

const generatedPath = item.currentPromptUnrestoredPath || item.unrestoredGeneratedPath;
const sourcePath = item.restorationSourcePath;
if (!generatedPath || !sourcePath) throw new Error("Saved generated/source layers are unavailable.");

const width = item.targetSize?.width;
const height = item.targetSize?.height;
if (!width || !height) throw new Error("Saved target dimensions are unavailable.");

const clampUnit = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const protection = item.protectionRegions || {};
const regions = Array.isArray(protection.regions) ? protection.regions : [];
const strokes = Array.isArray(protection.strokes) ? protection.strokes : [];
const shapes = [];

for (const region of regions) {
  const x = Math.round(clampUnit(region.x) * width);
  const y = Math.round(clampUnit(region.y) * height);
  const regionWidth = Math.max(1, Math.round(clampUnit(region.width) * width));
  const regionHeight = Math.max(1, Math.round(clampUnit(region.height) * height));
  shapes.push(`<rect x="${x}" y="${y}" width="${regionWidth}" height="${regionHeight}" fill="#fff"/>`);
}

for (const stroke of strokes) {
  const points = Array.isArray(stroke.points) ? stroke.points : [];
  if (!points.length) continue;
  const radius = Math.max(1, Math.round((Number(stroke.radius) || 0) * width));
  const mapped = points.map((point) => ({
    x: Math.round(clampUnit(point.x) * width),
    y: Math.round(clampUnit(point.y) * height),
  }));
  if (mapped.length === 1) {
    shapes.push(`<circle cx="${mapped[0].x}" cy="${mapped[0].y}" r="${radius}" fill="#fff"/>`);
  } else {
    const d = mapped.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join("");
    shapes.push(`<path d="${d}" fill="none" stroke="#fff" stroke-width="${radius * 2}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
}

if (!shapes.length) throw new Error("No painted mask shapes were saved.");

const maskSvg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes.join("")}</svg>`,
);
const renderedMask = await sharp(maskSvg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const mask = new Uint8Array(width * height);
const maskChannels = renderedMask.info.channels;
for (let pixel = 0; pixel < mask.length; pixel++) {
  mask[pixel] = renderedMask.data[pixel * maskChannels + maskChannels - 1] > 0 ? 1 : 0;
}

const maxInset = Math.max(...insetValues);
const distance = new Uint16Array(mask.length);
const queue = new Int32Array(mask.length);
let queueLength = 0;
const neighbors = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

for (let pixel = 0; pixel < mask.length; pixel++) {
  if (!mask[pixel]) continue;
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  let boundary = x === 0 || y === 0 || x === width - 1 || y === height - 1;
  if (!boundary) {
    for (const [dx, dy] of neighbors) {
      if (!mask[(y + dy) * width + x + dx]) {
        boundary = true;
        break;
      }
    }
  }
  if (boundary) {
    distance[pixel] = 1;
    queue[queueLength++] = pixel;
  }
}

for (let head = 0; head < queueLength; head++) {
  const pixel = queue[head];
  const currentDistance = distance[pixel];
  if (currentDistance > maxInset) continue;
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  for (const [dx, dy] of neighbors) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
    const next = ny * width + nx;
    if (!mask[next] || distance[next]) continue;
    distance[next] = currentDistance + 1;
    queue[queueLength++] = next;
  }
}

const [source, generated] = await Promise.all([
  sharp(sourcePath).resize(width, height, { fit: "fill" }).ensureAlpha().raw().toBuffer(),
  sharp(generatedPath).resize(width, height, { fit: "fill" }).ensureAlpha().raw().toBuffer(),
]);
const downloadsDir = join(homedir(), "Downloads");
const sentinelPreview = Buffer.alloc(source.length);
const sentinelTilePx = 32;
const sentinelHalfTile = sentinelTilePx / 2;
const edgePx = 12;
for (let pixel = 0; pixel < mask.length; pixel++) {
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  const offset = pixel * 4;
  const revealSource = mask[pixel] || x < edgePx || y < edgePx || x >= width - edgePx || y >= height - edgePx;
  if (revealSource) {
    source.copy(sentinelPreview, offset, offset, offset + 4);
    continue;
  }
  const magenta = (x % sentinelTilePx >= sentinelHalfTile) !== (y % sentinelTilePx >= sentinelHalfTile);
  sentinelPreview[offset] = magenta ? 255 : 0;
  sentinelPreview[offset + 1] = magenta ? 0 : 229;
  sentinelPreview[offset + 2] = magenta ? 204 : 255;
  sentinelPreview[offset + 3] = 255;
}
const sentinelPreviewPath = join(downloadsDir, "painted-sentinel-input-preview.png");
await sharp(sentinelPreview, { raw: { width, height, channels: 4 } }).png().toFile(sentinelPreviewPath);
const outputRows = [];
let originalMaskPixels = 0;
for (const value of mask) originalMaskPixels += value;

for (const insetPx of insetValues) {
  const output = Buffer.from(source);
  let retainedPixels = 0;
  for (let pixel = 0; pixel < mask.length; pixel++) {
    if (!mask[pixel]) continue;
    const boundaryDistance = distance[pixel];
    if (boundaryDistance && boundaryDistance <= insetPx) continue;
    const offset = pixel * 4;
    generated.copy(output, offset, offset, offset + 4);
    retainedPixels++;
  }
  const outputPath = join(downloadsDir, `painted-overrestore-${insetPx}px.png`);
  await sharp(output, { raw: { width, height, channels: 4 } }).png().toFile(outputPath);
  outputRows.push({ insetPx, outputPath, retainedPixels, restoredPixels: originalMaskPixels - retainedPixels });
}

const thumbWidth = 480;
const thumbHeight = Math.round(height * thumbWidth / width);
const labelHeight = 54;
const comparisonWidth = thumbWidth * outputRows.length;
const comparisonHeight = thumbHeight + labelHeight;
const composites = [];
for (let index = 0; index < outputRows.length; index++) {
  const row = outputRows[index];
  const thumbnail = await sharp(row.outputPath).resize(thumbWidth, thumbHeight, { fit: "fill" }).png().toBuffer();
  composites.push({ input: thumbnail, left: index * thumbWidth, top: labelHeight });
}
const labels = outputRows.map((row, index) => (
  `<rect x="${index * thumbWidth}" y="0" width="${thumbWidth}" height="${labelHeight}" fill="#fff"/>`
  + `<text x="${index * thumbWidth + thumbWidth / 2}" y="36" text-anchor="middle" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#111">Original restore ${row.insetPx}px</text>`
)).join("");
composites.unshift({
  input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${comparisonWidth}" height="${labelHeight}">${labels}</svg>`),
  left: 0,
  top: 0,
});
const comparisonPath = join(downloadsDir, "painted-overrestore-comparison-5-10-20px.png");
await sharp({ create: { width: comparisonWidth, height: comparisonHeight, channels: 3, background: "#fff" } })
  .composite(composites)
  .png()
  .toFile(comparisonPath);

console.log(JSON.stringify({
  batchId,
  itemId,
  sourcePath,
  generatedPath,
  sentinelPreviewPath,
  comparisonPath,
  originalMaskPixels,
  outputs: outputRows,
}, null, 2));
