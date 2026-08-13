import test from "node:test";
import assert from "node:assert/strict";
import { generateChallenge, validateResponse } from "../src/challenge.mjs";

test("generated challenges contain an answer and validate it", () => {
  for (let index = 0; index < 50; index += 1) {
    const challenge = generateChallenge();
    assert.ok(challenge.prompt.includes(challenge.expectedAnswer));
    assert.equal(validateResponse(challenge.expectedAnswer, challenge.expectedAnswer).valid, true);
  }
});

test("validation rejects long echoes and wrong answers", () => {
  assert.equal(validateResponse("apple", "banana").valid, false);
  assert.equal(validateResponse("banana one two three four five six", "banana").valid, false);
});
