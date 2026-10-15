// Turns a picked image into the app's product-photo look: a square on pure
// white with the item centered. Catalog shots (white or transparent
// background) get trimmed and re-centered; ordinary photos are cropped square.

const FULL = 1000;
const THUMB = 320;
const PAD = 0.08;      // margin around a trimmed item, as a share of its longest side
const WHITE = 244;     // anything brighter than this counts as background

export async function preparePhoto(file) {
  if (!file || !/^image\//.test(file.type || 'image/')) throw new Error('Pick a photo (JPG, PNG or HEIC).');
  const img = await load(file);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('That photo couldn’t be read.');

  // Flatten onto white (transparent PNGs become white, not black).
  const scale = Math.min(1, 2400 / Math.max(w, h));
  const src = canvas(Math.round(w * scale), Math.round(h * scale));
  const sx = src.getContext('2d', { willReadFrequently: true });
  sx.fillStyle = '#fff';
  sx.fillRect(0, 0, src.width, src.height);
  sx.drawImage(img, 0, 0, src.width, src.height);

  const data = sx.getImageData(0, 0, src.width, src.height).data;
  let box;
  if (whiteEdges(data, src.width, src.height)) {
    box = itemBox(data, src.width, src.height) || { x: 0, y: 0, w: src.width, h: src.height };
    const side = Math.max(box.w, box.h) * (1 + 2 * PAD);
    box = { x: box.x + box.w / 2 - side / 2, y: box.y + box.h / 2 - side / 2, w: side, h: side };
  } else {
    const side = Math.min(src.width, src.height); // a real-world photo: crop to the middle square
    box = { x: (src.width - side) / 2, y: (src.height - side) / 2, w: side, h: side };
  }

  const out = async (size, quality) => {
    const px = Math.min(size, Math.round(box.w));
    const c = canvas(px, px);
    const cx = c.getContext('2d');
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, px, px);
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, px, px);
    return blob(c, quality);
  };
  return { full: await out(FULL, 0.86), thumb: await out(THUMB, 0.82) };
}

function load(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file isn’t a photo this device can open.')); };
    img.src = url;
  });
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

function blob(c, quality) {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t save the photo.'))), 'image/jpeg', quality));
}

const bright = (d, i) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;

/** True when the outer edge is (almost) all white: a catalog shot. */
function whiteEdges(d, w, h) {
  let white = 0;
  let total = 0;
  const step = Math.max(1, Math.floor(Math.min(w, h) / 200));
  for (let x = 0; x < w; x += step) for (const y of [0, h - 1]) { total++; if (bright(d, (y * w + x) * 4) > WHITE) white++; }
  for (let y = 0; y < h; y += step) for (const x of [0, w - 1]) { total++; if (bright(d, (y * w + x) * 4) > WHITE) white++; }
  return white / total > 0.92;
}

/** The smallest box around everything that isn't background. */
function itemBox(d, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bright(d, (y * w + x) * 4) <= WHITE) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
