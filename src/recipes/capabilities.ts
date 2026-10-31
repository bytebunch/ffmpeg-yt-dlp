import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { Logger } from '@nestjs/common';
import { execa } from 'execa';

import type { AppConfig } from '../config/env.schema';
import type { WhisperSetup } from './context';

/** Nest token for the worker's transcription setup, probed once at start. */
export const WHISPER_SETUP = Symbol('WHISPER_SETUP');

const logger = new Logger('Capabilities');

/** True on x86-64 hosts whose CPU lacks AVX2 (the whisper.cpp build's baseline, SPEC §17). */
async function missingAvx2(): Promise<boolean> {
  if (process.arch !== 'x64') return false;
  const cpuinfo = await readFile('/proc/cpuinfo', 'utf8').catch(() => '');
  return cpuinfo !== '' && !/\bavx2\b/.test(cpuinfo);
}

/**
 * SPEC §8j transcribe: available only with the whisper filter, at least one model file and AVX2;
 * otherwise recipes asking for it get FEATURE_DISABLED with the reason.
 */
export async function probeWhisper(config: AppConfig): Promise<WhisperSetup> {
  const configured = config.FFMPEG_WHISPER_MODELS;
  const off = (disabled: string): WhisperSetup => {
    logger.warn(`transcribe is off: ${disabled}`);
    return { disabled, models: {} };
  };
  if (Object.keys(configured).length === 0)
    return off('no models configured (FFMPEG_WHISPER_MODELS)');
  const filters = await execa(config.FFMPEG_BIN, ['-hide_banner', '-filters'], {
    reject: false,
    timeout: 30_000,
  });
  if (!/\swhisper\s/.test(filters.stdout)) return off('this ffmpeg build has no whisper filter');
  if (await missingAvx2()) return off('the CPU has no AVX2');
  const models = Object.fromEntries(
    Object.entries(configured).filter(([, file]) => existsSync(file)),
  );
  const missing = Object.keys(configured).filter((name) => !(name in models));
  if (missing.length > 0) logger.warn(`whisper model files missing for: ${missing.join(', ')}`);
  if (Object.keys(models).length === 0) return off('none of the model files exist');
  const preferred = config.FFMPEG_WHISPER_DEFAULT_MODEL;
  const vad = config.FFMPEG_WHISPER_VAD_MODEL;
  return {
    models,
    defaultModel: preferred && preferred in models ? preferred : Object.keys(models)[0],
    vadModel: vad && existsSync(vad) ? vad : undefined,
  };
}
