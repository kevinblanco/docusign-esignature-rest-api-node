// Writes the two sample PDFs in ../documents. No dependencies.
//
//   node tools/make-pdfs.js

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "documents");

const PAGE = { w: 612, h: 792 }; // US Letter, in points
const LEFT = 72;
const WRAP = 92; // characters per line at 10.5 pt

/** Where the signature line sits in the original (points from the bottom). Mirrored in send-envelope.js. */
export const SIGNATURE_LINE_Y = 268;

const CLAUSES = [
  [
    "1. Confidential Information.",
    "\"Confidential Information\" means any non-public business, technical or financial information that one party discloses to the other, in any form, that is marked as confidential or would reasonably be understood to be confidential.",
  ],
  [
    "2. Obligations.",
    "The Recipient will use the Confidential Information only to evaluate a business relationship with Fontara, will not disclose it to any third party without Fontara's written consent, and will protect it with at least reasonable care.",
  ],
  [
    "3. Exclusions.",
    "These obligations do not apply to information that is or becomes public through no fault of the Recipient, was already known to the Recipient, or is independently developed without use of the Confidential Information.",
  ],
];

const REVISED_CLAUSES = [
  ...CLAUSES,
  [
    "4. Term.",
    "This Agreement remains in effect for two years from the date of signature. The obligations in section 2 survive for three years after it ends.",
  ],
  [
    "5. Return of Materials.",
    "On Fontara's request, the Recipient will promptly return or destroy all Confidential Information in its possession.",
  ],
];

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

const wrap = (text) => {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if ((line + " " + word).trim().length > WRAP) {
      lines.push(line);
      line = word;
    } else line = (line + " " + word).trim();
  }
  if (line) lines.push(line);
  return lines;
};

function page(clauses) {
  const ops = [];
  const text = (x, y, size, font, s, rgb = "0.07 0 0.2") => ops.push(`BT /${font} ${size} Tf ${rgb} rg ${x} ${y} Td (${esc(s)}) Tj ET`);
  const rule = (x1, x2, y) => ops.push(`0.4 0.4 0.45 RG 0.8 w ${x1} ${y} m ${x2} ${y} l S`);

  let y = PAGE.h - 96;
  text(LEFT, y, 20, "F2", "Mutual Non-Disclosure Agreement");
  y -= 22;
  text(LEFT, y, 9, "F1", "Fontara, Inc.  |  Sample document for the Docusign eSignature REST API tutorial", "0.45 0.42 0.55");
  y -= 34;
  for (const l of wrap(
    "This Mutual Non-Disclosure Agreement (the \"Agreement\") is entered into between Fontara, Inc. (\"Fontara\") and the party signing below (the \"Recipient\"), effective on the date of signature.",
  )) {
    text(LEFT, y, 10.5, "F1", l);
    y -= 15;
  }
  for (const [title, body] of clauses) {
    y -= 12;
    text(LEFT, y, 10.5, "F2", title);
    y -= 15;
    for (const l of wrap(body)) {
      text(LEFT, y, 10.5, "F1", l);
      y -= 15;
    }
  }

  // the signature block: in the original it sits at SIGNATURE_LINE_Y; the
  // revised clauses push it down
  const sigY = Math.min(SIGNATURE_LINE_Y, y - 60);
  text(LEFT, sigY + 44, 10.5, "F2", "Signed for the Recipient");
  text(LEFT, sigY - 14, 9, "F1", "Signature", "0.45 0.42 0.55");
  rule(LEFT, LEFT + 240, sigY);
  // the anchor: white on white, where the signature goes. A tab starts at the
  // anchor's first character, so it sits just above the line and needs no offset.
  text(LEFT, sigY + 18, 10.5, "F1", "\\s1\\", "1 1 1");
  rule(LEFT + 300, LEFT + 468, sigY);
  text(LEFT + 300, sigY - 14, 9, "F1", "Date", "0.45 0.42 0.55");
  rule(LEFT, LEFT + 240, sigY - 56);
  text(LEFT, sigY - 70, 9, "F1", "Name", "0.45 0.42 0.55");

  text(LEFT, 54, 8, "F1", "Sample document only. Not a real agreement. Sent from a Docusign developer account, where nothing is legally binding.", "0.55 0.52 0.62");
  return { stream: ops.join("\n"), sigY };
}

function pdf(stream) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
  ];
  // %PDF-1.7 base64-encodes to "JVBERi0xLjcK": the first bytes the tutorial shows
  let out = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

for (const [file, clauses] of [
  ["fontara-nda.pdf", CLAUSES],
  ["fontara-nda-revised.pdf", REVISED_CLAUSES],
]) {
  const { stream, sigY } = page(clauses);
  writeFileSync(path.join(OUT, file), pdf(stream));
  console.log(`${file}  signature line at ${PAGE.h - sigY} pt from the top`);
}
