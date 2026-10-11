import { badRequest } from "./errors.js";
import { isDate, isTime } from "./time.js";

// 入力値の検証ヘルパー。不正なら 400 を投げる。空文字は null として扱う。
export const v = {
  str(val, label, { max = 200, required = false } = {}) {
    if (val === undefined || val === null || String(val).trim() === "") {
      if (required) throw badRequest(`${label}を入力してください`);
      return null;
    }
    if (typeof val !== "string" && typeof val !== "number") throw badRequest(`${label}の形式が不正です`);
    const s = String(val).trim();
    if (s.length > max) throw badRequest(`${label}は${max}文字以内にしてください`);
    return s;
  },
  int(val, label, { min = 0, max = 100000, required = false } = {}) {
    if (val === undefined || val === null || val === "") {
      if (required) throw badRequest(`${label}を入力してください`);
      return null;
    }
    if (typeof val !== "number" && typeof val !== "string") throw badRequest(`${label}の値が不正です`);
    const n = Number(val);
    if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${label}の値が不正です`);
    return n;
  },
  date(val, label, { required = false } = {}) {
    if (!val) {
      if (required) throw badRequest(`${label}を入力してください`);
      return null;
    }
    if (!isDate(val)) throw badRequest(`${label}の形式が不正です`);
    return val;
  },
  time(val, label, { required = false } = {}) {
    if (!val) {
      if (required) throw badRequest(`${label}を入力してください`);
      return null;
    }
    if (!isTime(val)) throw badRequest(`${label}の形式が不正です`);
    return val;
  },
  oneOf(val, label, options, { required = false } = {}) {
    if (val === undefined || val === null || val === "") {
      if (required) throw badRequest(`${label}を選んでください`);
      return null;
    }
    if (!options.includes(val)) throw badRequest(`${label}の値が不正です`);
    return val;
  },
  url(val, label) {
    const s = v.str(val, label, { max: 1000 });
    if (s && !/^https?:\/\//.test(s)) throw badRequest(`${label}は http(s) で始まるURLにしてください`);
    return s;
  },
};
