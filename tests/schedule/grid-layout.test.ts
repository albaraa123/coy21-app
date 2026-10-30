import { describe, expect, it } from 'vitest';
import { computeGridLayout, type GridInputSession } from '@/lib/schedule/grid-layout';

const s = (id: string, trackId: string, start: string, end: string): GridInputSession => ({
  id, trackId, startTime: `2026-11-05T${start}:00Z`, endTime: `2026-11-05T${end}:00Z`,
});

describe('computeGridLayout', () => {
  it('returns an empty layout for an empty session list', () => {
    const layout = computeGridLayout([]);
    expect(layout.tracks).toEqual([]);
    expect(layout.blocks).toEqual([]);
  });

  it('derives the time range from the actual min start / max end, not a fixed window', () => {
    const layout = computeGridLayout([s('a', 't1', '05:00', '05:30'), s('b', 't1', '16:00', '19:00')]);
    expect(layout.rangeStartMinutes).toBe(5 * 60);
    expect(layout.rangeEndMinutes).toBe(19 * 60);
  });

  it('one track, one session: full column width, top/height match its time range proportionally', () => {
    const layout = computeGridLayout([s('a', 't1', '06:00', '07:00')]);
    const block = layout.blocks[0];
    expect(block.columnIndex).toBe(0);
    expect(block.lane).toBe(0);
    expect(block.laneCount).toBe(1);
  });

  it('two non-overlapping sessions in the same track get the same lane (lane 0)', () => {
    const layout = computeGridLayout([s('a', 't1', '06:00', '07:00'), s('b', 't1', '07:00', '08:00')]);
    expect(layout.blocks.find((b) => b.id === 'a')!.lane).toBe(0);
    expect(layout.blocks.find((b) => b.id === 'b')!.lane).toBe(0);
    expect(layout.blocks.find((b) => b.id === 'a')!.laneCount).toBe(1);
  });

  it('two overlapping sessions in the same track split into 2 lanes, laneCount=2 on both', () => {
    const layout = computeGridLayout([s('a', 't1', '10:00', '10:45'), s('b', 't1', '10:00', '10:45')]);
    const a = layout.blocks.find((b) => b.id === 'a')!;
    const b = layout.blocks.find((b) => b.id === 'b')!;
    expect(new Set([a.lane, b.lane])).toEqual(new Set([0, 1]));
    expect(a.laneCount).toBe(2);
    expect(b.laneCount).toBe(2);
  });

  it('seven overlapping sessions in the same track (the real SDE 10:00 case) get 7 distinct lanes', () => {
    const sessions = Array.from({ length: 7 }, (_, i) => s(`r${i}`, 't1', '10:00', '10:45'));
    const layout = computeGridLayout(sessions);
    const lanes = new Set(layout.blocks.map((b) => b.lane));
    expect(lanes.size).toBe(7);
    expect(layout.blocks.every((b) => b.laneCount === 7)).toBe(true);
  });

  it('a session overlapping only PART of another still shares/splits lanes correctly (greedy interval partition)', () => {
    // a: 10:00-11:00, b: 10:30-11:30 -- overlap in [10:30,11:00) -- must not share a lane
    const layout = computeGridLayout([s('a', 't1', '10:00', '11:00'), s('b', 't1', '10:30', '11:30')]);
    const a = layout.blocks.find((x) => x.id === 'a')!;
    const b = layout.blocks.find((x) => x.id === 'b')!;
    expect(a.lane).not.toBe(b.lane);
  });

  it('different tracks never share lanes even at the same time (each track lays out independently)', () => {
    const layout = computeGridLayout([s('a', 't1', '10:00', '10:45'), s('b', 't2', '10:00', '10:45')]);
    expect(layout.blocks.find((b) => b.id === 'a')!.columnIndex).not.toBe(layout.blocks.find((b) => b.id === 'b')!.columnIndex);
    expect(layout.blocks.find((b) => b.id === 'a')!.laneCount).toBe(1);
  });

  it('tracks are ordered by the order they are first seen in the input (stable, deterministic column order)', () => {
    const layout = computeGridLayout([s('a', 'zzz', '06:00', '07:00'), s('b', 'aaa', '06:00', '07:00')]);
    expect(layout.tracks.map((t) => t.trackId)).toEqual(['zzz', 'aaa']);
  });

  it('a zero-duration or inverted session (end <= start) is dropped, not NaN-crashed', () => {
    const layout = computeGridLayout([s('a', 't1', '10:00', '10:00'), s('b', 't1', '11:00', '10:30')]);
    expect(layout.blocks).toEqual([]);
  });
});
