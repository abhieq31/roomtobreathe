import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePeople } from "../../src/roomtobreathe/web/js/numbers.js";

test("crowd sizes are read the way people write them", () => {
  const cases = { "5000": 5000, "60,000": 60000, "1,00,000": 100000, "1 lakh": 100000, "1.5 lakh": 150000,
    "50k": 50000, "2 crore": 20000000, "10 thousand": 10000, " 7 500 ": 7500, "3000 people": 3000 };
  for (const [t, v] of Object.entries(cases)) assert.equal(parsePeople(t), v, t);
});

test("nonsense is refused", () => {
  for (const t of ["", "abc", "0", "-5", "5 bananas", "1.2.3"]) assert.equal(parsePeople(t), null, t);
});
