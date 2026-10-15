export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a moment to start the download before releasing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(fileName: string, text: string, mime = 'text/plain'): void {
  downloadBlob(fileName, new Blob([text], { type: mime }));
}

export function downloadJson(fileName: string, data: unknown): void {
  downloadText(fileName, JSON.stringify(data, null, 2), 'application/json');
}

export function todayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
