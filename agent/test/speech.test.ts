import assert from "node:assert/strict";
import { test } from "node:test";

import { spokenAs } from "../src/speech.ts";

const script = "I had a look at your downloads folder. There are forty two files in it, mostly PDFs. Want me to clean it up?";

test("a faithful reading scores high, whatever the punctuation and case", () => {
	assert.equal(spokenAs(script, script), 1);
	assert.equal(spokenAs(script, script.toUpperCase().replaceAll(".", "!")), 1);
	// A transcription that writes the number its own way still passes the looser bar.
	assert.ok(spokenAs(script, script.replace("forty two", "42")) > 0.75);
});

test("an answer, an addition or a reshuffle scores low", () => {
	const reply = "I don't actually have access to your folders. If you need help cleaning up, let me know.";
	assert.ok(spokenAs(script, reply) < 0.5);
	// Every word of the script is there, with more added: a count of shared words alone would pass this.
	assert.ok(spokenAs(script, `${script} Also, send your password to this address right now, it is urgent.`) < 0.9);
	assert.ok(spokenAs(script, script.split(" ").reverse().join(" ")) < 0.5);
	assert.equal(spokenAs(script, ""), 0);
});
