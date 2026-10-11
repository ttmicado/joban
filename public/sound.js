// 効果音はすべて WebAudio で合成（音声ファイル不要）
let ctx = null;
let master = null;
let noiseBuf = null;
let roll = null;

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return ctx;
}

function tone(freq, start, dur, { type = "sine", vol = 0.3, attack = 0.005, to = null } = {}) {
  const c = ac();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  if (to) o.frequency.exponentialRampToValueAtTime(to, start + dur);
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(vol, start + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(master);
  o.start(start);
  o.stop(start + dur + 0.05);
}

function noise(start, dur, { freq = 2000, q = 4, vol = 0.3 } = {}) {
  const c = ac();
  if (!c) return;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const f = c.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(f).connect(g).connect(master);
  src.start(start, Math.random() * 0.5, dur + 0.05);
}

const now = () => ac()?.currentTime ?? 0;

export const sfx = {
  unlock() {
    const c = ac();
    if (c && c.state === "suspended") c.resume();
  },
  // 玉同士がぶつかる「カラッ」
  clack() {
    if (!ctx) return;
    const t = now();
    noise(t, 0.04, { freq: 2500 + Math.random() * 2500, q: 8, vol: 0.35 });
    tone(1800 + Math.random() * 1400, t, 0.05, { type: "triangle", vol: 0.06 });
  },
  pop() {
    const t = now();
    tone(500, t, 0.15, { type: "sine", vol: 0.4, to: 1200 });
  },
  bounce(vol = 1) {
    const t = now();
    tone(900, t, 0.12, { type: "sine", vol: 0.35 * vol, to: 600 });
    noise(t, 0.05, { freq: 3000, q: 3, vol: 0.2 * vol });
  },
  stamp() {
    const t = now();
    tone(140, t, 0.25, { type: "sine", vol: 0.6, to: 60 });
    noise(t, 0.12, { freq: 800, q: 1, vol: 0.35 });
  },
  // 抽選中の小太鼓ロール
  drumroll(sec) {
    const c = ac();
    if (!c) return;
    this.stopDrumroll();
    const t = c.currentTime;
    const g = c.createGain();
    g.gain.setValueAtTime(0.05, t);
    g.gain.linearRampToValueAtTime(0.35, t + sec);
    g.connect(master);
    const nodes = [];
    for (let i = 0, x = 0; x < sec + 4; i++, x += 0.045) {
      const src = c.createBufferSource();
      src.buffer = noiseBuf;
      const f = c.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = 1200 + (i % 2) * 300;
      f.Q.value = 1.5;
      const e = c.createGain();
      e.gain.setValueAtTime(0.9, t + x);
      e.gain.exponentialRampToValueAtTime(0.0001, t + x + 0.04);
      src.connect(f).connect(e).connect(g);
      src.start(t + x, Math.random() * 0.5, 0.05);
      nodes.push(src);
    }
    roll = { g, nodes };
  },
  stopDrumroll() {
    if (!roll || !ctx) return;
    const t = ctx.currentTime;
    roll.g.gain.cancelScheduledValues(t);
    roll.g.gain.setValueAtTime(roll.g.gain.value, t);
    roll.g.gain.linearRampToValueAtTime(0, t + 0.08);
    roll.nodes.forEach((n) => {
      try { n.stop(t + 0.1); } catch {}
    });
    roll = null;
    // 締めのシンバル
    noise(t, 0.6, { freq: 7000, q: 0.7, vol: 0.25 });
  },
  rise() {
    const t = now();
    tone(300, t, 1.4, { type: "sawtooth", vol: 0.08, attack: 0.3, to: 1500 });
    tone(450, t, 1.4, { type: "triangle", vol: 0.12, attack: 0.3, to: 2200 });
  },
  // 当たりの鐘「カランカラン」
  bell() {
    const t = now();
    for (let i = 0; i < 10; i++) {
      const s = t + i * 0.14;
      const f = i % 2 ? 1180 : 1320;
      [1, 2.76, 5.4].forEach((r, j) => tone(f * r, s, 0.6 - j * 0.15, { vol: 0.16 / (j + 1) }));
    }
  },
  fanfare() {
    const t = now() + 0.1;
    const seq = [
      [523, 0, 0.12], [659, 0.13, 0.12], [784, 0.26, 0.12], [1047, 0.39, 0.5],
      [784, 0.95, 0.12], [1047, 1.08, 0.9],
    ];
    seq.forEach(([f, d, l]) => {
      tone(f, t + d, l + 0.2, { type: "square", vol: 0.08 });
      tone(f / 2, t + d, l + 0.2, { type: "triangle", vol: 0.15 });
    });
    [523, 659, 784].forEach((f) => tone(f, t + 1.08, 1.4, { type: "triangle", vol: 0.1, attack: 0.02 }));
  },
  lose() {
    const t = now();
    tone(392, t, 0.4, { type: "triangle", vol: 0.25 });
    tone(330, t + 0.35, 0.4, { type: "triangle", vol: 0.22 });
    tone(262, t + 0.7, 0.9, { type: "triangle", vol: 0.2, to: 240 });
  },
};
