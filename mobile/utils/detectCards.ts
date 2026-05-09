// Card region detection utilities.
// filterBlocksToCardZone: single-card mode — keeps only blocks inside the scan overlay zone.
// detectCardRegions: multi-card mode fallback — clusters blocks into card-shaped groups.
// boxesToRegions: converts server-detected bounding boxes into CardRegion objects.

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
 */
export function filterBlocksToCardZone(
  blocks: OCRBlock[],
  imgW: number,
  imgH: number,
  screenW: number,
  screenH: number,
): OCRBlock[] {
  const scale = Math.max(screenW / imgW, screenH / imgH);
  const cropX = Math.max(0, (imgW * scale - screenW) / 2 / scale);
  const cropY = Math.max(0, (imgH * scale - screenH) / 2 / scale);

  const fsW = screenW * FRAME_W_FRACTION;
  const fsH = fsW * CARD_ASPECT;
  const fsX = (screenW - fsW) / 2;
  const fsY = (screenH - fsH) / 2 - FRAME_Y_OFFSET_PX;

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

// ─── Multi-card helpers ───────────────────────────────────────────────────────

// TCG cards are portrait (W/H ≈ 0.71). Allow some tolerance for angle/perspective.
const TCG_ASPECT_MIN = 0.40;
const TCG_ASPECT_MAX = 1.10;
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

function toRegion(cluster: OCRBlock[]): CardRegion {
  const bb = boundingBoxOf(cluster);
  const text = cluster
    .slice()
    .sort((a, b) => a.frame.top - b.frame.top)
    .map((b) => b.text)
    .join("\n");
  return { blocks: cluster, boundingBox: bb, text };
}

function sortByCenter(regions: CardRegion[], cx: number, cy: number): CardRegion[] {
  return regions.slice().sort((a, b) => {
    const ad =
      (a.boundingBox.left + a.boundingBox.width / 2 - cx) ** 2 +
      (a.boundingBox.top + a.boundingBox.height / 2 - cy) ** 2;
    const bd =
      (b.boundingBox.left + b.boundingBox.width / 2 - cx) ** 2 +
      (b.boundingBox.top + b.boundingBox.height / 2 - cy) ** 2;
    return ad - bd;
  });
}

/**
 * Recursively splits a cluster of OCR blocks into card-shaped regions.
 *
 * If the cluster's bounding box is too wide (multiple side-by-side cards merged),
 * it splits at the horizontal midpoint. If too tall (stacked cards), it splits at
 * the vertical midpoint. Each half is then checked recursively.
 *
 * This avoids the gap-detection fragility: we don't need to find empty space
 * between cards — we just keep splitting merged clusters until each piece has a
 * card-shaped aspect ratio.
 */
function recursiveSplitCluster(
  cluster: OCRBlock[],
  imageWidth: number,
  imageHeight: number,
  depth: number,
): CardRegion[] {
  if (cluster.length < MIN_BLOCKS) return [];

  const bb = boundingBoxOf(cluster);
  const aspect = bb.width / bb.height;
  const areaCoverage = (bb.width * bb.height) / (imageWidth * imageHeight);

  if (areaCoverage < 0.008) return []; // too small to be a card

  // Already card-shaped — accept.
  if (aspect >= TCG_ASPECT_MIN && aspect <= TCG_ASPECT_MAX) {
    return [toRegion(cluster)];
  }

  // Can't split further.
  if (depth >= 4 || cluster.length < MIN_BLOCKS * 2) return [];

  // Too wide: cards are side-by-side — split at horizontal midpoint.
  if (aspect > TCG_ASPECT_MAX) {
    const midX = bb.left + bb.width / 2;
    const left = cluster.filter((b) => b.frame.left + b.frame.width / 2 <= midX);
    const right = cluster.filter((b) => b.frame.left + b.frame.width / 2 > midX);
    if (left.length >= MIN_BLOCKS && right.length >= MIN_BLOCKS) {
      const results = [
        ...recursiveSplitCluster(left, imageWidth, imageHeight, depth + 1),
        ...recursiveSplitCluster(right, imageWidth, imageHeight, depth + 1),
      ];
      if (results.length > 0) return results;
    }
  }

  // Too tall: cards are stacked — split at vertical midpoint.
  if (aspect < TCG_ASPECT_MIN) {
    const midY = bb.top + bb.height / 2;
    const top = cluster.filter((b) => b.frame.top + b.frame.height / 2 <= midY);
    const bottom = cluster.filter((b) => b.frame.top + b.frame.height / 2 > midY);
    if (top.length >= MIN_BLOCKS && bottom.length >= MIN_BLOCKS) {
      const results = [
        ...recursiveSplitCluster(top, imageWidth, imageHeight, depth + 1),
        ...recursiveSplitCluster(bottom, imageWidth, imageHeight, depth + 1),
      ];
      if (results.length > 0) return results;
    }
  }

  return [];
}

/**
 * Multi-card mode: detects card-shaped regions in an image containing one or
 * more TCG cards in any arrangement.
 *
 * Strategy:
 * 1. Try progressive thresholds so that within-card blocks connect (threshold
 *    must be >= the spacing between the card's own text blocks).
 * 2. At each threshold, any cluster that is too wide or too tall for a single
 *    card is recursively split at the spatial midpoint until each piece is
 *    card-shaped.
 * 3. The threshold pass that yields the most card-shaped regions wins.
 *
 * The recursive split replaces gap-detection (which breaks when background
 * text fills the space between cards or when cards aren't axis-aligned).
 */
export function detectCardRegions(
  blocks: OCRBlock[],
  imageWidth: number,
  imageHeight: number,
): CardRegion[] {
  if (blocks.length === 0) return [];

  const cx = imageWidth / 2;
  const cy = imageHeight / 2;
  const minDim = Math.min(imageWidth, imageHeight);

  const thresholds = [
    minDim * 0.08,
    minDim * 0.15,
    minDim * 0.25,
    minDim * 0.40,
    minDim * 0.60,
  ];

  let bestRegions: CardRegion[] = [];

  for (const threshold of thresholds) {
    const clusters = clusterBlocks(blocks, threshold);
    const regions: CardRegion[] = [];

    for (const cluster of clusters) {
      if (cluster.length < MIN_BLOCKS) continue;
      const subRegions = recursiveSplitCluster(cluster, imageWidth, imageHeight, 0);
      regions.push(...subRegions);
    }

    if (regions.length > bestRegions.length) {
      bestRegions = regions;
    }
  }

  if (bestRegions.length > 0) {
    return sortByCenter(bestRegions, cx, cy);
  }

  // Fallback: return the largest cluster regardless of aspect ratio —
  // handles a single card filling the frame whose blocks are too sparse to
  // form a clean card-shaped cluster.
  const allClusters = clusterBlocks(blocks, minDim * 0.60);
  const largest = allClusters
    .filter((c) => c.length >= MIN_BLOCKS)
    .sort((a, b) => {
      const bba = boundingBoxOf(a);
      const bbb = boundingBoxOf(b);
      return bbb.width * bbb.height - bba.width * bba.height;
    })[0];

  return largest ? [toRegion(largest)] : [];
}

/**
 * Converts server-detected bounding boxes into CardRegion objects.
 * Boxes are already in image-pixel coordinates (relative to the resized
 * image sent to the backend). OCR text is filled in later by the
 * crop-and-re-OCR step in useMultiCardScan.
 */
export function boxesToRegions(boxes: Array<{ left: number; top: number; width: number; height: number }>): CardRegion[] {
  return boxes.map((box) => ({
    blocks: [],
    boundingBox: { top: box.top, left: box.left, width: box.width, height: box.height },
    text: "",
  }));
}
