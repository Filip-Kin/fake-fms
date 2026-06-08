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

/** Milliseconds between the .NET epoch (0001-01-01) and the Unix epoch (1970-01-01). */
const DOTNET_EPOCH_OFFSET_MS = 62135596800000;

/**
 * Current time as .NET `DateTime.UtcNow.Ticks` (100ns intervals since 0001-01-01). This is what
 * real FMS sends as the single argument of `GlobalTimerChanged`. The value exceeds JS's safe
 * integer range, so the low digits round exactly as they do in any JSON consumer (and as they did
 * in our capture) - the consumer sees the same number either way.
 */
export function dotnetTicks(): number {
	return (Date.now() + DOTNET_EPOCH_OFFSET_MS) * 10000;
}

// #endregion
