/** Resize/crop an image to 1280x720 JPEG under 2 MB (YouTube's thumbnail limit). */
export async function toThumbnail(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const W = 1280;
  const H = 720;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't process images");
  // Cover: fill 16:9, cropping the overflow evenly.
  const scale = Math.max(W / bitmap.width, H / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (W - w) / 2, (H - h) / 2, w, h);
  bitmap.close();
  for (const q of [0.9, 0.8, 0.7, 0.6, 0.5]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
    if (blob && blob.size < 2 * 1024 * 1024) return blob;
  }
  throw new Error("That image is too detailed to shrink under 2 MB — try another");
}
