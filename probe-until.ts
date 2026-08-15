import { queryContentWindow } from './src/temporal/dates.js';

const queries = [
  'went through my notes from March 2024',
  'is the 2023 roadmap up to date',
  'search through the 2023 decisions',
  'notes in March 2024', // control: no idiom, should be two-sided 'in'
];
for (const q of queries) {
  console.log(JSON.stringify(q), '->', JSON.stringify(queryContentWindow(q)));
}
