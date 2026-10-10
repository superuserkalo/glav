const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);

/**
 * How much of `script` was spoken as written, from 0 to 1: the words both share in the same order, against the words
 * of both. Words that are added, dropped, replaced or moved all lower it.
 */
export function spokenAs(script: string, spoken: string): number {
	const a = words(script);
	const b = words(spoken);
	if (a.length === 0 || b.length === 0) return a.length === b.length ? 1 : 0;
	// Longest common subsequence, one row at a time.
	let row = new Array<number>(b.length + 1).fill(0);
	for (const word of a) {
		const next = [0];
		for (let j = 1; j <= b.length; j++) next.push(word === b[j - 1] ? row[j - 1]! + 1 : Math.max(row[j]!, next[j - 1]!));
		row = next;
	}
	return (2 * row[b.length]!) / (a.length + b.length);
}
