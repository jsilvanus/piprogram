/**
 * Named loudness levels for sound on the feeds: whisper, normal, loud, shout. A level is just a name for a
 * volume (0-100) so the operator does not pick numbers while a service runs. The numbers are meant to be
 * calibrated by listening tests in the church; the built-in values below are PROVISIONAL guesses, not
 * measurements. Set the real ones with PIPGM_AUDIO_LEVELS, for example
 * `PIPGM_AUDIO_LEVELS=whisper=8,normal=25,loud=45,shout=60`.
 *
 * A level never goes past the gain cap (PIPGM_AUDIO_MAX_VOLUME, default 60): the stage plays
 * min(level volume, cap). To make `shout` really louder than 60, raise the cap on purpose.
 */

export const AUDIO_LEVEL_NAMES = ["whisper", "normal", "loud", "shout"] as const;
export type AudioLevelName = (typeof AUDIO_LEVEL_NAMES)[number];
export type AudioLevels = Record<AudioLevelName, number>;

/** Provisional, uncalibrated. */
export const DEFAULT_AUDIO_LEVELS: AudioLevels = { whisper: 8, normal: 25, loud: 45, shout: 60 };

export function isAudioLevelName(value: unknown): value is AudioLevelName {
  return typeof value === "string" && (AUDIO_LEVEL_NAMES as readonly string[]).includes(value);
}

/**
 * Parses `name=volume,...`. Unlisted names keep their default. Throws on an unknown name, a volume outside
 * 0-100, or levels that are not in rising order (whisper < normal < loud < shout is what the names promise).
 */
export function parseAudioLevels(text: string | undefined): AudioLevels {
  const levels: AudioLevels = { ...DEFAULT_AUDIO_LEVELS };
  if (text && text.trim()) {
    for (const part of text.split(",")) {
      const [name, raw] = part.split("=").map((s) => s.trim());
      if (!isAudioLevelName(name)) throw new Error(`PIPGM_AUDIO_LEVELS: unknown level "${name ?? ""}" (use ${AUDIO_LEVEL_NAMES.join(", ")})`);
      const value = Number(raw);
      if (raw === undefined || raw === "" || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error(`PIPGM_AUDIO_LEVELS: ${name} must be a number from 0 to 100`);
      }
      levels[name] = Math.round(value);
    }
  }
  validateLevelOrder(levels);
  return levels;
}

export function validateLevelOrder(levels: AudioLevels): void {
  for (let i = 1; i < AUDIO_LEVEL_NAMES.length; i += 1) {
    const lower = AUDIO_LEVEL_NAMES[i - 1]!;
    const higher = AUDIO_LEVEL_NAMES[i]!;
    if (levels[lower] >= levels[higher]) throw new Error(`audio levels must rise: ${lower} (${levels[lower]}) must be below ${higher} (${levels[higher]})`);
  }
}
