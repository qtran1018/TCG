#!/usr/bin/env python3
"""
Fine-tune CLIP ViT-B/32 visual encoder on synthetic (augmented card photo, clean art) pairs.

This bridges the domain gap between phone photos of physical cards and the clean digital
art CLIP was originally trained on. Each training pair is:
  - anchor: official card art cropped to the art region (y=12%-52%)
  - positive: the same card's art pasted onto a random background texture, with perspective
    warp, color jitter, blur, and JPEG compression applied to simulate a real photo

InfoNCE contrastive loss pulls (anchor, positive) together and pushes apart non-matching
pairs within the same batch.

Usage (inside Docker container or locally with GPU):
    # Resume from existing fine-tuned weights (default — recommended for incremental retrains):
    python scripts/fine_tune_clip.py \
        --dataset "/en_cards" \
        --backgrounds "/backgrounds" \
        --output backend/models/clip_finetuned.pt \
        --resume backend/models/clip_finetuned.pt \
        --epochs 5

    # Start from base CLIP (first-ever training run, or intentional reset):
    python scripts/fine_tune_clip.py \
        --dataset "/en_cards" \
        --backgrounds "/backgrounds" \
        --output backend/models/clip_finetuned.pt \
        --resume "" \
        --epochs 10

--resume defaults to backend/models/clip_finetuned.pt. If the file exists, the visual
encoder is initialised from it before training begins, so the model builds on prior
learning rather than starting over. Pass --resume '' to force a cold start from base CLIP.

Only the visual encoder (image tower) is fine-tuned. The text encoder is frozen.
After training, re-run build_embeddings.py --force to re-embed all cards with the updated model.
"""

import argparse
import io
import logging
import math
import random
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from torch.utils.data import DataLoader, Dataset

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

SUPPORTED_EXTS = {".jpg", ".jpeg", ".png"}
CARD_W, CARD_H = 367, 512  # standard Pokemon card aspect ratio in pixels


# ---------------------------------------------------------------------------
# Art-region crop (must match card_embedder.py exactly)
# ---------------------------------------------------------------------------

def _crop_art(img: Image.Image) -> Image.Image:
    w, h = img.size
    return img.crop((int(w * 0.04), int(h * 0.12), int(w * 0.96), int(h * 0.52)))


# ---------------------------------------------------------------------------
# Augmentation pipeline
# ---------------------------------------------------------------------------

def _random_perspective(img: Image.Image, strength: float = 0.08) -> Image.Image:
    """Apply a random perspective warp to simulate a tilted card photo."""
    w, h = img.size
    dx = int(w * strength)
    dy = int(h * strength)

    src = [(0, 0), (w, 0), (w, h), (0, h)]
    dst = [
        (random.randint(0, dx), random.randint(0, dy)),
        (w - random.randint(0, dx), random.randint(0, dy)),
        (w - random.randint(0, dx), h - random.randint(0, dy)),
        (random.randint(0, dx), h - random.randint(0, dy)),
    ]

    # PIL perspective requires 8-coefficient flat list
    def _solve(src_pts, dst_pts):
        # compute projective transform coefficients
        matrix = []
        for (x, y), (X, Y) in zip(src_pts, dst_pts):
            matrix.append([x, y, 1, 0, 0, 0, -X * x, -X * y])
            matrix.append([0, 0, 0, x, y, 1, -Y * x, -Y * y])
        A = np.array(matrix, dtype=np.float64)
        b = np.array([X for (_, _), (X, _) in zip(src_pts, dst_pts)]
                     + [Y for (_, _), (_, Y) in zip(src_pts, dst_pts)], dtype=np.float64)
        # interleave X and Y into the b vector correctly
        b2 = []
        for (X, Y) in dst_pts:
            b2.extend([X, Y])
        b2 = np.array(b2, dtype=np.float64)
        coeffs, _, _, _ = np.linalg.lstsq(A, b2, rcond=None)
        return coeffs.tolist()

    coeffs = _solve(src, dst)
    return img.transform((w, h), Image.PERSPECTIVE, coeffs, Image.BICUBIC)


def _paste_card_on_background(card: Image.Image, bg: Image.Image) -> Image.Image:
    """Paste the card (with optional rotation) onto a randomly cropped background region."""
    cw, ch = card.size
    bw, bh = bg.size

    # Slight rotation (±5°)
    angle = random.uniform(-5, 5)
    card_rot = card.rotate(angle, expand=True, fillcolor=(0, 0, 0))

    # Scale card to 40–70% of the background's shorter dimension
    scale = random.uniform(0.40, 0.70)
    target_w = int(min(bw, bh) * scale)
    ratio = target_w / card_rot.width
    target_h = int(card_rot.height * ratio)
    card_scaled = card_rot.resize((target_w, target_h), Image.LANCZOS)

    # Position: random, but fully within background
    max_x = max(0, bw - target_w)
    max_y = max(0, bh - target_h)
    px = random.randint(0, max_x)
    py = random.randint(0, max_y)

    out = bg.copy()
    out.paste(card_scaled, (px, py))

    # Crop to card region with 10% margin for context
    margin_x = int(target_w * 0.10)
    margin_y = int(target_h * 0.10)
    x1 = max(0, px - margin_x)
    y1 = max(0, py - margin_y)
    x2 = min(bw, px + target_w + margin_x)
    y2 = min(bh, py + target_h + margin_y)
    return out.crop((x1, y1, x2, y2))


def _color_jitter(img: Image.Image) -> Image.Image:
    from PIL import ImageEnhance
    for Klass, lo, hi in [
        (ImageEnhance.Brightness, 0.6, 1.4),
        (ImageEnhance.Contrast, 0.6, 1.4),
        (ImageEnhance.Color, 0.5, 1.5),
        (ImageEnhance.Sharpness, 0.7, 1.3),
    ]:
        img = Klass(img).enhance(random.uniform(lo, hi))
    return img


def _gaussian_blur(img: Image.Image) -> Image.Image:
    from PIL import ImageFilter
    if random.random() < 0.5:
        radius = random.uniform(0.5, 2.0)
        img = img.filter(ImageFilter.GaussianBlur(radius=radius))
    return img


def _jpeg_compress(img: Image.Image) -> Image.Image:
    quality = random.randint(55, 95)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=quality)
    buf.seek(0)
    return Image.open(buf).copy()


def augment(card_img: Image.Image, bg_img: Image.Image) -> Image.Image:
    """Full augmentation pipeline: background paste → perspective → jitter → blur → JPEG."""
    composited = _paste_card_on_background(card_img, bg_img)
    composited = _random_perspective(composited, strength=0.06)
    composited = _color_jitter(composited)
    composited = _gaussian_blur(composited)
    composited = _jpeg_compress(composited)
    return composited


# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------

class CardPairDataset(Dataset):
    """
    Yields (anchor_tensor, positive_tensor) pairs.
    anchor  = art-region crop of the clean official card image
    positive = same card's art pasted on a random background + augmentations
    """

    def __init__(
        self,
        card_paths: list[Path],
        bg_paths: list[Path],
        preprocess,
        pairs_per_card: int = 4,
    ):
        self.card_paths = card_paths
        self.bg_paths = bg_paths
        self.preprocess = preprocess
        self.pairs_per_card = pairs_per_card

        # Pre-load backgrounds into memory (only 5 files, small)
        self.bgs: list[Image.Image] = []
        for p in bg_paths:
            try:
                self.bgs.append(Image.open(p).convert("RGB"))
                logger.info("Loaded background: %s", p.name)
            except Exception as e:
                logger.warning("Could not load background %s: %s", p, e)

        if not self.bgs:
            raise RuntimeError("No background images loaded — check --backgrounds path")

        logger.info(
            "Dataset: %d cards × %d pairs = %d total pairs",
            len(card_paths), pairs_per_card, len(card_paths) * pairs_per_card,
        )

    def __len__(self):
        return len(self.card_paths) * self.pairs_per_card

    def __getitem__(self, idx):
        card_idx = idx // self.pairs_per_card
        path = self.card_paths[card_idx]

        try:
            card_img = Image.open(path).convert("RGB")
        except Exception as e:
            logger.debug("Failed to open %s: %s — returning zeros", path, e)
            dummy = torch.zeros(3, 224, 224)
            return dummy, dummy

        # Anchor: art region of clean card
        anchor_crop = _crop_art(card_img)
        anchor = self.preprocess(anchor_crop)

        # Positive: augmented version
        bg = random.choice(self.bgs)
        aug = augment(card_img, bg)
        aug_crop = _crop_art(aug)
        positive = self.preprocess(aug_crop)

        return anchor, positive


def collect_card_paths(dataset_root: Path) -> list[Path]:
    paths = []
    for p in dataset_root.rglob("*"):
        if p.suffix.lower() in SUPPORTED_EXTS:
            paths.append(p)
    return paths


# ---------------------------------------------------------------------------
# InfoNCE loss
# ---------------------------------------------------------------------------

def infonce_loss(anchors: torch.Tensor, positives: torch.Tensor, temperature: float = 0.07) -> torch.Tensor:
    """
    Symmetric InfoNCE (NT-Xent) over a batch of (anchor, positive) pairs.
    anchors and positives are L2-normalized embeddings, shape (N, D).
    """
    n = anchors.shape[0]
    z = torch.cat([anchors, positives], dim=0)  # (2N, D)
    sim = torch.mm(z, z.T) / temperature  # (2N, 2N)

    # Mask out self-similarity
    mask = torch.eye(2 * n, device=sim.device, dtype=torch.bool)
    sim.masked_fill_(mask, float("-inf"))

    # Labels: for row i (anchor), the positive is at index i+n; for row i+n (positive), at i
    labels = torch.cat([torch.arange(n, 2 * n), torch.arange(0, n)]).to(sim.device)
    return F.cross_entropy(sim, labels)


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def train(
    dataset_root: Path,
    bg_root: Path,
    output_path: Path,
    epochs: int,
    batch_size: int,
    lr: float,
    pairs_per_card: int,
    temperature: float,
    checkpoint_every: int,
    resume_from: Path | None = None,
):
    import open_clip

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    logger.info("Device: %s", device)

    logger.info("Loading CLIP ViT-B/32...")
    model, _, preprocess = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai")
    model = model.to(device)

    if resume_from and resume_from.exists():
        state = torch.load(resume_from, map_location=device)
        model.visual.load_state_dict(state)
        logger.info("Resumed visual encoder from %s", resume_from)
    elif resume_from:
        logger.warning("--resume path not found (%s) — starting from base CLIP", resume_from)

    # Freeze text encoder — only fine-tune visual encoder
    for name, param in model.named_parameters():
        param.requires_grad = "visual" in name
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    logger.info("Trainable params: %d / %d (visual encoder only)", trainable, total)

    card_paths = collect_card_paths(dataset_root)
    if not card_paths:
        logger.error("No card images found in %s", dataset_root)
        sys.exit(1)
    logger.info("Found %d card images", len(card_paths))

    bg_paths = [p for p in bg_root.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"}]
    if not bg_paths:
        logger.error("No background images found in %s", bg_root)
        sys.exit(1)

    dataset = CardPairDataset(card_paths, bg_paths, preprocess, pairs_per_card=pairs_per_card)
    loader = DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=True,
        num_workers=4,
        pin_memory=(device.type == "cuda"),
        drop_last=True,
    )

    optimizer = torch.optim.AdamW(
        [p for p in model.parameters() if p.requires_grad],
        lr=lr,
        weight_decay=1e-4,
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=epochs * len(loader), eta_min=lr * 0.01
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    best_loss = float("inf")

    for epoch in range(1, epochs + 1):
        model.train()
        epoch_loss = 0.0
        steps = 0

        from tqdm import tqdm
        for anchors, positives in tqdm(loader, desc=f"Epoch {epoch}/{epochs}", unit="batch", dynamic_ncols=True):
            anchors = anchors.to(device)
            positives = positives.to(device)

            anchor_feats = model.encode_image(anchors)
            positive_feats = model.encode_image(positives)

            # L2 normalize
            anchor_feats = anchor_feats / anchor_feats.norm(dim=-1, keepdim=True)
            positive_feats = positive_feats / positive_feats.norm(dim=-1, keepdim=True)

            loss = infonce_loss(anchor_feats, positive_feats, temperature=temperature)

            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()

            epoch_loss += loss.item()
            steps += 1

        avg_loss = epoch_loss / max(steps, 1)
        logger.info("Epoch %d/%d — loss: %.4f — lr: %.2e", epoch, epochs, avg_loss, scheduler.get_last_lr()[0])

        if avg_loss < best_loss:
            best_loss = avg_loss
            torch.save(model.visual.state_dict(), output_path)
            logger.info("  Saved best checkpoint (loss=%.4f) → %s", best_loss, output_path)

        if checkpoint_every > 0 and epoch % checkpoint_every == 0:
            ckpt = output_path.with_stem(f"{output_path.stem}_epoch{epoch}")
            torch.save(model.visual.state_dict(), ckpt)
            logger.info("  Epoch checkpoint → %s", ckpt)

    logger.info("Training complete. Best loss: %.4f", best_loss)
    logger.info("Fine-tuned visual encoder saved to: %s", output_path)
    logger.info("Next: run build_embeddings.py --force to re-embed all 20k cards.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fine-tune CLIP ViT-B/32 on synthetic card pairs")
    parser.add_argument(
        "--dataset",
        type=Path,
        default=Path("/en_cards"),
        help="Path to card image folder (searched recursively)",
    )
    parser.add_argument(
        "--backgrounds",
        type=Path,
        default=Path("/backgrounds"),
        help="Path to background texture images folder",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("backend/models/clip_finetuned.pt"),
        help="Output path for the fine-tuned visual encoder state dict",
    )
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=1e-5, help="Learning rate")
    parser.add_argument(
        "--pairs-per-card",
        type=int,
        default=4,
        help="Synthetic augmented variants generated per card image",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.07,
        help="InfoNCE temperature (lower = harder negatives)",
    )
    parser.add_argument(
        "--checkpoint-every",
        type=int,
        default=0,
        help="Save epoch checkpoint every N epochs (0 = only save best)",
    )
    parser.add_argument(
        "--resume",
        type=Path,
        default=Path("backend/models/clip_finetuned.pt"),
        help="Path to existing fine-tuned visual encoder weights to resume from. "
             "Pass --resume '' to force training from base CLIP.",
    )
    args = parser.parse_args()

    train(
        dataset_root=args.dataset,
        bg_root=args.backgrounds,
        output_path=args.output,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        pairs_per_card=args.pairs_per_card,
        temperature=args.temperature,
        checkpoint_every=args.checkpoint_every,
        resume_from=args.resume if args.resume else None,
    )
