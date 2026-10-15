import { BadRequestException } from '@nestjs/common';
import { FILE_LIMITS } from './research-config';

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|x-sh|javascript|typescript))/;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|log|ini|toml|sql|js|ts|tsx|jsx|py|java|cs|go|rs|php|rb|sh)$/i;

export async function extractUploadText(file: UploadedFile): Promise<string> {
  const isPdf = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname);
  if (isPdf) {
    try {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(file.buffer) });
      try { return (await parser.getText()).text; } finally { await parser.destroy(); }
    } catch {
      throw new BadRequestException(`PDF nicht lesbar: ${file.originalname}`);
    }
  }
  if (TEXT_MIME.test(file.mimetype) || TEXT_EXT.test(file.originalname)) {
    const text = file.buffer.toString('utf8');
    if (text.includes('\u0000')) throw new BadRequestException(`Keine Textdatei: ${file.originalname}`);
    return text;
  }
  throw new BadRequestException(`Dateityp nicht unterstützt (nur Text und PDF): ${file.originalname}`);
}

export function prepareFiles(files: Array<{ name: string; text: string }>): Array<{ name: string; text: string }> {
  if (files.length > FILE_LIMITS.maxFiles) throw new BadRequestException(`Höchstens ${FILE_LIMITS.maxFiles} Dateien`);
  let sum = 0;
  const seen = new Map<string, number>();
  return files.map((f) => {
    if (f.text.length > FILE_LIMITS.maxCharsPerFile) throw new BadRequestException(`${f.name}: mehr als ${FILE_LIMITS.maxCharsPerFile} Zeichen`);
    sum += f.text.length;
    if (sum > FILE_LIMITS.maxCharsTotal) throw new BadRequestException(`Dateien zusammen mehr als ${FILE_LIMITS.maxCharsTotal} Zeichen`);
    const count = (seen.get(f.name) ?? 0) + 1;
    seen.set(f.name, count);
    const name = count === 1 ? f.name : f.name.replace(/(\.[^.]*)?$/, (ext) => ` (${count})${ext ?? ''}`);
    return { name, text: f.text };
  });
}

export function splitParts(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
