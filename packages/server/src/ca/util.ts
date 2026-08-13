/** Small CA-side formatting helpers. */

/**
 * Convert a .NET TimeSpan string (e.g. "00:07:32.1234567" or "0:07:32") — what the FMS controller
 * emits for LastCycleTimeCalculated — into CA's eventStatus.CycleTime form ("m:ss", or "h:mm:ss" for
 * an hour+). CA appends a "(… than scheduled)" suffix it computes from the schedule; we omit that.
 */
export function dotnetTimeSpanToCycle(timeSpan: string): string {
	const m = timeSpan.match(/^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})/);
	if (!m) return "";
	const hours = Number(m[2]);
	const minutes = Number(m[3]);
	const seconds = Number(m[4]);
	const pad = (n: number) => String(n).padStart(2, "0");
	if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
	return `${minutes}:${pad(seconds)}`;
}
