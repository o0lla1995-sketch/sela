/**
 * react-native-mmkv shim for Jest — a plain Map with the exact accessor
 * semantics the app relies on (getString/getNumber/getBoolean return
 * undefined when missing; set stores the typed value).
 */
'use strict';

class MMKV {
  constructor() {
    this.__map = new Map();
  }

  set(key, value) {
    this.__map.set(key, value);
  }

  getString(key) {
    const value = this.__map.get(key);
    return typeof value === 'string' ? value : undefined;
  }

  getNumber(key) {
    const value = this.__map.get(key);
    return typeof value === 'number' ? value : undefined;
  }

  getBoolean(key) {
    const value = this.__map.get(key);
    return typeof value === 'boolean' ? value : undefined;
  }

  delete(key) {
    this.__map.delete(key);
  }

  contains(key) {
    return this.__map.has(key);
  }

  clearAll() {
    this.__map.clear();
  }

  getAllKeys() {
    return Array.from(this.__map.keys());
  }
}

module.exports = {MMKV};
