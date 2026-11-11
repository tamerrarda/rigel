"use client";

import { useEffect, useRef } from "react";

interface Meteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
  len: number;
  width: number;
  /** Brightness multiplier: 1 for near meteors, below 1 for distant ones. */
  glow: number;
}

/**
 * A starfield with shooting stars: bright blue-white streaks every second or two,
 * and a steady drizzle of faint, distant ones behind them. Pure canvas, no image frames. Under
 * prefers-reduced-motion it draws the field once and nothing moves.
 */
export function StarCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0;
    let h = 0;
    let raf = 0;
    let last = 0;
    let nextMeteor = 400;
    let nextFaint = 150;
    const meteors: Meteor[] = [];

    // Deterministic field so every load looks the same.
    let seed = 11;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const stars = Array.from({ length: 380 }, () => ({
      x: rand(),
      y: rand(),
      r: rand() ** 3 * 1.5 + 0.25,
      depth: rand() * 0.8 + 0.2,
      phase: rand() * Math.PI * 2,
      warm: rand() < 0.1,
    }));

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    /** A near meteor is long and bright; a distant one is short, thin, slow and faint. */
    const spawn = (distant: boolean) => {
      // Enter from the top or the right edge, travel down and to the left.
      const fromTop = Math.random() < 0.6;
      const angle = Math.PI * (0.62 + Math.random() * 0.16); // ~112°-140°
      const speed = distant ? 0.45 + Math.random() * 0.4 : 0.9 + Math.random() * 0.9; // px per ms
      meteors.push({
        x: fromTop ? w * (0.1 + Math.random() * 0.9) : w + 20,
        y: fromTop ? -20 : h * Math.random() * 0.7,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        ttl: distant ? 700 + Math.random() * 900 : 900 + Math.random() * 700,
        len: distant ? 80 + Math.random() * 90 : 140 + Math.random() * 160,
        width: distant ? 0.9 + Math.random() * 0.6 : 1.6 + Math.random() * 1.2,
        glow: distant ? 0.5 + Math.random() * 0.3 : 1,
      });
    };

    const drawField = (t: number) => {
      for (const s of stars) {
        const y = (((s.y * h - window.scrollY * s.depth * 0.2) % h) + h) % h;
        const twinkle = still ? 1 : 0.6 + 0.4 * Math.sin(t / 1100 + s.phase);
        ctx.globalAlpha = Math.min(1, 0.2 + s.depth * 0.8) * twinkle;
        ctx.fillStyle = s.warm ? "#ffd8c2" : "#e6eeff";
        ctx.beginPath();
        ctx.arc(s.x * w, y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const drawMeteor = (m: Meteor) => {
      // Fade in quickly, out slowly.
      const p = m.life / m.ttl;
      const alpha = (p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85) * m.glow;
      const speed = Math.hypot(m.vx, m.vy);
      const tx = m.x - (m.vx / speed) * m.len;
      const ty = m.y - (m.vy / speed) * m.len;
      const g = ctx.createLinearGradient(m.x, m.y, tx, ty);
      g.addColorStop(0, `rgba(240, 246, 255, ${0.95 * alpha})`);
      g.addColorStop(0.25, `rgba(170, 200, 255, ${0.65 * alpha})`);
      g.addColorStop(1, "rgba(120, 160, 255, 0)");
      ctx.strokeStyle = g;
      ctx.lineWidth = m.width;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      const head = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.width * 4);
      head.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
      head.addColorStop(1, "rgba(180, 210, 255, 0)");
      ctx.fillStyle = head;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.width * 4, 0, Math.PI * 2);
      ctx.fill();
    };

    const frame = (t: number) => {
      const dt = last ? Math.min(t - last, 50) : 16;
      last = t;
      ctx.clearRect(0, 0, w, h);
      drawField(t);

      nextMeteor -= dt;
      if (nextMeteor <= 0) {
        spawn(false);
        if (Math.random() < 0.25) spawn(false); // now and then, a pair
        nextMeteor = 900 + Math.random() * 1500;
      }
      nextFaint -= dt;
      if (nextFaint <= 0) {
        spawn(true);
        nextFaint = 120 + Math.random() * 380;
      }
      ctx.globalCompositeOperation = "lighter";
      for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i];
        m.life += dt;
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        if (m.life >= m.ttl) {
          meteors.splice(i, 1);
          continue;
        }
        drawMeteor(m);
      }
      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(frame);
    };

    resize();
    const onResize = () => {
      resize();
      if (still) {
        ctx.clearRect(0, 0, w, h);
        drawField(0);
      }
    };
    const onScroll = () => {
      if (still) {
        ctx.clearRect(0, 0, w, h);
        drawField(0);
      }
    };
    if (still) drawField(0);
    else raf = requestAnimationFrame(frame);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return <canvas ref={ref} className="star-canvas" aria-hidden />;
}
