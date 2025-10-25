export function toPgVector(values: number[]): string {
  return `[${values.join(",")}]`;
}

export function chunkText(text: string, size = 700, overlap = 120): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= size) {
      chunks.push(paragraph.trim());
      continue;
    }
    let start = 0;
    while (start < paragraph.length) {
      const end = Math.min(start + size, paragraph.length);
      const slice = paragraph.slice(start, end).trim();
      if (slice) {
        chunks.push(slice);
      }
      if (end === paragraph.length) break;
      start = end - overlap;
    }
  }
  return chunks.filter(Boolean);
}

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
