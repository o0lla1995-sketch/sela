/**
 * Global Jest setup — DB path default + module alias fallbacks for
 * packages whose community mocks aren't installed locally.
 */
'use strict';

globalThis.__SELA_DB_PATH = ':memory:';
