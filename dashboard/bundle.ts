import { deflateRawSync } from "node:zlib";
import type { OfficeRecords, Artifact } from "../office-records.js";
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(b: Buffer) {
  let crc = 0xffffffff;
  for (const byte of b) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const filename = Buffer.from(name);
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x800, 6);
    h.writeUInt16LE(8, 8);
    h.writeUInt16LE(33, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(packed.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(filename.length, 26);
    local.push(h, filename, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(33, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(filename.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, filename);
    offset += h.length + filename.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function createBundle(
  records: OfficeRecords,
  selection: { artifact?: string; revision?: number; delivery?: number } = {},
) {
  const view = records.view();
  const delivery = selection.delivery
    ? view.deliveryHistory.find((d) => d.revision === selection.delivery)
    : undefined;
  if (selection.delivery && !delivery)
    throw new Error("Delivery version not found");
  const artifacts: Artifact[] = selection.artifact
    ? [records.artifact(selection.artifact, selection.revision)]
    : delivery
      ? delivery.artifacts.map((a) => records.artifact(a.id, a.revision))
      : view.artifacts;
  if (!artifacts.length) throw new Error("No artifacts have been registered");
  const entries: { name: string; data: Buffer }[] = [];
  let bytes = 0;
  let cards = "";
  for (const a of artifacts) {
    cards += `<article><h2>${escape(a.title)}</h2><p>${escape(a.summary)}</p><p>Revision ${a.revision} · ${escape(a.state)} · ${escape(a.by)}</p><ul>`;
    a.resources.forEach((r, i) => {
      const prefix = `artifacts/${a.id}/resource-${i + 1}/`;
      if (r.type === "url")
        cards += `<li><a href="${escape(r.url!)}" rel="noreferrer">External reference</a> · not included offline</li>`;
      if (r.type === "note") {
        entries.push({ name: prefix + "note.txt", data: Buffer.from(r.text!) });
        cards += `<li><a href="${prefix}note.txt">Read note</a></li>`;
      }
      for (const f of r.files || []) {
        bytes += f.bytes;
        if (bytes > 250 * 1024 * 1024 || entries.length >= 60000)
          throw new Error(
            "Bundle exceeds 250 MB or 60000 files. Download artifacts separately.",
          );
        entries.push({
          name: prefix + f.path,
          data: records.file(a.id, a.revision, i, f.path).data,
        });
      }
      if (r.files?.length)
        cards += `<li><a href="${prefix}${escape(r.entry!)}">${escape(r.path!)}</a> · ${r.files.length} files</li>`;
    });
    cards += `</ul><p>${escape(a.limitations)}</p></article>`;
  }
  entries.push({
    name: "manifest.json",
    data: Buffer.from(
      JSON.stringify(
        {
          team: records.team,
          delivery: delivery || null,
          agreement:
            view.agreementHistory.find(
              (a) => a.revision === delivery?.agreementRevision,
            ) || view.agreement,
          artifacts,
        },
        null,
        2,
      ),
    ),
  });
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mesh Office delivery</title><style>body{font:16px/1.7 system-ui;background:#f8f5ee;color:#233e34;max-width:900px;margin:50px auto;padding:0 24px}article{padding:24px;border:1px solid #ccd7c8;border-radius:12px;margin:20px 0;background:white}a{color:inherit}p{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>${escape(delivery?.title || "Team artifacts")}</h1><p>${escape(delivery?.summary || records.team.goal)}</p>${delivery ? `<p>Completed: ${escape(delivery.completed)}</p><p>Remaining: ${escape(delivery.remaining || "None listed")}</p><p>Next: ${escape(delivery.next)}</p>` : ""}<p>Preserved snapshots. External and localhost links may require network access or a running process. See manifest.json for provenance and checks.</p>${cards}</html>`;
  entries.push({ name: "index.html", data: Buffer.from(body) });
  return zip(entries);
}
