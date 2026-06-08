// #region .NET DateTime formatting

/**
 * Format the current instant the way .NET's `DateTime.UtcNow.ToString("O")` (round-trip) does:
 * ISO 8601 with **7** fractional-second digits (100ns ticks) and a trailing `Z`, e.g.
 * `2026-06-08T04:21:47.9220536Z`. Real FMS emits this exact shape on Red/BlueScoreChanged.
 *
 * JavaScript `Date` only carries millisecond precision, so the lower 4 digits (sub-millisecond)
 * are synthesized from `performance.now()`'s fractional part. That keeps the value realistic (not
 * just `.9220000Z`) and parseable by a strict .NET `DateTime` consumer.
 */
export function dotnetNow(): string {
	const iso = new Date().toISOString(); // e.g. 2026-06-08T04:21:47.922Z
	const frac = performance.now();
	const subMs = frac - Math.floor(frac); // 0..1 of the current millisecond
	const ticks = Math.min(9999, Math.floor(subMs * 10000)); // 100ns ticks within the ms
	return iso.replace(/\.(\d{3})Z$/, (_match, ms: string) => `.${ms}${ticks.toString().padStart(4, "0")}Z`);
}

// #endregion
