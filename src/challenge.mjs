const MAX_ANSWER_TOKENS = 6;

const CATEGORY_BANK = {
  animal: ["cat", "dog", "tiger", "horse", "rabbit", "eagle", "dolphin", "wolf"],
  fruit: ["apple", "banana", "grape", "mango", "peach", "lemon", "cherry", "pear"],
  color: ["red", "blue", "green", "yellow", "purple", "pink", "black", "white"],
  country: ["japan", "france", "brazil", "canada", "egypt", "india", "norway", "kenya"],
  metal: ["iron", "gold", "copper", "silver", "zinc", "nickel", "lead", "tin"],
  vehicle: ["car", "truck", "train", "bicycle", "airplane", "boat", "scooter", "tram"],
  instrument: ["piano", "guitar", "violin", "drum", "flute", "trumpet", "harp", "cello"],
  drink: ["coffee", "tea", "juice", "milk", "soda", "water", "cocoa", "lemonade"]
};

const COLORS = ["brown", "gray", "golden", "spotted", "striped", "pale", "dark", "bright"];
const ANIMALS = ["fox", "owl", "bear", "deer", "frog", "crow", "otter", "lynx"];
const ACTIONS = ["slept", "jumped", "rested", "waited", "played", "hid", "stared", "wandered"];
const PLACES = ["river", "mountain", "garden", "market", "forest", "lake", "bridge", "castle"];

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function sample(items, count) {
  const pool = [...items];
  const result = [];
  while (result.length < count && pool.length) {
    result.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return result;
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const next = Math.floor(Math.random() * (index + 1));
    [result[index], result[next]] = [result[next], result[index]];
  }
  return result;
}

function categoryChallenge() {
  const categories = Object.keys(CATEGORY_BANK);
  const target = pick(categories);
  const answer = pick(CATEGORY_BANK[target]);
  const others = categories.filter((item) => item !== target).flatMap((item) => CATEGORY_BANK[item]);
  const options = shuffle([answer, ...sample(others, 5)]);
  return {
    prompt: `Pick the word that belongs to the given category. Reply with ONLY that one word.\n\nCategory: fruit\nOptions: car, banana, iron, blue, dog\nA: banana\n\nCategory: ${target}\nOptions: ${options.join(", ")}\nA:`,
    expectedAnswer: answer
  };
}

function readingChallenge() {
  const facts = sample(ANIMALS, 6 + Math.floor(Math.random() * 2)).map((animal) => ({
    animal,
    color: pick(COLORS),
    action: pick(ACTIONS),
    place: pick(PLACES)
  }));
  const target = pick(facts);
  const ask = pick([
    { question: `What color was the ${target.animal}?`, answer: target.color },
    { question: `Where was the ${target.animal}?`, answer: target.place }
  ]);
  const passage = facts.map((fact) => `The ${fact.color} ${fact.animal} ${fact.action} near the ${fact.place}.`).join(" ");
  return {
    prompt: `Read the passage and answer the question with ONLY one word.\n\nPassage: The small dog rested near the garden. The happy cat slept near the lake.\nQuestion: Where was the cat?\nA: lake\n\nPassage: ${passage}\nQuestion: ${ask.question}\nA:`,
    expectedAnswer: ask.answer
  };
}

export function generateChallenge() {
  return Math.random() > 0.5 ? categoryChallenge() : readingChallenge();
}

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function validateResponse(response, expectedAnswer) {
  if (!response || !expectedAnswer) return { valid: false, normalized: null };
  const normalized = normalize(response);
  if (!normalized) return { valid: false, normalized: null };
  const tokens = normalized.split(" ");
  const expected = normalize(expectedAnswer);
  const display = normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
  return { valid: tokens.length <= MAX_ANSWER_TOKENS && tokens.includes(expected), normalized: display };
}
