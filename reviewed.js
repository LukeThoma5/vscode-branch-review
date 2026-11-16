// "Reviewed" marks. A mark stores a fingerprint of the file's content when you marked it,
// so if the file changes afterwards it automatically shows as unreviewed again.
const fs = require("fs");
const crypto = require("crypto");

const hashCache = new Map(); // absPath -> { mtimeMs, size, hash }

async function fingerprint(absPath, status) {
  if (status === "D") return "deleted";
  try {
    const st = await fs.promises.stat(absPath);
    if (!st.isFile()) return "not-a-file";
    const cached = hashCache.get(absPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size)
      return cached.hash;
    const hash = crypto
      .createHash("sha1")
      .update(await fs.promises.readFile(absPath))
      .digest("hex");
    hashCache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, hash });
    return hash;
  } catch {
    return "missing";
  }
}

class ReviewedStore {
  constructor(memento) {
    this.memento = memento;
    this.data = memento.get("reviewed", {}); // { [repoRoot]: { [relPath]: fingerprint } }
  }

  get(root, relPath) {
    return this.data[root]?.[relPath];
  }

  async set(root, relPath, fp) {
    (this.data[root] ??= {})[relPath] = fp;
    await this.memento.update("reviewed", this.data);
  }

  async unset(root, relPath) {
    if (this.data[root]) delete this.data[root][relPath];
    await this.memento.update("reviewed", this.data);
  }

  async clear() {
    this.data = {};
    await this.memento.update("reviewed", this.data);
  }
}

module.exports = { fingerprint, ReviewedStore };
