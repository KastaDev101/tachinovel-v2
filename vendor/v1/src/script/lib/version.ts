/** Compare dotted plugin versions ("2.3.1" vs "2.10.0"). Non-numeric parts compare as strings. */
export function compareVersions(a: string, b: string): number {
  const pa = a.trim().replace(/^v/i, '').split(/[.+-]/);
  const pb = b.trim().replace(/^v/i, '').split(/[.+-]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
