import fs from "node:fs/promises";
import path from "node:path";

const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MIME_EXTENSION = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
});
const EXTENSION_MIME = Object.freeze(Object.fromEntries(
  Object.entries(MIME_EXTENSION).map(([mimeType, extension]) => [extension, mimeType])
));
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export function detectImageMime(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  return null;
}

// Keeps only the most recent generated image per provider so the status page
// can show it without retaining a full history of expensive generations.
export class ImageStore {
  constructor({ directory, maxBytes = MAX_IMAGE_BYTES, now = () => new Date() } = {}) {
    if (!directory) throw new Error("ImageStore requires a directory");
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.now = now;
    this.entries = new Map();
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    let files = [];
    try {
      files = await fs.readdir(this.directory);
    } catch {
      return [];
    }
    for (const file of files) {
      const match = file.match(/^([A-Za-z0-9._-]{1,64})\.(png|jpg|webp|gif)$/);
      if (!match) continue;
      const [, id, extension] = match;
      try {
        const stat = await fs.stat(path.join(this.directory, file));
        this.entries.set(id, {
          mimeType: EXTENSION_MIME[extension],
          bytes: stat.size,
          capturedAt: stat.mtime.toISOString()
        });
      } catch {}
    }
    return [...this.entries.keys()];
  }

  meta(id) {
    return this.entries.get(id) || null;
  }

  async save(id, image) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error(`Invalid image provider id: ${id}`);
    const bytes = Buffer.isBuffer(image?.bytes) ? image.bytes : Buffer.from(image?.bytes || []);
    if (!bytes.length) throw new Error("Image payload is empty");
    if (bytes.length > this.maxBytes) throw new Error(`Image exceeds ${this.maxBytes} bytes`);
    const mimeType = detectImageMime(bytes) || image?.mimeType;
    const extension = MIME_EXTENSION[mimeType];
    if (!extension) throw new Error(`Unsupported image type: ${mimeType || "unknown"}`);
    const target = path.join(this.directory, `${id}.${extension}`);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, bytes, { mode: 0o644 });
    await fs.rename(temporary, target);
    for (const other of Object.keys(EXTENSION_MIME)) {
      if (other === extension) continue;
      await fs.rm(path.join(this.directory, `${id}.${other}`), { force: true });
    }
    const entry = { mimeType, bytes: bytes.length, capturedAt: this.now().toISOString() };
    this.entries.set(id, entry);
    return entry;
  }

  async read(id) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
    const meta = this.entries.get(id);
    if (!meta) return null;
    try {
      const bytes = await fs.readFile(path.join(this.directory, `${id}.${MIME_EXTENSION[meta.mimeType]}`));
      return { ...meta, bytes };
    } catch {
      this.entries.delete(id);
      return null;
    }
  }

  async remove(id) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) return false;
    this.entries.delete(id);
    for (const extension of Object.keys(EXTENSION_MIME)) {
      await fs.rm(path.join(this.directory, `${id}.${extension}`), { force: true });
    }
    return true;
  }
}
