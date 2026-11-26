/**
 * Filler words that say nothing about what a question is about.
 *
 * Kept in a module with no imports because two searches use it and one of them cannot import the
 * other: project search (src/projects/search.ts) sits above the ledger, and the ledger's own run
 * search (src/memory/store.ts) sits below it.
 */
export const STOPWORDS = new Set(
  ("a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my of on or our so " +
    "than that the their them then there these they this to us was we were what when where which who whom why will with would you your about " +
    "any all some much many more most not no yes out up down over just also tell show give find get got let make").split(" "),
);
