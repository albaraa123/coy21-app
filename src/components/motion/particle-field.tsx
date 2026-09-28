'use client';

// Canvas particle-network background for the homepage hero. Small dots
// drift slowly and draw a line between any two that are close together;
// the cursor acts as an extra "particle" so nearby dots visibly react to
// it. Pure canvas, no dependency, capped device-pixel-ratio and particle
// count so it stays cheap on mobile. Skips animation entirely under
// prefers-reduced-motion (renders nothing rather than a frozen canvas,
// since a static dot scatter has no informational value) AND on
// coarse-pointer/touch devices (phones/tablets have no hovering cursor to
// react to, so the interactive payoff doesn't exist there, but the
// continuous rAF loop would still burn battery — not a reasonable
// trade). pointer-events stays 'none' always: this is a decorative
// background layer sitting behind real hero content and must never
// intercept taps, drags, or scroll gestures meant for the page.
import { useEffect, useRef } from 'react';

const COLORS = ['#5fc0b6', '#8bc05f', '#d9a93a'];
const LINK_DISTANCE = 130;
const CURSOR_LINK_DISTANCE = 170;

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
};

export function ParticleField({ className = '' }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (window.matchMedia('(pointer: coarse)').matches) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let particles: Particle[] = [];
    const mouse = { x: -9999, y: -9999, active: false };
    let frameId = 0;

    const countFor = (w: number, h: number) => Math.min(70, Math.max(24, Math.round((w * h) / 22000)));

    function resize() {
      const parent = canvas!.parentElement;
      width = parent ? parent.clientWidth : window.innerWidth;
      height = parent ? parent.clientHeight : window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const target = countFor(width, height);
      particles = Array.from({ length: target }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        r: Math.random() * 1.6 + 1,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      }));
    }

    function onPointerMove(e: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
      mouse.active = true;
    }
    function onPointerLeave() {
      mouse.active = false;
      mouse.x = -9999;
      mouse.y = -9999;
    }

    function step() {
      ctx!.clearRect(0, 0, width, height);

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > width) p.vx *= -1;
        if (p.y < 0 || p.y > height) p.vy *= -1;

        if (mouse.active) {
          const dx = p.x - mouse.x;
          const dy = p.y - mouse.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 90 && dist > 0.01) {
            const force = (90 - dist) / 90;
            p.x += (dx / dist) * force * 0.6;
            p.y += (dy / dist) * force * 0.6;
          }
        }
      }

      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i];
          const b = particles[j];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist < LINK_DISTANCE) {
            ctx!.strokeStyle = a.color;
            ctx!.globalAlpha = (1 - dist / LINK_DISTANCE) * 0.18;
            ctx!.lineWidth = 1;
            ctx!.beginPath();
            ctx!.moveTo(a.x, a.y);
            ctx!.lineTo(b.x, b.y);
            ctx!.stroke();
          }
        }

        if (mouse.active) {
          const p = particles[i];
          const dist = Math.hypot(p.x - mouse.x, p.y - mouse.y);
          if (dist < CURSOR_LINK_DISTANCE) {
            ctx!.strokeStyle = p.color;
            ctx!.globalAlpha = (1 - dist / CURSOR_LINK_DISTANCE) * 0.35;
            ctx!.lineWidth = 1;
            ctx!.beginPath();
            ctx!.moveTo(p.x, p.y);
            ctx!.lineTo(mouse.x, mouse.y);
            ctx!.stroke();
          }
        }
      }

      ctx!.globalAlpha = 1;
      for (const p of particles) {
        ctx!.fillStyle = p.color;
        ctx!.globalAlpha = 0.6;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;

      frameId = requestAnimationFrame(step);
    }

    resize();
    frameId = requestAnimationFrame(step);

    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerleave', onPointerLeave);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 -z-10 ${className}`}
    />
  );
}
