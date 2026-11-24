import { expect, test } from 'bun:test';
import { findMissing, type UserRecipe } from './verify.ts';

const posted = `Pizzasnegle
25 g gær
3½ dl vand (lillefingervarmt)
500 g hvedemel
1. Rør gæren ud i vandet.
2. Tilsæt melet og ælt dejen godt.`;

const exact: UserRecipe = {
  title: 'Pizzasnegle',
  ingredients: [
    { name: 'gær', amount: 25, unit: 'g' },
    { name: 'hvedemel', amount: 500, unit: 'g' },
  ],
  instructions: ['Rør gæren ud i vandet.', 'Tilsæt melet og ælt dejen godt.'],
};

test('an exact copy is accepted', () => {
  expect(findMissing(posted, exact)).toEqual([]);
});

test('an invented ingredient is refused', () => {
  const r = { ...exact, ingredients: [...exact.ingredients, { name: 'oregano', amount: 1, unit: 'tsk' }] };
  expect(findMissing(posted, r).join()).toContain('ingredient "oregano"');
});

test('a changed amount is refused', () => {
  const r = { ...exact, ingredients: [{ name: 'gær', amount: 30, unit: 'g' }] };
  expect(findMissing(posted, r).join()).toContain('amount 30');
});

// Known gap: amounts are matched as substrings, so 50 is "found" inside "500 g hvedemel".
test.todo('a changed amount that is a substring of another number is refused (50 vs 500)');

test('a reworded step is refused', () => {
  const r = { ...exact, instructions: ['Opløs gæren i lunkent vand.'] };
  expect(findMissing(posted, r).join()).toContain('step 1');
});

test('an invented number of servings is refused', () => {
  expect(findMissing(posted, { ...exact, servings: 4 }).join()).toContain('servings 4');
});

test('"3½ dl" is refused as amount 3.5, but accepted when kept in the name', () => {
  // The real-world case from the talk: "3½ dl" is not in the known forms for 3.5, so it is refused,
  // and the model has to keep the amount in the ingredient name instead of guessing a number.
  const r = { ...exact, ingredients: [{ name: 'vand (lillefingervarmt)', amount: 3.5, unit: 'dl' }] };
  expect(findMissing(posted, r).join()).toContain('amount 3.5');
  const kept = { ...exact, ingredients: [{ name: '3½ dl vand (lillefingervarmt)', amount: null, unit: null }] };
  expect(findMissing(posted, kept)).toEqual([]);
});
