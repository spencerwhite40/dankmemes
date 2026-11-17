"use strict";
// A streaming ZIP writer with no dependencies, for handing over all of a run's clips at once. Clips are already compressed video,
// so entries are stored, not compressed: nothing is held in memory, and the CRC is worked out as the bytes go by (data descriptors).
// Limits of this simple format: each file under 4 GB and under 65,535 files, which a run of clips never approaches.
const zlib = require("node:zlib");

const SIG = { local: 0x04034b50, descriptor: 0x08074b50, central: 0x02014b50, end: 0x06054b50 };
const FLAGS = 0x0808;   // bit 3: sizes follow the data; bit 11: names are UTF-8

function dosDateTime(d = new Date()) {
  const year = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/** A safe, unique file name for inside the zip: letters, numbers, spaces and dashes only, short, and never the same twice. */
function safeName(raw, used, ext = "") {
  const base = String(raw || "clip").replace(/[^\p{L}\p{N} _-]+/gu, "").replace(/\s+/g, " ").trim().slice(0, 60) || "clip";
  let name = `${base}${ext}`, n = 2;
  while (used.has(name.toLowerCase())) name = `${base} (${n++})${ext}`;
  used.add(name.toLowerCase());
  return name;
}

/**
 * Writes a zip to `out` (any writable stream). entries: [{ name, open: async () => readableStream }], written one after another.
 * Resolves when the archive is complete; rejects (and destroys `out`) if an entry can't be read.
 */
async function writeZip(out, entries) {
  let offset = 0;
  const central = [];
  const write = (chunk) => new Promise((resolve, reject) => {
    offset += chunk.length;
    if (out.write(chunk)) return resolve();
    const onDrain = () => { out.off("error", onErr); resolve(); }, onErr = (e) => { out.off("drain", onDrain); reject(e); };
    out.once("drain", onDrain); out.once("error", onErr);
  });
  const { time, date } = dosDateTime();
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, "utf8");
      const headerOffset = offset;
      await write(Buffer.concat([u32(SIG.local), u16(20), u16(FLAGS), u16(0), u16(time), u16(date), u32(0), u32(0), u32(0), u16(name.length), u16(0), name]));
      const stream = await entry.open();
      let crc = 0, size = 0;
      for await (const chunk of stream) { crc = zlib.crc32(chunk, crc); size += chunk.length; if (size > 0xffffffff) throw new Error("file too large for this zip"); await write(chunk); }
      await write(Buffer.concat([u32(SIG.descriptor), u32(crc), u32(size), u32(size)]));
      central.push({ name, crc, size, headerOffset });
    }
    const cdStart = offset;
    for (const c of central) {
      await write(Buffer.concat([u32(SIG.central), u16(20), u16(20), u16(FLAGS), u16(0), u16(time), u16(date), u32(c.crc), u32(c.size), u32(c.size), u16(c.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.headerOffset), c.name]));
    }
    const cdSize = offset - cdStart;
    await write(Buffer.concat([u32(SIG.end), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0)]));
    await new Promise((resolve) => out.end(resolve));
  } catch (e) { out.destroy(e); throw e; }
}

module.exports = { writeZip, safeName };
