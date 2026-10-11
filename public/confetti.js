// 紙吹雪と金貨
const canvas = document.getElementById("confetti");
const c2d = canvas.getContext("2d");
const COLORS = ["#f6c445", "#fff1b0", "#d7263d", "#ffffff", "#ff8fab", "#06c755", "#7bdff2"];
let parts = [];
let running = false;

function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener("resize", resize);
resize();

function spawn(n, fromX, fromY, spread) {
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * spread;
    const v = 7 + Math.random() * 10;
    parts.push({
      x: fromX,
      y: fromY,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      w: 6 + Math.random() * 8,
      h: 4 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      tilt: Math.random() * Math.PI,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      coin: Math.random() < 0.12,
      life: 0,
    });
  }
}

function frame() {
  c2d.clearRect(0, 0, innerWidth, innerHeight);
  parts = parts.filter((p) => p.y < innerHeight + 40 && p.life < 600);
  for (const p of parts) {
    p.life++;
    p.vy += 0.22;
    p.vx *= 0.985;
    p.vy *= 0.985;
    p.x += p.vx + Math.sin(p.life / 10 + p.tilt) * 0.8;
    p.y += p.vy;
    p.rot += p.vr;
    c2d.save();
    c2d.translate(p.x, p.y);
    c2d.rotate(p.rot);
    if (p.coin) {
      const sx = Math.abs(Math.cos(p.life / 6 + p.tilt));
      c2d.scale(sx, 1);
      c2d.fillStyle = "#ffd84d";
      c2d.beginPath();
      c2d.arc(0, 0, 8, 0, Math.PI * 2);
      c2d.fill();
      c2d.strokeStyle = "#b8820b";
      c2d.lineWidth = 2;
      c2d.stroke();
    } else {
      c2d.scale(1, Math.cos(p.life / 8 + p.tilt));
      c2d.fillStyle = p.color;
      c2d.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    }
    c2d.restore();
  }
  if (parts.length) requestAnimationFrame(frame);
  else running = false;
}

export const confetti = {
  burst(power = 1) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const n = Math.round(90 * power);
    spawn(n, innerWidth * 0.5, innerHeight * 0.45, Math.PI * 1.4);
    setTimeout(() => {
      spawn(n * 0.6, 0, innerHeight * 0.7, 0.9);
      spawn(n * 0.6, innerWidth, innerHeight * 0.7, 0.9);
      parts.slice(-n * 1.2 | 0).forEach((p, i) => (p.vx = (i % 2 ? -1 : 1) * Math.abs(p.vx)));
    }, 350);
    // 雨のように降り続ける
    for (let k = 1; k <= 6; k++) {
      setTimeout(() => {
        for (let i = 0; i < 18 * power; i++) {
          parts.push({
            x: Math.random() * innerWidth, y: -20, vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 3,
            w: 6 + Math.random() * 8, h: 4 + Math.random() * 6, rot: Math.random() * 3, vr: (Math.random() - 0.5) * 0.3,
            tilt: Math.random() * 3, color: COLORS[(Math.random() * COLORS.length) | 0], coin: Math.random() < 0.15, life: 0,
          });
        }
        if (!running) { running = true; requestAnimationFrame(frame); }
      }, 600 * k);
    }
    if (!running) {
      running = true;
      requestAnimationFrame(frame);
    }
  },
};
