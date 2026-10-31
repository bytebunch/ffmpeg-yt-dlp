import { z } from 'zod';

import { type FilterContext, invalid } from '../context';
import { num } from '../graph';

/** SPEC §8e `platform_format`: delivery presets for social and video platforms. */

export interface PlatformSpec {
  width: number;
  height: number;
  fps: number;
  /** H.264 profile and level for the encode that follows. */
  profile: 'baseline' | 'main' | 'high';
  level: '3.0' | '3.1' | '4.0' | '4.1' | '4.2';
  /** Peak video bitrate (kbps) and audio bitrate. */
  maxrateKbps: number;
  audioKbps: number;
  /** Longest clip the platform takes, in seconds (null: no practical limit). */
  maxDurationS: number | null;
  maxFileMb: number | null;
}

export const PLATFORMS: Record<string, PlatformSpec> = {
  youtube: {
    width: 1920,
    height: 1080,
    fps: 60,
    profile: 'high',
    level: '4.2',
    maxrateKbps: 12_000,
    audioKbps: 192,
    maxDurationS: null,
    maxFileMb: null,
  },
  youtube_shorts: {
    width: 1080,
    height: 1920,
    fps: 60,
    profile: 'high',
    level: '4.2',
    maxrateKbps: 10_000,
    audioKbps: 192,
    maxDurationS: 180,
    maxFileMb: null,
  },
  instagram_feed: {
    width: 1080,
    height: 1350,
    fps: 30,
    profile: 'high',
    level: '4.1',
    maxrateKbps: 5000,
    audioKbps: 128,
    maxDurationS: 3600,
    maxFileMb: 4000,
  },
  instagram_reel: {
    width: 1080,
    height: 1920,
    fps: 30,
    profile: 'high',
    level: '4.1',
    maxrateKbps: 5000,
    audioKbps: 128,
    maxDurationS: 180,
    maxFileMb: 4000,
  },
  instagram_story: {
    width: 1080,
    height: 1920,
    fps: 30,
    profile: 'high',
    level: '4.1',
    maxrateKbps: 5000,
    audioKbps: 128,
    maxDurationS: 60,
    maxFileMb: 4000,
  },
  tiktok: {
    width: 1080,
    height: 1920,
    fps: 60,
    profile: 'high',
    level: '4.2',
    maxrateKbps: 8000,
    audioKbps: 128,
    maxDurationS: 600,
    maxFileMb: 4000,
  },
  x: {
    width: 1280,
    height: 720,
    fps: 40,
    profile: 'high',
    level: '4.1',
    maxrateKbps: 5000,
    audioKbps: 128,
    maxDurationS: 140,
    maxFileMb: 512,
  },
  facebook: {
    width: 1280,
    height: 720,
    fps: 30,
    profile: 'high',
    level: '4.1',
    maxrateKbps: 6000,
    audioKbps: 128,
    maxDurationS: 14_400,
    maxFileMb: 10_000,
  },
  linkedin: {
    width: 1920,
    height: 1080,
    fps: 30,
    profile: 'high',
    level: '4.1',
    maxrateKbps: 8000,
    audioKbps: 128,
    maxDurationS: 900,
    maxFileMb: 5000,
  },
  whatsapp: {
    width: 854,
    height: 480,
    fps: 30,
    profile: 'main',
    level: '3.1',
    maxrateKbps: 1000,
    audioKbps: 96,
    maxDurationS: 180,
    maxFileMb: 16,
  },
  pinterest: {
    width: 1000,
    height: 1500,
    fps: 30,
    profile: 'high',
    level: '4.1',
    maxrateKbps: 4000,
    audioKbps: 128,
    maxDurationS: 900,
    maxFileMb: 2000,
  },
};

export const platformSchemas = [
  z.strictObject({
    op: z.literal('platform_format'),
    platform: z.enum(Object.keys(PLATFORMS) as [string, ...string[]]),
    strategy: z.enum(['crop', 'pad', 'blur']).default('blur'),
    max_duration: z.boolean().default(true),
  }),
] as const;

export type PlatformStep = z.output<(typeof platformSchemas)[number]>;

export const platformHandlers = {
  platform_format(ctx: FilterContext, step: PlatformStep, index: number): void {
    const video = ctx.video(index, 'platform_format');
    const spec = PLATFORMS[step.platform];
    if (!spec) throw invalid(index, `unknown platform ${step.platform}`);
    const { width, height } = spec;
    const box = `${width}:${height}`;
    if (step.strategy === 'crop') {
      ctx.applyFilters(
        [`scale=${box}:force_original_aspect_ratio=increase`, `crop=${box}`, 'setsar=1'],
        null,
      );
    } else if (step.strategy === 'pad') {
      ctx.applyFilters(
        [
          `scale=${box}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
          `pad=${box}:(ow-iw)/2:(oh-ih)/2:color=black`,
          'setsar=1',
        ],
        null,
      );
    } else {
      // The picture over a blurred, zoomed copy of itself fills the frame without black bars.
      const background = ctx.graph.chain(video, [
        `scale=${box}:force_original_aspect_ratio=increase`,
        `crop=${box}`,
        'boxblur=20:2',
      ]);
      const foreground = ctx.graph.chain(video, [
        `scale=${box}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      ]);
      const out = ctx.graph.newPad('v');
      ctx.graph.segment(
        `[${ctx.graph.read(background)}][${ctx.graph.read(foreground)}]overlay=(W-w)/2:(H-h)/2[${out.label}]`,
      );
      ctx.state.video = ctx.graph.chain(out, ['setsar=1']);
      ctx.state.filtered = true;
    }
    if ((ctx.state.fps ?? 0) > spec.fps) ctx.applyFilters([`fps=${spec.fps}`], null);
    if (
      step.max_duration &&
      spec.maxDurationS !== null &&
      (ctx.state.duration ?? 0) > spec.maxDurationS
    ) {
      const range = `duration=${num(spec.maxDurationS)}`;
      ctx.applyFilters(
        [`trim=${range}`, 'setpts=PTS-STARTPTS'],
        [`atrim=${range}`, 'asetpts=PTS-STARTPTS'],
      );
      ctx.state.duration = spec.maxDurationS;
      ctx.state.timeAltered = true;
    }
    Object.assign(ctx.state, {
      width,
      height,
      fps: Math.min(ctx.state.fps ?? spec.fps, spec.fps),
      platform: spec,
    });
    ctx.filterCost(ctx.minutes, 0.3);
  },
};
