// Card region detection utilities.
// filterBlocksToCardZone: single-card mode — keeps only blocks inside the scan overlay zone.
// detectCardRegions: multi-card mode (future) — clusters all blocks into card-shaped groups.

export interface OCRBlock {
  text: string;
  frame: { top: number; left: number; width: number; height: number };
}

export interface CardRegion {
  blocks: OCRBlock[];
  boundingBox: { top: number; left: number; width: number; height: number };
  text: string;
}

// Mirror ScanOverlay.tsx geometry: 75% screen width, 88:63 aspect, -40px Y offset.
const FRAME_W_FRACTION = 0.75;
const CARD_ASPECT = 88 / 63;
const FRAME_Y_OFFSET_PX = 40;

/**
 * Single-card mode: filters OCR blocks to only those whose center falls
 * within the scan overlay zone, correctly mapped to image coordinates.
 *
 * The camera captures at a different aspect ratio than the screen (typically
 * 4:3 vs ~9:20). The preview uses cover scaling — the image is scaled so its
 * shorter axis fills the screen, and the overflow is cropped. We reverse that
 * transform to find where the overlay frame sits inside the captured image.
 *
 * Falls back to all blocks if fewer than 2 survive filtering.
 */
export function filterBlocksToCardZone(
  blocks: OCRBlock[],
  imgW: number,
  imgH: number,
  screenW: number,
  screenH: number,
): OCRBlock[] {
  // Cover scale: the image is scaled up until it fills the screen on both axes.
  const scale = Math.max(screenW / imgW, screenH / imgH);

  // How many image pixels are hidden (cropped) on each side.
  const cropX = Math.max(0, (imgW * scale - screenW) / 2 / scale);
  const cropY = Math.max(0, (imgH * scale - screenH) / 2 / scale);

  // Overlay frame in screen coordinates (mirrors ScanOverlay.tsx).
  const fsW = screenW * FRAME_W_FRACTION;
  const fsH = fsW * CARD_ASPECT;
  const fsX = (screenW - fsW) / 2;
  const fsY = (screenH - fsH) / 2 - FRAME_Y_OFFSET_PX;

  // Map overlay frame from screen coords → image coords.
  // screen point s maps to image point: cropX + s / scale
  const fiX = cropX + fsX / scale;
  const fiY = cropY + fsY / scale;
  const fiW = fsW / scale;
  const fiH = fsH / scale;

  const filtered = blocks.filter((b) => {
    const cx = b.frame.left + b.frame.width / 2;
    const cy = b.frame.top + b.frame.height / 2;
    return cx >= fiX && cx <= fiX + fiW && cy >= fiY && cy <= fiY + fiH;
  });

  return filtered.length >= 2 ? filtered : blocks;
}

// ─── Multi-card helpers (used by detectCardRegions) ───────────────────────────

const TCG_ASPECT_MIN = 0.45;
const TCG_ASPECT_MAX = 1.0;
const MIN_BLOCKS = 2;

function blockCenter(b: OCRBlock) {
  return { x: b.frame.left + b.frame.width / 2, y: b.frame.top + b.frame.height / 2 };
}

function distance(a: OCRBlock, b: OCRBlock): number {
  const ac = blockCenter(a);
  const bc = blockCenter(b);
  return Math.sqrt((ac.x - bc.x) ** 2 + (ac.y - bc.y) ** 2);
}

function boundingBoxOf(blocks: OCRBlock[]) {
  const left = Math.min(...blocks.map((b) => b.frame.left));
  const top = Math.min(...blocks.map((b) => b.frame.top));
  const right = Math.max(...blocks.map((b) => b.frame.left + b.frame.width));
  const bottom = Math.max(...blocks.map((b) => b.frame.top + b.frame.height));
  return { left, top, width: right - left, height: bottom - top };
}

function clusterBlocks(blocks: OCRBlock[], threshold: number): OCRBlock[][] {
  const assigned = new Array(blocks.length).fill(-1);
  let nextCluster = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (assigned[i] !== -1) continue;
    assigned[i] = nextCluster;
    const queue = [i];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (let j = 0; j < blocks.length; j++) {
        if (assigned[j] !== -1) continue;
        if (distance(blocks[cur], blocks[j]) <= threshold) {
          assigned[j] = nextCluster;
          queue.push(j);
        }
      }
    }
    nextCluster++;
  }
  const clusters: OCRBlock[][] = Array.from({ length: nextCluster }, () => []);
  for (let i = 0; i < blocks.length; i++) clusters[assigned[i]].push(blocks[i]);
  return clusters;
}

/**
 * Multi-card mode: clusters all blocks by proximity and returns each
 * card-shaped cluster as a CardRegion, sorted closest-to-center first.
 */
export function detectCardRegions(
  blocks: OCRBlock[],
  imageWidth: number,
  imageHeight: number,
): CardRegion[] {
  if (blocks.length === 0) return [];

  const threshold = imageHeight * 0.25;
  const clusters = clusterBlocks(blocks, threshold);
  const imageCenterX = imageWidth / 2;
  const imageCenterY = imageHeight / 2;
  const regions: CardRegion[] = [];

  for (const cluster of clusters) {
    if (cluster.length < MIN_BLOCKS) continue;
    const bb = boundingBoxOf(cluster);
    const aspect = bb.width / bb.height;
    if (aspect < TCG_ASPECT_MIN || aspect > TCG_ASPECT_MAX) continue;
    if ((bb.width * bb.height) / (imageWidth * imageHeight) < 0.02) continue;

    const text = cluster
      .slice()
      .sort((a, b) => a.frame.top - b.frame.top)
      .map((b) => b.text)
      .join("\n");

    regions.push({ blocks: cluster, boundingBox: bb, text });
  }

  regions.sort((a, b) => {
    const aDist = (a.boundingBox.left + a.boundingBox.width / 2 - imageCenterX) ** 2 +
                  (a.boundingBox.top + a.boundingBox.height / 2 - imageCenterY) ** 2;
    const bDist = (b.boundingBox.left + b.boundingBox.width / 2 - imageCenterX) ** 2 +
                  (b.boundingBox.top + b.boundingBox.height / 2 - imageCenterY) ** 2;
    return aDist - bDist;
  });

  return regions;
}
