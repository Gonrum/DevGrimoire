/** Hands a Blob to the browser as a file download (object URL on a temporary link). */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadTextFile(filename: string, text: string): void {
  downloadBlob(filename, new Blob([text], { type: 'text/markdown;charset=utf-8' }));
}
