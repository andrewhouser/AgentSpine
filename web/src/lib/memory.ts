/**
 * Memory you can read (PLAN-open-work section 15, R6): the sentences the clients say about a memory.
 * `MemoryWords` in Models.swift mirrors these; test/memory-screen.test.mjs holds them equal.
 */

/** "Not used yet", "Used once", "Used 31 times". A use is a recall into a run. */
export const usesLine = (uses: number): string => (uses <= 0 ? "Not used yet" : uses === 1 ? "Used once" : `Used ${uses} times`);

/** Where it may go. Only code can make a memory cloud-safe; a person can only take that away. */
export const cloudLine = (cloudSafe: boolean): string => (cloudSafe ? "May reach the cloud" : "Local only");

/** The state a person can act on: a guess no person confirmed, or nothing. */
export const guessLine = (guess: boolean): string => (guess ? "Guess: nobody has confirmed this" : "");
